// Email delivery: SMTP when SMTP_HOST is configured, log-only otherwise.
// Every in-app notification created through notify() also attempts an email,
// so approve/reject/query/reminder events reach the user's inbox automatically.
import nodemailer from 'nodemailer';
import { pool } from '../db';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'Oriental Energy TMS <no-reply@oriental-er.com>';

let transporter: import('nodemailer').Transporter | null = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  console.log(`[EMAIL] SMTP configured via ${SMTP_HOST}:${SMTP_PORT}`);
} else {
  console.log('[EMAIL] No SMTP_HOST set — emails will be logged, not sent.');
}

export async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!transporter) {
    console.log(`[EMAIL:log] To: ${to} | Subject: ${subject}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text: body,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1a2b3c;line-height:1.6">${body.replace(/\n/g, '<br/>')}</div>`,
    });
    return true;
  } catch (err: any) {
    console.error(`[EMAIL:error] to=${to}: ${err.message}`);
    return false;
  }
}

// Create an in-app notification AND fire the matching email in one call.
// Used by approve/reject/query/broadcast/reminder paths.
export async function notify(userId: string, type: string, title: string, message: string, link?: string) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, link) VALUES ($1,$2,$3,$4,$5)`,
    [userId, type, title, message, link || null]
  );
  try {
    const u = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [userId]);
    if (u.rows.length) await sendEmail(u.rows[0].email, title, `Hello ${u.rows[0].name},\n\n${message}\n\n— Oriental Energy TMS`);
  } catch (err: any) {
    console.error('[EMAIL] notify email failed:', err.message);
  }
}
