/* Conductor on your phone. Plain JavaScript, no external requests. */
'use strict';
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* optional */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* optional */ } } };
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* optional */ } };

const ICON = {
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  work: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg>',
  agents: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>',
  usage: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14 7.6"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  cpu: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
};

// ---- network --------------------------------------------------------------------
let token = ls.get('conductor.phone');
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({ error: 'The Mac sent an unexpected reply.' }));
  if (r.status === 401 && token) { token = null; ls.del('conductor.phone'); S.view = { t: 'tab' }; paint(); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}
const rpc = async (channel, payload) => { const j = await post('/api/rpc', { channel, payload }); if (!j.ok) throw new Error(j.error || 'Failed'); return j.value; };
const api = async (path, body) => (await post(path, body)).value;
async function upload(file) {
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name || 'photo.jpg') + '&type=' + encodeURIComponent(file.type || 'application/octet-stream'), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed.');
  return j.value;
}

// ---- state ----------------------------------------------------------------------
const S = {
  tab: 'work', view: { t: 'tab' },
  work: null, agents: [], cli: [], groups: [], usage: null, range: '7d', approvals: [], questions: [], projects: [],
  shut: { settled: true, snoozed: true }, sig: {}, chat: null, drafts: {}, chats: null, project: ls.get('cp.filter') || '',
};
const TABS = ['work', 'chat', 'agents', 'inbox', 'more'];
const TITLE = { work: 'Work', chat: 'Chat', agents: 'Agents', inbox: 'Inbox', usage: 'Usage', more: 'More' };

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'now'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
const WORKING = ['CREATED', 'CONTEXT_LOADING', 'PLANNING', 'RUNNING', 'VERIFYING'];
const tone = (state) => WORKING.includes(state) ? 'work' : state === 'WAITING_FOR_APPROVAL' ? 'wait' : state === 'COMPLETED' ? 'done' : (state === 'FAILED' || state === 'BLOCKED' || state === 'RECOVERABLE_INTERRUPTION') ? 'err' : '';
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const money = (r) => r && r.costUsd !== undefined ? '$' + (r.costUsd >= 100 ? r.costUsd.toFixed(0) : r.costUsd.toFixed(2)) : '—';

// ---- tiny markdown ----------------------------------------------------------------
function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
function md(text) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2) { close(); out.push('<pre><code>' + esc(part.replace(/^[^\n]*\n/, '').replace(/\n$/, '')) + '</code></pre>'); return; }
    for (const line of part.split('\n')) {
      let m;
      if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); }
      else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); }
      else if ((m = /^#{1,6}\s+(.*)/.exec(line))) { close(); out.push('<h4>' + inline(m[1]) + '</h4>'); }
      else if ((m = /^>\s?(.*)/.exec(line))) { close(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); }
      else if (line.trim() === '') close();
      else { close(); out.push('<p>' + inline(line) + '</p>'); }
    }
  });
  close();
  return '<div class="md">' + out.join('') + '</div>';
}

// ---- sheets & toasts ------------------------------------------------------------------
let sheetEl = null;
function closeSheet() { sheetEl?.remove(); sheetEl = null; }
function sheet(title, html, wire) {
  closeSheet();
  sheetEl = document.createElement('div');
  sheetEl.className = 'sheetbg';
  sheetEl.innerHTML = '<div class="sheet" role="dialog" aria-label="' + esc(title) + '"><div class="grab"></div><h3>' + esc(title) + '</h3><div class="body">' + html + '</div></div>';
  sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet(); });
  let y0 = null;
  const box = $('.sheet', sheetEl);
  box.addEventListener('touchstart', (e) => { if ($('.body', box).scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  box.addEventListener('touchmove', (e) => { if (y0 !== null && e.touches[0].clientY - y0 > 0) box.style.transform = 'translateY(' + (e.touches[0].clientY - y0) + 'px)'; }, { passive: true });
  box.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 110) closeSheet(); else box.style.transform = ''; y0 = null; });
  document.body.appendChild(sheetEl);
  wire?.(sheetEl);
  return sheetEl;
}
let toastTimer = 0;
function toast(msg) {
  $('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200);
}
const fail = (e) => toast(e && e.message ? e.message : 'Something went wrong.');

// ---- navigation --------------------------------------------------------------------
S.stack = [];
function open(view) { S.stack.push(S.view); history.pushState({ d: S.stack.length }, ''); S.view = view; paint(); }
function back() { if (S.stack.length) history.back(); else { S.view = { t: 'tab' }; paint(); } }
addEventListener('popstate', () => { S.view = S.stack.pop() ?? { t: 'tab' }; closeSheet(); $('.watch')?.remove(); paint(); refresh(); });

function setTab(tab) { if (S.tab === tab && S.view.t === 'tab') return; S.tab = tab; S.view = { t: 'tab' }; S.stack = []; paint(); refresh(); }

// ---- shell -----------------------------------------------------------------------------
function tabBar() {
  const waiting = S.work?.waiting ?? 0;
  const labels = { work: 'Work', chat: 'Chat', agents: 'Agents', inbox: 'Inbox', more: 'More' };
  return '<nav class="tabs">' + TABS.map((k) => '<button class="tab ' + (S.tab === k ? 'on' : '') + '" data-act="tab" data-v="' + k + '">' + ICON[k] + '<span>' + labels[k] + '</span>' + (k === 'inbox' && waiting ? '<b class="n">' + waiting + '</b>' : '') + '</button>').join('') + '</nav>';
}
function paint() {
  S.sig = {};
  if (!token) { app.innerHTML = '<div class="screen"><div class="empty" style="margin:auto"><b>Not connected</b>On your Mac, open <b style="display:inline">Control on phone</b> and scan the QR code with this phone’s camera.</div></div>'; return; }
  const v = S.view;
  if (v.t === 'thread' || v.t === 'chat') return paintThreadShell();
  if (v.t === 'usage') { app.innerHTML = '<div class="screen"><header class="bar compact"><button class="ib" data-act="back" aria-label="Back">' + ICON.back + '</button><h2 style="flex:1">Usage</h2></header><div class="scroller"><div id="list"></div></div></div>'; paintUsage(); refresh(); return; }
  if (v.t === 'group') return paintGroupShell();
  if (v.t === 'project') return paintProjectShell();
  const pname = S.project ? ((S.projects.find((p) => p.id === S.project) || {}).name || 'Project') : 'All projects';
  const filter = S.tab === 'work' ? '<button class="chip ' + (S.project ? 'on' : '') + '" data-act="filter" style="max-width:42vw">' + ICON.filter + '<span>' + esc(pname) + '</span></button>' : '';
  const action = filter + (S.tab === 'work' ? '<button class="ib" data-act="newtask" aria-label="New task">' + ICON.plus + '</button>' : S.tab === 'chat' ? '<button class="ib" data-act="newchat" aria-label="New chat">' + ICON.plus + '</button>' : S.tab === 'agents' ? '<button class="ib" data-act="newgroup" aria-label="New group chat">' + ICON.plus + '</button>' : '');
  app.innerHTML = '<div class="screen"><header class="bar"><h1>' + TITLE[S.tab] + '</h1>' + action + '</header><div class="scroller" id="scroller"><div class="ptr" id="ptr"></div><div id="list"></div></div>' + tabBar() + '</div>';
  paintList();
}
function setList(html, key) { const l = $('#list'); if (!l) return; if (S.sig.list === key) return; S.sig.list = key; l.innerHTML = html; }

// ---- tab content -------------------------------------------------------------------------
function swipeRow(inner, { key, left, right }) {
  const under = '<div class="under">' + (right ? '<span style="background:none">' + right.icon + right.label + '</span>' : '<span></span>') + (left ? '<span>' + left.label + left.icon + '</span>' : '<span></span>') + '</div>';
  return '<div class="swipe" data-key="' + esc(key) + '" data-l="' + (left ? left.act : '') + '" data-r="' + (right ? right.act : '') + '" data-lc="' + (left?.color ?? '') + '" data-rc="' + (right?.color ?? '') + '">' + under + '<div class="fg">' + inner + '</div></div>';
}
const THREAD_LEFT = { act: 'settle', label: 'Settle', icon: ICON.check, color: 'var(--ok)' };
const THREAD_RIGHT = { act: 'snooze', label: 'Snooze', icon: ICON.clock, color: 'var(--warn)' };
function threadRow(t, extra) {
  const pill = t.label ? '<span class="pill ' + tone(t.state) + '">' + esc(t.label) + '</span>' : '';
  const inner = '<div class="row" data-act="thread" data-k="' + esc(t.key) + '"><span class="dot ' + tone(t.state) + '"></span><div class="grow"><div class="t">' + esc(t.title) + '</div><div class="m">' + esc([extra, t.project, ago(t.updatedAt)].filter(Boolean).join(' · ')) + pill + '</div></div></div>';
  return swipeRow(inner, { key: t.key, left: t.settledTier ? { act: 'restore', label: 'Restore', icon: ICON.undo, color: 'var(--accent)' } : THREAD_LEFT, right: t.settledTier ? null : THREAD_RIGHT });
}
function paintChats() {
  const list = S.chats;
  if (!list) return setList('<div class="empty">Loading…</div>', 'cload');
  if (!list.length) return setList('<div class="empty"><b>No chats yet</b>Start one with the + button. Chats aren’t tied to a project.</div>', 'cnone');
  setList('<div class="group">' + list.map((c) => '<div class="row" data-act="chat" data-id="' + c.id + '"><span class="av sm" style="background:var(--fill);color:var(--mute)">' + ICON.chat.replace('<svg', '<svg style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8"') + '</span><div class="grow"><div class="t">' + esc(c.title) + '</div><div class="m">' + esc(cliName(c.agentId)) + ' · ' + ago(c.updatedAt) + '</div></div></div>').join('') + '</div>', JSON.stringify(list));
}
function paintList() {
  const l = $('#list'); if (!l) return;
  if (S.view.t === 'usage') return paintUsage();
  if (S.tab === 'chat') return paintChats();
  if (S.tab === 'work') {
    if (!S.work) return setList('<div class="empty">Loading…</div>', 'load');
    const groups = S.work.groups;
    if (!groups.length) return setList('<div class="empty"><b>Nothing here yet</b>Start a task with the + button.</div>', 'none');
    const hint = ls.get('cp.hint') ? '' : '<div class="hint">' + ICON.check.replace('<svg', '<svg width="18" height="18" style="stroke:currentColor;fill:none;stroke-width:2"') + 'Swipe a thread left to settle it, right to snooze.</div>';
    const html = hint + groups.map((g) => {
      const shut = S.shut[g.id];
      return '<div class="sec ' + (shut ? 'shut' : '') + '" data-act="sec" data-v="' + g.id + '">' + esc(g.label) + '<span class="c">' + g.threads.length + '</span><span class="chev">' + ICON.chev + '</span></div>'
        + (shut ? '' : '<div class="group">' + g.threads.map((t) => threadRow({ ...t, settledTier: g.id === 'settled' || g.id === 'snoozed' }, t.until ? 'until ' + new Date(t.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '')).join('') + '</div>');
    }).join('');
    return setList(html, JSON.stringify([groups, S.shut, !!ls.get('cp.hint')]));
  }
  if (S.tab === 'agents') {
    if (!S.agents.length && S.work) return setList('<div class="empty"><b>No agents yet</b>Create one on your Mac, then chat with it here.</div>', 'noag');
    const chats = S.work?.agentChats ?? [];
    const rows = S.agents.map((a) => {
      const mine = chats.filter((c) => c.agentId === a.id);
      const last = mine[0];
      const live = mine.some((c) => c.working);
      const waitingOn = mine.some((c) => c.state === 'WAITING_FOR_APPROVAL');
      return '<div class="row" data-act="agent" data-id="' + a.id + '">' + avatar(a, waitingOn ? 'wait' : live ? 'work' : last ? tone(last.state) : '') + '<div class="grow"><div class="t">' + esc(a.name) + '</div><div class="m">' + esc(live ? 'Working…' : waitingOn ? 'Waiting for approval' : last ? last.title : a.description || a.clis.join(' → ')) + '</div></div>' + (last ? '<span class="m">' + ago(last.updatedAt) + '</span>' : '') + '</div>';
    }).join('');
    const groups = S.groups.map((g) => '<div class="row" data-act="group" data-id="' + g.id + '"><span class="av" style="background:var(--accent)">' + ICON.chat.replace('<svg', '<svg style="width:22px;height:22px;stroke:#fff;fill:none;stroke-width:1.8"') + '</span><div class="grow"><div class="t">' + esc(g.name) + '</div><div class="m">' + g.agentIds.length + ' agents</div></div></div>').join('');
    return setList((rows ? '<div class="group">' + rows + '</div>' : '') + (groups ? '<div class="sec">Group chats</div><div class="group">' + groups + '</div>' : ''), JSON.stringify([S.agents, chats, S.groups]));
  }
  if (S.tab === 'inbox') return paintInbox();
  if (S.tab === 'usage') return paintUsage();
  if (S.tab === 'more') return paintMore();
}
function avatar(a, st, small) {
  return '<span class="av ' + (small ? 'sm' : '') + '" style="background:' + esc(a.color || '#a8289a') + '">' + esc((a.name || '?').trim().charAt(0).toUpperCase()) + (st !== undefined ? '<i class="st ' + st + '"></i>' : '') + '</span>';
}

function paintInbox() {
  const ap = S.approvals, qs = S.questions;
  if (!ap.length && !qs.length) return setList('<div class="empty"><b>All clear</b>Nothing is waiting on you.</div>', 'clear');
  const hint = ap.length && !ls.get('cp.hint2') ? '<div class="hint">' + 'Swipe right to approve, left to deny.</div>' : '';
  const a = ap.map((x) => '<div class="swipe" data-key="' + x.id + '" data-l="deny" data-r="approve" data-lc="var(--bad)" data-rc="var(--ok)"><div class="under"><span>' + ICON.check + 'Approve</span><span>Deny' + ICON.x + '</span></div><div class="fg"><div class="card appr" style="margin:0;border-radius:0;box-shadow:none"><div class="sum">' + esc(x.summary) + '</div><div class="small mute" style="margin-top:2px">' + esc(x.where || '') + ago(x.createdAt) + ' ago</div><div class="actions"><button class="btn bad" data-act="deny" data-id="' + x.id + '">Deny</button><button class="btn ok" data-act="approve" data-id="' + x.id + '">Approve</button></div></div></div></div>').join('');
  const q = qs.map((x) => '<div class="card"><div class="small mute">' + esc(x.agent) + ' asks</div>' + x.questions.map((qq) => '<h3 style="margin-top:8px">' + esc(qq.question || qq.header || '') + '</h3>' + (qq.options || []).map((o) => '<button class="opt" data-act="answer" data-id="' + x.id + '" data-q="' + qq.id + '" data-o="' + esc(o.id) + '"><div class="grow"><div>' + esc(o.label) + '</div>' + (o.description ? '<div class="m">' + esc(o.description) + '</div>' : '') + '</div></button>').join('')).join('') + '</div>').join('');
  setList(hint + (a ? '<div class="group">' + a + '</div>' : '') + q, JSON.stringify([ap, qs]));
}
function bar(pct) { const p = Math.max(0, Math.min(100, Math.round(pct))); return '<div class="bar2 ' + (p >= 100 ? 'full' : p >= 80 ? 'hot' : '') + '"><i style="width:' + p + '%"></i></div>'; }
function paintUsage() {
  const u = S.usage;
  const chips = '<div class="seg">' + [['24h', '24h'], ['7d', '7 days'], ['30d', '30 days']].map(([k, l]) => '<button class="' + (S.range === k ? 'on' : '') + '" data-act="range" data-v="' + k + '">' + l + '</button>').join('') + '</div>';
  if (!u) return setList(chips + '<div class="empty">Loading…</div>', 'uload');
  const head = '<div class="card"><div class="small mute">Everything · chats, tasks and agents</div><div style="font-size:30px;font-weight:700;letter-spacing:-.02em">' + fmt(u.totals.totalTokens) + ' <span style="font-size:15px;font-weight:600" class="mute">tokens</span></div><div class="small mute">' + u.totals.sessions + ' runs · est. ' + money(u.totals) + '</div></div>';
  const cl = u.clients.map((c) => '<div class="card"><div class="row" style="padding:0;min-height:0"><div class="grow"><h3>' + esc(c.label) + '</h3><div class="small mute">' + fmt(c.totalTokens) + ' tokens · ' + c.sessions + ' runs</div></div><b>' + money(c) + '</b></div>'
    + (c.limits || []).map((l) => { const used = l.usedPercent !== undefined ? l.usedPercent : l.remainingPercent !== undefined ? 100 - l.remainingPercent : null; return used === null ? '' : '<div class="small" style="margin-top:10px">' + esc(l.label || l.kind) + ' <span class="mute">· ' + Math.round(used) + '% used' + (l.resetsAt ? ' · resets ' + new Date(l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '') + '</span></div>' + bar(used); }).join('')
    + (!(c.limits || []).length && c.limitStatus ? '<div class="small mute" style="margin-top:8px">' + esc(c.limitStatus.message || '') + '</div>' : '') + '</div>').join('');
  const proj = u.byProject.length ? '<div class="sec">By project</div><div class="group">' + u.byProject.slice(0, 8).map((p) => '<div class="row" style="min-height:52px"><div class="grow"><div class="t">' + esc(p.label) + '</div><div class="m">' + fmt(p.totalTokens) + ' tokens</div></div><b>' + money(p) + '</b></div>').join('') + '</div>' : '';
  setList(chips + head + cl + proj, JSON.stringify([u, S.range]));
}
function paintMore() {
  const proj = S.projects.map((p) => '<div class="row" data-act="project" data-id="' + p.id + '"><span class="av sm" style="background:var(--fill);color:var(--mute)">' + ICON.folder.replace('<svg', '<svg style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8"') + '</span><div class="grow"><div class="t">' + esc(p.name) + '</div></div></div>').join('');
  setList('<div class="group"><div class="row" data-act="usage"><span class="av sm" style="background:var(--fill);color:var(--mute)">' + ICON.usage.replace('<svg', '<svg style="width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8"') + '</span><div class="grow"><div class="t">Usage</div><div class="m">Tokens, cost and limits across chats, tasks and agents</div></div></div></div>' + (proj ? '<div class="sec">Projects</div><div class="group">' + proj + '</div>' : '') + '<div class="sec">This phone</div><div class="group"><div class="row" data-act="signout"><div class="grow"><div class="t" style="color:var(--bad)">Sign out</div><div class="m">Scan the QR code again to reconnect.</div></div></div></div><p class="small mute" style="margin:14px 6px">Connected to your Mac through a private tunnel. Turn it off from Control on phone on your Mac.</p>', JSON.stringify([S.projects]));
}

// ---- data loading ----------------------------------------------------------------------------
async function refresh() {
  if (!token || document.hidden) return;
  try {
    if (S.view.t === 'thread') return await refreshThread();
    if (S.view.t === 'chat') return await refreshChat();
    if (S.view.t === 'usage') { S.usage = await rpc('usage.summary', { range: S.range }); return paintUsage(); }
    if (S.view.t === 'group') return await refreshGroup();
    if (S.view.t === 'project') return await refreshProject();
    const [work, agents, groupInfo] = await Promise.all([api('/api/work', S.project ? { workspaceId: S.project } : {}), rpc('agents.sandbox.list'), rpc('agents.group.list')]);
    S.work = work; S.agents = agents; S.groups = Array.isArray(groupInfo) ? groupInfo : (groupInfo.groups || []);
    if (S.tab === 'inbox') { [S.approvals, S.questions] = await Promise.all([rpc('approval.list'), rpc('question.list')]); S.approvals = S.approvals.filter((a) => a.status === 'pending'); S.questions = S.questions.filter((q) => q.status === 'pending'); }
    if (S.tab === 'chat') S.chats = (await rpc('chat.list')).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (S.tab === 'more' || !S.projects.length) S.projects = await rpc('workspace.list');
    if (S.view.t === 'tab' && !swiping) { updateTabBadge(); paintList(); }
  } catch (e) { if (!S.err) { S.err = true; toast(e.message); setTimeout(() => { S.err = false; }, 8000); } }
}
function updateTabBadge() { const tb = $('.tabs'); if (tb) tb.outerHTML = tabBar(); }
setInterval(() => { if (!sheetEl) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---- thread view (Work threads and agent chats) -------------------------------------------------------
const agentById = (id) => S.agents.find((a) => a.id === id);
function cliName(id) { return (S.cli.find((c) => c.id === id) || {}).name || id; }
const stick = (agentId) => { try { return JSON.parse(ls.get('cp.pick.' + agentId) || '{}'); } catch { return {}; } };
function pickState() {
  const v = S.view;
  if (v.t === 'chat') { const st = stick('chat'); return { cli: st.cli || '', model: st.model || '', effort: st.effort || '' }; }
  if (v.agentId) { const st = stick(v.agentId); return { cli: st.cli || '', model: st.model || '', effort: st.effort || '' }; }
  return v.pick || { cli: '', model: '', effort: '' };
}
function setPick(p) { if (S.view.t === 'chat') ls.set('cp.pick.chat', JSON.stringify(p)); else if (S.view.agentId) ls.set('cp.pick.' + S.view.agentId, JSON.stringify(p)); else S.view.pick = p; }

function paintThreadShell() {
  const v = S.view; const a = v.agentId ? agentById(v.agentId) : null;
  const title = a ? a.name : (v.title || (v.t === 'chat' ? 'New chat' : 'Thread'));
  const lead = a ? avatar(a, undefined, true) : '';
  const buttons = (a ? '<button class="ib" data-act="watch" aria-label="Watch the sandbox">' + ICON.eye + '</button><button class="ib" data-act="chats" aria-label="Chats">' + ICON.clock + '</button>' : '');
  app.innerHTML = '<div class="screen"><header class="bar compact"><button class="ib" data-act="back" aria-label="Back">' + ICON.back + '</button>' + lead + '<div style="min-width:0;flex:1"><h2>' + esc(title) + '</h2><div class="sub" id="sub"></div></div>' + buttons + '</header>'
    + '<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column"><div class="chat" id="chat"></div><button class="jump" id="jump" data-act="jump" aria-label="Jump to latest">' + ICON.down + '</button></div>'
    + composerHtml() + '</div>';
  wireComposer();
  $('#chat').addEventListener('scroll', onChatScroll, { passive: true });
  S.chat = null; refresh();
}
function composerHtml() {
  const v = S.view; const p = pickState();
  const a = v.agentId ? agentById(v.agentId) : null;
  const clis = a ? a.clis : S.cli.filter((c) => c.available && !c.remote).map((c) => c.id);
  const chips = '<div class="chips"><button class="chip ' + (p.cli ? 'on' : '') + '" data-act="pickcli">' + ICON.cpu + '<span>' + esc(p.cli ? cliName(p.cli) : 'Auto CLI') + '</span></button>'
    + (p.cli ? '<button class="chip ' + (p.model ? 'on' : '') + '" data-act="pickmodel"><span>' + esc(p.model ? p.modelLabel || p.model : 'Auto model') + '</span></button>' : '') + '</div>';
  void clis;
  const draft = S.drafts[draftKey()] || { text: '', atts: [] };
  return '<div class="composer">' + chips + '<div class="atts" id="atts">' + attChips(draft.atts) + '</div><div class="inputrow"><button class="ib" data-act="attach" aria-label="Attach">' + ICON.clip + '</button><textarea id="ta" rows="1" placeholder="' + esc(a ? 'Message ' + a.name : 'Message') + '" enterkeyhint="send">' + esc(draft.text) + '</textarea><button class="send" id="send" data-act="send" aria-label="Send">' + ICON.send + '</button></div><input id="file" type="file" multiple hidden></div>';
}
const attChips = (atts) => atts.map((x, i) => '<div class="att"><span>' + esc(x.name) + (x.busy ? ' …' : '') + '</span><button data-act="rmatt" data-i="' + i + '" aria-label="Remove">×</button></div>').join('');
function draftKey() { return S.view.t + ':' + (S.view.agentId || '') + ':' + (S.view.key || S.view.id || 'new'); }
function draft() { return (S.drafts[draftKey()] ||= { text: '', atts: [] }); }
function wireComposer() {
  const ta = $('#ta'); if (!ta) return;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
  ta.addEventListener('input', () => { draft().text = ta.value; grow(); syncSend(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover:hover)').matches) { e.preventDefault(); send(); } });
  $('#file').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      const d = draft(); const item = { name: f.name || 'photo', busy: true }; d.atts.push(item); $('#atts').innerHTML = attChips(d.atts);
      try { const ref = await upload(f); item.id = ref.id; item.name = ref.name || item.name; } catch (err) { d.atts.splice(d.atts.indexOf(item), 1); fail(err); }
      item.busy = false; const el = $('#atts'); if (el) el.innerHTML = attChips(draft().atts); syncSend();
    }
  });
  grow(); syncSend();
}
function syncSend() {
  const b = $('#send'); if (!b) return;
  const d = draft(); const working = S.chat?.working;
  const has = d.text.trim() !== '' && !d.atts.some((x) => x.busy);
  if (working && !has) { b.className = 'send stop'; b.innerHTML = ICON.stop; b.dataset.mode = 'stop'; b.disabled = false; b.setAttribute('aria-label', 'Stop'); }
  else { b.className = 'send'; b.innerHTML = ICON.send; b.dataset.mode = 'send'; b.disabled = !has; b.setAttribute('aria-label', 'Send'); }
}
let atBottom = true;
function onChatScroll() { const c = $('#chat'); atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 80; $('#jump')?.classList.toggle('show', !atBottom); }

async function refreshThread() {
  const v = S.view;
  if (!v.key) { paintChat({ turns: [], workspaceId: null }); return; }
  const data = await post('/api/thread', { threadId: v.key }).then((j) => j.value);
  if (S.view !== v) return;
  paintChat(data);
}
function paintChat(data) {
  const last = data.turns[data.turns.length - 1];
  S.chat = { working: !!last && last.working, lastId: last?.id, workspaceId: data.workspaceId };
  const a = S.view.agentId ? agentById(S.view.agentId) : null;
  const sub = $('#sub'); if (sub) sub.textContent = last?.working ? (last.activity || 'Working…') : (a ? a.clis.map(cliName).join(' → ') : '');
  const msgs = data.turns.flatMap((t) => t.messages).map((m) => m.role === 'user' ? '<div class="me">' + esc(m.text) + '</div>' : m.role === 'error' ? '<div class="er">' + esc(m.text) + '</div>' : '<div class="ag">' + md(m.text) + '</div>').join('');
  const live = last?.working ? '<div class="live"><i></i><span>' + esc(last.activity || 'Thinking…') + '</span></div>' : '';
  const empty = !data.turns.length ? '<div class="empty" style="margin:auto">' + (a ? avatar(a, undefined) + '<br><br><b>' + esc(a.name) + '</b>' + esc(a.description || 'Send a message to start.') : 'Send a message to start.') + '</div>' : '';
  const html = msgs + live + empty;
  const c = $('#chat'); if (!c) return;
  const sig = html;
  if (S.sig.chat !== sig) { S.sig.chat = sig; c.innerHTML = html; if (atBottom) c.scrollTop = c.scrollHeight; }
  syncSend();
}

function pickerOptions() {
  const v = S.view; const a = v.agentId ? agentById(v.agentId) : null;
  return (a ? a.clis : S.cli.filter((c) => c.available && !c.remote).map((c) => c.id)).filter((id) => S.cli.some((c) => c.id === id) || true);
}
async function send() {
  if (S.view.t === 'chat') return sendChat();
  const d = draft(); const text = d.text.trim(); const v = S.view;
  const b = $('#send');
  if (b && b.dataset.mode === 'stop' && !text) { try { await rpc('task.cancel', { id: S.chat.lastId }); buzz(); refresh(); } catch (e) { fail(e); } return; }
  if (!text || d.atts.some((x) => x.busy)) return;
  const attachmentIds = d.atts.filter((x) => x.id).map((x) => x.id);
  const p = pickState();
  const choice = p.cli && (p.model || p.effort) ? { runOptions: { main: { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) } } } : {};
  const common = { objective: text, ...(attachmentIds.length ? { attachmentIds } : {}), ...(p.cli ? { agentId: p.cli } : {}), ...choice };
  const key = draftKey();
  b.disabled = true;
  try {
    if (S.chat?.working) await rpc('task.enqueue', { taskId: S.chat.lastId, mode: 'queue', ...common });
    else if (v.key && S.chat?.lastId) await rpc('task.create', { workspaceId: S.chat.workspaceId, parentTaskId: S.chat.lastId, ...common });
    else if (v.agentId) {
      const ws = await rpc('agents.workspace'); const project = v.projectId;
      const t = await rpc('task.create', { workspaceId: project || ws, sandboxAgentId: v.agentId, ...common });
      v.key = t.threadId || t.id;
    } else {
      const t = await rpc('task.create', { workspaceId: v.workspaceId, ...common });
      v.key = t.threadId || t.id;
    }
    delete S.drafts[key]; const ta = $('#ta'); if (ta) { ta.value = ''; ta.style.height = 'auto'; } const at = $('#atts'); if (at) at.innerHTML = '';
    atBottom = true; buzz(); syncSend(); setTimeout(refresh, 400); refresh();
  } catch (e) { fail(e); syncSend(); }
}

// ---- Chat (conversations that aren't tied to a project) ------------------------------------------------
async function refreshChat() {
  const v = S.view;
  if (!v.id) { S.chat = { working: false }; return paintMessages([], false); }
  const conv = await rpc('chat.get', { threadId: v.id });
  if (S.view !== v) return;
  v.title = conv.thread.title;
  const h = $('header h2'); if (h) h.textContent = conv.thread.title;
  const last = conv.messages[conv.messages.length - 1];
  const working = !!last && last.role === 'assistant' && last.status === 'streaming';
  S.chat = { working };
  const running = working ? (last.activity || []).filter((x) => x.status === 'running').pop() : null;
  const sub = $('#sub'); if (sub) sub.textContent = working ? (running ? running.label : 'Thinking…') : '';
  const msgs = conv.messages.filter((m) => m.role === 'user' || m.content || m.error).map((m) => m.role === 'user' ? { role: 'user', text: m.content } : m.status === 'failed' || m.error ? { role: 'error', text: m.error || m.content || 'Failed' } : { role: 'agent', text: m.content });
  paintMessages(msgs, working, running ? running.label : 'Thinking…');
}
function paintMessages(msgs, working, label) {
  const html = msgs.map((m) => m.role === 'user' ? '<div class="me">' + esc(m.text) + '</div>' : m.role === 'error' ? '<div class="er">' + esc(m.text) + '</div>' : '<div class="ag">' + md(m.text) + '</div>').join('')
    + (working && !msgs.some((m) => m.role === 'agent') ? '<div class="live"><i></i><span>' + esc(label || 'Thinking…') + '</span></div>' : '')
    + (!msgs.length ? '<div class="empty" style="margin:auto"><b>New chat</b>Ask anything. Chats aren’t tied to a project.</div>' : '');
  const c = $('#chat'); if (c && S.sig.chat !== html) { S.sig.chat = html; c.innerHTML = html; if (atBottom) c.scrollTop = c.scrollHeight; }
  syncSend();
}
async function sendChat() {
  const d = draft(); const text = d.text.trim(); const v = S.view; const b = $('#send');
  if (b && b.dataset.mode === 'stop' && !text) { try { await rpc('chat.cancel', { threadId: v.id }); buzz(); refresh(); } catch (e) { fail(e); } return; }
  if (!text || d.atts.some((x) => x.busy)) return;
  const p = pickState(); const key = draftKey(); const ids = d.atts.filter((x) => x.id).map((x) => x.id);
  b.disabled = true;
  try {
    const conv = await rpc('chat.send', { ...(v.id ? { threadId: v.id } : {}), content: text, ...(p.cli ? { agentId: p.cli } : {}), ...(p.cli && (p.model || p.effort) ? { runOptions: { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) } } : {}), ...(ids.length ? { attachments: ids } : {}) });
    v.id = conv.thread.id; delete S.drafts[key];
    const ta = $('#ta'); if (ta) { ta.value = ''; ta.style.height = 'auto'; } const at = $('#atts'); if (at) at.innerHTML = '';
    atBottom = true; buzz(); S.chat = { working: true }; refresh();
  } catch (e) { fail(e); syncSend(); }
}
function pickFilter() {
  const opts = [{ id: '', name: 'All projects' }, ...S.projects];
  sheet('Project', opts.map((p) => '<button class="opt" data-p="' + esc(p.id) + '"><div class="grow">' + esc(p.name) + '</div><span class="ck">' + (S.project === p.id ? '✓' : '') + '</span></button>').join(''), (el) => {
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; S.project = b.dataset.p; ls.set('cp.filter', S.project); S.work = null; S.sig = {}; closeSheet(); paint(); refresh(); });
  });
}

// ---- pickers ----------------------------------------------------------------------------------------------
async function pickCli() {
  const v = S.view; const p = pickState(); const a = v.agentId ? agentById(v.agentId) : null;
  const ids = a ? a.clis : S.cli.filter((c) => c.available && !c.remote).map((c) => c.id);
  const opts = [{ id: '', name: 'Auto', sub: a ? 'Use the first available, falling back in order' : 'Conductor picks the best available' }, ...ids.map((id) => ({ id, name: cliName(id), sub: (S.cli.find((c) => c.id === id) || {}).available === false ? 'Not available' : '' }))];
  sheet('Run on', opts.map((o) => '<button class="opt" data-pick="' + esc(o.id) + '"><div class="grow"><div>' + esc(o.name) + '</div>' + (o.sub ? '<div class="m">' + esc(o.sub) + '</div>' : '') + '</div><span class="ck">' + (p.cli === o.id ? '✓' : '') + '</span></button>').join(''), (el) => {
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; setPick({ cli: b.dataset.pick, model: '', effort: '' }); closeSheet(); reComposer(); });
  });
}
async function pickModel() {
  const p = pickState(); if (!p.cli) return;
  let cat; try { cat = await rpc('agents.models', { agentId: p.cli }); } catch (e) { return fail(e); }
  const models = cat.models || [];
  const tier = (m) => m.tier === 'economy' ? 'Cheaper' : m.tier === 'premium' ? 'Most capable' : '';
  const effortRow = (list, cur) => list && list.length ? '<div class="sec" style="margin-top:8px">Effort</div><div class="seg" id="eff"><button class="' + (!cur ? 'on' : '') + '" data-eff="">Auto</button>' + list.map((x) => '<button class="' + (cur === x ? 'on' : '') + '" data-eff="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>' : '';
  const cur = models.find((m) => m.id === p.model);
  const efforts = p.model ? (cur?.efforts || []) : (cat.efforts || []);
  sheet('Model · ' + cliName(p.cli), '<button class="opt" data-m=""><div class="grow"><div>Auto model</div><div class="m">Cheaper for quick requests</div></div><span class="ck">' + (!p.model ? '✓' : '') + '</span></button>'
    + models.map((m) => '<button class="opt" data-m="' + esc(m.id) + '" data-l="' + esc(m.label) + '"><div class="grow"><div>' + esc(m.label) + '</div>' + (tier(m) ? '<div class="m">' + tier(m) + '</div>' : '') + '</div><span class="ck">' + (p.model === m.id ? '✓' : '') + '</span></button>').join('')
    + effortRow(efforts, p.effort), (el) => {
    el.addEventListener('click', (e) => {
      const mb = e.target.closest('[data-m]'); const eb = e.target.closest('[data-eff]');
      if (mb) { setPick({ ...p, model: mb.dataset.m, modelLabel: mb.dataset.l || '', effort: '' }); closeSheet(); reComposer(); }
      else if (eb) { setPick({ ...pickState(), effort: eb.dataset.eff }); closeSheet(); reComposer(); }
    });
  });
}
function reComposer() { const c = $('.composer'); if (!c) return; const keep = draft(); c.outerHTML = composerHtml(); void keep; wireComposer(); }

// ---- group chat ---------------------------------------------------------------------------------------------------
function paintGroupShell() {
  const g = S.groups.find((x) => x.id === S.view.id);
  if (!g) { S.view = { t: 'tab' }; return paint(); }
  const members = g.agentIds.map(agentById).filter(Boolean);
  app.innerHTML = '<div class="screen"><header class="bar compact"><button class="ib" data-act="back" aria-label="Back">' + ICON.back + '</button><div style="min-width:0;flex:1"><h2>' + esc(g.name) + '</h2><div class="sub">' + members.map((m) => esc(m.name)).join(', ') + '</div></div></header>'
    + '<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column"><div class="chat" id="chat"></div></div>'
    + '<div class="composer"><div class="chips" id="targets"></div><div class="atts" id="atts"></div><div class="inputrow"><button class="ib" data-act="attach" aria-label="Attach">' + ICON.clip + '</button><textarea id="ta" rows="1" placeholder="Message the group"></textarea><button class="send" id="send" data-act="gsend" aria-label="Send">' + ICON.send + '</button></div><input id="file" type="file" multiple hidden></div></div>';
  S.view.targets ||= [];
  paintTargets(members); S.view.key = 'g:' + g.id; wireComposer(); $('#send').dataset.mode = 'send'; refresh();
}
function paintTargets(members) {
  const el = $('#targets'); if (!el) return;
  el.innerHTML = '<button class="chip ' + (S.view.targets.length ? '' : 'on') + '" data-act="gall"><span>Everyone</span></button>' + members.map((m) => '<button class="chip ' + (S.view.targets.includes(m.id) ? 'on' : '') + '" data-act="gt" data-id="' + m.id + '"><span>@' + esc(m.name) + '</span></button>').join('');
}
async function refreshGroup() {
  const g = S.groups.find((x) => x.id === S.view.id); if (!g) return;
  const msgs = await rpc('agents.group.messages', { groupId: g.id });
  const parts = [];
  for (const m of msgs) {
    parts.push('<div class="me">' + esc(m.text) + '</div>');
    for (const [agentId, taskId] of Object.entries(m.replies)) {
      const a = agentById(agentId); const turn = await api('/api/task', { id: taskId });
      if (!turn) continue;
      const body = turn.messages.filter((x) => x.role !== 'user').map((x) => x.role === 'error' ? '<div class="er">' + esc(x.text) + '</div>' : '<div class="ag">' + md(x.text) + '</div>').join('') || (turn.working ? '' : '<div class="ag mute">No reply.</div>');
      parts.push('<div class="who">' + esc(a ? a.name : 'Agent') + '</div>' + body + (turn.working ? '<div class="live"><i></i><span>' + esc(turn.activity || 'Thinking…') + '</span></div>' : ''));
    }
  }
  const html = parts.join('') || '<div class="empty" style="margin:auto"><b>' + esc(g.name) + '</b>Message everyone, or tap names to ask specific agents.</div>';
  const c = $('#chat'); if (c && S.sig.chat !== html) { S.sig.chat = html; c.innerHTML = html; if (atBottom) c.scrollTop = c.scrollHeight; }
}
async function gsend() {
  const d = draft(); const text = d.text.trim(); if (!text) return;
  const g = S.groups.find((x) => x.id === S.view.id);
  try {
    const ws = await rpc('agents.workspace');
    await rpc('agents.group.send', { groupId: g.id, workspaceId: ws, text, ...(S.view.targets.length ? { agentIds: S.view.targets } : {}), ...(d.atts.some((x) => x.id) ? { attachmentIds: d.atts.filter((x) => x.id).map((x) => x.id) } : {}) });
    delete S.drafts[draftKey()]; const ta = $('#ta'); ta.value = ''; ta.style.height = 'auto'; $('#atts').innerHTML = ''; atBottom = true; buzz(); syncSend(); refresh();
  } catch (e) { fail(e); }
}

// ---- projects, new task -----------------------------------------------------------------------------------------------
function paintProjectShell() {
  const p = S.projects.find((x) => x.id === S.view.id);
  app.innerHTML = '<div class="screen"><header class="bar compact"><button class="ib" data-act="back" aria-label="Back">' + ICON.back + '</button><h2 style="flex:1">' + esc(p ? p.name : 'Project') + '</h2><button class="ib" data-act="newtask" data-p="' + esc(S.view.id) + '" aria-label="New task">' + ICON.plus + '</button></header><div class="scroller"><div id="list"></div></div></div>';
  refresh();
}
async function refreshProject() {
  const tasks = await rpc('task.list', { workspaceId: S.view.id, limit: 100 });
  const roots = tasks.filter((t) => !t.parentTaskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  setList(roots.length ? '<div class="group">' + roots.map((t) => '<div class="row" data-act="thread" data-k="' + esc(t.threadId || t.id) + '"><span class="dot ' + tone(t.state) + '"></span><div class="grow"><div class="t">' + esc((t.title || t.objective || '').split('\n')[0].slice(0, 100)) + '</div><div class="m">' + ago(t.updatedAt) + '</div></div></div>').join('') + '</div>' : '<div class="empty"><b>No tasks in this project</b>Start one with the + button.</div>', JSON.stringify(roots));
}
async function newTask(projectId) {
  let projects = S.projects; if (!projects.length) { try { projects = S.projects = await rpc('workspace.list'); } catch (e) { return fail(e); } }
  if (!projects.length) return toast('Add a project on your Mac first.');
  const sel = projectId || ls.get('cp.project') || projects[0].id;
  open({ t: 'thread', key: null, title: 'New task', workspaceId: sel, pick: { cli: '', model: '', effort: '' }, fresh: true });
  setTimeout(() => {
    const sub = $('#sub'); if (sub) sub.innerHTML = '<button class="chip" data-act="pickproject" style="height:24px;padding:0 8px;font-size:12px"><span>' + esc((projects.find((p) => p.id === sel) || projects[0]).name) + '</span></button>';
  }, 0);
}
function pickProject() {
  sheet('Project', S.projects.map((p) => '<button class="opt" data-p="' + p.id + '"><div class="grow">' + esc(p.name) + '</div><span class="ck">' + (S.view.workspaceId === p.id ? '✓' : '') + '</span></button>').join(''), (el) => {
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; S.view.workspaceId = b.dataset.p; ls.set('cp.project', b.dataset.p); closeSheet(); const p = S.projects.find((x) => x.id === b.dataset.p); $('#sub').innerHTML = '<button class="chip" data-act="pickproject" style="height:24px;padding:0 8px;font-size:12px"><span>' + esc(p.name) + '</span></button>'; });
  });
}

// ---- thread actions ----------------------------------------------------------------------------------------------------------
async function watch() {
  const id = S.view.agentId; if (!id) return;
  let r; try { r = await api('/api/watch', { agentId: id }); } catch (e) { return fail(e); }
  const a = agentById(id);
  const el = document.createElement('div'); el.className = 'watch';
  el.innerHTML = '<header><button class="ib" data-act="unwatch" aria-label="Close" style="color:#fff">' + ICON.x + '</button><b>' + esc(a ? a.name : 'Agent') + ' · live</b></header><iframe title="Live sandbox" src="' + esc(r.src) + '" allow="clipboard-read; clipboard-write"></iframe><div class="note">Tap and drag on the screen to take over.</div>';
  document.body.appendChild(el);
}
async function chatsSheet() {
  const id = S.view.agentId; const mine = (S.work?.agentChats ?? []).filter((c) => c.agentId === id);
  sheet('Chats', '<button class="opt" data-new="1"><span class="ck" style="font-size:20px">+</span><div class="grow">New chat</div></button>' + mine.map((c) => '<button class="opt" data-k="' + esc(c.key) + '"><span class="dot ' + tone(c.state) + '"></span><div class="grow"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.title) + '</div><div class="m">' + ago(c.updatedAt) + '</div></div></button>').join(''), (el) => {
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; closeSheet(); if (b.dataset.new) { S.view.key = null; S.view.title = ''; S.sig = {}; paint(); } else if (b.dataset.k) { S.view.key = b.dataset.k; S.sig = {}; paint(); } });
  });
}
function snoozeSheet(key) {
  const at = (fn) => { const d = new Date(); fn(d); return d.toISOString(); };
  const opts = [['In 1 hour', () => at((d) => d.setHours(d.getHours() + 1))], ['Later today', () => at((d) => { d.setHours(18, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1), d.setHours(9, 0, 0, 0); })], ['Tomorrow morning', () => at((d) => { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); })], ['Next week', () => at((d) => { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); })], ['Until I wake it', () => undefined]];
  sheet('Snooze', opts.map(([l], i) => '<button class="opt" data-i="' + i + '"><div class="grow">' + l + '</div></button>').join(''), (el) => {
    el.addEventListener('click', async (e) => { const b = e.target.closest('[data-i]'); if (!b) return; closeSheet(); try { await api('/api/tier', { key, action: 'snooze', until: opts[b.dataset.i][1]() }); buzz(); refresh(); } catch (err) { fail(err); } });
  });
}

// ---- gestures -------------------------------------------------------------------------------------------------------------------------
let swiping = false;
(function gestures() {
  let row = null, fg = null, x0 = 0, y0 = 0, dx = 0, lock = null, w = 0;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || sheetEl) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; lock = null;
    row = e.target.closest?.('.swipe') || null; fg = row ? $('.fg', row) : null; w = row ? row.offsetWidth : 0;
    S.edge = x0 < 24 && S.view.t !== 'tab'; S.pull = false;
    const sc = $('#scroller'); if (sc && sc.scrollTop <= 0 && !row) S.pull = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; const mx = t.clientX - x0, my = t.clientY - y0;
    if (!lock) { if (Math.abs(mx) > 10 || Math.abs(my) > 10) lock = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y'; else return; }
    if (lock === 'x' && fg) {
      const l = row.dataset.l, r = row.dataset.r;
      dx = Math.max(l ? -w : 0, Math.min(r ? w : 0, mx));
      swiping = true; fg.classList.remove('snap'); fg.style.transform = 'translateX(' + dx + 'px)';
      const under = $('.under', row); const col = dx < 0 ? row.dataset.lc : row.dataset.rc;
      under.style.background = Math.abs(dx) > 8 ? col : 'transparent';
      under.children[0].style.visibility = dx > 0 ? 'visible' : 'hidden'; under.children[1].style.visibility = dx < 0 ? 'visible' : 'hidden';
    } else if (lock === 'y' && S.pull && my > 0) {
      const p = $('#ptr'); if (p) { p.style.height = Math.min(my / 2.2, 56) + 'px'; p.textContent = my > 130 ? 'Release to refresh' : 'Pull to refresh'; S.pullY = my; }
    }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const mx = e.changedTouches[0].clientX - x0;
    if (fg && swiping) {
      const commit = Math.abs(dx) > Math.min(w * 0.38, 150);
      fg.classList.add('snap');
      if (commit) {
        const act = dx < 0 ? row.dataset.l : row.dataset.r; fg.style.transform = 'translateX(' + (dx < 0 ? -w : w) + 'px)'; buzz(12);
        const key = row.dataset.key; ls.set('cp.hint', '1'); ls.set('cp.hint2', '1');
        setTimeout(() => rowAction(act, key), 120);
      } else { fg.style.transform = ''; }
      setTimeout(() => { swiping = false; }, 200);
      e.preventDefault?.(); S.noClick = Date.now();
    } else if (S.edge && lock === 'x' && mx > 90) { back(); }
    else if (S.pull && lock === 'y' && (S.pullY || 0) > 130) { buzz(); refresh(); }
    else if (lock === 'x' && !fg && Math.abs(mx) > 90 && S.view.t === 'tab' && !e.target.closest?.('input,textarea,.chips,.seg')) {
      const i = TABS.indexOf(S.tab) + (mx < 0 ? 1 : -1); if (TABS[i]) setTab(TABS[i]);
    }
    const p = $('#ptr'); if (p) { p.style.height = '0'; p.textContent = ''; } S.pullY = 0; row = fg = null; lock = null;
  });
})();
async function rowAction(act, key) {
  try {
    if (act === 'settle') { await api('/api/tier', { key, action: 'settle' }); toast('Settled'); }
    else if (act === 'restore') { await api('/api/tier', { key, action: 'clear' }); toast('Restored'); }
    else if (act === 'snooze') { snoozeSheet(key); S.sig = {}; paintList(); return; }
    else if (act === 'approve' || act === 'deny') { await rpc('approval.resolve', { approvalId: key, decision: act === 'approve' ? 'approved' : 'denied' }); toast(act === 'approve' ? 'Approved' : 'Denied'); S.approvals = S.approvals.filter((a) => a.id !== key); }
    S.sig = {}; refresh();
  } catch (e) { fail(e); S.sig = {}; paintList(); }
}

// ---- clicks ------------------------------------------------------------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  if (S.noClick && Date.now() - S.noClick < 350) return;
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'tab': return setTab(el.dataset.v);
      case 'back': return back();
      case 'sec': S.shut[el.dataset.v] = !S.shut[el.dataset.v]; S.sig = {}; return paintList();
      case 'thread': { const k = el.dataset.k; const w = [...(S.work?.groups ?? []).flatMap((g) => g.threads), ...(S.work?.agentChats ?? [])].find((t) => t.key === k); return open({ t: 'thread', key: k, title: w?.title || 'Thread' }); }
      case 'agent': { const a = agentById(el.dataset.id); const chats = (S.work?.agentChats ?? []).filter((c) => c.agentId === a.id); return open({ t: 'thread', key: chats[0]?.key || null, agentId: a.id, title: a.name }); }
      case 'group': return open({ t: 'group', id: el.dataset.id });
      case 'project': return open({ t: 'project', id: el.dataset.id });
      case 'newtask': return newTask(el.dataset.p || S.project || undefined);
      case 'filter': return pickFilter();
      case 'chat': return open({ t: 'chat', id: el.dataset.id, title: (S.chats.find((c) => c.id === el.dataset.id) || {}).title || 'Chat' });
      case 'newchat': return open({ t: 'chat', id: null, title: 'New chat' });
      case 'usage': return open({ t: 'usage' });
      case 'pickproject': return pickProject();
      case 'newgroup': return newGroup();
      case 'send': return send();
      case 'gsend': return gsend();
      case 'attach': return $('#file').click();
      case 'rmatt': draft().atts.splice(+el.dataset.i, 1); $('#atts').innerHTML = attChips(draft().atts); return syncSend();
      case 'pickcli': return pickCli();
      case 'pickmodel': return pickModel();
      case 'watch': return watch();
      case 'unwatch': $('.watch')?.remove(); return;
      case 'chats': return chatsSheet();
      case 'jump': { const c = $('#chat'); c.scrollTop = c.scrollHeight; return; }
      case 'range': S.range = el.dataset.v; S.usage = null; S.sig = {}; paintList(); return refresh();
      case 'approve': case 'deny': return rowAction(act, el.dataset.id);
      case 'answer': { await rpc('question.answer', { id: el.dataset.id, answers: { [el.dataset.q]: [el.dataset.o] } }); buzz(); S.questions = S.questions.filter((q) => q.id !== el.dataset.id); S.sig = {}; paintList(); return refresh(); }
      case 'gall': S.view.targets = []; return paintTargets(S.groups.find((g) => g.id === S.view.id).agentIds.map(agentById).filter(Boolean));
      case 'gt': { const t = S.view.targets; const i = t.indexOf(el.dataset.id); if (i >= 0) t.splice(i, 1); else t.push(el.dataset.id); return paintTargets(S.groups.find((g) => g.id === S.view.id).agentIds.map(agentById).filter(Boolean)); }
      case 'signout': token = null; ls.del('conductor.phone'); S.view = { t: 'tab' }; return paint();
    }
  } catch (err) { fail(err); }
});
function newGroup() {
  if (S.agents.length < 2) return toast('You need at least two agents for a group chat.');
  const chosen = new Set();
  sheet('New group chat', S.agents.map((a) => '<button class="opt" data-id="' + a.id + '">' + avatar(a, undefined, true) + '<div class="grow">' + esc(a.name) + '</div><span class="ck"></span></button>').join('') + '<button class="btn block" id="mk" style="margin-top:10px" disabled>Create group</button>', (el) => {
    el.addEventListener('click', async (e) => {
      const o = e.target.closest('.opt'); const mk = e.target.closest('#mk');
      if (o) { const id = o.dataset.id; if (chosen.has(id)) chosen.delete(id); else chosen.add(id); $('.ck', o).textContent = chosen.has(id) ? '✓' : ''; $('#mk', el).disabled = chosen.size < 2; }
      if (mk) { try { const g = await rpc('agents.group.create', { name: '', agentIds: [...chosen] }); closeSheet(); S.groups.unshift(g); open({ t: 'group', id: g.id }); } catch (err) { fail(err); } }
    });
  });
}

// ---- start --------------------------------------------------------------------------------------------------------------------------------------
async function boot() {
  const m = /pair=([0-9a-f]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    try { const j = await post('/api/pair', { code: m[1] }); token = j.token; ls.set('conductor.phone', token); } catch (e) { app.innerHTML = '<div class="screen"><div class="empty" style="margin:auto"><b>Couldn’t connect</b>' + esc(e.message) + '</div></div>'; return; }
  }
  history.replaceState({ d: 0 }, '');
  paint();
  if (token) { try { S.cli = await rpc('agents.list'); } catch { /* names fall back to ids */ } refresh(); }
}
boot();
