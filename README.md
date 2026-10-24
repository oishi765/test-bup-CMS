# BUP Conference Management System

An institutional academic conference management platform designed for the **Bangladesh University of Professionals (BUP)**. Built with JavaScript/JSX, React 18, Vite, Node.js, Express, and cloud-native Supabase PostgreSQL.

> [!NOTE]
> **Zero Local PostgreSQL Requirement:** This project is designed exclusively for **Supabase Cloud**. You do not need to install PostgreSQL locally on your machine. All database schemas are executed directly in your browser using the Supabase SQL Editor.

---

## 1. Quick Start Guide (Windows PowerShell)

### Prerequisites
- [Node.js](https://nodejs.org/) v20.19+ or v22.12+ (LTS recommended) and `npm`.
- A free [Supabase Cloud](https://supabase.com/) account.

### Step 1: Clone & Install Dependencies
Open PowerShell in VS Code at the project root folder:

```powershell
# Copy environment configuration templates
Copy-Item server\.env.example server\.env
Copy-Item client\.env.example client\.env

# Install backend dependencies
npm.cmd --prefix server install

# Install frontend dependencies
npm.cmd --prefix client install
```

### Step 2: Configure Supabase Cloud (Browser-Based)
1. Sign in to [Supabase](https://app.supabase.com) and create a new project (e.g. `bup-cms`).
2. Go to **Project Settings → Database → Connection string → URI**. Copy the PostgreSQL connection URI.
3. Open `server\.env` in your editor and paste it:
   ```env
   DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres
   ```
4. Generate a secure random CSRF secret and paste it into `server\.env`:
   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```
5. In Supabase Dashboard, go to **SQL Editor → New Query**, and execute the migration files in `database/` in this exact order:
   1. `database/schema.sql`
   2. `database/auth-schema.sql`
   3. `database/admin-dashboard-schema.sql`
   4. `database/submission-workflow-schema.sql`
   5. `database/peer-review-schema.sql`
   6. `database/registration-payment-schema.sql`
   7. `database/scheduling-attendance-schema.sql`
   8. `database/certificates-analytics-schema.sql`
6. In Supabase Dashboard, go to **Storage**:
   - Create a new bucket named `manuscripts` and set it to **Private**.
   - Create a new bucket named `receipts` and set it to **Private**.
   - Copy your Project URL and `service_role` secret (from **Project Settings → API**) and add them to `server\.env`:
     ```env
     SUPABASE_URL=https://[YOUR-PROJECT-REF].supabase.co
     SUPABASE_SERVICE_ROLE_KEY=[YOUR-SERVICE-ROLE-SECRET]
     SUPABASE_STORAGE_BUCKET=manuscripts
     ```

### Step 3: Bootstrap the First Super Admin
Run the interactive CLI utility to create the initial root Super Admin account:

```powershell
npm.cmd --prefix server run auth:bootstrap-admin
```
Follow the interactive prompts to enter the admin name, email, and secure password.

### Step 4: Run the Application
Open two separate PowerShell terminal tabs:

**Terminal 1 (Backend API):**
```powershell
npm.cmd --prefix server run dev
```
*API starts at:* `http://localhost:3000`

**Terminal 2 (Frontend Client):**
```powershell
npm.cmd --prefix client run dev
```
*Web application opens at:* `http://localhost:5173`

---

## 2. Local URLs Reference

| Page / Workspace | Local URL | Role Access |
|---|---|---|
| Public Homepage | `http://localhost:5173/` | Public |
| Conference Directory | `http://localhost:5173/conferences` | Public |
| Schedule & Sessions | `http://localhost:5173/schedule` | Public / Presenters |
| Registration Information | `http://localhost:5173/registration-information` | Public / Attendee |
| Certificate Verification | `http://localhost:5173/certificate-verification` | Public |
| Sign In / Sign Up | `http://localhost:5173/login` | Public |
| Attendee / User Dashboard | `http://localhost:5173/dashboard` | Authenticated |
| My Registrations & Payments | `http://localhost:5173/registrations` | Attendee |
| My Claimed Certificates | `http://localhost:5173/certificates` | Authenticated |
| Author Submissions Portal | `http://localhost:5173/author/submissions` | Author |
| Reviewer Workspace | `http://localhost:5173/reviewer` | Reviewer |
| Session Chair Workspace | `http://localhost:5173/chair` | Session Chair |
| Admin Conference Management | `http://localhost:5173/admin` | Conference Admin / Super Admin |
| Peer Review Management | `http://localhost:5173/admin/reviews` | Conference Admin / Super Admin |
| Registration & Payment Verification | `http://localhost:5173/admin/registrations` | Conference Admin / Super Admin |
| Conference Scheduling & Sessions | `http://localhost:5173/admin/schedule` | Conference Admin / Super Admin |
| Certificate Management & Revocation | `http://localhost:5173/admin/certificates` | Conference Admin / Super Admin |
| Live Analytics & Report Exports | `http://localhost:5173/admin/analytics` | Conference Admin / Super Admin |

---

## 3. Automated Test Suites & Verification

The backend includes comprehensive test suites running on an isolated in-memory PostgreSQL engine (`pg-mem`). To run the entire test suite:

```powershell
npm.cmd --prefix server test
```

### Verified Test Results (39 / 39 Passing)
```text
✔ non-admin cannot create conference or read admin records
✔ Super Admin creates, publishes, filters, and audits a conference
✔ conference edit API saves validated updates
✔ unauthenticated requests are denied and CSRF is required on mutations
✔ login attempts from one client IP are rate limited
✔ registration hashes the password, assigns only Attendee, issues a secure session, and rejects role injection
✔ login, profile editing, and logout maintain a server-side session
✔ password change verifies the current password, rotates the session, and invalidates the prior session
✔ server role checks reject attendee escalation and scope Conference Admin to assigned conference
✔ Super Admin access is server-authorized and submission changes require ownership
✔ paper workflow validates PDFs, enforces deadlines and ownership, and retains private versions
✔ peer review scopes assignments, blocks conflicts, validates reviews, protects editor comments, and records decisions
✔ password reset tokens expire and can be used only once; SMTP absence is reported honestly
✔ required email verification blocks registration until an email provider is configured
✔ certificate eligibility evaluation reflects real participant activity and rejects ineligible users
✔ eligible user claims certificate, prevents duplicate issuance, and notification is generated
✔ download certificate generates valid downloadable PDF binary with correct headers
✔ public certificate verification, authorized revocation with reason, and verification reflection
✔ notification preferences, read/unread states, and mark-all-read operations
✔ conference analytics, exports (CSV and PDF summary), and scope protection
✔ public can query conference registration tiers and availability
✔ attendee registers, receives unique reference, and payment row is initialized with server validated fee
✔ duplicate registration for same conference is strictly rejected
✔ capacity limit prevents excess registrations
✔ receipt upload to private storage updates payment status and enforces role-based access
✔ admin verification queue, receipt approval, financial report and reconciliation
✔ rejection flow records reason and allows attendee re-upload
✔ refund workflow: attendee requests refund, admin processes with bank reference
✔ organizer creates session with validation, while overlapping room/chair conflicts are rejected
✔ assign accepted paper to presentation slot, non-accepted paper is rejected, and duplicate assignment blocked
✔ schedule publication visibility and authorized editing notifications
✔ personalized schedule, attendance check-in, and rotating QR token validation
✔ session chair dashboard, presentation status updates, and attendance certificate report
✔ unauthenticated request to protected endpoints is rejected with 401
✔ mutation without CSRF token is rejected with 403
✔ attendee attempting organizer administrative action is rejected with 403
✔ invalid lifecycle transition jumps are strictly rejected by the server
✔ public certificate verification with unknown number returns valid: false
✔ malformed inputs are rejected with 400 validation error
ℹ pass 39
ℹ fail 0
```

### Frontend Build Verification
```powershell
npm.cmd --prefix client run build
```
Builds production-ready bundles in `client/dist/` with 0 warnings or errors.

---

## 4. Requirements & Architecture Checklist

For the complete 110-point breakdown mapping every requirement to pages, API endpoints, PostgreSQL tables, and automated test cases, see:
👉 [docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md)

---

## 5. Production Deployment & Security Architecture

### Hosting Recommendations
1. **Frontend (Vite / React SPA):**
   - **Recommended:** [Vercel](https://vercel.com/), [Cloudflare Pages](https://pages.cloudflare.com/), or [Netlify](https://www.netlify.com/).
   - Set Build Command: `npm run build`
   - Set Output Directory: `dist`
   - Set Environment Variable: `VITE_API_BASE_URL=https://api.yourconference.bup.edu.bd`
2. **Backend (Node.js Express API):**
   - **Recommended:** [Render](https://render.com/), [Railway](https://railway.app/), or [AWS App Runner](https://aws.amazon.com/apprunner/).
   - Start Command: `npm start`
   - Enable HTTPS / SSL termination.
   - Configure environment variables from `server/.env.example`.

### Production CORS & Cookie Configuration
- In `server/.env`, set `CLIENT_ORIGIN` to the exact frontend origin:
  ```env
  CLIENT_ORIGIN=https://conference.bup.edu.bd
  NODE_ENV=production
  ```
- When `NODE_ENV=production`, session cookies are automatically set with `Secure: true`, `HttpOnly: true`, and `SameSite: Lax` to prevent cross-site leakage.

### Database Connection & Connection Pooler
- When deploying to serverless platforms, use Supabase's **Session or Transaction Pooler** URI (port `6543`) instead of direct connection (port `5432`) to manage connections efficiently.
- Supabase automatically performs automated daily backups. Point-in-time recovery (PITR) is available on Supabase Pro.

### Secrets Management
- **Never commit `.env` files.** The repository `.gitignore` strictly ignores `.env` and `.env.*`.
- **Privileged Credentials:** The `SUPABASE_SERVICE_ROLE_KEY`, `CSRF_SECRET`, and `DATABASE_URL` must remain on the backend server only. They are never prefixed with `VITE_` and never included in frontend builds.

---

## 6. Real-World External Integration Checklist

Before going live in production, configure the following external credentials:
1. **Live Supabase Credentials:** Set `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` to your live Supabase project.
2. **SMTP Email Service (Optional):**
   - To send actual password reset, email verification, and conference notifications to users' inboxes, configure SMTP credentials in `server/.env`:
     ```env
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=587
     SMTP_SECURE=false
     SMTP_USER=conference@bup.edu.bd
     SMTP_PASSWORD=your-app-password
     MAIL_FROM="BUP Conference Management <conference@bup.edu.bd>"
     ```
   - If SMTP is not provided, the platform functions fully with in-app notifications and records delivery outcome as `'not_configured'`.
3. **Institutional Custom Domain & SSL:** Map DNS records for `conference.bup.edu.bd` with automatic Let's Encrypt TLS certificates.
