import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.CSRF_SECRET = randomBytes(48).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';

const db = newDb();
db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: randomUUID, impure: true });
const { Pool } = db.adapters.createPg();
const pg = new Pool();

await pg.query(`
  create table public.users (
    id uuid primary key default gen_random_uuid(), email text not null unique, full_name text not null,
    institution text, job_title text, phone text, password_hash text, email_verified_at timestamptz, is_active boolean not null default true,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.roles (id uuid primary key default gen_random_uuid(), name text not null unique);
  create table public.user_roles (user_id uuid not null references public.users(id), role_id uuid not null references public.roles(id), primary key(user_id, role_id));
  create table public.conferences (
    id uuid primary key default gen_random_uuid(), title text not null, acronym text, description text, venue text,
    timezone text default 'Asia/Dhaka', status text not null default 'draft',
    start_date date, end_date date, submission_deadline timestamptz, conference_mode text default 'in_person',
    organizer_user_id uuid, created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.conference_memberships (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    user_id uuid references public.users(id), role_id uuid references public.roles(id), unique(conference_id, user_id, role_id)
  );
  create table public.conference_deadlines (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    deadline_type text, deadline_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
    unique(conference_id, deadline_type)
  );
  create table public.auth_sessions (
    token_hash text primary key, user_id uuid references public.users(id), csrf_token text not null,
    expires_at timestamptz not null, created_at timestamptz default now(), last_seen_at timestamptz default now()
  );
  create table public.audit_logs (
    id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
    entity_type text not null, entity_id uuid, details jsonb default '{}'::jsonb, ip_address text, created_at timestamptz default now()
  );
  create table public.submissions (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    paper_code text unique, title text not null, abstract text not null, status text not null default 'submitted',
    corresponding_author_id uuid not null references public.users(id), is_withdrawn boolean default false,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.certificates (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    user_id uuid not null references public.users(id), certificate_number text not null unique,
    certificate_type text not null, issued_at timestamptz not null default now(), is_revoked boolean not null default false,
    revocation_reason text, revoked_at timestamptz, revoked_by uuid, created_at timestamptz default now()
  );
`);

await pg.query("insert into public.roles (name) values ('super_admin'), ('conference_admin'), ('attendee'), ('author'), ('reviewer')");

const { configurePoolForTests } = await import('../src/db/pool.js');
configurePoolForTests(pg);
const { hashToken } = await import('../src/auth/crypto.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

let adminUser, attendeeUser;
let conferenceId;

async function createUser(role) {
  const email = `${role}-${randomUUID()}@bup.test`;
  const u = (await pg.query(
    'insert into public.users (email, full_name, email_verified_at) values ($1, $2, now()) returning id, email, full_name',
    [email, `Test ${role}`]
  )).rows[0];
  await pg.query('insert into public.user_roles (user_id, role_id) select $1, id from public.roles where name = $2', [u.id, role]);
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  await pg.query(
    'insert into public.auth_sessions (token_hash, user_id, csrf_token, expires_at) values ($1, $2, $3, now() + interval \'1 hour\')',
    [hashToken(token), u.id, csrf]
  );
  return { id: u.id, email: u.email, cookie: `bup_session=${token}; bup_csrf=${csrf}`, csrf };
}

before(async () => {
  adminUser = await createUser('super_admin');
  attendeeUser = await createUser('attendee');

  const confRes = await pg.query(
    'insert into public.conferences (title, acronym, status) values ($1, $2, $3) returning id',
    ['BUP CyberSec 2026', 'CYBER', 'published']
  );
  conferenceId = confRes.rows[0].id;
});

after(async () => {
  await pg.end();
});

test('unauthenticated request to protected endpoints is rejected with 401', async () => {
  const res = await supertest(app).get('/api/certificates/my');
  assert.equal(res.status, 401);

  const adminRes = await supertest(app).get('/api/admin/stats');
  assert.equal(adminRes.status, 401);
});

test('mutation without CSRF token is rejected with 403', async () => {
  const res = await supertest(app)
    .post(`/api/conferences/${conferenceId}/certificates/claim`)
    .set('Cookie', attendeeUser.cookie)
    .send({ certificate_type: 'attendee' });
  assert.equal(res.status, 403);
});

test('attendee attempting organizer administrative action is rejected with 403', async () => {
  const res = await supertest(app)
    .get(`/api/admin/conferences/${conferenceId}/analytics`)
    .set('Cookie', attendeeUser.cookie);
  assert.equal(res.status, 403);

  const issueRes = await supertest(app)
    .post(`/api/admin/conferences/${conferenceId}/certificates/issue`)
    .set('Cookie', attendeeUser.cookie)
    .set('X-CSRF-Token', attendeeUser.csrf)
    .send({ userId: attendeeUser.id, certificateType: 'attendee' });
  assert.equal(issueRes.status, 403);
});

test('invalid lifecycle transition jumps are strictly rejected by the server', async () => {
  // Conference starts in 'published' state
  // Trying to transition published to an invalid jump like 'draft' must fail with 409 Conflict
  const res = await supertest(app)
    .post(`/api/admin/conferences/${conferenceId}/lifecycle`)
    .set('Cookie', adminUser.cookie)
    .set('X-CSRF-Token', adminUser.csrf)
    .send({ status: 'draft' });
  assert.equal(res.status, 409);
});

test('public certificate verification with unknown number returns valid: false', async () => {
  const res = await supertest(app).get('/api/certificates/verify/BUP-CERT-FAKE-DOES-NOT-EXIST');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.valid, false);
});

test('malformed inputs are rejected with 400 validation error', async () => {
  const res = await supertest(app)
    .post('/api/admin/conferences')
    .set('Cookie', adminUser.cookie)
    .set('X-CSRF-Token', adminUser.csrf)
    .send({ title: '', startDate: 'invalid-date' });
  assert.equal(res.status, 400);
});
