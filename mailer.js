
// mailer.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "gurumaujsatsangi@gmail.com",
    pass: "gqqy syyr wnmk xxfh",
  },
});

export async function sendMail(to, subject, text, html, cc = null) {
  const mailOptions = {
    from: `"DEI Conference Management Toolkit" <gurumaujsatsangi@gmail.com>`,
    to,
    subject,
    text,
    html,
  };
  
  if (cc) {
    mailOptions.cc = cc;
  }
  
  return transporter.sendMail(mailOptions);
}
