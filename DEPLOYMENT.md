# RefundWaapsi production deployment

## Architecture

- GitHub: source control
- Render Web Service: Node/Express app
- Supabase: PostgreSQL + private `case-proofs` Storage bucket
- Cloudflare: DNS/CDN/security (optional initially, recommended for the custom domain)
- Razorpay: payments
- RefundWaapsi staff workspace: administrator + multi-agent support

## 1. Supabase

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase/schema.sql`.
4. Create/copy a server-only Supabase secret key. Current Supabase docs recommend secret keys for backend services; keep them out of browser code and source control.
5. The bucket `case-proofs` must remain private.

## 2. GitHub

Push the project to a private repository. Do not commit `.env`, customer data, payment keys, AI keys, or Supabase secret keys.

## 3. Render

Create **New -> Web Service**, connect the repository, then use:

```text
Build Command: npm ci
Start Command: npm start
Health Check: /api/health
```

Render can automatically redeploy after pushes to the connected branch.

### Required production environment variables

```text
NODE_ENV=production
PORT=10000
ADMIN_USER=<unique-admin-user>
ADMIN_PASS=<long-random-password>
JWT_SECRET=<64+ random characters>
CASE_FEE_PAISE=5900
ALLOWED_ORIGINS=https://your-domain.com
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<server-only Supabase secret key>
SUPABASE_STORAGE_BUCKET=case-proofs
```

Optional:

```text
RAZORPAY_KEY_ID=<test or live key id>
RAZORPAY_KEY_SECRET=<test or live secret>
ANTHROPIC_API_KEY=<optional>
ANTHROPIC_MODEL=<model supported by your Anthropic account>
```

Do not set `RAZORPAY_*` until the application has passed non-payment tests. The app remains in mock-payment mode when these are absent.

## 4. Existing JSON data migration

If you already have real data in `data/*.json` and local evidence in `uploads/`, first apply the Supabase schema and then run:

```bash
NODE_ENV=development SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<server-secret> node scripts_migrate-json-to-supabase.js
```

The script is designed to be repeatable for existing row IDs and uploads.

## 5. Staff workspace

The customer homepage no longer starts a chat. Customers sign up/log in, open a case for ₹59, complete payment, and then chat inside their case.

The master staff account is controlled by `ADMIN_USER` + `ADMIN_PASS`. Sign in at `/admin-login`. A master administrator can add or disable support agents from the Team panel. Agents get their own credentials, see unassigned and assigned-to-me paid cases, can reply to customers, and replying to an unassigned case automatically claims it. Administrators can assign any paid case to any active agent or leave it unassigned.

Run `supabase/upgrade-v2.2.sql` before using the multi-agent workspace if the database was created from an older schema. This migration adds `users.role`, `cases.assigned_to`, and `cases.assigned_at`.

## 6. Production tests before payments

Test:

1. `/api/health` returns 200 and reports `database: supabase`.
2. Signup/login works.
3. Session cookie has `HttpOnly`, `Secure`, `SameSite=Lax` in production.
4. Lead chat works and a lead can be claimed.
5. Case creation works.
6. Mock payment works while Razorpay keys are absent.
7. Proof uploads land in the private `case-proofs` bucket.
8. Customer A cannot read Customer B's case or evidence.
9. Admin can view cases, files and messages.
10. Restart/redeploy and verify database/file data remains.

## 7. Razorpay

Use Razorpay test credentials first. Verify signatures server-side. Only after end-to-end testing should you switch to live keys.

## 8. Domain

Attach the custom domain to Render, then manage DNS through Cloudflare if desired. Keep `ALLOWED_ORIGINS` equal to the actual browser origin(s).

## 9. Scaling path

Start with Render + Supabase. When traffic grows, scale the Render service and database independently. The app no longer depends on local JSON files or local evidence storage, so redeploys/restarts do not erase business data.

# Google Sign-In (public OAuth client ID)
GOOGLE_CLIENT_ID=

## v2.2 upgrade

Run `supabase/upgrade-v2.2.sql` once in the Supabase SQL Editor. It adds the `lead_id` link used for paid human-support conversations. No existing cases are deleted.

New Render environment variable:
- `GOOGLE_CLIENT_ID` — your Google OAuth Web client ID. This is a public client identifier, not a secret.

The AI chat still uses `ANTHROPIC_API_KEY`. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5`.
