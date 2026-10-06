// mailer.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

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

  const mailOptions = {
    from: `"DEI Conference Management Toolkit" <${process.env.EMAIL_FROM || "gurumaujsatsangi@gmail.com"}>`,
    to,
    subject,
    text: `${htmlToText(bodyHtml)}\n\n${FOOTER_TEXT}`,
    html: renderLayout(bodyHtml),
  };

  if (cc) {
    mailOptions.cc = cc;
  }

  return transporter.sendMail(mailOptions);
}
