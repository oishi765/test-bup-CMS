import { pool } from '../db/pool.js';
import { emailIsConfigured, sendWorkflowEmail } from '../auth/email.js';

/**
 * Dispatch an in-app and optional email notification adhering to user preferences
 */
export async function createNotification(db, {
  userId,
  conferenceId = null,
  title,
  body,
  category = 'general',
  metadata = {},
}) {
  const client = db || pool;

  // 1. Fetch user email and preferences
  const userQuery = await client.query('select id, email, full_name from public.users where id = $1', [userId]);
  const user = userQuery.rows[0];
  if (!user) return null;

  let prefs = {
    email_notifications: true,
    submission_updates: true,
    review_updates: true,
    schedule_updates: true,
    payment_updates: true,
    certificate_updates: true,
  };

  try {
    const prefQuery = await client.query('select * from public.notification_preferences where user_id = $1', [userId]);
    if (prefQuery.rows[0]) prefs = prefQuery.rows[0];
  } catch (_e) {
    // Default preferences if table not yet created
  }

  // Determine if email is permitted based on category preferences
  let allowEmail = prefs.email_notifications !== false;
  if (category === 'submission' && !prefs.submission_updates) allowEmail = false;
  if (category === 'review' && !prefs.review_updates) allowEmail = false;
  if (category === 'schedule' && !prefs.schedule_updates) allowEmail = false;
  if (category === 'payment' && !prefs.payment_updates) allowEmail = false;
  if (category === 'certificate' && !prefs.certificate_updates) allowEmail = false;

  let emailStatus = 'not_configured';
  if (allowEmail && emailIsConfigured()) {
    try {
      const delivered = await sendWorkflowEmail({
        email: user.email,
        subject: `[BUP Conference] ${title}`,
        text: `Hello ${user.full_name},\n\n${body}\n\nBangladesh University of Professionals`,
      });
      emailStatus = delivered ? 'sent' : 'failed';
    } catch (err) {
      console.error('Email dispatch error:', err.message);
      emailStatus = 'failed';
    }
  } else if (!allowEmail) {
    emailStatus = 'skipped_by_preference';
  }

  // 2. Insert into public.notifications
  try {
    const { rows } = await client.query(
      `insert into public.notifications(
         user_id, conference_id, title, body, channel, category, email_delivery_status, metadata
       ) values($1, $2, $3, $4, 'in_app', $5, $6, $7::jsonb)
       returning *`,
      [
        userId,
        conferenceId,
        title,
        body,
        category,
        emailStatus,
        JSON.stringify(metadata),
      ]
    );
    return rows[0];
  } catch (_err) {
    // Fallback if legacy table schema without new columns
    const { rows } = await client.query(
      `insert into public.notifications(
         user_id, conference_id, title, body, channel
       ) values($1, $2, $3, $4, 'in_app')
       returning *`,
      [userId, conferenceId, title, body]
    );
    return rows[0];
  }
}
