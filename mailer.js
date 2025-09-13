
// mailer.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "gurumaujsatsangi@gmail.com",
    pass: "gqqy syyr wnmk xxfh",
  },
});

export async function sendMail(to, subject, text, html) {
  return transporter.sendMail({
    from: `"My App" <gurumaujsatsangi@gmail.com>`,
    to,
    subject,
    text,
    html,
  });
}
