const nodemailer = require('nodemailer');

function getMode() {
  return process.env.SMTP_HOST ? 'smtp' : 'mock';
}

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendMail({ to, subject, text, html }) {
  if (getMode() === 'mock') {
    console.log('\n[mailer:mock] ─────────────────────────────');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${text}`);
    console.log('────────────────────────────────────────────\n');
    return { mode: 'mock' };
  }

  const transporter = createTransport();
  const info = await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
  return { mode: 'smtp', messageId: info.messageId };
}

module.exports = { sendMail };
