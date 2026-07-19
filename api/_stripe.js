// Zero-dependency Stripe REST client using built-in fetch.
// Avoids the `stripe` npm package so these functions deploy with no install step.

const STRIPE_BASE = 'https://api.stripe.com/v1';

// How long a customer keeps working after Stripe marks the subscription
// past_due. Stripe retries a failed renewal charge for days (smart retries),
// so an instant block would lock out a paying customer over a single card
// blip. Shared by validate.js and activate.js so the two doors agree.
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function authHeader() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return 'Bearer ' + key;
}

export async function stripeGet(pathWithQuery) {
  const res = await fetch(`${STRIPE_BASE}${pathWithQuery}`, {
    headers: { Authorization: authHeader() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe GET ${pathWithQuery} failed (${res.status})`);
  return data;
}

export async function stripePost(path, params, idempotencyKey) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method: 'POST',
    headers,
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe POST ${path} failed (${res.status})`);
  return data;
}

// Create a pending invoice item for one overage report. It attaches to the
// customer's NEXT subscription invoice and is collected with the monthly
// renewal — money never moves at request time, so a leaked license key can
// only add visible, refundable line items, never trigger an immediate charge.
// Idempotency-Key (derived from the reportId) makes client retries safe.
export async function createOverageInvoiceItem(customerId, amountCents, description, idempotencyKey) {
  return stripePost('/invoiceitems', {
    customer: customerId,
    amount: amountCents,
    currency: 'usd',
    description,
  }, idempotencyKey);
}

// Find ALL customers with this license_key (handles accidental duplicates).
export async function findCustomersByLicense(licenseKey) {
  const safe = licenseKey.replace(/'/g, '');
  const q = encodeURIComponent(`metadata['license_key']:'${safe}'`);
  const result = await stripeGet(`/customers/search?query=${q}&limit=10`);
  return result.data || [];
}

// Resolve the account for a license key: prefer the customer that actually has
// an active/past_due subscription. Falls back to the first customer found so
// callers can still distinguish "invalid key" from "no subscription".
export async function resolveAccount(licenseKey) {
  const customers = await findCustomersByLicense(licenseKey);
  if (!customers.length) return { customer: null, sub: null, status: 'none' };

  for (const customer of customers) {
    const { sub, status } = await getSubscription(customer.id);
    if (sub) return { customer, sub, status };
  }
  // No subscription on any matching customer.
  return { customer: customers[0], sub: null, status: 'none' };
}

// Get the active (or past_due) subscription for a customer.
// No deep expand — price.product comes back as an ID, fetched separately in
// planFromSubscription (Stripe caps expand depth, so deep expands error out).
export async function getSubscription(customerId) {
  const active = await stripeGet(`/subscriptions?customer=${customerId}&status=active&limit=1`);
  if (active.data?.length) return { sub: active.data[0], status: 'active' };

  const pastDue = await stripeGet(`/subscriptions?customer=${customerId}&status=past_due&limit=1`);
  if (pastDue.data?.length) return { sub: pastDue.data[0], status: 'past_due' };

  const trialing = await stripeGet(`/subscriptions?customer=${customerId}&status=trialing&limit=1`);
  if (trialing.data?.length) return { sub: trialing.data[0], status: 'active' };

  return { sub: null, status: 'none' };
}

// Plan metadata lives on the product. Resolve the product (id or object) and read it.
export async function planFromSubscription(sub) {
  let product = sub?.items?.data?.[0]?.price?.product;

  // price.product is usually an ID string — fetch the product to get its metadata.
  if (product && typeof product === 'string') {
    try {
      product = await stripeGet(`/products/${product}`);
    } catch {
      product = null;
    }
  }

  const meta = (product && typeof product === 'object' ? product.metadata : null) || {};
  return {
    planName: meta.plan_name || 'Standard',
    reportsIncluded: parseMoneyish(meta.reports_included, 15, parseInt),
    overageRate: parseMoneyish(meta.overage_rate, 15.0, parseFloat),
  };
}

// Parse a metadata number tolerantly: a trailing comma followed by 1-2 digits
// is a decimal separator ("15,00" → 15), other commas/currency symbols/
// whitespace are stripped as thousands separators or noise ("$1,000" → 1000),
// and ambiguous multi-dot results ("1.000,50") fall back to the safe default —
// never a silent 100x misparse on a billing rate.
export function parseMoneyish(raw, fallback, parser) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).replace(/,(\d{1,2})$/, '.$1');
  const cleaned = normalized.replace(/[^0-9.]/g, '');
  if ((cleaned.match(/\./g) || []).length > 1) return fallback;
  const n = parser(cleaned, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Period start under both classic and flexible billing.
export function periodStartOf(sub) {
  return sub?.current_period_start || sub?.items?.data?.[0]?.current_period_start || null;
}

// Reset the usage + overage counters when the subscription has advanced to a
// new billing period since we last recorded one. This makes the period reset
// self-healing and independent of a single webhook delivery: if invoice.paid is
// ever dropped or delayed, the next validate/report-complete still resets. The
// webhook remains a fast path. Idempotent — a no-op once period_start matches.
export async function ensureCurrentPeriod(customer, sub) {
  const start = periodStartOf(sub);
  if (!start) return customer;
  const recorded = customer.metadata?.period_start ? parseInt(customer.metadata.period_start, 10) : null;
  if (recorded === start) return customer;

  // One atomic multi-key write — a partial reset (counter cleared but
  // period_start not, or vice versa) would strand last period's usage into the
  // new period. Failure propagates to the callers' try/catch → 500 → retry.
  await stripePost(`/customers/${customer.id}`, {
    'metadata[reports_used_current_period]': '0',
    'metadata[overage_pending]': '0',
    'metadata[period_start]': String(start),
  });
  // Reflect the reset in the in-memory object so the caller counts from zero.
  customer.metadata = { ...customer.metadata, reports_used_current_period: '0', overage_pending: '0', period_start: String(start) };
  return customer;
}

export function formatPeriodEnd(sub) {
  // Under Stripe's flexible billing the period moved to the line item, so fall
  // back to the item's current_period_end when the top-level field is absent.
  const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Update customer metadata fields in ONE request. Stripe merges keys, and the
// single POST is atomic — related fields (a counter and its dedupe marker)
// either all commit or none do. null/undefined values are skipped by
// stripePost; pass '' to unset a key.
export async function setCustomerMetadata(customerId, fields) {
  const params = {};
  for (const [key, value] of Object.entries(fields || {})) {
    params[`metadata[${key}]`] = value;
  }
  return stripePost(`/customers/${customerId}`, params);
}
