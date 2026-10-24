import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';
import { hashToken, createOpaqueToken } from '../auth/crypto.js';
import { sendWorkflowEmail } from '../auth/email.js';

const router = Router();
const uuid = z.string().uuid();
const sessionFormats = ['in_person', 'virtual', 'hybrid'];
const sessionTypes = ['keynote', 'paper_session', 'poster_session', 'workshop', 'panel', 'break'];
const presentationStatuses = ['scheduled', 'in_progress', 'completed', 'absent', 'cancelled', 'rescheduled'];

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function dbRequired(_req, res, next) {
  if (!pool) return fail(res, 503, 'Database is unavailable until DATABASE_URL is configured.');
  next();
}

function isSuper(user) {
  return user.roles.includes('super_admin');
}

async function isManager(req, conferenceId) {
  return isSuper(req.user) || canManageConference(req.user, conferenceId);
}

async function notify(db, userId, conferenceId, title, body) {
  await db.query(
    `insert into public.notifications(user_id, conference_id, title, body, channel)
     values($1, $2, $3, $4, 'in_app')`,
    [userId, conferenceId, title, body]
  );
}

async function emailIfConfigured(email, subject, text) {
  try {
    await sendWorkflowEmail({ email, subject, text });
  } catch (error) {
    console.error('Workflow email delivery failed:', error.message);
  }
}

async function audit(db, userId, action, entityType, entityId, details = {}) {
  await db.query(
    `insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, details)
     values($1, $2, $3, $4, $5::jsonb)`,
    [userId, action, entityType, entityId, JSON.stringify(details)]
  );
}

// Conflict Detection Helper
async function detectSessionConflicts(db, { conferenceId, sessionId, room, startsAt, endsAt, sessionChairId }) {
  const conflicts = [];

  // 1. Room overlap conflict
  if (room) {
    const roomQuery = sessionId
      ? await db.query(
          `select id, title, room, starts_at, ends_at from public.sessions
           where conference_id = $1 and lower(room) = lower($2) and id != $3
           and (starts_at < $5 and ends_at > $4)
           limit 1`,
          [conferenceId, room, sessionId, startsAt, endsAt]
        )
      : await db.query(
          `select id, title, room, starts_at, ends_at from public.sessions
           where conference_id = $1 and lower(room) = lower($2)
           and (starts_at < $4 and ends_at > $3)
           limit 1`,
          [conferenceId, room, startsAt, endsAt]
        );

    if (roomQuery.rows[0]) {
      const c = roomQuery.rows[0];
      conflicts.push(`Room "${c.room}" is already booked for session "${c.title}" from ${new Date(c.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${new Date(c.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
    }
  }

  // 2. Session chair overlap conflict
  if (sessionChairId) {
    const chairQuery = sessionId
      ? await db.query(
          `select id, title, starts_at, ends_at from public.sessions
           where session_chair_id = $1 and id != $2
           and (starts_at < $4 and ends_at > $3)
           limit 1`,
          [sessionChairId, sessionId, startsAt, endsAt]
        )
      : await db.query(
          `select id, title, starts_at, ends_at from public.sessions
           where session_chair_id = $1
           and (starts_at < $3 and ends_at > $2)
           limit 1`,
          [sessionChairId, startsAt, endsAt]
        );

    if (chairQuery.rows[0]) {
      const c = chairQuery.rows[0];
      const chairUser = await db.query(`select full_name from public.users where id = $1`, [sessionChairId]);
      const chairName = chairUser.rows[0]?.full_name || 'Assigned chair';
      conflicts.push(`Session Chair ${chairName} is already chairing session "${c.title}" at that time.`);
    }
  }

  return conflicts;
}

// -------------------------------------------------------------
// Public & Authenticated Schedule Endpoints
// -------------------------------------------------------------

// Public schedule view with day-wise, room-wise, track-wise filters
router.get('/conferences/:conferenceId/schedule', dbRequired, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    const date = (req.query.date || '').trim(); // YYYY-MM-DD
    const room = (req.query.room || '').trim();
    const trackId = (req.query.trackId || '').trim();
    const format = (req.query.format || '').trim();
    const sessionId = (req.query.sessionId || '').trim();

    const isAuthorizedManager = req.user ? await isManager(req, req.params.conferenceId) : false;

    const conditions = ['s.conference_id = $1'];
    const params = [req.params.conferenceId];

    if (!isAuthorizedManager) {
      conditions.push('s.is_published = true');
    }
    if (date) {
      params.push(`${date}T00:00:00.000Z`);
      const startIdx = params.length;
      params.push(`${date}T23:59:59.999Z`);
      const endIdx = params.length;
      conditions.push(`s.starts_at >= $${startIdx} and s.starts_at <= $${endIdx}`);
    }
    if (room) {
      params.push(room);
      conditions.push(`s.room ilike $${params.length}`);
    }
    if (trackId && uuid.safeParse(trackId).success) {
      params.push(trackId);
      conditions.push(`s.track_id = $${params.length}`);
    }
    if (format) {
      params.push(format);
      conditions.push(`s.format = $${params.length}`);
    }
    if (sessionId && uuid.safeParse(sessionId).success) {
      params.push(sessionId);
      conditions.push(`s.id = $${params.length}`);
    }

    const whereClause = conditions.join(' and ');

    const [sessionsResult, daysResult, roomsResult, tracksResult] = await Promise.all([
      pool.query(
        `select s.id, s.conference_id, s.session_code, s.title, s.description, s.venue, s.room,
                s.format, s.session_type, s.starts_at, s.ends_at, s.is_published, s.created_at,
                c.title as conference_title, c.timezone,
                t.id as track_id, t.name as track_name,
                u.id as chair_id, u.full_name as chair_name, u.institution as chair_institution
         from public.sessions s
         join public.conferences c on c.id = s.conference_id
         left join public.tracks t on t.id = s.track_id
         left join public.users u on u.id = s.session_chair_id
         where ${whereClause}
         order by s.starts_at asc, s.room asc`,
        params
      ),
      pool.query(
        `select starts_at
         from public.sessions
         where conference_id = $1 and (is_published = true or $2 = true)
         order by starts_at asc`,
        [req.params.conferenceId, isAuthorizedManager]
      ),
      pool.query(
        `select distinct room from public.sessions
         where conference_id = $1 and room is not null and (is_published = true or $2 = true)
         order by room asc`,
        [req.params.conferenceId, isAuthorizedManager]
      ),
      pool.query(
        `select id, name from public.tracks where conference_id = $1 and is_active = true order by name asc`,
        [req.params.conferenceId]
      ),
    ]);

    const sessionRows = sessionsResult.rows;
    let presentationSlotsBySession = {};

    if (sessionRows.length > 0) {
      const sessionIds = sessionRows.map((s) => s.id);
      const slotsResult = await pool.query(
        `select ss.id, ss.session_id, ss.submission_id, ss.slot_number, ss.starts_at, ss.ends_at,
                ss.duration_minutes, ss.presentation_status, ss.chair_notes,
                sub.paper_code, sub.title,
                pres.id as presenter_id, pres.full_name as presenter_name, pres.email as presenter_email
         from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         left join public.users pres on pres.id = ss.presenter_user_id
         where ss.session_id = any($1::uuid[])
         order by ss.slot_number asc`,
        [sessionIds]
      );

      const submissionIds = [...new Set(slotsResult.rows.map((r) => r.submission_id))];
      let authorsMap = {};
      if (submissionIds.length > 0) {
        const authorsResult = await pool.query(
          `select submission_id, full_name, institution
           from public.authors
           where submission_id = any($1::uuid[])
           order by author_order asc`,
          [submissionIds]
        );
        for (const a of authorsResult.rows) {
          if (!authorsMap[a.submission_id]) authorsMap[a.submission_id] = [];
          authorsMap[a.submission_id].push({ fullName: a.full_name, affiliation: a.institution });
        }
      }

      for (const slot of slotsResult.rows) {
        if (!presentationSlotsBySession[slot.session_id]) {
          presentationSlotsBySession[slot.session_id] = [];
        }
        presentationSlotsBySession[slot.session_id].push({
          id: slot.id,
          submissionId: slot.submission_id,
          paperCode: slot.paper_code,
          title: slot.title,
          slotNumber: slot.slot_number,
          startsAt: slot.starts_at,
          endsAt: slot.ends_at,
          durationMinutes: slot.duration_minutes,
          presentationStatus: slot.presentation_status,
          chairNotes: slot.chair_notes,
          presenter: slot.presenter_id
            ? { id: slot.presenter_id, fullName: slot.presenter_name, email: slot.presenter_email }
            : null,
          authors: authorsMap[slot.submission_id] || [],
        });
      }
    }

    const sessionsWithSlots = sessionRows.map((s) => ({
      ...s,
      presentation_slots: presentationSlotsBySession[s.id] || [],
    }));

    res.json({
      data: {
        sessions: sessionsWithSlots,
        availableDays: [...new Set(daysResult.rows.map((r) => new Date(r.starts_at).toISOString().split('T')[0]))].sort(),
        availableRooms: roomsResult.rows.map((r) => r.room),
        availableTracks: tracksResult.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Personalized schedule for the logged in user (chaired sessions, presentations, registered conference schedule)
router.get('/schedule/my', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const authoredSubmissionsRes = await pool.query(
      `select submission_id from public.authors where user_id = $1 or lower(email) = lower($2)`,
      [req.user.id, req.user.email]
    );
    const authoredIds = authoredSubmissionsRes.rows.map((r) => r.submission_id);

    const [chairedSessionsRes, myPresentations, attendedSessions] = await Promise.all([
      pool.query(
        `select s.id, s.conference_id, s.session_code, s.title, s.room, s.venue, s.format,
                s.starts_at, s.ends_at, c.title as conference_title
         from public.sessions s
         join public.conferences c on c.id = s.conference_id
         where s.session_chair_id = $1
         order by s.starts_at asc`,
        [req.user.id]
      ),
      pool.query(
        `select ss.id as slot_id, ss.slot_number, ss.starts_at as slot_starts_at, ss.ends_at as slot_ends_at,
                ss.duration_minutes, ss.presentation_status,
                s.id as session_id, s.title as session_title, s.room, s.venue, s.starts_at as session_starts_at,
                sub.id as submission_id, sub.paper_code, sub.title as paper_title,
                c.id as conference_id, c.title as conference_title,
                u.full_name as chair_name
         from public.session_submissions ss
         join public.sessions s on s.id = ss.session_id
         join public.submissions sub on sub.id = ss.submission_id
         join public.conferences c on c.id = s.conference_id
         left join public.users u on u.id = s.session_chair_id
         where ss.presenter_user_id = $1
            or sub.submitted_by = $1
            or sub.id = any($2::uuid[])
         order by coalesce(ss.starts_at, s.starts_at) asc`,
        [req.user.id, authoredIds]
      ),
      pool.query(
        `select a.id as attendance_id, a.session_id, a.checked_in_at, a.check_in_method, a.attendance_role,
                s.title as session_title, s.room, s.starts_at, s.ends_at, c.title as conference_title
         from public.attendance a
         join public.sessions s on s.id = a.session_id
         join public.conferences c on c.id = s.conference_id
         where a.user_id = $1
         order by a.checked_in_at desc`,
        [req.user.id]
      ),
    ]);

    let chairedRows = chairedSessionsRes.rows;
    if (chairedRows.length > 0) {
      const sessionIds = chairedRows.map((s) => s.id);
      const countsRes = await pool.query(
        `select session_id, count(*)::int as count from public.session_submissions where session_id = any($1::uuid[]) group by session_id`,
        [sessionIds]
      );
      const countsMap = countsRes.rows.reduce((acc, r) => {
        acc[r.session_id] = Number(r.count);
        return acc;
      }, {});
      chairedRows = chairedRows.map((s) => ({
        ...s,
        slot_count: countsMap[s.id] || 0,
      }));
    }

    res.json({
      data: {
        chairedSessions: chairedRows,
        myPresentations: myPresentations.rows,
        myAttendance: attendedSessions.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Participant & Presenter attendance check-in (manual or via QR token)
router.post('/sessions/:sessionId/check-in', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.sessionId).success) return fail(res, 400, 'Session ID is invalid.');
  const schema = z.object({ token: z.string().trim().optional() }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid request parameters.');

  try {
    const sessionQuery = await pool.query(
      `select s.id, s.conference_id, s.title, s.starts_at, s.ends_at, s.session_chair_id, c.title as conference_title
       from public.sessions s
       join public.conferences c on c.id = s.conference_id
       where s.id = $1`,
      [req.params.sessionId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    // If a token is supplied, validate token expiration and hash
    let checkInMethod = 'manual';
    if (parsed.data.token) {
      const hashed = hashToken(parsed.data.token);
      const tokenQuery = await pool.query(
        `select id from public.session_checkin_tokens
         where session_id = $1 and token_hash = $2 and expires_at > now()`,
        [session.id, hashed]
      );
      if (!tokenQuery.rows[0]) {
        return fail(res, 400, 'Check-in token is invalid or has expired.');
      }
      checkInMethod = 'qr_code';
    }

    // Determine attendee role
    let attendanceRole = 'participant';
    if (session.session_chair_id === req.user.id) {
      attendanceRole = 'chair';
    } else {
      const authoredRes = await pool.query(
        `select submission_id from public.authors where user_id = $1 or lower(email) = lower($2)`,
        [req.user.id, req.user.email]
      );
      const authoredIds = authoredRes.rows.map((r) => r.submission_id);

      const presenterQuery = await pool.query(
        `select 1 from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         where ss.session_id = $1
         and (ss.presenter_user_id = $2 or sub.submitted_by = $2 or sub.id = any($3::uuid[]))
         limit 1`,
        [session.id, req.user.id, authoredIds]
      );
      if (presenterQuery.rows[0]) attendanceRole = 'presenter';
    }

    // Insert attendance record safely with duplicate prevention
    const { rows } = await pool.query(
      `insert into public.attendance(session_id, user_id, check_in_method, attendance_role, checked_in_at)
       values($1, $2, $3, $4, now())
       on conflict(session_id, user_id) do update
       set checked_in_at = public.attendance.checked_in_at
       returning id, session_id, user_id, check_in_method, attendance_role, checked_in_at`,
      [session.id, req.user.id, checkInMethod, attendanceRole]
    );

    res.json({
      data: {
        message: 'Attendance check-in recorded successfully!',
        record: rows[0],
        sessionTitle: session.title,
        conferenceTitle: session.conference_title,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Generate rotating secure QR Check-in token (Chair or Manager only)
router.post('/sessions/:sessionId/check-in-token', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.sessionId).success) return fail(res, 400, 'Session ID is invalid.');
  try {
    const sessionQuery = await pool.query(
      `select id, conference_id, session_chair_id, title from public.sessions where id = $1`,
      [req.params.sessionId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    const isChair = session.session_chair_id === req.user.id;
    const manager = await isManager(req, session.conference_id);
    if (!isChair && !manager) return fail(res, 403, 'Only the session chair or conference organizer can generate check-in tokens.');

    const rawToken = createOpaqueToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    await pool.query(
      `insert into public.session_checkin_tokens(session_id, token_hash, expires_at)
       values($1, $2, $3)`,
      [session.id, tokenHash, expiresAt]
    );

    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const checkInUrl = `${clientOrigin}/check-in?sessionId=${session.id}&token=${rawToken}`;

    res.json({
      data: {
        sessionId: session.id,
        token: rawToken,
        expiresAt,
        checkInUrl,
      },
    });
  } catch (e) {
    next(e);
  }
});

// -------------------------------------------------------------
// Session Chair Workspace Endpoints
// -------------------------------------------------------------

// Chair list of assigned sessions
router.get('/chair/sessions', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select s.id, s.conference_id, s.session_code, s.title, s.description, s.room, s.venue,
              s.format, s.session_type, s.starts_at, s.ends_at, s.is_published,
              c.title as conference_title
       from public.sessions s
       join public.conferences c on c.id = s.conference_id
       where s.session_chair_id = $1
       order by s.starts_at asc`,
      [req.user.id]
    );

    if (rows.length === 0) return res.json({ data: [] });

    const sessionIds = rows.map((s) => s.id);
    const [presentationsRes, attendanceRes] = await Promise.all([
      pool.query(
        `select session_id, count(*)::int as count from public.session_submissions where session_id = any($1::uuid[]) group by session_id`,
        [sessionIds]
      ),
      pool.query(
        `select session_id, count(*)::int as count from public.attendance where session_id = any($1::uuid[]) group by session_id`,
        [sessionIds]
      ),
    ]);

    const presMap = presentationsRes.rows.reduce((acc, r) => {
      acc[r.session_id] = Number(r.count);
      return acc;
    }, {});
    const attMap = attendanceRes.rows.reduce((acc, r) => {
      acc[r.session_id] = Number(r.count);
      return acc;
    }, {});

    const enriched = rows.map((s) => ({
      ...s,
      presentation_count: presMap[s.id] || 0,
      attendance_count: attMap[s.id] || 0,
    }));

    res.json({ data: enriched });
  } catch (e) {
    next(e);
  }
});

// Chair session dashboard detail (slots + real-time attendance roster)
router.get('/chair/sessions/:sessionId', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.sessionId).success) return fail(res, 400, 'Session ID is invalid.');
  try {
    const sessionQuery = await pool.query(
      `select s.*, c.title as conference_title, c.timezone
       from public.sessions s join public.conferences c on c.id = s.conference_id
       where s.id = $1`,
      [req.params.sessionId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    const isChair = session.session_chair_id === req.user.id;
    const manager = await isManager(req, session.conference_id);
    if (!isChair && !manager) return fail(res, 403, 'Session Chair access is required.');

    const [slotsResult, attendanceResult, registeredUsers] = await Promise.all([
      pool.query(
        `select ss.id, ss.slot_number, ss.starts_at, ss.ends_at, ss.duration_minutes,
                ss.presentation_status, ss.chair_notes,
                sub.id as submission_id, sub.paper_code, sub.title as paper_title, sub.abstract,
                pres.id as presenter_id, pres.full_name as presenter_name, pres.email as presenter_email
         from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         left join public.users pres on pres.id = ss.presenter_user_id
         where ss.session_id = $1
         order by ss.slot_number asc`,
        [session.id]
      ),
      pool.query(
        `select a.id, a.user_id, a.checked_in_at, a.check_in_method, a.attendance_role,
                u.full_name, u.email, u.institution
         from public.attendance a
         join public.users u on u.id = a.user_id
         where a.session_id = $1
         order by a.checked_in_at desc`,
        [session.id]
      ),
      pool.query(
        `select u.id, u.full_name, u.email, u.institution
         from public.registrations r
         join public.users u on u.id = r.user_id
         where r.conference_id = $1 and r.status in ('confirmed', 'pending')
         order by u.full_name asc`,
        [session.conference_id]
      ),
    ]);

    const submissionIds = [...new Set(slotsResult.rows.map((r) => r.submission_id))];
    let authorsBySubmission = {};
    if (submissionIds.length > 0) {
      const authorsRes = await pool.query(
        `select submission_id, full_name, institution
         from public.authors
         where submission_id = any($1::uuid[])
         order by author_order asc`,
        [submissionIds]
      );
      for (const a of authorsRes.rows) {
        if (!authorsBySubmission[a.submission_id]) authorsBySubmission[a.submission_id] = [];
        authorsBySubmission[a.submission_id].push({ fullName: a.full_name, affiliation: a.institution });
      }
    }

    const slotsWithAuthors = slotsResult.rows.map((slot) => ({
      ...slot,
      authors: authorsBySubmission[slot.submission_id] || [],
    }));

    res.json({
      data: {
        session,
        slots: slotsWithAuthors,
        attendance: attendanceResult.rows,
        registeredAttendees: registeredUsers.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Chair update presentation status (completed, absent, cancelled, rescheduled)
router.patch('/chair/sessions/:sessionId/slots/:slotId/status', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.sessionId).success || !uuid.safeParse(req.params.slotId).success) {
    return fail(res, 400, 'Session or Slot ID is invalid.');
  }
  const schema = z.object({
    status: z.enum(presentationStatuses),
    chairNotes: z.string().trim().max(1000).optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid presentation status.');

  try {
    const sessionQuery = await pool.query(
      `select id, conference_id, session_chair_id, title from public.sessions where id = $1`,
      [req.params.sessionId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    const isChair = session.session_chair_id === req.user.id;
    const manager = await isManager(req, session.conference_id);
    if (!isChair && !manager) return fail(res, 403, 'Only the assigned session chair or conference manager can update presentation status.');

    const { rows } = await pool.query(
      `update public.session_submissions
       set presentation_status = $1, chair_notes = coalesce($2, chair_notes), updated_at = now()
       where id = $3 and session_id = $4
       returning id, presentation_status, chair_notes, updated_at`,
      [parsed.data.status, parsed.data.chairNotes || null, req.params.slotId, session.id]
    );
    if (!rows[0]) return fail(res, 404, 'Presentation slot not found in this session.');

    await audit(pool, req.user.id, 'presentation.status_updated', 'session_submission', req.params.slotId, {
      status: parsed.data.status,
      sessionId: session.id,
    });

    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Chair manual check-in of an attendee or presenter
router.post('/chair/sessions/:sessionId/attendance', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.sessionId).success) return fail(res, 400, 'Session ID is invalid.');
  const schema = z.object({
    userId: uuid,
    attendanceRole: z.enum(['participant', 'presenter', 'chair']).default('participant'),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Provide a valid user ID.');

  try {
    const sessionQuery = await pool.query(
      `select id, conference_id, session_chair_id from public.sessions where id = $1`,
      [req.params.sessionId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    const isChair = session.session_chair_id === req.user.id;
    const manager = await isManager(req, session.conference_id);
    if (!isChair && !manager) return fail(res, 403, 'Session Chair access is required.');

    const { rows } = await pool.query(
      `insert into public.attendance(session_id, user_id, check_in_method, attendance_role, recorded_by, checked_in_at)
       values($1, $2, 'chair_verified', $3, $4, now())
       on conflict(session_id, user_id) do update
       set attendance_role = excluded.attendance_role, recorded_by = excluded.recorded_by
       returning id, session_id, user_id, check_in_method, attendance_role, checked_in_at`,
      [session.id, parsed.data.userId, parsed.data.attendanceRole, req.user.id]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// -------------------------------------------------------------
// Admin / Organizer Scheduling Endpoints
// -------------------------------------------------------------

// Create Session with conflict checks
router.post('/admin/conferences/:conferenceId/sessions', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const schema = z.object({
    title: z.string().trim().min(3).max(250),
    sessionCode: z.string().trim().max(50).nullable().optional(),
    description: z.string().trim().max(3000).nullable().optional(),
    trackId: uuid.nullable().optional(),
    venue: z.string().trim().max(200).nullable().optional(),
    room: z.string().trim().min(1).max(100),
    format: z.enum(sessionFormats).default('in_person'),
    sessionType: z.enum(sessionTypes).default('paper_session'),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    sessionChairId: uuid.nullable().optional(),
    isPublished: z.boolean().default(false),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check session details and date/time fields.');

  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  if (endsAt <= startsAt) return fail(res, 400, 'Session end time must be after the start time.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const conflicts = await detectSessionConflicts(pool, {
      conferenceId: req.params.conferenceId,
      room: parsed.data.room,
      startsAt: parsed.data.startsAt,
      endsAt: parsed.data.endsAt,
      sessionChairId: parsed.data.sessionChairId || null,
    });
    if (conflicts.length) return fail(res, 409, `Scheduling conflict: ${conflicts.join(' ')}`);

    const { rows } = await pool.query(
      `insert into public.sessions(
         conference_id, track_id, title, session_code, description, venue, room, format,
         session_type, starts_at, ends_at, session_chair_id, is_published
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id, conference_id, session_code, title, room, starts_at, ends_at, is_published`,
      [
        req.params.conferenceId,
        parsed.data.trackId || null,
        parsed.data.title,
        parsed.data.sessionCode || null,
        parsed.data.description || null,
        parsed.data.venue || null,
        parsed.data.room,
        parsed.data.format,
        parsed.data.sessionType,
        parsed.data.startsAt,
        parsed.data.endsAt,
        parsed.data.sessionChairId || null,
        parsed.data.isPublished,
      ]
    );

    await audit(pool, req.user.id, 'session.created', 'session', rows[0].id, {
      title: parsed.data.title,
      room: parsed.data.room,
    });

    if (parsed.data.sessionChairId) {
      await notify(
        pool,
        parsed.data.sessionChairId,
        req.params.conferenceId,
        'Assigned as Session Chair',
        `You have been assigned to chair the session "${parsed.data.title}" (${parsed.data.room}).`
      );
    }

    res.status(201).json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Edit Session with conflict checks & change notifications
router.patch('/admin/conferences/:conferenceId/sessions/:sessionId', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.sessionId).success) {
    return fail(res, 400, 'Conference or Session ID is invalid.');
  }
  const schema = z.object({
    title: z.string().trim().min(3).max(250).optional(),
    sessionCode: z.string().trim().max(50).nullable().optional(),
    description: z.string().trim().max(3000).nullable().optional(),
    trackId: uuid.nullable().optional(),
    venue: z.string().trim().max(200).nullable().optional(),
    room: z.string().trim().min(1).max(100).optional(),
    format: z.enum(sessionFormats).optional(),
    sessionType: z.enum(sessionTypes).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    sessionChairId: uuid.nullable().optional(),
    isPublished: z.boolean().optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check submitted session fields.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const curr = (await pool.query('select * from public.sessions where id = $1 and conference_id = $2', [req.params.sessionId, req.params.conferenceId])).rows[0];
    if (!curr) return fail(res, 404, 'Session not found.');

    const newStartsAt = parsed.data.startsAt || curr.starts_at;
    const newEndsAt = parsed.data.endsAt || curr.ends_at;
    if (new Date(newEndsAt) <= new Date(newStartsAt)) {
      return fail(res, 400, 'Session end time must be after start time.');
    }

    const newRoom = parsed.data.room || curr.room;
    const newChairId = parsed.data.sessionChairId !== undefined ? parsed.data.sessionChairId : curr.session_chair_id;

    const conflicts = await detectSessionConflicts(pool, {
      conferenceId: req.params.conferenceId,
      sessionId: curr.id,
      room: newRoom,
      startsAt: newStartsAt,
      endsAt: newEndsAt,
      sessionChairId: newChairId || null,
    });
    if (conflicts.length) return fail(res, 409, `Scheduling conflict: ${conflicts.join(' ')}`);

    const { rows } = await pool.query(
      `update public.sessions
       set title = coalesce($1, title),
           session_code = case when $2 is not null then $2 else session_code end,
           description = case when $3 is not null then $3 else description end,
           track_id = case when $4 is not null then $4 else track_id end,
           venue = case when $5 is not null then $5 else venue end,
           room = coalesce($6, room),
           format = coalesce($7, format),
           session_type = coalesce($8, session_type),
           starts_at = coalesce($9, starts_at),
           ends_at = coalesce($10, ends_at),
           session_chair_id = case when $11 is not null then $11 else session_chair_id end,
           is_published = coalesce($12, is_published),
           updated_at = now()
       where id = $13 and conference_id = $14
       returning *`,
      [
        parsed.data.title || null,
        parsed.data.sessionCode !== undefined ? parsed.data.sessionCode : null,
        parsed.data.description !== undefined ? parsed.data.description : null,
        parsed.data.trackId !== undefined ? parsed.data.trackId : null,
        parsed.data.venue !== undefined ? parsed.data.venue : null,
        parsed.data.room || null,
        parsed.data.format || null,
        parsed.data.sessionType || null,
        parsed.data.startsAt || null,
        parsed.data.endsAt || null,
        parsed.data.sessionChairId !== undefined ? parsed.data.sessionChairId : null,
        parsed.data.isPublished !== undefined ? parsed.data.isPublished : null,
        curr.id,
        req.params.conferenceId,
      ]
    );

    // If timing or room changed, notify scheduled presenters & chair
    const isTimingChanged = parsed.data.startsAt || parsed.data.endsAt || parsed.data.room;
    if (isTimingChanged) {
      const stakeholders = await pool.query(
        `select distinct u.id, u.email from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         join public.users u on (u.id = ss.presenter_user_id or u.id = sub.submitted_by)
         where ss.session_id = $1`,
        [curr.id]
      );
      for (const s of stakeholders.rows) {
        await notify(
          pool,
          s.id,
          req.params.conferenceId,
          'Session Schedule Updated',
          `The schedule for your session "${rows[0].title}" was updated to ${new Date(rows[0].starts_at).toLocaleString()} in ${rows[0].room}.`
        );
      }
    }

    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Delete Session
router.delete('/admin/conferences/:conferenceId/sessions/:sessionId', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.sessionId).success) {
    return fail(res, 400, 'Conference or Session ID is invalid.');
  }
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `delete from public.sessions where id = $1 and conference_id = $2 returning id, title`,
      [req.params.sessionId, req.params.conferenceId]
    );
    if (!rows[0]) return fail(res, 404, 'Session not found.');
    await audit(pool, req.user.id, 'session.deleted', 'session', req.params.sessionId, { title: rows[0].title });
    res.json({ data: { message: 'Session deleted successfully.', id: rows[0].id } });
  } catch (e) {
    next(e);
  }
});

// Toggle Publish Session Schedule
router.post('/admin/conferences/:conferenceId/sessions/:sessionId/publish', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.sessionId).success) {
    return fail(res, 400, 'Conference or Session ID is invalid.');
  }
  const schema = z.object({ isPublished: z.boolean() }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid publish flag.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `update public.sessions set is_published = $1, updated_at = now() where id = $2 and conference_id = $3 returning id, is_published`,
      [parsed.data.isPublished, req.params.sessionId, req.params.conferenceId]
    );
    if (!rows[0]) return fail(res, 404, 'Session not found.');
    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// List eligible accepted papers that are ready to be scheduled
router.get('/admin/conferences/:conferenceId/eligible-papers', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `select s.id, s.paper_code, s.title, s.category, s.status, t.name as track_name,
              u.id as submitter_id, u.full_name as submitter_name, u.email as submitter_email
       from public.submissions s
       left join public.tracks t on t.id = s.track_id
       left join public.users u on u.id = s.submitted_by
       where s.conference_id = $1 and s.status in ('accepted', 'camera_ready', 'finalized')
       order by s.paper_code asc`,
      [req.params.conferenceId]
    );

    if (rows.length === 0) return res.json({ data: [] });

    const submissionIds = rows.map((r) => r.id);
    const [authorsRes, assignmentsRes] = await Promise.all([
      pool.query(
        `select submission_id, user_id, full_name, email
         from public.authors
         where submission_id = any($1::uuid[])
         order by author_order asc`,
        [submissionIds]
      ),
      pool.query(
        `select submission_id, session_id from public.session_submissions where submission_id = any($1::uuid[])`,
        [submissionIds]
      ),
    ]);

    const authorsMap = {};
    for (const a of authorsRes.rows) {
      if (!authorsMap[a.submission_id]) authorsMap[a.submission_id] = [];
      authorsMap[a.submission_id].push({ userId: a.user_id, fullName: a.full_name, email: a.email });
    }

    const assignmentsMap = {};
    for (const ass of assignmentsRes.rows) {
      assignmentsMap[ass.submission_id] = ass.session_id;
    }

    const papers = rows.map((r) => ({
      ...r,
      authors: authorsMap[r.id] || [],
      assigned_session_id: assignmentsMap[r.id] || null,
    }));

    res.json({ data: papers });
  } catch (e) {
    next(e);
  }
});

// Assign accepted paper to presentation slot
router.post('/admin/conferences/:conferenceId/sessions/:sessionId/slots', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.sessionId).success) {
    return fail(res, 400, 'Conference or Session ID is invalid.');
  }
  const schema = z.object({
    submissionId: uuid,
    presenterUserId: uuid.nullable().optional(),
    durationMinutes: z.number().int().min(5).max(180).default(15),
    slotNumber: z.number().int().min(1).max(50).optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check presentation slot details.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const sessionQuery = await pool.query(
      `select id, conference_id, title, starts_at, ends_at, room from public.sessions where id = $1 and conference_id = $2`,
      [req.params.sessionId, req.params.conferenceId]
    );
    const session = sessionQuery.rows[0];
    if (!session) return fail(res, 404, 'Session not found.');

    // Verify paper eligibility
    const paperQuery = await pool.query(
      `select id, paper_code, title, status from public.submissions
       where id = $1 and conference_id = $2`,
      [parsed.data.submissionId, req.params.conferenceId]
    );
    const paper = paperQuery.rows[0];
    if (!paper) return fail(res, 404, 'Paper not found for this conference.');
    if (!['accepted', 'camera_ready', 'finalized'].includes(paper.status)) {
      return fail(res, 409, `Only accepted papers can be scheduled for presentation (Current paper status: ${paper.status}).`);
    }

    // Check if already assigned
    const existingAssignment = await pool.query(
      `select s.id, s.title from public.session_submissions ss
       join public.sessions s on s.id = ss.session_id
       where ss.submission_id = $1`,
      [paper.id]
    );
    if (existingAssignment.rows[0]) {
      return fail(res, 409, `Paper is already scheduled in session "${existingAssignment.rows[0].title}".`);
    }

    // Calculate slot number
    let slotNumber = parsed.data.slotNumber;
    if (!slotNumber) {
      const maxSlot = await pool.query(`select coalesce(max(slot_number), 0) + 1 as next_slot from public.session_submissions where session_id = $1`, [session.id]);
      slotNumber = Number(maxSlot.rows[0].next_slot);
    }

    const { rows } = await pool.query(
      `insert into public.session_submissions(
         session_id, submission_id, slot_number, duration_minutes, starts_at, ends_at, presenter_user_id
       ) values($1, $2, $3, $4, $5, $6, $7)
       returning id, session_id, submission_id, slot_number, duration_minutes, starts_at, ends_at, presentation_status`,
      [
        session.id,
        paper.id,
        slotNumber,
        parsed.data.durationMinutes,
        parsed.data.startsAt || null,
        parsed.data.endsAt || null,
        parsed.data.presenterUserId || null,
      ]
    );

    await audit(pool, req.user.id, 'presentation_slot.created', 'session_submission', rows[0].id, {
      paperCode: paper.paper_code,
      sessionId: session.id,
    });

    res.status(201).json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Remove paper from session slot
router.delete('/admin/conferences/:conferenceId/sessions/:sessionId/slots/:slotId', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.sessionId).success || !uuid.safeParse(req.params.slotId).success) {
    return fail(res, 400, 'IDs are invalid.');
  }
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `delete from public.session_submissions where id = $1 and session_id = $2 returning id`,
      [req.params.slotId, req.params.sessionId]
    );
    if (!rows[0]) return fail(res, 404, 'Slot not found.');
    res.json({ data: { message: 'Slot removed.', id: rows[0].id } });
  } catch (e) {
    next(e);
  }
});

// Conference Attendance & Certificate Eligibility Report
router.get('/admin/conferences/:conferenceId/attendance-report', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const [totalSessionsResult, registrationsResult, attendanceResult, presentationsResult, certificatesResult] = await Promise.all([
      pool.query(`select count(*)::int as count from public.sessions where conference_id = $1 and is_published = true`, [req.params.conferenceId]),
      pool.query(
        `select u.id as user_id, u.full_name, u.email, u.institution,
                r.reference_code, r.category as registration_category, r.status as registration_status
         from public.registrations r
         join public.users u on u.id = r.user_id
         where r.conference_id = $1 and r.status in ('confirmed', 'pending')
         order by u.full_name asc`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select a.user_id, count(distinct a.session_id)::int as attended_sessions_count
         from public.attendance a
         join public.sessions s on s.id = a.session_id
         where s.conference_id = $1
         group by a.user_id`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select ss.presenter_user_id as user_id, count(*)::int as completed_presentations_count
         from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         where sub.conference_id = $1 and ss.presentation_status = 'completed' and ss.presenter_user_id is not null
         group by ss.presenter_user_id`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select user_id, certificate_number from public.certificates where conference_id = $1`,
        [req.params.conferenceId]
      ),
    ]);

    const totalSessions = totalSessionsResult.rows[0]?.count || 0;
    const attendanceMap = attendanceResult.rows.reduce((acc, r) => {
      acc[r.user_id] = Number(r.attended_sessions_count);
      return acc;
    }, {});
    const presentationMap = presentationsResult.rows.reduce((acc, r) => {
      acc[r.user_id] = Number(r.completed_presentations_count);
      return acc;
    }, {});
    const certificateMap = certificatesResult.rows.reduce((acc, r) => {
      acc[r.user_id] = r.certificate_number;
      return acc;
    }, {});

    const attendees = registrationsResult.rows.map((row) => {
      const attendedCount = attendanceMap[row.user_id] || 0;
      const completedPresentations = presentationMap[row.user_id] || 0;
      const attendancePercent = totalSessions > 0 ? Math.round((attendedCount / totalSessions) * 100) : 0;
      const isEligible = attendedCount >= 1 || completedPresentations >= 1;

      return {
        ...row,
        attended_sessions_count: attendedCount,
        completed_presentations_count: completedPresentations,
        issued_certificate_number: certificateMap[row.user_id] || null,
        attendancePercent,
        isCertificateEligible: isEligible,
      };
    });

    res.json({
      data: {
        totalConferenceSessions: totalSessions,
        attendees,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
