import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  switch (event.type) {
    case 'invoice.paid': {
      // Reset usage counter at the start of each billing period
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_cycle') {
        const customerId = invoice.customer;
        const customer = await stripe.customers.retrieve(customerId);

        await stripe.customers.update(customerId, {
          metadata: {
            ...customer.metadata,
            reports_used_current_period: '0',
            period_reset_at: new Date().toISOString(),
          },
        });
        console.log(`Reset usage counter for customer ${customerId}`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      // Subscription cancelled
      const sub = event.data.object;
      console.log(`Subscription ${sub.id} cancelled for customer ${sub.customer}`);
      break;
    }

    case 'customer.subscription.updated': {
      // Plan change — update metadata
      const sub = event.data.object;
      console.log(`Subscription ${sub.id} updated for customer ${sub.customer}: status=${sub.status}`);
      break;
    }

    default:
      // Unhandled event type
      break;
  }

  return res.json({ received: true });
}
