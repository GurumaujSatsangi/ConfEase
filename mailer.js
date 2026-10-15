// mailer.js
import { Resend } from "resend";
import dotenv from "dotenv";
import { retryWithBackoff } from "./retry.js";

dotenv.config();

// Resend's own client throws immediately if constructed with no API key
// (confirmed directly against the installed package, not assumed) - so it
// must be built lazily, on first real send, not at module load time. Every
// test file imports api/index.js (which imports this module) under
// SKIP_AUTOLISTEN, and none of them set RESEND_API_KEY; constructing this
// eagerly at the top of the file would crash every single test file on
// import, not just the ones that happen to send an email.
let resendClient = null;
function getResendClient() {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

// Resend's own type definitions (node_modules/resend/dist/index.d.mts,
// checked directly rather than assumed) list `rate_limit_exceeded` as one
// of a fixed set of error codes the API returns - confirmed real, not
// guessed. Resend also doesn't throw on an API-level failure the way
// nodemailer did; emails.send() returns { data, error, headers } instead,
// so a rate-limit or server error has to be turned into a thrown Error
// here to keep working with the existing retry/failure-handling pattern
// (and so callers that already do `await sendMail(...).catch(...)` or wrap
// it in their own try/catch keep behaving exactly as before). A genuine
// network-level failure (DNS, connection refused) still throws from the
// SDK call itself, which the same retry path below also catches.
function isRetryableResendError(err) {
  if (err?.name === "rate_limit_exceeded") return true;
  if (typeof err?.statusCode === "number") return err.statusCode >= 500;
  const retryableCodes = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
  return retryableCodes.has(err?.code);
}

// A 429's Retry-After header is either a whole number of seconds, or an
// HTTP-date - RFC 9110 allows both. Returns null when absent/unparsable,
// so the caller falls back to its own exponential schedule.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
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

  // EMAIL_FROM must be an address on a domain verified in Resend
  // (resend.com/domains) - unlike the old Gmail/SMTP setup, Resend will
  // reject a send from an address it hasn't verified ownership of, so
  // there's no sensible hardcoded fallback here the way there was for
  // Gmail. onboarding@resend.dev is Resend's own sandbox sender, usable
  // with no domain setup but typically restricted to the account owner's
  // own verified address as a recipient - fine as a fallback for noticing
  // misconfiguration, not a real production default.
  const payload = {
    from: process.env.EMAIL_FROM || "DEI Conference Management Toolkit <onboarding@resend.dev>",
    to,
    subject,
    text: `${htmlToText(bodyHtml)}\n\n${FOOTER_TEXT}`,
    html: renderLayout(bodyHtml),
  };

  if (cc) {
    payload.cc = cc;
  }

  // Dozens of routes call sendMail() without mocking it, and the test suite
  // exercises most of those routes directly against a real running server.
  // Without this, every full test run would send real email through
  // whatever Resend account is configured - see the mailer_test file's own
  // history for what happened when this wasn't guarded against for the
  // previous (SMTP) transport.
  if (process.env.SKIP_AUTOLISTEN === "1") {
    return { messageId: "skipped-in-test@localhost", accepted: [to], rejected: [] };
  }

  const result = await retryWithBackoff(
    async () => {
      const { data, error, headers } = await getResendClient().emails.send(payload);
      if (error) {
        const err = new Error(`Resend send to ${to} failed (${error.name}): ${error.message}`);
        err.name = error.name;
        err.statusCode = error.statusCode;
        err.retryAfterMs = error.name === "rate_limit_exceeded" ? parseRetryAfterMs(headers?.["retry-after"]) : null;
        throw err;
      }
      return data;
    },
    {
      retries: 4,
      baseDelayMs: 500,
      isRetryable: isRetryableResendError,
      getDelayMs: (err, attempt, baseDelayMs) => err.retryAfterMs ?? Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000),
      onRetry: (err, attempt) => console.warn(`sendMail retry ${attempt}/4 to ${to} after ${err.name || err.code}`),
    }
  );

  return { messageId: result.id, accepted: [to], rejected: [] };
}

export { isRetryableResendError };
