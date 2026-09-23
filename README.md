# RefundWaapsi

RefundWaapsi is an Express-based customer-resolution application with accounts, paid case filing, private evidence uploads, lead intake, admin case management, and customer/agent chat.

## Production architecture

- Node.js + Express on Render
- Supabase PostgreSQL for durable application data
- Supabase private Storage for customer evidence
- Razorpay for payments
- Anthropic for optional AI lead intake
- Cloudflare for custom-domain DNS/security (recommended)

The app can still run locally with the original JSON store when Supabase variables are absent. In production, Supabase is mandatory.

## First setup

```bash
npm ci
cp .env.example .env
npm start
```

For a production database, run `supabase/schema.sql` first and configure the Supabase variables in the environment.

## Migrating an old JSON deployment

If an older RefundWaapsi instance has real JSON data and local evidence, use `scripts_migrate-json-to-supabase.js` after applying the schema:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET \
node scripts_migrate-json-to-supabase.js
```

## Production safety

Never commit `.env`, payment secrets, JWT secrets, AI keys, or Supabase server secrets. Customer evidence is stored in a private bucket and exposed only through short-lived signed URLs after server-side authorization.

See `DEPLOYMENT.md` for the deployment checklist.


## Current customer flow

The public homepage does not contain the old AI intake chat. Customers create an account or log in, open a case for ₹59, complete payment, and immediately enter a persistent case conversation with the RefundWaapsi support team.

## Staff flow

Open `/admin-login` for the staff workspace. The master administrator uses `ADMIN_USER` / `ADMIN_PASS`. From the Team panel, the administrator can add or disable support agents. Agents have separate credentials, can work unassigned or assigned cases, reply to customers, and automatically claim an unassigned case when they send the first reply. Administrators can assign or unassign cases manually.
