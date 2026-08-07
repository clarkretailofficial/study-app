// email.js
// Minimal wrapper around Resend's HTTP API for transactional email (right now,
// just password resets). Uses Node's built-in fetch, so no npm dependency is
// needed - stays consistent with the rest of this project's zero-dependency
// approach.
//
// If RESEND_API_KEY isn't set as an environment variable (e.g. running
// locally on your own computer), sending is simply skipped and the caller
// falls back to logging the reset link server-side instead - so the app
// keeps working exactly as before until email is actually configured.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Override with your own verified sender once you have one (e.g.
// "StudyNotes <noreply@yourdomain.com>"). Defaults to Resend's shared
// onboarding sender, which is fine to start with but may have its own
// sending restrictions until a domain is verified - check your Resend
// dashboard if emails aren't arriving.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'StudyNotes <onboarding@resend.dev>';

function emailSendingConfigured() {
  return Boolean(RESEND_API_KEY);
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!RESEND_API_KEY) return { skipped: true };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [toEmail],
      subject: 'Reset your StudyNotes password',
      html: `
        <p>Someone (hopefully you!) requested a password reset for your StudyNotes account.</p>
        <p><a href="${resetUrl}">Click here to set a new password</a></p>
        <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email - your password won't be changed.</p>
      `,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = { sendPasswordResetEmail, emailSendingConfigured };
