import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, hasConferenceRole, requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';
import { sendWorkflowEmail } from '../auth/email.js';

const router=Router();
const uuid=z.string().uuid();
const recommendation=z.enum(['accept','minor_revision','major_revision','reject']);
const standardCriteria=[
  {criterion_key:'originality',label:'Originality',max_score:5,sort_order:1},
  {criterion_key:'technical_quality',label:'Technical quality',max_score:5,sort_order:2},
  {criterion_key:'methodology',label:'Methodology',max_score:5,sort_order:3},
  {criterion_key:'clarity',label:'Clarity',max_score:5,sort_order:4},
  {criterion_key:'relevance',label:'Relevance',max_score:5,sort_order:5},
];
function fail(res,status,message){return res.status(status).json({error:{message}});}
function dbRequired(_req,res,next){if(!pool)return fail(res,503,'Database is unavailable until DATABASE_URL is configured.');next();}
async function tx(work){const c=await pool.connect();try{await c.query('begin');const value=await work(c);await c.query('commit');return value;}catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}}
function isSuper(user){return user.roles.includes('super_admin');}
async function manager(req,conferenceId){return isSuper(req.user)||canManageConference(req.user,conferenceId);}
async function reviewerRole(userId,roles,conferenceId){
  if(roles.includes('reviewer'))return true;
  return hasConferenceRole(userId,conferenceId,'reviewer');
}
async function ensureCriteria(db,conferenceId){
  const {rows}=await db.query('select criterion_key,label,max_score,sort_order,is_active from public.conference_review_criteria where conference_id=$1 order by sort_order',[conferenceId]);
  if(rows.length)return rows;
  for(const item of standardCriteria)await db.query(`insert into public.conference_review_criteria(conference_id,criterion_key,label,max_score,sort_order) values($1,$2,$3,$4,$5) on conflict(conference_id,criterion_key) do nothing`,[conferenceId,item.criterion_key,item.label,item.max_score,item.sort_order]);
  return (await db.query('select criterion_key,label,max_score,sort_order,is_active from public.conference_review_criteria where conference_id=$1 order by sort_order',[conferenceId])).rows;
}
async function audit(db,userId,action,entityId,details={}){
  await db.query(`insert into public.audit_logs(actor_user_id,action,entity_type,entity_id,details) values($1,$2,'submission',$3,$4::jsonb)`,[userId,action,entityId,JSON.stringify(details)]);
}
async function notify(db,userId,conferenceId,title,body){
  await db.query('insert into public.notifications(user_id,conference_id,title,body,channel) values($1,$2,$3,$4,\'in_app\')',[userId,conferenceId,title,body]);
}
async function emailIfConfigured(email,subject,text){try{await sendWorkflowEmail({email,subject,text});}catch(error){console.error('Workflow email delivery failed:',error.message);}}
async function managersFor(db,conferenceId){
  const {rows}=await db.query(`select distinct u.id,u.email,u.full_name from public.users u
    left join public.conferences c on c.organizer_user_id=u.id and c.id=$1
    left join public.conference_memberships cm on cm.user_id=u.id and cm.conference_id=$1
    left join public.roles r on r.id=cm.role_id
    where c.id=$1 or r.name='conference_admin'`,[conferenceId]);
  return rows;
}
async function submissionAuthorAccounts(db,submissionId){
  const {rows}=await db.query(`select distinct u.id,u.email from public.authors a join public.users u on (u.id=a.user_id or lower(u.email)=lower(a.email)) where a.submission_id=$1`,[submissionId]);return rows;
}
async function reviewerAssignment(db,reviewId,reviewerId,lock=false){
  if(lock){const locked=await db.query('select id from public.reviews where id=$1 and reviewer_id=$2 for update',[reviewId,reviewerId]);if(!locked.rows[0])return null;}
  const {rows}=await db.query(`select r.id,r.submission_id,r.reviewer_id,r.status,r.review_round,r.due_at,s.conference_id,s.status as submission_status,s.title,s.abstract,s.keywords,s.track_id,
    c.title as conference_title,c.review_mode,t.name as track_name
    from public.reviews r join public.submissions s on s.id=r.submission_id join public.conferences c on c.id=s.conference_id left join public.tracks t on t.id=s.track_id
    where r.id=$1 and r.reviewer_id=$2`,[reviewId,reviewerId]);return rows[0]||null;
}
async function reviewerHasConflict(db,review){
  const found=await db.query(`select 1 from public.review_conflicts where review_id=$1
    union all select 1 from public.authors a join public.users u on u.id=$2 where a.submission_id=$3 and (a.user_id=$2 or lower(a.email)=lower(u.email)) limit 1`,[review.id,review.reviewer_id,review.submission_id]);return Boolean(found.rows[0]);
}
function reviewerSafeSubmission(submission,authors,versions){
  const result={id:submission.submission_id,paperCode:submission.paper_code,title:submission.title,abstract:submission.abstract,keywords:submission.keywords,track:submission.track_name,conferenceId:submission.conference_id,conferenceTitle:submission.conference_title,reviewMode:submission.review_mode,versions};
  if(submission.review_mode==='single_blind')result.authors=authors;
  return result;
}

// Reviewer profile contains no role grants; conference membership controls which reviews can be assigned.
router.get('/reviewer/profile',dbRequired,requireAuth,async(req,res,next)=>{
  try{const {rows}=await pool.query('select expertise,availability,biography,updated_at from public.reviewer_profiles where user_id=$1',[req.user.id]);res.json({data:rows[0]||{expertise:[],availability:'available',biography:''}});}catch(e){next(e);}
});
router.patch('/reviewer/profile',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  const parsed=z.object({expertise:z.array(z.string().trim().min(2).max(100)).max(40),availability:z.enum(['available','unavailable']),biography:z.string().trim().max(3000).nullable().optional()}).strict().safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Check reviewer expertise and availability fields.');
  try{const {rows}=await pool.query(`insert into public.reviewer_profiles(user_id,expertise,availability,biography,updated_at) values($1,$2,$3,$4,now())
    on conflict(user_id) do update set expertise=excluded.expertise,availability=excluded.availability,biography=excluded.biography,updated_at=now()
    returning expertise,availability,biography,updated_at`,[req.user.id,parsed.data.expertise,parsed.data.availability,parsed.data.biography||null]);res.json({data:rows[0]});}catch(e){next(e);}
});

router.get('/reviewer/assignments',dbRequired,requireAuth,async(req,res,next)=>{
  try{
    const {rows}=await pool.query(`select r.id,r.submission_id,r.status,r.review_round,r.assigned_at,r.due_at,r.submitted_at,
      (r.due_at<now() and r.status not in ('submitted','declined','cancelled','conflict_declared')) as overdue,
      s.paper_code,s.title,s.abstract,s.keywords,s.status as paper_status,s.track_id,t.name as track_name,
      c.id conference_id,c.title conference_title,c.review_mode
      from public.reviews r join public.submissions s on s.id=r.submission_id join public.conferences c on c.id=s.conference_id left join public.tracks t on t.id=s.track_id
      where r.reviewer_id=$1 order by case when r.status='submitted' then 1 else 0 end,r.due_at nulls last,r.assigned_at desc`,[req.user.id]);
    const data=rows.map(row=>['declined','cancelled','conflict_declared'].includes(row.status)?{
      id:row.id,status:row.status,review_round:row.review_round,assigned_at:row.assigned_at,due_at:row.due_at,submitted_at:row.submitted_at,overdue:false,conference_id:row.conference_id,conference_title:row.conference_title,review_mode:row.review_mode,
    }:row);
    res.json({data});
  }catch(e){next(e);}
});

router.get('/reviewer/assignments/:reviewId',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.reviewId).success)return fail(res,400,'Review assignment ID is invalid.');
  try{
    const assignment=await reviewerAssignment(pool,req.params.reviewId,req.user.id);
    if(!assignment)return fail(res,404,'Review assignment not found.');
    if(['declined','cancelled','conflict_declared'].includes(assignment.status)||await reviewerHasConflict(pool,assignment))return fail(res,403,'This assignment is unavailable because of its status or a conflict declaration.');
    const [paper,authors,versions,criteria]=await Promise.all([
      pool.query(`select s.id submission_id,s.paper_code,s.title,s.abstract,s.keywords,c.id conference_id,c.title conference_title,c.review_mode,t.name track_name from public.submissions s join public.conferences c on c.id=s.conference_id left join public.tracks t on t.id=s.track_id where s.id=$1`,[assignment.submission_id]),
      pool.query(`select full_name,institution from public.authors where submission_id=$1 order by author_order`,[assignment.submission_id]),
      pool.query(`select id,version_number,version_type,file_size,created_at from public.submission_versions where submission_id=$1 order by version_number desc`,[assignment.submission_id]),
      ensureCriteria(pool,assignment.conference_id),
    ]);
    const ownReview=await pool.query(`select id,status,criterion_scores,overall_recommendation,comments_to_authors,confidential_comments,submitted_at,updated_at from public.reviews where id=$1 and reviewer_id=$2`,[assignment.id,req.user.id]);
    res.json({data:{assignment:{id:assignment.id,status:assignment.status,reviewRound:assignment.review_round,dueAt:assignment.due_at,overdue:assignment.due_at&&new Date(assignment.due_at)<new Date()&&assignment.status!=='submitted'},submission:reviewerSafeSubmission(paper.rows[0],authors.rows,versions.rows),criteria,review:ownReview.rows[0]}});
  }catch(e){next(e);}
});

router.patch('/reviewer/assignments/:reviewId/status',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.reviewId).success)return fail(res,400,'Review assignment ID is invalid.');
  const parsed=z.object({status:z.enum(['accepted','declined'])}).strict().safeParse(req.body);if(!parsed.success)return fail(res,400,'Choose accept or decline for this review assignment.');
  try{
    const result=await tx(async db=>{
      const assignment=await reviewerAssignment(db,req.params.reviewId,req.user.id,true);if(!assignment)return null;
      if(assignment.status!=='assigned')throw Object.assign(new Error('This assignment can no longer be accepted or declined.'),{status:409});
      const {rows}=await db.query('update public.reviews set status=$1,updated_at=now() where id=$2 and status=\'assigned\' returning id,status',[parsed.data.status,assignment.id]);
      await audit(db,req.user.id,`review.${parsed.data.status}` ,assignment.submission_id,{reviewId:assignment.id,round:assignment.review_round});return rows[0];
    });if(!result)return fail(res,404,'Review assignment not found.');res.json({data:result});
  }catch(e){next(e);}
});

router.post('/reviewer/assignments/:reviewId/conflict',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.reviewId).success)return fail(res,400,'Review assignment ID is invalid.');
  const parsed=z.object({reason:z.string().trim().min(10).max(3000)}).strict().safeParse(req.body);if(!parsed.success)return fail(res,400,'Explain the conflict in 10 to 3000 characters.');
  try{
    const result=await tx(async db=>{
      const assignment=await reviewerAssignment(db,req.params.reviewId,req.user.id,true);if(!assignment)return null;
      if(['declined','cancelled','conflict_declared'].includes(assignment.status))throw Object.assign(new Error('This assignment is no longer active.'),{status:409});
      await db.query(`insert into public.review_conflicts(review_id,declared_by,reason) values($1,$2,$3) on conflict(review_id) do update set declared_by=excluded.declared_by,reason=excluded.reason,created_at=now()`,[assignment.id,req.user.id,parsed.data.reason]);
      await db.query(`update public.reviews set status='conflict_declared',updated_at=now() where id=$1`,[assignment.id]);
      await audit(db,req.user.id,'review.conflict_declared',assignment.submission_id,{reviewId:assignment.id,round:assignment.review_round});
      const managers=await managersFor(db,assignment.conference_id);for(const m of managers)await notify(db,m.id,assignment.conference_id,'Reviewer conflict declared',`A reviewer declared a conflict for paper ${assignment.title}. Reassign this review.`);
      return {id:assignment.id,status:'conflict_declared',managers,conferenceId:assignment.conference_id,title:assignment.title};
    });
    if(!result)return fail(res,404,'Review assignment not found.');for(const m of result.managers)void emailIfConfigured(m.email,'Reviewer conflict declared',`A reviewer declared a conflict for paper ${result.title}. Please review the assignment in the organizer workspace.`);res.json({data:{id:result.id,status:result.status}});
  }catch(e){next(e);}
});

router.put('/reviewer/assignments/:reviewId/review',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.reviewId).success)return fail(res,400,'Review assignment ID is invalid.');
  const parsed=z.object({action:z.enum(['draft','submit']),criterionScores:z.record(z.number().finite()).default({}),recommendation:recommendation.nullable().optional(),commentsToAuthors:z.string().trim().max(12000).nullable().optional(),confidentialComments:z.string().trim().max(12000).nullable().optional()}).strict().safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Review fields are invalid. Use numeric scores and separate author/editor comments.');
  try{
    const saved=await tx(async db=>{
      const assignment=await reviewerAssignment(db,req.params.reviewId,req.user.id,true);if(!assignment)return null;
      if(!['assigned','accepted','in_progress'].includes(assignment.status)||await reviewerHasConflict(db,assignment))throw Object.assign(new Error('This review is not available for editing.'),{status:409});
      const criteria=(await ensureCriteria(db,assignment.conference_id)).filter(c=>c.is_active);
      const limits=new Map(criteria.map(c=>[c.criterion_key,Number(c.max_score)]));
      for(const [key,value] of Object.entries(parsed.data.criterionScores))if(!limits.has(key)||!Number.isFinite(value)||value<1||value>limits.get(key))throw Object.assign(new Error(`Score for ${key} must be between 1 and ${limits.get(key)||'the configured maximum'}.`),{status:400});
      if(parsed.data.action==='submit'){
        const missing=criteria.filter(c=>!Object.hasOwn(parsed.data.criterionScores,c.criterion_key));
        if(missing.length)throw Object.assign(new Error(`Complete all review scores: ${missing.map(c=>c.label).join(', ')}.`),{status:400});
        if(!parsed.data.recommendation)throw Object.assign(new Error('Select an overall recommendation.'),{status:400});
        if(!parsed.data.commentsToAuthors?.trim())throw Object.assign(new Error('Provide feedback for the authors before submitting.'),{status:400});
      }
      const values=Object.entries(parsed.data.criterionScores);const average=values.length?Math.round(values.reduce((total,[key,value])=>total+value/limits.get(key),0)/values.length*10000)/100:null;
      const status=parsed.data.action==='submit'?'submitted':'in_progress';
      const {rows}=await db.query(`update public.reviews set status=$1,criterion_scores=$2::jsonb,score=$3,overall_recommendation=$4,recommendation=$4,
        comments_to_authors=$5,confidential_comments=$6,submitted_at=case when $1='submitted' then now() else null end,updated_at=now()
        where id=$7 and reviewer_id=$8 returning id,status,review_round,criterion_scores,score,overall_recommendation,comments_to_authors,confidential_comments,submitted_at`,
      [status,JSON.stringify(parsed.data.criterionScores),average,parsed.data.recommendation||null,parsed.data.commentsToAuthors||null,parsed.data.confidentialComments||null,assignment.id,req.user.id]);
      if(parsed.data.action==='submit')await audit(db,req.user.id,'review.submitted',assignment.submission_id,{reviewId:assignment.id,round:assignment.review_round,recommendation:parsed.data.recommendation});
      else await audit(db,req.user.id,'review.draft_saved',assignment.submission_id,{reviewId:assignment.id,round:assignment.review_round});
      return rows[0];
    });if(!saved)return fail(res,404,'Review assignment not found.');res.json({data:saved});
  }catch(e){next(e);}
});

// Organizer-side settings, candidates, assignments and review summaries.
router.get('/admin/conferences/:conferenceId/review-settings',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success)return fail(res,400,'Conference ID is invalid.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const c=await pool.query('select review_mode from public.conferences where id=$1',[req.params.conferenceId]);if(!c.rows[0])return fail(res,404,'Conference not found.');
    res.json({data:{reviewMode:c.rows[0].review_mode,criteria:await ensureCriteria(pool,req.params.conferenceId)}});
  }catch(e){next(e);}
});
router.put('/admin/conferences/:conferenceId/review-settings',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success)return fail(res,400,'Conference ID is invalid.');
  const criteriaSchema=z.array(z.object({criterionKey:z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),label:z.string().trim().min(2).max(120),maxScore:z.number().int().min(2).max(10),isActive:z.boolean().default(true)}).strict()).min(1).max(20);
  const parsed=z.object({reviewMode:z.enum(['single_blind','double_blind']),criteria:criteriaSchema}).strict().safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Set a review mode and one or more valid scoring criteria.');
  if(new Set(parsed.data.criteria.map(c=>c.criterionKey)).size!==parsed.data.criteria.length)return fail(res,400,'Review criterion keys must be unique.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const out=await tx(async db=>{
      const existing=await db.query('select 1 from public.reviews r join public.submissions s on s.id=r.submission_id where s.conference_id=$1 limit 1',[req.params.conferenceId]);if(existing.rows[0])throw Object.assign(new Error('Review settings cannot change after reviewer assignments begin.'),{status:409});
      const conf=await db.query('update public.conferences set review_mode=$1,updated_at=now() where id=$2 returning review_mode',[parsed.data.reviewMode,req.params.conferenceId]);if(!conf.rows[0])return null;
      await db.query('delete from public.conference_review_criteria where conference_id=$1',[req.params.conferenceId]);
      for(let i=0;i<parsed.data.criteria.length;i++){const c=parsed.data.criteria[i];await db.query(`insert into public.conference_review_criteria(conference_id,criterion_key,label,max_score,sort_order,is_active) values($1,$2,$3,$4,$5,$6)`,[req.params.conferenceId,c.criterionKey,c.label,c.maxScore,i+1,c.isActive]);}
      await db.query(`insert into public.audit_logs(actor_user_id,action,entity_type,entity_id,details) values($1,'review.settings_updated','conference',$2,$3::jsonb)`,[req.user.id,req.params.conferenceId,JSON.stringify({reviewMode:parsed.data.reviewMode,criteria:parsed.data.criteria.map(c=>c.criterionKey)})]);
      return {reviewMode:conf.rows[0].review_mode,criteria:(await db.query('select criterion_key,label,max_score,sort_order,is_active from public.conference_review_criteria where conference_id=$1 order by sort_order',[req.params.conferenceId])).rows};
    });if(!out)return fail(res,404,'Conference not found.');res.json({data:out});
  }catch(e){next(e);}
});

router.get('/admin/conferences/:conferenceId/review-candidates',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success)return fail(res,400,'Conference ID is invalid.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const [papers,reviewRows,decisionRows]=await Promise.all([
      pool.query(`select s.id,s.paper_code,s.title,s.status,s.track_id,t.name track_name,s.created_at from public.submissions s left join public.tracks t on t.id=s.track_id where s.conference_id=$1 and s.status in ('submitted','under_review') order by s.created_at desc`,[req.params.conferenceId]),
      pool.query(`select r.submission_id,r.review_round,r.status from public.reviews r join public.submissions s on s.id=r.submission_id where s.conference_id=$1`,[req.params.conferenceId]),
      pool.query(`select d.submission_id,d.status from public.submission_decisions d join public.submissions s on s.id=d.submission_id where s.conference_id=$1 order by d.created_at desc`,[req.params.conferenceId]),
    ]);
    const reviewMap=new Map();for(const r of reviewRows.rows){const x=reviewMap.get(r.submission_id)||{assignment_count:0,latest_round:null};if(!['cancelled','declined','conflict_declared'].includes(r.status))x.assignment_count++;x.latest_round=Math.max(x.latest_round||0,r.review_round);reviewMap.set(r.submission_id,x);}
    const latestDecision=new Map();for(const d of decisionRows.rows)if(!latestDecision.has(d.submission_id))latestDecision.set(d.submission_id,d.status);
    res.json({data:papers.rows.map(s=>({...s,assignment_count:reviewMap.get(s.id)?.assignment_count||0,latest_round:reviewMap.get(s.id)?.latest_round||null,latest_decision:latestDecision.get(s.id)||null}))});
  }catch(e){next(e);}
});
router.get('/admin/conferences/:conferenceId/reviewers',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success||!uuid.safeParse(req.query.submissionId).success)return fail(res,400,'Conference or submission ID is invalid.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const sub=await pool.query('select id,conference_id from public.submissions where id=$1',[req.query.submissionId]);if(!sub.rows[0]||sub.rows[0].conference_id!==req.params.conferenceId)return fail(res,404,'Submission not found for this conference.');
    const [users,globalRoles,conferenceRoles,authors]=await Promise.all([
      pool.query(`select u.id,u.full_name,u.email,u.institution,coalesce(rp.expertise,'{}') expertise,coalesce(rp.availability,'available') availability from public.users u left join public.reviewer_profiles rp on rp.user_id=u.id where u.is_active=true order by u.full_name`),
      pool.query(`select ur.user_id from public.user_roles ur join public.roles r on r.id=ur.role_id where r.name='reviewer'`),
      pool.query(`select cm.user_id from public.conference_memberships cm join public.roles r on r.id=cm.role_id where cm.conference_id=$1 and r.name='reviewer'`,[req.params.conferenceId]),
      pool.query(`select user_id,email from public.authors where submission_id=$1`,[req.query.submissionId]),
    ]);
    const eligible=new Set([...globalRoles.rows,...conferenceRoles.rows].map(x=>x.user_id));
    const authorsByUser=new Set(authors.rows.map(x=>x.user_id).filter(Boolean));const authorEmails=new Set(authors.rows.map(x=>String(x.email).toLowerCase()));
    res.json({data:users.rows.filter(x=>eligible.has(x.id)&&x.availability==='available'&&!authorsByUser.has(x.id)&&!authorEmails.has(String(x.email).toLowerCase()))});
  }catch(e){next(e);}
});
router.post('/admin/conferences/:conferenceId/review-assignments',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success)return fail(res,400,'Conference ID is invalid.');
  const parsed=z.object({submissionId:uuid,reviewerId:uuid,dueAt:z.string().datetime().nullable().optional(),reviewRound:z.number().int().min(1).max(20).default(1)}).strict().safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Choose a paper, reviewer, valid due date, and review round.');
  if(parsed.data.dueAt&&new Date(parsed.data.dueAt)<=new Date())return fail(res,400,'The reviewer deadline must be in the future.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const created=await tx(async db=>{
      const {rows}=await db.query('select id,conference_id,status,title from public.submissions where id=$1 for update',[parsed.data.submissionId]);const s=rows[0];if(!s||s.conference_id!==req.params.conferenceId)return null;
      if(!['submitted','under_review'].includes(s.status))throw Object.assign(new Error('Only submitted or in-review papers can be assigned.'),{status:409});
      const reviewer=await db.query(`select id,email,full_name from public.users where id=$1 and is_active=true`,[parsed.data.reviewerId]);
      if(!reviewer.rows[0])throw Object.assign(new Error('The selected account is not an active reviewer for this conference.'),{status:400});
      const [globalRole,conferenceRole]=await Promise.all([
        db.query(`select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=$1 and r.name='reviewer'`,[parsed.data.reviewerId]),
        db.query(`select 1 from public.conference_memberships cm join public.roles r on r.id=cm.role_id where cm.user_id=$1 and cm.conference_id=$2 and r.name='reviewer'`,[parsed.data.reviewerId,req.params.conferenceId]),
      ]);
      if(!globalRole.rows[0]&&!conferenceRole.rows[0])throw Object.assign(new Error('The selected account is not an active reviewer for this conference.'),{status:400});
      const profile=await db.query("select availability from public.reviewer_profiles where user_id=$1",[parsed.data.reviewerId]);if(profile.rows[0]?.availability==='unavailable')throw Object.assign(new Error('This reviewer is marked unavailable.'),{status:409});
      const coauthor=await db.query('select 1 from public.authors a join public.users u on u.id=$2 where a.submission_id=$1 and (a.user_id=$2 or lower(a.email)=lower(u.email))',[s.id,parsed.data.reviewerId]);if(coauthor.rows[0])throw Object.assign(new Error('A paper author cannot review their own submission.'),{status:409});
      const criteria=await db.query('select 1 from public.reviews where submission_id=$1 and reviewer_id=$2 and review_round=$3',[s.id,parsed.data.reviewerId,parsed.data.reviewRound]);if(criteria.rows[0])throw Object.assign(new Error('This reviewer already has an assignment in that review round.'),{status:409});
      const review=await db.query(`insert into public.reviews(submission_id,reviewer_id,status,due_at,review_round) values($1,$2,'assigned',$3,$4) returning id,status,review_round,due_at`,[s.id,parsed.data.reviewerId,parsed.data.dueAt||null,parsed.data.reviewRound]);
      if(s.status==='submitted')await db.query("update public.submissions set status='under_review',updated_at=now() where id=$1 and status='submitted'",[s.id]);
      await notify(db,reviewer.rows[0].id,s.conference_id,'New paper review assigned',`You have been assigned paper ${s.title}.`);
      await audit(db,req.user.id,'review.assigned',s.id,{reviewId:review.rows[0].id,reviewerId:reviewer.rows[0].id,round:parsed.data.reviewRound,dueAt:parsed.data.dueAt||null});
      return {...review.rows[0],submissionId:s.id,reviewer:reviewer.rows[0],title:s.title,conferenceId:s.conference_id};
    });if(!created)return fail(res,404,'Submission not found for this conference.');
    void emailIfConfigured(created.reviewer.email,'BUP peer review assignment',`A paper has been assigned to you for review. Sign in to your reviewer dashboard to read the manuscript and submit your review. Deadline: ${created.due_at||'not set'}.`);
    res.status(201).json({data:{id:created.id,submissionId:created.submissionId,reviewerId:created.reviewer.id,status:created.status,reviewRound:created.review_round,dueAt:created.due_at}});
  }catch(e){next(e);}
});

router.get('/admin/conferences/:conferenceId/review-summary',dbRequired,requireAuth,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success)return fail(res,400,'Conference ID is invalid.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Conference Organizer access is required.');
    const [reviews,decisions]=await Promise.all([
      pool.query(`select r.id,r.submission_id,r.reviewer_id,u.full_name reviewer_name,u.email reviewer_email,r.status,r.review_round,r.due_at,r.submitted_at,r.criterion_scores,r.score,r.overall_recommendation,r.comments_to_authors,r.confidential_comments,
        (r.due_at<now() and r.status not in ('submitted','declined','cancelled','conflict_declared')) overdue,s.paper_code,s.title,s.status paper_status,
        rc.reason conflict_reason
        from public.reviews r join public.submissions s on s.id=r.submission_id join public.users u on u.id=r.reviewer_id left join public.review_conflicts rc on rc.review_id=r.id
        where s.conference_id=$1 order by s.created_at desc,r.review_round,u.full_name`,[req.params.conferenceId]),
      pool.query(`select d.*,s.paper_code,s.title,u.full_name decided_by_name from public.submission_decisions d join public.submissions s on s.id=d.submission_id join public.users u on u.id=d.decided_by where s.conference_id=$1 order by d.created_at desc`,[req.params.conferenceId]),
    ]);
    res.json({data:{reviews:reviews.rows,decisions:decisions.rows,criteria:await ensureCriteria(pool,req.params.conferenceId)}});
  }catch(e){next(e);}
});

router.post('/admin/conferences/:conferenceId/submissions/:submissionId/decision',dbRequired,requireAuth,requireCsrf,async(req,res,next)=>{
  if(!uuid.safeParse(req.params.conferenceId).success||!uuid.safeParse(req.params.submissionId).success)return fail(res,400,'Conference or submission ID is invalid.');
  const parsed=z.object({status:z.enum(['revision_required','accepted','rejected']),authorNote:z.string().trim().max(10000).nullable().optional(),editorNote:z.string().trim().max(10000).nullable().optional(),reviewRound:z.number().int().min(1).max(20).default(1)}).strict().safeParse(req.body);
  if(!parsed.success)return fail(res,400,'Choose an editorial decision and valid notes.');
  try{if(!await manager(req,req.params.conferenceId))return fail(res,403,'Only the Conference Organizer can record an editorial decision.');
    const result=await tx(async db=>{
      const {rows}=await db.query('select id,conference_id,status,paper_code,title from public.submissions where id=$1 for update',[req.params.submissionId]);const s=rows[0];if(!s||s.conference_id!==req.params.conferenceId)return null;
      const allowed={submitted:['revision_required','accepted','rejected'],under_review:['revision_required','accepted','rejected'],revision_required:['revision_required','accepted','rejected']}[s.status]||[];
      if(!allowed.includes(parsed.data.status))throw Object.assign(new Error(`Cannot record a decision while this paper is ${s.status.replaceAll('_',' ')}.`),{status:409});
      const currentReviews=await db.query("select count(*)::int as submitted_count from public.reviews where submission_id=$1 and review_round=$2 and status='submitted'",[s.id,parsed.data.reviewRound]);
      const {rows:decision}=await db.query(`insert into public.submission_decisions(submission_id,review_round,status,author_note,editor_note,decided_by) values($1,$2,$3,$4,$5,$6) returning id,status,review_round,created_at`,[s.id,parsed.data.reviewRound,parsed.data.status,parsed.data.authorNote||null,parsed.data.editorNote||null,req.user.id]);
      await db.query('update public.submissions set status=$1,decision_note=$2,updated_at=now() where id=$3',[parsed.data.status,parsed.data.authorNote||null,s.id]);
      await audit(db,req.user.id,'submission.editorial_decision',s.id,{decisionId:decision[0].id,from:s.status,to:parsed.data.status,reviewRound:parsed.data.reviewRound,submittedReviews:currentReviews.rows[0].submitted_count});
      const authors=await submissionAuthorAccounts(db,s.id);for(const author of authors)await notify(db,author.id,s.conference_id,`Paper ${parsed.data.status.replaceAll('_',' ')}`,`An editorial decision for ${s.paper_code||s.title} is available in your author workspace.`);
      return {decision:decision[0],authors,conferenceId:s.conference_id,paperCode:s.paper_code,title:s.title,authorNote:parsed.data.authorNote||''};
    });if(!result)return fail(res,404,'Submission not found for this conference.');
    for(const author of result.authors)void emailIfConfigured(author.email,`BUP paper decision: ${result.paperCode||result.title}`,`An editorial decision is available in your author workspace. Sign in to view the decision and author-facing note.\n\n${result.authorNote}`);
    res.status(201).json({data:result.decision});
  }catch(e){next(e);}
});

export default router;
