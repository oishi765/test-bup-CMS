# Conference Scheduling and Attendance Management

This document details the Conference Scheduling and Attendance Management module implemented for the BUP Conference Management System.

---

## 1. Overview & Architecture

The Scheduling and Attendance subsystem completes the academic conference lifecycle:
- Papers submitted, reviewed, and accepted are scheduled into specific presentation slots.
- Venues, rooms, and session chairs are assigned with automated conflict detection.
- Schedules are made available to attendees through multi-dimensional filters (day, room, track, format) and personalized "My Schedule" views.
- Real-time presentation tracking allows session chairs to mark presentations as completed, absent, cancelled, or rescheduled.
- Attendance is recorded via manual roster verification or secure rotating QR tokens.
- Organizers receive attendance reports and automated certificate eligibility calculations.

---

## 2. Database Schema

The database migration is defined in [`database/scheduling-attendance-schema.sql`](../database/scheduling-attendance-schema.sql) and extends Supabase PostgreSQL:

### `public.sessions`
- `id`: UUID (Primary Key)
- `conference_id`: UUID (Foreign Key references `conferences`)
- `track_id`: UUID (Foreign Key references `tracks`, nullable)
- `session_code`: TEXT (e.g., `S-101`)
- `title`: TEXT (Required)
- `description`: TEXT
- `venue`: TEXT (Building / Facility)
- `room`: TEXT (e.g., `Auditorium 2`, `Room 301`)
- `format`: TEXT (`in_person`, `virtual`, `hybrid`)
- `session_type`: TEXT (`keynote`, `paper_session`, `poster_session`, `workshop`, `panel`, `break`)
- `starts_at`: TIMESTAMPTZ (Start time)
- `ends_at`: TIMESTAMPTZ (End time, must be after `starts_at`)
- `session_chair_id`: UUID (Foreign Key references `users`, nullable)
- `is_published`: BOOLEAN (Controls public schedule visibility)
- `created_at` / `updated_at`: TIMESTAMPTZ

### `public.session_submissions` (Presentation Slots)
- `id`: UUID (Primary Key)
- `session_id`: UUID (Foreign Key references `sessions`)
- `submission_id`: UUID (Foreign Key references `submissions`)
- `slot_number`: INTEGER (Ordering within session, default 1)
- `duration_minutes`: INTEGER (e.g. 15, 20)
- `starts_at` / `ends_at`: TIMESTAMPTZ (Optional slot-level timestamps)
- `presenter_user_id`: UUID (Foreign Key references `users`, nullable)
- `presentation_status`: TEXT (`scheduled`, `in_progress`, `completed`, `absent`, `cancelled`, `rescheduled`)
- `chair_notes`: TEXT (Observations recorded by session chair)
- Unique constraint: A submission cannot be concurrently scheduled across multiple sessions.

### `public.attendance`
- `id`: UUID (Primary Key)
- `session_id`: UUID (Foreign Key references `sessions`)
- `user_id`: UUID (Foreign Key references `users`)
- `check_in_method`: TEXT (`manual`, `qr_code`, `chair_verified`)
- `attendance_role`: TEXT (`participant`, `presenter`, `chair`)
- `recorded_by`: UUID (Foreign Key references `users`, nullable)
- `checked_in_at`: TIMESTAMPTZ
- Unique constraint: `(session_id, user_id)` prevents duplicate check-ins.

### `public.session_checkin_tokens`
- `id`: UUID (Primary Key)
- `session_id`: UUID (Foreign Key references `sessions`)
- `token_hash`: TEXT (SHA-256 hash of opaque 64-hex token)
- `expires_at`: TIMESTAMPTZ (Default 2-hour validity window)

---

## 3. Conflict Detection Engine

Before saving a session (POST or PATCH), the backend evaluates two distinct types of scheduling conflicts:

1. **Room Overlap Conflict:**
   Checks if another session in the same conference is booked in the same room with an overlapping time window:
   $$\text{starts\_at} < \text{other.ends\_at} \quad\land\quad \text{ends\_at} > \text{other.starts\_at}$$
2. **Session Chair Overlap Conflict:**
   Checks if the selected session chair is already assigned to lead another session during an overlapping time window.

If a conflict is detected, the server returns an HTTP 409 Conflict with an explicit error message detailing the conflicting session and time window.

---

## 4. Paper Presentation Assignment

- **Eligibility:** Only papers whose status is in `('accepted', 'camera_ready', 'finalized')` can be assigned to a session. Papers currently in draft or under review are rejected with HTTP 409.
- **Presenter Resolution:** Defaults to the designated submitter or an explicitly selected author/user.
- **Stakeholder Notifications:** If session timings or room locations are modified, automated in-app notifications are generated for all presenting authors and session chairs.

---

## 5. Session Chair Dashboard & Attendance Verification

- **Real-Time Outcomes:** Session chairs can transition presentation statuses during the session:
  - `scheduled` $\rightarrow$ `in_progress` $\rightarrow$ `completed`
  - `absent` (no-show)
  - `cancelled`
  - `rescheduled`
- **Roster Check-in:** Chairs can view who has checked in and manually mark registered attendees present.
- **Rotating QR Token Check-in:**
  - Chairs or conference admins generate a dynamic check-in token.
  - The token is valid for 2 hours.
  - The generated URL (`/check-in?sessionId=...&token=...`) contains no personal information (PII).
  - When scanned or entered by an attendee, the server validates the hash and verifies the attendee's registration before recording attendance.

---

## 6. Attendance Reports & Certificate Eligibility

Organizers can access `/api/admin/conferences/:id/attendance-report`:
- Displays total conference sessions and attendance percentage per attendee.
- Evaluates certificate eligibility:
  - An attendee is eligible if they have attended at least 1 session ($\ge 1$) OR if their paper presentation is marked as `completed`.
  - Links to issued certificate numbers if already generated.

---

## 7. Automated Test Suite

Run offline unit and integration tests using `pg-mem`:
```powershell
npm.cmd --prefix server test
```
The test suite in [`server/test/scheduling-attendance.test.js`](../server/test/scheduling-attendance.test.js) verifies:
- Organizer session creation and validation.
- Room and chair conflict detection (HTTP 409).
- Paper eligibility enforcement (rejects non-accepted papers).
- Duplicate paper assignment prevention.
- Schedule publication visibility rules.
- In-app notification delivery on schedule updates.
- Attendance check-in and rotating QR token verification.
- Session chair presentation status updates and chair notes.
- Attendance report and certificate eligibility calculation.
