// mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { retryWithBackoff } from "./retry.js";

dotenv.config();

// REL-04 (security-audit/PRODUCTION_RELIABILITY.md, "R4"): previously a
// brand-new SMTP connection was opened for every single email, with no
// cap on how many could be opened at once and no self-imposed send rate -
// a burst of emails (e.g. a chair's bulk "Enable PDF Download" emailing
// every author at once) could open many simultaneous connections to
// Gmail, and Gmail can throttle or temporarily flag an account for that
// pattern independently of its daily sending cap. `pool: true` reuses a
// small set of connections instead of one per message; `rateLimit` caps
// how fast this app will ever send, client-side, so it can't flood Gmail
// in the first place.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  rateDelta: 1000,
  rateLimit: 5, // at most 5 messages per rateDelta (1s) window
});

// Transient SMTP/network failures (a dropped connection, a temporary "try
// again" response) are safe to retry - the message was never accepted by
// the server. A permanent rejection (bad recipient, auth failure, content
// rejected) is not: retrying it wastes time and repeats the same failure.
// nodemailer surfaces the SMTP reply code as responseCode when the server
// sent one; a 4xx is temporary, a 5xx is permanent (RFC 5321).
function isRetryableSmtpError(err) {
  const retryableCodes = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET", "EDNS", "EAI_AGAIN", "ECONNECTION"]);
  if (retryableCodes.has(err?.code)) return true;
  if (typeof err?.responseCode === "number") return err.responseCode >= 400 && err.responseCode < 500;
  return false;
}

// Test-only record of every sendMail() call made while SKIP_AUTOLISTEN=1
// (when the real SMTP send is skipped - see sendMail below). Lets a test
// assert who an email would have gone to without actually sending one.
export const testSentEmails = [];
export function resetTestSentEmails() {
  testSentEmails.length = 0;
}

// Test-only: recipients sendMail() should reject for instead of
// succeeding, while SKIP_AUTOLISTEN=1. Lets a test simulate a real
// delivery failure (e.g. for a bulk-send "keep going" regression test)
// without needing a real SMTP server to actually refuse a message.
export const testForcedFailures = new Set();
export function resetTestForcedFailures() {
  testForcedFailures.clear();
}

// Standard footer shared by every email
const FOOTER_HTML =
  'Incase of any technical queries / assistance, please feel free to reach out to us at <a href="mailto:cmt@dei.ac.in">cmt@dei.ac.in</a> or contact us at +91 9875691340.<br><br>' +
  "Thanks &amp; Regards,<br>" +
  "Team DEI Conference Management Toolkit,<br>" +
  "Multimedia Laboratory / Centre,<br>" +
  "Dayalbagh Educational Institute, Agra - 282005,<br>" +
  "Uttar Pradesh, India";

const FOOTER_TEXT =
  "Incase of any technical queries / assistance, please feel free to reach out to us at cmt@dei.ac.in or contact us at +91 9875691340.\n\n" +
  "Thanks & Regards,\nTeam DEI Conference Management Toolkit,\nMultimedia Laboratory / Centre,\nDayalbagh Educational Institute, Agra - 282005,\nUttar Pradesh, India";

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Removes a body's own trailing sign-off, because the shared footer replaces it
function stripLegacyFooter(html) {
  return String(html).replace(/(\s|&nbsp;|<br\s*\/?>)*(<p[^>]*>)?\s*(Incase|In case) of [\s\S]*$/i, "");
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// Table-based layout (works across mail clients)
function renderLayout(bodyHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;max-width:600px;width:100%;border-radius:8px;overflow:hidden;">
      <tr><td style="background-color:#0b4a9b;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold;">DEI Conference Management Toolkit</td></tr>
      <tr><td style="padding:24px;color:#222222;font-size:14px;line-height:1.6;">${bodyHtml}</td></tr>
      <tr><td style="padding:16px 24px;background-color:#f9fafb;color:#555555;font-size:12px;line-height:1.6;border-top:1px solid #e5e7eb;">${FOOTER_HTML}</td></tr>
    </table>
  </td></tr>
</table>`;
}

// Every email is sent as HTML. Plain-text bodies are converted to paragraphs.
export async function sendMail(to, subject, text, html, cc = null) {
  const bodyHtml = html
    ? stripLegacyFooter(html)
    : `<p>${escapeHtml(text || "")}</p>`;

  // Sent through Gmail's own SMTP (service: "gmail" above), authenticated
  // as EMAIL_USER - Gmail requires the From address to be that same
  // account (or one of its verified Send As aliases), so this uses
  // EMAIL_USER itself rather than EMAIL_FROM, which is now a
  // Resend-verified domain address Gmail has no reason to accept as a
  // sender identity.
  const mailOptions = {
    from: `"DEI Conference Management Toolkit" <${process.env.EMAIL_USER || "gurumaujsatsangi@gmail.com"}>`,
    to,
    subject,
    text: `${htmlToText(bodyHtml)}\n\n${FOOTER_TEXT}`,
    html: renderLayout(bodyHtml),
  };

  if (cc) {
    mailOptions.cc = cc;
  }

  // Dozens of routes call sendMail() without mocking it, and the test suite
  // exercises most of those routes directly against a real running server.
  // Without this, every full test run sends real email through the live
  // Gmail account configured in EMAIL_USER/EMAIL_PASSWORD, which has a daily
  // sending quota Gmail enforces account-wide - repeated runs during
  // development exhausted it and caused unrelated-looking test failures
  // (SMTP 550 5.4.5) across any test that happens to hit a mail-sending route.
  if (process.env.SKIP_AUTOLISTEN === "1") {
    if (testForcedFailures.has(to)) {
      throw new Error(`Simulated send failure to ${to} (testForcedFailures)`);
    }
    // Recorded (not sent) so tests can assert who *would* have been
    // emailed - see testSentEmails/resetTestSentEmails above.
    testSentEmails.push({ to, subject });
    return { messageId: "skipped-in-test@localhost", accepted: [to], rejected: [] };
  }

  return retryWithBackoff(() => transporter.sendMail(mailOptions), {
    retries: 2,
    baseDelayMs: 500,
    isRetryable: isRetryableSmtpError,
    onRetry: (err, attempt) => console.warn(`sendMail retry ${attempt}/2 to ${to} after transient error: ${err.message}`),
  });
}

export { isRetryableSmtpError };
