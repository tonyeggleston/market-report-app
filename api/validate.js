import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    // Look up customer by license key stored in Stripe metadata
    const customers = await stripe.customers.search({
      query: `metadata['license_key']:'${licenseKey}'`,
      limit: 1,
    });

    if (!customers.data.length) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key.' });
    }

    const customer = customers.data[0];

    // Get active subscription
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    if (!subs.data.length) {
      // Check for past_due (grace period)
      const pastDue = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'past_due',
        limit: 1,
      });

      if (pastDue.data.length) {
        return res.json({
          active: false,
          reason: 'past-due',
          message: 'Your subscription payment is past due. Please update your payment method.',
        });
      }

      return res.json({ active: false, reason: 'no-subscription', message: 'No active subscription found.' });
    }

    const sub = subs.data[0];
    const plan = sub.metadata?.plan_name || 'Standard';
    const reportsIncluded = parseInt(sub.metadata?.reports_included || '10', 10);
    const overageRate = parseFloat(sub.metadata?.overage_rate || '15.00');

    // Count reports used in current billing period
    const periodStart = sub.current_period_start;
    const periodEnd = sub.current_period_end;

    // Usage stored in Stripe usage records on a metered price, or in metadata
    const reportsUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);

    return res.json({
      active: true,
      plan,
      reportsIncluded,
      reportsUsed,
      overageRate,
      billingPeriodEnd: new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      customerId: customer.id,
    });
  } catch (err) {
    console.error('Validate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
