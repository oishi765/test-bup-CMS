import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.CSRF_SECRET = randomBytes(48).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.TRUST_PROXY_HOPS = '1';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
delete process.env.SMTP_HOST;

const memory = newDb();
memory.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: randomUUID, impure: true });
const { Pool } = memory.adapters.createPg();
const testPool = new Pool();
await testPool.query(`
  create table public.users (
    id uuid primary key default gen_random_uuid(), email text not null unique, full_name text not null,
    institution text, job_title text, phone text, password_hash text, email_verified_at timestamptz,
    is_active boolean not null default true, profile_updated_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table public.roles (id uuid primary key default gen_random_uuid(), name text not null unique, description text);
  create table public.user_roles (user_id uuid not null references public.users(id), role_id uuid not null references public.roles(id), assigned_at timestamptz default now(), primary key(user_id, role_id));
  create table public.conferences (id uuid primary key default gen_random_uuid(), title text not null, status text not null default 'draft', organizer_user_id uuid, submission_deadline timestamptz, review_mode text default 'single_blind', created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.conference_deadlines(id uuid primary key default gen_random_uuid(),conference_id uuid,deadline_type text,deadline_at timestamptz);
  create table public.conference_memberships (id uuid primary key default gen_random_uuid(), conference_id uuid references public.conferences(id), user_id uuid references public.users(id), role_id uuid references public.roles(id), assigned_by uuid references public.users(id), created_at timestamptz default now(), unique(conference_id,user_id,role_id));
  create table public.auth_sessions (token_hash text primary key, user_id uuid references public.users(id), csrf_token text not null, expires_at timestamptz not null, created_at timestamptz default now(), last_seen_at timestamptz default now(), user_agent text, ip_address text);
  create table public.password_reset_tokens (token_hash text primary key, user_id uuid references public.users(id), expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz default now());
  create table public.email_verification_tokens (token_hash text primary key, user_id uuid references public.users(id), expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz default now());
  create table public.audit_logs (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null, entity_type text not null, entity_id uuid, details jsonb default '{}'::jsonb, ip_address text, created_at timestamptz default now());
  create table public.tracks (id uuid primary key default gen_random_uuid(), conference_id uuid, name text, is_active boolean default true);
  create table public.submissions (id uuid primary key default gen_random_uuid(), conference_id uuid, track_id uuid, submitted_by uuid, title text not null, abstract text not null, keywords text[] default '{}', paper_url text, submission_type text default 'paper', category text default 'full_paper', paper_code text, decision_note text, withdrawal_requested_at timestamptz, status text default 'draft', submitted_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.authors (id uuid primary key default gen_random_uuid(), submission_id uuid, user_id uuid, full_name text, email text, institution text, author_order smallint, is_corresponding boolean, created_at timestamptz default now());
  create table public.submission_versions (id uuid primary key default gen_random_uuid(),submission_id uuid,version_number integer,version_type text,object_key text,original_filename text,file_size bigint,sha256 text,uploaded_by uuid,created_at timestamptz default now());
  create table public.author_profiles (user_id uuid primary key,corresponding_name text,corresponding_email text,corresponding_affiliation text,updated_at timestamptz default now());
  create table public.reviews (id uuid primary key default gen_random_uuid(), submission_id uuid, reviewer_id uuid, status text, due_at timestamptz, review_round integer default 1, assigned_at timestamptz default now(), submitted_at timestamptz, criterion_scores jsonb default '{}'::jsonb, overall_recommendation text, recommendation text, score numeric, comments_to_authors text, confidential_comments text, updated_at timestamptz default now());
  create table public.reviewer_profiles(user_id uuid primary key,expertise text[] default '{}',availability text default 'available',biography text,updated_at timestamptz default now());
  create table public.conference_review_criteria(id uuid primary key default gen_random_uuid(),conference_id uuid,criterion_key text,label text,max_score smallint,sort_order smallint,is_active boolean default true,unique(conference_id,criterion_key));
  create table public.review_conflicts(review_id uuid primary key,declared_by uuid,reason text,created_at timestamptz default now(),resolved_at timestamptz,resolved_by uuid,resolution text);
  create table public.submission_decisions(id uuid primary key default gen_random_uuid(),submission_id uuid,review_round integer,status text,author_note text,editor_note text,decided_by uuid,created_at timestamptz default now());
  create table public.sessions (id uuid primary key default gen_random_uuid(), conference_id uuid, title text, starts_at timestamptz, ends_at timestamptz);
  create table public.session_submissions (session_id uuid, submission_id uuid);
  create table public.registrations (id uuid primary key default gen_random_uuid(), conference_id uuid, user_id uuid, status text);
  create table public.conference_people (id uuid primary key default gen_random_uuid(), conference_id uuid, person_type text, full_name text, title text, institution text, bio text, is_public boolean default true);
  create table public.notifications(id uuid primary key default gen_random_uuid(),user_id uuid,conference_id uuid,title text,body text,channel text default 'in_app',read_at timestamptz,created_at timestamptz default now());
`);
await testPool.query(`insert into public.roles(name) values ('super_admin'), ('conference_admin'), ('author'), ('reviewer'), ('attendee'), ('session_chair')`);
const { configurePoolForTests } = await import('../src/db/pool.js');
configurePoolForTests(testPool);
const { createApp } = await import('../src/app.js');
const app = createApp();
const client = supertest.agent(app);
const ORIGIN = process.env.CLIENT_ORIGIN;
let testIp = 1;
let attendeeId;
let conferenceAdminId;
let superAdminId;
let changeUser;
let conferenceOne;
let conferenceTwo;
let ownerSubmission;
let workflowTrack;

async function csrf(agent = client) {
  const response = await agent.get('/api/auth/csrf').expect(200);
  return response.body.data.csrfToken;
}
function mutate(agent, method, path, body) {
  const promise = csrf(agent).then((token) => agent[method](path).set('Origin', ORIGIN).set('X-Forwarded-For', `198.51.100.${testIp++}`).set('X-CSRF-Token', token).send(body));
  promise.expect = (status) => promise.then((response) => { assert.equal(response.status, status, response.text); return response; });
  return promise;
}
async function addUser({ email, role, conferenceId = null, password = 'StrongPassword123!' }) {
  const { hashPassword } = await import('../src/auth/crypto.js');
  const hash = await hashPassword(password);
  const { rows } = await testPool.query(`insert into public.users(email, full_name, password_hash, email_verified_at) values($1,$2,$3,now()) returning id`, [email, email.split('@')[0], hash]);
  const userId = rows[0].id;
  if (role === 'attendee' || role === 'super_admin') await testPool.query('insert into public.user_roles(user_id,role_id) select $1,id from public.roles where name=$2', [userId, role]);
  if (conferenceId && role) await testPool.query('insert into public.conference_memberships(conference_id,user_id,role_id) select $1,$2,id from public.roles where name=$3', [conferenceId, userId, role]);
  return { id: userId, email, password };
}
async function signIn(agent, email, password) {
  return mutate(agent, 'post', '/api/auth/login', { email, password }).expect(200);
}

before(async () => {
  const confA = await testPool.query("insert into public.conferences(title,status) values('Conference A','published') returning id");
  const confB = await testPool.query("insert into public.conferences(title,status) values('Conference B','published') returning id");
  conferenceOne = confA.rows[0].id;
  conferenceTwo = confB.rows[0].id;
  const testTrack=await testPool.query("insert into public.tracks(conference_id,name,is_active) values($1,'Research Systems',true) returning id",[conferenceOne]);
  workflowTrack=testTrack.rows[0].id;
  const attendee = await addUser({ email: 'attendee@example.test', role: 'attendee' });
  attendeeId = attendee.id;
  const conferenceAdmin = await addUser({ email: 'organizer@example.test', role: 'conference_admin', conferenceId: conferenceOne });
  conferenceAdminId = conferenceAdmin.id;
  const superAdmin = await addUser({ email: 'platform@example.test', role: 'super_admin' });
  superAdminId = superAdmin.id;
  changeUser = await addUser({ email: 'change@example.test', role: 'attendee' });
  const owner = await addUser({ email: 'author@example.test', role: 'attendee' });
  const other = await addUser({ email: 'other@example.test', role: 'attendee' });
  const owned = await testPool.query("insert into public.submissions(conference_id,submitted_by,title,abstract,status) values($1,$2,'My draft title','This abstract has sufficient length for a draft submission.','draft') returning id", [conferenceOne, owner.id]);
  ownerSubmission = owned.rows[0].id;
  await testPool.query("insert into public.submissions(conference_id,submitted_by,title,abstract,status) values($1,$2,'Other draft title','This abstract has sufficient length for a draft submission.','draft')", [conferenceOne, other.id]);
});

after(async () => { await testPool.end(); });

test('unauthenticated requests are denied and CSRF is required on mutations', async () => {
  await client.get('/api/auth/dashboard').expect(401);
  await client.post('/api/auth/login').set('Origin', ORIGIN).send({ email: 'attendee@example.test', password: 'StrongPassword123!' }).expect(403);
});

test('login attempts from one client IP are rate limited', async () => {
  const agent = supertest.agent(app);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = await csrf(agent);
    const response = await agent.post('/api/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', '198.51.100.250').set('X-CSRF-Token', token)
      .send({ email: 'attendee@example.test', password: 'NotTheRightPassword123!' });
    assert.equal(response.status, 401);
  }
  const token = await csrf(agent);
  const limited = await agent.post('/api/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', '198.51.100.250').set('X-CSRF-Token', token)
    .send({ email: 'attendee@example.test', password: 'NotTheRightPassword123!' });
  assert.equal(limited.status, 429);
});

test('registration hashes the password, assigns only Attendee, issues a secure session, and rejects role injection', async () => {
  const injected = await mutate(client, 'post', '/api/auth/register', { fullName: 'Attempted Admin', email: 'attacker@example.test', password: 'StrongPassword123!', role: 'super_admin' });
  assert.equal(injected.status, 400);
  const registered = await mutate(client, 'post', '/api/auth/register', { fullName: 'New Attendee', email: 'new@example.test', password: 'NewPassword123!', institution: 'BUP' }).expect(201);
  assert.deepEqual(registered.body.data.user.roles, ['attendee']);
  assert.equal(registered.body.data.authenticated, true);
  assert.match(registered.headers['set-cookie'].join(';'), /bup_session=.*HttpOnly.*SameSite=Lax/);
  const stored = await testPool.query('select password_hash from public.users where email=$1', ['new@example.test']);
  assert.match(stored.rows[0].password_hash, /^scrypt\$/);
  assert.notEqual(stored.rows[0].password_hash, 'NewPassword123!');
  const session = await client.get('/api/auth/session').expect(200);
  assert.equal(session.body.data.user.email, 'new@example.test');
});

test('login, profile editing, and logout maintain a server-side session', async () => {
  const agent = supertest.agent(app);
  await signIn(agent, 'attendee@example.test', 'StrongPassword123!');
  await mutate(agent, 'patch', '/api/auth/profile', { fullName: 'Updated Attendee', institution: 'BUP', jobTitle: 'Student', phone: '+8801000' }).expect(200);
  const profile = await agent.get('/api/auth/session').expect(200);
  assert.equal(profile.body.data.user.fullName, 'Updated Attendee');
  await mutate(agent, 'post', '/api/auth/logout', {}).expect(200);
  const ended = await agent.get('/api/auth/session').expect(200);
  assert.equal(ended.body.data.user, null);
});

test('password change verifies the current password, rotates the session, and invalidates the prior session', async () => {
  const agent = supertest.agent(app);
  const signedIn = await signIn(agent, changeUser.email, changeUser.password);
  const oldCookie = signedIn.headers['set-cookie'].find((cookie) => cookie.startsWith('bup_session=')).split(';')[0];
  const staleAgent = supertest.agent(app);
  await staleAgent.get('/api/auth/session').set('Cookie', oldCookie).expect(200).expect((response) => assert.equal(response.body.data.user.email, changeUser.email));
  await mutate(agent, 'post', '/api/auth/change-password', { currentPassword: changeUser.password, newPassword: 'DifferentPassword456!' }).expect(200);
  const active = await agent.get('/api/auth/session').expect(200);
  assert.equal(active.body.data.user.email, changeUser.email);
  const stale = await staleAgent.get('/api/auth/session').expect(200);
  assert.equal(stale.body.data.user, null);
  const oldLogin = await mutate(supertest.agent(app), 'post', '/api/auth/login', { email: changeUser.email, password: changeUser.password });
  assert.equal(oldLogin.status, 401);
  await signIn(supertest.agent(app), changeUser.email, 'DifferentPassword456!');
});

test('server role checks reject attendee escalation and scope Conference Admin to assigned conference', async () => {
  const attendee = supertest.agent(app);
  await signIn(attendee, 'attendee@example.test', 'StrongPassword123!');
  await attendee.get('/api/auth/admin/users').expect(403);
  const forbidden = await mutate(attendee, 'post', `/api/conferences/${conferenceOne}/members`, { userId: attendeeId, role: 'conference_admin' });
  assert.equal(forbidden.status, 403);

  const organizer = supertest.agent(app);
  await signIn(organizer, 'organizer@example.test', 'StrongPassword123!');
  await mutate(organizer, 'post', `/api/conferences/${conferenceTwo}/members`, { userId: attendeeId, role: 'reviewer' }).expect(403);
  await mutate(organizer, 'post', `/api/conferences/${conferenceOne}/members`, { userId: attendeeId, role: 'reviewer' }).expect(201);
  const members = await organizer.get(`/api/conferences/${conferenceOne}/members`).expect(200);
  assert.ok(members.body.data.some((member) => member.user_id === attendeeId && member.role === 'reviewer'));
  const publicCommittee = await organizer.get(`/api/committee?conferenceId=${conferenceOne}`).expect(200);
  assert.ok(publicCommittee.body.data.some((member) => member.role === 'conference_admin' && member.conference_id === conferenceOne));
});

test('Super Admin access is server-authorized and submission changes require ownership', async () => {
  const superAgent = supertest.agent(app);
  await signIn(superAgent, 'platform@example.test', 'StrongPassword123!');
  const users = await superAgent.get('/api/auth/admin/users').expect(200);
  assert.ok(users.body.data.length >= 5);

  const author = supertest.agent(app);
  await signIn(author, 'author@example.test', 'StrongPassword123!');
  await author.get(`/api/submissions/${ownerSubmission}`).expect(200);
  await mutate(author, 'patch', `/api/submissions/${ownerSubmission}`, { title: 'Updated draft title' }).expect(200);
  await author.get(`/api/submissions/${randomUUID()}`).expect(404);
  const otherOwner = supertest.agent(app);
  await signIn(otherOwner, 'attendee@example.test', 'StrongPassword123!');
  await otherOwner.get(`/api/submissions/${ownerSubmission}`).expect(403);
  await mutate(otherOwner, 'patch', `/api/submissions/${ownerSubmission}`, { title: 'Unauthorized edit title' }).expect(404);
});

test('paper workflow validates PDFs, enforces deadlines and ownership, and retains private versions', async () => {
  let author=supertest.agent(app);await signIn(author,'author@example.test','StrongPassword123!');
  const originalFetch=global.fetch;const oldUrl=process.env.SUPABASE_URL;const oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL='https://storage.example.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-secret';process.env.SUPABASE_STORAGE_BUCKET='manuscripts';
  let stored=0;
  global.fetch=async(url,options)=>{
    assert.match(String(url),/storage\/v1\/object/);
    if(options.method==='POST'&&String(url).includes('/sign/'))return new Response(JSON.stringify({signedURL:'/object/sign/manuscripts/temporary?token=short-lived'}),{status:200,headers:{'Content-Type':'application/json'}});
    if(options.method==='POST'){stored++;return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});}
    return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
  };
  try{
    await testPool.query("insert into public.conference_deadlines(conference_id,deadline_type,deadline_at) values($1,'paper',now()+interval '2 days')",[conferenceOne]);
    const invalidToken=await csrf(author);
    const invalid=await author.post('/api/submissions').set('Origin',ORIGIN).set('X-CSRF-Token',invalidToken)
      .field('conferenceId',conferenceOne).field('trackId',workflowTrack).field('title','Workflow test paper').field('abstract','A sufficiently long scientific abstract for a tested submission workflow. '.repeat(2))
      .field('keywords',JSON.stringify(['systems'])).field('category','full_paper').field('authors',JSON.stringify([{fullName:'author',email:'author@example.test'}])).field('correspondingIndex','0')
      .attach('manuscript',Buffer.from('not a pdf'),{filename:'paper.pdf',contentType:'application/pdf'});
    assert.equal(invalid.status,400);assert.match(invalid.body.error.message,/valid PDF/);

    author=supertest.agent(app);await signIn(author,'author@example.test','StrongPassword123!');
    const token=await csrf(author);const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF');
    const created=await author.post('/api/submissions').set('Origin',ORIGIN).set('X-CSRF-Token',token)
      .field('conferenceId',conferenceOne).field('trackId',workflowTrack).field('title','Workflow test paper').field('abstract','A sufficiently long scientific abstract for a tested submission workflow. '.repeat(2))
      .field('keywords',JSON.stringify(['systems','security'])).field('category','full_paper')
      .field('authors',JSON.stringify([{fullName:'Author One',email:'author@example.test',affiliation:'BUP'},{fullName:'Other Author',email:'other@example.test',affiliation:'BUP'}])).field('correspondingIndex','0')
      .attach('manuscript',pdf,{filename:'paper.pdf',contentType:'application/pdf'});
    assert.equal(created.status,201,created.text);assert.match(created.body.data.paperCode,/^BUP-\d{4}-[A-F0-9]+$/);assert.equal(created.body.data.status,'submitted');assert.equal(stored,1);
    const id=created.body.data.id;
    const history=await author.get(`/api/submissions/${id}`).expect(200);
    assert.equal(history.body.data.versions.length,1);assert.equal(history.body.data.authors.length,2);assert.equal(JSON.stringify(history.body).includes('object_key'),false);
    assert.equal(JSON.stringify(history.body).includes('confidential_comments'),false);

    const linkToken=await csrf(author);
    const link=await author.post(`/api/submissions/${id}/download-link`).set('Origin',ORIGIN).set('X-CSRF-Token',linkToken).send({versionId:history.body.data.versions[0].id}).expect(200);
    assert.match(link.body.data.url,/short-lived/);assert.equal(link.body.data.expiresIn,300);

    const authorToken=linkToken;
  await author.patch(`/api/submissions/${id}/status`).set('Origin',ORIGIN).set('X-CSRF-Token',authorToken).send({status:'accepted'}).expect(404);
    const revisionToken=linkToken;
    const revised=await author.post(`/api/submissions/${id}/versions`).set('Origin',ORIGIN).set('X-CSRF-Token',revisionToken)
      .attach('manuscript',pdf,{filename:'revision.pdf',contentType:'application/pdf'}).expect(201);
    assert.equal(revised.body.data.version_number,2);assert.equal(revised.body.data.status,'submitted');
    const afterRevision=await author.get(`/api/submissions/${id}`).expect(200);assert.equal(afterRevision.body.data.versions.length,2);

    await testPool.query("delete from public.conference_deadlines where conference_id=$1 and deadline_type='paper'",[conferenceOne]);
    await testPool.query("insert into public.conference_deadlines(conference_id,deadline_type,deadline_at) values($1,'paper',now()-interval '1 day')",[conferenceOne]);
    const expired=await author.patch(`/api/submissions/${id}`).set('Origin',ORIGIN).set('X-CSRF-Token',linkToken).send({title:'Title after deadline'}).expect(409);
    assert.match(expired.body.error.message,/deadline has passed/);
  }finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});

test('peer review scopes assignments, blocks conflicts, validates reviews, protects editor comments, and records decisions', async()=>{
  const reviewer=await addUser({email:'reviewer-workflow@example.test',role:'reviewer',conferenceId:conferenceOne});
  const conflictedReviewer=await addUser({email:'reviewer-author@example.test',role:'reviewer',conferenceId:conferenceOne});
  const editor=supertest.agent(app);await signIn(editor,'organizer@example.test','StrongPassword123!');
  const author=supertest.agent(app);await signIn(author,'author@example.test','StrongPassword123!');
  const authorAccount=(await testPool.query("select id from public.users where email='author@example.test'")).rows[0];
  const target=(await testPool.query(`insert into public.submissions(conference_id,submitted_by,title,abstract,status,paper_code)
    values($1,$2,'Review workflow target','This is an abstract with enough detail to test peer review permissions.','submitted','BUP-TEST-REVIEW') returning id`,[conferenceOne,authorAccount.id])).rows[0];
  const paperId=target.id;
  await testPool.query(`insert into public.authors(submission_id,user_id,full_name,email,institution,author_order,is_corresponding) values($1,$2,'Paper Author','author@example.test','BUP',1,true)`,[paperId,authorAccount.id]);
  const second=(await testPool.query(`insert into public.submissions(conference_id,submitted_by,title,abstract,status,paper_code)
    values($1,$2,'Conflict workflow paper','This is an abstract with enough detail to test conflict disclosure.','submitted','BUP-TEST-CONFLICT') returning id`,[conferenceOne,authorAccount.id])).rows[0];
  await testPool.query(`insert into public.authors(submission_id,user_id,full_name,email,author_order) values($1,$2,'Paper Author','author@example.test',1)`,[second.id,authorAccount.id]);
  const conflictVersion=(await testPool.query(`insert into public.submission_versions(submission_id,version_number,version_type,object_key,original_filename,file_size,sha256,uploaded_by) values($1,1,'initial',$2,'conflict.pdf',32,$3,$4) returning id`,[second.id,`${second.id}/private.pdf`,'b'.repeat(64),authorAccount.id])).rows[0];
  await testPool.query(`insert into public.authors(submission_id,user_id,full_name,email,author_order) values($1,$2,'Conflicted reviewer','reviewer-author@example.test',2)`,[paperId,conflictedReviewer.id]);
  await testPool.query(`insert into public.submission_versions(submission_id,version_number,version_type,object_key,original_filename,file_size,sha256,uploaded_by) values($1,1,'initial',$2,'anonymous.pdf',32,$3,$4)`,[paperId,`${paperId}/private.pdf`,'a'.repeat(64),authorAccount.id]);

  const settingsToken=await csrf(editor);
  const criteria=['originality','technical_quality','methodology','clarity','relevance'].map((criterionKey,i)=>({criterionKey,label:criterionKey,maxScore:5,isActive:true}));
  await editor.put(`/api/admin/conferences/${conferenceOne}/review-settings`).set('Origin',ORIGIN).set('X-CSRF-Token',settingsToken).send({reviewMode:'double_blind',criteria}).expect(200);
  const candidates=await editor.get(`/api/admin/conferences/${conferenceOne}/review-candidates`).expect(200);assert.ok(candidates.body.data.some(c=>c.id===paperId));
  const excluded=await editor.get(`/api/admin/conferences/${conferenceOne}/reviewers?submissionId=${paperId}`).expect(200);
  assert.equal(excluded.body.data.some(x=>x.id===conflictedReviewer.id),false);
  const authorToken=await csrf(author);
  await author.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',authorToken).send({submissionId:paperId,reviewerId:reviewer.id,reviewRound:1}).expect(403);
  const organizerToken=await csrf(editor);
  await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',organizerToken).send({submissionId:paperId,reviewerId:conflictedReviewer.id,reviewRound:1}).expect(409);
  await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',organizerToken).send({submissionId:paperId,reviewerId:reviewer.id,dueAt:new Date(Date.now()-86400000).toISOString(),reviewRound:1}).expect(400);
  const assignment=await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',organizerToken).send({submissionId:paperId,reviewerId:reviewer.id,dueAt:new Date(Date.now()+86400000).toISOString(),reviewRound:1}).expect(201);
  const reviewId=assignment.body.data.id;
  await testPool.query("update public.reviews set due_at=now()-interval '1 day' where id=$1",[reviewId]);
  const reviewerAgent=supertest.agent(app);await signIn(reviewerAgent,reviewer.email,reviewer.password);
  const profileToken=await csrf(reviewerAgent);await reviewerAgent.patch('/api/reviewer/profile').set('Origin',ORIGIN).set('X-CSRF-Token',profileToken).send({expertise:['systems security','research methods'],availability:'available',biography:'Research reviewer.'}).expect(200);
  const dashboard=await reviewerAgent.get('/api/reviewer/assignments').expect(200);assert.equal(dashboard.body.data.length,1);assert.equal(dashboard.body.data[0].id,reviewId);assert.equal(dashboard.body.data[0].overdue,true);
  await testPool.query("update public.reviews set due_at=now()+interval '1 day' where id=$1",[reviewId]);
  await reviewerAgent.get(`/api/reviewer/assignments/${randomUUID()}`).expect(404);
  const detail=await reviewerAgent.get(`/api/reviewer/assignments/${reviewId}`).expect(200);assert.equal(detail.body.data.submission.reviewMode,'double_blind');assert.equal(detail.body.data.submission.authors,undefined);
  const downloadToken=await csrf(reviewerAgent);const originalFetch=global.fetch;const oldUrl=process.env.SUPABASE_URL;const oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL='https://storage.example.test';process.env.SUPABASE_SERVICE_ROLE_KEY='review-test-key';
  global.fetch=async()=>new Response(JSON.stringify({signedURL:'/object/sign/manuscripts/review.pdf?token=temporary'}),{status:200,headers:{'Content-Type':'application/json'}});
  try{const signed=await reviewerAgent.post(`/api/submissions/${paperId}/download-link`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({versionId:detail.body.data.submission.versions[0].id}).expect(200);assert.match(signed.body.data.url,/temporary/);}finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}

  const scores={originality:5,technical_quality:4,methodology:4,clarity:5,relevance:4};
  await reviewerAgent.put(`/api/reviewer/assignments/${reviewId}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:{...scores,technical_quality:8},recommendation:'accept',commentsToAuthors:'Detailed and constructive feedback for this manuscript.'}).expect(400);
  await reviewerAgent.put(`/api/reviewer/assignments/${reviewId}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:{originality:5},recommendation:'accept',commentsToAuthors:'Feedback'}).expect(400);
  await reviewerAgent.put(`/api/reviewer/assignments/${reviewId}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'draft',criterionScores:{originality:4},confidentialComments:'Private editor note.'}).expect(200);
  const submitted=await reviewerAgent.put(`/api/reviewer/assignments/${reviewId}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:scores,recommendation:'minor_revision',commentsToAuthors:'Please clarify the methodology and expand the evaluation section.',confidentialComments:'Editor only: verify the related work concerns.'}).expect(200);
  assert.equal(submitted.body.data.status,'submitted');
  await reviewerAgent.post(`/api/admin/conferences/${conferenceOne}/submissions/${paperId}/decision`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({status:'accepted'}).expect(403);
  const summary=await editor.get(`/api/admin/conferences/${conferenceOne}/review-summary`).expect(200);assert.equal(summary.body.data.reviews.find(r=>r.id===reviewId).confidential_comments,'Editor only: verify the related work concerns.');
  const ownerDetail=await author.get(`/api/submissions/${paperId}`).expect(200);assert.equal(JSON.stringify(ownerDetail.body).includes('Editor only'),false);assert.equal(ownerDetail.body.data.reviews.length,0);
  const decisionToken=await csrf(editor);await editor.post(`/api/admin/conferences/${conferenceOne}/submissions/${paperId}/decision`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({status:'accepted',authorNote:'Accepted after editorial review.',editorNote:'Final editor-only decision note.',reviewRound:1}).expect(201);
  await editor.post(`/api/admin/conferences/${conferenceOne}/submissions/${paperId}/decision`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({status:'rejected',reviewRound:1}).expect(409);
  const afterDecision=await author.get(`/api/submissions/${paperId}`).expect(200);assert.equal(afterDecision.body.data.decisions.length,1);assert.equal(afterDecision.body.data.decisions[0].author_note,'Accepted after editorial review.');assert.equal(afterDecision.body.data.reviews[0].comments,'Please clarify the methodology and expand the evaluation section.');assert.equal(JSON.stringify(afterDecision.body).includes('Final editor-only'),false);
  const notifications=await testPool.query('select title from public.notifications where user_id=$1',[authorAccount.id]);assert.ok(notifications.rows.some(n=>n.title==='Paper accepted'));
  const authorNotifications=await author.get('/api/notifications').expect(200);assert.ok(authorNotifications.body.data.some(n=>n.title==='Paper accepted'));assert.equal(JSON.stringify(authorNotifications.body).includes('Final editor-only'),false);

  const secondAssignment=await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({submissionId:second.id,reviewerId:reviewer.id,reviewRound:1}).expect(201);
  const conflict=await reviewerAgent.post(`/api/reviewer/assignments/${secondAssignment.body.data.id}/conflict`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({reason:'I have a recent collaboration with an author on this paper.'}).expect(200);
  assert.equal(conflict.body.data.status,'conflict_declared');await reviewerAgent.get(`/api/reviewer/assignments/${secondAssignment.body.data.id}`).expect(403);
  await reviewerAgent.post(`/api/submissions/${second.id}/download-link`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({versionId:conflictVersion.id}).expect(403);
  await reviewerAgent.put(`/api/reviewer/assignments/${secondAssignment.body.data.id}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:scores,recommendation:'accept',commentsToAuthors:'Review'}).expect(409);

  // Invalid status transitions, decline, and re-review round lifecycle
  const third=(await testPool.query(`insert into public.submissions(conference_id,submitted_by,title,abstract,status,paper_code)
    values($1,$2,'Re-review lifecycle paper','Abstract for testing multi-round review and decline transitions.','submitted','BUP-TEST-REREVIEW') returning id`,[conferenceOne,authorAccount.id])).rows[0];
  await testPool.query(`insert into public.authors(submission_id,user_id,full_name,email,author_order) values($1,$2,'Paper Author','author@example.test',1)`,[third.id,authorAccount.id]);
  const thirdVersion=(await testPool.query(`insert into public.submission_versions(submission_id,version_number,version_type,object_key,original_filename,file_size,sha256,uploaded_by) values($1,1,'initial',$2,'third.pdf',32,$3,$4) returning id`,[third.id,`${third.id}/private.pdf`,'c'.repeat(64),authorAccount.id])).rows[0];

  const thirdAssignment=await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({submissionId:third.id,reviewerId:reviewer.id,reviewRound:1}).expect(201);
  const thirdRevId=thirdAssignment.body.data.id;

  // Reviewer accepts assignment
  await reviewerAgent.patch(`/api/reviewer/assignments/${thirdRevId}/status`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({status:'accepted'}).expect(200);
  // Cannot re-accept or decline once accepted (invalid transition -> 409)
  await reviewerAgent.patch(`/api/reviewer/assignments/${thirdRevId}/status`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({status:'declined'}).expect(409);

  // Reviewer submits round 1 review requesting revision
  await reviewerAgent.put(`/api/reviewer/assignments/${thirdRevId}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:scores,recommendation:'major_revision',commentsToAuthors:'Extensive revision required.'}).expect(200);

  // Editor records revision_required
  await editor.post(`/api/admin/conferences/${conferenceOne}/submissions/${third.id}/decision`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({status:'revision_required',authorNote:'Please address major reviewer comments.',editorNote:'Check methodology in next round.',reviewRound:1}).expect(201);

  // Paper status is now revision_required; author uploads revision -> status returns to submitted
  await testPool.query(`insert into public.submission_versions(submission_id,version_number,version_type,object_key,original_filename,file_size,sha256,uploaded_by) values($1,2,'revision',$2,'revised.pdf',40,$3,$4)`,[third.id,`${third.id}/v2.pdf`,'d'.repeat(64),authorAccount.id]);
  await testPool.query("update public.submissions set status='submitted',updated_at=now() where id=$1",[third.id]);

  // Round 2 assignment to the same reviewer
  const roundTwoAssignment=await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({submissionId:third.id,reviewerId:reviewer.id,reviewRound:2}).expect(201);
  assert.equal(roundTwoAssignment.body.data.reviewRound,2);

  // Cannot assign same reviewer to round 2 again (duplicate in same round -> 409)
  await editor.post(`/api/admin/conferences/${conferenceOne}/review-assignments`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({submissionId:third.id,reviewerId:reviewer.id,reviewRound:2}).expect(409);

  // Reviewer submits round 2 review accepting the revision
  await reviewerAgent.put(`/api/reviewer/assignments/${roundTwoAssignment.body.data.id}/review`).set('Origin',ORIGIN).set('X-CSRF-Token',downloadToken).send({action:'submit',criterionScores:scores,recommendation:'accept',commentsToAuthors:'Revisions are satisfactory.'}).expect(200);

  // Editor records final acceptance
  await editor.post(`/api/admin/conferences/${conferenceOne}/submissions/${third.id}/decision`).set('Origin',ORIGIN).set('X-CSRF-Token',decisionToken).send({status:'accepted',authorNote:'Accepted after satisfactory revision.',reviewRound:2}).expect(201);

  // Decision history contains both rounds
  const decisionHistory=(await testPool.query('select review_round,status from public.submission_decisions where submission_id=$1 order by review_round asc',[third.id])).rows;
  assert.equal(decisionHistory.length,2);
  assert.equal(decisionHistory[0].status,'revision_required');
  assert.equal(decisionHistory[1].status,'accepted');
});

test('password reset tokens expire and can be used only once; SMTP absence is reported honestly', async () => {
  const { createOpaqueToken, hashToken, hashPassword } = await import('../src/auth/crypto.js');
  const token = createOpaqueToken();
  const oldHash = await hashPassword('OldPassword123!');
  await testPool.query('update public.users set password_hash=$1 where id=$2', [oldHash, attendeeId]);
  await testPool.query("insert into public.password_reset_tokens(token_hash,user_id,expires_at) values($1,$2,now()+interval '20 minutes')", [hashToken(token), attendeeId]);
  const resetAgent = supertest.agent(app);
  await mutate(resetAgent, 'post', '/api/auth/reset-password', { token, password: 'ReplacementPass123!' }).expect(200);
  await mutate(resetAgent, 'post', '/api/auth/reset-password', { token, password: 'SecondReplacement123!' }).expect(400);
  const expiredToken = createOpaqueToken();
  await testPool.query("insert into public.password_reset_tokens(token_hash,user_id,expires_at) values($1,$2,now()-interval '1 minute')", [hashToken(expiredToken), attendeeId]);
  await mutate(resetAgent, 'post', '/api/auth/reset-password', { token: expiredToken, password: 'YetAnotherPass123!' }).expect(400);
  const forgot = await mutate(resetAgent, 'post', '/api/auth/forgot-password', { email: 'attendee@example.test' });
  assert.equal(forgot.status, 503);
  assert.match(forgot.body.error.message, /No password reset email was sent/);
  const oldLogin = await mutate(supertest.agent(app), 'post', '/api/auth/login', { email: 'attendee@example.test', password: 'StrongPassword123!' });
  assert.equal(oldLogin.status, 401);
  const newLogin = supertest.agent(app);
  await signIn(newLogin, 'attendee@example.test', 'ReplacementPass123!');
});

test('required email verification blocks registration until an email provider is configured', async () => {
  process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
  try {
    const agent = supertest.agent(app);
    const result = await mutate(agent, 'post', '/api/auth/register', { fullName: 'Unverified Person', email: 'pending@example.test', password: 'Verification123!' });
    assert.equal(result.status, 503);
    assert.match(result.body.error.message, /No account was created/);
    const absent = await testPool.query('select id from public.users where email=$1', ['pending@example.test']);
    assert.equal(absent.rows.length, 0);
  } finally { process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false'; }
});
