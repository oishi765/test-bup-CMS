import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';

const router = Router();
const uuid = z.string().uuid();
const MAX_BYTES = Math.min(Number(process.env.MANUSCRIPT_MAX_BYTES || 15 * 1024 * 1024), 50 * 1024 * 1024);
const publicStatuses = ['accepted', 'revision_required', 'rejected', 'camera_ready', 'finalized'];
const categories = ['full_paper', 'short_paper', 'poster', 'workshop', 'case_study', 'other'];
const field = (v) => typeof v === 'string' ? v.trim() : '';

function dbRequired(_req, res, next) {
  if (!pool) return res.status(503).json({ error: { message: 'Database is unavailable until DATABASE_URL is configured.' } });
  next();
}
function fail(res, status, message) { return res.status(status).json({ error: { message } }); }

// Small bounded multipart reader keeps uploads out of memory beyond the configured cap.
async function readMultipart(req) {
  const type = req.headers['content-type'] || '';
  const boundary = type.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundary) throw Object.assign(new Error('Upload must use multipart/form-data.'), { status: 400 });
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES + 256 * 1024) throw Object.assign(new Error(`PDF exceeds the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB upload limit.`), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks); const fields = {}; let file;
  let cursor = body.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') break;
    if (body.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headEnd < 0) break;
    const header = body.subarray(cursor, headEnd).toString('utf8');
    const next = body.indexOf(marker, headEnd + 4);
    if (next < 0) break;
    let dataEnd = next;
    if (body.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    const disposition = header.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    const data = body.subarray(headEnd + 4, dataEnd);
    if (name && filename !== undefined) {
      if (file) throw Object.assign(new Error('Upload exactly one PDF file.'), { status: 400 });
      file = { data, filename, contentType: header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || '' };
    } else if (name) fields[name] = data.toString('utf8');
    cursor = next;
  }
  return { fields, file };
}

function validatePdf(file) {
  if (!file || !file.data.length) return 'Select a PDF manuscript to upload.';
  if (file.data.length > MAX_BYTES) return `PDF exceeds the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB upload limit.`;
  if (file.contentType !== 'application/pdf') return 'The manuscript must have the application/pdf content type.';
  if (!/^.+\.pdf$/i.test(file.filename)) return 'The selected file must have a .pdf extension.';
  const bytes = file.data;
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return 'The file content is not a valid PDF document.';
  if (!bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) return 'The PDF appears incomplete or damaged.';
  const structure=bytes.toString('latin1');
  if(!/\b\d+\s+\d+\s+obj\b/.test(structure)||!/\/Type\s*\/Catalog\b/.test(structure))return 'The PDF is missing its required document structure.';
  return '';
}

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'manuscripts';
  return url && key ? { url: url.replace(/\/$/, ''), key, bucket } : null;
}
async function storePrivate(file, objectKey) {
  const cfg = storageConfig();
  if (!cfg) throw Object.assign(new Error('Private manuscript storage is not configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and create the private bucket.'), { status: 503 });
  const response = await fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${objectKey}`, {
    method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: file.data,
  });
  if (!response.ok) throw Object.assign(new Error('Manuscript storage rejected the upload. Check the private bucket configuration.'), { status: 502 });
  return cfg;
}
async function removePrivate(objectKey) {
  const cfg = storageConfig(); if (!cfg) return;
  await fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}`, {
    method: 'DELETE', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [objectKey] }),
  }).catch(() => {});
}
async function signedLink(objectKey) {
  const cfg = storageConfig();
  if (!cfg) throw Object.assign(new Error('Private manuscript storage is not configured.'), { status: 503 });
  const expires = Math.max(60, Math.min(Number(process.env.MANUSCRIPT_SIGNED_URL_SECONDS || 300), 900));
  const response = await fetch(`${cfg.url}/storage/v1/object/sign/${encodeURIComponent(cfg.bucket)}/${objectKey}`, {
    method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: expires }),
  });
  if (!response.ok) throw Object.assign(new Error('Could not create a temporary manuscript download link.'), { status: 502 });
  const data = await response.json();
  const path = data.signedURL || data.signedUrl;
  if (!path) throw Object.assign(new Error('Storage did not return a signed download link.'), { status: 502 });
  const url = path.startsWith('http') ? path : `${cfg.url}/storage/v1${path.startsWith('/') ? '' : '/'}${path}`;
  return { url, expiresIn: expires };
}
async function allowedDeadline(client, conferenceId, kind) {
  const { rows } = await client.query(`select deadline_at from public.conference_deadlines where conference_id=$1 and deadline_type=$2`, [conferenceId, kind]);
  if (rows[0]) return new Date(rows[0].deadline_at) >= new Date();
  if (kind === 'paper') {
    const fallback = await client.query('select submission_deadline from public.conferences where id=$1', [conferenceId]);
    return !fallback.rows[0]?.submission_deadline || new Date(fallback.rows[0].submission_deadline) >= new Date();
  }
  return false;
}
async function owns(client, submissionId, userId) {
  const result = await client.query(`select s.*,c.title as conference_title from public.submissions s join public.conferences c on c.id=s.conference_id where s.id=$1`, [submissionId]);
  if(!result.rows[0]) return null;
  const submission=result.rows[0];
  if(submission.submitted_by===userId) return submission;
  const author=await client.query('select 1 from public.authors where submission_id=$1 and user_id=$2 limit 1',[submissionId,userId]);
  return author.rows[0]?submission:null;
}
function safePaper(row) {
  const { submitted_by, paper_url, ...safe } = row;
  return safe;
}
async function saveVersion(client, { submissionId, file, userId, versionType }) {
  const { rows } = await client.query('select coalesce(max(version_number),0)+1 as next from public.submission_versions where submission_id=$1', [submissionId]);
  const versionNumber = Number(rows[0].next);
  const objectKey = `${submissionId}/${randomBytes(24).toString('hex')}.pdf`;
  await storePrivate(file, objectKey);
  try {
    const result = await client.query(`insert into public.submission_versions(submission_id,version_number,version_type,object_key,original_filename,file_size,sha256,uploaded_by)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning id,version_number,version_type,original_filename,file_size,sha256,created_at`,
    [submissionId, versionNumber, versionType, objectKey, file.filename.slice(0, 255), file.data.length, createHash('sha256').update(file.data).digest('hex'), userId]);
    return { record: result.rows[0], objectKey };
  } catch (error) { await removePrivate(objectKey); throw error; }
}

router.get('/author/profile', dbRequired, requireAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query(`select u.full_name,u.email,u.institution,p.corresponding_name,p.corresponding_email,p.corresponding_affiliation
      from public.users u left join public.author_profiles p on p.user_id=u.id where u.id=$1`, [req.user.id]);
    res.json({ data: rows[0] || {} });
  } catch (error) { next(error); }
});
router.patch('/author/profile', dbRequired, requireAuth, requireCsrf, async (req,res,next) => {
  const schema = z.object({ fullName:z.string().trim().min(2).max(160), institution:z.string().trim().max(200).nullable().optional(), correspondingName:z.string().trim().max(160).nullable().optional(), correspondingEmail:z.string().email().max(254).nullable().optional(), correspondingAffiliation:z.string().trim().max(200).nullable().optional() }).strict();
  const parsed=schema.safeParse(req.body); if(!parsed.success) return fail(res,400,'Check the author profile fields.');
  try {
    await pool.query('update public.users set full_name=$1,institution=$2,updated_at=now() where id=$3',[parsed.data.fullName,parsed.data.institution||null,req.user.id]);
    const p=parsed.data;
    const {rows}=await pool.query(`insert into public.author_profiles(user_id,corresponding_name,corresponding_email,corresponding_affiliation,updated_at)
      values($1,$2,$3,$4,now()) on conflict(user_id) do update set corresponding_name=excluded.corresponding_name,corresponding_email=excluded.corresponding_email,corresponding_affiliation=excluded.corresponding_affiliation,updated_at=now()
      returning corresponding_name,corresponding_email,corresponding_affiliation`,[req.user.id,p.correspondingName||null,p.correspondingEmail||null,p.correspondingAffiliation||null]);
    res.json({data:{fullName:p.fullName,institution:p.institution||null,...rows[0]}});
  } catch(error){next(error);}
});

router.get('/author/submissions', dbRequired, requireAuth, async (req,res,next)=>{
  try {
    const {rows}=await pool.query(`select s.id,s.paper_code,s.title,s.abstract,s.keywords,s.category,s.submission_type,s.status,s.decision_note,s.submitted_at,s.created_at,s.updated_at,
      c.id conference_id,c.title conference_title,
      (select deadline_at from public.conference_deadlines d where d.conference_id=c.id and d.deadline_type='paper') paper_deadline,
      (select deadline_at from public.conference_deadlines d where d.conference_id=c.id and d.deadline_type='camera_ready') camera_ready_deadline,
      r.status registration_status,
      (select json_agg(json_build_object('id',a.id,'fullName',a.full_name,'email',a.email,'affiliation',a.institution,'isCorresponding',a.is_corresponding) order by a.author_order) from public.authors a where a.submission_id=s.id) authors,
      (select count(*)::int from public.submission_versions v where v.submission_id=s.id) version_count,
      (select coalesce(json_agg(json_build_object('id',v.id,'version_number',v.version_number,'version_type',v.version_type,'created_at',v.created_at) order by v.version_number desc),'[]'::json) from public.submission_versions v where v.submission_id=s.id) versions,
      case when s.status = any(array['accepted','revision_required','rejected','camera_ready','finalized']::text[]) then
        (select coalesce(json_agg(json_build_object('comments',rev.comments_to_authors,'score',rev.score,'submitted_at',rev.submitted_at) order by rev.submitted_at),'[]'::json)
         from public.reviews rev where rev.submission_id=s.id and rev.status='submitted' and rev.comments_to_authors is not null)
      else '[]'::json end as reviews
      from public.submissions s join public.conferences c on c.id=s.conference_id
      left join public.registrations r on r.conference_id=c.id and r.user_id=$1
      where s.submitted_by=$1 or exists(select 1 from public.authors a where a.submission_id=s.id and a.user_id=$1)
      order by s.created_at desc`,[req.user.id]);
    res.json({data:rows});
  } catch(error){next(error);}
});

// A new submission and its first manuscript version are committed together.
router.post('/submissions', dbRequired, requireAuth, requireCsrf, async (req,res,next)=>{
  let multipart; try { multipart=await readMultipart(req); } catch(error){return fail(res,error.status||400,error.message);}
  const f=multipart.fields;
  const schema=z.object({conferenceId:uuid,trackId:uuid,title:z.string().trim().min(5).max(300),abstract:z.string().trim().min(50).max(20000),keywords:z.array(z.string().trim().min(1).max(60)).min(1).max(12),category:z.enum(categories),authors:z.array(z.object({fullName:z.string().trim().min(2).max(160),email:z.string().email().max(254),affiliation:z.string().trim().max(200).nullable().optional()}).strict()).min(1).max(20),correspondingIndex:z.number().int().min(0)}).strict();
  let input;
  try { input={conferenceId:f.conferenceId,trackId:f.trackId,title:f.title,abstract:f.abstract,keywords:JSON.parse(f.keywords||'[]'),category:f.category,authors:JSON.parse(f.authors||'[]'),correspondingIndex:Number(f.correspondingIndex)}; }
  catch{return fail(res,400,'Submission form data is invalid.');}
  const parsed=schema.safeParse(input);if(!parsed.success)return fail(res,400,'Check the title, abstract, track, category, keywords, and author details.');
  const fileError=validatePdf(multipart.file);if(fileError)return fail(res,400,fileError);
  if(parsed.data.correspondingIndex>=parsed.data.authors.length)return fail(res,400,'Choose one corresponding author.');
  if(!parsed.data.authors.some(a=>a.email.toLowerCase()===req.user.email.toLowerCase()))return fail(res,400,'Include your account email in the author list.');
  const client=await pool.connect(); let objectKey;
  try {
    await client.query('begin');
    const conf=await client.query(`select id,status from public.conferences where id=$1 for share`,[parsed.data.conferenceId]);
    if(!conf.rows[0]||!['published','submission_open'].includes(conf.rows[0].status)){await client.query('rollback');return fail(res,404,'This conference is not open for submissions.');}
    const track=await client.query('select id from public.tracks where id=$1 and conference_id=$2 and is_active=true',[parsed.data.trackId,parsed.data.conferenceId]);
    if(!track.rows[0]){await client.query('rollback');return fail(res,400,'Choose an active track for this conference.');}
    if(!await allowedDeadline(client,parsed.data.conferenceId,'paper')){await client.query('rollback');return fail(res,409,'The paper submission deadline has passed.');}
    const paperCode=`BUP-${new Date().getFullYear()}-${randomBytes(5).toString('hex').toUpperCase()}`;
    const paper=await client.query(`insert into public.submissions(conference_id,track_id,submitted_by,title,abstract,keywords,submission_type,category,status,paper_code,submitted_at)
      values($1,$2,$3,$4,$5,$6,'paper',$7,'submitted',$8,now()) returning id,paper_code`,[parsed.data.conferenceId,parsed.data.trackId,req.user.id,parsed.data.title,parsed.data.abstract,parsed.data.keywords,parsed.data.category,paperCode]);
    const id=paper.rows[0].id;
    const correspondence=parsed.data.correspondingIndex;
    for(let i=0;i<parsed.data.authors.length;i++){
      const a=parsed.data.authors[i];
      const match=await client.query('select id from public.users where lower(email)=lower($1) limit 1',[a.email]);
      await client.query(`insert into public.authors(submission_id,user_id,full_name,email,institution,author_order,is_corresponding) values($1,$2,$3,$4,$5,$6,$7)`,[id,match.rows[0]?.id||null,a.fullName,a.email.toLowerCase(),a.affiliation||null,i+1,i===correspondence]);
    }
    await client.query(`insert into public.user_roles(user_id,role_id) select $1,id from public.roles where name='author' on conflict do nothing`,[req.user.id]);
    const saved=await saveVersion(client,{submissionId:id,file:multipart.file,userId:req.user.id,versionType:'initial'}); objectKey=saved.objectKey; const version=saved.record;
    await client.query(`insert into public.audit_logs(actor_user_id,action,entity_type,entity_id,details) values($1,'submission.created','submission',$2,$3::jsonb)`,[req.user.id,id,JSON.stringify({paperCode:paper.rows[0].paper_code})]);
    await client.query('commit');
    res.status(201).json({data:{id,paperCode:paper.rows[0].paper_code,status:'submitted',versionNumber:version.version_number,message:'Your paper was submitted successfully.'}});
  }catch(error){await client.query('rollback').catch(()=>{});if(objectKey)await removePrivate(objectKey);next(error);}finally{client.release();}
});

router.get('/submissions/:submissionId',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.submissionId).success)return fail(res,400,'Submission ID is invalid.');
  try{
    const {rows}=await pool.query(`select s.*,c.title conference_title from public.submissions s join public.conferences c on c.id=s.conference_id where s.id=$1`,[req.params.submissionId]);
    const s=rows[0];if(!s)return fail(res,404,'Submission not found.');
    const author=await owns(pool,s.id,req.user.id);
    const reviewer=await pool.query('select 1 from public.reviews where submission_id=$1 and reviewer_id=$2',[s.id,req.user.id]);
    const manager=await canManageConference(req.user,s.conference_id);
    if(!author&&!reviewer.rows[0]&&!manager&&!req.user.roles.includes('super_admin'))return fail(res,403,'You do not have access to this submission.');
    const [authors,versions]=await Promise.all([
      pool.query(`select id,full_name,email,institution,author_order,is_corresponding from public.authors where submission_id=$1 order by author_order`,[s.id]),
      pool.query(`select id,version_number,version_type,original_filename,file_size,sha256,created_at from public.submission_versions where submission_id=$1 order by version_number desc`,[s.id]),
    ]);
    const decisions=author?await pool.query(`select id,status,author_note,created_at from public.submission_decisions where submission_id=$1 order by created_at desc`,[s.id]):{rows:[]};
    let authorReviews=[];
    if(author&&publicStatuses.includes(s.status)){
      const safe=await pool.query(`select comments_to_authors as comments,score,submitted_at from public.reviews where submission_id=$1 and status='submitted' and comments_to_authors is not null order by submitted_at`,[s.id]);authorReviews=safe.rows;
    }
    res.json({data:{...safePaper(s),authors:authors.rows,versions:versions.rows,reviews:authorReviews,decisions:decisions.rows}});
  }catch(error){next(error);}
});

router.patch('/submissions/:submissionId',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  const schema=z.object({title:z.string().trim().min(5).max(300).optional(),abstract:z.string().trim().min(50).max(20000).optional(),keywords:z.array(z.string().trim().min(1).max(60)).min(1).max(12).optional(),trackId:uuid.optional(),category:z.enum(categories).optional()}).strict().refine(v=>Object.keys(v).length>0);
  const parsed=schema.safeParse(req.body);if(!parsed.success)return fail(res,400,'Check the submission fields.');
  const client=await pool.connect();let objectKey;
  try{
    await client.query('begin');const s=await owns(client,req.params.submissionId,req.user.id);
    if(!s){await client.query('rollback');return fail(res,404,'Submission not found for this account.');}
    if(!['draft','submitted','revision_required'].includes(s.status)){await client.query('rollback');return fail(res,409,'This paper can no longer be edited.');}
    if(!await allowedDeadline(client,s.conference_id,'paper')){await client.query('rollback');return fail(res,409,'The editing deadline has passed.');}
    if(parsed.data.trackId){const t=await client.query('select 1 from public.tracks where id=$1 and conference_id=$2 and is_active=true',[parsed.data.trackId,s.conference_id]);if(!t.rows[0]){await client.query('rollback');return fail(res,400,'Choose an active track for this conference.');}}
    const values=parsed.data;const updated=await client.query(`update public.submissions set title=coalesce($1,title),abstract=coalesce($2,abstract),keywords=coalesce($3::text[],keywords),track_id=coalesce($4,track_id),category=coalesce($5,category),updated_at=now() where id=$6 returning id,paper_code,title,abstract,keywords,track_id,category,status,updated_at`,[values.title||null,values.abstract||null,values.keywords||null,values.trackId||null,values.category||null,s.id]);
    await client.query('commit');res.json({data:updated.rows[0]});
  }catch(error){await client.query('rollback').catch(()=>{});next(error);}finally{client.release();}
});

router.post('/submissions/:submissionId/versions',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  let multipart;try{multipart=await readMultipart(req);}catch(error){return fail(res,error.status||400,error.message);}
  const error=validatePdf(multipart.file);if(error)return fail(res,400,error);
  const client=await pool.connect();let objectKey;
  try{
    await client.query('begin');const s=await owns(client,req.params.submissionId,req.user.id);
    if(!s){await client.query('rollback');return fail(res,404,'Submission not found for this account.');}
    let versionType;
    if(s.status==='revision_required'||s.status==='submitted'){
      if(!await allowedDeadline(client,s.conference_id,'paper')){await client.query('rollback');return fail(res,409,'The revision deadline has passed.');}
      versionType='revision';
    }else if(s.status==='accepted'){
      if(!await allowedDeadline(client,s.conference_id,'camera_ready')){await client.query('rollback');return fail(res,409,'The camera-ready deadline has passed.');}
      versionType='camera_ready';
    }else{await client.query('rollback');return fail(res,409,'A new version is not allowed for the current paper status.');}
    const saved=await saveVersion(client,{submissionId:s.id,file:multipart.file,userId:req.user.id,versionType});objectKey=saved.objectKey;const version=saved.record;
    const nextStatus=versionType==='camera_ready'?'camera_ready':'submitted';
    await client.query('update public.submissions set status=$1,submitted_at=case when $1=\'submitted\' then now() else submitted_at end,updated_at=now() where id=$2',[nextStatus,s.id]);
    await client.query('insert into public.audit_logs(actor_user_id,action,entity_type,entity_id,details) values($1,\'submission.version_uploaded\',\'submission\',$2,$3::jsonb)',[req.user.id,s.id,JSON.stringify({version:version.version_number,type:versionType})]);
    await client.query('commit');res.status(201).json({data:{...version,status:nextStatus,message:'New manuscript version uploaded.'}});
  }catch(err){await client.query('rollback').catch(()=>{});if(objectKey)await removePrivate(objectKey);next(err);}finally{client.release();}
});

router.post('/submissions/:submissionId/withdrawal-request',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  try{
    const s=await owns(pool,req.params.submissionId,req.user.id);if(!s)return fail(res,404,'Submission not found for this account.');
    if(!['submitted','under_review','revision_required','accepted'].includes(s.status))return fail(res,409,'A withdrawal request is not allowed for this paper status.');
    const {rows}=await pool.query(`update public.submissions set status='withdrawal_requested',withdrawal_requested_at=now(),updated_at=now() where id=$1 and status=$2 returning id,status`,[s.id,s.status]);
    if(!rows[0])return fail(res,409,'Paper status changed. Refresh and try again.');
    await pool.query(`insert into public.audit_logs(actor_user_id,action,entity_type,entity_id) values($1,'submission.withdrawal_requested','submission',$2)`,[req.user.id,s.id]);res.json({data:rows[0]});
  }catch(error){next(error);}
});

router.post('/submissions/:submissionId/download-link',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  const parsed=z.object({versionId:uuid}).strict().safeParse(req.body);if(!parsed.success)return fail(res,400,'Choose a valid manuscript version.');
  try{
    const result=await pool.query(`select v.object_key,s.conference_id,s.submitted_by from public.submission_versions v join public.submissions s on s.id=v.submission_id where s.id=$1 and v.id=$2`,[req.params.submissionId,parsed.data.versionId]);
    const v=result.rows[0];if(!v)return fail(res,404,'Manuscript version not found.');
    const [author,assignments,manager]=await Promise.all([owns(pool,req.params.submissionId,req.user.id),pool.query(`select id from public.reviews where submission_id=$1 and reviewer_id=$2 and status in ('assigned','accepted','in_progress','submitted')`,[req.params.submissionId,req.user.id]),canManageConference(req.user,v.conference_id)]);
    let activeReviewer=Boolean(assignments.rows[0]);
    if(activeReviewer){const conflict=await pool.query('select 1 from public.review_conflicts where review_id=$1',[assignments.rows[0].id]);activeReviewer=!conflict.rows[0];}
    if(!author&&!activeReviewer&&!manager&&!req.user.roles.includes('super_admin'))return fail(res,403,'You do not have access to this manuscript.');
    const link=await signedLink(v.object_key);res.set('Cache-Control','no-store, private');res.json({data:link});
  }catch(error){next(error);}
});

export default router;
