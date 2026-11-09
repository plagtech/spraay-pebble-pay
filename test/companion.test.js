const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'pkjs', 'index.js'), 'utf8');
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HASH = '0x' + 'ab'.repeat(32);

function challenge(amount = '250000', over = {}) {
  return { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount, payTo: '0xR', ...over }] };
}
function req(id, amount, over) {
  return { id, url: 'https://api.example.com/v1/data?secret=1', service: 'Example', challenge: challenge(amount, over) };
}

function env({ withFetch = false, config = { pollUrl: 'https://p.example/poll', payUrl: 'https://p.example/pay', apiToken: 'tok' } } = {}) {
  const h = { listeners: {}, watch: [], calls: [], timers: [], now: 0, nextAck: () => true, responder: null, logs: [] };
  const store = { 'spraay.config': JSON.stringify(config) };
  const respond = (method, url, headers, body) => h.responder(method, url, headers, body);
  function setT(fn, ms) { const t = { fn, at: h.now + ms, id: h.timers.length + 1 }; h.timers.push(t); return t.id; }
  class XHR {
    open(m, u) { this.m = m; this.u = u; this.h = {}; }
    setRequestHeader(k, v) { this.h[k] = v; }
    send(b) {
      h.calls.push({ method: this.m, url: this.u, headers: this.h, body: b });
      const r = respond(this.m, this.u, this.h, b);
      if (r === null) { this.onerror(); return; }
      if (r === undefined) return;
      this.status = r[0]; this.responseText = r[1] === undefined ? '' : JSON.stringify(r[1]); this.onload();
    }
  }
  const ctx = {
    console: { log: (m) => h.logs.push(String(m)) }, JSON, Date, Math, Object, Array, String, RegExp, encodeURIComponent, decodeURIComponent,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    setTimeout: setT, clearTimeout: (id) => { h.timers = h.timers.filter((t) => t.id !== id); },
    setInterval: () => 1, XMLHttpRequest: XHR,
    Pebble: {
      addEventListener: (n, f) => { h.listeners[n] = f; },
      sendAppMessage: (m, ok, fail) => { h.watch.push(m); h.nextAck(m) ? ok() : fail(); },
      openURL: (u) => { h.opened = u; },
    },
  };
  if (withFetch) {
    ctx.fetch = (url, o) => { h.calls.push({ method: o.method, url, headers: o.headers, body: o.body }); const r = respond(o.method, url, o.headers, o.body);
      return Promise.resolve({ status: r[0], text: () => Promise.resolve(JSON.stringify(r[1])) }); };
  }
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  h.store = store;
  h.history = () => JSON.parse(store['spraay.history'] || '[]');
  h.ready = () => h.listeners.ready();
  h.decide = (id, d) => h.listeners.appmessage({ payload: { PaymentId: id, UserDecision: d } });
  h.advance = (ms) => { const end = h.now + ms; let due; while ((due = h.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0])) { h.timers.splice(h.timers.indexOf(due), 1); h.now = due.at; due.fn(); } h.now = end; };
  h.pays = () => h.calls.filter((c) => c.method === 'POST');
  h.serve = (requests, pay) => { h.responder = (m) => (m === 'GET' ? [200, { requests }] : (typeof pay === 'function' ? pay() : pay)); };
  h.prompts = () => h.watch.filter((m) => m.PaymentStatus === 0);
  h.results = () => h.watch.filter((m) => m.PaymentStatus !== 0);
  return h;
}

const tests = {
  'approve: shows, pays exactly once, reports sent with short hash'() {
    const h = env(); h.serve([req('a')], [200, { status: 'settled', txHash: HASH }]); h.ready();
    const p = h.prompts()[0];
    assert.strictEqual(p.PaymentAmount, '0.25'); assert.strictEqual(p.PaymentService, 'Example');
    assert.strictEqual(p.PaymentUrl, 'api.example.com\n/v1/data', 'query must be dropped');
    assert.strictEqual(h.pays().length, 0, 'nothing paid before approval');
    h.decide(p.PaymentId, 1);
    assert.strictEqual(h.pays().length, 1);
    const c = h.pays()[0]; assert.strictEqual(c.headers['Idempotency-Key'], 'a'); assert.strictEqual(c.headers.Authorization, 'Bearer tok');
    assert.strictEqual(JSON.parse(c.body).requirement.amount, '250000');
    const r = h.results()[0]; assert.strictEqual(r.PaymentStatus, 1); assert.strictEqual(r.TxHash, '0xabab...abab'); assert.ok(r.TxHash.length < 16);
    assert.strictEqual(h.history()[0].txHash, HASH);
  },
  'deny: never contacts payment API, and is not re-prompted'() {
    const h = env(); h.serve([req('a')], [200, { status: 'settled' }]); h.ready();
    h.decide(h.prompts()[0].PaymentId, 0);
    assert.strictEqual(h.pays().length, 0); assert.strictEqual(h.results()[0].PaymentStatus, 2);
    h.ready(); assert.strictEqual(h.prompts().length, 1);
  },
  'no decision: denied after timeout, no payment'() {
    const h = env(); h.serve([req('a')], [200, {}]); h.ready();
    h.advance(65001);
    assert.strictEqual(h.pays().length, 0); assert.strictEqual(h.results()[0].PaymentStatus, 2);
  },
  'late approval after timeout is ignored'() {
    const h = env(); h.serve([req('a')], [200, { status: 'settled' }]); h.ready();
    const id = h.prompts()[0].PaymentId; h.advance(65001); h.decide(id, 1);
    assert.strictEqual(h.pays().length, 0);
  },
  'decision with wrong id is ignored'() {
    const h = env(); h.serve([req('a')], [200, { status: 'settled' }]); h.ready();
    h.decide(h.prompts()[0].PaymentId + 1, 1); assert.strictEqual(h.pays().length, 0);
  },
  'only UserDecision === 1 approves'() {
    for (const d of [2, -1, '1', true, undefined]) {
      const h = env(); h.serve([req('a')], [200, { status: 'settled' }]); h.ready();
      h.decide(h.prompts()[0].PaymentId, d); assert.strictEqual(h.pays().length, 0, String(d));
    }
  },
  'double approve pays once'() {
    const h = env(); h.serve([req('a')], undefined); h.responder = (m) => (m === 'GET' ? [200, { requests: [req('a')] }] : undefined); h.ready();
    const id = h.prompts()[0].PaymentId; h.decide(id, 1); h.decide(id, 1);
    assert.strictEqual(h.pays().length, 1);
  },
  'one request at a time, in order'() {
    const h = env(); h.serve([req('a'), req('b')], [200, { status: 'settled', txHash: HASH }]); h.ready();
    assert.strictEqual(h.prompts().length, 1);
    h.decide(h.prompts()[0].PaymentId, 1);
    assert.strictEqual(h.prompts().length, 2); assert.notStrictEqual(h.prompts()[0].PaymentId, h.prompts()[1].PaymentId);
  },
  'wrong token, chain or scheme rejected'() {
    for (const over of [{ asset: '0xdead' }, { network: 'eip155:1' }, { scheme: 'upto' }, { network: 'eip155:1', asset: BASE_USDC }]) {
      const h = env(); h.serve([req('a', '250000', over)], [200, {}]); h.ready();
      assert.strictEqual(h.prompts().length, 0, JSON.stringify(over));
    }
  },
  'bad amounts rejected'() {
    for (const a of ['0', '-1', '1.5', 'abc', '', '0x10', '012']) {
      const h = env(); h.serve([req('a', a)], [200, {}]); h.ready();
      assert.strictEqual(h.prompts().length, 0, a);
    }
  },
  'amount formatting is exact'() {
    const cases = { 1: '0.000001', 250000: '0.25', 1000000: '1', 1500000: '1.5', 123456789: '123.456789', 9999999123456: '9999999.123456' };
    for (const [a, want] of Object.entries(cases)) {
      const h = env(); h.serve([req('a', a)], [200, {}]); h.ready();
      assert.strictEqual(h.prompts()[0].PaymentAmount, want);
    }
  },
  'over-long amount rejected, not truncated'() {
    const h = env(); h.serve([req('a', '99999999123456')], [200, {}]); h.ready();
    assert.strictEqual(h.prompts().length, 0);
  },
  'cheapest valid requirement is the one paid'() {
    const h = env(); const r = req('a'); r.challenge.accepts = [
      { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount: '900000' },
      { scheme: 'exact', network: 'eip155:8453', asset: '0xdead', amount: '1' },
      { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount: '100000' }];
    h.serve([r], [200, { status: 'settled' }]); h.ready();
    assert.strictEqual(h.prompts()[0].PaymentAmount, '0.1');
    h.decide(h.prompts()[0].PaymentId, 1);
    assert.strictEqual(JSON.parse(h.pays()[0].body).requirement.amount, '100000');
  },
  'testnet off by default, labeled when enabled'() {
    const over = { network: 'eip155:84532', asset: SEPOLIA_USDC };
    let h = env(); h.serve([req('a', '1000', over)], [200, {}]); h.ready(); assert.strictEqual(h.prompts().length, 0);
    h = env({ config: { pollUrl: 'https://p.x/a', payUrl: 'https://p.x/b', allowTestnet: true } }); h.serve([req('a', '1000', over)], [200, {}]); h.ready();
    assert.strictEqual(h.prompts()[0].PaymentService, 'TEST Example');
  },
  'outcomes map to the right status, no retry'() {
    const cases = [[[200, { status: 'settled', txHash: HASH }], 1], [[200, { status: 'failed' }], 3], [[402, {}], 3], [[408, {}], 4], [[500, {}], 4], [[200, { status: 'weird' }], 4], [[200, undefined], 4], [null, 4]];
    for (const [resp, want] of cases) {
      const h = env(); h.serve([req('a')], resp); h.ready();
      h.decide(h.prompts()[0].PaymentId, 1);
      assert.strictEqual(h.results()[0].PaymentStatus, want, JSON.stringify(resp)); assert.strictEqual(h.pays().length, 1);
    }
  },
  'pay endpoint hanging resolves to unknown after timeout'() {
    const h = env(); h.responder = (m) => (m === 'GET' ? [200, { requests: [req('a')] }] : undefined); h.ready();
    h.decide(h.prompts()[0].PaymentId, 1); assert.strictEqual(h.results().length, 0);
    h.advance(30001); assert.strictEqual(h.results()[0].PaymentStatus, 4); assert.strictEqual(h.pays().length, 1);
  },
  'undelivered request retries, then returns to queue and is re-offered'() {
    const h = env(); h.nextAck = () => false; h.serve([req('a')], [200, {}]); h.ready();
    h.advance(3000); assert.strictEqual(h.prompts().length, 3);
    h.nextAck = () => true; h.ready();
    assert.strictEqual(h.prompts().length, 4);
    h.decide(h.prompts()[3].PaymentId, 0); assert.strictEqual(h.results()[0].PaymentStatus, 2);
  },
  'hostname is preserved and lookalike chars neutralized'() {
    const h = env(); const r = req('a'); r.url = 'https://user:pw@evil.example/' + 'x'.repeat(200); r.service = 'P\u0430yPal\n';
    h.serve([r], [200, {}]); h.ready();
    const p = h.prompts()[0]; assert.ok(p.PaymentUrl.startsWith('evil.example\n/')); assert.ok(p.PaymentUrl.length <= 63, 'len'); assert.strictEqual(p.PaymentService, 'P?yPal?');
  },
  'unconfigured or plain-http endpoints do nothing'() {
    for (const config of [{}, { pollUrl: 'http://x.example/p', payUrl: 'https://x.example/q' }]) {
      const h = env({ config }); h.responder = () => { throw new Error('called'); }; h.ready(); assert.strictEqual(h.calls.length, 0);
    }
  },
  'settings: saves https, refuses plain http'() {
    const h = env({ config: {} }); h.responder = () => [204];
    h.listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify({ pollUrl: 'http://bad.example', payUrl: 'https://a.example' })) });
    assert.strictEqual(h.calls.length, 0); assert.strictEqual(h.store['spraay.config'], '{}');
    h.listeners.webviewclosed({ response: encodeURIComponent(JSON.stringify({ pollUrl: 'https://a.example/p', payUrl: 'https://a.example/q', apiToken: 't' })) });
    assert.strictEqual(h.calls.length, 1); assert.strictEqual(JSON.parse(h.store['spraay.config']).apiToken, 't');
    h.listeners.webviewclosed({ response: 'not json%' }); h.listeners.webviewclosed({});
  },
  'settings page: value is escaped'() {
    const h = env({ config: { pollUrl: 'https://a"><script>x', payUrl: 'https://b' } }); h.listeners.showConfiguration();
    assert.ok(!decodeURIComponent(h.opened).includes('value="https://a"><script>'));
  },
  'poll: junk bodies are survived'() {
    for (const resp of [[200, null], [200, { requests: 'x' }], [200, { requests: [null, 5, {}, { id: 'q' }] }], [204], [500, {}], null]) {
      const h = env(); h.responder = () => resp; h.ready(); assert.strictEqual(h.prompts().length, 0);
    }
  },
  async 'uses fetch when present'() {
    const h = env({ withFetch: true }); h.serve([req('a')], [200, { status: 'settled', txHash: HASH }]); h.ready();
    await new Promise((r) => setTimeout(r, 10));
    h.decide(h.prompts()[0].PaymentId, 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(h.results()[0].PaymentStatus, 1);
  },
  'no private key material handled'() {
    assert.ok(!/privateKey|mnemonic|signTypedData/i.test(SRC));
  },
};

(async () => {
  let failed = 0;
  for (const [name, t] of Object.entries(tests)) {
    try { await t(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
  process.exit(failed ? 1 : 0);
})();
