import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, requireAuth } from '../auth/middleware.js';
import { buildCsv, generateExecutiveReportPdf } from '../utils/pdf.js';

const router = Router();
const uuid = z.string().uuid();

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
     values($1, $2, 'report', $3, $4::jsonb)`,
    [userId, action, entityId, JSON.stringify(details)]
  );
}

// -------------------------------------------------------------
// Conference Analytics & Live Statistics
// -------------------------------------------------------------

router.get('/conferences/:conferenceId/analytics', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const confId = req.params.conferenceId;

    const [
      confRes,
      paperCountsRes,
      reviewCountsRes,
      regCountsRes,
      finRes,
      sessionsCountRes,
      slotsCountRes,
      completedPresRes,
      missedPresRes,
      checkinsCountRes,
      qrCheckinsRes,
      certRes,
    ] = await Promise.all([
      pool.query('select id, title, acronym, status, start_date, end_date, venue, timezone from public.conferences where id = $1', [confId]),
      pool.query(
        `select status, count(*)::int as count
         from public.submissions
         where conference_id = $1
         group by status`,
        [confId]
      ),
      pool.query(
        `select r.status, count(*)::int as count, avg(case when r.score is not null then r.score else null end) as avg_score
         from public.reviews r
         join public.submissions s on s.id = r.submission_id
         where s.conference_id = $1
         group by r.status`,
        [confId]
      ),
      pool.query(
        `select status, category, count(*)::int as count
         from public.registrations
         where conference_id = $1
         group by status, category`,
        [confId]
      ),
      pool.query(
        `select p.status, count(*)::int as count, coalesce(sum(p.amount), 0) as total_amount
         from public.payments p
         join public.registrations r on r.id = p.registration_id
         where r.conference_id = $1
         group by p.status`,
        [confId]
      ),
      pool.query('select count(*)::int as count from public.sessions where conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1 and ss.presentation_status = \'completed\'', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1 and ss.presentation_status in (\'absent\', \'cancelled\')', [confId]),
      pool.query('select count(*)::int as count from public.attendance a join public.sessions s on s.id = a.session_id where s.conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.attendance a join public.sessions s on s.id = a.session_id where s.conference_id = $1 and a.check_in_method = \'qr_code\'', [confId]),
      pool.query(
        `select certificate_type, is_revoked, count(*)::int as count
         from public.certificates
         where conference_id = $1
         group by certificate_type, is_revoked`,
        [confId]
      ),
    ]);

    const conf = confRes.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');

    // Build Papers summary
    const paperStatusMap = paperCountsRes.rows.reduce((acc, r) => {
      acc[r.status] = r.count;
      return acc;
    }, {});
    const totalPapers = Object.values(paperStatusMap).reduce((a, b) => a + b, 0);

    const papers = {
      total: totalPapers,
      accepted: (paperStatusMap.accepted || 0) + (paperStatusMap.camera_ready || 0) + (paperStatusMap.finalized || 0),
      rejected: paperStatusMap.rejected || 0,
      under_review: paperStatusMap.under_review || 0,
      revision_requested: paperStatusMap.revision_requested || 0,
      draft: paperStatusMap.draft || 0,
      withdrawn: paperStatusMap.withdrawn || 0,
      byStatus: paperStatusMap,
    };

    // Build Reviews summary
    let totalReviewsAssigned = 0;
    let completedReviews = 0;
    let scoreAccumulator = 0;
    let scoreCount = 0;
    for (const r of reviewCountsRes.rows) {
      totalReviewsAssigned += r.count;
      if (r.status === 'submitted') {
        completedReviews += r.count;
      }
      if (r.avg_score) {
        scoreAccumulator += Number(r.avg_score) * r.count;
        scoreCount += r.count;
      }
    }
    const reviews = {
      totalAssigned: totalReviewsAssigned,
      completed: completedReviews,
      pending: totalReviewsAssigned - completedReviews,
      averageScore: scoreCount > 0 ? (scoreAccumulator / scoreCount).toFixed(2) : null,
    };

    // Build Registrations summary
    let totalRegs = 0;
    let confirmedRegs = 0;
    let pendingRegs = 0;
    let cancelledRegs = 0;
    const categoryMap = {};
    for (const r of regCountsRes.rows) {
      totalRegs += r.count;
      if (r.status === 'confirmed') confirmedRegs += r.count;
      if (r.status === 'pending') pendingRegs += r.count;
      if (r.status === 'cancelled') cancelledRegs += r.count;
      categoryMap[r.category] = (categoryMap[r.category] || 0) + r.count;
    }
    const registrations = {
      total: totalRegs,
      confirmed: confirmedRegs,
      pending: pendingRegs,
      cancelled: cancelledRegs,
      byCategory: categoryMap,
    };

    // Build Financials summary
    let verifiedAmount = 0;
    let refundedAmount = 0;
    let verifiedCount = 0;
    let pendingCount = 0;
    let rejectedCount = 0;
    for (const f of finRes.rows) {
      if (f.status === 'verified') {
        verifiedAmount = Number(f.total_amount);
        verifiedCount = f.count;
      } else if (f.status === 'pending') {
        pendingCount = f.count;
      } else if (f.status === 'rejected') {
        rejectedCount = f.count;
      } else if (f.status === 'refunded') {
        refundedAmount = Number(f.total_amount);
      }
    }
    const financials = {
      verifiedAmount,
      refundedAmount,
      verifiedCount,
      pendingCount,
      rejectedCount,
    };

    // Build Attendance summary
    const totalSessions = Number(sessionsCountRes.rows[0]?.count || 0);
    const totalSlots = Number(slotsCountRes.rows[0]?.count || 0);
    const completedPresentations = Number(completedPresRes.rows[0]?.count || 0);
    const missedPresentations = Number(missedPresRes.rows[0]?.count || 0);
    const totalCheckIns = Number(checkinsCountRes.rows[0]?.count || 0);
    const qrCheckIns = Number(qrCheckinsRes.rows[0]?.count || 0);
    const manualCheckIns = totalCheckIns - qrCheckIns;

    const attendance = {
      totalSessions,
      totalSlots,
      completedPresentations,
      absentOrCancelledPresentations: missedPresentations,
      totalCheckIns,
      qrCheckIns,
      manualCheckIns,
    };

    // Build Certificates summary
    let totalCerts = 0;
    let revokedCerts = 0;
    const certTypeMap = {};
    for (const c of certRes.rows) {
      totalCerts += c.count;
      if (c.is_revoked) revokedCerts += c.count;
      certTypeMap[c.certificate_type] = (certTypeMap[c.certificate_type] || 0) + c.count;
    }
    const certificates = {
      totalIssued: totalCerts,
      revoked: revokedCerts,
      byType: certTypeMap,
    };

    res.json({
      data: {
        conference: conf,
        papers,
        reviews,
        registrations,
        financials,
        attendance,
        certificates,
      },
    });
  } catch (e) {
    next(e);
  }
});

// -------------------------------------------------------------
// Report Exports (CSV and PDF)
// -------------------------------------------------------------

// Export Registrations CSV
router.get('/conferences/:conferenceId/reports/registrations/csv', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const { rows } = await pool.query(
      `select r.reference_code, u.full_name, u.email, u.institution,
              r.category, r.status as registration_status, r.created_at,
              p.amount, p.currency, p.status as payment_status, p.payment_method, p.provider_reference
       from public.registrations r
       join public.users u on u.id = r.user_id
       left join public.payments p on p.registration_id = r.id
       where r.conference_id = $1
       order by r.created_at desc`,
      [req.params.conferenceId]
    );

    const headers = [
      { label: 'Reference Code', key: 'reference_code' },
      { label: 'Full Name', key: 'full_name' },
      { label: 'Email', key: 'email' },
      { label: 'Institution', key: 'institution' },
      { label: 'Category', key: 'category' },
      { label: 'Registration Status', key: 'registration_status' },
      { label: 'Fee Amount', key: 'amount' },
      { label: 'Currency', key: 'currency' },
      { label: 'Payment Status', key: 'payment_status' },
      { label: 'Payment Method', key: 'payment_method' },
      { label: 'Payment Reference', key: 'provider_reference' },
      { label: 'Registered At', key: (r) => (r.created_at ? new Date(r.created_at).toISOString() : '') },
    ];

    const csvData = buildCsv(headers, rows);

    await audit(pool, req.user.id, 'report.exported_registrations_csv', req.params.conferenceId, { rowCount: rows.length });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="BUP-Registrations-${req.params.conferenceId}.csv"`);
    res.send(csvData);
  } catch (e) {
    next(e);
  }
});

// Export Submissions CSV
router.get('/conferences/:conferenceId/reports/submissions/csv', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const { rows } = await pool.query(
      `select s.paper_code, s.title, s.category, s.status, t.name as track_name,
              u.full_name as submitter_name, u.email as submitter_email,
              s.created_at
       from public.submissions s
       left join public.tracks t on t.id = s.track_id
       left join public.users u on u.id = s.submitted_by
       where s.conference_id = $1
       order by s.paper_code asc`,
      [req.params.conferenceId]
    );

    const headers = [
      { label: 'Paper Code', key: 'paper_code' },
      { label: 'Title', key: 'title' },
      { label: 'Track', key: 'track_name' },
      { label: 'Category', key: 'category' },
      { label: 'Status', key: 'status' },
      { label: 'Submitter Name', key: 'submitter_name' },
      { label: 'Submitter Email', key: 'submitter_email' },
      { label: 'Submitted At', key: (r) => (r.created_at ? new Date(r.created_at).toISOString() : '') },
    ];

    const csvData = buildCsv(headers, rows);

    await audit(pool, req.user.id, 'report.exported_submissions_csv', req.params.conferenceId, { rowCount: rows.length });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="BUP-Submissions-${req.params.conferenceId}.csv"`);
    res.send(csvData);
  } catch (e) {
    next(e);
  }
});

// Export Attendance & Certificates CSV
router.get('/conferences/:conferenceId/reports/attendance/csv', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const [regRes, attRes, presRes, certRes] = await Promise.all([
      pool.query(
        `select r.id, r.user_id, r.reference_code, r.category, r.status,
                u.full_name, u.email, u.institution
         from public.registrations r
         join public.users u on u.id = r.user_id
         where r.conference_id = $1`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select a.user_id, count(distinct a.session_id)::int as count
         from public.attendance a
         join public.sessions s on s.id = a.session_id
         where s.conference_id = $1
         group by a.user_id`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select ss.presenter_user_id as user_id, count(*)::int as count
         from public.session_submissions ss
         join public.submissions sub on sub.id = ss.submission_id
         where sub.conference_id = $1 and ss.presentation_status = 'completed' and ss.presenter_user_id is not null
         group by ss.presenter_user_id`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select user_id, certificate_number, certificate_type, is_revoked from public.certificates where conference_id = $1`,
        [req.params.conferenceId]
      ),
    ]);

    const attMap = attRes.rows.reduce((acc, r) => { acc[r.user_id] = r.count; return acc; }, {});
    const presMap = presRes.rows.reduce((acc, r) => { acc[r.user_id] = r.count; return acc; }, {});
    const certMap = certRes.rows.reduce((acc, r) => {
      acc[r.user_id] = `${r.certificate_number} (${r.certificate_type}${r.is_revoked ? ' - REVOKED' : ''})`;
      return acc;
    }, {});

    const rows = regRes.rows.map((r) => {
      const attended = attMap[r.user_id] || 0;
      const presented = presMap[r.user_id] || 0;
      const eligible = attended > 0 || presented > 0;
      return {
        ...r,
        attended_sessions: attended,
        completed_presentations: presented,
        certificate_eligible: eligible ? 'Eligible' : 'Not Eligible',
        certificate_info: certMap[r.user_id] || 'None',
      };
    });

    const headers = [
      { label: 'Reference Code', key: 'reference_code' },
      { label: 'Full Name', key: 'full_name' },
      { label: 'Email', key: 'email' },
      { label: 'Institution', key: 'institution' },
      { label: 'Category', key: 'category' },
      { label: 'Attended Sessions', key: 'attended_sessions' },
      { label: 'Completed Presentations', key: 'completed_presentations' },
      { label: 'Certificate Eligibility', key: 'certificate_eligible' },
      { label: 'Issued Certificate', key: 'certificate_info' },
    ];

    const csvData = buildCsv(headers, rows);

    await audit(pool, req.user.id, 'report.exported_attendance_csv', req.params.conferenceId, { rowCount: rows.length });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="BUP-Attendance-${req.params.conferenceId}.csv"`);
    res.send(csvData);
  } catch (e) {
    next(e);
  }
});

// Export Executive Summary PDF
router.get('/conferences/:conferenceId/reports/summary/pdf', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const confId = req.params.conferenceId;

    const confRes = await pool.query('select * from public.conferences where id = $1', [confId]);
    const conf = confRes.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');

    // Fetch analytics data using internal queries
    const [
      paperCountsRes,
      reviewCountsRes,
      regCountsRes,
      finRes,
      sessionsCountRes,
      slotsCountRes,
      completedPresRes,
      missedPresRes,
      checkinsCountRes,
      qrCheckinsRes,
      certRes,
    ] = await Promise.all([
      pool.query('select status, count(*)::int as count from public.submissions where conference_id = $1 group by status', [confId]),
      pool.query('select r.status, count(*)::int as count from public.reviews r join public.submissions s on s.id = r.submission_id where s.conference_id = $1 group by r.status', [confId]),
      pool.query('select status, category, count(*)::int as count from public.registrations where conference_id = $1 group by status, category', [confId]),
      pool.query('select p.status, count(*)::int as count, coalesce(sum(p.amount), 0) as total from public.payments p join public.registrations r on r.id = p.registration_id where r.conference_id = $1 group by p.status', [confId]),
      pool.query('select count(*)::int as count from public.sessions where conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1 and ss.presentation_status = \'completed\'', [confId]),
      pool.query('select count(*)::int as count from public.session_submissions ss join public.sessions s on s.id = ss.session_id where s.conference_id = $1 and ss.presentation_status in (\'absent\', \'cancelled\')', [confId]),
      pool.query('select count(*)::int as count from public.attendance a join public.sessions s on s.id = a.session_id where s.conference_id = $1', [confId]),
      pool.query('select count(*)::int as count from public.attendance a join public.sessions s on s.id = a.session_id where s.conference_id = $1 and a.check_in_method = \'qr_code\'', [confId]),
      pool.query('select certificate_type, is_revoked, count(*)::int as count from public.certificates where conference_id = $1 group by certificate_type, is_revoked', [confId]),
    ]);

    const paperMap = paperCountsRes.rows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {});
    const totalPapers = Object.values(paperMap).reduce((a, b) => a + b, 0);

    const papers = {
      total: totalPapers,
      accepted: (paperMap.accepted || 0) + (paperMap.camera_ready || 0) + (paperMap.finalized || 0),
      rejected: paperMap.rejected || 0,
      under_review: paperMap.under_review || 0,
      revision_requested: paperMap.revision_requested || 0,
    };

    let totalReviews = 0;
    let completedReviews = 0;
    for (const r of reviewCountsRes.rows) {
      totalReviews += r.count;
      if (r.status === 'submitted') completedReviews += r.count;
    }
    const reviews = {
      totalAssigned: totalReviews,
      completed: completedReviews,
    };

    let totalReg = 0;
    let confReg = 0;
    let pendReg = 0;
    let cancReg = 0;
    const catMap = {};
    for (const r of regCountsRes.rows) {
      totalReg += r.count;
      if (r.status === 'confirmed') confReg += r.count;
      if (r.status === 'pending') pendReg += r.count;
      if (r.status === 'cancelled') cancReg += r.count;
      catMap[r.category] = (catMap[r.category] || 0) + r.count;
    }
    const registrations = {
      total: totalReg,
      confirmed: confReg,
      pending: pendReg,
      cancelled: cancReg,
      byCategory: catMap,
    };

    let verifiedAmount = 0;
    let refundedAmount = 0;
    let verifiedCount = 0;
    let pendingCount = 0;
    let rejectedCount = 0;
    for (const f of finRes.rows) {
      if (f.status === 'verified') {
        verifiedAmount = Number(f.total);
        verifiedCount = f.count;
      } else if (f.status === 'refunded') {
        refundedAmount = Number(f.total);
      } else if (f.status === 'pending') {
        pendingCount = f.count;
      } else if (f.status === 'rejected') {
        rejectedCount = f.count;
      }
    }
    const financials = {
      verifiedAmount,
      refundedAmount,
      verifiedCount,
      pendingCount,
      rejectedCount,
    };

    const totalSessions = Number(sessionsCountRes.rows[0]?.count || 0);
    const totalSlots = Number(slotsCountRes.rows[0]?.count || 0);
    const completedPresentations = Number(completedPresRes.rows[0]?.count || 0);
    const missedPresentations = Number(missedPresRes.rows[0]?.count || 0);
    const totalCheckIns = Number(checkinsCountRes.rows[0]?.count || 0);
    const qrCheckIns = Number(qrCheckinsRes.rows[0]?.count || 0);
    const manualCheckIns = totalCheckIns - qrCheckIns;

    const attendance = {
      totalSessions,
      totalSlots,
      completedPresentations,
      absentOrCancelledPresentations: missedPresentations,
      totalCheckIns,
      qrCheckIns,
      manualCheckIns,
    };

    let totalCerts = 0;
    let revokedCerts = 0;
    const certTypeMap = {};
    for (const c of certRes.rows) {
      totalCerts += c.count;
      if (c.is_revoked) revokedCerts += c.count;
      certTypeMap[c.certificate_type] = (certTypeMap[c.certificate_type] || 0) + c.count;
    }
    const certificates = {
      totalIssued: totalCerts,
      revoked: revokedCerts,
      byType: certTypeMap,
    };

    const pdfBuffer = await generateExecutiveReportPdf({
      conference: conf,
      analytics: { papers, reviews, registrations, financials, attendance, certificates },
      generatedBy: req.user,
    });

    await audit(pool, req.user.id, 'report.exported_summary_pdf', confId, {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="BUP-Executive-Summary-${conf.acronym || 'CONF'}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    next(e);
  }
});

// Global Super Admin Analytics
router.get('/analytics/global', dbRequired, requireAuth, async (req, res, next) => {
  try {
    if (!isSuper(req.user)) return fail(res, 403, 'Super Admin access is required.');

    const [confRes, userRes, subRes, revRes, certRes] = await Promise.all([
      pool.query('select count(*)::int as total, count(case when status = \'published\' then 1 end)::int as published from public.conferences'),
      pool.query('select count(*)::int as total, count(case when is_active = true then 1 end)::int as active from public.users'),
      pool.query('select count(*)::int as total, count(case when status in (\'accepted\', \'camera_ready\', \'finalized\') then 1 end)::int as accepted from public.submissions'),
      pool.query('select coalesce(sum(amount), 0) as total_revenue from public.payments where status = \'verified\''),
      pool.query('select count(*)::int as total, count(case when is_revoked = true then 1 end)::int as revoked from public.certificates'),
    ]);

    res.json({
      data: {
        conferences: confRes.rows[0],
        users: userRes.rows[0],
        submissions: subRes.rows[0],
        financials: { totalVerifiedRevenue: Number(revRes.rows[0]?.total_revenue || 0) },
        certificates: certRes.rows[0],
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
