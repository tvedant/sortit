/*
 * One-time migration from the old JSON/local-upload store to Supabase.
 * Run from the project root after applying supabase/schema.sql:
 *
 *   NODE_ENV=development SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts_migrate-json-to-supabase.js
 *
 * The script is intentionally idempotent for rows with the same primary/unique
 * IDs. It uploads local evidence into the private case-proofs bucket.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'case-proofs';
if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');

async function api(pathname, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function read(name) {
  const p = path.join(ROOT, 'data', `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function upsert(table, rows) {
  if (!rows.length) return;
  await api(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  console.log(`Migrated ${rows.length} ${table} row(s)`);
}

async function uploadFile(storagePath, filePath, mime) {
  const body = fs.readFileSync(filePath);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body,
  });
  if (!res.ok) throw new Error(`Storage ${res.status}: ${await res.text()}`);
}

(async () => {
  const users = read('users');
  const leads = read('leads');
  const cases = read('cases');
  const messages = read('messages');

  await upsert('users', users.map(u => ({
    id: u.id, name: u.name, email: u.email, password_hash: u.passwordHash,
    created_at: u.createdAt,
  })));

  await upsert('leads', leads.map(l => ({
    id: l.id, name: l.name, contact: l.contact, story: l.story, category: l.category,
    summary: l.summary, stage: l.stage || 0, user_id: l.userId, status: l.status,
    source: l.source, transcript: l.transcript || [], created_at: l.createdAt,
  })));

  await upsert('cases', cases.map(c => ({
    id: c.id, case_id: c.caseId, user_id: c.userId, user_email: c.userEmail,
    user_name: c.userName, category: c.category, description: c.description,
    summary: c.summary, amount_paise: c.amountPaise, payment_status: c.paymentStatus,
    razorpay_order_id: c.razorpayOrderId, razorpay_payment_id: c.razorpayPaymentId,
    status: c.status, created_at: c.createdAt, updated_at: c.updatedAt,
  })));

  await upsert('messages', messages.map(m => ({
    id: m.id, case_id: m.caseId, sender: m.sender, sender_name: m.senderName,
    text: m.text, created_at: m.createdAt,
  })));

  const caseFiles = [];
  for (const c of cases) {
    for (const f of (c.proofFiles || [])) {
      const localPath = path.join(ROOT, 'uploads', c.caseId, f.filename);
      if (!fs.existsSync(localPath)) {
        console.warn(`Skipping missing local proof: ${localPath}`);
        continue;
      }
      const storagePath = `${c.caseId}/${f.filename}`;
      const ext = path.extname(f.filename).toLowerCase();
      const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      await uploadFile(storagePath, localPath, mime);
      caseFiles.push({
        id: require('crypto').randomUUID(), case_id: c.caseId, filename: f.filename,
        original_name: f.originalName || f.filename, storage_path: storagePath,
        mime_type: mime, size: f.size || fs.statSync(localPath).size,
        created_at: new Date().toISOString(),
      });
      console.log(`Uploaded ${storagePath}`);
    }
  }
  await upsert('case_files', caseFiles);
  console.log('Migration complete.');
})().catch(err => { console.error(err); process.exit(1); });
