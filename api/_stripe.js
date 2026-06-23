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

  let firstCustomer = customers[0];
  for (const customer of customers) {
    const { sub, status } = await getSubscription(customer.id);
    if (sub) return { customer, sub, status };
  }
  // No subscription on any matching customer.
  return { customer: firstCustomer, sub: null, status: 'none' };
}

// Back-compat: single-customer lookup (first match).
export async function findCustomerByLicense(licenseKey) {
  const customers = await findCustomersByLicense(licenseKey);
  return customers[0] || null;
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
    reportsIncluded: parseInt(meta.reports_included || '15', 10),
    overageRate: parseFloat(meta.overage_rate || '15.00'),
  };
}

export function formatPeriodEnd(sub) {
  // Under Stripe's flexible billing the period moved to the line item, so fall
  // back to the item's current_period_end when the top-level field is absent.
  const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
  if (!end) return null;
  return new Date(end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Update a single metadata field on a customer.
export async function setCustomerMetadata(customerId, key, value) {
  return stripePost(`/customers/${customerId}`, { [`metadata[${key}]`]: value });
}
