# Conference Registration and Payment Management

Apply `database/registration-payment-schema.sql` in the Supabase SQL Editor after `peer-review-schema.sql`. It adds configurable registration tiers, conference capacity controls, offline receipt submission, organizer verification queue, financial reconciliation, and refund tracking.

## Registration Workflow

1. **Conference Tiers & Pricing**:
   - Each conference supports 4 primary categories: **Author**, **Student**, **Professional**, and **General Attendee**.
   - Fees, currencies (`BDT`, `USD`, `EUR`, `GBP`), eligibility criteria, category capacity limits, and deadlines can be configured by organizers at `/admin/registrations`.
   - The server validates all tier amounts directly against the database upon registration; client amounts are never trusted.

2. **Attendee Registration**:
   - Attendees register at `/registration-information` (or `/registrations`).
   - If registering as an **Author**, the attendee selects their accepted conference paper.
   - Dietary requirements, special assistance needs, and organization details are recorded.
   - Upon registration, the attendee is assigned a unique tracking reference formatted as `BUP-REG-YYYY-XXXXX`.
   - Concurrency-safe capacity management: Conference and tier limits are checked using PostgreSQL row-level locks (`SELECT ... FOR UPDATE`), preventing race conditions when parallel registrations occur.
   - Duplicate registrations for the same conference are rejected (`unique(conference_id, user_id)`).

3. **Status Separation**:
   - **Registration status**: `pending` → `confirmed` (or `cancellation_requested` → `cancelled` / `refunded`).
   - **Payment status**: `unpaid` → `submitted` → `verified` (or `rejected` / `refund_requested` / `refunded`).

## Offline Payment & Receipt Verification

1. **Receipt Submission**:
   - Attendees upload bank deposit slips, mobile banking transaction screenshots (bKash, Nagad, Rocket), or wire transfer advices at `/registrations`.
   - Accepted file types: `application/pdf`, `image/jpeg`, `image/png` (validated up to 5 MB with magic byte inspection).
   - Attendee enters their payment method and official transaction reference (TrxID / scroll number).
   - Receipts are stored in the private Supabase Storage bucket (`receipts/` path prefix) and are never publicly accessible.
   - Status updates to `submitted`, and organizers are notified in-app.

2. **Organizer Verification Queue**:
   - Organizers navigate to `/admin/registrations` → **Verification Queue**.
   - Temporary short-lived signed URLs (5 minutes expiration) are generated to review the receipt document.
   - **Approve**: Sets payment status to `verified` and registration status to `confirmed`. In-app notification and confirmation email are sent to the attendee.
   - **Reject**: Requires a mandatory explanation (e.g., "TrxID not found on BUP bank statement"). Sets payment status to `rejected`. Attendee receives an in-app notice and email with instructions to re-upload.

3. **Refunds & Reconciliation**:
   - Verified attendees can submit refund requests with justification.
   - Organizers process offline bank refunds by entering the official institutional refund transaction reference.
   - Financial report dashboard displays gross verified revenue, pending queue totals, refunded amounts, category revenue breakdown, and capacity utilization.

## Security & Integrity

- **No Card Data Storage**: Real card numbers, CVVs, or banking credentials are never requested or stored.
- **Strict Role-Based Scoping**: Only conference organizers assigned to the conference, or Super Admins, can access the verification queue, download receipts, or process refunds.
- **Audit Logs**: All key state transitions (`registration.created`, `payment.receipt_uploaded`, `payment.verified`, `payment.rejected`, `payment.refund_processed`) are recorded in `public.audit_logs`.
