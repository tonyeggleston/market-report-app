// Zero-dependency Stripe REST client using built-in fetch.
// Avoids the `stripe` npm package so these functions deploy with no install step.

const STRIPE_BASE = 'https://api.stripe.com/v1';

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

export async function stripePost(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe POST ${path} failed (${res.status})`);
  return data;
}

// Find a customer by the license_key stored in their metadata.
export async function findCustomerByLicense(licenseKey) {
  // Stripe search query — escape single quotes in the key defensively.
  const safe = licenseKey.replace(/'/g, '');
  const q = encodeURIComponent(`metadata['license_key']:'${safe}'`);
  const result = await stripeGet(`/customers/search?query=${q}&limit=1`);
  return result.data?.[0] || null;
}

// Get the active (or past_due) subscription for a customer, with the product expanded
// so we can read plan metadata (reports_included, overage_rate, plan_name).
export async function getSubscription(customerId) {
  const expand = '&expand[]=data.items.data.price.product';
  const active = await stripeGet(`/subscriptions?customer=${customerId}&status=active&limit=1${expand}`);
  if (active.data?.length) return { sub: active.data[0], status: 'active' };

  const pastDue = await stripeGet(`/subscriptions?customer=${customerId}&status=past_due&limit=1${expand}`);
  if (pastDue.data?.length) return { sub: pastDue.data[0], status: 'past_due' };

  const trialing = await stripeGet(`/subscriptions?customer=${customerId}&status=trialing&limit=1${expand}`);
  if (trialing.data?.length) return { sub: trialing.data[0], status: 'active' };

  return { sub: null, status: 'none' };
}

// Plan metadata lives on the product. Read it from the expanded subscription.
export function planFromSubscription(sub) {
  const product = sub?.items?.data?.[0]?.price?.product;
  const meta = (product && typeof product === 'object' ? product.metadata : null) || {};
  return {
    planName: meta.plan_name || 'Standard',
    reportsIncluded: parseInt(meta.reports_included || '15', 10),
    overageRate: parseFloat(meta.overage_rate || '15.00'),
  };
}

export function formatPeriodEnd(sub) {
  const end = sub?.current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Update a single metadata field on a customer.
export async function setCustomerMetadata(customerId, key, value) {
  return stripePost(`/customers/${customerId}`, { [`metadata[${key}]`]: value });
}
