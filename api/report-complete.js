import { createHash } from 'node:crypto';
import { resolveAccount, planFromSubscription, setCustomerMetadata, createOverageInvoiceItem, ensureCurrentPeriod } from './_stripe.js';
import { rateLimited } from './_ratelimit.js';

// Usage-recording endpoint with deferred overage billing.
//
// SECURITY: this endpoint is public and authenticated only by a license key.
// It therefore NEVER moves money at request time. Usage is recorded, and each
// over-quota report creates a PENDING Stripe invoice item that is collected on
// the customer's next monthly invoice — itemized per report. A leaked key can
// add visible, refundable line items but can never trigger an immediate card
// charge. See billing audit (2026-06-22) + per-run billing decision (2026-07-16).
//
// Exemptions (e.g. the Davis Team's own-billing arrangement): a license key
// listed in the OVERAGE_EXEMPT_KEYS env var (comma-separated), or a customer
// with metadata overage_billing='manual', gets usage tracking + the
// overage_pending counter only — no invoice items.

function isOverageExempt(licenseKey, customer) {
  const envList = (process.env.OVERAGE_EXEMPT_KEYS || '')
    .split(',').map((k) => k.trim()).filter(Boolean);
  if (envList.includes(licenseKey)) return true;
  return customer.metadata?.overage_billing === 'manual';
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Tight per-key limit: a legit client posts ~one per finished report, so a
  // flood is someone trying to inflate a customer's usage/overage bill.
  if (rateLimited(req, res, { tag: 'report-complete', ipLimit: 60, keyLimit: 20 })) return;

  const { licenseKey, listingAddress, completedAt, reportId } = req.body || {};
  if (!licenseKey || typeof licenseKey !== 'string') return res.status(400).json({ error: 'Missing licenseKey' });

  try {
    let { customer, sub } = await resolveAccount(licenseKey);
    if (!customer) return res.status(404).json({ error: 'Invalid license key' });

    // Self-healing period reset before counting (independent of the webhook).
    if (sub) customer = await ensureCurrentPeriod(customer, sub);

    // Idempotency: the client's durable queue replays events verbatim, so any
    // retry carries the same frozen reportId+completedAt. Hashing BOTH into the
    // dedupe token keeps retries stable while two machines sharing one license
    // key (colliding per-machine SQLite rowids) never collide. A bounded recent
    // set — not a single slot — so replaying a multi-event queue can't
    // re-count earlier events.
    const dedupeToken = reportId != null
      ? createHash('sha256').update(`${reportId}|${completedAt || ''}`).digest('hex').slice(0, 10)
      : null;
    const recorded = (customer.metadata?.recorded_report_ids || '').split(',').filter(Boolean);
    if (dedupeToken && recorded.includes(dedupeToken)) {
      const used = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
      return res.json({ ok: true, reportsUsed: used, overage: false, deduped: true, message: 'Already recorded.' });
    }

    const currentUsed = parseInt(customer.metadata?.reports_used_current_period || '0', 10);
    const newCount = currentUsed + 1;

    // Counter + dedupe set + timestamp in ONE atomic write: a crash between a
    // counter commit and a marker commit is exactly the double-count window.
    // Deliberately uncaught — a swallowed failure would return 200 and lose the
    // count forever, since the client only retries on error. Trim the set
    // oldest-first to stay under Stripe's 500-char metadata value limit.
    if (dedupeToken) recorded.push(dedupeToken);
    while (recorded.join(',').length > 480) recorded.shift();
    await setCustomerMetadata(customer.id, {
      reports_used_current_period: String(newCount),
      recorded_report_ids: recorded.join(','),
      last_report_at: completedAt || new Date().toISOString(),
    });

    // Over quota: record the overage, and (unless exempt) create a pending
    // invoice item so Stripe collects it on the next monthly invoice. Never
    // finalize an invoice or charge here — money never moves on a client call.
    let overage = false;
    let billed = false;
    if (sub) {
      const { reportsIncluded, overageRate } = await planFromSubscription(sub);
      if (newCount > reportsIncluded) {
        overage = true;
        const pending = parseInt(customer.metadata?.overage_pending || '0', 10) + 1;
        await setCustomerMetadata(customer.id, { overage_pending: String(pending) }).catch(() => {});

        if (!isOverageExempt(licenseKey, customer)) {
          const amountCents = Math.round(overageRate * 100);
          const when = (completedAt || new Date().toISOString()).slice(0, 10);
          const description = `MarketPulse overage report — ${listingAddress || 'listing'} — ${when}`;
          // Billing failure must not un-record the report; the overage_pending
          // counter remains the reconciliation trail for any missed item.
          try {
            // Idempotency key uses the same reportId+completedAt token as the
            // dedupe set: globally unique across installs and machines (raw
            // reportId is a per-machine SQLite rowid — collisions would
            // silently skip billing a legitimate report), while retries of the
            // same event still dedupe at Stripe.
            await createOverageInvoiceItem(
              customer.id,
              amountCents,
              description,
              dedupeToken ? `mp-overage-${customer.id}-${dedupeToken}` : undefined
            );
            billed = true;
          } catch (err) {
            console.error('Overage invoice item failed (left in overage_pending for reconciliation):', err.message);
          }
        }
      }
    }

    return res.json({
      ok: true,
      reportsUsed: newCount,
      overage,
      billed,
      message: overage
        ? (billed
          ? `Report ${newCount} recorded — overage added to your next invoice.`
          : `Report ${newCount} recorded (over plan — overage pending reconciliation).`)
        : `Report ${newCount} recorded.`,
    });
  } catch (err) {
    console.error('Report-complete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
