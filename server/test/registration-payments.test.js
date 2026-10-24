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
    institution text, job_title text, phone text, password_hash text, email_verified_at timestamptz, is_active boolean not null default true,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.roles (id uuid primary key default gen_random_uuid(), name text not null unique);
  create table public.user_roles (user_id uuid not null references public.users(id), role_id uuid not null references public.roles(id), primary key(user_id, role_id));
  create table public.conferences (
    id uuid primary key default gen_random_uuid(), title text not null, status text not null default 'published',
    max_capacity integer, organizer_user_id uuid, start_date date, end_date date, venue text,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.conference_deadlines (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    deadline_type text, deadline_at timestamptz
  );
  create table public.conference_memberships (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    user_id uuid references public.users(id), role_id uuid references public.roles(id), unique(conference_id, user_id, role_id)
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
  create table public.conference_registration_tiers (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    category text not null, title text not null, description text, amount numeric(12,2) not null,
    currency char(3) not null default 'BDT', eligibility_criteria text, deadline_at timestamptz,
    capacity integer, is_active boolean not null default true, created_at timestamptz default now(),
    updated_at timestamptz default now(), unique(conference_id, category)
  );
  create table public.submissions (
    id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id),
    submitted_by uuid references public.users(id), title text not null, status text default 'accepted'
  );
  create table public.authors (
    id uuid primary key default gen_random_uuid(), submission_id uuid references public.submissions(id),
    user_id uuid references public.users(id), full_name text, email text
  );
  create table public.registrations (
    id uuid primary key default gen_random_uuid(), conference_id uuid not null references public.conferences(id),
    user_id uuid not null references public.users(id), tier_id uuid references public.conference_registration_tiers(id),
    reference_code text unique, category text not null default 'general_attendee', status text not null default 'pending',
    payment_status text not null default 'unpaid', paper_id uuid references public.submissions(id),
    organization text, dietary_requirements text, special_needs text, cancellation_reason text,
    cancellation_requested_at timestamptz, cancelled_at timestamptz, registered_at timestamptz not null default now(),
    created_at timestamptz default now(), updated_at timestamptz default now(), unique(conference_id, user_id)
  );
  create table public.payments (
    id uuid primary key default gen_random_uuid(), registration_id uuid not null references public.registrations(id),
    amount numeric(12,2) not null, currency char(3) not null default 'BDT', payment_method text not null default 'bank_transfer',
    transaction_reference text, receipt_object_key text, receipt_filename text, receipt_file_size integer,
    status text not null default 'pending', paid_at timestamptz, verified_at timestamptz, verified_by uuid references public.users(id),
    verification_notes text, rejection_reason text, created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.registration_refunds (
    id uuid primary key default gen_random_uuid(), registration_id uuid not null references public.registrations(id),
    payment_id uuid not null references public.payments(id), amount numeric(12,2) not null,
    currency char(3) not null default 'BDT', reason text not null, status text not null default 'requested',
    requested_by uuid not null references public.users(id), requested_at timestamptz not null default now(),
    processed_by uuid references public.users(id), processed_at timestamptz, processor_reference text, admin_notes text
  );
`);

await pg.query(`insert into public.roles(name) values ('super_admin'), ('conference_admin'), ('attendee'), ('author')`);

const { configurePoolForTests } = await import('../src/db/pool.js');
configurePoolForTests(pg);
const { hashPassword, hashToken } = await import('../src/auth/crypto.js');
const { createApp } = await import('../src/app.js');
const app = createApp();

let organizer, attendee, attendeeTwo, outsider, conferenceId, authorPaperId;

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
  if (confId && role === 'conference_admin') {
    await pg.query(
      `insert into public.conference_memberships(conference_id, user_id, role_id)
       select $1, $2, id from public.roles where name = 'conference_admin'`,
      [confId, user.id]
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
  const conf = (await pg.query(`insert into public.conferences(title, status, max_capacity) values('BUP International Research Conference', 'published', 2) returning id`)).rows[0];
  conferenceId = conf.id;

  organizer = await createUser('organizer-reg@bup.edu.bd', 'conference_admin', conferenceId);
  attendee = await createUser('student-attendee@bup.edu.bd', 'attendee');
  attendeeTwo = await createUser('pro-attendee@company.test', 'attendee');
  outsider = await createUser('outsider@other.test', 'attendee');

  const paper = (await pg.query(
    `insert into public.submissions(conference_id, submitted_by, title, status)
     values($1, $2, 'Advanced Machine Learning in Defense', 'accepted') returning id`,
    [conferenceId, attendee.id]
  )).rows[0];
  authorPaperId = paper.id;
  await pg.query(`insert into public.authors(submission_id, user_id, full_name, email) values($1, $2, 'Student Author', $3)`, [paper.id, attendee.id, attendee.email]);

  // Seed registration tiers
  await pg.query(`
    insert into public.conference_registration_tiers(conference_id, category, title, description, amount, currency, capacity) values
    ('${conferenceId}', 'student', 'Student Registration', 'Student rate', 2000.00, 'BDT', 5),
    ('${conferenceId}', 'author', 'Author Registration', 'Author fee', 5000.00, 'BDT', 5),
    ('${conferenceId}', 'professional', 'Professional Registration', 'Industry rate', 6000.00, 'BDT', 1),
    ('${conferenceId}', 'general_attendee', 'General Attendee', 'General rate', 3000.00, 'BDT', 5);
  `);
});

after(async () => {
  await pg.end();
});

test('public can query conference registration tiers and availability', async () => {
  const res = await supertest(app).get(`/api/conferences/${conferenceId}/registration-tiers`).expect(200);
  assert.equal(res.body.data.conferenceTitle, 'BUP International Research Conference');
  assert.equal(res.body.data.maxCapacity, 2);
  assert.equal(res.body.data.totalRegistered, 0);
  assert.equal(res.body.data.isFull, false);
  assert.equal(res.body.data.tiers.length, 4);
  const studentTier = res.body.data.tiers.find(t => t.category === 'student');
  assert.equal(studentTier.amount, 2000);
  assert.equal(studentTier.currency, 'BDT');
});

test('attendee registers, receives unique reference, and payment row is initialized with server validated fee', async () => {
  const agent = supertest(app);
  const regRes = await agent
    .post(`/api/conferences/${conferenceId}/registrations`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ category: 'student', organization: 'BUP Faculty of Science', dietaryRequirements: 'Vegetarian' })
    .expect(201);

  assert.ok(regRes.body.data.referenceCode.startsWith('BUP-REG-'));
  assert.equal(regRes.body.data.category, 'student');
  assert.equal(regRes.body.data.status, 'pending');
  assert.equal(regRes.body.data.payment_status, 'unpaid');
  assert.equal(regRes.body.data.amount, 2000);
  assert.equal(regRes.body.data.currency, 'BDT');

  const myRegs = await agent.get('/api/registrations/my').set('Cookie', attendee.cookie).expect(200);
  assert.equal(myRegs.body.data.length, 1);
  assert.equal(myRegs.body.data[0].reference_code, regRes.body.data.referenceCode);
  assert.equal(myRegs.body.data[0].tier_amount, 2000);
});

test('duplicate registration for same conference is strictly rejected', async () => {
  const agent = supertest(app);
  const dupRes = await agent
    .post(`/api/conferences/${conferenceId}/registrations`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ category: 'student' })
    .expect(409);

  assert.match(dupRes.body.error.message, /already registered/);
});

test('capacity limit prevents excess registrations', async () => {
  const agent = supertest(app);
  // Attendee two registers (reaching max_capacity = 2)
  await agent
    .post(`/api/conferences/${conferenceId}/registrations`)
    .set('Cookie', attendeeTwo.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendeeTwo.csrf)
    .send({ category: 'professional', organization: 'Tech Corp' })
    .expect(201);

  // Third user attempts to register (capacity full -> 409)
  const fullRes = await agent
    .post(`/api/conferences/${conferenceId}/registrations`)
    .set('Cookie', outsider.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', outsider.csrf)
    .send({ category: 'general_attendee' })
    .expect(409);

  assert.match(fullRes.body.error.message, /maximum registration capacity/);
});

test('receipt upload to private storage updates payment status and enforces role-based access', async () => {
  const agent = supertest(app);
  const myReg = (await agent.get('/api/registrations/my').set('Cookie', attendee.cookie)).body.data[0];

  const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  const boundary = '----FormBoundaryReceipt';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="paymentMethod"\r\n\r\nmobile_banking\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="transactionReference"\r\n\r\nBKASH-TRX-998877\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="receipt"; filename="bkash-slip.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    fakePdf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  global.fetch = async (url) => {
    if (String(url).includes('/sign/')) {
      return new Response(JSON.stringify({ signedURL: 'https://supabase.test/storage/v1/object/sign/receipts/slip.pdf?token=abc' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'ok' }), { status: 200 });
  };

  try {
    const uploadRes = await agent
      .post(`/api/registrations/${myReg.id}/receipt`)
      .set('Cookie', attendee.cookie)
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('X-CSRF-Token', attendee.csrf)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body)
      .expect(200);

    assert.equal(uploadRes.body.data.payment.status, 'submitted');
    assert.equal(uploadRes.body.data.payment.transaction_reference, 'BKASH-TRX-998877');

    // Registrant can get signed receipt link
    const linkRes = await agent
      .post(`/api/registrations/${myReg.id}/receipt-link`)
      .set('Cookie', attendee.cookie)
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('X-CSRF-Token', attendee.csrf)
      .send({})
      .expect(200);
    assert.match(linkRes.body.data.url, /token=abc/);

    // Outsider cannot access private receipt (403)
    await agent
      .post(`/api/registrations/${myReg.id}/receipt-link`)
      .set('Cookie', outsider.cookie)
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('X-CSRF-Token', outsider.csrf)
      .send({})
      .expect(403);
  } finally {
    global.fetch = origFetch;
  }
});

test('admin verification queue, receipt approval, financial report and reconciliation', async () => {
  const agent = supertest(app);

  // Organizer views verification queue
  const queueRes = await agent
    .get(`/api/admin/conferences/${conferenceId}/payments/verification-queue`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  assert.equal(queueRes.body.data.length, 1);
  const paymentItem = queueRes.body.data[0];
  assert.equal(paymentItem.transaction_reference, 'BKASH-TRX-998877');
  assert.equal(paymentItem.amount, 2000);

  // Non-organizer cannot verify (403)
  await agent
    .post(`/api/admin/conferences/${conferenceId}/payments/${paymentItem.id}/verify`)
    .set('Cookie', outsider.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', outsider.csrf)
    .send({ action: 'approve' })
    .expect(403);

  // Organizer approves payment
  const verifyRes = await agent
    .post(`/api/admin/conferences/${conferenceId}/payments/${paymentItem.id}/verify`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({ action: 'approve', notes: 'Bank statement matched.' })
    .expect(200);

  assert.equal(verifyRes.body.data.status, 'verified');

  // Verify registration is now confirmed
  const myRegs = await agent.get('/api/registrations/my').set('Cookie', attendee.cookie).expect(200);
  assert.equal(myRegs.body.data[0].status, 'confirmed');
  assert.equal(myRegs.body.data[0].payment_status, 'verified');

  // Financial report
  const finRes = await agent
    .get(`/api/admin/conferences/${conferenceId}/financial-report`)
    .set('Cookie', organizer.cookie)
    .expect(200);

  const bdtRevenue = finRes.body.data.revenueByCurrency.find(c => c.currency.trim() === 'BDT');
  assert.equal(bdtRevenue.verified_total, 2000);
  assert.equal(bdtRevenue.verified_count, 1);
  assert.equal(finRes.body.data.conference.activeRegistrations, 2);
  assert.equal(finRes.body.data.conference.remainingCapacity, 0);
});

test('rejection flow records reason and allows attendee re-upload', async () => {
  const agent = supertest(app);
  const myRegTwo = (await agent.get('/api/registrations/my').set('Cookie', attendeeTwo.cookie)).body.data[0];

  // Upload receipt for attendeeTwo
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const boundary = '----FormBoundaryJpg';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="paymentMethod"\r\n\r\nbank_transfer\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="transactionReference"\r\n\r\nSLIP-5544\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="receipt"; filename="slip.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    fakeJpg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const origFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ message: 'ok' }), { status: 200 });

  try {
    await agent
      .post(`/api/registrations/${myRegTwo.id}/receipt`)
      .set('Cookie', attendeeTwo.cookie)
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('X-CSRF-Token', attendeeTwo.csrf)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body)
      .expect(200);

    const paymentId = (await pg.query(`select id from public.payments where registration_id = $1`, [myRegTwo.id])).rows[0].id;

    // Organizer rejects receipt
    const rejectRes = await agent
      .post(`/api/admin/conferences/${conferenceId}/payments/${paymentId}/verify`)
      .set('Cookie', organizer.cookie)
      .set('Origin', process.env.CLIENT_ORIGIN)
      .set('X-CSRF-Token', organizer.csrf)
      .send({ action: 'reject', rejectionReason: 'Deposit slip transaction reference not found on bank statement.' })
      .expect(200);

    assert.equal(rejectRes.body.data.status, 'rejected');

    // Registration payment_status is rejected
    const checkReg = (await agent.get('/api/registrations/my').set('Cookie', attendeeTwo.cookie)).body.data[0];
    assert.equal(checkReg.payment_status, 'rejected');
    assert.match(checkReg.rejection_reason, /not found on bank statement/);
  } finally {
    global.fetch = origFetch;
  }
});

test('refund workflow: attendee requests refund, admin processes with bank reference', async () => {
  const agent = supertest(app);
  const myReg = (await agent.get('/api/registrations/my').set('Cookie', attendee.cookie)).body.data[0];

  // Attendee requests refund
  const refundReq = await agent
    .post(`/api/registrations/${myReg.id}/refund-request`)
    .set('Cookie', attendee.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', attendee.csrf)
    .send({ reason: 'Unable to travel due to academic scheduling conflict.' })
    .expect(201);

  assert.equal(refundReq.body.data.status, 'requested');
  assert.equal(refundReq.body.data.amount, 2000);

  // Organizer views refund list
  const refundsList = await agent
    .get(`/api/admin/conferences/${conferenceId}/refunds`)
    .set('Cookie', organizer.cookie)
    .expect(200);
  assert.equal(refundsList.body.data.length, 1);
  const refItem = refundsList.body.data[0];

  // Organizer processes refund with offline bank processor reference
  const processRes = await agent
    .post(`/api/admin/conferences/${conferenceId}/refunds/${refItem.id}/process`)
    .set('Cookie', organizer.cookie)
    .set('Origin', process.env.CLIENT_ORIGIN)
    .set('X-CSRF-Token', organizer.csrf)
    .send({ action: 'approve', processorReference: 'BANK-REFUND-TX-778899', adminNotes: 'Processed via BUP corporate bank portal.' })
    .expect(200);

  assert.equal(processRes.body.data.status, 'processed');
  assert.equal(processRes.body.data.processor_reference, 'BANK-REFUND-TX-778899');

  // Verify registration and payment status are refunded
  const myRegUpdated = (await agent.get('/api/registrations/my').set('Cookie', attendee.cookie)).body.data[0];
  assert.equal(myRegUpdated.status, 'refunded');
  assert.equal(myRegUpdated.payment_status, 'refunded');
});
