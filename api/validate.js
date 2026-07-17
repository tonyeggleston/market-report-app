import { resolveAccount, planFromSubscription, formatPeriodEnd, ensureCurrentPeriod } from './_stripe.js';
import { signLicenseToken } from './_license-token.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    let { customer, sub, status } = await resolveAccount(licenseKey);

    if (!customer) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key.' });
    }

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

    // Self-healing period reset (independent of the webhook) before we read the counter.
    customer = await ensureCurrentPeriod(customer, sub);

    const { planName, reportsIncluded, overageRate } = await planFromSubscription(sub);
    const reportsUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
    const overagesThisPeriod = parseInt(customer.metadata?.overage_pending || '0', 10);

    // Signed token for offline grace — proof the server confirmed a paid,
    // active subscription. Null when no signing key is configured (online path
    // is unaffected). The client verifies the signature before trusting it.
    const token = signLicenseToken(
      { customerId: customer.id, licenseKey, plan: planName, reportsIncluded, overageRate },
      Date.now()
    );

    return res.json({
      active: true,
      plan: planName,
      reportsIncluded,
      reportsUsed,
      overagesThisPeriod,
      overageRate,
      billingPeriodEnd: formatPeriodEnd(sub),
      customerId: customer.id,
      token,
    });
  } catch (err) {
    console.error('Validate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
