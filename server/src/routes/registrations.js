import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { canManageConference, requireAuth } from '../auth/middleware.js';
import { requireCsrf } from '../auth/csrf.js';
import { sendWorkflowEmail } from '../auth/email.js';

const router = Router();
const uuid = z.string().uuid();
const MAX_RECEIPT_BYTES = Math.min(Number(process.env.RECEIPT_MAX_BYTES || 5 * 1024 * 1024), 20 * 1024 * 1024);
const allowedCategories = ['author', 'student', 'professional', 'general_attendee'];
const allowedPaymentMethods = ['bank_transfer', 'mobile_banking', 'wire_transfer', 'cash', 'other'];

function fail(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function dbRequired(_req, res, next) {
  if (!pool) return fail(res, 503, 'Database is unavailable until DATABASE_URL is configured.');
  next();
}

function isSuper(user) {
  return user.roles.includes('super_admin');
}

async function isManager(req, conferenceId) {
  return isSuper(req.user) || canManageConference(req.user, conferenceId);
}

async function tx(work) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const value = await work(c);
    await c.query('commit');
    return value;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function audit(db, userId, action, entityType, entityId, details = {}) {
  await db.query(
    `insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, details)
     values($1, $2, $3, $4, $5::jsonb)`,
    [userId, action, entityType, entityId, JSON.stringify(details)]
  );
}

async function notify(db, userId, conferenceId, title, body) {
  await db.query(
    `insert into public.notifications(user_id, conference_id, title, body, channel)
     values($1, $2, $3, $4, 'in_app')`,
    [userId, conferenceId, title, body]
  );
}

async function emailIfConfigured(email, subject, text) {
  try {
    await sendWorkflowEmail({ email, subject, text });
  } catch (error) {
    console.error('Workflow email delivery failed:', error.message);
  }
}

async function managersFor(db, conferenceId) {
  const { rows } = await db.query(
    `select distinct u.id, u.email, u.full_name from public.users u
     left join public.conferences c on c.organizer_user_id = u.id and c.id = $1
     left join public.conference_memberships cm on cm.user_id = u.id and cm.conference_id = $1
     left join public.roles r on r.id = cm.role_id
     where c.id = $1 or r.name = 'conference_admin'`,
    [conferenceId]
  );
  return rows;
}

// Bounded multipart reader for receipt upload (PDF or Images)
async function readReceiptMultipart(req) {
  const type = req.headers['content-type'] || '';
  const boundaryMatch = type.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error('Upload must use multipart/form-data.'), { status: 400 });
  const marker = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_RECEIPT_BYTES + 128 * 1024) {
      throw Object.assign(new Error(`Receipt file exceeds the ${Math.floor(MAX_RECEIPT_BYTES / 1024 / 1024)} MB upload limit.`), { status: 413 });
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const fields = {};
  let file;
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
      if (file) throw Object.assign(new Error('Upload exactly one receipt file.'), { status: 400 });
      file = {
        data,
        filename,
        contentType: header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || '',
      };
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
    cursor = next;
  }
  return { fields, file };
}

function validateReceiptFile(file) {
  if (!file || !file.data.length) return 'Select a receipt file to upload.';
  if (file.data.length > MAX_RECEIPT_BYTES) return `Receipt exceeds ${Math.floor(MAX_RECEIPT_BYTES / 1024 / 1024)} MB limit.`;
  const name = file.filename.toLowerCase();
  const isPdf = name.endsWith('.pdf');
  const isJpg = name.endsWith('.jpg') || name.endsWith('.jpeg');
  const isPng = name.endsWith('.png');
  if (!isPdf && !isJpg && !isPng) return 'Receipt file must be a PDF, JPEG, or PNG.';
  const bytes = file.data;
  if (isPdf) {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return 'The file content is not a valid PDF.';
  } else if (isJpg) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return 'The file content is not a valid JPEG.';
  } else if (isPng) {
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return 'The file content is not a valid PNG.';
  }
  return '';
}

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'manuscripts';
  return url && key ? { url: url.replace(/\/$/, ''), key, bucket } : null;
}

async function storePrivateReceipt(file, objectKey) {
  const cfg = storageConfig();
  if (!cfg) throw Object.assign(new Error('Private receipt storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'), { status: 503 });
  const response = await fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${objectKey}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': file.contentType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: file.data,
  });
  if (!response.ok) throw Object.assign(new Error('Receipt storage rejected the upload.'), { status: 502 });
  return cfg;
}

async function signedReceiptLink(objectKey) {
  const cfg = storageConfig();
  if (!cfg) throw Object.assign(new Error('Private storage is not configured.'), { status: 503 });
  const expires = 300;
  const response = await fetch(`${cfg.url}/storage/v1/object/sign/${encodeURIComponent(cfg.bucket)}/${objectKey}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expires }),
  });
  if (!response.ok) throw Object.assign(new Error('Could not create temporary receipt download link.'), { status: 502 });
  const data = await response.json();
  const path = data.signedURL || data.signedUrl;
  if (!path) throw Object.assign(new Error('Storage did not return a signed receipt link.'), { status: 502 });
  const url = path.startsWith('http') ? path : `${cfg.url}/storage/v1${path.startsWith('/') ? '' : '/'}${path}`;
  return { url, expiresIn: expires };
}

// -------------------------------------------------------------
// Public / Attendee Registration Endpoints
// -------------------------------------------------------------

// Get active registration tiers, eligibility, deadlines, and conference capacity
router.get('/conferences/:conferenceId/registration-tiers', dbRequired, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    const [confResult, tiersResult, regCountResult] = await Promise.all([
      pool.query(`select id, title, status, max_capacity from public.conferences where id = $1`, [req.params.conferenceId]),
      pool.query(
        `select id, category, title, description, amount::float as amount, currency, eligibility_criteria, deadline_at, capacity, is_active
         from public.conference_registration_tiers
         where conference_id = $1 and is_active = true
         order by amount asc`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select count(*)::int as count from public.registrations
         where conference_id = $1 and status not in ('cancelled', 'refunded')`,
        [req.params.conferenceId]
      ),
    ]);
    const conf = confResult.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');
    const totalRegistered = regCountResult.rows[0]?.count || 0;
    const isFull = Boolean(conf.max_capacity && totalRegistered >= conf.max_capacity);
    res.json({
      data: {
        conferenceId: conf.id,
        conferenceTitle: conf.title,
        conferenceStatus: conf.status,
        maxCapacity: conf.max_capacity,
        totalRegistered,
        isFull,
        tiers: tiersResult.rows.map((t) => ({
          ...t,
          isDeadlinePassed: t.deadline_at ? new Date(t.deadline_at) < new Date() : false,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

// Register for a conference (Concurrency-safe with row lock)
router.post('/conferences/:conferenceId/registrations', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const schema = z.object({
    category: z.enum(allowedCategories),
    paperId: uuid.nullable().optional(),
    organization: z.string().trim().max(200).nullable().optional(),
    dietaryRequirements: z.string().trim().max(300).nullable().optional(),
    specialNeeds: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check registration category and information fields.');

  try {
    const created = await tx(async (db) => {
      // Lock conference row to safely handle concurrent registrations
      const confQuery = await db.query(
        `select id, title, status, max_capacity from public.conferences where id = $1 for update`,
        [req.params.conferenceId]
      );
      const conf = confQuery.rows[0];
      if (!conf) throw Object.assign(new Error('Conference not found.'), { status: 404 });
      if (!['published', 'submission_open', 'in_review'].includes(conf.status)) {
        throw Object.assign(new Error('Registration is not currently open for this conference.'), { status: 409 });
      }

      // Check general registration deadline
      const deadlineQuery = await db.query(
        `select deadline_at from public.conference_deadlines where conference_id = $1 and deadline_type = 'registration'`,
        [conf.id]
      );
      if (deadlineQuery.rows[0] && new Date(deadlineQuery.rows[0].deadline_at) < new Date()) {
        throw Object.assign(new Error('The conference registration deadline has passed.'), { status: 409 });
      }

      // Check overall conference capacity
      if (conf.max_capacity) {
        const totalQuery = await db.query(
          `select count(*)::int as count from public.registrations
           where conference_id = $1 and status not in ('cancelled', 'refunded')`,
          [conf.id]
        );
        if (totalQuery.rows[0].count >= conf.max_capacity) {
          throw Object.assign(new Error('This conference has reached its maximum registration capacity.'), { status: 409 });
        }
      }

      // Find registration tier
      const tierQuery = await db.query(
        `select id, category, title, amount, currency, deadline_at, capacity, is_active
         from public.conference_registration_tiers
         where conference_id = $1 and category = $2 for share`,
        [conf.id, parsed.data.category]
      );
      const tier = tierQuery.rows[0];
      if (!tier || !tier.is_active) {
        throw Object.assign(new Error('Selected registration tier is not active for this conference.'), { status: 400 });
      }
      if (tier.deadline_at && new Date(tier.deadline_at) < new Date()) {
        throw Object.assign(new Error(`The registration deadline for ${tier.title} has passed.`), { status: 409 });
      }
      if (tier.capacity) {
        const tierCountQuery = await db.query(
          `select count(*)::int as count from public.registrations
           where conference_id = $1 and category = $2 and status not in ('cancelled', 'refunded')`,
          [conf.id, parsed.data.category]
        );
        if (tierCountQuery.rows[0].count >= tier.capacity) {
          throw Object.assign(new Error(`The ${tier.title} category has reached its capacity limit.`), { status: 409 });
        }
      }

      // Validate paper if author category
      let paperId = null;
      if (parsed.data.category === 'author') {
        if (!parsed.data.paperId) {
          throw Object.assign(new Error('Author registration requires selecting an accepted conference paper.'), { status: 400 });
        }
        const paperQuery = await db.query(
          `select s.id, s.title, s.status from public.submissions s
           where s.id = $1 and s.conference_id = $2
           and (s.submitted_by = $3 or exists(select 1 from public.authors a where a.submission_id = s.id and (a.user_id = $3 or lower(a.email) = lower($4))))`,
          [parsed.data.paperId, conf.id, req.user.id, req.user.email]
        );
        if (!paperQuery.rows[0]) {
          throw Object.assign(new Error('The specified paper is not linked to your account for this conference.'), { status: 400 });
        }
        paperId = paperQuery.rows[0].id;
      }

      // Prevent duplicate registration
      const existing = await db.query(
        `select id, reference_code, status, payment_status from public.registrations
         where conference_id = $1 and user_id = $2 for update`,
        [conf.id, req.user.id]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status !== 'cancelled') {
          throw Object.assign(
            new Error(`You are already registered for this conference (Reference: ${existing.rows[0].reference_code}).`),
            { status: 409 }
          );
        }
      }

      // Unique reference code
      const year = new Date().getFullYear();
      const referenceCode = `BUP-REG-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;

      let regRow;
      if (existing.rows[0] && existing.rows[0].status === 'cancelled') {
        // Re-activate previously cancelled registration
        const updated = await db.query(
          `update public.registrations
           set tier_id = $1, reference_code = $2, category = $3, status = 'pending', payment_status = 'unpaid',
               paper_id = $4, organization = $5, dietary_requirements = $6, special_needs = $7,
               registered_at = now(), cancellation_reason = null, cancellation_requested_at = null,
               cancelled_at = null, updated_at = now()
           where id = $8
           returning id, conference_id, reference_code, category, status, payment_status, registered_at`,
          [
            tier.id,
            referenceCode,
            parsed.data.category,
            paperId,
            parsed.data.organization || null,
            parsed.data.dietaryRequirements || null,
            parsed.data.specialNeeds || null,
            existing.rows[0].id,
          ]
        );
        regRow = updated.rows[0];
      } else {
        const inserted = await db.query(
          `insert into public.registrations(
             conference_id, user_id, tier_id, reference_code, category, status, payment_status,
             paper_id, organization, dietary_requirements, special_needs, registered_at
           ) values($1, $2, $3, $4, $5, 'pending', 'unpaid', $6, $7, $8, $9, now())
           returning id, conference_id, reference_code, category, status, payment_status, registered_at`,
          [
            conf.id,
            req.user.id,
            tier.id,
            referenceCode,
            parsed.data.category,
            paperId,
            parsed.data.organization || null,
            parsed.data.dietaryRequirements || null,
            parsed.data.specialNeeds || null,
          ]
        );
        regRow = inserted.rows[0];
      }

      // Create initial pending payment record with server-validated amount
      const payment = await db.query(
        `insert into public.payments(
           registration_id, amount, currency, status, payment_method
         ) values($1, $2, $3, 'pending', 'bank_transfer')
         returning id, amount::float as amount, currency, status`,
        [regRow.id, tier.amount, tier.currency]
      );

      await audit(db, req.user.id, 'registration.created', 'registration', regRow.id, {
        referenceCode,
        category: parsed.data.category,
        amount: tier.amount,
        currency: tier.currency,
      });

      await notify(
        db,
        req.user.id,
        conf.id,
        'Conference Registration Created',
        `Your registration for ${conf.title} has been created (Reference: ${referenceCode}). Please upload your payment receipt to complete verification.`
      );

      return {
        ...regRow,
        referenceCode,
        conferenceTitle: conf.title,
        tierTitle: tier.title,
        amount: Number(tier.amount),
        currency: tier.currency,
        paymentId: payment.rows[0].id,
      };
    });

    void emailIfConfigured(
      req.user.email,
      `BUP Registration Confirmation: ${created.referenceCode}`,
      `Thank you for registering for ${created.conferenceTitle}.\n\nReference: ${created.referenceCode}\nCategory: ${created.tierTitle}\nFee: ${created.currency} ${created.amount}\n\nPlease sign in to your dashboard to upload your payment receipt.`
    );

    res.status(201).json({ data: created });
  } catch (e) {
    next(e);
  }
});

// Get user's own registrations
router.get('/registrations/my', dbRequired, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select r.id, r.conference_id, r.reference_code, r.category, r.status, r.payment_status,
              r.organization, r.dietary_requirements, r.special_needs, r.registered_at, r.created_at,
              c.title as conference_title, c.start_date, c.end_date, c.venue,
              t.title as tier_title, t.amount::float as tier_amount, t.currency as tier_currency,
              p.id as payment_id, p.amount::float as payment_amount, p.currency as payment_currency,
              p.payment_method, p.transaction_reference, p.receipt_object_key, p.receipt_filename,
              p.receipt_file_size, p.status as payment_record_status, p.paid_at, p.verified_at,
              p.rejection_reason,
              ref.id as refund_id, ref.status as refund_status, ref.amount::float as refund_amount,
              ref.reason as refund_reason
       from public.registrations r
       join public.conferences c on c.id = r.conference_id
       left join public.conference_registration_tiers t on t.id = r.tier_id
       left join public.payments p on p.registration_id = r.id
       left join public.registration_refunds ref on ref.registration_id = r.id
       where r.user_id = $1
       order by r.registered_at desc`,
      [req.user.id]
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

// Get specific registration details
router.get('/registrations/:registrationId', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.registrationId).success) return fail(res, 400, 'Registration ID is invalid.');
  try {
    const { rows } = await pool.query(
      `select r.*, c.title as conference_title, c.start_date, c.end_date, c.venue,
              t.title as tier_title, t.amount::float as tier_amount, t.currency as tier_currency,
              u.full_name as registrant_name, u.email as registrant_email
       from public.registrations r
       join public.conferences c on c.id = r.conference_id
       join public.users u on u.id = r.user_id
       left join public.conference_registration_tiers t on t.id = r.tier_id
       where r.id = $1`,
      [req.params.registrationId]
    );
    const reg = rows[0];
    if (!reg) return fail(res, 404, 'Registration not found.');
    const manager = await isManager(req, reg.conference_id);
    if (reg.user_id !== req.user.id && !manager) return fail(res, 403, 'Access denied.');

    const [payments, refunds] = await Promise.all([
      pool.query(`select * from public.payments where registration_id = $1 order by created_at desc`, [reg.id]),
      pool.query(`select * from public.registration_refunds where registration_id = $1 order by requested_at desc`, [reg.id]),
    ]);

    res.json({
      data: {
        ...reg,
        payments: payments.rows,
        refunds: refunds.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Upload payment receipt for a registration
router.post('/registrations/:registrationId/receipt', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.registrationId).success) return fail(res, 400, 'Registration ID is invalid.');
  let multipart;
  try {
    multipart = await readReceiptMultipart(req);
  } catch (error) {
    return fail(res, error.status || 400, error.message);
  }

  const fileError = validateReceiptFile(multipart.file);
  if (fileError) return fail(res, 400, fileError);

  const f = multipart.fields;
  const paymentMethod = allowedPaymentMethods.includes(f.paymentMethod) ? f.paymentMethod : 'bank_transfer';
  const transactionReference = (f.transactionReference || '').trim();
  if (transactionReference.length < 3 || transactionReference.length > 100) {
    return fail(res, 400, 'Provide a valid transaction reference or TrxID (3 to 100 characters).');
  }

  let objectKey;
  try {
    const result = await tx(async (db) => {
      const regQuery = await db.query(
        `select r.id, r.conference_id, r.user_id, r.status, r.reference_code, c.title as conference_title
         from public.registrations r join public.conferences c on c.id = r.conference_id
         where r.id = $1 for update`,
        [req.params.registrationId]
      );
      const reg = regQuery.rows[0];
      if (!reg) return null;
      if (reg.user_id !== req.user.id) throw Object.assign(new Error('Access denied to this registration.'), { status: 403 });
      if (['cancelled', 'refunded'].includes(reg.status)) {
        throw Object.assign(new Error(`Cannot upload payment for ${reg.status} registration.`), { status: 409 });
      }

      // Check payment record
      const pQuery = await db.query(
        `select id, amount, currency, status from public.payments where registration_id = $1 for update`,
        [reg.id]
      );
      const p = pQuery.rows[0];
      if (!p) throw Object.assign(new Error('Payment record not found.'), { status: 404 });
      if (p.status === 'verified') throw Object.assign(new Error('Payment has already been verified.'), { status: 409 });

      const ext = multipart.file.filename.split('.').pop().toLowerCase();
      objectKey = `receipts/${reg.id}/${randomBytes(16).toString('hex')}.${ext}`;
      await storePrivateReceipt(multipart.file, objectKey);

      const updatedPayment = await db.query(
        `update public.payments
         set payment_method = $1, transaction_reference = $2, receipt_object_key = $3,
             receipt_filename = $4, receipt_file_size = $5, status = 'submitted',
             rejection_reason = null, updated_at = now()
         where id = $6
         returning id, status, payment_method, transaction_reference, receipt_filename`,
        [paymentMethod, transactionReference, objectKey, multipart.file.filename.slice(0, 255), multipart.file.data.length, p.id]
      );

      await db.query(
        `update public.registrations set payment_status = 'submitted', updated_at = now() where id = $1`,
        [reg.id]
      );

      await audit(db, req.user.id, 'payment.receipt_uploaded', 'payment', p.id, {
        registrationId: reg.id,
        transactionReference,
        paymentMethod,
      });

      const managers = await managersFor(db, reg.conference_id);
      for (const m of managers) {
        await notify(
          db,
          m.id,
          reg.conference_id,
          'Payment Receipt Submitted',
          `A new payment receipt was uploaded for registration ${reg.reference_code}. Please verify in the admin queue.`
        );
      }

      return {
        payment: updatedPayment.rows[0],
        registrationId: reg.id,
        referenceCode: reg.reference_code,
        conferenceTitle: reg.conference_title,
      };
    });

    if (!result) return fail(res, 404, 'Registration not found.');
    res.json({ data: { message: 'Payment receipt uploaded successfully and submitted for verification.', ...result } });
  } catch (e) {
    next(e);
  }
});

// Secure receipt download link
router.post('/registrations/:registrationId/receipt-link', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.registrationId).success) return fail(res, 400, 'Registration ID is invalid.');
  try {
    const regQuery = await pool.query(
      `select r.id, r.user_id, r.conference_id, p.receipt_object_key
       from public.registrations r
       join public.payments p on p.registration_id = r.id
       where r.id = $1`,
      [req.params.registrationId]
    );
    const reg = regQuery.rows[0];
    if (!reg) return fail(res, 404, 'Registration or payment not found.');
    if (!reg.receipt_object_key) return fail(res, 404, 'No receipt file has been uploaded for this registration.');

    const manager = await isManager(req, reg.conference_id);
    if (reg.user_id !== req.user.id && !manager) return fail(res, 403, 'You do not have access to this receipt.');

    const link = await signedReceiptLink(reg.receipt_object_key);
    res.set('Cache-Control', 'no-store, private');
    res.json({ data: link });
  } catch (e) {
    next(e);
  }
});

// User cancellation request
router.post('/registrations/:registrationId/cancellation-request', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.registrationId).success) return fail(res, 400, 'Registration ID is invalid.');
  const schema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Provide a cancellation reason (5 to 1000 characters).');

  try {
    const result = await tx(async (db) => {
      const regQuery = await db.query(
        `select r.id, r.user_id, r.conference_id, r.status, r.payment_status, r.reference_code, c.title as conference_title
         from public.registrations r join public.conferences c on c.id = r.conference_id
         where r.id = $1 for update`,
        [req.params.registrationId]
      );
      const reg = regQuery.rows[0];
      if (!reg) return null;
      if (reg.user_id !== req.user.id) throw Object.assign(new Error('Access denied.'), { status: 403 });
      if (['cancelled', 'refunded'].includes(reg.status)) {
        throw Object.assign(new Error(`Registration is already ${reg.status}.`), { status: 409 });
      }

      // If unpaid or rejected, directly cancel
      if (['unpaid', 'rejected'].includes(reg.payment_status)) {
        const { rows } = await db.query(
          `update public.registrations
           set status = 'cancelled', cancellation_reason = $1, cancelled_at = now(), updated_at = now()
           where id = $2 returning id, status, reference_code`,
          [parsed.data.reason, reg.id]
        );
        await audit(db, req.user.id, 'registration.cancelled', 'registration', reg.id, { reason: parsed.data.reason });
        return { action: 'cancelled', record: rows[0] };
      }

      // If submitted or verified, request cancellation
      const { rows } = await db.query(
        `update public.registrations
         set status = 'cancellation_requested', cancellation_reason = $1, cancellation_requested_at = now(), updated_at = now()
         where id = $2 returning id, status, reference_code`,
        [parsed.data.reason, reg.id]
      );
      await audit(db, req.user.id, 'registration.cancellation_requested', 'registration', reg.id, { reason: parsed.data.reason });

      const managers = await managersFor(db, reg.conference_id);
      for (const m of managers) {
        await notify(
          db,
          m.id,
          reg.conference_id,
          'Registration Cancellation Requested',
          `Cancellation requested for registration ${reg.reference_code}. Reason: ${parsed.data.reason}`
        );
      }
      return { action: 'requested', record: rows[0] };
    });

    if (!result) return fail(res, 404, 'Registration not found.');
    res.json({
      data: {
        message: result.action === 'cancelled' ? 'Registration cancelled.' : 'Cancellation request submitted to organizers.',
        ...result.record,
      },
    });
  } catch (e) {
    next(e);
  }
});

// User refund request for verified payment
router.post('/registrations/:registrationId/refund-request', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.registrationId).success) return fail(res, 400, 'Registration ID is invalid.');
  const schema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Provide a refund reason (5 to 1000 characters).');

  try {
    const result = await tx(async (db) => {
      const regQuery = await db.query(
        `select r.id, r.user_id, r.conference_id, r.status, r.payment_status, r.reference_code,
                p.id as payment_id, p.amount, p.currency, p.status as payment_status_record
         from public.registrations r
         join public.payments p on p.registration_id = r.id
         where r.id = $1 for update`,
        [req.params.registrationId]
      );
      const reg = regQuery.rows[0];
      if (!reg) return null;
      if (reg.user_id !== req.user.id) throw Object.assign(new Error('Access denied.'), { status: 403 });
      if (reg.payment_status !== 'verified' || reg.payment_status_record !== 'verified') {
        throw Object.assign(new Error('Refund can only be requested for verified payments.'), { status: 409 });
      }

      const existingRefund = await db.query(
        `select id, status from public.registration_refunds where registration_id = $1 and status = 'requested'`,
        [reg.id]
      );
      if (existingRefund.rows[0]) throw Object.assign(new Error('A refund request is already pending review.'), { status: 409 });

      const inserted = await db.query(
        `insert into public.registration_refunds(
           registration_id, payment_id, amount, currency, reason, status, requested_by, requested_at
         ) values($1, $2, $3, $4, $5, 'requested', $6, now())
         returning id, status, amount::float as amount, currency, requested_at`,
        [reg.id, reg.payment_id, reg.amount, reg.currency, parsed.data.reason, req.user.id]
      );

      await db.query(
        `update public.registrations set payment_status = 'refund_requested', updated_at = now() where id = $1`,
        [reg.id]
      );

      await audit(db, req.user.id, 'payment.refund_requested', 'registration_refund', inserted.rows[0].id, {
        registrationId: reg.id,
        amount: reg.amount,
        reason: parsed.data.reason,
      });

      const managers = await managersFor(db, reg.conference_id);
      for (const m of managers) {
        await notify(
          db,
          m.id,
          reg.conference_id,
          'Refund Requested',
          `Refund requested for registration ${reg.reference_code} (${reg.currency} ${reg.amount}).`
        );
      }

      return inserted.rows[0];
    });

    if (!result) return fail(res, 404, 'Registration not found.');
    res.status(201).json({ data: result });
  } catch (e) {
    next(e);
  }
});

// -------------------------------------------------------------
// Admin / Organizer Registration & Payment Management
// -------------------------------------------------------------

// Search, filter, and paginate conference registrations
router.get('/admin/conferences/:conferenceId/registrations', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const paymentStatus = (req.query.paymentStatus || '').trim();
    const category = (req.query.category || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '25', 10) || 25));
    const offset = (page - 1) * limit;

    const conditions = ['r.conference_id = $1'];
    const params = [req.params.conferenceId];

    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conditions.push(`(u.full_name ilike $${idx} or u.email ilike $${idx} or r.reference_code ilike $${idx} or p.transaction_reference ilike $${idx})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`r.status = $${params.length}`);
    }
    if (paymentStatus) {
      params.push(paymentStatus);
      conditions.push(`r.payment_status = $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`r.category = $${params.length}`);
    }

    const whereClause = conditions.join(' and ');

    const [countResult, listResult] = await Promise.all([
      pool.query(
        `select count(*)::int as total
         from public.registrations r
         join public.users u on u.id = r.user_id
         left join public.payments p on p.registration_id = r.id
         where ${whereClause}`,
        params
      ),
      pool.query(
        `select r.id, r.conference_id, r.reference_code, r.category, r.status, r.payment_status,
                r.organization, r.dietary_requirements, r.special_needs, r.cancellation_reason,
                r.registered_at, r.created_at,
                u.id as user_id, u.full_name as registrant_name, u.email as registrant_email, u.institution,
                t.title as tier_title, t.amount::float as tier_amount, t.currency as tier_currency,
                p.id as payment_id, p.amount::float as payment_amount, p.currency as payment_currency,
                p.payment_method, p.transaction_reference, p.status as payment_record_status,
                p.receipt_filename, p.verified_at, p.rejection_reason
         from public.registrations r
         join public.users u on u.id = r.user_id
         left join public.conference_registration_tiers t on t.id = r.tier_id
         left join public.payments p on p.registration_id = r.id
         where ${whereClause}
         order by r.registered_at desc
         limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;
    res.json({
      data: listResult.rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    next(e);
  }
});

// Configure registration tiers (fees, currency, deadlines, capacity)
router.get('/admin/conferences/:conferenceId/registration-tiers', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `select id, category, title, description, amount::float as amount, currency, eligibility_criteria,
              deadline_at, capacity, is_active, created_at, updated_at,
              (select count(*)::int from public.registrations r where r.conference_id = $1 and r.category = t.category and r.status not in ('cancelled', 'refunded')) as registered_count
       from public.conference_registration_tiers t
       where conference_id = $1
       order by amount asc`,
      [req.params.conferenceId]
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

router.put('/admin/conferences/:conferenceId/registration-tiers', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const tierSchema = z.object({
    category: z.enum(allowedCategories),
    title: z.string().trim().min(2).max(150),
    description: z.string().trim().max(1000).nullable().optional(),
    amount: z.number().min(0).max(10000000),
    currency: z.enum(['BDT', 'USD', 'EUR', 'GBP']).default('BDT'),
    eligibilityCriteria: z.string().trim().max(1000).nullable().optional(),
    deadlineAt: z.string().datetime().nullable().optional(),
    capacity: z.number().int().min(1).nullable().optional(),
    isActive: z.boolean().default(true),
  }).strict();

  const parsed = z.array(tierSchema).min(1).max(10).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check registration tier configurations.');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const result = await tx(async (db) => {
      for (const t of parsed.data) {
        await db.query(
          `insert into public.conference_registration_tiers(
             conference_id, category, title, description, amount, currency, eligibility_criteria,
             deadline_at, capacity, is_active, updated_at
           ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           on conflict(conference_id, category) do update
           set title = excluded.title, description = excluded.description, amount = excluded.amount,
               currency = excluded.currency, eligibility_criteria = excluded.eligibility_criteria,
               deadline_at = excluded.deadline_at, capacity = excluded.capacity,
               is_active = excluded.is_active, updated_at = now()`,
          [
            req.params.conferenceId,
            t.category,
            t.title,
            t.description || null,
            t.amount,
            t.currency,
            t.eligibilityCriteria || null,
            t.deadlineAt || null,
            t.capacity || null,
            t.isActive,
          ]
        );
      }
      await audit(db, req.user.id, 'registration.tiers_updated', 'conference', req.params.conferenceId, {
        tierCount: parsed.data.length,
      });
      const { rows } = await db.query(
        `select id, category, title, description, amount::float as amount, currency, eligibility_criteria,
                deadline_at, capacity, is_active
         from public.conference_registration_tiers where conference_id = $1 order by amount asc`,
        [req.params.conferenceId]
      );
      return rows;
    });
    res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

// Update overall conference max capacity
router.patch('/admin/conferences/:conferenceId/capacity', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  const schema = z.object({ maxCapacity: z.number().int().min(1).nullable() }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Max capacity must be a positive integer or null (unlimited).');

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `update public.conferences set max_capacity = $1, updated_at = now() where id = $2 returning id, max_capacity`,
      [parsed.data.maxCapacity, req.params.conferenceId]
    );
    if (!rows[0]) return fail(res, 404, 'Conference not found.');
    await audit(pool, req.user.id, 'conference.capacity_updated', 'conference', req.params.conferenceId, {
      maxCapacity: parsed.data.maxCapacity,
    });
    res.json({ data: rows[0] });
  } catch (e) {
    next(e);
  }
});

// Admin payment verification queue (receipts waiting for verification)
router.get('/admin/conferences/:conferenceId/payments/verification-queue', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `select p.id, p.registration_id, p.amount::float as amount, p.currency, p.payment_method,
              p.transaction_reference, p.status, p.receipt_object_key, p.receipt_filename,
              p.receipt_file_size, p.created_at, p.updated_at,
              r.reference_code, r.category, r.status as registration_status, r.registered_at,
              u.id as user_id, u.full_name as registrant_name, u.email as registrant_email, u.institution,
              t.title as tier_title
       from public.payments p
       join public.registrations r on r.id = p.registration_id
       join public.users u on u.id = r.user_id
       left join public.conference_registration_tiers t on t.id = r.tier_id
       where r.conference_id = $1 and p.status = 'submitted'
       order by p.updated_at asc`,
      [req.params.conferenceId]
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

// Admin verify (approve or reject) payment receipt
router.post('/admin/conferences/:conferenceId/payments/:paymentId/verify', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.paymentId).success) {
    return fail(res, 400, 'Conference or Payment ID is invalid.');
  }
  const schema = z.object({
    action: z.enum(['approve', 'reject']),
    rejectionReason: z.string().trim().max(1000).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Choose approve or reject with appropriate notes.');
  if (parsed.data.action === 'reject' && (!parsed.data.rejectionReason || parsed.data.rejectionReason.length < 5)) {
    return fail(res, 400, 'Provide a rejection reason explaining why the receipt was rejected (at least 5 characters).');
  }

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const result = await tx(async (db) => {
      const pQuery = await db.query(
        `select p.id, p.registration_id, p.amount, p.currency, p.status,
                r.conference_id, r.user_id, r.reference_code, r.category,
                u.email as registrant_email, u.full_name as registrant_name,
                c.title as conference_title
         from public.payments p
         join public.registrations r on r.id = p.registration_id
         join public.users u on u.id = r.user_id
         join public.conferences c on c.id = r.conference_id
         where p.id = $1 for update`,
        [req.params.paymentId]
      );
      const p = pQuery.rows[0];
      if (!p || p.conference_id !== req.params.conferenceId) return null;
      if (['verified', 'refunded'].includes(p.status)) {
        throw Object.assign(new Error(`This payment is already ${p.status}.`), { status: 409 });
      }

      if (parsed.data.action === 'approve') {
        const updatedPayment = await db.query(
          `update public.payments
           set status = 'verified', paid_at = now(), verified_at = now(), verified_by = $1,
               verification_notes = $2, rejection_reason = null, updated_at = now()
           where id = $3
           returning id, status, amount::float as amount, currency, verified_at`,
          [req.user.id, parsed.data.notes || null, p.id]
        );

        await db.query(
          `update public.registrations
           set status = 'confirmed', payment_status = 'verified', updated_at = now()
           where id = $1`,
          [p.registration_id]
        );

        await audit(db, req.user.id, 'payment.verified', 'payment', p.id, {
          registrationId: p.registration_id,
          amount: p.amount,
          currency: p.currency,
        });

        await notify(
          db,
          p.user_id,
          p.conference_id,
          'Registration Confirmed',
          `Your payment receipt for ${p.conference_title} has been verified. Your registration (Ref: ${p.reference_code}) is now confirmed!`
        );

        return {
          action: 'approved',
          payment: updatedPayment.rows[0],
          registrant: { email: p.registrant_email, name: p.registrant_name },
          referenceCode: p.reference_code,
          conferenceTitle: p.conference_title,
        };
      } else {
        const updatedPayment = await db.query(
          `update public.payments
           set status = 'rejected', rejection_reason = $1, verified_at = now(), verified_by = $2,
               verification_notes = $3, updated_at = now()
           where id = $4
           returning id, status, rejection_reason, verified_at`,
          [parsed.data.rejectionReason, req.user.id, parsed.data.notes || null, p.id]
        );

        await db.query(
          `update public.registrations
           set payment_status = 'rejected', updated_at = now()
           where id = $1`,
          [p.registration_id]
        );

        await audit(db, req.user.id, 'payment.rejected', 'payment', p.id, {
          registrationId: p.registration_id,
          reason: parsed.data.rejectionReason,
        });

        await notify(
          db,
          p.user_id,
          p.conference_id,
          'Payment Receipt Rejected',
          `Your payment receipt for registration ${p.reference_code} was not accepted: ${parsed.data.rejectionReason}. Please sign in to re-upload a valid receipt.`
        );

        return {
          action: 'rejected',
          payment: updatedPayment.rows[0],
          registrant: { email: p.registrant_email, name: p.registrant_name },
          referenceCode: p.reference_code,
          conferenceTitle: p.conference_title,
          rejectionReason: parsed.data.rejectionReason,
        };
      }
    });

    if (!result) return fail(res, 404, 'Payment record not found for this conference.');

    if (result.action === 'approved') {
      void emailIfConfigured(
        result.registrant.email,
        `Payment Verified - BUP Registration Confirmed: ${result.referenceCode}`,
        `Your payment has been successfully verified by the conference organizing committee.\n\nConference: ${result.conferenceTitle}\nRegistration Reference: ${result.referenceCode}\nStatus: Confirmed`
      );
    } else {
      void emailIfConfigured(
        result.registrant.email,
        `Payment Receipt Verification Issue: ${result.referenceCode}`,
        `Your uploaded payment receipt could not be verified by the organizers.\n\nReason: ${result.rejectionReason}\n\nPlease sign in to your dashboard to review and upload a corrected payment receipt.`
      );
    }

    res.json({ data: result.payment });
  } catch (e) {
    next(e);
  }
});

// Financial report and reconciliation
router.get('/admin/conferences/:conferenceId/financial-report', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const [confResult, countResult, currencySummary, categorySummary, methodSummary, refundsSummary, recentQuery] = await Promise.all([
      pool.query(
        `select id, title, max_capacity from public.conferences where id = $1`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select count(*)::int as count from public.registrations where conference_id = $1 and status not in ('cancelled', 'refunded')`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select p.currency,
                coalesce(count(case when p.status = 'verified' then 1 end), 0)::int as verified_count,
                coalesce(sum(case when p.status = 'verified' then p.amount else 0 end), 0)::float as verified_total,
                coalesce(count(case when p.status = 'submitted' then 1 end), 0)::int as pending_count,
                coalesce(sum(case when p.status = 'submitted' then p.amount else 0 end), 0)::float as pending_total,
                coalesce(count(case when p.status = 'refunded' then 1 end), 0)::int as refunded_count,
                coalesce(sum(case when p.status = 'refunded' then p.amount else 0 end), 0)::float as refunded_total
         from public.payments p
         join public.registrations r on r.id = p.registration_id
         where r.conference_id = $1
         group by p.currency`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select r.category,
                count(*)::int as total_registrations,
                coalesce(count(case when r.status = 'confirmed' then 1 end), 0)::int as confirmed_count,
                coalesce(sum(case when p.status = 'verified' then p.amount else 0 end), 0)::float as verified_revenue
         from public.registrations r
         left join public.payments p on p.registration_id = r.id
         where r.conference_id = $1
         group by r.category`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select p.payment_method,
                count(*)::int as count,
                coalesce(sum(case when p.status = 'verified' then p.amount else 0 end), 0)::float as verified_amount
         from public.payments p
         join public.registrations r on r.id = p.registration_id
         where r.conference_id = $1 and p.status in ('submitted', 'verified')
         group by p.payment_method`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select count(*)::int as total_requests,
                coalesce(count(case when ref.status = 'requested' then 1 end), 0)::int as pending_requests,
                coalesce(count(case when ref.status = 'processed' then 1 end), 0)::int as processed_requests,
                coalesce(sum(case when ref.status = 'processed' then ref.amount else 0 end), 0)::float as processed_amount
         from public.registration_refunds ref
         join public.registrations r on r.id = ref.registration_id
         where r.conference_id = $1`,
        [req.params.conferenceId]
      ),
      pool.query(
        `select p.id, p.amount::float as amount, p.currency, p.payment_method, p.transaction_reference,
                p.status, p.paid_at, p.verified_at, r.reference_code, r.category,
                u.full_name as registrant_name, u.email as registrant_email
         from public.payments p
         join public.registrations r on r.id = p.registration_id
         join public.users u on u.id = r.user_id
         where r.conference_id = $1
         order by p.updated_at desc
         limit 30`,
        [req.params.conferenceId]
      ),
    ]);

    const conf = confResult.rows[0];
    if (!conf) return fail(res, 404, 'Conference not found.');
    const activeRegistrations = countResult.rows[0]?.count || 0;

    res.json({
      data: {
        conference: {
          id: conf.id,
          title: conf.title,
          maxCapacity: conf.max_capacity,
          activeRegistrations,
          remainingCapacity: conf.max_capacity ? Math.max(0, conf.max_capacity - activeRegistrations) : null,
        },
        revenueByCurrency: currencySummary.rows,
        categoryBreakdown: categorySummary.rows,
        paymentMethods: methodSummary.rows,
        refunds: refundsSummary.rows[0] || {},
        recentTransactions: recentQuery.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

// List pending refund requests
router.get('/admin/conferences/:conferenceId/refunds', dbRequired, requireAuth, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success) return fail(res, 400, 'Conference ID is invalid.');
  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');
    const { rows } = await pool.query(
      `select ref.id, ref.registration_id, ref.payment_id, ref.amount::float as amount, ref.currency,
              ref.reason, ref.status, ref.requested_at, ref.processed_at, ref.processor_reference,
              ref.admin_notes,
              r.reference_code, r.category,
              u.full_name as registrant_name, u.email as registrant_email,
              p.transaction_reference, p.payment_method
       from public.registration_refunds ref
       join public.registrations r on r.id = ref.registration_id
       join public.users u on u.id = ref.requested_by
       join public.payments p on p.id = ref.payment_id
       where r.conference_id = $1
       order by case when ref.status = 'requested' then 0 else 1 end, ref.requested_at desc`,
      [req.params.conferenceId]
    );
    res.json({ data: rows });
  } catch (e) {
    next(e);
  }
});

// Process or reject refund request
router.post('/admin/conferences/:conferenceId/refunds/:refundId/process', dbRequired, requireAuth, requireCsrf, async (req, res, next) => {
  if (!uuid.safeParse(req.params.conferenceId).success || !uuid.safeParse(req.params.refundId).success) {
    return fail(res, 400, 'Conference or Refund ID is invalid.');
  }
  const schema = z.object({
    action: z.enum(['approve', 'reject']),
    processorReference: z.string().trim().max(100).optional(),
    adminNotes: z.string().trim().max(1000).optional(),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Check refund processing action and details.');
  if (parsed.data.action === 'approve' && (!parsed.data.processorReference || parsed.data.processorReference.length < 3)) {
    return fail(res, 400, 'Provide a confirmed bank or payment processor refund transaction reference.');
  }

  try {
    if (!await isManager(req, req.params.conferenceId)) return fail(res, 403, 'Conference Organizer access is required.');

    const result = await tx(async (db) => {
      const refQuery = await db.query(
        `select ref.id, ref.registration_id, ref.payment_id, ref.amount, ref.currency, ref.status,
                r.conference_id, r.user_id, r.reference_code,
                u.email as registrant_email, u.full_name as registrant_name,
                c.title as conference_title
         from public.registration_refunds ref
         join public.registrations r on r.id = ref.registration_id
         join public.users u on u.id = r.user_id
         join public.conferences c on c.id = r.conference_id
         where ref.id = $1 for update`,
        [req.params.refundId]
      );
      const ref = refQuery.rows[0];
      if (!ref || ref.conference_id !== req.params.conferenceId) return null;
      if (ref.status !== 'requested') throw Object.assign(new Error(`Refund request is already ${ref.status}.`), { status: 409 });

      if (parsed.data.action === 'approve') {
        const updatedRefund = await db.query(
          `update public.registration_refunds
           set status = 'processed', processed_at = now(), processed_by = $1,
               processor_reference = $2, admin_notes = $3
           where id = $4
           returning id, status, amount::float as amount, currency, processed_at, processor_reference`,
          [req.user.id, parsed.data.processorReference, parsed.data.adminNotes || null, ref.id]
        );

        await db.query(`update public.payments set status = 'refunded', updated_at = now() where id = $1`, [ref.payment_id]);
        await db.query(
          `update public.registrations set status = 'refunded', payment_status = 'refunded', updated_at = now() where id = $1`,
          [ref.registration_id]
        );

        await audit(db, req.user.id, 'payment.refund_processed', 'registration_refund', ref.id, {
          registrationId: ref.registration_id,
          amount: ref.amount,
          processorReference: parsed.data.processorReference,
        });

        await notify(
          db,
          ref.user_id,
          ref.conference_id,
          'Refund Processed',
          `Your refund of ${ref.currency} ${ref.amount} for registration ${ref.reference_code} has been processed (Ref: ${parsed.data.processorReference}).`
        );

        return {
          action: 'approved',
          refund: updatedRefund.rows[0],
          registrant: { email: ref.registrant_email, name: ref.registrant_name },
          referenceCode: ref.reference_code,
          conferenceTitle: ref.conference_title,
          amount: ref.amount,
          currency: ref.currency,
          processorReference: parsed.data.processorReference,
        };
      } else {
        const updatedRefund = await db.query(
          `update public.registration_refunds
           set status = 'rejected', processed_at = now(), processed_by = $1, admin_notes = $2
           where id = $3
           returning id, status, admin_notes, processed_at`,
          [req.user.id, parsed.data.adminNotes || null, ref.id]
        );

        await db.query(
          `update public.registrations set payment_status = 'verified', updated_at = now() where id = $1`,
          [ref.registration_id]
        );

        await audit(db, req.user.id, 'payment.refund_rejected', 'registration_refund', ref.id, {
          registrationId: ref.registration_id,
          notes: parsed.data.adminNotes,
        });

        await notify(
          db,
          ref.user_id,
          ref.conference_id,
          'Refund Request Rejected',
          `Your refund request for registration ${ref.reference_code} was declined by the organizers.`
        );

        return {
          action: 'rejected',
          refund: updatedRefund.rows[0],
          registrant: { email: ref.registrant_email, name: ref.registrant_name },
          referenceCode: ref.reference_code,
          conferenceTitle: ref.conference_title,
        };
      }
    });

    if (!result) return fail(res, 404, 'Refund record not found.');

    if (result.action === 'approved') {
      void emailIfConfigured(
        result.registrant.email,
        `Refund Processed: ${result.referenceCode}`,
        `Your refund of ${result.currency} ${result.amount} has been processed.\n\nBank Processor Reference: ${result.processorReference}\nConference: ${result.conferenceTitle}`
      );
    }

    res.json({ data: result.refund });
  } catch (e) {
    next(e);
  }
});

export default router;
