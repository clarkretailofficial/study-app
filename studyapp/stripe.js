// stripe.js
// Minimal wrapper around Stripe's HTTP API (Checkout, Billing Portal, and
// webhook signature verification) using Node's built-in fetch/crypto - no
// npm "stripe" package needed, keeping this project's zero-dependency
// approach consistent (see email.js for the same pattern with Resend).

const crypto = require('node:crypto');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // Premium
const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID; // Pro (AI study sets)
// A one-time (not subscription) price for the "buy 10 more generations"
// top-up - see GENERATION_TOPUP_PRICE_USD/GENERATION_TOPUP_AMOUNT in plans.js
// and POST /api/billing/topup in server.js. Its own env var, same reasoning
// as STRIPE_PRO_PRICE_ID: the rest of billing keeps working even before this
// one's been created in Stripe.
const STRIPE_TOPUP_PRICE_ID = process.env.STRIPE_TOPUP_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function billingConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID);
}

// Separate from billingConfigured() so Premium checkout can keep working even
// before a Pro price has been created in Stripe - the Pro upgrade button just
// stays disabled with a clear message until STRIPE_PRO_PRICE_ID is set too.
function proBillingConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_PRO_PRICE_ID);
}

function topupConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_TOPUP_PRICE_ID);
}

function priceIdForTier(tier) {
  return tier === 'pro' ? STRIPE_PRO_PRICE_ID : STRIPE_PRICE_ID;
}

// Stripe's API takes classic application/x-www-form-urlencoded bodies, with
// nested params expressed as bracket notation, e.g. line_items[0][price].
// This flattens a plain JS object into that format.
function toFormBody(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(toFormBody(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(toFormBody(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

async function stripeRequest(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe API error ${res.status}`;
    throw new Error(message);
  }
  return data;
}

// A plain GET - needed to look up an existing subscription's item id before
// we can swap its price in place (see updateSubscriptionPrice() below).
async function stripeGetRequest(path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe API error ${res.status}`;
    throw new Error(message);
  }
  return data;
}

// Creates a Stripe Checkout Session for a ScribeStack subscription (Premium
// or Pro - `tier` picks the price) and returns the hosted checkout URL to
// redirect the browser to. `userId` is stamped onto the session (via
// client_reference_id) so the webhook handler can match the eventual payment
// back to the right account even before a Stripe customer record exists for
// them; `tier` is stamped alongside it (in metadata, on both the session and
// the resulting subscription) so the webhook knows which plan to grant -
// Stripe's own session/subscription objects don't otherwise say "this was
// the Pro price" anywhere convenient to read back later.
async function createCheckoutSession({ userId, email, tier = 'paid', successUrl, cancelUrl }) {
  if (!billingConfigured()) {
    throw new Error('Billing is not configured yet.');
  }
  const priceId = priceIdForTier(tier);
  if (!priceId) {
    throw new Error(tier === 'pro' ? 'Pro billing is not configured yet.' : 'Billing is not configured yet.');
  }
  const session = await stripeRequest('checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    managed_payments: { enabled: true },
    customer_email: email,
    client_reference_id: String(userId),
    metadata: { userId: String(userId), tier },
    subscription_data: { metadata: { userId: String(userId), tier } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session.url;
}

// Swaps the price on someone's EXISTING active subscription in place (e.g.
// Premium -> Pro) instead of starting a second, separately-billed
// subscription alongside their first one. Stripe prorates the difference by
// default. Returns the updated subscription.
async function updateSubscriptionPrice({ subscriptionId, tier, userId }) {
  if (!billingConfigured()) {
    throw new Error('Billing is not configured yet.');
  }
  const priceId = priceIdForTier(tier);
  if (!priceId) {
    throw new Error(tier === 'pro' ? 'Pro billing is not configured yet.' : 'Billing is not configured yet.');
  }
  const existing = await stripeGetRequest(`subscriptions/${subscriptionId}`);
  const itemId = existing.items && existing.items.data && existing.items.data[0] && existing.items.data[0].id;
  if (!itemId) {
    throw new Error('Could not find your existing subscription to upgrade it.');
  }
  return stripeRequest(`subscriptions/${subscriptionId}`, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: 'create_prorations',
    metadata: { userId: String(userId), tier },
  });
}

// Creates a Stripe Checkout Session for the one-time "10 more generations"
// top-up (Pro only) - mode 'payment', not 'subscription', since this is a
// single purchase rather than a recurring charge. metadata.type lets the
// webhook handler tell this apart from a subscription checkout completing
// (both fire the same checkout.session.completed event).
async function createTopupCheckoutSession({ userId, email, successUrl, cancelUrl }) {
  if (!topupConfigured()) {
    throw new Error('Buying extra generations is not set up yet.');
  }
  const session = await stripeRequest('checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: STRIPE_TOPUP_PRICE_ID, quantity: 1 }],
    managed_payments: { enabled: true },
    customer_email: email,
    client_reference_id: String(userId),
    metadata: { userId: String(userId), type: 'ai_topup' },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session.url;
}

// Creates a Stripe Billing Portal session so an already-Premium user can
// update their card or cancel, without ScribeStack having to build any of
// that UI itself.
async function createBillingPortalSession({ customerId, returnUrl }) {
  if (!billingConfigured()) {
    throw new Error('Billing is not configured yet.');
  }
  const session = await stripeRequest('billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// Verifies a webhook request actually came from Stripe (not a forged
// request hitting our public endpoint) by recomputing the HMAC signature
// Stripe sends in the Stripe-Signature header, over the *raw* request body.
// Mirrors what Stripe's own SDKs do under the hood, so we don't need to
// pull in the "stripe" npm package just for this one piece.
function verifyWebhookSignature(rawBody, signatureHeader, toleranceSeconds = 300) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('Webhook secret is not configured yet.');
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header.');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Malformed Stripe-Signature header.');

  const expected = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  const signatureValid =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  if (!signatureValid) throw new Error('Webhook signature verification failed.');

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) throw new Error('Webhook timestamp too old - possible replay.');

  return JSON.parse(rawBody);
}

module.exports = {
  billingConfigured,
  proBillingConfigured,
  topupConfigured,
  createCheckoutSession,
  updateSubscriptionPrice,
  createTopupCheckoutSession,
  createBillingPortalSession,
  verifyWebhookSignature,
};
