import type { AdvisorRenderedRecipe } from './advisor-recipe-types';

/** Fixed contract-backed source. No generated security expressions or column bindings. */
export function checkoutFulfillmentRecipe(table: string): AdvisorRenderedRecipe {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) throw new Error('recipe_table');
  return {
    explanation: 'Proposed new server-only payment table and fulfillment handler. For an existing app, merge this new table into the complete current schema rather than replacing that file; choose an unused table name and never convert an existing scope. Create Checkout server-side and store its exact session ID, amount in integer cents, currency, livemode and account identity before accepting events. Never copy those expectations from browser input or the webhook. For an account-scoped destination store stripe_account_id=null; for Connect events store the expected account ID. The handler compares against that stored authority; it does not assume test or live mode. Configure a separate Stripe destination and its endpoint-specific secret; ad-hoc Checkout does not emit project payment events. The single row transition is atomic; external fulfillment and a separate audit write are not made atomic by this recipe.',
    files: [{ path: 'db/schema.ts', source: `import { schema, table, id, text, integer, boolean, timestamp, serverOnly } from 'somewhere/db';

export default schema({
  ${table}: table({
    id: id({ uuid: true }),
    checkout_session_id: text({ unique: true }),
    amount_cents: integer(),
    currency: text(),
    livemode: boolean(),
    stripe_account_id: text({ nullable: true }),
    status: text({ default: 'pending' }),
    paid_event_id: text({ nullable: true }),
    paid_at: timestamp({ nullable: true }),
  }, { scope: serverOnly() }),
});
` }, { path: 'api/payments/stripe.ts', source: `import Stripe from 'stripe';

export default async function (req, sw) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();
  const stripe = new Stripe(sw.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw, req.headers.get('stripe-signature') ?? '', sw.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return new Response('bad signature', { status: 400 });
  }
  if (event.type !== 'checkout.session.completed') return new Response('ok');
  const session = event.data.object;
  if (session.mode !== 'payment' || session.payment_status !== 'paid' ||
      typeof session.id !== 'string' || !Number.isSafeInteger(session.amount_total) ||
      typeof session.currency !== 'string' || typeof session.livemode !== 'boolean' ||
      event.livemode !== session.livemode) return new Response('payment mismatch', { status: 409 });
  const found = await sw.db.from('${table}', { where: { checkout_session_id: session.id }, limit: 1 });
  const order = found.data[0];
  if (typeof event.id !== 'string' || (event.account !== undefined && typeof event.account !== 'string')) {
    return new Response('payment mismatch', { status: 409 });
  }
  const account = event.account ?? null;
  if (!order || order.checkout_session_id !== session.id ||
      order.amount_cents !== session.amount_total || order.currency !== session.currency ||
      ![true, false, 0, 1].includes(order.livemode) || Boolean(order.livemode) !== session.livemode || order.stripe_account_id !== account) {
    return new Response('payment mismatch', { status: 409 });
  }
  const where = {
    id: order.id, checkout_session_id: session.id, status: 'pending',
    amount_cents: order.amount_cents, currency: order.currency,
    livemode: order.livemode, stripe_account_id: account,
  };
  const updated = await sw.db.update('${table}', {
    set: { status: 'paid', paid_event_id: event.id, paid_at: new Date().toISOString() }, where,
  });
  if (updated.data.length === 1 && updated.data[0].id === order.id) return Response.json({ ok: true, transitioned: true });
  const current = (await sw.db.from('${table}', { where: { id: order.id }, limit: 1 })).data[0];
  if (current?.status === 'paid' && current.paid_event_id === event.id &&
      current.checkout_session_id === session.id && current.amount_cents === order.amount_cents &&
      current.currency === order.currency && current.livemode === order.livemode &&
      current.stripe_account_id === account) return Response.json({ ok: true, transitioned: false });
  return new Response('payment state unresolved', { status: 409 });
}
` }],
  };
}
