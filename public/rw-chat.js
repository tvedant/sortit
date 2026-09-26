/* rw-chat.js — stable, instant-send chat: incremental rendering, optimistic sending, no loading flashes.
   Loads AFTER the page's inline script and replaces its chat/list functions. */
(() => {
'use strict';
const D = document, $ = id => D.getElementById(id);
const dash = !!$('screenList'), admin = !!$('agentManager');
if (!dash && !admin) return;

/* ---------- sides + instant-feel styling ---------- */
const mineBg = dash ? '#2C5F8A' : '#2457a6';
const S = D.createElement('style');
S.textContent = `
.chat-msg.customer,.chat-msg.agent,.chat-msg.admin,.msg.customer,.msg.agent,.msg.admin{align-self:flex-start}
.chat-msg.mine,.msg.mine{align-self:flex-end;background:${mineBg}!important;border-color:${dash ? '#1A1611' : mineBg}!important;color:#fff}
.chat-msg.mine .who,.msg.mine .who{color:#fff;opacity:.8}
.chat-messages,.messages{overscroll-behavior:contain}
/* Sent instantly, so the pop-in should read as instant too — not the slower staggered reveal used elsewhere. */
.chat-messages .rw-pop,.messages .rw-pop{animation-duration:.16s!important;animation-delay:0s!important}
.chat-msg.pending,.msg.pending{opacity:.62}
.chat-msg.failed,.msg.failed{opacity:1;background:#fff0f0!important;border-color:#e2a3a3!important;cursor:pointer}
.rw-stat{display:inline-flex;align-items:center;gap:4px;font-size:10px;opacity:.85;margin-left:6px}
.rw-clock{width:9px;height:9px;border:1.5px solid currentColor;border-radius:50%;position:relative;flex:none}
.rw-clock::after{content:'';position:absolute;left:50%;top:50%;width:2.5px;height:2.5px;background:currentColor;border-radius:50%;transform:translate(-50%,-50%)}
.chat-msg.failed .rw-stat,.msg.failed .rw-stat{color:#c1272d;font-weight:700}
@keyframes rwping{0%,100%{opacity:.4}50%{opacity:1}}
.chat-msg.pending .rw-stat,.msg.pending .rw-stat{animation:rwping 1s ease-in-out infinite}`;
D.head.append(S);

/* ---------- helpers ---------- */
const keyOf = m => m.id || m._id || (m.createdAt + '|' + m.text);
const throttled = (fn, gap) => { let last = 0, t; return () => { const w = last + gap - Date.now(); clearTimeout(t); if (w <= 0) { last = Date.now(); fn(); } else t = setTimeout(() => { last = Date.now(); fn(); }, w); }; };
const time = m => new Date(m.createdAt).toLocaleString('en-IN');
const uid = () => 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Read receipts: send once per (case, latest message). Stops any read -> stream event -> read loop.
const _mr = window.markRead; let lastMR = '';
window.markRead = c => { const k = (c && c.caseId) + '|' + (c && c.lastMessageAt); if (k === lastMR) return Promise.resolve(); lastMR = k; return _mr(c); };

// Incremental renderer: only appends what is new, and never touches confirmed bubbles, so nothing flickers.
// Optimistic ("pending") bubbles live outside the confirmed-key bookkeeping entirely, so a poll or live-update
// landing mid-send can never wipe out a message the person just watched appear on screen.
function makeChat(box, build, emptyClass, emptyText) {
  let keys = [], id = null; const pending = new Map();
  const empty = () => { const e = D.createElement('div'); e.className = emptyClass + ' rw-empty'; e.textContent = emptyText; return e; };
  const near = () => box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  const down = smooth => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  const reflow = () => { for (const p of pending.values()) box.append(p.el); };
  return {
    bottom() { down(false); },
    reset(n) { if (n === id) return; id = n; keys = []; pending.clear(); box.replaceChildren(); },
    add(m, force) { const k = keyOf(m); if (keys.includes(k)) return; const e = box.querySelector('.rw-empty'); if (e) e.remove(); box.append(build(m)); keys.push(k); reflow(); if (force || near()) down(true); },
    // Appears the instant the person hits send — before the network round-trip even starts.
    addPending(tempKey, msg) { const e = box.querySelector('.rw-empty'); if (e) e.remove(); const el = build(msg); el.classList.add('pending'); el.dataset.tmp = tempKey; box.append(el); pending.set(tempKey, { el, msg }); down(true); return el; },
    resolvePending(tempKey, realMsg) { const p = pending.get(tempKey); if (!p) return; pending.delete(tempKey); p.el.remove(); this.add(realMsg, true); },
    failPending(tempKey) { const p = pending.get(tempKey); if (!p) return; p.el.classList.remove('pending'); p.el.classList.add('failed'); },
    retryPending(tempKey) { const p = pending.get(tempKey); if (!p) return null; p.el.classList.remove('failed'); p.el.classList.add('pending'); return p.msg; },
    removePending(tempKey) { const p = pending.get(tempKey); if (!p) return; p.el.remove(); pending.delete(tempKey); },
    sync(list) {
      const nk = list.map(keyOf);
      if (!nk.length) { if (!box.firstElementChild && !pending.size) box.append(empty()); return; }
      const same = keys.length <= nk.length && keys.every((k, i) => k === nk[i]);
      if (same && keys.length === nk.length) { reflow(); return; }
      const first = !keys.length, stick = first || near();
      const e = box.querySelector('.rw-empty'); if (e) e.remove();
      if (same) list.slice(keys.length).forEach(m => box.append(build(m)));
      else box.replaceChildren(...list.map(build));
      keys = nk; reflow(); if (stick) down(!first);
    }
  };
}
const bubble = (cls, who, text, stat) => { const el = D.createElement('div'); el.className = cls; const w = D.createElement('span'); w.className = 'who'; w.textContent = who; el.append(w, D.createTextNode(text)); if (stat) el.insertAdjacentHTML('beforeend', stat); return el; };
const PENDING_STAT = `<span class="rw-stat"><span class="rw-clock"></span></span>`;
const FAILED_STAT = `<span class="rw-stat">⚠ Not sent · Tap to retry</span>`;

/* ================= CUSTOMER DASHBOARD ================= */
if (dash) {
  const chat = makeChat($('chatMessages'), m => {
    const s = m.sender === 'admin' ? 'admin' : m.sender === 'agent' ? 'agent' : 'customer', mine = s === 'customer';
    const label = mine ? 'You' : (m.senderName || (s === 'admin' ? 'Super Admin' : 'Agent'));
    const stat = mine ? (m.failed ? FAILED_STAT : m.pending ? PENDING_STAT : '') : '';
    return bubble(`chat-msg ${s}${mine ? ' mine' : ''}`, [label, mine ? '' : (s === 'admin' ? 'SUPER ADMIN' : 'AGENT'), time(m)].filter(Boolean).join(' · '), m.text, stat);
  }, 'chat-empty', 'No messages yet — say hello!');

  let busy = false, again = false;
  window.loadMessages = async function () {
    if (!currentCaseId) return;
    if (busy) { again = true; return; }
    busy = true; const cid = currentCaseId;
    try {
      const res = await fetch(`/api/my/cases/${encodeURIComponent(cid)}/messages`, { cache: 'no-store' });
      if (!res.ok || cid !== currentCaseId) return;
      const list = await res.json(); chat.reset(cid); chat.sync(list);
      const last = list[list.length - 1]; if (last && last.createdAt) markRead({ caseId: cid, lastMessageAt: last.createdAt });
    } catch (e) { console.debug('loadMessages', e); }
    finally { busy = false; if (again) { again = false; loadMessages(); } }
  };
  const _ov = window.openCaseView;
  window.openCaseView = function (id) {   // open instantly; fetch messages in parallel with the case details
    chat.reset(id); currentCaseId = id; $('caseViewId').textContent = id; $('caseViewStatus').textContent = ''; $('caseViewSummary').textContent = ''; $('caseViewFiles').textContent = '';
    showScreen('case'); loadMessages();
    return _ov.apply(this, arguments).then(() => chat.bottom());
  };
  window.openChatStream = function (caseId) {
    closeChatStream(); const run = throttled(() => loadMessages(), 400);
    const es = new EventSource(`/api/my/cases/${encodeURIComponent(caseId)}/stream`);
    es.addEventListener('message', ev => { try { const d = JSON.parse(ev.data), m = d && (d.message || d); if (m && m.text && m.createdAt && m.sender) chat.add(m); } catch (_) {} run(); });
    es.onerror = () => {}; chatStream = es;
  };

  // send: appears the instant you press it (or hit Enter) — the network call happens in the background.
  const sb = $('chatSendBtn'), si = $('chatInput'), nb = sb.cloneNode(true), ni = si.cloneNode(true); sb.replaceWith(nb); si.replaceWith(ni);
  async function attempt(text, tempKey) {
    try {
      const res = await fetch(`/api/my/cases/${encodeURIComponent(currentCaseId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text }) });
      const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `Could not send message (HTTP ${res.status}).`);
      const at = d.createdAt || new Date().toISOString();
      chat.resolvePending(tempKey, { ...d, text: d.text || text, createdAt: at, sender: 'customer' }); markRead({ caseId: currentCaseId, lastMessageAt: at });
    } catch (e) { chat.failPending(tempKey); $('chatNotice').textContent = e.message || 'Could not send. Tap the message to retry.'; }
  }
  const send = () => {
    const text = ni.value.trim(); if (!text || !currentCaseId) return;
    $('chatNotice').textContent = ''; ni.value = ''; ni.focus();   // clears instantly — never waits on the network
    const tempKey = uid();
    chat.addPending(tempKey, { text, createdAt: new Date().toISOString(), sender: 'customer', pending: true });
    attempt(text, tempKey);
  };
  nb.addEventListener('click', send);
  ni.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) send(); });
  $('chatMessages').addEventListener('click', e => { const el = e.target.closest('.chat-msg.failed'); if (!el || !el.dataset.tmp) return;
    const tempKey = el.dataset.tmp, msg = chat.retryPending(tempKey); if (msg) attempt(msg.text, tempKey); });

  // case list: loader only on the very first load; re-render only when data really changed; keep last good list on errors
  const row = c => { const locked = !!c.accessExpired, p = locked ? 'Access expired — renew to continue' : (c.lastMessageText ? `${senderLabel(c)}: ${c.lastMessageText}` : 'No messages yet'), n = Number(c.unreadCount || 0);
    return `<div class="case-row ${n ? 'unread' : ''}" data-case="${escapeHtml(c.caseId)}" data-status="${escapeHtml(c.status || '')}"><div style="min-width:0;flex:1"><div class="case-id">${escapeHtml(c.caseId)}${locked ? ' <span style="color:#9b6810;font-size:11px;font-weight:800;">⏳ EXPIRED</span>' : ''}</div><div class="case-meta">${c.createdAt ? new Date(c.createdAt).toLocaleString('en-IN') : 'Date unavailable'}${c.category ? ' • ' + escapeHtml(c.category) : ''}</div><div class="case-preview"${locked ? ' style="color:#9b6810;font-weight:600;"' : ''}>${escapeHtml(p)}</div></div><div class="case-actions">${n ? `<span class="unread-pill" title="${n} unread message${n === 1 ? '' : 's'}">${n > 99 ? '99+' : n}</span>` : ''}<span class="status-badge status-${escapeHtml(c.status || '')}">${escapeHtml(statusLabel(c.status || ''))}</span></div></div>`; };
  let listBusy = false, listKey = null;
  window.loadCases = async function () {
    if (listBusy) return; listBusy = true; const el = $('caseList');
    try {
      if (!el.firstElementChild) el.innerHTML = '<div class="loading-state">Loading your cases…</div>';
      const res = await fetch('/api/my/cases', { cache: 'no-store' }), payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Could not load your cases.');
      const cases = (Array.isArray(payload) ? payload : []).sort((a, b) => new Date(b.lastMessageAt || b.updatedAt || b.createdAt || 0) - new Date(a.lastMessageAt || a.updatedAt || a.createdAt || 0));
      const key = JSON.stringify(cases.map(c => [c.caseId, c.status, c.unreadCount, c.lastMessageAt, c.lastMessageText, c.lastMessageSender, c.lastMessageSenderName, c.category, c.createdAt]));
      if (key === listKey) return; listKey = key;
      if (!cases.length) { el.innerHTML = '<div class="empty-state">No cases yet. Click "Open a New Case" to file your first one.</div>'; return; }
      el.innerHTML = cases.map(row).join('');
      el.querySelectorAll('.case-row').forEach(r => r.addEventListener('click', () => resumeCase(r.dataset.case, r.dataset.status)));
    } catch (err) {
      console.error('loadCases:', err);
      if (listKey === null || !el.querySelector('.case-row')) { listKey = null; el.innerHTML = `<div class="empty-state"><strong>Could not load your cases.</strong><br><span style="font-size:13px;">${escapeHtml(err.message || 'Please refresh and try again.')}</span><br><button class="btn secondary" style="margin-top:16px;" onclick="loadCases()">Try Again</button></div>`; }
    } finally { listBusy = false; }
  };
}

/* ================= SUPPORT WORKSPACE (admin / agents) ================= */
if (admin) {
  const isMine = m => (m.senderId && m.senderId === staff.uid) || (!m.senderId && m.sender === staff.role);
  const chat = makeChat($('messages'), m => {
    const s = m.sender === 'customer' ? 'customer' : m.sender === 'admin' ? 'admin' : 'agent', mine = isMine(m);
    const label = mine ? 'You' : (m.senderName || (s === 'customer' ? 'Customer' : s === 'admin' ? 'Super Admin' : 'Agent'));
    const stat = mine ? (m.failed ? FAILED_STAT : m.pending ? PENDING_STAT : '') : '';
    return bubble(`msg ${s}${mine ? ' mine' : ''}`, [label, mine ? '' : (s === 'admin' ? 'SUPER ADMIN' : s === 'agent' ? 'AGENT' : 'CUSTOMER'), time(m)].filter(Boolean).join(' · '), m.text, stat);
  }, 'empty', 'No messages yet. Start the conversation.');

  let busy = false, again = false;
  window.loadMessages = async function () {
    if (!current) return;
    if (busy) { again = true; return; }
    busy = true; const cid = current.caseId;
    try {
      const list = await api('/api/admin/cases/' + encodeURIComponent(cid) + '/messages');
      if (!current || current.caseId !== cid) return;
      chat.reset(cid); chat.sync(list);
      const last = list[list.length - 1];
      if (last && last.createdAt) { await markRead({ ...current, lastMessageAt: last.createdAt });
        const r = cases.find(c => c.caseId === cid); if (r && (r.unreadCount || r.unread)) { r.unreadCount = 0; r.unread = false; renderList(); } }
    } catch (e) { console.error('loadMessages', e); }
    finally { busy = false; if (again) { again = false; loadMessages(); } }
  };
  const _oc = window.openCase;
  window.openCase = function (id) { chat.reset(id); const p = _oc.apply(this, arguments); loadMessages(); return p; };   // messages load in parallel with details
  const _rl = window.renderList;   // unread total in the tab title
  window.renderList = function () { _rl.apply(this, arguments); const n = cases.reduce((a, c) => a + Number(c.unreadCount || 0), 0); D.title = (n ? `(${n}) ` : '') + 'RefundWaapsi — Support Workspace'; };
  window.openChatStream = function (caseId) {
    closeChatStream(); const run = throttled(() => { loadMessages(); loadCases(true).catch(() => {}); }, 500);
    const es = new EventSource('/api/admin/cases/' + encodeURIComponent(caseId) + '/stream');
    es.addEventListener('message', ev => { try { const d = JSON.parse(ev.data), m = d && (d.message || d); if (m && m.text && m.createdAt && m.sender) chat.add(m); } catch (_) {} run(); });
    es.onerror = () => {}; chatStream = es;
  };
  async function attemptStaff(text, tempKey, caseId) {
    try {
      const sent = await api('/api/admin/cases/' + encodeURIComponent(caseId) + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const at = sent.createdAt || new Date().toISOString();
      if (current && current.caseId === caseId) {
        chat.resolvePending(tempKey, { ...sent, text: sent.text || text, createdAt: at, sender: staff.role, senderId: staff.uid, senderName: staff.name });
        Object.assign(current, { lastMessageText: sent.text || text, lastMessageAt: at, lastMessageSender: staff.role, lastMessageSenderName: staff.name, unread: false });
        await markRead(current); renderList();
      }
    } catch (e) { if (current && current.caseId === caseId) chat.failPending(tempKey); }
  }
  $('send').onclick = () => {
    const t = $('composer').value.trim(); if (!t || !current) return;
    const caseId = current.caseId; $('composer').value = ''; $('composer').focus();   // clears instantly
    const tempKey = uid();
    chat.addPending(tempKey, { text: t, createdAt: new Date().toISOString(), sender: staff.role, senderId: staff.uid, senderName: staff.name, pending: true });
    attemptStaff(t, tempKey, caseId);
  };
  $('messages').addEventListener('click', e => { const el = e.target.closest('.msg.failed'); if (!el || !el.dataset.tmp || !current) return;
    const tempKey = el.dataset.tmp, msg = chat.retryPending(tempKey); if (msg) attemptStaff(msg.text, tempKey, current.caseId); });
}
D.addEventListener('visibilitychange', () => { if (D.visibilityState !== 'visible') return; if (admin) loadCases(true).catch(() => {}); else if (currentCaseId) loadMessages(); else loadCases(); });
})();
