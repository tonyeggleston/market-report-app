import { resolveAccount, planFromSubscription, setCustomerMetadata, stripePost } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey, listingAddress, completedAt } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    const { customer, sub } = await resolveAccount(licenseKey);
    if (!customer) return res.status(404).json({ error: 'Invalid license key' });

    // Increment usage counter (on the customer that holds the subscription).
    const currentUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
    const newCount = currentUsed + 1;

    await setCustomerMetadata(customer.id, 'reports_used_current_period', String(newCount));
    await setCustomerMetadata(customer.id, 'last_report_at', completedAt || new Date().toISOString()).catch(() => {});

    // Determine if this is an overage report.
    if (sub) {
      const { reportsIncluded, overageRate } = await planFromSubscription(sub);

      if (newCount > reportsIncluded && overageRate > 0) {
        // One-time invoice item for the overage, then invoice + auto-charge.
        await stripePost('/invoiceitems', {
          customer: customer.id,
          amount: Math.round(overageRate * 100),
          currency: 'usd',
          description: `Overage report #${newCount} — ${listingAddress || 'unlisted'}`,
        });

        const invoice = await stripePost('/invoices', {
          customer: customer.id,
          auto_advance: 'true',
        });
        await stripePost(`/invoices/${invoice.id}/finalize`, {}).catch(() => {});

        return res.json({
          ok: true,
          reportsUsed: newCount,
          overage: true,
          overageCharge: overageRate,
          message: `Report recorded. Overage charge of $${overageRate.toFixed(2)} applied.`,
        });
      }
    }

    return res.json({ ok: true, reportsUsed: newCount, overage: false, message: `Report ${newCount} recorded.` });
  } catch (err) {
    console.error('Report-complete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
