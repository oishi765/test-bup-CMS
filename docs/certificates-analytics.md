# Certificates, Notifications, Analytics & Reports

This document outlines the architecture, data models, business rules, and API endpoints for Certificates, In-App / Email Notifications, and Conference Analytics & Reporting in the BUP Conference Management System.

---

## 1. Certificates Architecture

### 1.1 Unique ID Format
Certificates use a deterministic, collision-resistant format:
```text
BUP-CERT-[YEAR]-[CONF_ACRONYM]-[TYPE_ABBR]-[RANDOM_HEX]
Example: BUP-CERT-2026-BUP-CONF-ATT-F4A1B2
```
A database unique constraint on `(conference_id, user_id, certificate_type)` prevents duplicate issuance for the same role and event.

### 1.2 Eligibility Matrix
Eligibility is computed dynamically from real database records:
- **Attendee:** Confirmed registration (`status = 'confirmed'`) AND at least 1 verified session check-in in `session_attendance`.
- **Presenter:** Scheduled presentation slot in `session_presentations` with `status = 'completed'`.
- **Author:** Authored research submission with status `accepted`, `camera_ready`, or `finalized`.
- **Reviewer:** At least 1 completed review in `reviews` (`status = 'completed'`).
- **Organizer:** Conference Admin or Session Chair assignment for the conference.

Organizers can manually grant a certificate with an eligibility override (`override_eligibility: true`), which requires documenting the administrative justification in audit logs.

### 1.3 Revocation Workflow
Organizers can revoke any certificate:
- A mandatory reason must be provided (min 5 characters).
- Marks `is_revoked = true`, records `revoked_at`, `revoked_by`, and `revocation_reason`.
- Emits an in-app notification to the recipient.
- The public verification page (`/certificate-verification`) immediately shows the certificate as **Revoked / Invalid** along with the date and reason.
- If downloaded, the PDF generator draws a prominent semi-transparent red **"REVOKED"** watermark diagonally across the certificate.

### 1.4 PDF Generation
Vector PDF certificates are rendered on demand using `pdfkit`:
- A4 Landscape layout.
- Formal institutional border in BUP Forest Green (`#006a4e`) and Gold (`#c99700`).
- Conference details, recipient name, role badge, issue date, and certificate identifier.
- Direct verification URL printed at the bottom.
- Configurable signatory names and titles from `public.certificate_templates`.

---

## 2. In-App Notifications & Email Delivery

### 2.1 Storage & Preferences
- Notifications persist in `public.notifications` with columns: `user_id`, `category`, `title`, `body`, `link`, `is_read`, `read_at`, `delivery_status`, `created_at`.
- Categories supported: `submission`, `review`, `registration`, `payment`, `schedule`, `certificate`, `announcement`, `general`.
- User preferences persist in `public.notification_preferences` with toggles for:
  - `email_notifications`
  - `submission_updates`
  - `review_updates`
  - `schedule_updates`
  - `announcements`

### 2.2 Delivery Outcomes
When notifications are dispatched via `sendNotification()`:
- User preferences are checked first. If disabled, delivery status is recorded as `'skipped_by_preference'`.
- If an email provider is configured (`SMTP_HOST`, `SMTP_USER`), real email delivery is attempted.
- Delivery outcome is accurately recorded in the database:
  - `'sent'` - email successfully handed to SMTP provider.
  - `'not_configured'` - no SMTP server configured; in-app notification preserved.
  - `'failed'` - SMTP error occurred; logged with error context.

---

## 3. Analytics & Exportable Reports

### 3.1 Live PostgreSQL Metrics
All metrics on the Analytics Dashboard (`/admin/analytics`) are derived directly from live database tables:
- **Submissions:** Total, submitted, in review, revision requested, accepted, rejected, camera ready, finalized.
- **Reviews:** Total assigned, completed, pending, overdue, and average score across completed reviews.
- **Registrations:** Confirmed, pending payment, cancelled, capacity count, and capacity percentage.
- **Payments & Revenue:** Total verified revenue (in BDT and USD), verified transaction count, pending receipt review count, and refunded totals.
- **Attendance:** Unique attendees checked in, total session check-ins, presentations completed, scheduled, absent, or rescheduled.
- **Certificates:** Total issued, active count, revoked count, and category breakdown.

### 3.2 Export Formats
- **CSV Exports:**
  - Registrations: `/api/admin/conferences/:id/reports/registrations/csv`
  - Research Submissions: `/api/admin/conferences/:id/reports/submissions/csv`
  - Attendance Records: `/api/admin/conferences/:id/reports/attendance/csv`
  - Fully RFC 4180 compliant with double-quote escaping.
- **PDF Executive Summary Report:**
  - `/api/admin/conferences/:id/reports/summary/pdf`
  - Portrait A4 document containing key conference KPIs, registration numbers, revenue reconciliation, peer review performance, and attendance summaries.

---

## 4. API Endpoints Reference

### Certificates
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/certificates/my` | Authenticated | List all certificates issued to caller |
| `GET` | `/api/certificates/:id/download` | Public / Recipient | Download certificate PDF |
| `GET` | `/api/certificates/verify/:number` | Public | Verify certificate status and validity |
| `GET` | `/api/conferences/:id/certificates/eligibility` | Authenticated | Evaluate eligibility matrix |
| `POST` | `/api/conferences/:id/certificates/claim` | Authenticated + CSRF | Claim eligible certificate |
| `GET` | `/api/admin/conferences/:id/certificates` | Conference Admin | Search & filter issued certificates |
| `POST` | `/api/admin/conferences/:id/certificates/issue` | Conference Admin + CSRF | Manually issue or override eligibility |
| `POST` | `/api/admin/conferences/:id/certificates/:id/revoke` | Conference Admin + CSRF | Revoke certificate with reason |
| `GET` | `/api/admin/conferences/:id/certificates/template` | Conference Admin | Get conference certificate template |
| `PUT` | `/api/admin/conferences/:id/certificates/template` | Conference Admin + CSRF | Update certificate template |

### Notifications
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/notifications` | Authenticated | Get user notifications with unread count |
| `PATCH` | `/api/notifications/:id/read` | Authenticated + CSRF | Mark notification as read |
| `POST` | `/api/notifications/mark-all-read` | Authenticated + CSRF | Mark all notifications as read |
| `GET` | `/api/notifications/preferences` | Authenticated | Get user notification preferences |
| `PUT` | `/api/notifications/preferences` | Authenticated + CSRF | Update notification preferences |

### Analytics & Reports
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/admin/conferences/:id/analytics` | Conference Admin | Get live conference KPIs and distributions |
| `GET` | `/api/admin/conferences/:id/reports/registrations/csv` | Conference Admin | Export registrations CSV |
| `GET` | `/api/admin/conferences/:id/reports/submissions/csv` | Conference Admin | Export submissions CSV |
| `GET` | `/api/admin/conferences/:id/reports/attendance/csv` | Conference Admin | Export attendance CSV |
| `GET` | `/api/admin/conferences/:id/reports/summary/pdf` | Conference Admin | Download Executive Summary PDF |
| `GET` | `/api/admin/analytics/global` | Super Admin | Global statistics across all conferences |
