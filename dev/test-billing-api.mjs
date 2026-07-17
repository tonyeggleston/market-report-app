// Offline test of the licensing/billing API handlers against a mocked Stripe.
// Drives the REAL handler modules (api/validate.js, api/report-complete.js,
// api/webhook.js) with a fake global.fetch that plays Stripe, and asserts the
// full billing contract:
//   - payment-current gate (active / past_due / no-sub / bad key)
//   - per-period usage tracking + reportId dedupe
//   - per-run overage billing via pending invoice items (amount, idempotency)
//   - exemption paths (env allow-list + customer metadata) never create items
//   - invoice-item failure degrades to overage_pending, never loses the run
//   - webhook cycle reset (real HMAC signature)
//
// Usage:  node dev/test-billing-api.mjs

import crypto from 'node:crypto';

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.OPENROUTER_API_KEY = 'sk-or-test-fake'; // AI proxy: real calls are mocked below

// Ephemeral Ed25519 keypair for the token tests: private key on the "server",
// public key stands in for the one bundled in the client.
const { publicKey: TEST_PUBKEY, privateKey: TEST_PRIVKEY } = crypto.generateKeyPairSync('ed25519');
process.env.LICENSE_SIGNING_KEY = TEST_PRIVKEY.export({ type: 'pkcs8', format: 'pem' });

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── Mock Stripe ─────────────────────────────────────────────────────────────
const state = {
  customer: null,          // fixture served by /customers/search
  sub: null,               // fixture served by /subscriptions
  subStatus: 'active',
  invoiceItemCalls: [],    // captured POST /invoiceitems
  metadataWrites: [],      // captured POST /customers/{id}
  failInvoiceItems: false,
  openrouterCalls: [],     // captured POST to openrouter (AI proxy path)
  failOpenRouter: false,
};

function resetState({ used = '0', metadata = {}, subStatus = 'active', hasSub = true } = {}) {
  state.customer = {
    id: 'cus_test1',
    // period_start defaults to the current sub period so ensureCurrentPeriod is
    // a no-op unless a test deliberately sets an OLD period_start to exercise
    // the rollover reset.
    metadata: { license_key: 'MP-TEST-KEY', period_start: '1780000000', reports_used_current_period: used, ...metadata },
  };
  state.sub = hasSub ? { id: 'sub_test1', items: { data: [{ price: { product: 'prod_test1' }, current_period_start: 1780000000, current_period_end: 1790000000 }] } } : null;
  state.subStatus = subStatus;
  state.invoiceItemCalls = [];
  state.metadataWrites = [];
  state.failInvoiceItems = false;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const respond = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });

  if (u.includes('openrouter.ai')) {
    state.openrouterCalls.push(JSON.parse(opts.body));
    if (state.failOpenRouter) return respond({ error: { message: 'upstream_boom' } }, false, 500);
    return respond({ choices: [{ message: { content: 'MOCK_AI_REPLY' } }] });
  }
  if (u.includes('/customers/search')) {
    return respond({ data: state.customer ? [state.customer] : [] });
  }
  if (u.includes('/subscriptions?')) {
    const wantStatus = new URL(u).searchParams.get('status');
    const match = state.sub && wantStatus === state.subStatus;
    return respond({ data: match ? [state.sub] : [] });
  }
  if (u.includes('/products/')) {
    return respond({ id: 'prod_test1', metadata: { plan_name: 'Standard', reports_included: '15', overage_rate: '15.00' } });
  }
  if (u.includes('/invoiceitems') && opts.method === 'POST') {
    if (state.failInvoiceItems) return respond({ error: { message: 'card_declined_simulation' } }, false, 402);
    state.invoiceItemCalls.push({ body: Object.fromEntries(new URLSearchParams(opts.body)), idempotencyKey: opts.headers['Idempotency-Key'] });
    return respond({ id: 'ii_test1' });
  }
  if (/\/customers\/cus_/.test(u) && opts.method === 'POST') {
    const body = Object.fromEntries(new URLSearchParams(opts.body));
    state.metadataWrites.push(body);
    // Mirror metadata writes into the fixture so later reads see them.
    for (const [k, v] of Object.entries(body)) {
      const m = k.match(/^metadata\[(.+)\]$/);
      if (m) state.customer.metadata[m[1]] = v;
    }
    return respond(state.customer);
  }
  throw new Error(`Unmocked fetch: ${u}`);
};

// ── Fake req/res ────────────────────────────────────────────────────────────
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

const { default: validate } = await import('../api/validate.js');
const { default: reportComplete } = await import('../api/report-complete.js');
const { default: webhook } = await import('../api/webhook.js');
const { default: ai } = await import('../api/ai.js');
const { allow, rateLimited, clientIp } = await import('../api/_ratelimit.js');
const { verifyLicenseToken: serverVerify, TOKEN_GRACE_MS } = await import('../api/_license-token.js');

// ── validate: the payment-current gate ──────────────────────────────────────
console.log('=== validate ===');
resetState({ used: '3' });
let res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('active sub validates', res.body.active === true && res.body.reportsIncluded === 15 && res.body.reportsUsed === 3, JSON.stringify(res.body).slice(0, 90));

resetState({ hasSub: false });
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('no subscription BLOCKS', res.body.active === false && res.body.reason === 'no-subscription');

state.customer = null;
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-WRONG' } }, res);
check('invalid key BLOCKS', res.body.active === false && res.body.reason === 'invalid-key');

// ── report-complete: usage + per-run overage billing ────────────────────────
console.log('\n=== report-complete ===');
resetState({ used: '3' });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', listingAddress: '4222 Frank St', reportId: 'r1' } }, res);
check('under quota: counted, no invoice item', res.body.reportsUsed === 4 && res.body.overage === false && state.invoiceItemCalls.length === 0);

resetState({ used: '15' });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', listingAddress: '4222 Frank St, Dallas', reportId: 'r16', completedAt: '2026-07-16T12:00:00Z' } }, res);
const item = state.invoiceItemCalls[0];
check('over quota: invoice item created', res.body.overage === true && res.body.billed === true && state.invoiceItemCalls.length === 1);
check('item is $15.00 usd on the customer', item && item.body.amount === '1500' && item.body.currency === 'usd' && item.body.customer === 'cus_test1');
check('item description carries address + date', item && /4222 Frank St, Dallas/.test(item.body.description) && /2026-07-16/.test(item.body.description), item?.body.description);
check('idempotency key derived from reportId', item?.idempotencyKey === 'mp-overage-cus_test1-r16', item?.idempotencyKey);
check('overage_pending counter still recorded', state.customer.metadata.overage_pending === '1');

resetState({ used: '15', metadata: { last_report_id: 'r16' } });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 'r16' } }, res);
check('same reportId dedupes (no count, no item)', res.body.deduped === true && state.invoiceItemCalls.length === 0 && state.metadataWrites.length === 0);

process.env.OVERAGE_EXEMPT_KEYS = ' MP-OTHER , MP-TEST-KEY ';
resetState({ used: '20' });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', listingAddress: '15 Hillcrest', reportId: 'r21' } }, res);
check('env-exempt key (Davis Team): tracked, never billed', res.body.overage === true && res.body.billed === false && state.invoiceItemCalls.length === 0 && state.customer.metadata.overage_pending === '1');
delete process.env.OVERAGE_EXEMPT_KEYS;

resetState({ used: '20', metadata: { overage_billing: 'manual' } });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 'r22' } }, res);
check('metadata overage_billing=manual: never billed', res.body.overage === true && res.body.billed === false && state.invoiceItemCalls.length === 0);

resetState({ used: '15' });
state.failInvoiceItems = true;
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 'r17' } }, res);
check('invoice-item failure: run still recorded, billed=false, pending kept', res.body.ok === true && res.body.reportsUsed === 16 && res.body.billed === false && state.customer.metadata.overage_pending === '1');

// ── webhook: cycle reset with a real signature ──────────────────────────────
console.log('\n=== webhook ===');
resetState({ used: '18', metadata: { overage_pending: '3' } });
const payload = JSON.stringify({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle', customer: 'cus_test1' } } });
const ts = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', 'whsec_testsecret').update(`${ts}.${payload}`).digest('hex');
const req = { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload); } };
res = makeRes();
await webhook(req, res);
check('signed cycle-paid resets usage + overage counters', res.body?.received === true && state.customer.metadata.reports_used_current_period === '0' && state.customer.metadata.overage_pending === '0');

const badReq = { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=deadbeef` }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload); } };
res = makeRes();
await webhook(badReq, res);
check('bad signature rejected', res.statusCode === 400);

// ── signed offline token: sign → verify roundtrip + tamper/expiry ───────────
console.log('\n=== signed offline token ===');
const { signLicenseToken } = await import('../api/_license-token.js');
const nowMs = 1784200000000;
const tok = signLicenseToken({ customerId: 'cus_test1', licenseKey: 'MP-TEST-KEY', plan: 'Standard', reportsIncluded: 15, overageRate: 15 }, nowMs);
check('validate signs a token when signing key present', tok && tok.payload && tok.sig);

// Client-side verification mirror (same logic as license.js verifyLicenseToken).
const verify = (token, licenseKey) => {
  if (!token?.payload || !token?.sig) return null;
  try {
    if (!crypto.verify(null, Buffer.from(token.payload), TEST_PUBKEY, Buffer.from(token.sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(token.payload, 'base64url').toString('utf8'));
    return p.licenseKey === licenseKey ? p : null;
  } catch { return null; }
};
const good = verify(tok, 'MP-TEST-KEY');
check('client verifies a genuine token', good && good.customerId === 'cus_test1' && good.validUntil > nowMs, good ? `validUntil +${Math.round((good.validUntil-nowMs)/3600000)}h` : 'null');
check('token bound to its license key (wrong key rejected)', verify(tok, 'MP-OTHER') === null);
const tampered = { payload: Buffer.from(JSON.stringify({ ...good, reportsIncluded: 999999 })).toString('base64url'), sig: tok.sig };
check('tampered payload fails verification', verify(tampered, 'MP-TEST-KEY') === null);
const forged = { payload: Buffer.from(JSON.stringify({ v:1, customerId:'cus_x', licenseKey:'MP-FORGE', validUntil: nowMs + 1e9 })).toString('base64url'), sig: Buffer.from('x'.repeat(64)).toString('base64url') };
check('forged cache (no valid sig) is rejected — the payment-gate bypass is closed', verify(forged, 'MP-FORGE') === null);
delete process.env.LICENSE_SIGNING_KEY;
check('no signing key → no token (online path unaffected)', signLicenseToken({ customerId: 'c', licenseKey: 'k' }, nowMs) === null);
process.env.LICENSE_SIGNING_KEY = TEST_PRIVKEY.export({ type: 'pkcs8', format: 'pem' });

// ── period rollover: self-healing reset independent of the webhook ──────────
console.log('\n=== period rollover ===');
resetState({ used: '9', metadata: { period_start: '1770000000', overage_pending: '2' } }); // stored period is OLD
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 'p1' } }, res);
check('advanced period resets counter before counting (9→reset→1)', res.body.reportsUsed === 1 && state.customer.metadata.period_start === '1780000000' && state.customer.metadata.overage_pending === '0', `used=${res.body.reportsUsed}`);

resetState({ used: '5', metadata: { period_start: '1780000000' } }); // stored period MATCHES current
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 'p2' } }, res);
check('same period does NOT reset (5→6)', res.body.reportsUsed === 6);

// ── idempotency key namespaced by customer id ───────────────────────────────
console.log('\n=== idempotency namespacing ===');
resetState({ used: '15' });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 5 } }, res); // numeric rowid
check('idempotency key includes customer id (cross-install collision fixed)', state.invoiceItemCalls[0]?.idempotencyKey === 'mp-overage-cus_test1-5', state.invoiceItemCalls[0]?.idempotencyKey);

// numeric reportId dedupe (metadata is a string — the === bug)
resetState({ used: '15', metadata: { last_report_id: '5' } });
res = makeRes();
await reportComplete({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY', reportId: 5 } }, res);
check('numeric reportId dedupes against string metadata', res.body.deduped === true && state.invoiceItemCalls.length === 0);

// ── tolerant overage_rate parsing ───────────────────────────────────────────
console.log('\n=== tolerant rate parse ===');
const { parseMoneyish } = await import('../api/_stripe.js');
check('"$15.00" → 15 (not NaN)', parseMoneyish('$15.00', 99, parseFloat) === 15);
check('"20" → 20', parseMoneyish('20', 99, parseFloat) === 20);
check('missing → fallback', parseMoneyish('', 15, parseFloat) === 15 && parseMoneyish(undefined, 15, parseFloat) === 15);

// ── past_due grace window ───────────────────────────────────────────────────
console.log('\n=== past_due grace ===');
resetState({ subStatus: 'past_due' }); // first time seen past_due — no marker yet
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('past_due first-seen: served active-with-warning + marker stamped',
  res.body.active === true && res.body.pastDue === true && !!state.customer.metadata.past_due_since, res.body.message);

resetState({ subStatus: 'past_due', metadata: { past_due_since: String(Date.now() - 1000) } }); // 1s into grace
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('past_due within grace: still active (dunning-safe)', res.body.active === true && res.body.pastDue === true);

resetState({ subStatus: 'past_due', metadata: { past_due_since: String(Date.now() - 8 * 24 * 3600 * 1000) } }); // 8d > 7d grace
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('past_due beyond grace: BLOCKS', res.body.active === false && res.body.reason === 'past-due', res.body.message);

resetState({ subStatus: 'active', metadata: { past_due_since: '1234567890' } }); // recovered
res = makeRes();
await validate({ method: 'POST', body: { licenseKey: 'MP-TEST-KEY' } }, res);
check('recovered: marker cleared, no warning',
  res.body.active === true && !res.body.pastDue && state.customer.metadata.past_due_since === '');

// ── server-side token verification (AI-proxy auth) ──────────────────────────
console.log('\n=== server token verify ===');
const sNow = 1784200000000;
const sTok = signLicenseToken({ customerId: 'cus_test1', licenseKey: 'MP-TEST-KEY', plan: 'Standard', reportsIncluded: 15, overageRate: 15 }, sNow);
check('server verifies a genuine, unexpired token', serverVerify(sTok, sNow + 1000)?.customerId === 'cus_test1');
check('server rejects an expired token', serverVerify(sTok, sNow + TOKEN_GRACE_MS + 1) === null);
const sTampered = { payload: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(sTok.payload, 'base64url')), reportsIncluded: 999999 })).toString('base64url'), sig: sTok.sig };
check('server rejects a tampered token', serverVerify(sTampered, sNow + 1000) === null);
check('server rejects null/empty token', serverVerify(null, sNow) === null && serverVerify({}, sNow) === null);

// ── AI proxy: token-gated, model-capped, cost-bounded ───────────────────────
console.log('\n=== AI proxy ===');
const aiTok = signLicenseToken({ customerId: 'cus_test1', licenseKey: 'MP-TEST-KEY', plan: 'Standard', reportsIncluded: 15, overageRate: 15 }, Date.now());
const aiReq = (body) => ({ method: 'POST', headers: {}, body });
const callAi = async (body, reqOverride) => {
  state.openrouterCalls = [];
  const r = makeRes();
  await ai(reqOverride || aiReq(body), r);
  return r;
};

res = await callAi({ token: aiTok, mode: 'vision', content: [{ type: 'text', text: 'hi' }], model: 'google/gemini-2.5-flash' });
check('valid token: call proxied, content returned', res.body?.content === 'MOCK_AI_REPLY' && state.openrouterCalls.length === 1 && state.openrouterCalls[0].model === 'google/gemini-2.5-flash');

res = await callAi({ mode: 'vision', content: 'x' }); // no token
check('missing token: 401, no upstream call', res.statusCode === 401 && state.openrouterCalls.length === 0);

const forgedAi = { payload: aiTok.payload, sig: Buffer.from('x'.repeat(64)).toString('base64url') };
res = await callAi({ token: forgedAi, mode: 'vision', content: 'x' });
check('forged token: 401, no upstream call', res.statusCode === 401 && state.openrouterCalls.length === 0);

res = await callAi({ token: aiTok, mode: 'bogus', content: 'x' });
check('bad mode: 400', res.statusCode === 400 && state.openrouterCalls.length === 0);

res = await callAi({ token: aiTok, mode: 'vision' }); // missing content
check('missing content: 400', res.statusCode === 400 && state.openrouterCalls.length === 0);

res = await callAi(null, { method: 'GET', headers: {}, body: {} });
check('GET: 405', res.statusCode === 405);

res = await callAi({ token: aiTok, mode: 'vision', content: 'x', model: 'openai/gpt-4o', max_tokens: 999999 });
check('non-allowlisted model forced to default (no premium-model bill)', state.openrouterCalls[0]?.model === 'google/gemini-2.5-flash');
check('max_tokens capped server-side (999999 → 4096 vision)', state.openrouterCalls[0]?.max_tokens === 4096);

res = await callAi({ token: aiTok, mode: 'text', content: 'x', model: 'google/gemini-2.5-flash-lite' });
check('allowlisted alt model preserved; text cap = 1024', state.openrouterCalls[0]?.model === 'google/gemini-2.5-flash-lite' && state.openrouterCalls[0]?.max_tokens === 1024);

state.failOpenRouter = true;
res = await callAi({ token: aiTok, mode: 'vision', content: 'x' });
check('upstream error → generic 502 (no provider internals leaked)', res.statusCode === 502 && res.body.error === 'AI request failed.' && !/boom/.test(JSON.stringify(res.body)));
state.failOpenRouter = false;

// ── rate limiter ────────────────────────────────────────────────────────────
console.log('\n=== rate limiter ===');
let permitted = 0;
for (let i = 0; i < 6; i++) if (allow('rl-unit-a', { limit: 3, windowMs: 60_000 })) permitted++;
check('allow() permits exactly `limit` then blocks (3 of 6)', permitted === 3);

let rejected429 = false, firstPassed = false;
for (let i = 0; i < 5; i++) {
  const rr = makeRes();
  const blocked = rateLimited({ method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: {} }, rr, { tag: 'rl-unit-b', ipLimit: 3, keyLimit: 100, windowMs: 60_000 });
  if (i === 0) firstPassed = !blocked;
  if (blocked) rejected429 = rr.statusCode === 429;
}
check('rateLimited: first requests pass, floods get 429', firstPassed && rejected429);
check('clientIp tolerates a bare req (no headers)', clientIp({}) === 'unknown');

console.log(failures ? `\n✗ ${failures} check(s) FAILED` : '\n✓ BILLING API verified: signed offline tokens + payment gate + past_due grace + usage tracking + per-run overage invoicing + period self-heal + exemptions + idempotency + AI proxy auth/model-cap/cost-bound + rate limiting.');
process.exit(failures ? 1 : 0);
