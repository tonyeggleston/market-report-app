import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey, listingAddress, completedAt } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    // Look up customer
    const customers = await stripe.customers.search({
      query: `metadata['license_key']:'${licenseKey}'`,
      limit: 1,
    });

    if (!customers.data.length) {
      return res.status(404).json({ error: 'Invalid license key' });
    }

    const customer = customers.data[0];

    // Increment usage counter
    const currentUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
    const newCount = currentUsed + 1;

    await stripe.customers.update(customer.id, {
      metadata: {
        ...customer.metadata,
        reports_used_current_period: String(newCount),
        last_report_address: listingAddress || '',
        last_report_at: completedAt || new Date().toISOString(),
      },
    });

    // Check if this is an overage report
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    if (subs.data.length) {
      const sub = subs.data[0];
      const reportsIncluded = parseInt(sub.metadata?.reports_included || '10', 10);
      const overageRate = parseFloat(sub.metadata?.overage_rate || '15.00');

      if (newCount > reportsIncluded) {
        // Create a one-time invoice item for the overage
        await stripe.invoiceItems.create({
          customer: customer.id,
          amount: Math.round(overageRate * 100), // cents
          currency: 'usd',
          description: `Overage report #${newCount} — ${listingAddress || 'unlisted'}`,
        });

        // Create and finalize the invoice immediately
        const invoice = await stripe.invoices.create({
          customer: customer.id,
          auto_advance: true, // auto-charge the customer's payment method
        });
        await stripe.invoices.finalizeInvoice(invoice.id);

        return res.json({
          ok: true,
          reportsUsed: newCount,
          overage: true,
          overageCharge: overageRate,
          message: `Report recorded. Overage charge of $${overageRate.toFixed(2)} applied.`,
        });
      }
    }

    return res.json({
      ok: true,
      reportsUsed: newCount,
      overage: false,
      message: `Report ${newCount} recorded.`,
    });
  } catch (err) {
    console.error('Report-complete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
