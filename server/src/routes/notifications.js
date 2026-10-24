import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';
import { emailIsConfigured } from '../auth/email.js';

const router = Router();
const uuid = z.string().uuid();

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function dbRequired(_req, res, next) {
  if (!pool) return fail(res, 503, 'Database is unavailable.');
  next();
}

// List user notifications with filtering and unread count
router.get('/notifications', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const unreadOnly = req.query.unreadOnly === 'true';

    const conditions = ['user_id = $1'];
    const params = [req.user.id];

    if (unreadOnly) {
      conditions.push('read_at is null');
    }

    const [listRes, countRes] = await Promise.all([
      pool.query(
        `select id, conference_id, title, body, channel, read_at, created_at
         from public.notifications
         where ${conditions.join(' and ')}
         order by created_at desc
         limit 100`,
        params
      ),
      pool.query(
        `select count(*)::int as unread_count
         from public.notifications
         where user_id = $1 and read_at is null`,
        [req.user.id]
      ),
    ]);

    res.json({
      data: listRes.rows,
      unreadCount: countRes.rows[0]?.unread_count || 0,
    });
  } catch (e) {
    next(e);
  }
});

// Mark single notification read
router.patch('/notifications/:notificationId/read', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.notificationId).success) return fail(res, 400, 'Notification ID is invalid.');
  try {
    const { rows } = await pool.query(
      `update public.notifications
       set read_at = coalesce(read_at, now())
       where id = $1 and user_id = $2
       returning id, read_at`,
      [req.params.notificationId, req.user.id]
    );
    if (!rows[0]) return fail(res, 404, 'Notification not found.');
    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Mark all user notifications read
router.post('/notifications/mark-all-read', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `update public.notifications
       set read_at = now()
       where user_id = $1 and read_at is null
       returning id`,
      [req.user.id]
    );
    res.json({
      data: {
        message: 'All notifications marked as read.',
        updatedCount: rows.length,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Get user notification preferences
router.get('/notifications/preferences', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select user_id, email_notifications, submission_updates, review_updates,
              schedule_updates, payment_updates, certificate_updates, updated_at
       from public.notification_preferences
       where user_id = $1`,
      [req.user.id]
    );

    const defaultPrefs = {
      userId: req.user.id,
      emailNotifications: true,
      submissionUpdates: true,
      reviewUpdates: true,
      scheduleUpdates: true,
      paymentUpdates: true,
      certificateUpdates: true,
      emailConfigured: emailIsConfigured(),
    };

    if (!rows[0]) {
      return res.json({ data: defaultPrefs });
    }

    const p = rows[0];
    res.json({
      data: {
        userId: p.user_id,
        emailNotifications: p.email_notifications,
        submissionUpdates: p.submission_updates,
        reviewUpdates: p.review_updates,
        scheduleUpdates: p.schedule_updates,
        paymentUpdates: p.payment_updates,
        certificateUpdates: p.certificate_updates,
        emailConfigured: emailIsConfigured(),
        updatedAt: p.updated_at,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Update user notification preferences
router.patch('/notifications/preferences', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  const schema = z.object({
    emailNotifications: z.boolean().optional(),
    submissionUpdates: z.boolean().optional(),
    reviewUpdates: z.boolean().optional(),
    scheduleUpdates: z.boolean().optional(),
    paymentUpdates: z.boolean().optional(),
    certificateUpdates: z.boolean().optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid preference values.');

  try {
    const currentRes = await pool.query(
      `select * from public.notification_preferences where user_id = $1`,
      [req.user.id]
    );
    const curr = currentRes.rows[0] || {
      email_notifications: true,
      submission_updates: true,
      review_updates: true,
      schedule_updates: true,
      payment_updates: true,
      certificate_updates: true,
    };

    const newEmail = parsed.data.emailNotifications !== undefined ? parsed.data.emailNotifications : curr.email_notifications;
    const newSub = parsed.data.submissionUpdates !== undefined ? parsed.data.submissionUpdates : curr.submission_updates;
    const newRev = parsed.data.reviewUpdates !== undefined ? parsed.data.reviewUpdates : curr.review_updates;
    const newSched = parsed.data.scheduleUpdates !== undefined ? parsed.data.scheduleUpdates : curr.schedule_updates;
    const newPay = parsed.data.paymentUpdates !== undefined ? parsed.data.paymentUpdates : curr.payment_updates;
    const newCert = parsed.data.certificateUpdates !== undefined ? parsed.data.certificateUpdates : curr.certificate_updates;

    const { rows } = await pool.query(
      `insert into public.notification_preferences(
         user_id, email_notifications, submission_updates, review_updates,
         schedule_updates, payment_updates, certificate_updates, updated_at
       ) values($1, $2, $3, $4, $5, $6, $7, now())
       on conflict(user_id) do update
       set email_notifications = excluded.email_notifications,
           submission_updates = excluded.submission_updates,
           review_updates = excluded.review_updates,
           schedule_updates = excluded.schedule_updates,
           payment_updates = excluded.payment_updates,
           certificate_updates = excluded.certificate_updates,
           updated_at = now()
       returning *`,
      [req.user.id, newEmail, newSub, newRev, newSched, newPay, newCert]
    );

    const r = rows[0];
    res.json({
      data: {
        userId: r.user_id,
        emailNotifications: r.email_notifications,
        submissionUpdates: r.submission_updates,
        reviewUpdates: r.review_updates,
        scheduleUpdates: r.schedule_updates,
        paymentUpdates: r.payment_updates,
        certificateUpdates: r.certificate_updates,
        emailConfigured: emailIsConfigured(),
        updatedAt: r.updated_at,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
