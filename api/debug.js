import { findCustomersByLicense, stripeGet } from './_stripe.js';

// TEMPORARY diagnostic — gated by knowing the exact license key.
// Returns raw customer + subscription data (no secrets) to debug lookups.
// DELETE after diagnosis.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    const customers = await findCustomersByLicense(licenseKey);
    const out = [];

    for (const c of customers) {
      // ALL subscriptions for this customer, any status.
      const subs = await stripeGet(`/subscriptions?customer=${c.id}&status=all&limit=10`);
      out.push({
        customerId: c.id,
        hasLicenseKeyMeta: !!c.metadata?.license_key,
        licenseKeyMeta: c.metadata?.license_key || null,
        subscriptions: (subs.data || []).map((s) => ({
          id: s.id,
          status: s.status,
          priceId: s.items?.data?.[0]?.price?.id || null,
          productId: s.items?.data?.[0]?.price?.product || null,
        })),
      });
    }

    return res.json({ matchCount: customers.length, customers: out });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
