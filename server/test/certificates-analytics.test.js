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
    id uuid primary key default gen_random_uuid(), title text not null, acronym text, timezone text default 'Asia/Dhaka',
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
    channel text default 'in_app', category text default 'general', email_delivery_status text default 'not_applicable',
    read_at timestamptz, metadata jsonb default '{}'::jsonb, created_at timestamptz default now()
  );
  create table public.notification_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    email_notifications boolean not null default true,
    submission_updates boolean not null default true,
    review_updates boolean not null default true,
    schedule_updates boolean not null default true,
    payment_updates boolean not null default true,
    certificate_updates boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.submissions (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    track_id uuid references public.tracks(id), submitted_by uuid references public.users(id),
    paper_code text, title text not null, abstract text, category text default 'regular_paper',
    status text default 'accepted', created_at timestamptz default now()
  );
  create table public.authors (
    id uuid primary key default gen_random_uuid(), submission_id uuid references public.submissions(id),
    user_id uuid references public.users(id), full_name text, email text, institution text, author_order smallint default 1
  );
  create table public.reviews (
    id uuid primary key default gen_random_uuid(), submission_id uuid not null references public.submissions(id),
    reviewer_id uuid not null references public.users(id), status text not null default 'submitted',
    score integer, review_round integer not null default 1, assigned_at timestamptz default now(),
    submitted_at timestamptz default now()
  );
  create table public.registrations (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    user_id uuid not null references public.users(id), reference_code text, category text default 'general_attendee',
    status text default 'confirmed', payment_status text default 'verified', created_at timestamptz default now()
  );
  create table public.payments (
    id uuid primary key default gen_random_uuid(), registration_id uuid not null references public.registrations(id),
    amount numeric(12,2) not null, currency text not null default 'BDT', status text not null default 'verified',
    payment_method text not null default 'bank_transfer', provider_reference text, created_at timestamptz default now()
  );
  create table public.sessions (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    track_id uuid references public.tracks(id), session_code text, title text not null, description text,
    venue text, room text, format text not null default 'in_person', session_type text not null default 'paper_session',
    starts_at timestamptz not null, ends_at timestamptz not null, session_chair_id uuid references public.users(id),
    is_published boolean not null default true, created_at timestamptz default now()
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
  create table public.certificates (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    user_id uuid not null references public.users(id), registration_id uuid references public.registrations(id),
    certificate_type text not null check (certificate_type in ('attendee','author','presenter','reviewer','organizer')),
    certificate_number text not null unique, file_url text, is_revoked boolean not null default false,
    revoked_at timestamptz, revocation_reason text, revoked_by uuid references public.users(id),
    metadata jsonb default '{}'::jsonb, issued_at timestamptz not null default now(), created_at timestamptz default now(),
    unique(conference_id, user_id, certificate_type)
  );
  create table public.certificate_templates (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    certificate_type text not null check (certificate_type in ('attendee','author','presenter','reviewer','organizer')),
    title text not null, subtitle text, body_text text not null, signatory_name text not null default 'General Chair',
    signatory_title text not null default 'BUP', is_active boolean not null default true,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique(conference_id, certificate_type)
  );
`);

await pg.query(`insert into public.roles(name) values ('super_admin'), ('conference_admin'), ('session_chair'), ('author'), ('attendee'), ('reviewer')`);

const { configurePoolForTests } = await import('../src/db/pool.js');
configurePoolForTests(pg);

const { createApp } = await import('../src/app.js');
const app = createApp();
const { hashToken } = await import('../src/auth/crypto.js');

async function createUser(email, fullName, roleNames = ['attendee']) {
  const { rows } = await pg.query(
    'insert into public.users(email, full_name, email_verified_at) values($1, $2, now()) returning id, email, full_name',
    [email, fullName]
  );
  const user = rows[0];
  for (const r of roleNames) {
    const roleRes = await pg.query('select id from public.roles where name = $1', [r]);
    if (roleRes.rows[0]) {
      await pg.query('insert into public.user_roles(user_id, role_id) values($1, $2)', [user.id, roleRes.rows[0].id]);
    }
  }
  const rawSession = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  await pg.query(
    'insert into public.auth_sessions(token_hash, user_id, csrf_token, expires_at) values($1, $2, $3, now() + interval \'2 hours\')',
    [hashToken(rawSession), user.id, csrf]
  );
  return { ...user, cookie: `bup_session=${rawSession}; bup_csrf=${csrf}`, csrf };
}

let superAdmin, organizer, presenterUser, attendeeUser, otherUser;
let conferenceId;

before(async () => {
  superAdmin = await createUser('superadmin@bup.edu.bd', 'Super Admin', ['super_admin']);
  organizer = await createUser('organizer@bup.edu.bd', 'Prof. Organizer', ['conference_admin']);
  presenterUser = await createUser('presenter@university.edu', 'Dr. Presenter', ['author']);
  attendeeUser = await createUser('attendee@university.edu', 'Ms. Attendee', ['attendee']);
  otherUser = await createUser('other@university.edu', 'Mr. Other', ['attendee']);

  const confRes = await pg.query(
    `insert into public.conferences(title, acronym, organizer_user_id, status, venue)
     values('BUP International Conference on AI & Computing', 'BUP-ICAC', $1, 'published', 'BUP Auditorium')
     returning id`,
    [organizer.id]
  );
  conferenceId = confRes.rows[0].id;

  const orgRole = (await pg.query('select id from public.roles where name = \'conference_admin\'')).rows[0].id;
  await pg.query('insert into public.conference_memberships(conference_id, user_id, role_id) values($1, $2, $3)', [conferenceId, organizer.id, orgRole]);

  // Create paper and slot for presenterUser
  const subRes = await pg.query(
    `insert into public.submissions(conference_id, submitted_by, paper_code, title, status)
     values($1, $2, 'BUP-2026-001', 'Deep Learning on Edge Devices', 'accepted')
     returning id`,
    [conferenceId, presenterUser.id]
  );
  const submissionId = subRes.rows[0].id;

  const sessionRes = await pg.query(
    `insert into public.sessions(conference_id, title, room, starts_at, ends_at)
     values($1, 'Keynote & AI Session', 'Hall A', '2026-11-10T10:00:00.000Z', '2026-11-10T12:00:00.000Z')
     returning id`,
    [conferenceId]
  );
  const sessionId = sessionRes.rows[0].id;

  await pg.query(
    `insert into public.session_submissions(session_id, submission_id, slot_number, duration_minutes, presenter_user_id, presentation_status)
     values($1, $2, 1, 20, $3, 'completed')`,
    [sessionId, submissionId, presenterUser.id]
  );

  // Registration & Attendance for attendeeUser
  const regRes = await pg.query(
    `insert into public.registrations(conference_id, user_id, reference_code, category, status, payment_status)
     values($1, $2, 'BUP-REG-2026-001', 'general_attendee', 'confirmed', 'verified')
     returning id`,
    [conferenceId, attendeeUser.id]
  );
  await pg.query(
    `insert into public.payments(registration_id, amount, currency, status, provider_reference)
     values($1, 1500.00, 'BDT', 'verified', 'BANK-TRX-12345')`,
    [regRes.rows[0].id]
  );
  await pg.query(
    `insert into public.attendance(session_id, user_id, check_in_method, attendance_role)
     values($1, $2, 'qr_code', 'participant')`,
    [sessionId, attendeeUser.id]
  );
});

test('certificate eligibility evaluation reflects real participant activity and rejects ineligible users', async () => {
  const agent = supertest(app);

  // 1. Check attendee eligibility (attendeeUser is registered and attended session -> eligible for attendee cert)
  const attendeeEligibility = await agent
    .get(`/api/conferences/${conferenceId}/certificates/eligibility`)
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  assert.equal(attendeeEligibility.body.data.attendee.eligible, true);
  assert.equal(attendeeEligibility.body.data.presenter.eligible, false);

  // 2. Check presenter eligibility (presenterUser completed paper presentation -> eligible for presenter & author certs)
  const presenterEligibility = await agent
    .get(`/api/conferences/${conferenceId}/certificates/eligibility`)
    .set('Cookie', presenterUser.cookie)
    .expect(200);

  assert.equal(presenterEligibility.body.data.presenter.eligible, true);
  assert.equal(presenterEligibility.body.data.author.eligible, true);

  // 3. Other user has no registration or activity -> ineligible
  const otherEligibility = await agent
    .get(`/api/conferences/${conferenceId}/certificates/eligibility`)
    .set('Cookie', otherUser.cookie)
    .expect(200);

  assert.equal(otherEligibility.body.data.attendee.eligible, false);
  assert.equal(otherEligibility.body.data.presenter.eligible, false);

  // 4. Ineligible user trying to claim certificate is rejected with 403
  const rejectClaim = await agent
    .post(`/api/conferences/${conferenceId}/certificates/claim`)
    .set('Cookie', otherUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', otherUser.csrf)
    .send({ certificateType: 'attendee' })
    .expect(403);

  assert.match(rejectClaim.body.error.message, /not eligible/);
});

test('eligible user claims certificate, prevents duplicate issuance, and notification is generated', async () => {
  const agent = supertest(app);

  // 1. Attendee claims attendee certificate
  const claimRes = await agent
    .post(`/api/conferences/${conferenceId}/certificates/claim`)
    .set('Cookie', attendeeUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .send({ certificateType: 'attendee' })
    .expect(201);

  assert.ok(claimRes.body.data.certificate_number.startsWith('BUP-CERT-'));
  assert.equal(claimRes.body.data.certificate_type, 'attendee');
  assert.equal(claimRes.body.data.is_revoked, false);
  const certId = claimRes.body.data.id;

  // 2. Duplicate claim for same certificate type is strictly rejected (409)
  const dupClaim = await agent
    .post(`/api/conferences/${conferenceId}/certificates/claim`)
    .set('Cookie', attendeeUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .send({ certificateType: 'attendee' })
    .expect(409);

  assert.match(dupClaim.body.error.message, /already have an issued attendee certificate/);

  // 3. In-app notification was created for attendee
  const notifRes = await agent
    .get('/api/notifications')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  assert.ok(notifRes.body.data.some((n) => n.title === 'Certificate Issued'));

  // 4. Attendee can see certificate in /api/certificates/my
  const myCerts = await agent
    .get('/api/certificates/my')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  assert.equal(myCerts.body.data.length, 1);
  assert.equal(myCerts.body.data[0].id, certId);
});

test('download certificate generates valid downloadable PDF binary with correct headers', async () => {
  const agent = supertest(app);

  const myCerts = await agent
    .get('/api/certificates/my')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  const certId = myCerts.body.data[0].id;

  const pdfRes = await agent
    .get(`/api/certificates/${certId}/download`)
    .expect(200);

  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.ok(pdfRes.headers['content-disposition'].includes('inline; filename="BUP-Certificate-'));
  // PDF file begins with %PDF-
  assert.equal(pdfRes.body.subarray(0, 4).toString(), '%PDF');
});

test('public certificate verification, authorized revocation with reason, and verification reflection', async () => {
  const agent = supertest(app);

  const myCerts = await agent
    .get('/api/certificates/my')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  const cert = myCerts.body.data[0];
  const certNumber = cert.certificate_number;

  // 1. Public verification check of valid certificate
  const verifyRes = await agent
    .get(`/api/certificates/verify/${encodeURIComponent(certNumber)}`)
    .expect(200);

  assert.equal(verifyRes.body.data.valid, true);
  assert.equal(verifyRes.body.data.status, 'valid');
  assert.equal(verifyRes.body.data.full_name, attendeeUser.full_name);
  assert.equal(verifyRes.body.data.certificate_type, 'attendee');

  // 2. Unauthorized user cannot revoke certificate (403)
  await agent
    .post(`/api/admin/conferences/${conferenceId}/certificates/${cert.id}/revoke`)
    .set('Cookie', attendeeUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .send({ reason: 'Unauthorized revocation attempt' })
    .expect(403);

  // 3. Authorized conference organizer revokes certificate with reason
  const revokeRes = await agent
    .post(`/api/admin/conferences/${conferenceId}/certificates/${cert.id}/revoke`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({ reason: 'Attendance record falsification discovered' })
    .expect(200);

  assert.equal(revokeRes.body.data.certificate.is_revoked, true);
  assert.equal(revokeRes.body.data.certificate.revocation_reason, 'Attendance record falsification discovered');

  // 4. Public verification now honestly reports revoked status and reason
  const verifyRevoked = await agent
    .get(`/api/certificates/verify/${encodeURIComponent(certNumber)}`)
    .expect(200);

  assert.equal(verifyRevoked.body.data.valid, false);
  assert.equal(verifyRevoked.body.data.status, 'revoked');
  assert.equal(verifyRevoked.body.data.revocation_reason, 'Attendance record falsification discovered');

  // 5. Audit log recorded revocation
  const auditLogs = await pg.query('select * from public.audit_logs where action = \'certificate.revoked\'');
  assert.ok(auditLogs.rows.length >= 1);
});

test('notification preferences, read/unread states, and mark-all-read operations', async () => {
  const agent = supertest(app);

  // 1. Get default preferences
  const prefsRes = await agent
    .get('/api/notifications/preferences')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  assert.equal(prefsRes.body.data.emailNotifications, true);
  assert.equal(prefsRes.body.data.submissionUpdates, true);

  // 2. Update preferences
  const updatePrefs = await agent
    .patch('/api/notifications/preferences')
    .set('Cookie', attendeeUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .send({ emailNotifications: false, paymentUpdates: false })
    .expect(200);

  assert.equal(updatePrefs.body.data.emailNotifications, false);
  assert.equal(updatePrefs.body.data.paymentUpdates, false);

  // 3. Mark all notifications read
  const markAll = await agent
    .post('/api/notifications/mark-all-read')
    .set('Cookie', attendeeUser.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .expect(200);

  assert.ok(markAll.body.data.updatedCount >= 1);

  // 4. Unread count is now 0
  const afterList = await agent
    .get('/api/notifications?unreadOnly=true')
    .set('Cookie', attendeeUser.cookie)
    .expect(200);

  assert.equal(afterList.body.unreadCount, 0);
  assert.equal(afterList.body.data.length, 0);
});

test('conference analytics, exports (CSV and PDF summary), and scope protection', async () => {
  const agent = supertest(app);

  // 1. Unauthorized attendee cannot view conference analytics (403)
  await agent
    .get(`/api/admin/conferences/${conferenceId}/analytics`)
    .set('Cookie', attendeeUser.cookie)
    .expect(403);

  // 2. Authorized conference organizer gets live PostgreSQL metrics
  const analyticsRes = await agent
    .get(`/api/admin/conferences/${conferenceId}/analytics`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  const a = analyticsRes.body.data;
  assert.equal(a.conference.title, 'BUP International Conference on AI & Computing');
  assert.equal(a.papers.total, 1);
  assert.equal(a.papers.accepted, 1);
  assert.equal(a.registrations.total, 1);
  assert.equal(a.financials.verifiedAmount, 1500);
  assert.equal(a.attendance.totalSessions, 1);
  assert.equal(a.attendance.totalCheckIns, 1);
  assert.equal(a.certificates.totalIssued, 1);
  assert.equal(a.certificates.revoked, 1);

  // 3. Export Registrations CSV
  const regCsv = await agent
    .get(`/api/admin/conferences/${conferenceId}/reports/registrations/csv`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(regCsv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(regCsv.text.includes('Reference Code,Full Name,Email'));
  assert.ok(regCsv.text.includes('BUP-REG-2026-001'));
  assert.ok(regCsv.text.includes('BANK-TRX-12345'));

  // 4. Export Submissions CSV
  const subCsv = await agent
    .get(`/api/admin/conferences/${conferenceId}/reports/submissions/csv`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(subCsv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(subCsv.text.includes('Paper Code,Title,Track'));
  assert.ok(subCsv.text.includes('BUP-2026-001'));
  assert.ok(subCsv.text.includes('Deep Learning on Edge Devices'));

  // 5. Export Attendance CSV
  const attCsv = await agent
    .get(`/api/admin/conferences/${conferenceId}/reports/attendance/csv`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(attCsv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(attCsv.text.includes('Reference Code,Full Name,Email'));
  assert.ok(attCsv.text.includes('Attended Sessions'));

  // 6. Export Executive Summary PDF
  const summaryPdf = await agent
    .get(`/api/admin/conferences/${conferenceId}/reports/summary/pdf`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(summaryPdf.headers['content-type'], 'application/pdf');
  assert.equal(summaryPdf.body.subarray(0, 4).toString(), '%PDF');

  // 7. Super Admin Global Analytics
  const globalAnalytics = await agent
    .get('/api/admin/analytics/global')
    .set('Cookie', superAdmin.cookie)
    .expect(200);

  assert.ok(globalAnalytics.body.data.conferences.total >= 1);
  assert.ok(globalAnalytics.body.data.users.total >= 5);
  assert.equal(globalAnalytics.body.data.financials.totalVerifiedRevenue, 1500);

  // Non-superadmin cannot access global analytics (403)
  await agent
    .get('/api/admin/analytics/global')
    .set('Cookie', organizer.cookie)
    .expect(403);
});
