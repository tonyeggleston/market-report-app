import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    // Look up customer by license key
    const customers = await stripe.customers.search({
      query: `metadata['license_key']:'${licenseKey}'`,
      limit: 1,
    });

    if (!customers.data.length) {
      return res.json({ active: false, reason: 'invalid-key', message: 'Invalid license key. Check the key and try again.' });
    }

    const customer = customers.data[0];

    // Get active subscription
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    if (!subs.data.length) {
      return res.json({
        active: false,
        reason: 'no-subscription',
        message: 'This license key is valid but has no active subscription. Please subscribe at our website.',
      });
    }

    const sub = subs.data[0];
    const plan = sub.metadata?.plan_name || 'Standard';
    const reportsIncluded = parseInt(sub.metadata?.reports_included || '10', 10);
    const overageRate = parseFloat(sub.metadata?.overage_rate || '15.00');
    const periodEnd = sub.current_period_end;

    // Mark activation
    await stripe.customers.update(customer.id, {
      metadata: {
        ...customer.metadata,
        activated_at: new Date().toISOString(),
        reports_used_current_period: customer.metadata?.reports_used_current_period || '0',
      },
    });

    return res.json({
      active: true,
      plan,
      reportsIncluded,
      reportsUsed: parseInt(customer.metadata?.reports_used_current_period || '0', 10),
      overageRate,
      billingPeriodEnd: new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      message: `License activated! You have ${reportsIncluded} reports included per month.`,
    });
  } catch (err) {
    console.error('Activate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
