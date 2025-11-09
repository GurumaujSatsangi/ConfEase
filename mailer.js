
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
