import { resolveAccount, planFromSubscription, formatPeriodEnd, setCustomerMetadata } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    const { customer, sub } = await resolveAccount(licenseKey);

    if (!customer) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key. Check the key and try again.' });
    }

    if (!sub) {
      return res.json({
        active: false,
        reason: 'no-subscription',
        message: 'This license key is valid but has no active subscription. Please subscribe at our website.',
      });
    }

    const { planName, reportsIncluded, overageRate } = await planFromSubscription(sub);

    // Initialize the usage counter if it's not set yet.
    if (customer.metadata?.reports_used_current_period === undefined) {
      await setCustomerMetadata(customer.id, 'reports_used_current_period', '0').catch(() => {});
    }

    return res.json({
      active: true,
      plan: planName,
      reportsIncluded,
      reportsUsed: parseInt(customer.metadata?.reports_used_current_period || '0', 10),
      overageRate,
      billingPeriodEnd: formatPeriodEnd(sub),
      message: `License activated! You have ${reportsIncluded} reports included per month.`,
    });
  } catch (err) {
    console.error('Activate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
