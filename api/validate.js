import { resolveAccount, planFromSubscription, formatPeriodEnd, ensureCurrentPeriod, setCustomerMetadata, PAST_DUE_GRACE_MS } from './_stripe.js';
import { signLicenseToken } from './_license-token.js';
import { rateLimited } from './_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimited(req, res, { tag: 'validate', ipLimit: 60, keyLimit: 30 })) return;

  const { licenseKey } = req.body || {};
  if (!licenseKey || typeof licenseKey !== 'string') return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    let { customer, sub, status } = await resolveAccount(licenseKey);

    if (!customer) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key.' });
    }

    if (!sub) {
      return res.json({ active: false, reason: 'no-subscription', message: 'No active subscription found.' });
    }

    if (status === 'past_due') {
      // Grace window: allow up to PAST_DUE_GRACE_MS from when we first saw the
      // account go past_due, so a transient failed charge doesn't hard-block a
      // customer mid-dunning. Cleared back to active below when the sub recovers.
      const since = customer.metadata?.past_due_since ? parseInt(customer.metadata.past_due_since, 10) : null;
      const now = Date.now();
      if (!since) {
        await setCustomerMetadata(customer.id, { past_due_since: String(now) }).catch(() => {});
      } else if (now - since > PAST_DUE_GRACE_MS) {
        return res.json({
          active: false,
          reason: 'past-due',
          message: 'Your subscription payment is past due. Please update your payment method to continue.',
        });
      }
      // else: still inside grace — fall through and serve as active-with-warning.
    } else if (customer.metadata?.past_due_since) {
      // Recovered — clear the marker so a future dunning starts a fresh window.
      await setCustomerMetadata(customer.id, { past_due_since: '' }).catch(() => {});
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
      ...(status === 'past_due' ? { pastDue: true, message: 'Your last payment failed — please update your payment method. Reports keep working for a few days while we retry.' } : {}),
    });
  } catch (err) {
    console.error('Validate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
