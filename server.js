require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let Razorpay = null;
try { Razorpay = require('razorpay'); } catch (_) {}

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? '' : 'refundwaapsi-local-development-secret-change-me');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
if (IS_PROD && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production.');
}

const CASE_FEE_PAISE = parseInt(process.env.CASE_FEE_PAISE || '5900', 10);
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const PAYMENTS_LIVE = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
const razorpay = PAYMENTS_LIVE && Razorpay ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET }) : null;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const AI_CHAT_LIVE = Boolean(ANTHROPIC_API_KEY);

// Production storage/database. The application uses Supabase's REST APIs so
// there is no extra DB driver dependency and the same app can run on Render.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'case-proofs';
const DB_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
if (IS_PROD && !DB_ENABLED) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required in production.');
if (IS_PROD && !process.env.ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS is required in production.');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  cases: path.join(DATA_DIR, 'cases.json'),
  messages: path.join(DATA_DIR, 'messages.json'),
  leads: path.join(DATA_DIR, 'leads.json'),
};
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  Object.values(FILES).forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, '[]'); });
}
ensureStore();
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (_) { return []; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

async function supa(pathname, options = {}) {
  if (!DB_ENABLED) throw new Error('Supabase is not configured');
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
async function dbSelect(table, query = '') { return supa(`/rest/v1/${table}?select=*${query ? `&${query}` : ''}`); }
async function dbSelectColumns(table, columns, query = '') { return supa(`/rest/v1/${table}?select=${encodeURIComponent(columns)}${query ? `&${query}` : ''}`); }
async function dbInsert(table, rows) {
  return supa(`/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) });
}
async function dbUpsert(table, rows, onConflict) {
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return supa(`/rest/v1/${table}${query}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
}
async function dbUpdate(table, query, patch) {
  return supa(`/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
}
async function dbDelete(table, query) { return supa(`/rest/v1/${table}?${query}`, { method: 'DELETE' }); }

async function listUsers() { return DB_ENABLED ? dbSelect('users') : readJson(FILES.users); }
async function findUserByEmail(email) { const e = email.toLowerCase(); if (!DB_ENABLED) return readJson(FILES.users).find(u => u.email.toLowerCase() === e); const rows = await dbSelect('users', `email=eq.${encodeURIComponent(e)}`); return rows[0] || null; }
async function findUserById(id) { if (!DB_ENABLED) return readJson(FILES.users).find(u => u.id === id); const rows = await dbSelect('users', `id=eq.${encodeURIComponent(id)}`); return rows[0] || null; }
async function createUser(user) { if (!DB_ENABLED) { const a = readJson(FILES.users); a.push(user); writeJson(FILES.users, a); return user; } return (await dbInsert('users', [ { id: user.id, name: user.name, email: user.email, password_hash: user.passwordHash, role: user.role || 'customer', created_at: user.createdAt } ]))[0]; }

async function listLeads() { if (!DB_ENABLED) return readJson(FILES.leads); return dbSelect('leads', 'order=created_at.desc'); }
async function findLead(id) { if (!DB_ENABLED) return readJson(FILES.leads).find(l => l.id === id); return (await dbSelect('leads', `id=eq.${encodeURIComponent(id)}`))[0] || null; }
function leadFromDb(r) { return r ? { ...r, userId: r.user_id, createdAt: r.created_at } : r; }
async function createLead(l) { if (!DB_ENABLED) { const a = readJson(FILES.leads); a.unshift(l); writeJson(FILES.leads, a); return l; } const r = (await dbInsert('leads', [{ id:l.id,name:l.name,contact:l.contact,story:l.story,category:l.category,summary:l.summary,stage:l.stage,user_id:l.userId,status:l.status,source:l.source,transcript:l.transcript,created_at:l.createdAt }]))[0]; return leadFromDb(r); }
async function updateLead(id, patch) { if (!DB_ENABLED) { const a=readJson(FILES.leads); const i=a.findIndex(x=>x.id===id); if(i<0) return null; Object.assign(a[i],patch); writeJson(FILES.leads,a); return a[i]; } const dbPatch={}; for(const [k,v] of Object.entries(patch)){ dbPatch[{userId:'user_id',createdAt:'created_at'}[k]||k]=v; } const r=(await dbUpdate('leads',`id=eq.${encodeURIComponent(id)}`,dbPatch))[0]; return leadFromDb(r); }

async function listCasesForUser(userId) { if (!DB_ENABLED) return readJson(FILES.cases).filter(c=>c.userId===userId); return dbSelect('cases', `user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`); }
async function findCase(caseId, userId) { if (!DB_ENABLED) return readJson(FILES.cases).find(c=>c.caseId===caseId && (!userId || c.userId===userId)); const q=`case_id=eq.${encodeURIComponent(caseId)}${userId?`&user_id=eq.${encodeURIComponent(userId)}`:''}`; return (await dbSelect('cases',q))[0]||null; }
async function listPaidCases() { if (!DB_ENABLED) return readJson(FILES.cases).filter(c=>c.paymentStatus==='paid'); return dbSelect('cases','payment_status=eq.paid&order=created_at.desc'); }
function caseFromDb(r) { return r ? { ...r, caseId:r.case_id, userId:r.user_id, userEmail:r.user_email, userName:r.user_name, amountPaise:r.amount_paise, paymentStatus:r.payment_status, razorpayOrderId:r.razorpay_order_id, razorpayPaymentId:r.razorpay_payment_id, leadId:r.lead_id, assignedTo:r.assigned_to, assignedAt:r.assigned_at, proofFiles:[] , createdAt:r.created_at, updatedAt:r.updated_at } : r; }
function casePatchToDb(p) {
  const out = {};
  const map = {
    caseId: 'case_id',
    userId: 'user_id',
    userEmail: 'user_email',
    userName: 'user_name',
    amountPaise: 'amount_paise',
    paymentStatus: 'payment_status',
    razorpayOrderId: 'razorpay_order_id',
    razorpayPaymentId: 'razorpay_payment_id',
    leadId: 'lead_id',
    assignedTo: 'assigned_to',
    assignedAt: 'assigned_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  };

  for (const [key, value] of Object.entries(p || {})) {
    if (key === 'caseId') {
      // The existing production schema requires both identifiers.
      out.case_id = value;
      out.case_number = value;
      continue;
    }

    if (value !== undefined) {
      out[map[key] || key] = value;
    }
  }

  return out;
}
async function createCase(c){ if(!DB_ENABLED){const a=readJson(FILES.cases);a.push(c);writeJson(FILES.cases,a);return c;} return caseFromDb((await dbInsert('cases',[casePatchToDb(c)]))[0]); }
async function updateCase(caseId, patch){ if(!DB_ENABLED){const a=readJson(FILES.cases);const i=a.findIndex(x=>x.caseId===caseId);if(i<0)return null;Object.assign(a[i],patch);writeJson(FILES.cases,a);return a[i];} return caseFromDb((await dbUpdate('cases',`case_id=eq.${encodeURIComponent(caseId)}`,casePatchToDb(patch)))[0]); }

let MESSAGE_SCHEMA_CACHE = null;
let MESSAGE_SCHEMA_CACHE_AT = 0;
const MESSAGE_SCHEMA_TTL_MS = 5 * 60 * 1000;
let MESSAGE_META_CACHE = null;
let MESSAGE_META_CACHE_AT = 0;
const MESSAGE_META_TTL_MS = 2500;
function invalidateMessageMetaCache(){ MESSAGE_META_CACHE = null; MESSAGE_META_CACHE_AT = 0; }

async function getMessageSchema() {
  if (!DB_ENABLED) return null;
  const now = Date.now();
  if (MESSAGE_SCHEMA_CACHE && now - MESSAGE_SCHEMA_CACHE_AT < MESSAGE_SCHEMA_TTL_MS) {
    return MESSAGE_SCHEMA_CACHE;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        Accept: 'application/openapi+json, application/json'
      }
    });
    if (!res.ok) throw new Error(`Supabase schema discovery failed: ${res.status}`);
    const spec = await res.json();
    const definition = spec?.definitions?.messages || spec?.components?.schemas?.messages;
    const properties = definition?.properties || {};
    const columns = new Set(Object.keys(properties));
    if (!columns.size) throw new Error('messages table columns were not exposed by PostgREST');
    MESSAGE_SCHEMA_CACHE = columns;
    MESSAGE_SCHEMA_CACHE_AT = now;
    return columns;
  } catch (err) {
    console.warn('Message schema discovery unavailable:', err.message);
    return MESSAGE_SCHEMA_CACHE || null;
  }
}

function firstExistingColumn(columns, candidates) {
  if (!columns) return null;
  return candidates.find(name => columns.has(name)) || null;
}

function canonicalSender(value, senderName='') {
  const v = String(value || '').trim().toLowerCase();
  if (['customer','user','client','consumer'].includes(v)) return 'customer';
  if (['admin','superadmin','super_admin','master_admin','administrator'].includes(v)) return 'admin';
  if (['agent','support','staff','human','representative'].includes(v)) return 'agent';
  const n = String(senderName || '').toLowerCase();
  if (/(super\s*admin|administrator|master\s*admin)/i.test(n)) return 'admin';
  return v || 'agent';
}

function normalizeMessageRow(row, columns = null) {
  if (!row) return row;
  const senderKey = firstExistingColumn(columns, ['sender', 'role', 'sender_type', 'author_type']);
  const senderNameKey = firstExistingColumn(columns, ['sender_name', 'author_name', 'senderName', 'name']);
  const textKey = firstExistingColumn(columns, ['text', 'message', 'content', 'body']);
  const createdKey = firstExistingColumn(columns, ['created_at', 'sent_at', 'timestamp', 'createdAt']);
  const senderName = senderNameKey ? (row[senderNameKey] || '') : '';
  return {
    ...row,
    caseId: row.case_id ?? row.caseId ?? row.case_uuid,
    sender: canonicalSender(senderKey ? row[senderKey] : '', senderName),
    senderRole: canonicalSender(senderKey ? row[senderKey] : '', senderName),
    senderName,
    text: textKey ? (row[textKey] || '') : '',
    createdAt: createdKey ? (row[createdKey] || new Date().toISOString()) : new Date().toISOString()
  };
}

function messagePatchForSchema(m, columns, caseDbId) {
  const out = {};
  const setIf = (candidates, value) => {
    const key = firstExistingColumn(columns, candidates);
    if (key && value !== undefined) out[key] = value;
    return key;
  };

  const caseKey = setIf(['case_id', 'caseId'], m.caseId);
  if (!caseKey && columns?.has('case_uuid')) out.case_uuid = caseDbId;

  setIf(['id', 'message_id'], m.id);
  setIf(['sender', 'role', 'sender_type', 'author_type'], m.sender);
  setIf(['sender_name', 'author_name', 'senderName', 'name'], m.senderName);
  setIf(['text', 'message', 'content', 'body'], m.text);
  setIf(['created_at', 'sent_at', 'timestamp', 'createdAt'], m.createdAt);

  return out;
}

async function listMessages(caseId) {
  if (!DB_ENABLED) {
    return readJson(FILES.messages)
      .filter(m => m.caseId === caseId)
      .map(m => normalizeMessageRow(m));
  }

  const record = await findCase(caseId);
  if (!record) return [];

  const columns = await getMessageSchema();
  const caseCandidates = columns
    ? [firstExistingColumn(columns, ['case_id', 'caseId']), firstExistingColumn(columns, ['case_uuid'])].filter(Boolean)
    : ['case_id'];

  let lastError = null;
  for (const caseColumn of caseCandidates) {
    for (const value of caseColumn === 'case_uuid' ? [record.id] : [caseId, record.id]) {
      try {
        const createdColumn = firstExistingColumn(columns, ['created_at','sent_at','timestamp','createdAt']) || 'created_at';
        const rows = await dbSelect(
          'messages',
          `${caseColumn}=eq.${encodeURIComponent(value)}&order=${encodeURIComponent(createdColumn)}.asc`
        );
        return rows.map(row => normalizeMessageRow(row, columns));
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error('Could not read case messages.');
}


function parseReadState(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed).slice(0, 500)) {
      if (typeof key === 'string' && typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) out[key] = value;
    }
    return out;
  } catch (_) { return {}; }
}

let READ_STATE_WARNED = false;
async function getPersistedReadState(viewerId) {
  if (!DB_ENABLED || !viewerId) return null;
  try {
    const rows = await dbSelectColumns('case_reads','case_id,last_read_at',`viewer_id=eq.${encodeURIComponent(viewerId)}`);
    const out = {};
    for (const row of rows || []) {
      if (row.case_id && row.last_read_at) out[String(row.case_id)] = row.last_read_at;
    }
    return out;
  } catch (err) {
    if (!READ_STATE_WARNED) {
      READ_STATE_WARNED = true;
      console.warn('Persistent read-state table unavailable; using browser fallback until migration is applied:', err.message);
    }
    return null;
  }
}

async function markCaseRead(viewerId, caseId) {
  const messages = await listMessages(caseId);
  const latest = messages[messages.length - 1];
  if (!latest?.createdAt) return { ok:true, lastReadAt:null };
  if (DB_ENABLED) {
    try {
      await dbUpsert('case_reads',[{viewer_id:viewerId,case_id:caseId,last_read_at:latest.createdAt}], 'viewer_id,case_id');
      return { ok:true, lastReadAt:latest.createdAt, persisted:true };
    } catch (err) {
      if (!READ_STATE_WARNED) { READ_STATE_WARNED = true; console.warn('Could not persist chat read state; browser fallback will be used:', err.message); }
    }
  }
  return { ok:true, lastReadAt:latest.createdAt, persisted:false };
}

async function resolveSeenMap(viewerId, fallbackMap) {
  const persisted = await getPersistedReadState(viewerId);
  return persisted || fallbackMap || {};
}

async function getLatestMessageMeta(records, viewerRole, seenMap = {}) {
  const rows = Array.isArray(records) ? records : [];
  const meta = new Map();
  if (!rows.length) return meta;

  const byPublic = new Map(rows.map(r => { const c=caseFromDb(r); return [String(c.caseId),c]; }));
  const byDb = new Map(rows.map(r => { const c=caseFromDb(r); return [String(c.id),c]; }));
  const grouped = new Map();

  const consume = (raw) => {
    const m = normalizeMessageRow(raw);
    const c = byPublic.get(String(m.caseId)) || byDb.get(String(m.caseId));
    if (!c) return;
    const key = String(c.caseId);
    const list = grouped.get(key) || [];
    list.push(m);
    grouped.set(key, list);
  };

  if (!DB_ENABLED) {
    for (const m of readJson(FILES.messages)) consume(m);
  } else {
    const now = Date.now();
    let messages = MESSAGE_META_CACHE;
    if (!messages || now - MESSAGE_META_CACHE_AT > MESSAGE_META_TTL_MS) {
      const columns = await getMessageSchema();
      if (!columns) return meta;
      const caseColumn = firstExistingColumn(columns,['case_id','caseId','case_uuid']);
      const senderColumn = firstExistingColumn(columns,['sender','role','sender_type','author_type']);
      const senderNameColumn = firstExistingColumn(columns,['sender_name','author_name','senderName','name']);
      const textColumn = firstExistingColumn(columns,['text','message','content','body']);
      const createdColumn = firstExistingColumn(columns,['created_at','sent_at','timestamp','createdAt']);
      if (!caseColumn || !createdColumn) return meta;
      const selected = [caseColumn,senderColumn,senderNameColumn,textColumn,createdColumn].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(',');
      try {
        messages = await dbSelectColumns('messages', selected, `order=${encodeURIComponent(createdColumn)}.desc&limit=10000`);
        MESSAGE_META_CACHE = messages;
        MESSAGE_META_CACHE_AT = now;
      } catch (err) {
        console.warn('Message metadata query failed:', err.message);
        return meta;
      }
    }
    for (const raw of messages || []) consume(raw);
  }

  for (const [caseId, list] of grouped) {
    list.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
    const latest = list[0];
    const seenAt = seenMap && seenMap[caseId] ? new Date(seenMap[caseId]).getTime() : null;
    const unreadCount = seenAt === null || Number.isNaN(seenAt)
      ? 0
      : list.filter(m => canonicalSender(m.sender,m.senderName) !== viewerRole && new Date(m.createdAt||0).getTime() > seenAt).length;
    meta.set(caseId, {
      lastMessageText: latest?.text || '',
      lastMessageAt: latest?.createdAt || null,
      lastMessageSender: latest ? canonicalSender(latest.sender,latest.senderName) : '',
      lastMessageSenderName: latest?.senderName || '',
      unreadCount,
      unread: unreadCount > 0,
      messageCount: list.length
    });
  }
  return meta;
}

function attachMessageMeta(records,meta){return records.map(r=>{const c=caseFromDb(r);return {...c,...(meta.get(c.caseId)||{lastMessageText:'',lastMessageAt:null,lastMessageSender:'',lastMessageSenderName:'',unread:false,unreadCount:0,messageCount:0})};});}

async function createMessage(m) {
  if (!DB_ENABLED) {
    const a = readJson(FILES.messages);
    a.push(m);
    writeJson(FILES.messages, a);
    invalidateMessageMetaCache();
    const cases=readJson(FILES.cases);const idx=cases.findIndex(c=>c.caseId===m.caseId);
    if(idx>=0){cases[idx].updatedAt=m.createdAt||new Date().toISOString();writeJson(FILES.cases,cases);}
    return m;
  }

  const record = await findCase(m.caseId);
  if (!record) {
    throw new Error(`Cannot create message: case ${m.caseId} was not found.`);
  }

  let columns = await getMessageSchema();
  if (!columns) {
    throw new Error('Could not determine the production messages table schema.');
  }

  // The production database has evolved independently of the bundled schema.
  // Build the insert using only columns that actually exist in the live table.
  // Prefer the public RW-... case ID; retry with cases.id if the FK is UUID.
  const attempts = [];
  const primary = messagePatchForSchema(m, columns, record.id);
  attempts.push(primary);

  const caseColumn = firstExistingColumn(columns, ['case_id', 'caseId']);
  if (caseColumn && primary[caseColumn] === m.caseId && record.id !== m.caseId) {
    attempts.push({ ...primary, [caseColumn]: record.id });
  }

  let lastError = null;
  for (const payload of attempts) {
    try {
      const r = (await dbInsert('messages', [payload]))[0];
      await updateCase(m.caseId,{updatedAt:m.createdAt||new Date().toISOString()});
      invalidateMessageMetaCache();
      return normalizeMessageRow(r, columns);
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);

      // A cached PostgREST schema can be stale after a Supabase migration.
      // Refresh once and retry with the current live columns.
      if (/schema cache|column .* does not exist/i.test(message)) {
        MESSAGE_SCHEMA_CACHE = null;
        MESSAGE_SCHEMA_CACHE_AT = 0;
        columns = await getMessageSchema();
        if (columns) {
          const refreshed = messagePatchForSchema(m, columns, record.id);
          try {
            const r = (await dbInsert('messages', [refreshed]))[0];
            await updateCase(m.caseId,{updatedAt:m.createdAt||new Date().toISOString()});
            invalidateMessageMetaCache();
            return normalizeMessageRow(r, columns);
          } catch (refreshErr) {
            lastError = refreshErr;
          }
        }
      }
    }
  }

  throw lastError || new Error('Could not create message.');
}

async function listCaseFiles(caseId) {
  if (!DB_ENABLED) {
    return (readJson(FILES.cases).find(c => c.caseId === caseId) || {}).proofFiles || [];
  }

  // caseId is the public RW-YYYY-XXXXXX identifier.
  // case_files.case_id stores the UUID from cases.id.
  const record = await findCase(caseId);
  if (!record) return [];

  const rows = await dbSelect(
    'case_files',
    `case_id=eq.${encodeURIComponent(record.id)}&order=created_at.asc`
  );

  return rows.map(f => ({
    id: f.id,
    filename: f.filename,
    originalName: f.original_name,
    size: f.size,
    mimeType: f.mime_type,
    storagePath: f.storage_path,
    createdAt: f.created_at
  }));
}

async function createCaseFile(f) {
  if (!DB_ENABLED) return f;

  // case_files.case_id is a UUID foreign key to cases.id.
  const record = await findCase(f.caseId);
  if (!record) {
    throw new Error(`Cannot create case file: case ${f.caseId} was not found.`);
  }

  return (await dbInsert('case_files', [{
    id: f.id,
    case_id: record.id,
    filename: f.filename,
    original_name: f.originalName,
    storage_path: f.storagePath,
    mime_type: f.mimeType,
    size: f.size,
    created_at: f.createdAt
  }]))[0];
}

async function uploadToStorage(file, storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method:'POST', headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':file.mimetype,'x-upsert':'false'}, body:file.buffer
  });
  if(!res.ok) throw new Error(`Storage upload failed ${res.status}: ${await res.text()}`);
}
async function signedStorageUrl(storagePath, expiresIn=900){
  const res=await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`Storage signing failed ${res.status}: ${JSON.stringify(data)}`);
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// Middleware
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  if (IS_PROD) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});
const ALLOWED_ORIGINS=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{if(!origin || ALLOWED_ORIGINS.length===0 || ALLOWED_ORIGINS.includes(origin))return cb(null,true);return cb(new Error('CORS origin not allowed'));},credentials:true}));
app.use(express.json({limit:'400kb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
const hitLog=new Map();
function rateLimit(bucket,max,windowMs){return(req,res,next)=>{const key=`${bucket}:${req.ip}`;const now=Date.now();const hits=(hitLog.get(key)||[]).filter(t=>now-t<windowMs);if(hits.length>=max)return res.status(429).json({error:'Too many requests. Please try again in a bit.'});hits.push(now);hitLog.set(key,hits);next();};}

// Express 4 does not automatically forward rejected async route promises to the error middleware.
// Keep every async API failure inside Express so one bad request can never take down the process.
function asyncHandler(fn){return function(req,res,next){Promise.resolve(fn(req,res,next)).catch(next);};}

function signToken(user){return jwt.sign({uid:user.id,email:user.email,name:user.name},JWT_SECRET,{expiresIn:'7d'});}
function requireAuth(req,res,next){const token=req.cookies.token;if(!token)return res.status(401).json({error:'Please log in first.'});try{req.user=jwt.verify(token,JWT_SECRET);next();}catch(_){return res.status(401).json({error:'Your session has expired. Please log in again.'});}}
function signStaffToken(staff){return jwt.sign({uid:staff.id||null,email:staff.email,name:staff.name,role:staff.role,staff:true},JWT_SECRET,{expiresIn:'12h'});}
function requireStaff(req,res,next){const token=req.cookies.staff_token;if(!token)return res.status(401).json({error:'Please sign in to the staff portal.'});try{const staff=jwt.verify(token,JWT_SECRET);if(!staff.staff || !['admin','agent'].includes(staff.role))throw new Error('invalid');req.staff=staff;next();}catch(_){return res.status(401).json({error:'Your staff session has expired. Please sign in again.'});}}
function requireAdmin(req,res,next){return requireStaff(req,res,()=>{if(req.staff.role!=='admin')return res.status(403).json({error:'Administrator access required.'});next();});}
if(IS_PROD && (!process.env.ADMIN_USER || !process.env.ADMIN_PASS || process.env.ADMIN_PASS.length<16)) throw new Error('ADMIN_USER and a strong ADMIN_PASS are required in production.');
const MASTER_ADMIN_EMAIL=String(process.env.ADMIN_USER||'admin').trim().toLowerCase();
const MASTER_ADMIN_NAME=process.env.ADMIN_NAME||'RefundWaapsi Admin';
function genCaseId(){const year=new Date().getFullYear();const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code='';for(let i=0;i<6;i++)code+=chars[crypto.randomInt(0,chars.length)];return `RW-${year}-${code}`;}
function buildSummary({category,description}){const words=description.trim().split(/\s+/).filter(Boolean);const preview=words.slice(0,28).join(' ')+(words.length>28?'…':'');const labels={ecommerce:'an e-commerce purchase or return',banking:'a bank or EMI/lending app charge',telecom:'a telecom billing issue',travel:'a travel or cab booking',food:'a food delivery order',insurance:'an insurance claim',other:'a consumer complaint'};return `This case concerns ${labels[category]||labels.other}. Customer's account: "${preview}" Word count: ${words.length}. Flagged for review and drafting of the appropriate notice (company grievance officer / RBI Ombudsman / TRAI / e-Daakhil, as applicable).`;}

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:5},fileFilter:(req,file,cb)=>cb(null,['image/png','image/jpeg','image/webp','application/pdf'].includes(file.mimetype))});

// AUTH
app.post('/api/auth/signup',rateLimit('signup',8,15*60*1000),async(req,res)=>{try{const{name,email,password}=req.body||{};if(!name||name.trim().length<2)return res.status(400).json({error:'Please enter your name.'});if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Please enter a valid email.'});if(!password||password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});if(await findUserByEmail(email))return res.status(409).json({error:'An account with this email already exists. Try logging in.'});const user={id:crypto.randomUUID(),name:name.trim().slice(0,120),email:email.trim().toLowerCase(),passwordHash:await bcrypt.hash(password,12),role:'customer',createdAt:new Date().toISOString()};await createUser(user);const token=signToken(user);res.cookie('token',token,{httpOnly:true,sameSite:'lax',secure:IS_PROD,maxAge:7*24*60*60*1000});res.status(201).json({ok:true,user:{name:user.name,email:user.email}});}catch(e){console.error(e);res.status(500).json({error:'Could not create account.'});}});
app.post('/api/auth/login',rateLimit('login',10,15*60*1000),async(req,res)=>{try{const{email,password}=req.body||{};if(!email||!password)return res.status(400).json({error:'Please enter your email and password.'});const user=await findUserByEmail(email);if(!user)return res.status(401).json({error:'Incorrect email or password.'});const match=await bcrypt.compare(password,user.passwordHash||user.password_hash);if(!match)return res.status(401).json({error:'Incorrect email or password.'});const token=signToken(user);res.cookie('token',token,{httpOnly:true,sameSite:'lax',secure:IS_PROD,maxAge:7*24*60*60*1000});res.json({ok:true,user:{name:user.name,email:user.email}});}catch(e){console.error(e);res.status(500).json({error:'Could not log in.'});}});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('token');res.json({ok:true});});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({name:req.user.name,email:req.user.email}));
app.post('/api/auth/google',rateLimit('google-login',12,15*60*1000),async(req,res)=>{try{
  if(!GOOGLE_CLIENT_ID)return res.status(503).json({error:'Google sign-in is not configured yet.'});
  const credential=String(req.body?.credential||'');
  if(!credential)return res.status(400).json({error:'Google sign-in token is missing.'});
  const verify=await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const info=await verify.json();
  if(!verify.ok || info.aud!==GOOGLE_CLIENT_ID || !['accounts.google.com','https://accounts.google.com'].includes(info.iss) || String(info.email_verified)!=='true')return res.status(401).json({error:'Google sign-in could not be verified.'});
  const email=String(info.email||'').trim().toLowerCase();
  const name=String(info.name||info.given_name||'Google User').trim().slice(0,120);
  if(!email)return res.status(400).json({error:'Google did not provide an email address.'});
  let user=await findUserByEmail(email);
  if(!user){
    user={id:crypto.randomUUID(),name,email,passwordHash:await bcrypt.hash(crypto.randomBytes(32).toString('hex'),12),role:'customer',createdAt:new Date().toISOString()};
    await createUser(user);
  } else if(!user.name && name){ user.name=name; }
  const token=signToken(user);
  res.cookie('token',token,{httpOnly:true,sameSite:'lax',secure:IS_PROD,maxAge:7*24*60*60*1000});
  res.json({ok:true,user:{name:user.name||name,email}});
}catch(e){console.error('Google auth error:',e);res.status(500).json({error:'Google sign-in failed. Please try again.'});}});

// STAFF PORTAL
app.post('/api/staff/login',rateLimit('staff-login',12,15*60*1000),async(req,res)=>{try{
  const email=String(req.body?.email||'').trim().toLowerCase();
  const password=String(req.body?.password||'');
  if(!email||!password)return res.status(400).json({error:'Email and password are required.'});
  let staff=null;
  if(email===MASTER_ADMIN_EMAIL && password===String(process.env.ADMIN_PASS||'')) staff={id:null,email,name:MASTER_ADMIN_NAME,role:'admin'};
  else {
    const user=await findUserByEmail(email);
    const role=user?.role||user?.user_role;
    if(!user || !['admin','agent'].includes(role))return res.status(401).json({error:'Invalid staff credentials.'});
    const ok=await bcrypt.compare(password,user.passwordHash||user.password_hash||'');
    if(!ok)return res.status(401).json({error:'Invalid staff credentials.'});
    staff={id:user.id,email:user.email,name:user.name,role};
  }
  res.cookie('staff_token',signStaffToken(staff),{httpOnly:true,sameSite:'lax',secure:IS_PROD,maxAge:12*60*60*1000});
  res.json({ok:true,staff});
}catch(e){console.error(e);res.status(500).json({error:'Could not sign in.'});}});
app.post('/api/staff/logout',(req,res)=>{res.clearCookie('staff_token');res.json({ok:true});});
app.get('/api/staff/me',requireStaff,(req,res)=>res.json({staff:req.staff}));

async function listAgents(){
  if(!DB_ENABLED)return readJson(FILES.users).filter(u=>['agent','admin'].includes(u.role));
  return dbSelect('users','role=eq.agent&order=created_at.desc');
}
app.get('/api/admin/agents',requireAdmin,async(req,res)=>res.json((await listAgents()).map(u=>({id:u.id,name:u.name,email:u.email,role:u.role||'agent',createdAt:u.created_at||u.createdAt}))));
app.post('/api/admin/agents',requireAdmin,async(req,res)=>{try{
  const name=String(req.body?.name||'').trim().slice(0,120),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
  if(name.length<2)return res.status(400).json({error:'Name is required.'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Enter a valid email.'});
  if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
  if(email===MASTER_ADMIN_EMAIL)return res.status(409).json({error:'That email is reserved for the master administrator.'});
  if(await findUserByEmail(email))return res.status(409).json({error:'An account with that email already exists.'});
  const user={id:crypto.randomUUID(),name,email,passwordHash:await bcrypt.hash(password,12),role:'agent',createdAt:new Date().toISOString()};
  await createUser(user);res.status(201).json({ok:true,agent:{id:user.id,name:user.name,email:user.email,role:'agent',createdAt:user.createdAt}});
}catch(e){console.error(e);res.status(500).json({error:'Could not create agent.'});}});
app.delete('/api/admin/agents/:id',requireAdmin,async(req,res)=>{try{
  const user=await findUserById(req.params.id);if(!user || (user.role||user.user_role)!=='agent')return res.status(404).json({error:'Agent not found.'});
  if(DB_ENABLED)await dbUpdate('users',`id=eq.${encodeURIComponent(req.params.id)}`,{role:'disabled'}); else {const a=readJson(FILES.users);const i=a.findIndex(u=>u.id===req.params.id);if(i>=0){a[i].role='disabled';writeJson(FILES.users,a);}}
  // Unassign their active cases so another staff member can pick them up.
  if(DB_ENABLED)await dbUpdate('cases',`assigned_to=eq.${encodeURIComponent(req.params.id)}`,{assigned_to:null,assigned_at:null,updated_at:new Date().toISOString()});
  else {const a=readJson(FILES.cases);a.forEach(c=>{if(c.assignedTo===req.params.id){c.assignedTo=null;c.assignedAt=null;}});writeJson(FILES.cases,a);}
  res.json({ok:true});
}catch(e){console.error(e);res.status(500).json({error:'Could not disable agent.'});}});

// LEAD CHAT
const LEAD_CATEGORY_LABELS={ecommerce:'an e-commerce purchase or return',banking:'a bank or EMI/lending app charge',telecom:'a telecom billing issue',travel:'a travel or cab booking',food:'a food delivery order',insurance:'an insurance claim',other:'a consumer complaint'};
function guessCategory(text){const t=(text||'').toLowerCase();if(/(amazon|flipkart|myntra|order|delivery|refund|return|product|parcel)/.test(t))return'ecommerce';if(/(bank|emi|loan|lending|credit|interest|processing fee)/.test(t))return'banking';if(/(airtel|jio|vi |vodafone|telecom|recharge|network|sim)/.test(t))return'telecom';if(/(flight|train|irctc|cab|ola|uber|hotel|booking|travel)/.test(t))return'travel';if(/(zomato|swiggy|food|restaurant|delivery boy)/.test(t))return'food';if(/(insurance|policy|claim|premium)/.test(t))return'insurance';return'other';}
function buildLeadSummary({name,contact,story,category}){const topic=LEAD_CATEGORY_LABELS[category]||LEAD_CATEGORY_LABELS.other;const words=(story||'').trim().split(/\s+/).filter(Boolean);const preview=words.slice(0,40).join(' ')+(words.length>40?'…':'');return `Thanks, ${name||'there'}! I've got the story. This looks like ${topic}. You can keep chatting here if you remember anything else; a RefundWaapsi human can take over from this conversation. We'll reach you at ${contact||'the contact you provide'}.`;}
const SCRIPTED_STAGES=['story','name','contact'];
function scriptedNextQuestion(stage){return({story:"Tell me what happened in your own words — which company, what went wrong, how much money is involved, and what you've already tried.",name:"Got it. What's your name?",contact:"Thanks. What's the best phone number or email to reach you on?"})[stage];}
function runScriptedTurn(lead,userText){const stage=SCRIPTED_STAGES[lead.stage];if(stage==='name')lead.name=userText.trim().slice(0,120);else if(stage==='contact')lead.contact=userText.trim().slice(0,160);else if(stage==='story'){lead.story=userText.trim().slice(0,3000);lead.category=guessCategory(lead.story);}lead.stage+=1;if(lead.stage>=SCRIPTED_STAGES.length){lead.summary=buildLeadSummary(lead);lead.status='captured';return{reply:lead.summary,done:true};}return{reply:scriptedNextQuestion(SCRIPTED_STAGES[lead.stage]),done:false};}
const LEAD_SYSTEM_PROMPT=`You are a warm, brief intake assistant for RefundWaapsi, a service that helps Indian customers get refunds and resolutions from companies that wronged them. Let the customer tell their story first, in their own words. Then naturally collect any missing details: their name and a phone number or email. Your job is intake only. Do not give legal advice, do not promise outcomes, and do not claim that a refund is guaranteed. Keep replies short (1-3 sentences), empathetic, plain conversational English. If the customer asks for a human, says they want an agent, or the situation needs human review, respond that a RefundWaapsi human can take over and keep the conversation open. You MUST respond with ONLY a raw JSON object, no markdown. While collecting information: {"done":false,"reply":"<next response>"}. Once you have enough information: {"done":true,"reply":"<brief handoff message>","name":"<name>","contact":"<phone or email>","story":"<concise customer story>","category":"<ecommerce|banking|telecom|travel|food|insurance|other>"}`;
async function callClaudeForLead(transcript){const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:ANTHROPIC_MODEL,max_tokens:400,system:LEAD_SYSTEM_PROMPT,messages:transcript.map(t=>({role:t.role,content:t.text}))})});if(!res.ok)throw new Error(`Claude API error ${res.status}`);const data=await res.json();const raw=(data.content||[]).map(b=>b.text||'').join('').trim();return JSON.parse(raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim());}

app.post('/api/lead-chat/start',rateLimit('lead-start',20,30*60*1000),async(req,res)=>{try{const id=crypto.randomUUID(),firstMessage=AI_CHAT_LIVE?"Hi! I'm here to help. Tell me what happened in your own words — no need to make it formal.":scriptedNextQuestion('story');const lead={id,name:null,contact:null,story:null,category:null,summary:null,stage:0,userId:null,status:'in-progress',source:AI_CHAT_LIVE?'ai':'scripted',transcript:[{role:'assistant',text:firstMessage,at:new Date().toISOString()}],createdAt:new Date().toISOString()};await createLead(lead);res.status(201).json({sessionId:id,message:firstMessage,status:lead.status,source:lead.source});}catch(e){console.error(e);res.status(500).json({error:'Could not start chat.'});}});
app.get('/api/lead-chat/:sessionId',rateLimit('lead-read',120,10*60*1000),async(req,res)=>{try{const raw=await findLead(req.params.sessionId);if(!raw)return res.status(404).json({error:'Chat session not found.'});const lead=leadFromDb(raw);res.json({leadId:lead.id,status:lead.status,source:lead.source,name:lead.name,contact:lead.contact,category:lead.category,done:['captured','human','converted','closed'].includes(lead.status),transcript:lead.transcript||[]});}catch(e){console.error(e);res.status(500).json({error:'Chat temporarily unavailable.'});}});
app.post('/api/lead-chat/:sessionId/message',rateLimit('lead-msg',60,10*60*1000),async(req,res)=>{try{const{text}=req.body||{};if(!text||!text.trim())return res.status(400).json({error:'Please type something first.'});const raw=await findLead(req.params.sessionId);if(!raw)return res.status(404).json({error:'Chat session not found. Please refresh and start again.'});const lead=leadFromDb(raw);if(lead.status==='closed')return res.status(400).json({error:'This conversation is closed.'});const cleanText=text.trim().slice(0,3000);lead.transcript=Array.isArray(lead.transcript)?lead.transcript:[];lead.transcript.push({role:'user',text:cleanText,at:new Date().toISOString()});
let result=null;
if(lead.status==='human'){result={reply:"Thanks — your message is in the queue for our human team. We'll reply here as soon as possible.",done:false};}
else if(['captured','converted'].includes(lead.status)){result={reply:"Thanks — I've added that to your story. A RefundWaapsi human can review and reply here.",done:false};}
else {try{result=lead.source==='ai'?await callClaudeForLead(lead.transcript):runScriptedTurn(lead,cleanText);}catch(err){console.error('Lead chat error:',err.message);lead.source='scripted';result=runScriptedTurn(lead,cleanText);}}
if(result.done&&lead.source==='ai'){lead.name=(result.name||lead.name||'').slice(0,120);lead.contact=(result.contact||lead.contact||'').slice(0,160);lead.story=(result.story||lead.story||'').slice(0,3000);lead.category=LEAD_CATEGORY_LABELS[result.category]?result.category:guessCategory(lead.story);lead.summary=result.reply;lead.status='captured';}
if(result.done&&lead.source==='scripted'){lead.summary=result.reply;lead.status='captured';}
lead.transcript.push({role:lead.status==='human'?'system':'assistant',text:result.reply,at:new Date().toISOString()});await updateLead(lead.id,{name:lead.name,contact:lead.contact,story:lead.story,category:lead.category,summary:lead.summary,stage:lead.stage,userId:lead.userId,status:lead.status,source:lead.source,transcript:lead.transcript});res.json({message:result.reply,done:!!result.done,leadId:lead.id,status:lead.status,summary:lead.summary||null});}catch(e){console.error(e);res.status(500).json({error:'Chat temporarily unavailable.'});}});
app.post('/api/lead-chat/:sessionId/claim',requireAuth,async(req,res)=>{const raw=await findLead(req.params.sessionId);if(!raw)return res.status(404).json({error:'Chat session not found.'});const lead=leadFromDb(raw);lead.userId=req.user.uid;await updateLead(lead.id,{userId:req.user.uid});res.json({ok:true,lead:{name:lead.name,contact:lead.contact,story:lead.story,category:lead.category,status:lead.status}});});
app.get('/api/admin/leads',requireAdmin,async(req,res)=>res.json((await listLeads()).map(leadFromDb)));
app.post('/api/admin/leads/:id/messages',requireAdmin,async(req,res)=>{try{const{text}=req.body||{};if(!text||!text.trim())return res.status(400).json({error:'Message cannot be empty.'});const raw=await findLead(req.params.id);if(!raw)return res.status(404).json({error:'Lead not found.'});const lead=leadFromDb(raw);lead.transcript=Array.isArray(lead.transcript)?lead.transcript:[];lead.transcript.push({role:'human',text:text.trim().slice(0,3000),at:new Date().toISOString()});lead.status='human';await updateLead(lead.id,{status:'human',transcript:lead.transcript});res.json({ok:true,status:'human'});}catch(e){console.error(e);res.status(500).json({error:'Could not send message.'});}});
app.patch('/api/admin/leads/:id',requireAdmin,async(req,res)=>{const allowed=['in-progress','captured','human','converted','closed'];if(!allowed.includes(req.body?.status))return res.status(400).json({error:`Status must be one of: ${allowed.join(', ')}`});const raw=await findLead(req.params.id);if(!raw)return res.status(404).json({error:'Lead not found.'});await updateLead(req.params.id,{status:req.body.status});res.json({ok:true});});

// CASES
async function importLeadTranscriptIntoCase(record, leadId, userName){
  if(!leadId)return;
  const raw=await findLead(leadId); if(!raw)return;
  const lead=leadFromDb(raw); if(!lead || lead.userId!==record.userId)return;
  const existing=await listMessages(record.caseId); if(existing.length>0)return;
  for(const t of (lead.transcript||[])){
    if(!t?.text)continue;
    const sender=t.role==='user'?'customer':'agent';
    const senderName=t.role==='user'?userName:(t.role==='human'?'RefundWaapsi Human':'RefundWaapsi AI');
    await createMessage({id:crypto.randomUUID(),caseId:record.caseId,sender,senderName,text:String(t.text).slice(0,2000),createdAt:t.at||new Date().toISOString()});
  }
}

async function createPaymentOrder(record){
  if(PAYMENTS_LIVE){
    const order=await razorpay.orders.create({amount:record.amountPaise,currency:'INR',receipt:record.caseId});
    await updateCase(record.caseId,{razorpayOrderId:order.id,updatedAt:new Date().toISOString()});
    return {orderId:order.id};
  }
  return {orderId:record.razorpayOrderId||`test_order_${record.id.slice(0,8)}`};
}

app.post('/api/my/cases',requireAuth,rateLimit('case-create',10,30*60*1000),async(req,res)=>{try{
  let caseId=genCaseId();
  while(await findCase(caseId)) caseId=genCaseId();

  const now=new Date().toISOString();
  const demoMode=!PAYMENTS_LIVE;
  const record={
    id:crypto.randomUUID(),
    caseId,
    userId:req.user.uid,
    userEmail:req.user.email,
    userName:req.user.name,
    category:null,
    description:null,
    summary:null,
    amountPaise:CASE_FEE_PAISE,
    paymentStatus:demoMode?'paid':'pending',
    razorpayOrderId:demoMode?`test_order_${crypto.randomUUID().slice(0,8)}`:null,
    razorpayPaymentId:demoMode?`test_pay_${crypto.randomUUID().slice(0,8)}`:null,
    leadId:null,
    status:demoMode?'in-progress':'awaiting_payment',
    createdAt:now,
    updatedAt:now
  };

  await createCase(record);

  if(demoMode){
    return res.status(201).json({
      ok:true,
      caseId:record.caseId,
      paymentStatus:'paid',
      status:record.status,
      amountPaise:record.amountPaise,
      testMode:true,
      demo:true
    });
  }

  const order=await createPaymentOrder(record);
  res.status(201).json({ok:true,caseId,orderId:order.orderId,amountPaise:record.amountPaise,keyId:RAZORPAY_KEY_ID,testMode:false,paymentStatus:'pending',status:record.status});
}catch(e){console.error('Create case error:',e);res.status(500).json({error:'Could not create case. Please try again.'});}});

app.post('/api/my/leads/:leadId/human-support',requireAuth,rateLimit('human-support',10,30*60*1000),async(req,res)=>{try{
  const raw=await findLead(req.params.leadId); if(!raw)return res.status(404).json({error:'Conversation not found.'});
  const lead=leadFromDb(raw); if(lead.userId!==req.user.uid)return res.status(403).json({error:'This conversation is not linked to your account.'});
  const all=await listCasesForUser(req.user.uid); let existing=all.map(caseFromDb).find(c=>c.leadId===lead.id);
  if(existing){
    if(existing.paymentStatus==='paid'){await importLeadTranscriptIntoCase(existing,lead.id,req.user.name);return res.json({ok:true,caseId:existing.caseId,paymentStatus:'paid',status:existing.status,amountPaise:existing.amountPaise});}
    const order=await createPaymentOrder(existing); return res.json({ok:true,caseId:existing.caseId,paymentStatus:existing.paymentStatus,status:existing.status,orderId:order.orderId,amountPaise:existing.amountPaise,keyId:PAYMENTS_LIVE?RAZORPAY_KEY_ID:null,testMode:!PAYMENTS_LIVE});
  }
  let caseId=genCaseId();while(await findCase(caseId))caseId=genCaseId();const now=new Date().toISOString();
  const record={id:crypto.randomUUID(),caseId,userId:req.user.uid,userEmail:req.user.email,userName:req.user.name,category:lead.category||'other',description:lead.story||'',summary:lead.summary||'Human support requested from the RefundWaapsi AI conversation.',amountPaise:CASE_FEE_PAISE,paymentStatus:'pending',razorpayOrderId:null,razorpayPaymentId:null,leadId:lead.id,status:'awaiting_payment',createdAt:now,updatedAt:now};
  if(!PAYMENTS_LIVE)record.razorpayOrderId=`test_order_${record.id.slice(0,8)}`; await createCase(record); const order=await createPaymentOrder(record);
  res.status(201).json({ok:true,caseId,orderId:order.orderId,paymentStatus:'pending',status:record.status,amountPaise:record.amountPaise,keyId:PAYMENTS_LIVE?RAZORPAY_KEY_ID:null,testMode:!PAYMENTS_LIVE});
}catch(e){console.error(e);res.status(500).json({error:'Could not start human support.'});}});

app.post('/api/my/cases/:caseId/payment-order',requireAuth,async(req,res)=>{try{const record=await findCase(req.params.caseId,req.user.uid);if(!record)return res.status(404).json({error:'Case not found.'});if(record.paymentStatus==='paid')return res.json({ok:true,alreadyPaid:true,caseId:record.caseId});const order=await createPaymentOrder(record);res.json({ok:true,caseId:record.caseId,orderId:order.orderId,amountPaise:record.amountPaise,keyId:PAYMENTS_LIVE?RAZORPAY_KEY_ID:null,testMode:!PAYMENTS_LIVE});}catch(e){console.error(e);res.status(502).json({error:'Could not start payment.'});}});
app.post('/api/my/cases/:caseId/verify-payment',requireAuth,async(req,res)=>{const{razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};const record=await findCase(req.params.caseId,req.user.uid);if(!record)return res.status(404).json({error:'Case not found.'});if(!PAYMENTS_LIVE)return res.status(400).json({error:'Live payments are not configured. Use the test-mode confirmation instead.'});const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');const providedSig=String(razorpay_signature||''); if(providedSig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(providedSig)))return res.status(400).json({error:'Payment verification failed. Please contact support.'});const nextStatus=record.leadId?'in-progress':'awaiting_details';await updateCase(record.caseId,{paymentStatus:'paid',razorpayPaymentId:razorpay_payment_id,status:nextStatus,updatedAt:new Date().toISOString()});if(record.leadId)await importLeadTranscriptIntoCase(record,record.leadId,req.user.name);res.json({ok:true,caseId:record.caseId,humanSupport:Boolean(record.leadId)});});
app.post('/api/my/cases/:caseId/mock-pay',requireAuth,asyncHandler(async(req,res)=>{
  if(PAYMENTS_LIVE)return res.status(400).json({error:'Live payments are configured — use real checkout instead.'});
  const record=await findCase(req.params.caseId,req.user.uid);
  if(!record)return res.status(404).json({error:'Case not found.'});
  if(record.paymentStatus==='paid')return res.json({ok:true,alreadyPaid:true,caseId:record.caseId,humanSupport:Boolean(record.leadId)});
  const nextStatus=record.leadId?'in-progress':'awaiting_details';
  await updateCase(record.caseId,{paymentStatus:'paid',razorpayPaymentId:`test_pay_${crypto.randomUUID().slice(0,8)}`,status:nextStatus,updatedAt:new Date().toISOString()});
  if(record.leadId)await importLeadTranscriptIntoCase(record,record.leadId,req.user.name);
  res.json({ok:true,caseId:record.caseId,humanSupport:Boolean(record.leadId)});
}));

app.post('/api/my/cases/:caseId/details',requireAuth,upload.array('proofs',5),async(req,res)=>{try{const record=await findCase(req.params.caseId,req.user.uid);if(!record)return res.status(404).json({error:'Case not found.'});if((record.paymentStatus||record.payment_status)!=='paid')return res.status(402).json({error:'Please complete the ₹59 filing fee first.'});const{category,description}=req.body||{};if(!description||description.trim().length<20)return res.status(400).json({error:'Please describe what happened in at least 20 characters.'});const files=[];for(const file of req.files||[]){const filename=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-80)}`;const storagePath=`${record.caseId}/${filename}`;if(DB_ENABLED){await uploadToStorage(file,storagePath);const f={id:crypto.randomUUID(),caseId:record.caseId,filename,originalName:file.originalname,size:file.size,mimeType:file.mimetype,storagePath,createdAt:new Date().toISOString()};await createCaseFile(f);files.push(f);}else{const dir=path.join(UPLOADS_DIR,record.caseId);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,filename),file.buffer);files.push({filename,originalName:file.originalname,size:file.size});}}
const cat=(category||'other').slice(0,40);const desc=description.trim().slice(0,4000);const summary=buildSummary({category:cat,description:desc});await updateCase(record.caseId,{category:cat,description:desc,summary,status:'submitted',updatedAt:new Date().toISOString()});
const leadId=String(req.body?.leadId||'').trim();if(leadId)await importLeadTranscriptIntoCase(record,leadId,req.user.name);
res.json({ok:true,caseId:record.caseId,summary});}catch(e){console.error(e);res.status(500).json({error:'Could not save case details or evidence.'});}});

function stripInternal(c){const x=caseFromDb(c);const{userId,...rest}=x;return rest;}
async function decorateCase(c){
  const x=caseFromDb(c);
  try {
    x.proofFiles=await listCaseFiles(x.caseId);
  } catch (err) {
    // A case must remain viewable even if evidence metadata is temporarily unavailable.
    console.error('Case file metadata error:', err);
    x.proofFiles=[];
    x.proofFilesUnavailable=true;
  }
  return x;
}
app.get('/api/my/cases',requireAuth,asyncHandler(async(req,res)=>{
  const rows=await listCasesForUser(req.user.uid);
  const fallbackSeen=parseReadState(req.get('x-read-state'));
  const seenMap=await resolveSeenMap(req.user.uid,fallbackSeen);
  const meta=await getLatestMessageMeta(rows,'customer',seenMap);
  const out=attachMessageMeta(rows,meta).sort((a,b)=>new Date(b.lastMessageAt||b.updatedAt||b.createdAt||0)-new Date(a.lastMessageAt||a.updatedAt||a.createdAt||0));
  res.json(out.map(x=>{const{userId,...rest}=x;return rest;}));
}));
app.get('/api/my/cases/:caseId',requireAuth,asyncHandler(async(req,res)=>{
  const r=await findCase(req.params.caseId,req.user.uid);
  if(!r)return res.status(404).json({error:'Case not found.'});
  res.json(stripInternal(await decorateCase(r)));
}));

async function authorizeFile(req,isAdmin){
  const record=isAdmin?await findCase(req.params.caseId):await findCase(req.params.caseId,req.user.uid);
  if(!record)return null;
  const files=await listCaseFiles(req.params.caseId);
  return files.find(f=>f.filename===req.params.filename)||null;
}

app.get('/api/my/cases/:caseId/files/:filename',requireAuth,asyncHandler(async(req,res)=>{
  const f=await authorizeFile(req,false);
  if(!f)return res.status(404).json({error:'File not found.'});
  if(DB_ENABLED){
    try{return res.redirect(await signedStorageUrl(f.storagePath));}
    catch(e){console.error('Customer file URL error:',e);return res.status(500).json({error:'Could not open file.'});}
  }
  const fp=path.join(UPLOADS_DIR,req.params.caseId,req.params.filename);
  if(!fp.startsWith(path.resolve(UPLOADS_DIR)+path.sep)||!fs.existsSync(fp))return res.status(404).json({error:'File not found.'});
  res.sendFile(fp);
}));

app.post('/api/my/cases/:caseId/read',requireAuth,asyncHandler(async(req,res)=>{
  const record=await findCase(req.params.caseId,req.user.uid);
  if(!record)return res.status(404).json({error:'Case not found.'});
  res.json(await markCaseRead(req.user.uid,req.params.caseId));
}));

app.get('/api/my/cases/:caseId/messages',requireAuth,asyncHandler(async(req,res)=>{
  const record=await findCase(req.params.caseId,req.user.uid);
  if(!record)return res.status(404).json({error:'Case not found.'});
  res.json(await listMessages(req.params.caseId));
}));

app.post('/api/my/cases/:caseId/messages',requireAuth,rateLimit('chat-send',30,5*60*1000),asyncHandler(async(req,res)=>{
  const record=await findCase(req.params.caseId,req.user.uid);
  if(!record)return res.status(404).json({error:'Case not found.'});
  const{text}=req.body||{};
  if(!text||!text.trim())return res.status(400).json({error:'Message cannot be empty.'});
  const msg={id:crypto.randomUUID(),caseId:req.params.caseId,sender:'customer',senderName:req.user.name,text:text.trim().slice(0,2000),createdAt:new Date().toISOString()};
  res.status(201).json(await createMessage(msg));
}));

// ADMIN / AGENT WORKSPACE
async function listStaffCases(staff){
  if(!DB_ENABLED){
    const rows=readJson(FILES.cases).filter(c=>c.paymentStatus==='paid');
    if(staff.role==='admin')return rows;
    return rows.filter(c=>!c.assignedTo||c.assignedTo===staff.uid);
  }
  if(staff.role==='admin')return dbSelect('cases','payment_status=eq.paid&order=updated_at.desc');
  const mine=await dbSelect('cases',`payment_status=eq.paid&assigned_to=eq.${encodeURIComponent(staff.uid)}&order=updated_at.desc`);
  const open=await dbSelect('cases','payment_status=eq.paid&assigned_to=is.null&order=updated_at.desc');
  return [...mine,...open];
}
async function canStaffAccessCase(staff,record){return staff.role==='admin'||!record.assignedTo||record.assignedTo===staff.uid;}
app.get('/api/admin/cases',requireStaff,asyncHandler(async(req,res)=>{
  const rows=await listStaffCases(req.staff);
  const fallbackSeen=parseReadState(req.get('x-read-state'));
  const seenMap=await resolveSeenMap(req.staff.uid,fallbackSeen);
  const meta=await getLatestMessageMeta(rows,req.staff.role,seenMap);
  const out=attachMessageMeta(rows,meta).sort((a,b)=>new Date(b.lastMessageAt||b.updatedAt||b.createdAt||0)-new Date(a.lastMessageAt||a.updatedAt||a.createdAt||0));
  res.json(out);
}));
app.get('/api/admin/cases/:caseId',requireStaff,asyncHandler(async(req,res)=>{
  const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});
  const c=caseFromDb(record);if(!(await canStaffAccessCase(req.staff,c)))return res.status(403).json({error:'This case is assigned to another agent.'});
  res.json(await decorateCase(record));
}));
app.patch('/api/admin/cases/:caseId/status',requireStaff,async(req,res)=>{const allowed=['awaiting_details','submitted','in-progress','won','closed'];if(!allowed.includes(req.body?.status))return res.status(400).json({error:`Status must be one of: ${allowed.join(', ')}`});const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});if(!(await canStaffAccessCase(req.staff,caseFromDb(record))))return res.status(403).json({error:'This case is assigned to another agent.'});await updateCase(req.params.caseId,{status:req.body.status,updatedAt:new Date().toISOString()});res.json({ok:true});});
app.patch('/api/admin/cases/:caseId/assign',requireAdmin,async(req,res)=>{try{
  const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});
  const agentId=req.body?.agentId?String(req.body.agentId):null;
  if(agentId){const agent=await findUserById(agentId);if(!agent||agent.role!=='agent')return res.status(400).json({error:'Agent not found.'});}
  await updateCase(req.params.caseId,{assignedTo:agentId,assignedAt:agentId?new Date().toISOString():null,updatedAt:new Date().toISOString()});res.json({ok:true,assignedTo:agentId});
}catch(e){console.error(e);res.status(500).json({error:'Could not assign case.'});}});
app.post('/api/admin/cases/:caseId/read',requireStaff,asyncHandler(async(req,res)=>{
  const record=await findCase(req.params.caseId);
  if(!record)return res.status(404).json({error:'Case not found.'});
  if(!(await canStaffAccessCase(req.staff,caseFromDb(record))))return res.status(403).json({error:'This case is assigned to another agent.'});
  res.json(await markCaseRead(req.staff.uid,req.params.caseId));
}));
app.get('/api/admin/cases/:caseId/messages',requireStaff,asyncHandler(async(req,res)=>{const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});if(!(await canStaffAccessCase(req.staff,caseFromDb(record))))return res.status(403).json({error:'This case is assigned to another agent.'});res.json(await listMessages(req.params.caseId));}));
app.post('/api/admin/cases/:caseId/messages',requireStaff,async(req,res)=>{try{const{text}=req.body||{};if(!text||!text.trim())return res.status(400).json({error:'Message cannot be empty.'});const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});const c=caseFromDb(record);if(!(await canStaffAccessCase(req.staff,c)))return res.status(403).json({error:'This case is assigned to another agent.'});
  // An agent replying to an unassigned case claims it, preventing two agents from working it simultaneously.
  if(req.staff.role==='agent'&&!c.assignedTo)await updateCase(c.caseId,{assignedTo:req.staff.uid,assignedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const msg={id:crypto.randomUUID(),caseId:req.params.caseId,sender:req.staff.role==='admin'?'admin':'agent',senderName:req.staff.name,text:text.trim().slice(0,2000),createdAt:new Date().toISOString()};res.status(201).json(await createMessage(msg));
}catch(e){console.error(e);res.status(500).json({error:'Could not send message.'});}});
app.get('/api/admin/cases/:caseId/files/:filename',requireStaff,async(req,res)=>{const record=await findCase(req.params.caseId);if(!record)return res.status(404).json({error:'Case not found.'});if(!(await canStaffAccessCase(req.staff,caseFromDb(record))))return res.status(403).json({error:'This case is assigned to another agent.'});const f=await authorizeFile(req,true);if(!f)return res.status(404).json({error:'File not found.'});if(DB_ENABLED){try{return res.redirect(await signedStorageUrl(f.storagePath));}catch(e){return res.status(500).json({error:'Could not open file.'});}}const fp=path.join(UPLOADS_DIR,req.params.caseId,req.params.filename);if(!fp.startsWith(path.resolve(UPLOADS_DIR)+path.sep)||!fs.existsSync(fp))return res.status(404).json({error:'File not found.'});res.sendFile(fp);});

app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/admin-login',(req,res)=>res.sendFile(path.join(__dirname,'public','admin-login.html')));

app.get('/api/config',(req,res)=>res.json({paymentsLive:PAYMENTS_LIVE,caseFeeRupees:CASE_FEE_PAISE/100,aiChatLive:AI_CHAT_LIVE,googleLogin:!!GOOGLE_CLIENT_ID,googleClientId:GOOGLE_CLIENT_ID,database:'supabase'}));
app.get('/api/health',(req,res)=>res.json({ok:true,time:new Date().toISOString(),database:DB_ENABLED?'supabase':'json-fallback'}));
app.use((err,req,res,next)=>{
  console.error('Unhandled request error:',err);
  if(res.headersSent)return next(err);
  if(err instanceof multer.MulterError)return res.status(400).json({error:err.message});
  if(err.message==='CORS origin not allowed')return res.status(403).json({error:err.message});
  res.status(500).json({error:'Unexpected server error. Please try again.'});
});

// Log unexpected process-level failures without deliberately terminating the service.
// Request-level async failures are handled by asyncHandler above.
process.on('unhandledRejection',(err)=>console.error('Unhandled promise rejection:',err));

app.listen(PORT,'0.0.0.0',()=>{console.log(`RefundWaapsi server running on port ${PORT}`);console.log(`Database: ${DB_ENABLED?'SUPABASE':'JSON FALLBACK'}`);console.log(`Payments: ${PAYMENTS_LIVE?'LIVE':'TEST MODE'}`);console.log(`Lead chat: ${AI_CHAT_LIVE?'AI':'SCRIPTED'}`);});
