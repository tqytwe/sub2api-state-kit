(function (global, factory) {
  'use strict';
  const i18n = typeof module === 'object' && module.exports ? require('./i18n.js') : global.Sub2APIPluginI18n;
  const api = factory(i18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.start(global);
})(typeof window === 'object' ? window : null, function (i18n) {
  'use strict';
  const DEFAULT_CONFIG = Object.freeze({ enabled: false, dynamic_proxy_url: '', harvest_dial_proxy_url: '', harvest_dial_proxy_mode: 'direct', harvest_dial_proxy_id: 0, observe_exit_ip: false, ttl_minutes: 60,
    refresh_before_minutes: 10, max_attempts: 8, attempt_interval_seconds: 10, cooldown_seconds: 300 });
  const NUMBERS = Object.freeze({ ttl_minutes: [1, 60, 'ttl'], refresh_before_minutes: [0, 59, 'refreshBefore'],
    max_attempts: [1, 32, 'maxAttempts'], attempt_interval_seconds: [1, 300, 'attemptInterval'], cooldown_seconds: [30, 3600, 'cooldown'] });
  const STATES = Object.freeze({ disabled: ['stateDisabled', ''], waiting_host: ['stateWaitingHost', 'warning'],
    waiting_account: ['stateWaitingAccount', 'warning'], queued: ['stateQueued', ''], harvesting: ['stateHarvesting', ''],
    ready: ['stateReady', 'success'], renewing: ['stateRenewing', ''], cooldown: ['stateCooldown', 'warning'],
    expired: ['stateExpired', 'warning'], error: ['stateError', 'error'] });
  const MODEL_PATTERN = /^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;
  const ERRORS = Object.freeze({ managed_proxy_unavailable:'errorManagedProxy', proxy_auth_failed:'errorProxyAuth', front_proxy_failed:'errorFrontProxy', transport_timeout:'errorTimeout', transport_tls_failed:'errorTLS', attempts_exhausted:'errorAttempts', identity_unavailable:'errorIdentityUnavailable', invalid_dynamic_proxy:'errorInvalidDynamicProxy', harvest_failed:'errorHarvestFailed', unexpected_state_length:'errorStateLength', identity_changed:'errorIdentityChanged', fixed_proxy_validation_failed:'errorFixedValidation', ticket_persistence_failed:'errorPersistence', upstream_unauthorized:'error401', upstream_forbidden:'error403', upstream_rate_limited:'error429', upstream_rejected:'errorRejected', model_mismatch:'errorModelMismatch', state_312:'error312', model_mismatch_persistence_failed:'errorModelMismatchPersistence', state_312_persistence_failed:'error312Persistence' });
  const MESSAGES = Object.freeze({ 'STATE disabled; requests use the account business proxy':'messageDisabled', 'STATE active only for explicitly enabled account/model pairs':'messageActiveExplicit', 'waiting for host services':'messageWaitingHost' });
  function text(locale, key, values) { return i18n.t(i18n.normalizeLocale(locale), key, values); }
  function accountID(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (!/^[1-9]\d*$/.test(String(value).trim())) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  function normalizeConfig(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const config = Object.assign({}, DEFAULT_CONFIG);
    Object.keys(DEFAULT_CONFIG).forEach(function (key) {
      if (source[key] !== undefined) config[key] = source[key];
    });
    if (!source.harvest_dial_proxy_mode) config.harvest_dial_proxy_mode = config.harvest_dial_proxy_url ? 'manual' : 'direct';
    config.accounts = Array.isArray(source.accounts) ? source.accounts.map(function (account) {
      return { account_id: account.account_id, enabled: account.enabled === true,
        plan: account.plan || 'pro', models: Array.isArray(account.models) ? account.models.slice() : ['gpt-6-astra'] };
    }) : [];
    return config;
  }
  function validateConfig(config, locale) {
    locale = i18n.normalizeLocale(locale);
    const mode = config.harvest_dial_proxy_mode || (config.harvest_dial_proxy_url ? 'manual' : 'direct');
    if (!['direct', 'manual', 'managed'].includes(mode)) throw new Error(text(locale, 'invalidFrontMode'));
    if (mode === 'manual' && !config.harvest_dial_proxy_url) throw new Error(text(locale, 'frontRequired'));
    if (mode === 'managed' && accountID(config.harvest_dial_proxy_id) === null) throw new Error(text(locale, 'managedRequired'));
    if (typeof config.enabled !== 'boolean') throw new Error(text(locale, 'invalidGlobalSwitch'));
    if (typeof config.observe_exit_ip !== 'boolean') throw new Error(text(locale, 'invalidObserveSwitch'));
    if (typeof config.harvest_dial_proxy_url !== 'string') throw new Error(text(locale, 'invalidFrontProxy'));
    if (/[{}]/.test(config.harvest_dial_proxy_url)) throw new Error(text(locale, 'frontPlaceholderForbidden'));
    for (const proxyValue of [config.dynamic_proxy_url, config.harvest_dial_proxy_url]) {
    if (typeof proxyValue !== 'string') throw new Error(text(locale, 'invalidDynamicProxy'));
    if (proxyValue) {
      try {
        if (proxyValue.length > 4096 || /[\r\n\t]/.test(proxyValue)) throw new Error();
        const expanded = proxyValue.replace(/\{(?:random|sid)\}/g, '123456');
        if (/[{}]/.test(expanded)) throw new Error();
        const url = new URL(expanded);
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error();
      } catch (_) { throw new Error(text(locale, 'invalidProxyURL')); }
    }
    }
    Object.keys(NUMBERS).forEach(function (key) {
      const bounds = NUMBERS[key];
      if (!Number.isInteger(config[key]) || config[key] < bounds[0] || config[key] > bounds[1]) {
        throw new Error(text(locale, 'integerRange', { field: text(locale, bounds[2]), min: bounds[0], max: bounds[1] }));
      }
    });
    if (config.refresh_before_minutes >= config.ttl_minutes) throw new Error(text(locale, 'renewalBeforeTTL'));
    if (!Array.isArray(config.accounts) || config.accounts.length > 256) throw new Error(text(locale, 'maxAccounts'));
    const ids = new Set();
    let totalModels = 0;
    config.accounts.forEach(function (account) {
      if (accountID(account.account_id) === null) throw new Error(text(locale, 'positiveAccountID'));
      if (ids.has(account.account_id)) throw new Error(text(locale, 'duplicateAccount', { id: account.account_id }));
      ids.add(account.account_id);
      if (typeof account.enabled !== 'boolean') throw new Error(text(locale, 'invalidAccountSwitch'));
      if (!['pro', 'team'].includes(account.plan)) throw new Error(text(locale, 'invalidPlan'));
      if (!Array.isArray(account.models) || !account.models.length || account.models.length > 16) throw new Error(text(locale, 'modelsCount'));
      totalModels += account.models.length;
      const models = new Set();
      account.models.forEach(function (model) {
        if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) throw new Error(text(locale, 'invalidModel'));
        if (models.has(model)) throw new Error(text(locale, 'duplicateModel'));
        models.add(model);
      });
    });
    if (totalModels > 1024) throw new Error(text(locale, 'maxCombinations'));
    if (config.enabled && config.accounts.some(function (account) { return account.enabled; }) && !config.dynamic_proxy_url) {
      throw new Error(text(locale, 'dynamicRequired'));
    }
    return config;
  }
  function stateLabel(state, locale) { const item = Object.prototype.hasOwnProperty.call(STATES, state) ? STATES[state] : ['stateUnknown', 'warning']; return [text(locale, item[0]), item[1]]; }
  function errorLabel(code, locale) { return text(locale, Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : 'operationFailed'); }
  function redactError(value, locale) {
    return String(value || '')
      .replace(/(?:https?|socks5h?):\/\/[^\s/]*@/gi, text(locale, 'redactedProxy') + '@')
      .replace(/(?:x-codex-turn-state|authorization|access_token|refresh_token|api_key|password)\s*[:=]\s*[^\s,;]+/gi, text(locale, 'redactedSensitive'))
      .replace(/\beyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+){0,2}/g, text(locale, 'redactedTicket'))
      .slice(0, 400);
  }
  function parseStatus(result, locale) {
    let status = result && result.status_json;
    if (typeof status === 'string') {
      try { status = JSON.parse(status); } catch (_) { throw new Error(text(locale, 'invalidStatus')); }
    }
    if (!status || typeof status !== 'object' || Array.isArray(status)) status = {};
    return { host_ready: status.host_ready === true,
      resources_ready: status.resources_ready === true,
      accounts: Array.isArray(status.accounts) ? status.accounts.filter(a => a && accountID(a.id) !== null).map(a => ({id: accountID(a.id), name: typeof a.name === 'string' ? a.name.slice(0, 256) : ''})) : [],
      proxies: Array.isArray(status.proxies) ? status.proxies.filter(p => p && accountID(p.id) !== null).map(p => ({id:accountID(p.id), name:typeof p.name === 'string' ? p.name.slice(0,256) : '', protocol:typeof p.protocol === 'string' ? p.protocol : '', host:typeof p.host === 'string' ? p.host : '', port:Number.isInteger(p.port) ? p.port : 0})) : [],
      account_ids: Array.isArray(status.account_ids) ? Array.from(new Set(status.account_ids.map(accountID).filter(function (id) { return id !== null; }))).sort(function (a, b) { return a - b; }) : [],
      tickets: Array.isArray(status.tickets) ? status.tickets.filter(function (ticket) { return ticket && accountID(ticket.account_id) !== null; }).slice(0, 4096) : [],
      events: Array.isArray(status.events) ? status.events.slice(-200) : [],
      message: redactError(MESSAGES[status.message] ? text(locale, MESSAGES[status.message]) : (status.message || result && result.message ? text(locale, 'operationFailed') : ''), locale) };
  }
  function remainingText(seconds, locale) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const minutes = Math.floor(value / 60);
    return minutes ? text(locale, 'minutesSeconds', { minutes: minutes, seconds: Math.floor(value % 60) }) : text(locale, 'seconds', { seconds: Math.floor(value) });
  }

  function start(global) {
    const document = global.document;
    const bridge = global.Sub2APIPluginBridge;
    const locale = i18n.localeFromHash(global.location && global.location.hash);
    i18n.applyDocument(document, locale);
    const byID = function (id) { return document.getElementById(id); };
    let loaded = false;
    let busy = false;
    let dirty = false;
    let statusBusy = false;
    let closed = false;
    let pollTimer;
    let resizeObserver;
    let accounts = [];
    let accountNames = new Map();
    let accountCells = [];
    function accountLabel(id) { return accountNames.has(id) ? accountNames.get(id) + ' · ID ' + id : 'ID ' + id; }
    function updateFrontMode() {
      byID('front-manual').hidden = byID('harvest-dial-proxy-mode').value !== 'manual';
      byID('front-managed').hidden = byID('harvest-dial-proxy-mode').value !== 'managed';
    }
    function renderResources(status) {
      accountNames = new Map(status.accounts.map(a => [a.id, a.name || text(locale, 'unnamedAccount')]));
      accountCells.forEach(cell => { cell.node.textContent = accountLabel(cell.id); });
      const select = byID('harvest-dial-proxy-id');
      const selected = select.value;
      select.replaceChildren();
      const empty = element('option', text(locale, 'chooseProxy')); empty.value = ''; select.appendChild(empty);
      status.proxies.forEach(p => {
        const option = element('option', (p.name || text(locale, 'unnamedProxy')) + ' · ID ' + p.id + ' · ' + p.protocol + '://' + p.host + ':' + p.port);
        option.value = p.id; select.appendChild(option);
      });
      if (selected && !status.proxies.some(p => String(p.id) === selected)) {
        const unavailable = element('option', text(locale, 'unavailableProxy', { id: selected })); unavailable.value = selected; select.appendChild(unavailable);
      }
      select.value = selected;
      byID('managed-proxy-option').disabled = !status.resources_ready;
      byID('proxy-discovery').textContent = status.resources_ready ? text(locale, 'resourcesReady', { count: status.proxies.length }) : text(locale, 'resourcesUnavailable');
    }
    const numberIDs = { ttl_minutes: 'ttl-minutes', refresh_before_minutes: 'refresh-before-minutes',
      max_attempts: 'max-attempts', attempt_interval_seconds: 'attempt-interval-seconds', cooldown_seconds: 'cooldown-seconds' };
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    }
    function notice(message, kind) {
      const node = byID('notice');
      node.textContent = redactError(message, locale);
      node.className = 'notice' + (kind ? ' ' + kind : '');
      node.hidden = !message;
    }
    function updateSaveState(text) {
      byID('save-state').textContent = text || (dirty ? i18n.t(locale, 'unsaved') : i18n.t(locale, 'loaded'));
      byID('save-state').className = dirty ? 'dirty' : 'muted';
    }
    function markDirty() { if (loaded) { dirty = true; updateSaveState(); } }
    function setBusy(value) {
      busy = value;
      byID('config-fields').disabled = !loaded || busy;
      byID('save-config').disabled = !loaded || busy;
      byID('test-config').disabled = !loaded || busy;
    }
    function renderAccounts() {
      const body = byID('accounts-body');
      body.replaceChildren();
      accountCells = [];
      accounts.forEach(function (account, index) {
        const row = element('tr');
        const label = element('td', accountLabel(account.account_id), 'account-id');
        accountCells.push({id:account.account_id, node:label}); row.appendChild(label);
        const enabledCell = element('td');
        const enabled = element('input');
        enabled.type = 'checkbox'; enabled.checked = account.enabled === true;
        enabled.setAttribute('aria-label', text(locale, 'enableAccountAria', { id: account.account_id }));
        enabled.addEventListener('change', function () { account.enabled = enabled.checked; markDirty(); });
        enabledCell.appendChild(enabled); row.appendChild(enabledCell);
        const planCell = element('td');
        const plan = element('select'); plan.setAttribute('aria-label', text(locale, 'planAria', { id: account.account_id }));
        [['pro', 'Pro · 292'], ['team', 'Team · 332']].forEach(function (entry) {
          const option = element('option', entry[1]); option.value = entry[0]; plan.appendChild(option);
        });
        plan.value = account.plan;
        plan.addEventListener('change', function () { account.plan = plan.value; markDirty(); });
        planCell.appendChild(plan); row.appendChild(planCell);
        const modelsCell = element('td');
        const models = element('input'); models.type = 'text'; models.value = account.models.join(', '); models.spellcheck = false;
        models.autocomplete = 'off'; models.setAttribute('aria-label', text(locale, 'modelAria', { id: account.account_id }));
        models.addEventListener('input', function () { account.models = models.value.split(',').map(function (v) { return v.trim(); }).filter(Boolean); markDirty(); });
        modelsCell.appendChild(models); row.appendChild(modelsCell);
        const deleteCell = element('td'); const remove = element('button', text(locale, 'delete'), 'delete-button'); remove.type = 'button';
        remove.setAttribute('aria-label', text(locale, 'deleteAria', { id: account.account_id }));
        remove.addEventListener('click', function () { accounts.splice(index, 1); renderAccounts(); markDirty(); });
        deleteCell.appendChild(remove); row.appendChild(deleteCell); body.appendChild(row);
      });
      byID('accounts-empty').hidden = accounts.length !== 0;
      byID('account-count').textContent = text(locale, 'accountCount', { count: accounts.length });
    }
    function applyConfig(input) {
      const config = normalizeConfig(input);
      byID('enabled').checked = config.enabled === true;
      byID('dynamic-proxy-url').value = config.dynamic_proxy_url;
      byID('harvest-dial-proxy-url').value = config.harvest_dial_proxy_url;
      byID('harvest-dial-proxy-mode').value = config.harvest_dial_proxy_mode;
      const selectedProxy = byID('harvest-dial-proxy-id');
      selectedProxy.replaceChildren();
      const selectedOption = element('option', config.harvest_dial_proxy_id ? 'ID ' + config.harvest_dial_proxy_id : text(locale, 'chooseProxy'));
      selectedOption.value = config.harvest_dial_proxy_id || ''; selectedProxy.appendChild(selectedOption); selectedProxy.value = selectedOption.value;
      updateFrontMode();
      byID('observe-exit-ip').checked = config.observe_exit_ip;
      Object.keys(numberIDs).forEach(function (key) { byID(numberIDs[key]).value = config[key]; });
      accounts = config.accounts;
      renderAccounts();
      dirty = false;
      updateSaveState();
    }
    function formConfig() {
      const config = { enabled: byID('enabled').checked, dynamic_proxy_url: byID('dynamic-proxy-url').value.trim(), harvest_dial_proxy_mode: byID('harvest-dial-proxy-mode').value, harvest_dial_proxy_id: byID('harvest-dial-proxy-mode').value === 'managed' ? Number(byID('harvest-dial-proxy-id').value) : 0, harvest_dial_proxy_url: byID('harvest-dial-proxy-mode').value === 'manual' ? byID('harvest-dial-proxy-url').value.trim() : '', observe_exit_ip: byID('observe-exit-ip').checked };
      Object.keys(numberIDs).forEach(function (key) {
        const raw = byID(numberIDs[key]).value.trim();
        config[key] = raw === '' ? NaN : Number(raw);
      });
      config.accounts = accounts.map(function (account) { return {
        account_id: account.account_id, enabled: account.enabled, plan: account.plan, models: account.models.slice()
      }; });
      return validateConfig(config, locale);
    }
    function renderStatus(status) {
      renderResources(status);
      const connection = byID('connection-status');
      connection.textContent = status.host_ready ? text(locale, 'hostConnected') : text(locale, 'waitingHostInit');
      connection.className = 'badge ' + (status.host_ready ? 'success' : 'warning');
      byID('status-summary').textContent = status.message || (status.host_ready ? text(locale, 'statusUpdated') : text(locale, 'waitingHostInfo'));
      const options = byID('detected-accounts'); options.replaceChildren();
      status.account_ids.forEach(function (id) { const option = element('option', accountLabel(id)); option.setAttribute('label', accountLabel(id)); option.value = id; options.appendChild(option); });
      byID('account-discovery').textContent = status.account_ids.length ? text(locale, status.resources_ready ? 'foundAccountsNamed' : 'foundAccountsIDs', { count: status.account_ids.length }) : text(locale, 'noAccounts');
      const body = byID('tickets-body'); body.replaceChildren();
      status.tickets.forEach(function (ticket) {
        const row = element('tr'); const account = element('td', accountLabel(accountID(ticket.account_id)));
        const model = typeof ticket.model === 'string' && MODEL_PATTERN.test(ticket.model) ? ticket.model : text(locale, 'unknownModel');
        account.appendChild(element('span', model, 'status-model')); row.appendChild(account);
        row.appendChild(element('td', ticket.plan === 'team' ? 'Team · 332' : ticket.plan === 'pro' ? 'Pro · 292' : '—'));
        const state = stateLabel(ticket.state, locale); const stateCell = element('td');
        stateCell.appendChild(element('span', state[0], 'badge ' + state[1])); row.appendChild(stateCell);
        const remaining = element('td', remainingText(ticket.remaining_seconds, locale));
        if (typeof ticket.expires_at === 'string' && Number.isFinite(Date.parse(ticket.expires_at))) remaining.title = text(locale, 'expiresAt', { time: new Date(ticket.expires_at).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN') });
        row.appendChild(remaining);
        const attempts = Number.isSafeInteger(ticket.attempts) && ticket.attempts > 0 ? text(locale, 'attempts', { count: ticket.attempts }) : '—';
        const detail = element('td', attempts, 'error-detail');
        if (ticket.last_error) detail.appendChild(element('div', errorLabel(ticket.last_error, locale)));
        row.appendChild(detail); body.appendChild(row);
      });
      byID('tickets-empty').hidden = status.tickets.length !== 0;
      const logs = byID('activity-body'); logs.replaceChildren();
      status.events.slice().reverse().forEach(function (entry) {
        if (!entry || accountID(entry.account_id) === null) return;
        const row = element('tr');
        const time = Number.isFinite(Date.parse(entry.time)) ? new Date(entry.time).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN') : '—';
        row.appendChild(element('td', time + ' / ' + accountLabel(accountID(entry.account_id))));
        const phaseKey = { harvest: 'phaseHarvest', validate: 'phaseValidate', restore: 'phaseRestore', collection: 'phaseCollection', watchdog: 'phaseWatchdog' }[entry.phase];
        const phase = phaseKey ? text(locale, phaseKey) : '—';
        row.appendChild(element('td', phase + (entry.chained ? ' · ' + text(locale, 'chained') : '') + (Number.isSafeInteger(entry.attempt) && entry.attempt > 0 ? ' · ' + text(locale, 'attemptNumber', { count: entry.attempt }) : '')));
        const ip = typeof entry.exit_ip === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(entry.exit_ip) ? entry.exit_ip : '—';
        row.appendChild(element('td', ip));
        const resultKey = { started: 'resultStarted', ip_observed: 'resultIPObserved', ip_check_failed: 'resultIPCheckFailed', model_matched: 'resultModelMatched', model_mismatch: 'resultModelMismatch', incomplete_response: 'resultIncomplete', transport_failed: 'resultTransportFailed', transport_unavailable: 'resultTransportUnavailable', ready: 'resultReady', cancelled: 'resultCancelled' }[entry.result];
        const result = resultKey ? text(locale, resultKey) : errorLabel(entry.result, locale);
        const cell = element('td', result);
        const details = [];
        if (Number.isSafeInteger(entry.http_status) && entry.http_status > 0) details.push('HTTP ' + entry.http_status);
        if (typeof entry.actual_model === 'string' && MODEL_PATTERN.test(entry.actual_model)) details.push(entry.actual_model);
        if (Number.isSafeInteger(entry.state_bytes) && entry.state_bytes >= 0) details.push(text(locale, 'bytes', { count: entry.state_bytes }));
        if (Number.isSafeInteger(entry.duration_ms) && entry.duration_ms >= 0) details.push(text(locale, 'duration', { seconds: (entry.duration_ms / 1000).toFixed(1) }));
        cell.appendChild(element('div', details.join(' · '), 'muted')); row.appendChild(cell); logs.appendChild(row);
      });
      byID('activity-empty').hidden = logs.children.length !== 0;
    }
    async function refreshStatus() {
      if (closed || statusBusy || !bridge) return;
      statusBusy = true; byID('refresh-status').disabled = true;
      try {
        const response = await bridge.status();
        if (!closed) renderStatus(parseStatus(response.result, locale));
      } catch (error) {
        if (!closed) {
          byID('connection-status').textContent = text(locale, 'statusUnavailable');
          byID('connection-status').className = 'badge warning';
          byID('status-summary').textContent = redactError(error.message, locale);
        }
      } finally { statusBusy = false; if (!closed) byID('refresh-status').disabled = false; }
    }
    byID('harvest-dial-proxy-mode').addEventListener('change', updateFrontMode);
    byID('config-form').addEventListener('input', markDirty);
    byID('config-form').addEventListener('change', markDirty);
    async function saveConfig(event) {
      event.preventDefault(); if (busy || !loaded) return;
      let config;
      try { config = formConfig(); } catch (error) { notice(error.message, 'error'); return; }
      setBusy(true); updateSaveState(text(locale, 'saving'));
      try {
        const response = await bridge.save(config);
        if (closed) return;
        applyConfig(response.config); updateSaveState(text(locale, 'saved'));
        notice(text(locale, config.enabled ? 'savedEnabled' : 'savedDisabled'), 'success');
        await refreshStatus();
      } catch (error) { if (!closed) { notice(error.message, 'error'); updateSaveState(text(locale, 'saveUnconfirmed')); } }
      finally { if (!closed) setBusy(false); }
    }
    // The host iframe does not grant allow-forms: save via Bridge on an explicit
    // button click instead of relying on sandbox-blocked native form submission.
    byID('save-config').addEventListener('click', saveConfig);
    byID('config-form').addEventListener('submit', saveConfig);
    byID('add-account').addEventListener('click', function () {
      const id = accountID(byID('new-account-id').value);
      if (id === null) { notice(text(locale, 'invalidAccountInput'), 'error'); return; }
      if (accounts.some(function (account) { return account.account_id === id; })) { notice(text(locale, 'accountExists'), 'error'); return; }
      if (accounts.length >= 256) { notice(text(locale, 'maxAccounts'), 'error'); return; }
      accounts.push({ account_id: id, enabled: false, plan: 'pro', models: ['gpt-6-astra'] });
      renderAccounts(); markDirty(); byID('new-account-id').value = ''; notice(text(locale, 'accountAdded', { id: id }));
    });
    byID('new-account-id').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); byID('add-account').click(); }
    });
    byID('toggle-proxy').addEventListener('click', function () {
      const input = byID('dynamic-proxy-url'); const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password'; byID('toggle-proxy').textContent = text(locale, reveal ? 'hide' : 'show');
      byID('toggle-proxy').setAttribute('aria-pressed', String(reveal));
    });
    byID('toggle-front-proxy').addEventListener('click', function () {
      const input = byID('harvest-dial-proxy-url'); const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password'; byID('toggle-front-proxy').textContent = text(locale, reveal ? 'hide' : 'show');
      byID('toggle-front-proxy').setAttribute('aria-pressed', String(reveal));
    });
    byID('test-config').addEventListener('click', async function () {
      if (busy || !loaded) return;
      setBusy(true); notice(text(locale, 'checking'));
      try {
        const response = await bridge.test();
        if (!closed) notice(text(locale, 'checkComplete') + (dirty ? text(locale, 'stillUnsaved') : ''), 'success');
      } catch (error) { if (!closed) notice(error.message, 'error'); }
      finally { if (!closed) setBusy(false); }
    });
    byID('refresh-status').addEventListener('click', refreshStatus);
    function resize() { try { bridge.resize(document.documentElement.scrollHeight); } catch (_) { /* Context may already be closed. */ } }
    function stop() {
      if (closed) return;
      closed = true; global.clearInterval(pollTimer);
      if (resizeObserver) resizeObserver.disconnect();
      if (bridge) bridge.dispose();
      global.removeEventListener('pagehide', stop);
    }
    global.addEventListener('pagehide', stop);
    (async function () {
      try {
        if (!bridge) throw new Error(text(locale, 'bridgeMissing'));
        bridge.ready();
        const response = await bridge.load();
        if (closed) return;
        applyConfig(response.config); loaded = true; setBusy(false); resize();
        if (global.ResizeObserver) { resizeObserver = new global.ResizeObserver(resize); resizeObserver.observe(document.body); }
        await refreshStatus();
        if (!closed) pollTimer = global.setInterval(function () { if (document.visibilityState !== 'hidden') refreshStatus(); }, 5000);
      } catch (error) { if (!closed) { notice(error.message, 'error'); updateSaveState(text(locale, 'configNotLoaded')); byID('connection-status').textContent = text(locale, 'connectionFailed'); } }
    })();
    return { stop: stop, refreshStatus: refreshStatus };
  }
  return { DEFAULT_CONFIG: DEFAULT_CONFIG, normalizeConfig: normalizeConfig, validateConfig: validateConfig,
    accountID: accountID, parseStatus: parseStatus, stateLabel: stateLabel, errorLabel: errorLabel, redactError: redactError, remainingText: remainingText, start: start };
});
