import crypto from 'node:crypto';
import { setCustomerMetadata } from './_stripe.js';

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verify Stripe's signature header without the stripe library.
// Header format: t=<timestamp>,v1=<signature>
function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time compare.
  const a = Buffer.from(computed);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!verifySignature(raw, sig, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      // Reset usage at the start of each billing cycle.
      if (invoice.billing_reason === 'subscription_cycle' && invoice.customer) {
        await setCustomerMetadata(invoice.customer, 'reports_used_current_period', '0');
        await setCustomerMetadata(invoice.customer, 'period_reset_at', new Date().toISOString()).catch(() => {});
      }
    }
    // Other event types (subscription.deleted/updated) are acknowledged without action for now.
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Still 200 so Stripe doesn't retry forever on a transient metadata write.
  }

  return res.json({ received: true });
}
