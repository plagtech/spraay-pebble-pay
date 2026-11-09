// PebbleKit JS companion. Runs on the phone while the watchapp is open.
//
// Holds no private keys: the payment API named in the settings does the wallet signing.
// Written in ES5 because PebbleKit JS runs on older phone JavaScript engines.

// Values of PaymentStatus. Keep in sync with src/c/main.c.
var STATUS_REQUEST = 0;
var STATUS_SENT = 1;
var STATUS_DENIED = 2;
var STATUS_FAILED = 3;
var STATUS_UNKNOWN = 4;

var POLL_INTERVAL_MS = 10000;
var HTTP_TIMEOUT_MS = 30000;
// Slightly longer than the watch's own 60 second timeout, which should always fire first.
var DECISION_TIMEOUT_MS = 65000;
var SEND_ATTEMPTS = 3;
var SEND_RETRY_MS = 1000;

var MAX_QUEUE = 20;
var MAX_SEEN = 200;
var MAX_HISTORY = 50;

var MAX_ID_LEN = 128;
var MAX_SERVICE_LEN = 31;
var MAX_URL_LEN = 63;
// The longest amount that still fits on one line of the narrowest watch screens.
var MAX_AMOUNT_LEN = 14;

var USDC_DECIMALS = 6;
var BASE_NETWORK = 'eip155:8453';
var BASE_SEPOLIA_NETWORK = 'eip155:84532';
var USDC_ADDRESSES = {};
USDC_ADDRESSES[BASE_NETWORK] = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
USDC_ADDRESSES[BASE_SEPOLIA_NETWORK] = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

var STORAGE_CONFIG = 'spraay.config';
var STORAGE_SEEN = 'spraay.seen';
var STORAGE_HISTORY = 'spraay.history';

var config = readJson(STORAGE_CONFIG, {});
var seenIds = readJson(STORAGE_SEEN, []);
var queue = [];
var current = null;
var polling = false;
var pollTimer = null;
var decisionTimer = null;
// Starts from the clock so that ids never repeat across companion restarts.
var nextMessageId = (Math.floor(Date.now() / 1000) % 1000000000) + 1;

// Storage ---------------------------------------------------------------------

function readJson(key, fallback) {
  try {
    var value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.log('Could not save ' + key + ': ' + e);
  }
}

function markSeen(id) {
  seenIds.push(id);
  if (seenIds.length > MAX_SEEN) {
    seenIds = seenIds.slice(seenIds.length - MAX_SEEN);
  }
  writeJson(STORAGE_SEEN, seenIds);
}

function recordHistory(request, status, txHash) {
  var history = readJson(STORAGE_HISTORY, []);
  history.unshift({
    id: request.id,
    service: request.service,
    url: request.url,
    amount: request.amount,
    network: request.requirement.network,
    status: status,
    txHash: txHash || null,
    time: new Date().toISOString()
  });
  writeJson(STORAGE_HISTORY, history.slice(0, MAX_HISTORY));
}

// Parsing ---------------------------------------------------------------------

function isAllowedEndpoint(url) {
  return /^https:\/\/[^\s/]+/i.test(url) ||
    /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/i.test(url);
}

function isConfigured() {
  return isAllowedEndpoint(config.pollUrl || '') && isAllowedEndpoint(config.payUrl || '');
}

// Watch fonts are ASCII-only here, and this also strips control and lookalike characters.
function toPrintableAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?');
}

function hostOf(url) {
  var match = /^https?:\/\/(?:[^\/?#@]*@)?([^\/?#:]+)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

// The end of a hostname is the part that identifies its owner, so that is the part kept.
function displayUrl(url) {
  var host = toPrintableAscii(hostOf(url));
  if (host.length > MAX_URL_LEN) {
    return '...' + host.slice(host.length - (MAX_URL_LEN - 3));
  }
  var rest = toPrintableAscii(url.replace(/^https?:\/\/[^\/?#]*/i, '').replace(/[?#].*$/, ''));
  // On separate lines so the watch's word wrap does not hyphenate the URL at the join.
  var text = rest.length > 1 ? host + '\n' + rest : host;
  return text.length > MAX_URL_LEN ? text.slice(0, MAX_URL_LEN - 3) + '...' : text;
}

// "250000" -> "0.25". Works on strings because amounts can exceed safe integer range.
function formatUsdc(atomic) {
  var digits = atomic;
  while (digits.length <= USDC_DECIMALS) {
    digits = '0' + digits;
  }
  var split = digits.length - USDC_DECIMALS;
  var fraction = digits.slice(split).replace(/0+$/, '');
  return digits.slice(0, split) + (fraction ? '.' + fraction : '');
}

function compareAtomic(a, b) {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : (a > b ? 1 : 0);
}

// Same rule as spraay-device-pay: only exact-scheme USDC at the pinned contract on an enabled
// network, cheapest first. The server does not get to choose the token or the chain.
function selectRequirement(challenge) {
  if (!challenge || !Array.isArray(challenge.accepts)) {
    return null;
  }
  var best = null;
  challenge.accepts.forEach(function (requirement) {
    if (!requirement || requirement.scheme !== 'exact') {
      return;
    }
    if (requirement.network === BASE_SEPOLIA_NETWORK && !config.allowTestnet) {
      return;
    }
    var usdc = USDC_ADDRESSES[requirement.network];
    if (!usdc || String(requirement.asset).toLowerCase() !== usdc) {
      return;
    }
    if (!/^[1-9]\d*$/.test(requirement.amount || '')) {
      return;
    }
    if (!best || compareAtomic(requirement.amount, best.amount) < 0) {
      best = requirement;
    }
  });
  return best;
}

// Returns the request to show on the watch, or null if it cannot be shown truthfully.
function normalizeRequest(raw) {
  if (!raw || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) {
    return null;
  }
  var id = String(raw.id);
  if (!id || id.length > MAX_ID_LEN || typeof raw.url !== 'string' || !hostOf(raw.url)) {
    return null;
  }
  var requirement = selectRequirement(raw.challenge);
  if (!requirement) {
    return null;
  }
  // Refused rather than cut short: a truncated amount would misstate the price.
  var amount = formatUsdc(requirement.amount);
  if (amount.length > MAX_AMOUNT_LEN) {
    return null;
  }
  var service = toPrintableAscii(typeof raw.service === 'string' && raw.service ? raw.service
    : hostOf(raw.url));
  if (requirement.network === BASE_SEPOLIA_NETWORK) {
    service = 'TEST ' + service;
  }
  return {
    id: id,
    url: raw.url,
    service: service.slice(0, MAX_SERVICE_LEN),
    displayUrl: displayUrl(raw.url),
    amount: amount,
    requirement: requirement,
    challenge: raw.challenge
  };
}

function shortTxHash(txHash) {
  return txHash ? txHash.slice(0, 6) + '...' + txHash.slice(-4) : '';
}

// HTTP ------------------------------------------------------------------------

function authHeaders() {
  var headers = { 'Accept': 'application/json' };
  if (config.apiToken) {
    headers['Authorization'] = 'Bearer ' + config.apiToken;
  }
  return headers;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Calls back with (HTTP status, parsed JSON body), or status 0 if no response arrived.
function httpJson(method, url, headers, body, callback) {
  var finished = false;
  function finish(status, text) {
    if (!finished) {
      finished = true;
      callback(status, parseJson(text));
    }
  }
  setTimeout(function () { finish(0, ''); }, HTTP_TIMEOUT_MS);

  // Not every PebbleKit JS runtime provides fetch().
  if (typeof fetch === 'function') {
    fetch(url, { method: method, headers: headers, body: body }).then(function (response) {
      return response.text().then(function (text) { finish(response.status, text); });
    }).catch(function () { finish(0, ''); });
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open(method, url);
  Object.keys(headers).forEach(function (name) { xhr.setRequestHeader(name, headers[name]); });
  xhr.onload = function () { finish(xhr.status, xhr.responseText); };
  xhr.onerror = function () { finish(0, ''); };
  xhr.send(body);
}

// Watch messages --------------------------------------------------------------

function sendToWatch(message, attemptsLeft, onAck, onFail) {
  Pebble.sendAppMessage(message, onAck, function () {
    if (attemptsLeft > 1) {
      setTimeout(function () {
        sendToWatch(message, attemptsLeft - 1, onAck, onFail);
      }, SEND_RETRY_MS);
    } else if (onFail) {
      onFail();
    }
  });
}

function noop() {}

function isKnown(id) {
  return seenIds.indexOf(id) !== -1 ||
    (current !== null && current.id === id) ||
    queue.some(function (request) { return request.id === id; });
}

function showNext() {
  if (current !== null || queue.length === 0) {
    return;
  }
  var request = queue.shift();
  request.messageId = nextMessageId++;
  current = request;
  sendToWatch({
    PaymentId: request.messageId,
    PaymentStatus: STATUS_REQUEST,
    PaymentAmount: request.amount,
    PaymentService: request.service,
    PaymentUrl: request.displayUrl
  }, SEND_ATTEMPTS, function () {
    // Once the user has seen it, a request is never shown again, whatever they do with it.
    markSeen(request.id);
    decisionTimer = setTimeout(function () {
      decisionTimer = null;
      deny(request, 'timed out');
    }, DECISION_TIMEOUT_MS);
  }, function () {
    // Never displayed, so the next poll can safely try again.
    if (current === request) {
      current = null;
      queue.unshift(request);
    }
  });
}

function finish(request, status, txHash) {
  recordHistory(request, status, txHash);
  sendToWatch({
    PaymentId: request.messageId,
    PaymentStatus: status,
    TxHash: shortTxHash(txHash)
  }, SEND_ATTEMPTS, noop, noop);
  current = null;
  showNext();
}

function deny(request, reason) {
  console.log('Payment ' + request.id + ' denied (' + reason + '), discarding');
  finish(request, STATUS_DENIED, null);
}

// Sent once only. A retry could pay twice, so an unclear outcome is reported as unknown.
function pay(request) {
  var headers = authHeaders();
  headers['Content-Type'] = 'application/json';
  headers['Idempotency-Key'] = request.id;
  var body = JSON.stringify({
    id: request.id,
    url: request.url,
    requirement: request.requirement,
    challenge: request.challenge
  });
  httpJson('POST', config.payUrl, headers, body, function (status, json) {
    if (status >= 200 && status < 300 && json && json.status === 'settled') {
      var txHash = /^0x[0-9a-fA-F]{64}$/.test(json.txHash || '') ? json.txHash : null;
      finish(request, STATUS_SENT, txHash);
    } else if ((status >= 200 && status < 300 && json && json.status === 'failed') ||
               (status >= 400 && status < 500 && status !== 408)) {
      finish(request, STATUS_FAILED, null);
    } else {
      finish(request, STATUS_UNKNOWN, null);
    }
  });
}

function handleDecision(payload) {
  var request = current;
  if (request === null || request.decided || payload.PaymentId !== request.messageId) {
    return;
  }
  request.decided = true;
  if (decisionTimer !== null) {
    clearTimeout(decisionTimer);
    decisionTimer = null;
  }
  // Only an explicit 1 is an approval.
  if (payload.UserDecision === 1) {
    pay(request);
  } else {
    deny(request, 'by user');
  }
}

// Polling ---------------------------------------------------------------------

function poll() {
  if (polling || !isConfigured()) {
    return;
  }
  polling = true;
  httpJson('GET', config.pollUrl, authHeaders(), undefined, function (status, json) {
    polling = false;
    if (status === 200 && json && Array.isArray(json.requests)) {
      json.requests.forEach(function (raw) {
        var id = raw && raw.id !== undefined ? String(raw.id) : '';
        if (!id || isKnown(id) || queue.length >= MAX_QUEUE) {
          return;
        }
        var request = normalizeRequest(raw);
        if (request) {
          queue.push(request);
        } else {
          console.log('Rejected payment request ' + id);
          markSeen(id);
        }
      });
    } else if (status !== 204) {
      console.log('Poll failed with status ' + status);
    }
    showNext();
  });
}

function startPolling() {
  if (pollTimer === null) {
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }
  poll();
}

// Settings --------------------------------------------------------------------

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function configPageHtml() {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Spraay Pay</title><style>' +
    'body{font:16px sans-serif;margin:16px}label{display:block;margin:16px 0 4px}' +
    'input[type=url],input[type=password]{width:100%;box-sizing:border-box;padding:8px}' +
    'button{margin-top:24px;padding:12px;width:100%;font-size:16px}' +
    '</style></head><body><h2>Spraay Pay</h2>' +
    '<label for="p">Polling endpoint (HTTPS)</label>' +
    '<input id="p" type="url" value="' + escapeHtml(config.pollUrl) + '">' +
    '<label for="s">Payment endpoint (HTTPS)</label>' +
    '<input id="s" type="url" value="' + escapeHtml(config.payUrl) + '">' +
    '<label for="t">API token (optional)</label>' +
    '<input id="t" type="password" value="' + escapeHtml(config.apiToken) + '">' +
    '<label><input id="n" type="checkbox"' + (config.allowTestnet ? ' checked' : '') + '> ' +
    'Allow Base Sepolia testnet</label>' +
    '<button id="b">Save</button><script>' +
    'document.getElementById("b").onclick=function(){' +
    'var g=function(i){return document.getElementById(i)};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify({' +
    'pollUrl:g("p").value.trim(),payUrl:g("s").value.trim(),' +
    'apiToken:g("t").value,allowTestnet:g("n").checked}))};' +
    '</script></body></html>';
}

function applyConfig(response) {
  var updated;
  try {
    updated = JSON.parse(decodeURIComponent(response));
  } catch (e) {
    return;
  }
  if (!updated || !isAllowedEndpoint(updated.pollUrl || '') ||
      !isAllowedEndpoint(updated.payUrl || '')) {
    console.log('Settings not saved: endpoints must use HTTPS');
    return;
  }
  config = {
    pollUrl: updated.pollUrl,
    payUrl: updated.payUrl,
    apiToken: updated.apiToken || '',
    allowTestnet: updated.allowTestnet === true
  };
  writeJson(STORAGE_CONFIG, config);
  poll();
}

// Events ----------------------------------------------------------------------

Pebble.addEventListener('ready', startPolling);

Pebble.addEventListener('appmessage', function (e) {
  handleDecision(e.payload);
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(configPageHtml()));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    applyConfig(e.response);
  }
});
