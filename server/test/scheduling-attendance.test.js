import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.CSRF_SECRET = randomBytes(48).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
delete process.env.SMTP_HOST;

const db = newDb();
db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: randomUUID, impure: true });
const { Pool } = db.adapters.createPg();
const pg = new Pool();

await pg.query(`
  create table public.users (
    id uuid primary key default gen_random_uuid(), email text not null unique, full_name text not null,
    institution text, job_title text, phone text, password_hash text, email_verified_at timestamptz,
    is_active boolean not null default true, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.roles (id uuid primary key default gen_random_uuid(), name text not null unique);
  create table public.user_roles (user_id uuid not null references public.users(id), role_id uuid not null references public.roles(id), primary key(user_id, role_id));
  create table public.conferences (
    id uuid primary key default gen_random_uuid(), title text not null, timezone text default 'Asia/Dhaka',
    status text not null default 'published', max_capacity integer, organizer_user_id uuid,
    start_date date, end_date date, venue text, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.conference_memberships (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    user_id uuid references public.users(id), role_id uuid references public.roles(id), unique(conference_id, user_id, role_id)
  );
  create table public.tracks (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    name text not null, is_active boolean not null default true
  );
  create table public.auth_sessions (
    token_hash text primary key, user_id uuid references public.users(id), csrf_token text not null,
    expires_at timestamptz not null, created_at timestamptz default now(), last_seen_at timestamptz default now()
  );
  create table public.audit_logs (
    id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
    entity_type text not null, entity_id uuid, details jsonb default '{}'::jsonb, created_at timestamptz default now()
  );
  create table public.notifications (
    id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id),
    conference_id uuid references public.conferences(id), title text not null, body text not null,
    channel text default 'in_app', read_at timestamptz, created_at timestamptz default now()
  );
  create table public.submissions (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    track_id uuid references public.tracks(id), submitted_by uuid references public.users(id),
    paper_code text, title text not null, abstract text, status text default 'accepted'
  );
  create table public.authors (
    id uuid primary key default gen_random_uuid(), submission_id uuid references public.submissions(id),
    user_id uuid references public.users(id), full_name text, email text, institution text, author_order smallint default 1
  );
  create table public.registrations (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    user_id uuid not null references public.users(id), reference_code text, category text default 'general_attendee',
    status text default 'confirmed', payment_status text default 'verified'
  );
  create table public.sessions (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    track_id uuid references public.tracks(id), session_code text, title text not null, description text,
    venue text, room text, format text not null default 'in_person', session_type text not null default 'paper_session',
    starts_at timestamptz not null, ends_at timestamptz not null, session_chair_id uuid references public.users(id),
    is_published boolean not null default false, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.session_submissions (
    id uuid primary key default gen_random_uuid(), session_id uuid not null references public.sessions(id),
    submission_id uuid not null references public.submissions(id), slot_number integer not null default 1,
    duration_minutes integer not null default 15, starts_at timestamptz, ends_at timestamptz,
    presenter_user_id uuid references public.users(id), presentation_status text not null default 'scheduled',
    chair_notes text, updated_at timestamptz default now()
  );
  create table public.attendance (
    id uuid primary key default gen_random_uuid(), session_id uuid not null references public.sessions(id),
    user_id uuid not null references public.users(id), check_in_method text not null default 'manual',
    attendance_role text not null default 'participant', recorded_by uuid references public.users(id),
    checked_in_at timestamptz not null default now(), checked_out_at timestamptz, created_at timestamptz default now(),
    unique(session_id, user_id)
  );
  create table public.session_checkin_tokens (
    id uuid primary key default gen_random_uuid(), session_id uuid not null references public.sessions(id),
    token_hash text not null unique, expires_at timestamptz not null, created_at timestamptz default now()
  );
  create table public.certificates (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    user_id uuid references public.users(id), certificate_number text
  );
`);

await pg.query(`insert into public.roles(name) values ('super_admin'), ('conference_admin'), ('session_chair'), ('author'), ('attendee')`);

const { configurePoolForTests } = await import('../src/db/pool.js');
configurePoolForTests(pg);
const { hashPassword, hashToken } = await import('../src/auth/crypto.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

let organizer, chair, presenter, attendee, conferenceId, trackId, acceptedPaper, pendingPaper;

async function createUser(email, role, confId = null) {
  const hash = await hashPassword('StrongPassword123!');
  const user = (await pg.query(
    `insert into public.users(email, full_name, password_hash, email_verified_at)
     values($1, $2, $3, now()) returning id, email`,
    [email, email.split('@')[0], hash]
  )).rows[0];

  await pg.query(
    `insert into public.user_roles(user_id, role_id) select $1, id from public.roles where name = $2`,
    [user.id, role]
  );
  if (confId && (role === 'conference_admin' || role === 'session_chair')) {
    await pg.query(
      `insert into public.conference_memberships(conference_id, user_id, role_id)
       select $1, $2, id from public.roles where name = $3`,
      [confId, user.id, role]
    );
  }

  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  await pg.query(
    `insert into public.auth_sessions(token_hash, user_id, csrf_token, expires_at)
     values($1, $2, $3, now() + interval '1 day')`,
    [hashToken(token), user.id, csrf]
  );

  return { id: user.id, email: user.email, cookie: `bup_session=${token}; bup_csrf=${csrf}`, csrf };
}

before(async () => {
  const conf = (await pg.query(`insert into public.conferences(title, status) values('BUP Annual Cybersecurity Summit', 'published') returning id`)).rows[0];
  conferenceId = conf.id;

  const trk = (await pg.query(`insert into public.tracks(conference_id, name) values($1, 'Network Security') returning id`, [conferenceId])).rows[0];
  trackId = trk.id;

  organizer = await createUser('organizer-sched@bup.edu.bd', 'conference_admin', conferenceId);
  chair = await createUser('chair-dr-karim@bup.edu.bd', 'session_chair', conferenceId);
  presenter = await createUser('author-presenter@university.test', 'author');
  attendee = await createUser('attendee-participant@test.org', 'attendee');

  // Register attendee and presenter
  await pg.query(`insert into public.registrations(conference_id, user_id, reference_code, status) values
    ('${conferenceId}', '${attendee.id}', 'BUP-REG-2026-ATT1', 'confirmed'),
    ('${conferenceId}', '${presenter.id}', 'BUP-REG-2026-PRES1', 'confirmed')
  `);

  // Create accepted and pending submissions
  acceptedPaper = (await pg.query(`insert into public.submissions(conference_id, track_id, submitted_by, paper_code, title, status)
    values('${conferenceId}', '${trackId}', '${presenter.id}', 'BUP-2026-SEC01', 'Zero Trust Architecture in Higher Ed', 'accepted') returning id`)).rows[0];
  await pg.query(`insert into public.authors(submission_id, user_id, full_name, email) values('${acceptedPaper.id}', '${presenter.id}', 'Presenter Author', '${presenter.email}')`);

  pendingPaper = (await pg.query(`insert into public.submissions(conference_id, track_id, submitted_by, paper_code, title, status)
    values('${conferenceId}', '${trackId}', '${presenter.id}', 'BUP-2026-SEC02', 'Under Review Draft Paper', 'under_review') returning id`)).rows[0];
});

after(async () => {
  await pg.end();
});

test('organizer creates session with validation, while overlapping room/chair conflicts are rejected', async () => {
  const agent = supertest(app);

  const t1 = '2026-11-10T09:00:00.000Z';
  const t2 = '2026-11-10T10:30:00.000Z';

  // 1. Create first valid session
  const s1 = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      title: 'Opening Plenary & Cyber Defense',
      sessionCode: 'SES-01',
      room: 'Auditorium Hall A',
      venue: 'BUP Central Campus',
      format: 'in_person',
      sessionType: 'paper_session',
      trackId,
      startsAt: t1,
      endsAt: t2,
      sessionChairId: chair.id,
      isPublished: false,
    })
    .expect(201);

  assert.equal(s1.body.data.title, 'Opening Plenary & Cyber Defense');
  assert.equal(s1.body.data.room, 'Auditorium Hall A');

  // 2. Overlapping room booking conflict (same room, overlapping time -> 409)
  const roomConflict = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      title: 'Concurrent AI Session',
      room: 'Auditorium Hall A', // Same room!
      startsAt: '2026-11-10T09:30:00.000Z', // Overlaps!
      endsAt: '2026-11-10T11:00:00.000Z',
    })
    .expect(409);

  assert.match(roomConflict.body.error.message, /already booked for session/);

  // 3. Overlapping session chair conflict (different room, but same chair at same time -> 409)
  const chairConflict = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      title: 'Parallel Workshop Session',
      room: 'Room 302', // Different room
      startsAt: '2026-11-10T10:00:00.000Z', // Overlaps chair!
      endsAt: '2026-11-10T11:30:00.000Z',
      sessionChairId: chair.id,
    })
    .expect(409);

  assert.match(chairConflict.body.error.message, /already chairing session/);
});

test('assign accepted paper to presentation slot, non-accepted paper is rejected, and duplicate assignment blocked', async () => {
  const agent = supertest(app);

  const sessions = (await agent.get(`/api/conferences/${conferenceId}/schedule`).set('Cookie', organizer.cookie)).body.data.sessions;
  const sessionId = sessions[0].id;

  // 1. Try to assign pending paper (status under_review -> 409)
  const rejectPending = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions/${sessionId}/slots`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      submissionId: pendingPaper.id,
      durationMinutes: 20,
    })
    .expect(409);
  assert.match(rejectPending.body.error.message, /Only accepted papers can be scheduled/);

  // 2. Assign accepted paper to slot
  const slotRes = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions/${sessionId}/slots`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      submissionId: acceptedPaper.id,
      presenterUserId: presenter.id,
      durationMinutes: 15,
      startsAt: '2026-11-10T09:15:00.000Z',
      endsAt: '2026-11-10T09:30:00.000Z',
    })
    .expect(201);

  assert.equal(slotRes.body.data.slot_number, 1);
  assert.equal(slotRes.body.data.duration_minutes, 15);
  assert.equal(slotRes.body.data.presentation_status, 'scheduled');

  // 3. Duplicate paper assignment to another slot is rejected
  const dupSlot = await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions/${sessionId}/slots`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({
      submissionId: acceptedPaper.id,
    })
    .expect(409);
  assert.match(dupSlot.body.error.message, /already scheduled/);
});

test('schedule publication visibility and authorized editing notifications', async () => {
  const agent = supertest(app);
  const sessionList = (await agent.get(`/api/conferences/${conferenceId}/schedule`).set('Cookie', organizer.cookie)).body.data.sessions;
  const sessionId = sessionList[0].id;

  // Public cannot see unpublished session
  const pubBefore = await agent.get(`/api/conferences/${conferenceId}/schedule`).expect(200);
  assert.equal(pubBefore.body.data.sessions.length, 0);

  // Publish session
  await agent
    .post(`/api/admin/conferences/${conferenceId}/sessions/${sessionId}/publish`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({ isPublished: true })
    .expect(200);

  // Public can now view published session
  const pubAfter = await agent.get(`/api/conferences/${conferenceId}/schedule`).expect(200);
  assert.equal(pubAfter.body.data.sessions.length, 1);
  assert.equal(pubAfter.body.data.sessions[0].presentation_slots.length, 1);
  assert.equal(pubAfter.body.data.sessions[0].presentation_slots[0].paperCode, 'BUP-2026-SEC01');

  // Edit session schedule and trigger notification
  await agent
    .patch(`/api/admin/conferences/${conferenceId}/sessions/${sessionId}`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({ room: 'Auditorium Hall B' })
    .expect(200);

  const notifications = (await pg.query(`select title, body from public.notifications where user_id = $1`, [presenter.id])).rows;
  assert.ok(notifications.some(n => n.title.includes('Session Schedule Updated')));
});

test('personalized schedule, attendance check-in, and rotating QR token validation', async () => {
  const agent = supertest(app);
  const sessionList = (await agent.get(`/api/conferences/${conferenceId}/schedule`)).body.data.sessions;
  const sessionId = sessionList[0].id;

  // 1. Presenter views personalized schedule
  const presSched = await agent.get('/api/schedule/my').set('Cookie', presenter.cookie).expect(200);
  assert.equal(presSched.body.data.myPresentations.length, 1);
  assert.equal(presSched.body.data.myPresentations[0].paper_code, 'BUP-2026-SEC01');

  // 2. Chair generates rotating secure check-in token
  const tokenRes = await agent
    .post(`/api/sessions/${sessionId}/check-in-token`)
    .set('Cookie', chair.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', chair.csrf)
    .send({})
    .expect(200);

  const rawToken = tokenRes.body.data.token;
  assert.ok(rawToken && rawToken.length >= 32);

  // Non-chair, non-manager cannot generate token (403)
  await agent
    .post(`/api/sessions/${sessionId}/check-in-token`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({})
    .expect(403);

  // 3. Attendee scans QR code and checks in with token
  const checkinRes = await agent
    .post(`/api/sessions/${sessionId}/check-in`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ token: rawToken })
    .expect(200);

  assert.equal(checkinRes.body.data.record.check_in_method, 'qr_code');
  assert.equal(checkinRes.body.data.record.attendance_role, 'participant');

  // Duplicate check-in is idempotent and doesn't fail
  await agent
    .post(`/api/sessions/${sessionId}/check-in`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ token: rawToken })
    .expect(200);
});

test('session chair dashboard, presentation status updates, and attendance certificate report', async () => {
  const agent = supertest(app);
  const sessionList = (await agent.get(`/api/conferences/${conferenceId}/schedule`)).body.data.sessions;
  const sessionId = sessionList[0].id;
  const slotId = sessionList[0].presentation_slots[0].id;

  // 1. Chair dashboard view
  const chairDash = await agent
    .get(`/api/chair/sessions/${sessionId}`)
    .set('Cookie', chair.cookie)
    .expect(200);

  assert.equal(chairDash.body.data.session.id, sessionId);
  assert.equal(chairDash.body.data.slots.length, 1);
  assert.equal(chairDash.body.data.attendance.length, 1); // Attendee is checked in

  // 2. Chair marks presentation as completed
  const statusRes = await agent
    .patch(`/api/chair/sessions/${sessionId}/slots/${slotId}/status`)
    .set('Cookie', chair.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', chair.csrf)
    .send({ status: 'completed', chairNotes: 'Excellent presentation and Q&A handling.' })
    .expect(200);

  assert.equal(statusRes.body.data.presentation_status, 'completed');
  assert.equal(statusRes.body.data.chair_notes, 'Excellent presentation and Q&A handling.');

  // Unauthorized user cannot update presentation status (403)
  await agent
    .patch(`/api/chair/sessions/${sessionId}/slots/${slotId}/status`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ status: 'cancelled' })
    .expect(403);

  // 3. Organizer attendance & certificate eligibility report
  const rep = await agent
    .get(`/api/admin/conferences/${conferenceId}/attendance-report`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(rep.body.data.totalConferenceSessions, 1);
  const attendeeRow = rep.body.data.attendees.find(a => a.user_id === attendee.id);
  assert.equal(attendeeRow.attended_sessions_count, 1);
  assert.equal(attendeeRow.attendancePercent, 100);
  assert.equal(attendeeRow.isCertificateEligible, true);
});
