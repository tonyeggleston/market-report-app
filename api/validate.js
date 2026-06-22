import { findCustomerByLicense, getSubscription, planFromSubscription, formatPeriodEnd } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    const customer = await findCustomerByLicense(licenseKey);
    if (!customer) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key.' });
    }

    const { sub, status } = await getSubscription(customer.id);

    if (!sub) {
      return res.json({ active: false, reason: 'no-subscription', message: 'No active subscription found.' });
    }

    if (status === 'past_due') {
      return res.json({
        active: false,
        reason: 'past-due',
        message: 'Your subscription payment is past due. Please update your payment method.',
      });
    }

    const { planName, reportsIncluded, overageRate } = await planFromSubscription(sub);
    const reportsUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);

    return res.json({
      active: true,
      plan: planName,
      reportsIncluded,
      reportsUsed,
      overageRate,
      billingPeriodEnd: formatPeriodEnd(sub),
      customerId: customer.id,
    });
  } catch (err) {
    console.error('Validate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
