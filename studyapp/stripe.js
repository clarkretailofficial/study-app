// stripe.js
// Minimal wrapper around Stripe's HTTP API (Checkout, Billing Portal, and
// webhook signature verification) using Node's built-in fetch/crypto - no
// npm "stripe" package needed, keeping this project's zero-dependency
// approach consistent (see email.js for the same pattern with Resend).

const crypto = require('node:crypto');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function billingConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID);
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

// Creates a Stripe Checkout Session for the ScribeStack Premium subscription
// and returns the hosted checkout URL to redirect the browser to.
// `userId` is stamped onto the session (via client_reference_id) so the
// webhook handler can match the eventual payment back to the right account
// even before a Stripe customer record exists for them.
async function createCheckoutSession({ userId, email, successUrl, cancelUrl }) {
  if (!billingConfigured()) {
    throw new Error('Billing is not configured yet.');
  }
  const session = await stripeRequest('checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    managed_payments: { enabled: true },
    customer_email: email,
    client_reference_id: String(userId),
    metadata: { userId: String(userId) },
    subscription_data: { metadata: { userId: String(userId) } },
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
  createCheckoutSession,
  createBillingPortalSession,
  verifyWebhookSignature,
};
