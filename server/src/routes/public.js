import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireDatabase() {
  if (!pool) {
    const error = new Error('Database is not configured. Set DATABASE_URL in server/.env.');
    error.status = 503;
    throw error;
  }
}

function validConferenceId(id, res) {
  if (!uuidPattern.test(id)) {
    res.status(400).json({ error: { message: 'Conference ID must be a UUID.' } });
    return false;
  }
  return true;
}

router.get('/conferences', async (req, res, next) => {
  try {
    requireDatabase();
    const values = [];
    const filters = ["status in ('published', 'submission_open', 'in_review', 'completed')"];
    if (req.query.q) {
      values.push(`%${String(req.query.q).slice(0, 120)}%`);
      filters.push(`(title ilike $${values.length} or acronym ilike $${values.length})`);
    }
    if (req.query.status && ['published', 'submission_open', 'in_review', 'completed'].includes(req.query.status)) {
      values.push(req.query.status);
      filters.push(`status = $${values.length}`);
    }
    values.push(Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100));
    const result = await pool.query(
      `select id, title, acronym, description, venue, timezone, start_date, end_date, submission_deadline, status, conference_mode
       from public.conferences where ${filters.join(' and ')}
       order by start_date asc nulls last, created_at desc limit $${values.length}`,
      values,
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

router.get('/conferences/:id', async (req, res, next) => {
  if (!validConferenceId(req.params.id, res)) return;
  try {
    requireDatabase();
    const { rows } = await pool.query(
      "select id, title, acronym, description, venue, timezone, start_date, end_date, submission_deadline, status, conference_mode from public.conferences where id = $1 and status in ('published','submission_open','in_review','completed')",
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: { message: 'Conference not found.' } });
    res.json({ data: rows[0] });
  } catch (error) { next(error); }
});

router.get('/conferences/:id/dates', async (req, res, next) => {
  if (!validConferenceId(req.params.id, res)) return;
  try {
    requireDatabase();
    const { rows } = await pool.query(
      `select d.id, d.label, d.description, d.starts_at, d.ends_at, c.timezone
       from public.conference_dates d join public.conferences c on c.id = d.conference_id
       where d.conference_id = $1 and c.status in ('published','submission_open','in_review','completed')
       union all
       select c.id, 'Submission deadline' as label, null::text as description,
         c.submission_deadline as starts_at, null::timestamptz as ends_at, c.timezone
       from public.conferences c where c.id = $1 and c.submission_deadline is not null
         and c.status in ('published','submission_open','in_review','completed')
       union all
       select d.id, initcap(replace(d.deadline_type,'_',' ')) as label, null::text as description,
         d.deadline_at as starts_at, null::timestamptz as ends_at, c.timezone
       from public.conference_deadlines d join public.conferences c on c.id=d.conference_id
       where d.conference_id=$1 and c.status in ('published','submission_open','in_review','completed')
       order by starts_at asc nulls last`, [req.params.id]);
    res.json({ data: rows });
  } catch (error) { next(error); }
});

router.get('/conferences/:id/tracks', async (req, res, next) => {
  if (!validConferenceId(req.params.id, res)) return;
  try {
    requireDatabase();
    const { rows } = await pool.query(
      `select t.id, t.name, t.description,
         coalesce((select json_agg(json_build_object('id',tp.id,'name',tp.name,'description',tp.description) order by tp.name) from public.track_topics tp where tp.track_id=t.id and tp.is_active=true),'[]'::json) as topics
       from public.tracks t join public.conferences c on c.id = t.conference_id
       where t.conference_id = $1 and t.is_active = true and c.status in ('published','submission_open','in_review','completed') order by t.name`, [req.params.id]);
    res.json({ data: rows });
  } catch (error) { next(error); }
});

router.get('/conferences/:id/deadlines', async (req,res,next)=>{
  if(!validConferenceId(req.params.id,res))return;
  try{requireDatabase();const {rows}=await pool.query(`select d.id,d.deadline_type,d.deadline_at,c.timezone from public.conference_deadlines d join public.conferences c on c.id=d.conference_id where d.conference_id=$1 and c.status in ('published','submission_open','in_review','completed') order by d.deadline_at`,[req.params.id]);res.json({data:rows});}catch(error){next(error);}
});

router.get('/conferences/:id/people', async(req,res,next)=>{
  if(!validConferenceId(req.params.id,res))return;
  try{requireDatabase();const {rows}=await pool.query(`select id,person_type,full_name,title,institution,bio from public.conference_people where conference_id=$1 and is_public=true and person_type in ('committee','keynote_speaker','organizer','session_chair') and exists(select 1 from public.conferences c where c.id=$1 and c.status in ('published','submission_open','in_review','completed')) order by person_type,full_name`,[req.params.id]);res.json({data:rows});}catch(error){next(error);}
});

router.get('/faqs',async(req,res,next)=>{try{requireDatabase();const values=[];let where='f.is_published=true and (f.conference_id is null or c.status in (\'published\',\'submission_open\',\'in_review\',\'completed\'))';if(req.query.conferenceId&&uuidPattern.test(String(req.query.conferenceId))){values.push(req.query.conferenceId);where+=` and (f.conference_id is null or f.conference_id=$${values.length})`;}const {rows}=await pool.query(`select f.id,f.conference_id,f.question,f.answer,f.sort_order from public.faqs f left join public.conferences c on c.id=f.conference_id where ${where} order by f.sort_order,f.created_at`,values);res.json({data:rows});}catch(error){next(error);}});

router.get('/site-settings',async(_req,res,next)=>{try{requireDatabase();const {rows}=await pool.query('select key,value from public.public_site_settings order by key');res.json({data:Object.fromEntries(rows.map(row=>[row.key,row.value]))});}catch(error){next(error);}});

router.get('/conferences/:id/schedule', async (req, res, next) => {
  if (!validConferenceId(req.params.id, res)) return;
  try {
    requireDatabase();
    const { rows } = await pool.query(
      `select s.id, s.title, s.description, s.venue, s.starts_at, s.ends_at, c.timezone, t.name as track_name
       from public.sessions s join public.conferences c on c.id = s.conference_id
       left join public.tracks t on t.id = s.track_id
       where s.conference_id = $1 and c.status in ('published','submission_open','in_review','completed')
       order by s.starts_at asc`, [req.params.id]);
    res.json({ data: rows });
  } catch (error) { next(error); }
});

router.get('/announcements', async (_req, res, next) => {
  try {
    requireDatabase();
    const { rows } = await pool.query(
      `select a.id, a.title, a.body, a.published_at, c.id as conference_id, c.title as conference_title
       from public.announcements a left join public.conferences c on c.id = a.conference_id
       where a.is_published = true and (a.conference_id is null or c.status in ('published','submission_open','in_review','completed'))
       order by a.published_at desc limit 10`);
    res.json({ data: rows });
  } catch (error) { next(error); }
});

router.get('/committee', async (req, res, next) => {
  try {
    requireDatabase();
    const params = [];
    let scope = "r.name in ('conference_admin','session_chair') and c.status in ('published','submission_open','in_review','completed')";
    if (req.query.conferenceId && uuidPattern.test(String(req.query.conferenceId))) {
      params.push(req.query.conferenceId);
      scope += ` and c.id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `select distinct u.id, u.full_name, u.institution, r.name as role, c.id as conference_id, c.title as conference_title
       from public.conference_memberships cm join public.users u on u.id = cm.user_id
       join public.roles r on r.id = cm.role_id join public.conferences c on c.id = cm.conference_id
       where ${scope} and u.is_active = true order by c.title, r.name, u.full_name limit 100`, params);
    const staffParams=[];let staffScope="p.is_public=true and p.person_type in ('committee','organizer','session_chair') and c.status in ('published','submission_open','in_review','completed')";if(req.query.conferenceId&&uuidPattern.test(String(req.query.conferenceId))){staffParams.push(req.query.conferenceId);staffScope+=` and c.id=$${staffParams.length}`;}const people=await pool.query(`select p.id,p.full_name,p.institution,p.person_type as role,c.id as conference_id,c.title as conference_title from public.conference_people p join public.conferences c on c.id=p.conference_id where ${staffScope}`,staffParams);res.json({ data: [...rows,...people.rows] });
  } catch (error) { next(error); }
});

router.get('/speakers', async (req, res, next) => {
  try {
    requireDatabase();
    const params = [];
    let scope = "r.registration_type = 'speaker' and r.status = 'confirmed' and c.status in ('published','submission_open','in_review','completed')";
    if (req.query.conferenceId && uuidPattern.test(String(req.query.conferenceId))) {
      params.push(req.query.conferenceId);
      scope += ` and c.id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `select u.id, u.full_name, u.institution, c.id as conference_id, c.title as conference_title
       from public.registrations r join public.users u on u.id = r.user_id
       join public.conferences c on c.id = r.conference_id where ${scope}
       order by c.start_date nulls last, u.full_name limit 100`, params);
    const speakerParams=[];let speakerScope="p.is_public=true and p.person_type='keynote_speaker' and c.status in ('published','submission_open','in_review','completed')";if(req.query.conferenceId&&uuidPattern.test(String(req.query.conferenceId))){speakerParams.push(req.query.conferenceId);speakerScope+=` and c.id=$${speakerParams.length}`;}const speakers=await pool.query(`select p.id,p.full_name,p.institution,c.id as conference_id,c.title as conference_title from public.conference_people p join public.conferences c on c.id=p.conference_id where ${speakerScope}`,speakerParams);res.json({ data: [...rows,...speakers.rows] });
  } catch (error) { next(error); }
});

router.get('/certificates/verify/:number', async (req, res, next) => {
  try {
    requireDatabase();
    const number = String(req.params.number).trim().slice(0, 100);
    const { rows } = await pool.query(
      `select cert.id, cert.certificate_number, cert.certificate_type, cert.issued_at,
              cert.is_revoked, cert.revocation_reason, cert.revoked_at,
              u.full_name, u.institution, c.id as conference_id, c.title as conference_title
       from public.certificates cert
       join public.users u on u.id = cert.user_id
       join public.conferences c on c.id = cert.conference_id
       where cert.certificate_number = $1 and c.status in ('published','submission_open','in_review','completed')
       limit 1`,
      [number]
    );
    if (!rows[0]) return res.json({ data: { valid: false, status: 'not_found' } });

    const c = rows[0];
    if (c.is_revoked) {
      return res.json({
        data: {
          valid: false,
          status: 'revoked',
          certificate_number: c.certificate_number,
          certificate_type: c.certificate_type,
          full_name: c.full_name,
          conference_title: c.conference_title,
          revocation_reason: c.revocation_reason,
          revoked_at: c.revoked_at,
        },
      });
    }

    res.json({
      data: {
        valid: true,
        status: 'valid',
        id: c.id,
        certificate_number: c.certificate_number,
        certificate_type: c.certificate_type,
        full_name: c.full_name,
        institution: c.institution,
        conference_title: c.conference_title,
        issued_at: c.issued_at,
        download_url: `/api/certificates/${c.id}/download`,
      },
    });
  } catch (error) { next(error); }
});

router.post('/contact', async (req, res, next) => {
  try {
    requireDatabase();
    const { name, email, subject, message } = req.body || {};
    if (![name, email, subject, message].every((value) => typeof value === 'string' && value.trim()) ||
        name.length > 160 || email.length > 254 || subject.length > 200 || message.length > 5000 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: { message: 'Enter a valid name, email, subject and message.' } });
    }
    await pool.query(
      'insert into public.contact_messages (name, email, subject, message) values ($1, $2, $3, $4)',
      [name.trim(), email.trim(), subject.trim(), message.trim()]);
    res.status(201).json({ data: { message: 'Your message has been received.' } });
  } catch (error) { next(error); }
});

export default router;
