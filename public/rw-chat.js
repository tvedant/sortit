/* rw-chat.js — stable chat: incremental rendering, no loading flashes, own messages on the right.
   Loads AFTER the page's inline script and replaces its chat/list functions. */
(() => {
'use strict';
const D = document, $ = id => D.getElementById(id);
const dash = !!$('screenList'), admin = !!$('agentManager');
if (!dash && !admin) return;

/* ---------- sides: mine = right (blue), everyone else = left ---------- */
const mineBg = dash ? '#2C5F8A' : '#2457a6';
const S = D.createElement('style');
S.textContent = `
.chat-msg.customer,.chat-msg.agent,.chat-msg.admin,.msg.customer,.msg.agent,.msg.admin{align-self:flex-start}
.chat-msg.mine,.msg.mine{align-self:flex-end;background:${mineBg}!important;border-color:${dash ? '#1A1611' : mineBg}!important;color:#fff}
.chat-msg.mine .who,.msg.mine .who{color:#fff;opacity:.8}
.chat-messages,.messages{overscroll-behavior:contain}`;
D.head.append(S);

/* ---------- helpers ---------- */
const keyOf = m => m.id || m._id || (m.createdAt + '|' + m.text);
const throttled = (fn, gap) => { let last = 0, t; return () => { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(); }, Math.max(150, last + gap - Date.now())); }; };
const time = m => new Date(m.createdAt).toLocaleString('en-IN');

// Read receipts: send once per (case, latest message). Stops any read -> stream event -> read loop.
const _mr = window.markRead; let lastMR = '';
window.markRead = c => { const k = (c && c.caseId) + '|' + (c && c.lastMessageAt); if (k === lastMR) return Promise.resolve(); lastMR = k; return _mr(c); };

// Incremental renderer: only appends what is new. Existing bubbles are never touched, so nothing flickers.
function makeChat(box, build, emptyClass, emptyText) {
  let keys = [], id = null;
  const empty = () => { const e = D.createElement('div'); e.className = emptyClass + ' rw-empty'; e.textContent = emptyText; return e; };
  const near = () => box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  const down = smooth => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  return {
    reset(n) { if (n === id) return; id = n; keys = []; box.replaceChildren(); },
    add(m) { const k = keyOf(m); if (keys.includes(k)) return; const e = box.querySelector('.rw-empty'); if (e) e.remove(); box.append(build(m)); keys.push(k); down(true); },
    sync(list) {
      const nk = list.map(keyOf);
      if (!nk.length) { if (!box.firstElementChild) box.append(empty()); return; }
      const same = keys.length <= nk.length && keys.every((k, i) => k === nk[i]);
      if (same && keys.length === nk.length) return;
      const first = !keys.length, stick = first || near();
      const e = box.querySelector('.rw-empty'); if (e) e.remove();
      if (same) list.slice(keys.length).forEach(m => box.append(build(m)));
      else box.replaceChildren(...list.map(build));
      keys = nk; if (stick) down(!first);
    }
  };
}
const bubble = (cls, who, text) => { const el = D.createElement('div'); el.className = cls; const w = D.createElement('span'); w.className = 'who'; w.textContent = who; el.append(w, D.createTextNode(text)); return el; };

/* ================= CUSTOMER DASHBOARD ================= */
if (dash) {
  const chat = makeChat($('chatMessages'), m => {
    const s = m.sender === 'admin' ? 'admin' : m.sender === 'agent' ? 'agent' : 'customer', mine = s === 'customer';
    const label = mine ? 'You' : (m.senderName || (s === 'admin' ? 'Super Admin' : 'Agent'));
    return bubble(`chat-msg ${s}${mine ? ' mine' : ''}`, [label, mine ? '' : (s === 'admin' ? 'SUPER ADMIN' : 'AGENT'), time(m)].filter(Boolean).join(' · '), m.text);
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
  const _ov = window.openCaseView; window.openCaseView = function (id) { chat.reset(id); return _ov.apply(this, arguments); };
  window.openChatStream = function (caseId) {
    closeChatStream(); const run = throttled(() => loadMessages(), 1200);
    const es = new EventSource(`/api/my/cases/${encodeURIComponent(caseId)}/stream`);
    es.addEventListener('message', run); es.onerror = () => {}; chatStream = es;
  };

  // send (old listeners are bound to the old function, so swap the nodes)
  const sb = $('chatSendBtn'), si = $('chatInput'), nb = sb.cloneNode(true), ni = si.cloneNode(true); sb.replaceWith(nb); si.replaceWith(ni);
  const send = async () => {
    const text = ni.value.trim(), note = $('chatNotice'); if (!text || !currentCaseId || nb.disabled) return;
    note.textContent = ''; nb.disabled = true; nb.textContent = 'Sending…';
    try {
      const res = await fetch(`/api/my/cases/${encodeURIComponent(currentCaseId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text }) });
      const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `Could not send message (HTTP ${res.status}).`);
      const at = d.createdAt || new Date().toISOString(); ni.value = '';
      chat.add({ ...d, text: d.text || text, createdAt: at, sender: 'customer' }); markRead({ caseId: currentCaseId, lastMessageAt: at });
    } catch (e) { ni.value = text; note.textContent = e.message || 'Could not send message. Please try again.'; }
    finally { nb.disabled = false; nb.textContent = 'Send'; ni.focus(); }
  };
  nb.addEventListener('click', send); ni.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) send(); });

  // case list: loader only on the very first load; re-render only when data really changed; keep last good list on errors
  const row = c => { const p = c.lastMessageText ? `${senderLabel(c)}: ${c.lastMessageText}` : 'No messages yet', n = Number(c.unreadCount || 0);
    return `<div class="case-row ${n ? 'unread' : ''}" data-case="${escapeHtml(c.caseId)}" data-status="${escapeHtml(c.status || '')}"><div style="min-width:0;flex:1"><div class="case-id">${escapeHtml(c.caseId)}</div><div class="case-meta">${c.createdAt ? new Date(c.createdAt).toLocaleString('en-IN') : 'Date unavailable'}${c.category ? ' • ' + escapeHtml(c.category) : ''}</div><div class="case-preview">${escapeHtml(p)}</div></div><div class="case-actions">${n ? `<span class="unread-pill" title="${n} unread message${n === 1 ? '' : 's'}">${n > 99 ? '99+' : n}</span>` : ''}<span class="status-badge status-${escapeHtml(c.status || '')}">${escapeHtml(statusLabel(c.status || ''))}</span></div></div>`; };
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
    return bubble(`msg ${s}${mine ? ' mine' : ''}`, [label, mine ? '' : (s === 'admin' ? 'SUPER ADMIN' : s === 'agent' ? 'AGENT' : 'CUSTOMER'), time(m)].filter(Boolean).join(' · '), m.text);
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
  const _oc = window.openCase; window.openCase = function (id) { chat.reset(id); return _oc.apply(this, arguments); };
  window.openChatStream = function (caseId) {
    closeChatStream(); const run = throttled(() => { loadMessages(); loadCases(true).catch(() => {}); }, 1500);
    const es = new EventSource('/api/admin/cases/' + encodeURIComponent(caseId) + '/stream');
    es.addEventListener('message', run); es.onerror = () => {}; chatStream = es;
  };
  $('send').onclick = async () => {
    const t = $('composer').value.trim(); if (!t || !current) return; $('send').disabled = true;
    try {
      const sent = await api('/api/admin/cases/' + encodeURIComponent(current.caseId) + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
      const at = sent.createdAt || new Date().toISOString(); $('composer').value = '';
      chat.add({ ...sent, text: sent.text || t, createdAt: at, sender: staff.role, senderId: staff.uid, senderName: staff.name });
      Object.assign(current, { lastMessageText: sent.text || t, lastMessageAt: at, lastMessageSender: staff.role, lastMessageSenderName: staff.name, unread: false });
      await markRead(current); renderList();
    } catch (e) { alert(e.message); } finally { $('send').disabled = false; }
  };
}
})();
