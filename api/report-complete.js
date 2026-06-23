import { resolveAccount, planFromSubscription, setCustomerMetadata } from './_stripe.js';

// Record-only usage endpoint.
//
// SECURITY: this endpoint is public and authenticated only by a license key.
// It therefore NEVER moves money. It records usage and flags overages for
// server-side reconciliation — a client (or anyone holding a key) must not be
// able to trigger a card charge. Overage billing is handled out-of-band by the
// operator, not auto-charged here. See billing audit (2026-06-22).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { licenseKey, listingAddress, completedAt, reportId } = req.body || {};
  if (!licenseKey) return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    const { customer, sub } = await resolveAccount(licenseKey);
    if (!customer) return res.status(404).json({ error: 'Invalid license key' });

    // Idempotency: a client retry/double-submit with the same reportId must not
    // double-count. Dedupes the common consecutive-retry case without extra infra.
    if (reportId && customer.metadata?.last_report_id === reportId) {
      const used = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
      return res.json({ ok: true, reportsUsed: used, overage: false, deduped: true, message: 'Already recorded.' });
    }

    const currentUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
    const newCount = currentUsed + 1;

    await setCustomerMetadata(customer.id, 'reports_used_current_period', String(newCount));
    await setCustomerMetadata(customer.id, 'last_report_at', completedAt || new Date().toISOString()).catch(() => {});
    if (reportId) await setCustomerMetadata(customer.id, 'last_report_id', reportId).catch(() => {});

    // Over quota: RECORD the overage for the operator to reconcile/bill. Do NOT
    // create or finalize any invoice here — money never moves on a client call.
    let overage = false;
    if (sub) {
      const { reportsIncluded } = await planFromSubscription(sub);
      if (newCount > reportsIncluded) {
        overage = true;
        const pending = parseInt(customer.metadata?.overage_pending || '0', 10) + 1;
        await setCustomerMetadata(customer.id, 'overage_pending', String(pending)).catch(() => {});
      }
    }

    return res.json({
      ok: true,
      reportsUsed: newCount,
      overage,
      message: overage
        ? `Report ${newCount} recorded (over plan — overage pending reconciliation).`
        : `Report ${newCount} recorded.`,
    });
  } catch (err) {
    console.error('Report-complete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
