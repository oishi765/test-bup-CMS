import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';
import { generateCertificatePdf } from '../utils/pdf.js';
import { createNotification } from '../utils/notifications.js';

const router = Router();
const uuid = z.string().uuid();
const certTypes = ['attendee', 'author', 'presenter', 'reviewer', 'organizer'];

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function dbRequired(_req, res, next) {
  if (!pool) return fail(res, 503, 'Database is unavailable.');
  next();
}

function isSuper(user) {
  return user?.roles?.includes('super_admin');
}

async function isManager(req, conferenceId) {
  return isSuper(req.user) || canManageConference(req.user, conferenceId);
}

async function audit(db, userId, action, entityId, details = {}) {
  await db.query(
    `insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, details)
     values($1, $2, 'certificate', $3, $4::jsonb)`,
    [userId, action, entityId, JSON.stringify(details)]
  );
}

/**
 * Generate a unique standardized Certificate Number
 */
function createCertificateNumber(conferenceAcronym, type) {
  const year = new Date().getFullYear();
  const cleanAcronym = (conferenceAcronym || 'BUP').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const typeCode = type.slice(0, 4).toUpperCase();
  const randomHex = randomBytes(3).toString('hex').toUpperCase();
  return `BUP-CERT-${year}-${cleanAcronym}-${typeCode}-${randomHex}`;
}

/**
 * Check user eligibility for each certificate type
 */
export async function evaluateEligibility(db, conferenceId, userId) {
  const userRes = await db.query('select id, full_name, email from public.users where id = $1', [userId]);
  const userEmail = userRes.rows[0]?.email || '';

  const authoredRes = await db.query(
    'select submission_id from public.authors where user_id = $1 or lower(email) = lower($2)',
    [userId, userEmail]
  );
  const authoredIds = authoredRes.rows.map((r) => r.submission_id);

  const [
    confRes,
    regRes,
    attendanceRes,
    presentationRes,
    authorPaperRes,
    reviewRes,
    organizerRes,
    existingCertsRes,
  ] = await Promise.all([
    db.query('select id, title, acronym, status from public.conferences where id = $1', [conferenceId]),
    db.query('select id, status, payment_status from public.registrations where conference_id = $1 and user_id = $2 and status in (\'confirmed\', \'pending\')', [conferenceId, userId]),
    db.query('select a.id from public.attendance a join public.sessions s on s.id = a.session_id where s.conference_id = $1 and a.user_id = $2', [conferenceId, userId]),
    db.query(
      `select ss.id, sub.title, sub.paper_code
       from public.session_submissions ss
       join public.submissions sub on sub.id = ss.submission_id
       where sub.conference_id = $1 and ss.presenter_user_id = $2 and ss.presentation_status = 'completed'`,
      [conferenceId, userId]
    ),
    db.query(
      `select s.id, s.paper_code, s.title
       from public.submissions s
       where s.conference_id = $1 and s.status in ('accepted', 'camera_ready', 'finalized')
       and (s.submitted_by = $2 or s.id = any($3::uuid[]))`,
      [conferenceId, userId, authoredIds]
    ),
    db.query(
      `select r.id
       from public.reviews r
       join public.submissions s on s.id = r.submission_id
       where s.conference_id = $1 and r.reviewer_id = $2 and r.status = 'submitted'`,
      [conferenceId, userId]
    ),
    db.query(
      `select 1 from public.conferences c where c.id = $1 and c.organizer_user_id = $2
       union
       select 1 from public.conference_memberships cm
       join public.roles ro on ro.id = cm.role_id
       where cm.conference_id = $1 and cm.user_id = $2 and ro.name in ('conference_admin', 'session_chair')`,
      [conferenceId, userId]
    ),
    db.query(
      `select id, certificate_type, certificate_number, is_revoked from public.certificates where conference_id = $1 and user_id = $2`,
      [conferenceId, userId]
    ),
  ]);

  const existingByType = existingCertsRes.rows.reduce((acc, c) => {
    acc[c.certificate_type] = c;
    return acc;
  }, {});

  const hasRegistration = regRes.rows.length > 0;
  const attendedCount = attendanceRes.rows.length;
  const completedPresentations = presentationRes.rows.length;
  const acceptedPapers = authorPaperRes.rows.length;
  const completedReviews = reviewRes.rows.length;
  const isOrganizer = organizerRes.rows.length > 0;

  return {
    attendee: {
      eligible: hasRegistration && attendedCount > 0,
      reason: !hasRegistration
        ? 'Valid conference registration required.'
        : attendedCount === 0
        ? 'Session attendance check-in required.'
        : `Verified registration and ${attendedCount} session attendance check-in(s).`,
      issued: Boolean(existingByType.attendee),
      certificate: existingByType.attendee || null,
    },
    presenter: {
      eligible: completedPresentations > 0,
      reason: completedPresentations > 0
        ? `Delivered ${completedPresentations} completed presentation(s).`
        : 'Must have at least one scheduled presentation marked as completed by session chair.',
      issued: Boolean(existingByType.presenter),
      certificate: existingByType.presenter || null,
    },
    author: {
      eligible: acceptedPapers > 0,
      reason: acceptedPapers > 0
        ? `Co-authored/authored ${acceptedPapers} accepted paper(s).`
        : 'Must author an accepted paper in this conference.',
      issued: Boolean(existingByType.author),
      certificate: existingByType.author || null,
    },
    reviewer: {
      eligible: completedReviews > 0,
      reason: completedReviews > 0
        ? `Submitted ${completedReviews} complete peer review(s).`
        : 'Must submit at least one complete peer review.',
      issued: Boolean(existingByType.reviewer),
      certificate: existingByType.reviewer || null,
    },
    organizer: {
      eligible: isOrganizer,
      reason: isOrganizer
        ? 'Recognized as an organizing committee member or session chair.'
        : 'Must be designated in the organizing committee or session chairs.',
      issued: Boolean(existingByType.organizer),
      certificate: existingByType.organizer || null,
    },
  };
}

// -------------------------------------------------------------
// User Certificate Endpoints
// -------------------------------------------------------------

// My certificates across all conferences
router.get('/certificates/my', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select cert.id, cert.certificate_type, cert.certificate_number, cert.issued_at,
              cert.is_revoked, cert.revocation_reason, cert.revoked_at,
              c.id as conference_id, c.title as conference_title, c.acronym as conference_acronym
       from public.certificates cert
       join public.conferences c on c.id = cert.conference_id
       where cert.user_id = $1
       order by cert.issued_at desc`,
      [req.user.id]
    );

    const data = rows.map((r) => ({
      ...r,
      downloadUrl: `/api/certificates/${r.id}/download`,
    }));

    res.json({ data });
  } catch (e) {
    next(e);
  }
});

// Download Certificate PDF
router.get('/certificates/:certId/download', dbRequired, async (req, res, next) => {
  if (!uuid.safeParse(req.params.certId).success) return fail(res, 400, 'Invalid certificate ID.');
  try {
    const { rows } = await pool.query(
      `select cert.*,
              u.full_name, u.institution, u.email,
              c.title as conference_title, c.acronym, c.start_date, c.end_date, c.venue,
              ct.title as template_title, ct.subtitle as template_subtitle,
              ct.body_text as template_body, ct.signatory_name, ct.signatory_title
       from public.certificates cert
       join public.users u on u.id = cert.user_id
       join public.conferences c on c.id = cert.conference_id
       left join public.certificate_templates ct on ct.conference_id = cert.conference_id and ct.certificate_type = cert.certificate_type and ct.is_active = true
       where cert.id = $1`,
      [req.params.certId]
    );

    const cert = rows[0];
    if (!cert) return fail(res, 404, 'Certificate not found.');

    const conference = {
      id: cert.conference_id,
      title: cert.conference_title,
      acronym: cert.acronym,
      start_date: cert.start_date,
      end_date: cert.end_date,
      venue: cert.venue,
    };

    const user = {
      full_name: cert.full_name,
      institution: cert.institution,
      email: cert.email,
    };

    const template = {
      title: cert.template_title,
      subtitle: cert.template_subtitle,
      body_text: cert.template_body,
      signatory_name: cert.signatory_name,
      signatory_title: cert.signatory_title,
    };

    const pdfBuffer = await generateCertificatePdf({
      certificate: cert,
      conference,
      user,
      template,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="BUP-Certificate-${cert.certificate_number}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (e) {
    next(e);
  }
});

// Check eligibility for a specific conference
router.get('/conferences/:conferenceId/certificates/eligibility', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    const data = await evaluateEligibility(pool, req.params.conferenceId, req.user.id);
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

// Claim eligible certificate
router.post('/conferences/:conferenceId/certificates/claim', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const schema = z.object({
    certificateType: z.enum(certTypes),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid certificate type.');

  const type = parsed.data.certificateType;

  try {
    const confRes = await pool.query('select id, title, acronym, status from public.conferences where id = $1', [req.params.conferenceId]);
    const conf = confRes.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');

    const eligibility = await evaluateEligibility(pool, req.params.conferenceId, req.user.id);
    const targetEligibility = eligibility[type];

    if (targetEligibility.issued) {
      return fail(res, 409, `You already have an issued ${type} certificate for this conference.`);
    }

    if (!targetEligibility.eligible) {
      return fail(res, 403, `You are not eligible for a ${type} certificate: ${targetEligibility.reason}`);
    }

    const certNumber = createCertificateNumber(conf.acronym, type);

    const { rows } = await pool.query(
      `insert into public.certificates(
         conference_id, user_id, certificate_type, certificate_number, issued_at
       ) values($1, $2, $3, $4, now())
       returning id, conference_id, user_id, certificate_type, certificate_number, issued_at, is_revoked`,
      [conf.id, req.user.id, type, certNumber]
    );

    const createdCert = rows[0];

    await audit(pool, req.user.id, 'certificate.claimed', createdCert.id, {
      certificateNumber: certNumber,
      certificateType: type,
      conferenceId: conf.id,
    });

    await createNotification(pool, {
      userId: req.user.id,
      conferenceId: conf.id,
      title: 'Certificate Issued',
      body: `Your official ${type} certificate (${certNumber}) for "${conf.title}" is ready for download.`,
      category: 'certificate',
      metadata: { certificateId: createdCert.id, certificateNumber: certNumber },
    });

    res.status(201).json({
      data: {
        ...createdCert,
        downloadUrl: `/api/certificates/${createdCert.id}/download`,
      },
    });
  } catch (e) {
    if (e.code === '23505') {
      return fail(res, 409, 'A certificate of this type was already issued for this conference.');
    }
    next(e);
  }
});

// -------------------------------------------------------------
// Admin Certificate Management Endpoints
// -------------------------------------------------------------

// List all conference certificates with filters
router.get('/admin/conferences/:conferenceId/certificates', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const search = (req.query.search || '').trim();
    const type = (req.query.type || '').trim();
    const status = (req.query.status || '').trim(); // 'active' or 'revoked'

    const conditions = ['cert.conference_id = $1'];
    const params = [req.params.conferenceId];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.full_name ilike $${params.length} or u.email ilike $${params.length} or cert.certificate_number ilike $${params.length})`);
    }

    if (type && certTypes.includes(type)) {
      params.push(type);
      conditions.push(`cert.certificate_type = $${params.length}`);
    }

    if (status === 'active') {
      conditions.push('cert.is_revoked = false');
    } else if (status === 'revoked') {
      conditions.push('cert.is_revoked = true');
    }

    const { rows } = await pool.query(
      `select cert.id, cert.certificate_number, cert.certificate_type, cert.issued_at,
              cert.is_revoked, cert.revoked_at, cert.revocation_reason,
              u.id as user_id, u.full_name, u.email, u.institution,
              rev_user.full_name as revoked_by_name
       from public.certificates cert
       join public.users u on u.id = cert.user_id
       left join public.users rev_user on rev_user.id = cert.revoked_by
       where ${conditions.join(' and ')}
       order by cert.issued_at desc`,
      params
    );

    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

// Admin issue certificate (with optional approval override)
router.post('/admin/conferences/:conferenceId/certificates/issue', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const schema = z.object({
    userId: uuid,
    certificateType: z.enum(certTypes),
    overrideEligibility: z.boolean().default(false),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid issuance parameters.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const confRes = await pool.query('select id, title, acronym from public.conferences where id = $1', [req.params.conferenceId]);
    const conf = confRes.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');

    if (!parsed.data.overrideEligibility) {
      const eligibility = await evaluateEligibility(pool, req.params.conferenceId, parsed.data.userId);
      const target = eligibility[parsed.data.certificateType];
      if (target.issued) return fail(res, 409, 'Certificate already issued for this user.');
      if (!target.eligible) return fail(res, 400, `User is not eligible: ${target.reason}`);
    }

    const certNumber = createCertificateNumber(conf.acronym, parsed.data.certificateType);

    const { rows } = await pool.query(
      `insert into public.certificates(
         conference_id, user_id, certificate_type, certificate_number, issued_at
       ) values($1, $2, $3, $4, now())
       returning id, conference_id, user_id, certificate_type, certificate_number, issued_at, is_revoked`,
      [conf.id, parsed.data.userId, parsed.data.certificateType, certNumber]
    );

    const createdCert = rows[0];

    await audit(pool, req.user.id, 'certificate.issued_by_admin', createdCert.id, {
      recipientUserId: parsed.data.userId,
      certificateNumber: certNumber,
      certificateType: parsed.data.certificateType,
      overrideEligibility: parsed.data.overrideEligibility,
    });

    await createNotification(pool, {
      userId: parsed.data.userId,
      conferenceId: conf.id,
      title: 'Certificate Awarded',
      body: `An official ${parsed.data.certificateType} certificate (${certNumber}) for "${conf.title}" was issued to you.`,
      category: 'certificate',
      metadata: { certificateId: createdCert.id, certificateNumber: certNumber },
    });

    res.status(201).json({ data: createdCert });
  } catch (e) {
    if (e.code === '23505') {
      return fail(res, 409, 'A certificate of this type was already issued for this user in this conference.');
    }
    next(e);
  }
});

// Admin revoke certificate
router.post('/admin/conferences/:conferenceId/certificates/:certId/revoke', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.certId).success) {
    return fail(res, 400, 'Invalid IDs.');
  }
  const schema = z.object({
    reason: z.string().trim().min(5, 'Revocation reason must be at least 5 characters.').max(1000),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || 'Provide a valid revocation reason.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const certQuery = await pool.query(
      `select cert.id, cert.certificate_number, cert.user_id, cert.is_revoked, c.title as conference_title
       from public.certificates cert
       join public.conferences c on c.id = cert.conference_id
       where cert.id = $1 and cert.conference_id = $2`,
      [req.params.certId, req.params.conferenceId]
    );
    const cert = certQuery.rows[0];
    if (!cert) return fail(res, 404, 'Certificate not found.');
    if (cert.is_revoked) return fail(res, 400, 'Certificate has already been revoked.');

    const { rows } = await pool.query(
      `update public.certificates
       set is_revoked = true,
           revoked_at = now(),
           revocation_reason = $1,
           revoked_by = $2
       where id = $3
       returning id, certificate_number, is_revoked, revoked_at, revocation_reason`,
      [parsed.data.reason, req.user.id, cert.id]
    );

    await audit(pool, req.user.id, 'certificate.revoked', cert.id, {
      certificateNumber: cert.certificate_number,
      reason: parsed.data.reason,
    });

    await createNotification(pool, {
      userId: cert.user_id,
      conferenceId: req.params.conferenceId,
      title: 'Certificate Revoked',
      body: `Your certificate (${cert.certificate_number}) for "${cert.conference_title}" was revoked. Reason: ${parsed.data.reason}`,
      category: 'certificate',
      metadata: { certificateId: cert.id, certificateNumber: cert.certificate_number },
    });

    res.json({
      data: {
        message: 'Certificate revoked successfully.',
        certificate: rows[0],
      },
    });
  } catch (e) {
    next(e);
  }
});

// Admin templates management
router.get('/admin/conferences/:conferenceId/certificates/templates', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `select id, conference_id, certificate_type, title, subtitle, body_text, signatory_name, signatory_title, is_active, updated_at
       from public.certificate_templates
       where conference_id = $1`,
      [req.params.conferenceId]
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

router.put('/admin/conferences/:conferenceId/certificates/templates/:certType', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !certTypes.includes(req.params.certType)) {
    return fail(res, 400, 'Invalid conference or certificate type.');
  }
  const schema = z.object({
    title: z.string().trim().min(3).max(200),
    subtitle: z.string().trim().max(200).nullable().optional(),
    bodyText: z.string().trim().min(10).max(2000),
    signatoryName: z.string().trim().min(2).max(160),
    signatoryTitle: z.string().trim().min(2).max(160),
    isActive: z.boolean().default(true),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check submitted template fields.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const { rows } = await pool.query(
      `insert into public.certificate_templates(
         conference_id, certificate_type, title, subtitle, body_text, signatory_name, signatory_title, is_active, updated_at
       ) values($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict(conference_id, certificate_type) do update
       set title = excluded.title,
           subtitle = excluded.subtitle,
           body_text = excluded.body_text,
           signatory_name = excluded.signatory_name,
           signatory_title = excluded.signatory_title,
           is_active = excluded.is_active,
           updated_at = now()
       returning *`,
      [
        req.params.conferenceId,
        req.params.certType,
        parsed.data.title,
        parsed.data.subtitle || null,
        parsed.data.bodyText,
        parsed.data.signatoryName,
        parsed.data.signatoryTitle,
        parsed.data.isActive,
      ]
    );

    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

export default router;
