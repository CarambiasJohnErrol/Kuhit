// Kuhit: poke people nearby. One kuhit at a time.
// Screens follow the Kuhit Figma file ("MVP screens", sections 1-8), numbered in comments.

import * as geo from './geo.js';
import { openCamera, captureSquare, captureFrame, blurThumb } from './camera.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const S = {
  be: null,
  booting: true,
  user: null,
  account: undefined, // undefined = loading, null = signed in without an account yet
  profile: null,
  loc: { state: 'idle' }, // idle | asking | ok | denied | error
  nearby: null, // null = still looking
  nearbyCell: null,
  inbox: [], sent: [], matches: [], blocks: { ids: [], names: {} },
  limit: { day: 0, count: 0 },
  people: {}, // uid -> public profile (for received kuhits)
  reveal: {}, // uid -> { name, img } after a mutual kuhit
  draft: {}, // sign-up form
  flow: 'signup', // signup | login
  verify: { idType: 'philsys', idImg: null, step: 0 },
  sheet: null,
  kuhitsTab: 'received',
  msgs: { id: null, list: [] },
  err: '', busy: false,
  resendAt: 0,
  introStep: 0,
  pending: null, // a kuhit waiting out its undo window
  phoneTouched: false,
};

const unsubs = [];
let stopNearby = null, stopMsgs = null, stopCam = null, geoWatch = null, lastUpload = null;
let inboxLoaded = false, matchesLoaded = false;

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
function ago(ms) {
  if (!ms) return 'just now';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}
const DAY = 24 * 3600 * 1000;
const me = () => S.user?.uid;
const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const today = () => geo.manilaDay();
const kuhitsLeft = () => Math.max(0, S.be.DAILY_KUHITS - (S.limit.day === today() ? S.limit.count : 0) - (S.pending ? 1 : 0));
const hasSelfie = () => !!S.profile?.selfieAt && Date.now() - S.profile.selfieAt < DAY;
const isVisible = () => hasSelfie() && !!S.profile?.visible;
const matchWith = (uid) => S.matches.find((m) => m.members.includes(uid));
const otherOf = (m) => m.members.find((u) => u !== me());
const tag = (type) => (type === 'crush' ? '<span class="tag tag-crush">CRUSH</span>' : '<span class="tag tag-friendly">FRIENDLY</span>');
const typeName = (type) => (type === 'crush' ? 'Crush' : 'Friendly');

function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('63')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return /^9\d{9}$/.test(d) ? `+63${d}` : null;
}
// Phone: keep only the 10 digits after +63, shown as "917 123 4567".
function phoneDigits(v) {
  const t = String(v || '').trim();
  let d;
  if (t.startsWith('+63')) d = t.slice(3).replace(/\D/g, '');
  else if (t.startsWith('+')) d = ''; // erasing the +63 prefix
  else {
    d = t.replace(/\D/g, '');
    if (d.startsWith('63') && d[2] === '9') d = d.slice(2); // typed or pasted 63917...
    else if (d.startsWith('0')) d = d.slice(1); // typed or pasted 0917...
  }
  return d.slice(0, 10);
}
const fmtPhone = (d) => [d.slice(0, 3), d.slice(3, 6), d.slice(6, 10)].filter(Boolean).join(' ');
// The phone field always reads "+63 917 123 4567", as in the Figma sign-up screen.
const phoneDisplay = (d) => (d ? `+63 ${fmtPhone(d)}` : '');
function phoneHint() {
  const d = S.draft.phone || '';
  if (/^9\d{9}$/.test(d)) return { cls: 'ok', html: `${I.check}Looks good` };
  if (d && d[0] !== '9') return { cls: 'bad', html: `${I.info}PH mobile numbers start with 9, like 917 123 4567.` };
  if (d && S.phoneTouched) return { cls: 'bad', html: `${I.info}That's ${d.length} digit${d.length === 1 ? '' : 's'}. You need 10 after +63.` };
  return { cls: '', html: "We'll send a one-time code." };
}
// Birthday: three small fields (MM / DD / YYYY). The ISO date is set only when it's a real date.
function readBday() {
  const bd = S.draft.bd || '';
  if (bd.length < 8) return { state: 'partial' };
  const m = +bd.slice(0, 2), d = +bd.slice(2, 4), y = +bd.slice(4, 8);
  const thisYear = new Date().getFullYear();
  if (y < 1900 || y > thisYear) return { state: 'year' };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { state: 'date' };
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const age = ageOn(iso);
  if (age < 0) return { state: 'date' };
  return { state: age < 18 ? 'under' : 'ok', iso, age };
}
// "MM / DD / YYYY" mask for the birthday field.
function bdayDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length >= 1 && +d[0] > 1) d = `0${d}`;            // month 2-9 -> 02-09
  if (d.length >= 3 && +d[2] > 3) d = `${d.slice(0, 2)}0${d.slice(2)}`; // day 4-9 -> 04-09
  return d.slice(0, 8);
}
const fmtBday = (d) => [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join(' / ');

function bdayHint() {
  const b = readBday();
  if (b.state === 'ok') return { cls: 'ok', html: `${I.check}You're ${b.age}` };
  if (b.state === 'under') return { cls: 'bad', html: `${I.info}You must be 18 or older to use Kuhit.` };
  if (b.state === 'year') return { cls: 'bad', html: `${I.info}Check the year.` };
  if (b.state === 'date') return { cls: 'bad', html: `${I.info}That date doesn't exist. Check the month and day.` };
  return { cls: '', html: '' };
}
// Time until the daily kuhits reset (midnight, Philippine time).
function resetIn() {
  const now = Date.now();
  const next = (geo.manilaDay(now) + 1) * 86400000 - 8 * 3600000;
  const mins = Math.max(1, Math.ceil((next - now) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
const maskPhone = (p) => (p ? `${p.slice(0, 3)} ${p.slice(3, 6)} *** ${p.slice(-4)}` : '');
function ageOn(birth) {
  if (!birth) return null;
  const [y, m, d] = birth.split('-').map(Number);
  const now = new Date(Date.now() + 8 * 3600000);
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a--;
  return a;
}

// ---------- icons ----------
const ic = (d, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const I = {
  back: ic('<path d="M15 5l-7 7 7 7"/>'),
  close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
  chev: ic('<path d="M9 5l7 7-7 7"/>'),
  pin: ic('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  hand: ic('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5V4a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4.5 16.5a1.6 1.6 0 0 1 2.4-2.1L8 15.5"/>'),
  chat: ic('<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>'),
  user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  eyeOff: ic('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.1 4M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 19 12 19a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  eye: ic('<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7S18 19 12 19 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  heart: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.5s-8-4.9-8-11A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.5c0 6.1-8 11-8 11z" fill="currentColor" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  flag: ic('<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>'),
  send: ic('<path d="M4 12l16-8-6 16-2.5-6.5z"/>'),
  clock: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  ban: ic('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  shield: ic('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  info: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.6v.4"/>'),
  phone: ic('<path d="M5 3.5h3.5l1.8 4.6-2.4 1.5a11 11 0 0 0 6.5 6.5l1.5-2.4 4.6 1.8V19a2 2 0 0 1-2 2A17.5 17.5 0 0 1 3 5.5a2 2 0 0 1 2-2z"/>'),
  people: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.1.7 3.5 2.6 3.5 5.7"/>'),
  bell: ic('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  lock: ic('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  download: ic('<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 20h14"/>'),
  trash: ic('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'),
  logout: ic('<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>'),
  refresh: ic('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  camera: ic('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  id: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-1.6 1.6-2.4 3-2.4s2.5.8 3 2.4M14.5 10h4M14.5 13h3"/>'),
  car: ic('<path d="M5 16V11l2-5h10l2 5v5M3.5 16h17M7 19v-3m10 3v-3"/><circle cx="8" cy="13" r=".6"/><circle cx="16" cy="13" r=".6"/>'),
  school: ic('<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c1.5 1.5 3.4 2.2 5.5 2.2s4-.7 5.5-2.2v-4.5"/>'),
  sparkle: ic('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>'),
};
const LOGO_PATHS = '<path d="M186.389 23.7695L171.265 40.4284"/><path d="M159.136 9.15724L154.862 30.6016"/><path d="M203.559 49.4877L182.626 55.8082"/><path d="M100.942 92.607L128.702 57.187C131.347 53.9296 135.166 51.8415 139.336 51.3727C143.506 50.9039 147.693 52.0919 150.995 54.6807C154.297 57.2695 156.45 61.0519 156.99 65.213C157.531 69.3742 156.414 73.5809 153.882 76.927L123.122 115.987C135.812 121.277 147.352 132.737 143.122 146.487C138.362 161.287 123.122 158.487 116.412 152.487L103.722 139.127L87.8624 156.577C79.9036 165.472 54.2036 163.872 43.0036 155.272C31.8036 146.672 17.9036 127.472 26.5 116.5"/><path d="M26.2023 116.607L61.3723 71.7468C63.1731 69.4513 65.812 67.9653 68.7085 67.6155C71.605 67.2658 74.5218 68.081 76.8173 69.8818C79.1127 71.6826 80.5988 74.3215 80.9485 77.218C81.2983 80.1145 80.4831 83.0313 78.6823 85.3268"/><path d="M70.6622 95.5571L83.6222 79.0271C85.423 76.7303 88.0625 75.243 90.9599 74.8923C93.8574 74.5416 96.7755 75.3563 99.0722 77.1571C101.369 78.9579 102.856 81.5974 103.207 84.4948C103.558 87.3922 102.743 90.3103 100.942 92.6071"/>';
const logoMark = (cls = '') => `<svg class="logo-mark ${cls}" viewBox="10 0 202 172" fill="none" stroke="currentColor" stroke-width="11.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOGO_PATHS}</svg>`;
const tapMarks = '<span class="tapmarks" aria-hidden="true"><i></i><i></i><i></i></span>';

// ---------- routing ----------
const GUEST = ['welcome', 'intro', 'signup', 'otp', 'login'];
const VERIFY = ['face', 'face-failed', 'id', 'scan', 'id-review', 'id-pending', 'verified', 'not-eligible'];
const APP = ['nearby', 'kuhits', 'kuhit', 'sent', 'mutual', 'chats', 'chat', 'me', 'blocked', 'privacy', 'safety', 'selfie', 'status'];
const CAMERA = ['face', 'scan', 'selfie'];
const TABBED = ['nearby', 'kuhits', 'chats', 'me'];

function parseHash() {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || '', arg: decodeURIComponent(arg) };
}
function go(name, arg) {
  const h = `#/${name}${arg ? `/${encodeURIComponent(arg)}` : ''}`;
  if (location.hash === h) render(); else location.hash = h;
}
function guard({ name }) {
  if (!S.user) return GUEST.includes(name) ? null : 'welcome';
  if (S.account === undefined) return null;
  if (!S.account) return name === 'signup' || name === 'otp' ? null : 'signup';
  if (ageOn(S.account.birthdate) !== null && ageOn(S.account.birthdate) < 18) return name === 'not-eligible' ? null : 'not-eligible';
  if (!S.account.verified?.id) {
    if (VERIFY.includes(name)) return null;
    return S.account.verified?.face ? 'id' : 'face';
  }
  if (APP.includes(name) || name === 'verified') return null;
  return hasSelfie() || store.get('kuhit-skip-selfie-intro', false) ? 'nearby' : 'selfie';
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(true); });
}

function render(fromData = false) {
  const r = parseHash();
  if (S.booting || (S.user && S.account === undefined)) { $app.innerHTML = splash(); return; }
  const redirect = guard(r);
  if (redirect) { go(redirect); return; }
  // Camera screens own their <video>; data updates must not rebuild them.
  if (fromData && CAMERA.includes(r.name) && $app.dataset.route === r.name) return;
  if (!CAMERA.includes(r.name) || $app.dataset.route !== r.name) stopCamera();
  if (r.name !== 'chat') stopChat();

  // Keep focus, value and caret in a field across re-renders.
  const a = document.activeElement;
  const keep = a && a.id && $app.contains(a) ? { id: a.id, v: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  const scrollEl = $app.querySelector('.scroll');
  const scrollTop = fromData && scrollEl ? scrollEl.scrollTop : 0;

  const view = (SCREENS[r.name] || SCREENS.welcome)(r.arg);
  const tabbar = TABBED.includes(r.name) ? tabBar(r.name) : '';
  $app.innerHTML = `<div class="screen screen-${r.name}${tabbar ? ' has-tabs' : ''}">${view}</div>${tabbar}${S.sheet ? sheet() : ''}`;
  $app.dataset.route = r.name;

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { if (el.value !== keep.v && 'value' in el) el.value = keep.v; el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text field */ } }
  }
  const sc = $app.querySelector('.scroll');
  if (sc && scrollTop) sc.scrollTop = scrollTop;
  MOUNT[r.name]?.(r.arg, fromData);
}

// ---------- shared pieces ----------
const splash = () => `<div class="splash"><div class="logo-tile">${logoMark()}</div></div>`;
const backBtn = (to) => `<button class="icon-btn back" data-act="back" ${to ? `data-to="${to}"` : ''} aria-label="Back">${I.back}</button>`;
const steps = (n) => `<div class="steps"><div class="steps-label">Step ${n} of 5</div><div class="steps-bar"><i style="width:${n * 20}%"></i></div></div>`;
const errLine = () => (S.err ? `<p class="err" role="alert">${I.info}<span>${esc(S.err)}</span></p>` : '');
const btn = (label, act, cls = 'primary', extra = '') => `<button class="btn btn-${cls}" data-act="${act}" ${extra}>${label}</button>`;
const busy = (label) => (S.busy ? 'Just a sec…' : label);
const toggle = (id, on, act, disabled = false) => `<button class="toggle${on ? ' on' : ''}" role="switch" aria-checked="${on}" id="${id}" data-act="${act}" ${disabled ? 'disabled' : ''}><i></i></button>`;
function avatar(uid, { size = 48, blur = true, img = null } = {}) {
  const src = img || (blur ? (S.people[uid]?.blur || S.nearby?.find((p) => p.uid === uid)?.blur) : S.reveal[uid]?.img);
  const name = S.reveal[uid]?.name;
  if (!blur && !src) return `<span class="ava ava-letter" style="--s:${size}px">${esc((name || '?')[0])}</span>`;
  return `<span class="ava${blur ? ' ava-blur' : ''}" style="--s:${size}px">${src ? `<img src="${esc(src)}" alt="">` : ''}</span>`;
}
const personOf = (uid) => S.nearby?.find((p) => p.uid === uid) || S.people[uid] || null;
function distOf(p) {
  if (!p || p.lat == null || S.loc.state !== 'ok') return null;
  return geo.distanceMeters(S.loc, p);
}
function tabBar(active) {
  const unseen = S.inbox.filter((i) => !i.seen && !matchWith(i.from)).length;
  const reads = store.get('kuhit-read', {});
  const unread = S.matches.filter((m) => m.lastFrom && m.lastFrom !== me() && (m.lastAt || 0) > (reads[m.id] || 0)).length;
  const item = (name, label, icon, badge) => `<a href="#/${name}" class="tab${active === name ? ' active' : ''}"><span class="tab-ic">${icon}${badge ? `<b class="badge">${badge}</b>` : ''}</span>${label}</a>`;
  return `<nav class="tabbar" aria-label="Sections">${item('nearby', 'Nearby', I.pin)}${item('kuhits', 'Kuhits', logoMark('tab-mark'), unseen)}${item('chats', 'Chats', I.chat, unread)}${item('me', 'Me', I.user)}</nav>`;
}
function header(right = '') {
  return `<header class="apphead"><span class="wordmark">kuhit</span>${right}</header>`;
}
function visChip() {
  return isVisible()
    ? `<button class="chip chip-vis" data-act="go" data-to="me"><i class="dot"></i>Visible · ~50m</button>`
    : `<button class="chip chip-invis" data-act="go" data-to="${hasSelfie() ? 'me' : 'selfie'}">${I.eyeOff}Invisible</button>`;
}

function phoneField() {
  const h = phoneHint();
  return `<label class="field${h.cls === 'bad' ? ' bad' : ''}" id="phone-field"><span>Mobile number</span>
    <input id="f-phone" data-model="phone" data-live="1" type="tel" inputmode="numeric" autocomplete="tel" placeholder="+63 9XX XXX XXXX" maxlength="16" aria-describedby="phone-hint" value="${esc(phoneDisplay(S.draft.phone || ''))}">
    <small id="phone-hint" class="hint ${h.cls}">${h.html}</small></label>`;
}
function bdayField() {
  const h = bdayHint();
  return `<label class="field${h.cls === 'bad' ? ' bad' : ''}" id="bd-field"><span>Birthday</span>
    <input id="f-bd" data-model="bd" data-live="1" type="text" inputmode="numeric" autocomplete="bday" placeholder="MM / DD / YYYY" maxlength="14" aria-describedby="bd-hint" value="${esc(fmtBday(S.draft.bd || ''))}">
    <small id="bd-hint" class="hint ${h.cls}">${h.html}</small></label>`;
}
function signupOk() {
  const d = S.draft;
  const phoneOk = !!S.user || !!normalizePhone(d.phone);
  return phoneOk && readBday().state === 'ok' && (d.name || '').trim().length > 0;
}
// Update hints and buttons in place while typing, so fields never lose focus or caret.
function refreshLive() {
  const set = (fieldId, hintId, h) => {
    const f = document.getElementById(fieldId), el = document.getElementById(hintId);
    if (f) f.classList.toggle('bad', h.cls === 'bad');
    if (el) { el.className = `hint ${h.cls}`; el.innerHTML = h.html; }
  };
  set('phone-field', 'phone-hint', phoneHint());
  set('bd-field', 'bd-hint', bdayHint());
  const c = document.querySelector('[data-act="signup-continue"]');
  if (c) c.disabled = !signupOk() || S.busy;
  const l = document.querySelector('[data-act="login-send"]');
  if (l) l.disabled = !normalizePhone(S.draft.phone) || S.busy;
  const e = document.querySelector('.err'); if (e && !S.err) e.remove();
}

// ---------- screens ----------
const SCREENS = {
  // 01 Welcome
  welcome: () => `
    <div class="pad center-col welcome">
      <div class="grow center-col">
        <div class="logo-tile big">${logoMark()}</div>
        <h1 class="wordmark xl">kuhit</h1>
        <p class="lede">Meet people around you.<br>One kuhit at a time.</p>
      </div>
      <div class="stack">
        ${btn('Get started', 'start-signup')}
        ${btn('I already have an account', 'start-login', 'secondary')}
        <p class="fine">18+ only · Made in CDO</p>
        ${S.be?.mode === 'demo' ? '<p class="fine demo-note">Demo mode: data stays on this phone, people nearby are simulated.</p>' : ''}
      </div>
    </div>`,

  // How Kuhit works (3 short cards before sign-up)
  intro: () => {
    const i = Math.min(S.introStep || 0, 2);
    const cards = [
      { art: `<div class="intro-art yellow">${I.camera}</div>`, t: "Take today's selfie", b: 'One fresh selfie a day, straight from the camera. No old photos, no filters, no catfish.' },
      { art: `<div class="intro-art red">${logoMark()}</div>`, t: 'Kuhit someone nearby', b: "Send a Friendly or a Crush kuhit. They won't know it's you unless they kuhit back." },
      { art: `<div class="intro-art pink">${I.heart}</div>`, t: "Kuhit back? It's mutual!", b: 'Both selfies unblur and a chat opens. If they don\'t kuhit back, nothing happens. Nobody gets rejected.' },
    ];
    const c = cards[i];
    return `
    <div class="pad col">
      <div class="topline">${i ? '<button class="icon-btn back" data-act="intro-prev" aria-label="Back">' + I.back + '</button>' : backBtn('welcome')}<button class="link push-right" data-act="intro-done">Skip</button></div>
      <div class="grow center-col intro" aria-live="polite">
        ${c.art}
        <p class="intro-step">${i + 1} of 3</p>
        <h1 class="h1 center">${c.t}</h1>
        <p class="sub center">${c.b}</p>
        <div class="intro-dots" aria-hidden="true">${cards.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      </div>
      ${btn(i < 2 ? 'Next' : 'Create my account', 'intro-next')}
    </div>`;
  },

  // 02 Sign up / 03 under 18
  signup: () => {
    const d = S.draft;
    const signedIn = !!S.user;
    const needPhone = !signedIn;
    const ok = signupOk();
    return `
    <div class="pad col">
      <div class="topline">${signedIn ? '' : backBtn('welcome')}${steps(1)}</div>
      <div class="scroll grow">
        <h1 class="h1">Create your account</h1>
        <p class="sub">Just the basics. Your name stays hidden until a mutual kuhit.</p>
        ${needPhone ? phoneField() : ''}
        ${bdayField()}
        <label class="field"><span>First name</span>
          <input id="f-name" data-model="name" data-live="1" type="text" autocomplete="given-name" maxlength="30" placeholder="e.g. Mika" value="${esc(d.name || '')}">
          <small>Only shown after a mutual kuhit.</small></label>
        <div class="note note-yellow">${I.shield}<span>Kuhit is for 18+ only. We'll verify your age in the next steps.</span></div>
        ${errLine()}
      </div>
      ${btn(busy('Continue'), 'signup-continue', 'primary', ok && !S.busy ? '' : 'disabled')}
      <div id="recaptcha"></div>
    </div>`;
  },

  // 04 OTP
  otp: () => {
    const code = S.draft.code || '';
    const left = Math.max(0, Math.ceil((S.resendAt - Date.now()) / 1000));
    return `
    <div class="pad col">
      <div class="topline">${backBtn(S.flow === 'login' ? 'login' : 'signup')}${S.flow === 'signup' ? steps(2) : ''}</div>
      <div class="grow">
        <h1 class="h1">Enter the code</h1>
        <p class="sub">We sent a 6-digit code to ${esc(maskPhone(S.draft.phoneE164))}.</p>
        <label class="otp">
          <input id="f-code" data-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="${esc(code)}" aria-label="6-digit code">
          ${[0, 1, 2, 3, 4, 5].map((i) => `<i class="${i === code.length ? 'cur' : ''}">${esc(code[i] || '')}</i>`).join('')}
        </label>
        <p class="fine left" id="resend">${left ? `Resend code in 0:${String(left).padStart(2, '0')}` : '<button class="link" data-act="resend">Resend code</button>'}</p>
        ${S.be.mode === 'demo' ? '<p class="fine left">Demo mode: any 6 digits work.</p>' : ''}
        ${errLine()}
      </div>
      ${btn(busy('Verify'), 'verify-code', 'primary', code.length === 6 && !S.busy ? '' : 'disabled')}
      <div id="recaptcha"></div>
    </div>`;
  },

  // 05 Log in
  login: () => `
    <div class="pad col">
      <div class="topline">${backBtn('welcome')}</div>
      <div class="grow">
        <h1 class="h1">Welcome back!</h1>
        <p class="sub">Log in with your mobile number.</p>
        ${phoneField()}
        ${errLine()}
      </div>
      <div class="stack">
        ${btn(busy('Send code'), 'login-send', 'primary', normalizePhone(S.draft.phone) && !S.busy ? '' : 'disabled')}
        <button class="btn btn-ghost" data-act="google">Continue with Google</button>
        <p class="fine">New here? <button class="link red" data-act="start-signup">Create an account</button></p>
      </div>
      <div id="recaptcha"></div>
    </div>`,

  // 06 Face check (live)
  face: () => {
    const v = S.verify;
    const prompts = ['Look straight at the camera', 'Blink twice', 'Turn your head left', 'Turn your head right', 'All done!'];
    const running = v.step > 0;
    return `
    <div class="pad col">
      <div class="topline">${steps(3)}</div>
      <h1 class="h1">Quick face check</h1>
      <p class="sub">Makes sure it's really you, not a photo of someone else. Hold still and follow the prompts.</p>
      <div class="facecam${running ? ' running' : ''}">
        <video id="cam" class="mirror" playsinline muted></video>
        <div class="oval"></div>
        <div class="cam-chip">${running ? esc(prompts[Math.min(v.step - 1, 4)]) : 'Fit your face inside the oval'}</div>
        ${running ? `<div class="face-progress"><i style="width:${Math.min(100, (v.step - 1) * 25)}%"></i></div>` : ''}
      </div>
      <ul class="checks">
        <li>${I.check}Good light, face the camera</li>
        <li>${I.check}Remove sunglasses or face mask</li>
        <li>${I.check}Takes about 10 seconds</li>
      </ul>
      ${btn(running ? 'Checking…' : 'Start face check', 'face-start', 'primary', running ? 'disabled' : '')}
    </div>`;
  },

  // 07 Face check failed
  'face-failed': () => `
    <div class="pad col">
      <div class="topline">${backBtn('face')}</div>
      <div class="grow">
        <div class="facecam failed"><div class="oval red"></div><div class="cam-chip red">${esc(S.camErr || "Couldn't see your face")}</div></div>
        <h1 class="h1">Let's try that again</h1>
        <p class="sub">A few things usually help:</p>
        <ul class="checks">
          <li>${I.check}Allow camera access for Kuhit</li>
          <li>${I.check}Find brighter light, face it</li>
          <li>${I.check}Hold your phone at eye level</li>
        </ul>
      </div>
      <div class="stack">
        ${btn('Try again', 'face-retry')}
        <a class="btn btn-secondary" href="mailto:hello@kuhit.app?subject=Face%20check%20help">Get help</a>
        ${S.be.mode === 'demo' ? '<button class="link" data-act="face-demo-pass">Skip in demo mode</button>' : ''}
      </div>
    </div>`,

  // 08 ID check
  id: () => {
    const opts = [['philsys', 'PhilSys National ID', I.id], ['license', "Driver's license", I.car], ['school', 'School ID (college)', I.school]];
    return `
    <div class="pad col">
      <div class="topline">${steps(4)}</div>
      <div class="grow">
        <h1 class="h1">Verify your age</h1>
        <p class="sub">Scan one valid ID. We only check your age and that it's you.</p>
        <div class="radios" role="radiogroup">
          ${opts.map(([k, l, icon]) => `<button class="radio${S.verify.idType === k ? ' on' : ''}" role="radio" aria-checked="${S.verify.idType === k}" data-act="id-type" data-v="${k}"><span class="ri">${icon}</span><span class="grow">${l}</span><i class="dot"></i></button>`).join('')}
        </div>
        <div class="note note-blue">${I.lock}<span>Checked by our verification partner. We never store your ID photo.</span></div>
      </div>
      ${btn('Scan my ID', 'go', 'primary', 'data-to="scan"')}
    </div>`;
  },

  // 09 ID scanner
  scan: () => {
    const name = { philsys: 'PhilSys ID', license: "driver's license", school: 'school ID' }[S.verify.idType];
    return `
    <div class="dark col fill">
      <div class="scan-top"><button class="icon-btn dark-btn" data-act="go" data-to="id" aria-label="Close">${I.close}</button>
        <div class="center"><b>Scan your ${esc(name)}</b><small>Front side</small></div><span class="icon-spacer"></span></div>
      <div class="scanbox"><video id="cam" playsinline muted></video><div class="corners"><i></i><i></i><i></i><i></i></div></div>
      <div class="cam-chip yellow">Fit your ID inside the frame</div>
      <div class="scan-tips"><span>No glare</span><span>All corners in</span><span>Text sharp</span></div>
      <div class="shutter-row"><button class="shutter" data-act="scan-capture" aria-label="Take photo of ID"></button></div>
      ${errLine()}
    </div>`;
  },

  // 10 ID photo check
  'id-review': () => `
    <div class="pad col">
      <div class="topline">${backBtn('scan')}</div>
      <div class="grow">
        <h1 class="h1">Is your ID clear?</h1>
        <p class="sub">Make sure all text and your photo are readable.</p>
        <div class="idshot">${S.verify.idImg ? `<img src="${S.verify.idImg}" alt="Your ID photo">` : ''}</div>
        <ul class="checks boxed">
          <li>${I.check}Text is readable</li><li>${I.check}No glare</li><li>${I.check}All 4 corners visible</li>
        </ul>
      </div>
      <div class="stack">${btn('Use this photo', 'id-use')}${btn('Retake', 'go', 'secondary', 'data-to="scan"')}</div>
    </div>`,

  // 11 ID under review
  'id-pending': () => `
    <div class="pad col">
      <div class="grow center-col">
        <div class="bigicon yellow">${I.clock}</div>
        <h1 class="h1 center">We're checking your ID</h1>
        <p class="sub center">This usually takes a few minutes. We'll let you know when you're in.</p>
        <ul class="checks boxed wide">
          <li>${I.check}Face check</li><li>${I.check}ID uploaded</li><li class="pending">${I.clock}Review in progress</li>
        </ul>
      </div>
      ${btn('Got it', 'noop', 'secondary', 'disabled')}
    </div>`,

  // 12 Not eligible
  'not-eligible': () => `
    <div class="pad col">
      <div class="grow center-col">
        <div class="bigicon red">${I.ban}</div>
        <h1 class="h1 center">Kuhit is 18+ only</h1>
        <p class="sub center">Based on your birthday, you don't meet our age requirement. You can delete your account and data now.</p>
      </div>
      <div class="stack">${btn('Delete my account', 'delete-account', 'secondary')}
        <a class="link red center" href="mailto:hello@kuhit.app?subject=Age%20check">Think this is a mistake? Contact support</a></div>
    </div>`,

  // 13 Verified + permissions
  verified: () => {
    const locOn = S.loc.state === 'ok' || S.loc.state === 'asking';
    return `
    <div class="pad col">
      <div class="grow center-col">
        <div class="bigicon blue">${I.check}</div>
        <h1 class="h1 center">You're verified!</h1>
        <p class="sub center">One quick permission and you're in.</p>
        <div class="card perm">
          <div class="perm-row"><span class="ri yellow">${I.pin}</span><div class="grow"><b>Location</b><small>Shows you to people nearby as ~50m. Never exact, never a pin.</small></div>${toggle('t-loc', locOn, 'perm-loc')}</div>
        </div>
        <p class="fine">We'll ask about notifications after your first kuhit.</p>
        <p class="fine">By continuing you agree that Kuhit uses your approximate location and today's selfie to show you to people nearby, as the Data Privacy Act of 2012 requires us to ask.</p>
      </div>
      ${btn("Let's go", 'go', 'primary', 'data-to="selfie"')}
    </div>`;
  },

  // 14 Daily selfie
  selfie: () => {
    const d = new Date();
    return `
    <div class="dark col fill">
      <div class="scan-top"><button class="icon-btn dark-btn" data-act="selfie-close" aria-label="Close">${I.close}</button>
        <div class="center"><b>Today's selfie</b><small>${d.toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric' })}</small></div><span class="icon-spacer"></span></div>
      <div class="selfiebox"><video id="cam" class="mirror" playsinline muted></video><div class="cam-msg" id="cam-msg"></div></div>
      <div class="shutter-row"><button class="shutter" data-act="selfie-capture" aria-label="Take selfie"></button></div>
      <p class="cam-foot">Expires in 24 hours. Blurred to others until a mutual kuhit.</p>
      ${S.be.mode === 'demo' ? '<button class="link light" data-act="selfie-demo">No camera? Use a demo selfie</button>' : ''}
      ${errLine()}
    </div>`;
  },

  // 15 Status & go visible
  status: () => {
    const st = S.draft.status ?? S.profile?.status ?? '';
    const vis = S.draft.visible ?? (S.profile?.visible ?? true);
    const sugg = ['Kape buddy?', 'Bored sa jeep', 'Study mo later?', 'New in CDO'];
    return `
    <div class="pad col">
      <div class="topline">${backBtn('nearby')}</div>
      <div class="scroll grow">
        <h1 class="h1">Looking good!</h1>
        <p class="sub">Add a status so people nearby have something to talk about.</p>
        <div class="selfie-row">
          <span class="ava ava-sq" style="--s:84px">${S.reveal[me()]?.img ? `<img src="${esc(S.reveal[me()].img)}" alt="Your selfie">` : ''}</span>
          <div><span class="chip chip-blue">${I.check}Today's selfie</span><button class="link red" data-act="go" data-to="selfie">Retake</button></div>
        </div>
        <label class="field"><span class="row-between">Your status today <small>${st.length}/40</small></span>
          <input id="f-status" data-model="status" maxlength="40" placeholder="Ulina from work, pagod" value="${esc(st)}"></label>
        <div class="chips">${sugg.map((s) => `<button class="chip chip-yellow" data-act="status-sugg" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <div class="card row-card"><span class="ri yellow">${I.eye}</span><div class="grow"><b>Visible to people nearby</b><small>~50m range. Turn off anytime.</small></div>${toggle('t-vis', vis, 'status-vis')}</div>
        ${errLine()}
      </div>
      ${btn(busy("Show me who's nearby"), 'status-save', 'primary', S.busy ? 'disabled' : '')}
    </div>`;
  },

  // 16-23 Nearby
  nearby: () => {
    const left = kuhitsLeft();
    const people = nearbyPeople();
    const inboxCount = S.inbox.filter((i) => !matchWith(i.from)).length;
    let top = '', list = '';
    const strip = `<div class="strip${left ? '' : ' out'}"><b>${left ? `${left} of ${S.be.DAILY_KUHITS} kuhits left today` : `Out of kuhits · new ones in ${resetIn()}`}</b><span class="pips">${Array.from({ length: S.be.DAILY_KUHITS }, (_, i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('')}</span></div>`;

    if (S.loc.state === 'denied' || S.loc.state === 'error' || S.loc.state === 'idle') {
      // 21 Location off
      return `${header(visChip())}<div class="pad col grow center-col">
        <div class="bigicon yellow">${I.pin}</div>
        <h1 class="h2 center">Turn on location</h1>
        <p class="sub center">Kuhit needs your approximate location to show people nearby. We only ever show ~50m, never a pin.</p>
        ${S.loc.state === 'denied' ? '<p class="fine">Location is blocked for this site. Allow it in your browser settings, then try again.</p>' : ''}
        ${btn('Turn on location', 'perm-loc-on')}</div>`;
    }
    if (!hasSelfie()) {
      // 16 Invisible today
      top = `<div class="card hero yellow-card center-col">
        <div class="bigicon sm">${I.eyeOff}</div>
        <h2 class="h3">You're invisible today</h2>
        <p class="sub center">Take today's selfie to see and kuhit people nearby. You can still check who kuhit you.</p>
        ${btn("Take today's selfie", 'go', 'primary', 'data-to="selfie"')}
        ${btn(`See my kuhits (${inboxCount})`, 'go', 'secondary', 'data-to="kuhits"')}</div>`;
    } else if (!S.profile?.visible) {
      // 22 Hidden
      top = `<div class="card hero yellow-card">
        <h2 class="h3">You're hidden right now</h2>
        <p class="sub">People nearby can't see you, and you can't send kuhits. You still get kuhits from people who saw you earlier.</p>
        <div class="card row-card flat"><span class="ri">${I.eye}</span><div class="grow"><b>Visible to people nearby</b></div>${toggle('t-vis2', false, 'vis-toggle')}</div></div>`;
    } else {
      top = strip;
    }
    const canSend = isVisible() && left > 0;
    if (S.nearby === null || S.loc.state === 'asking') {
      // 18 Loading
      list = `<p class="muted">Looking around you…</p>${'<div class="person skel"></div>'.repeat(4)}`;
    } else if (!people.length) {
      // 19 Empty
      list = `<div class="empty center-col"><div class="bigicon yellow">${I.pin}</div><h2 class="h3">No one nearby yet</h2>
        <p class="sub center">Kuhit works best in busy places like malls, campuses and jeeps. We'll show people as they show up.</p>
        ${btn('Refresh', 'refresh-nearby', 'secondary')}</div>`;
    } else {
      list = people.map((p) => personCard(p, canSend)).join('');
    }
    return `${header(visChip())}<div class="scroll pad-x">${top}
      <div class="row-between section-h"><h2 class="h3">Nearby now</h2>${people.length ? `<small class="muted">${people.length} ${people.length === 1 ? 'person' : 'people'}</small>` : ''}</div>
      <div class="${hasSelfie() && S.profile?.visible ? '' : 'greyed'}">${list}</div></div>`;
  },

  // 25 / 26 Kuhit sent (with a 5-second undo, then a one-time notifications ask)
  sent: (type) => {
    const crush = type === 'crush';
    const pending = !!S.pending;
    const left = kuhitsLeft();
    const askNotif = !pending && !notificationsOn() && 'Notification' in window && !store.get('kuhit-notif-asked', false);
    return `
    <div class="pad col">
      <div class="grow center-col">
        <div class="poke ${crush ? 'pink' : 'yellow'}${pending ? '' : ' done'}">${logoMark('poke-mark')}${crush ? `<span class="poke-heart">${I.heart}</span>` : ''}</div>
        <h1 class="h1 center">${pending ? (crush ? 'Sending your crush kuhit…' : 'Sending your kuhit…') : (crush ? 'Crush kuhit sent!' : 'Kuhit sent!')}</h1>
        ${tag(type)}
        <p class="sub center">${pending ? 'Changed your mind? You have a few seconds to undo.' : crush ? "It stays secret. If they kuhit you back, you'll both see each other and a chat opens." : "If they kuhit back, you'll both see each other and a chat opens."}</p>
        ${pending ? `<div class="undo-bar" aria-hidden="true"><i style="animation-duration:${Math.max(0, S.pending.until - Date.now())}ms"></i></div>`
          : `<span class="chip">${left ? `${left} kuhit${left === 1 ? '' : 's'} left today` : `That was your last one today · new ones in ${resetIn()}`}</span>`}
        ${askNotif ? `<div class="card ask-notif"><span class="ri yellow">${I.bell}</span><div class="grow"><b>Want to know if they kuhit back?</b><small>We'll only say "Someone kuhit you!", never who.</small>
          <div class="row-gap ask-btns">${btn('Turn on', 'notif-ask-yes', 'primary btn-sm')}<button class="link" data-act="notif-ask-no">Not now</button></div></div></div>` : ''}
      </div>
      <div class="stack">${pending ? btn('Undo', 'undo-kuhit', 'secondary') : `${btn('Back to nearby', 'go', 'primary', 'data-to="nearby"')}${btn('See my kuhits', 'kuhits-sent', 'secondary')}`}</div>
    </div>`;
  },

  // 27-29 Kuhits received / sent
  kuhits: () => {
    const received = S.inbox.filter((i) => !matchWith(i.from) && !S.blocks.ids.includes(i.from)).sort((a, b) => b.at - a.at);
    const sent = S.sent.filter((k) => !matchWith(k.to)).sort((a, b) => b.at - a.at);
    const tab = S.kuhitsTab;
    const seg = `<div class="seg"><button class="${tab === 'received' ? 'on' : ''}" data-act="ktab" data-v="received">Received (${received.length})</button><button class="${tab === 'sent' ? 'on' : ''}" data-act="ktab" data-v="sent">Sent (${sent.length})</button></div>`;
    let body;
    if (tab === 'received') {
      body = received.length ? received.map((i) => {
        const p = personOf(i.from);
        const dist = distOf(p);
        return `<button class="person row" data-act="go" data-to="kuhit" data-arg="${esc(i.from)}">${avatar(i.from, { size: 52 })}
          <span class="grow"><b class="row-gap">Someone kuhit you ${tag(i.type)}${i.seen ? '' : '<i class="new-dot" aria-label="new"></i>'}</b>
          <small class="muted">${I.pin}${dist != null ? geo.distanceLabel(dist) : 'Nearby'} · ${ago(i.at)}</small></span>${I.chev}</button>`;
      }).join('') + `<div class="note note-blue">${I.lock}<span>Who kuhit you stays hidden until you kuhit back. Nobody gets rejected.</span></div>`
        : `<div class="empty center-col"><div class="bigicon yellow">${logoMark('ic')}</div><h2 class="h3">No kuhits yet</h2><p class="sub center">When someone kuhit you, it shows up here, hidden until you kuhit back.</p>${btn('Go to nearby', 'go', 'primary', 'data-to="nearby"')}</div>`;
    } else {
      body = sent.length ? sent.map((k) => `<div class="person row">${avatar(k.to, { size: 52 })}
          <span class="grow"><b class="row-gap">You kuhit someone ${tag(k.type)}</b><small class="muted">Waiting · ${ago(k.at)}</small></span></div>`).join('')
        + `<div class="note note-blue">${I.lock}<span>They'll only know it was you if they kuhit back.</span></div>`
        : `<div class="empty center-col"><div class="bigicon yellow">${logoMark('ic')}</div><h2 class="h3">No kuhits sent yet</h2><p class="sub center">You have ${kuhitsLeft()} kuhits left today. Make one count.</p>${btn('Go to nearby', 'go', 'primary', 'data-to="nearby"')}</div>`;
    }
    return `<header class="apphead"><h1 class="h1 flush">Kuhits</h1></header><div class="scroll pad-x">${seg}${body}</div>`;
  },

  // 30 / 31 Someone kuhit you
  kuhit: (uid) => {
    const item = S.inbox.find((i) => i.from === uid);
    if (!item) return `<div class="pad col">${backBtn('kuhits')}<p class="sub">This kuhit is no longer here.</p></div>`;
    const p = personOf(uid);
    const dist = distOf(p);
    const canSend = isVisible() && kuhitsLeft() > 0;
    const why = !hasSelfie() ? "Take today's selfie to kuhit back." : !S.profile?.visible ? 'Turn on visibility to kuhit back.' : kuhitsLeft() ? '' : `You're out of kuhits today. New ones in ${resetIn()}.`;
    return `
    <div class="pad col">
      <div class="topline">${backBtn('kuhits')}</div>
      <div class="scroll grow">
        <div class="bigphoto">${avatar(uid, { size: 280 })}<span class="chip chip-white">${I.lock}Hidden until mutual</span></div>
        <h1 class="h2 row-gap">Someone kuhit you! ${tag(item.type)}</h1>
        ${p?.status ? `<p class="quote">"${esc(p.status)}"</p>` : ''}
        <p class="muted small">${I.pin}${dist != null ? `${geo.distanceLabel(dist)} away` : 'Nearby'} · ${ago(item.at)}</p>
        ${why ? `<p class="note note-yellow">${I.info}<span>${why}</span></p>` : ''}
      </div>
      <div class="stack">
        ${canSend ? btn('Kuhit back', 'open-kuhit', 'primary', `data-uid="${esc(uid)}" data-back="1"`) : !hasSelfie() ? btn("Take today's selfie", 'go', 'primary', 'data-to="selfie"') : btn('Kuhit back', 'noop', 'primary', 'disabled')}
        ${btn('Not now', 'go', 'secondary', 'data-to="kuhits"')}
        <p class="fine">They won't know if you say not now.</p>
      </div>
    </div>`;
  },

  // 32 / 33 It's mutual / crush match
  mutual: (id) => {
    const m = S.matches.find((x) => x.id === id);
    if (!m) return `<div class="pad col">${backBtn('nearby')}<p class="sub">This match is no longer here.</p></div>`;
    const o = otherOf(m);
    const name = S.reveal[o]?.name || 'them';
    return `
    <div class="pad col fill ${m.crush ? 'pink-bg' : 'yellow-bg'}">
      <div class="grow center-col">
        <div class="duo">
          <span class="card-tilt l">${avatar(me(), { size: 120, blur: false, img: S.reveal[me()]?.img })}<b>You</b></span>
          <span class="card-tilt r">${avatar(o, { size: 120, blur: false })}<b>${esc(name)}</b></span>
          ${m.crush ? `<span class="duo-heart">${I.heart}</span>` : ''}
        </div>
        <h1 class="h1 center">${m.crush ? "It's a crush match!" : "It's mutual!"}</h1>
        <p class="sub center">${m.crush ? `You and ${esc(name)} both have a crush. Say hi before the moment passes.` : `You and ${esc(name)} kuhit each other. Say hi before the moment passes.`}</p>
      </div>
      <div class="stack">${btn(`Say hi to ${esc(name)}`, 'go', 'primary', `data-to="chat" data-arg="${esc(id)}"`)}${btn('Keep exploring', 'go', 'secondary', 'data-to="nearby"')}</div>
    </div>`;
  },

  // 35 / 36 Chats
  chats: () => {
    const list = [...S.matches].sort((a, b) => (b.lastAt || b.at || 0) - (a.lastAt || a.at || 0));
    const reads = store.get('kuhit-read', {});
    const body = list.length ? list.map((m) => {
      const o = otherOf(m);
      const unread = m.lastFrom && m.lastFrom !== me() && (m.lastAt || 0) > (reads[m.id] || 0);
      return `<button class="person row chatrow" data-act="go" data-to="chat" data-arg="${esc(m.id)}">${avatar(o, { size: 52, blur: false })}
        <span class="grow"><b class="row-gap">${esc(S.reveal[o]?.name || '…')} ${tag(m.crush ? 'crush' : 'friendly')}</b>
        <small class="${unread ? 'strong' : 'muted'}">${m.lastText ? `${m.lastFrom === me() ? 'You: ' : ''}${esc(m.lastText)}` : 'New match! Say hi'}</small></span>
        <small class="muted">${ago(m.lastAt || m.at)}</small>${unread ? '<i class="new-dot"></i>' : ''}</button>`;
    }).join('')
      : `<div class="empty center-col"><div class="bigicon">${I.chat}</div><h2 class="h3">No chats yet</h2><p class="sub center">A chat opens when a kuhit is mutual.</p>${btn('Find people nearby', 'go', 'primary', 'data-to="nearby"')}</div>`;
    return `<header class="apphead"><h1 class="h1 flush">Chats</h1></header><div class="scroll pad-x">${body}</div>`;
  },

  // 37 / 38 Chat
  chat: (id) => {
    const m = S.matches.find((x) => x.id === id);
    if (!m) return `<div class="pad col"><div class="topline">${backBtn('chats')}</div><div class="grow center-col"><h1 class="h2">This chat has closed</h1><p class="sub center">It may have been ended by the other person.</p></div></div>`;
    const o = otherOf(m);
    const name = S.reveal[o]?.name || '…';
    const msgs = S.msgs.id === id ? S.msgs.list : [];
    const ice = ['Asa ka padulong?', 'Taga asa ka?', 'Unsay ganahan nimo nga kape?', 'First time nimo diri?'];
    const iceBox = `<div class="icebox"><b>${I.sparkle}Break the ice</b><div class="chips">${ice.map((q) => `<button class="chip chip-white" data-act="ice" data-v="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
    const empty = !msgs.length;
    return `
    <div class="col fill">
      <header class="chathead">${backBtn('chats')}${avatar(o, { size: 40, blur: false })}<div class="grow"><b>${esc(name)}</b><small class="muted">Matched ${ago(m.at)}</small></div>
        <button class="icon-btn" data-act="open-block" data-uid="${esc(o)}" data-match="${esc(id)}" aria-label="Block or report">${I.flag}</button></header>
      <div class="scroll msgs" id="msgs">
        <div class="sys-chip">You both kuhit each other · ${m.crush ? 'Crush' : 'Friendly'}</div>
        ${empty ? `<div class="center-col newmatch">${avatar(o, { size: 96, blur: false })}<h2 class="h2">Say hi to ${esc(name)}!</h2><p class="sub center">Pick an icebreaker or say your own hi.</p></div>${iceBox}`
        : (msgs.length < 4 ? iceBox : '') + msgs.map((x) => `<div class="bubble ${x.from === me() ? 'mine' : 'theirs'}">${esc(x.text)}</div>`).join('')}
      </div>
      <form class="composer" data-form="send"><input id="f-msg" data-model="msg" placeholder="Type a message" maxlength="500" autocomplete="off" value="${esc(S.draft.msg || '')}"><button class="send" aria-label="Send">${I.send}</button></form>
    </div>`;
  },

  // 41 Me
  me: () => {
    const p = S.profile || {};
    return `<header class="apphead"><h1 class="h1 flush">Me</h1></header><div class="scroll pad-x">
      <div class="card me-card">${avatar(me(), { size: 64, blur: false, img: S.reveal[me()]?.img })}
        <div class="grow"><b class="h3">${esc(S.account?.name)}</b><span class="chip chip-blue">${I.check}Verified</span></div></div>
      <div class="card status-card"><div class="grow"><small class="muted">Status today</small><b>${esc(p.status || 'No status yet')}</b></div><button class="link" data-act="open-status">Edit</button></div>
      <div class="card list">
        <div class="li"><span class="ri yellow">${I.eye}</span><span class="grow">Visible to people nearby${hasSelfie() ? '' : '<small class="muted">Take today\'s selfie first</small>'}</span>${toggle('t-vis3', isVisible(), 'vis-toggle', !hasSelfie())}</div>
        <div class="li"><span class="ri yellow">${I.bell}</span><span class="grow">Kuhit notifications</span>${toggle('t-notif2', notificationsOn(), 'perm-notif')}</div>
        <button class="li" data-act="go" data-to="selfie"><span class="ri">${I.camera}</span><span class="grow">${hasSelfie() ? "Retake today's selfie" : "Take today's selfie"}</span>${I.chev}</button>
        <button class="li" data-act="go" data-to="blocked"><span class="ri">${I.ban}</span><span class="grow">Blocked people</span>${I.chev}</button>
        <button class="li" data-act="go" data-to="privacy"><span class="ri">${I.lock}</span><span class="grow">Privacy &amp; location</span>${I.chev}</button>
        <button class="li" data-act="go" data-to="safety"><span class="ri">${I.shield}</span><span class="grow">Safety tips</span>${I.chev}</button>
        <button class="li red" data-act="logout"><span class="ri">${I.logout}</span><span class="grow">Log out</span></button>
        <button class="li red" data-act="open-delete"><span class="ri">${I.trash}</span><span class="grow">Delete account</span></button>
      </div>
      ${S.be.mode === 'demo' ? '<p class="fine">Demo mode · data stays on this phone.</p>' : ''}
    </div>`;
  },

  // 43 Blocked people
  blocked: () => `
    <div class="pad col">
      <div class="topline">${backBtn('me')}</div>
      <h1 class="h1">Blocked people</h1>
      <p class="sub">Blocked people can't kuhit you or chat with you.</p>
      <div class="scroll grow">${S.blocks.ids.length ? S.blocks.ids.map((u) => `<div class="person row"><span class="ava ava-letter" style="--s:44px">${esc((S.blocks.names[u] || '?')[0])}</span><b class="grow">${esc(S.blocks.names[u] || 'Someone')}</b><button class="btn btn-secondary btn-sm" data-act="unblock" data-uid="${esc(u)}">Unblock</button></div>`).join('') : '<p class="muted">Nobody blocked.</p>'}</div>
    </div>`,

  // 44 Privacy & location
  privacy: () => `
    <div class="pad col">
      <div class="topline">${backBtn('me')}</div>
      <div class="scroll grow">
        <h1 class="h1">Privacy &amp; location</h1>
        <div class="card list">
          <div class="li"><span class="ri yellow">${I.pin}</span><span class="grow">Approximate location only<small class="muted">Rounded to about 100m. Others see ~50m, never a pin.</small></span>${toggle('t-a', true, 'noop', true)}</div>
          <div class="li"><span class="ri yellow">${I.bell}</span><span class="grow">Hide sender in notifications<small class="muted">Always "Someone kuhit you!", even on the lock screen.</small></span>${toggle('t-b', true, 'noop', true)}</div>
          <button class="li" data-act="download"><span class="ri">${I.download}</span><span class="grow">Download my data</span>${I.chev}</button>
          <button class="li" data-act="clear-location"><span class="ri">${I.trash}</span><span class="grow">Delete my location now<small class="muted">Kuhit keeps only your latest spot, never a history.</small></span>${I.chev}</button>
        </div>
        <div class="note note-blue">${I.shield}<span><b>Your rights under the Data Privacy Act of 2012.</b> You can see, download or delete your data anytime. Selfies expire after 24 hours, and your ID photo is never stored.</span></div>
      </div>
    </div>`,

  // 45 Safety tips
  safety: () => {
    const tips = [[I.people, 'Meet in public places', 'Malls, cafés and campuses. Never a private place on a first meet.'],
      [I.chat, 'Tell a friend', 'Share where you are going and who you are meeting.'],
      [I.lock, 'Keep personal info private', "Don't share your address, school schedule or money details."],
      [I.flag, 'Report anything off', 'Block and report from any chat. Reports are private.']];
    return `
    <div class="pad col">
      <div class="topline">${backBtn('me')}</div>
      <div class="scroll grow">
        <h1 class="h1">Safety tips</h1>
        <p class="sub">Kuhit is for meeting people safely. A few habits help.</p>
        ${tips.map(([icon, t, d]) => `<div class="card row-card"><span class="ri yellow">${icon}</span><div class="grow"><b>${t}</b><small class="muted">${d}</small></div></div>`).join('')}
      </div>
      <a class="btn btn-primary" href="tel:911">${I.phone} Emergency? Call 911</a>
    </div>`;
  },
};

function nearbyPeople() {
  if (!S.nearby || S.loc.state !== 'ok') return [];
  const now = Date.now();
  return S.nearby
    .filter((p) => p.visible && p.selfieAt && now - p.selfieAt < DAY && p.seenAt && now - p.seenAt < 3600000
      && !S.blocks.ids.includes(p.uid) && !matchWith(p.uid) && p.lat != null)
    .map((p) => ({ ...p, dist: geo.distanceMeters(S.loc, p) }))
    .filter((p) => p.dist <= geo.NEARBY_RADIUS_M)
    .sort((a, b) => a.dist - b.dist);
}

function personCard(p, canSend) {
  const sent = S.sent.find((k) => k.to === p.uid);
  const action = S.pending?.uid === p.uid
    ? '<span class="btn btn-sm btn-muted">Sending…</span>'
    : sent
    ? `<span class="btn btn-sm btn-muted">${tag(sent.type)}</span>`
    : `<button class="btn btn-sm btn-primary" data-act="open-kuhit" data-uid="${esc(p.uid)}" ${canSend ? '' : 'disabled'}>Kuhit</button>`;
  return `<div class="person">${avatar(p.uid, { size: 56 })}
    <span class="grow"><b>Someone nearby</b><small class="quote-sm">"${esc(p.status || '…')}"</small>
    <small class="muted">${I.pin}${geo.distanceLabel(p.dist)} · ${ago(p.seenAt)}</small></span>${action}</div>`;
}

// ---------- sheets ----------
function sheet() {
  const s = S.sheet;
  let body = '';
  if (s.type === 'kuhit') {
    // 24 Choose kuhit type
    const p = personOf(s.uid);
    const dist = distOf(p);
    body = `<div class="person flat">${avatar(s.uid, { size: 52 })}<span class="grow"><b>Someone nearby</b><small class="quote-sm">"${esc(p?.status || '…')}"</small><small class="muted">${I.pin}${dist != null ? geo.distanceLabel(dist) : 'Nearby'}</small></span></div>
      <h2 class="h3">${s.back ? 'How do you want to kuhit back?' : 'How do you want to kuhit?'}</h2>
      <div class="radios">
        <button class="radio big${s.choice === 'friendly' ? ' on blue' : ''}" data-act="kuhit-type" data-v="friendly"><span class="ri yellow">☺</span><span class="grow"><b class="row-gap">Friendly kuhit ${tag('friendly')}</b><small class="muted">Just making friends. Keep it casual.</small></span><i class="dot"></i></button>
        <button class="radio big${s.choice === 'crush' ? ' on red' : ''}" data-act="kuhit-type" data-v="crush"><span class="ri pink">${I.heart}</span><span class="grow"><b class="row-gap">Crush kuhit ${tag('crush')}</b><small class="muted">Secret until they kuhit you back.</small></span><i class="dot"></i></button>
      </div>
      ${errLine()}
      ${btn(busy('Send kuhit'), 'send-kuhit', 'primary', S.busy ? 'disabled' : '')}`;
  } else if (s.type === 'block') {
    // 39 Block or report
    const name = S.reveal[s.uid]?.name || 'them';
    const reasons = ['Just want to block', 'Harassing or creepy messages', 'Fake photo or catfish', 'Seems under 18', 'Spam or scam'];
    body = `<h2 class="h3">Block or report ${esc(name)}?</h2>
      <p class="sub">Blocking ends the chat and stops them from kuhit-ing you. Reports are private.</p>
      <div class="radios">${reasons.map((r) => `<button class="radio${s.reason === r ? ' on red' : ''}" data-act="block-reason" data-v="${esc(r)}"><span class="grow">${r}</span><i class="dot"></i></button>`).join('')}</div>
      ${errLine()}
      <div class="stack">${btn(busy(s.reason && s.reason !== reasons[0] ? 'Block & report' : 'Block'), 'do-block', 'primary', s.reason && !S.busy ? '' : 'disabled')}${btn('Cancel', 'close-sheet', 'secondary')}</div>`;
  } else if (s.type === 'status') {
    // 42 Edit status
    const st = S.draft.status ?? S.profile?.status ?? '';
    body = `<h2 class="h3">Edit your status</h2>
      <label class="field"><span class="row-between">Your status today <small>${st.length}/40</small></span><input id="f-status2" data-model="status" maxlength="40" value="${esc(st)}"></label>
      <div class="chips">${['Kape buddy?', 'Bored sa jeep', 'Study mo later?', 'New in CDO'].map((x) => `<button class="chip chip-yellow" data-act="status-sugg" data-v="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      ${btn(busy('Save status'), 'save-status', 'primary', S.busy ? 'disabled' : '')}`;
  } else if (s.type === 'delete') {
    // 46 Delete account
    body = `<h2 class="h3">Delete your account?</h2>
      <p class="sub">This deletes your selfies, kuhits, matches and chats. You can't undo this.</p>
      ${errLine()}
      <div class="stack">${btn(busy('Delete my account'), 'delete-account', 'danger', S.busy ? 'disabled' : '')}${btn('Cancel', 'close-sheet', 'secondary')}</div>`;
  } else if (s.type === 'reported') {
    // 40 Thanks for reporting
    body = `<div class="center-col"><div class="bigicon blue">${I.shield}</div><h2 class="h3">${s.reported ? 'Thanks for reporting' : 'Blocked'}</h2>
      <p class="sub center">${s.reported ? "We'll review this within 24 hours. " : ''}${esc(s.name || 'They')} can't kuhit you or message you anymore.</p></div>
      ${btn('Back to chats', 'close-sheet-chats')}`;
  }
  const anim = s.shown ? '' : ' anim';
  s.shown = true;
  return `<div class="sheet-wrap${anim}" data-act="backdrop"><div class="sheet" role="dialog" aria-modal="true"><i class="grab"></i>${body}</div></div>`;
}

// ---------- mount hooks (cameras, chat) ----------
const MOUNT = {
  otp: () => { const el = document.getElementById('f-code'); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); },
  face: () => attachCamera('user', (e) => { S.camErr = camError(e); go('face-failed'); }),
  scan: () => attachCamera('environment', (e) => { S.err = camError(e); render(); }),
  selfie: () => attachCamera('user', (e) => {
    const msg = document.getElementById('cam-msg');
    if (msg) msg.textContent = camError(e);
  }),
  chat: (id, fromData) => {
    if (S.msgs.id !== id) {
      stopChat();
      S.msgs = { id, list: [] };
      stopMsgs = S.be.watchMessages(id, (list) => {
        S.msgs.list = list;
        markRead(id);
        if (parseHash().arg === id) { render(true); scrollMsgs(); }
      });
      const m = S.matches.find((x) => x.id === id);
      if (m) ensureReveal(otherOf(m));
    }
    markRead(id);
    if (!fromData) scrollMsgs();
  },
};
function camError(e) {
  if (e?.name === 'NotAllowedError') return 'Camera access is blocked. Allow it for Kuhit and try again.';
  if (e?.name === 'NotFoundError' || e?.message === 'no-camera') return 'No camera found on this device.';
  return "Couldn't open the camera.";
}
// Re-renders replace the <video>, so hand the running stream to the new element.
let camOpening = false;
async function attachCamera(facing, onFail) {
  const v = document.getElementById('cam');
  if (!v) return;
  if (stopCam) { if (v.srcObject !== stopCam.stream) { v.srcObject = stopCam.stream; v.play().catch(() => {}); } return; }
  if (camOpening) return;
  camOpening = true;
  try {
    stopCam = await openCamera(v, facing);
    const now = document.getElementById('cam');
    if (!CAMERA.includes(parseHash().name)) stopCamera();
    else if (now && now !== v) { now.srcObject = stopCam.stream; now.play().catch(() => {}); }
  } catch (e) { onFail(e); } finally { camOpening = false; }
}
function stopCamera() { if (stopCam) { stopCam(); stopCam = null; } }
function stopChat() { if (stopMsgs) { stopMsgs(); stopMsgs = null; } S.msgs = { id: null, list: [] }; }
function scrollMsgs() { const el = document.getElementById('msgs'); if (el) el.scrollTop = el.scrollHeight; }
function markRead(id) {
  const reads = store.get('kuhit-read', {});
  const m = S.matches.find((x) => x.id === id);
  const t = Math.max(m?.lastAt || 0, Date.now());
  if ((reads[id] || 0) < t - 1000) { reads[id] = t; store.set('kuhit-read', reads); }
}

// ---------- data ----------
async function ensureReveal(uid) {
  if (!uid || S.reveal[uid]?.loading || (S.reveal[uid] && S.reveal[uid].img !== undefined)) return;
  S.reveal[uid] = { ...S.reveal[uid], loading: true };
  const [name, selfie] = await Promise.all([S.be.getName(uid), S.be.getSelfie(uid)]);
  S.reveal[uid] = { name: name || S.reveal[uid]?.name || null, img: selfie?.img || null };
  scheduleRender();
}
async function ensurePerson(uid) {
  if (S.people[uid] !== undefined) return;
  S.people[uid] = null;
  const fromNearby = S.nearby?.find((p) => p.uid === uid);
  if (fromNearby) { S.people[uid] = fromNearby; return; }
  S.people[uid] = (await S.be.getProfile?.(uid)) || null;
  scheduleRender();
}

function stopWatchers() {
  while (unsubs.length) { try { unsubs.pop()(); } catch { /* ignore */ } }
  if (stopNearby) { stopNearby(); stopNearby = null; }
  if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  stopChat();
  inboxLoaded = matchesLoaded = false;
  S.nearby = null; S.nearbyCell = null;
}

function startWatchers() {
  if (unsubs.length) return;
  const be = S.be;
  unsubs.push(be.watchProfile((p) => {
    S.profile = p;
    if (p?.selfieAt) S.reveal[me()] = { ...S.reveal[me()], name: S.account?.name };
    if (p?.selfieAt && !S.reveal[me()]?.img) be.getSelfie(me()).then((s) => { S.reveal[me()] = { name: S.account?.name, img: s?.img || null }; scheduleRender(); });
    scheduleRender();
  }));
  unsubs.push(be.watchLimit((l) => { S.limit = l; scheduleRender(); }));
  unsubs.push(be.watchBlocks((b) => { S.blocks = b; scheduleRender(); }));
  unsubs.push(be.watchSent((list) => { S.sent = list; scheduleRender(); }));
  unsubs.push(be.watchInbox((list) => {
    const before = new Set(S.inbox.map((i) => i.from));
    S.inbox = list;
    list.forEach((i) => ensurePerson(i.from));
    if (inboxLoaded) {
      for (const i of list) {
        if (!before.has(i.from) && !matchWith(i.from) && !S.sent.some((k) => k.to === i.from)) notifyKuhit(i.type);
      }
    }
    inboxLoaded = true;
    scheduleRender();
  }));
  unsubs.push(be.watchMatches((list) => {
    const seen = new Set(store.get('kuhit-seen-matches', []));
    S.matches = list;
    list.forEach((m) => ensureReveal(otherOf(m)));
    const fresh = list.filter((m) => !seen.has(m.id));
    if (fresh.length) {
      fresh.forEach((m) => seen.add(m.id));
      store.set('kuhit-seen-matches', [...seen]);
      const r = parseHash().name;
      if (matchesLoaded || fresh.length === 1) {
        const m = fresh[fresh.length - 1];
        if (['nearby', 'kuhits', 'kuhit', 'sent', 'chats'].includes(r)) go('mutual', m.id);
        else showToast(m.crush ? "It's a crush match!" : "It's mutual!", 'Open Chats to say hi.');
        systemNotify("It's mutual!", 'Someone kuhit you back. Say hi!');
      }
    }
    matchesLoaded = true;
    scheduleRender();
  }));
  if (store.get('kuhit-loc-ok', false)) startLocation();
}

function startLocation() {
  if (!navigator.geolocation) { S.loc = { state: 'error' }; scheduleRender(); return; }
  if (geoWatch != null) return;
  if (S.loc.state !== 'ok') S.loc = { state: 'asking' };
  scheduleRender();
  geoWatch = navigator.geolocation.watchPosition((pos) => {
    store.set('kuhit-loc-ok', true);
    onPosition(pos.coords.latitude, pos.coords.longitude);
  }, (err) => {
    if (S.be.mode === 'demo' && S.loc.state !== 'ok') { onPosition(8.4822, 124.6472); return; } // CDO, for trying it out
    S.loc = { state: err.code === 1 ? 'denied' : 'error' };
    if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    scheduleRender();
  }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 });
}

function onPosition(lat, lng) {
  lat = geo.roundCoord(lat); lng = geo.roundCoord(lng);
  S.loc = { state: 'ok', lat, lng };
  const cell = geo.geohash(lat, lng);
  if (cell !== S.nearbyCell) {
    S.nearbyCell = cell;
    if (stopNearby) stopNearby();
    S.nearby = null;
    stopNearby = S.be.watchNearby({ lat, lng }, (list) => { S.nearby = list; scheduleRender(); });
  }
  const moved = !lastUpload || geo.distanceMeters(lastUpload, { lat, lng }) > 80 || Date.now() - lastUpload.t > 3 * 60000;
  if (moved) {
    lastUpload = { lat, lng, t: Date.now() };
    S.be.updateLocation(lat, lng).catch((e) => console.warn('location', e));
  }
  scheduleRender();
}

// ---------- notifications ----------
function notificationsOn() {
  return store.get('kuhit-notif', false) && 'Notification' in window && Notification.permission === 'granted';
}
async function systemNotify(title, body) {
  if (!notificationsOn() || document.visibilityState === 'visible') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'kuhit' });
    else new Notification(title, { body });
  } catch { /* ignore */ }
}
function notifyKuhit(type) {
  // Never the sender, never "Naay nikuhit nimo": always "Someone kuhit you!" + the type.
  showToast('Someone kuhit you!', null, type);
  systemNotify('Someone kuhit you!', `${typeName(type)} kuhit`);
}
let toastTimer = null;
function showToast(title, body, type) {
  $toast.innerHTML = `<button class="toast-in" data-act="toast">${type ? `<span class="toast-ic">${type === 'crush' ? I.heart : logoMark('ic')}</span>` : ''}<span class="grow"><b>${esc(title)}</b>${body ? `<small>${esc(body)}</small>` : ''}</span>${type ? tag(type) : ''}</button>`;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 4500);
}

// ---------- actions ----------
const ACTIONS = {
  back: (el) => go(el.dataset.to || 'nearby'),
  go: (el) => { S.err = ''; S.sheet = null; go(el.dataset.to, el.dataset.arg); },
  noop: () => {},
  toast: () => { $toast.classList.remove('show'); go('kuhits'); },
  'start-signup': () => { S.flow = 'signup'; S.err = ''; S.introStep = 0; go(store.get('kuhit-intro-seen', false) ? 'signup' : 'intro'); },
  'intro-next': () => { if ((S.introStep || 0) < 2) { S.introStep = (S.introStep || 0) + 1; render(); } else ACTIONS['intro-done'](); },
  'intro-prev': () => { S.introStep = Math.max(0, (S.introStep || 0) - 1); render(); },
  'intro-done': () => { store.set('kuhit-intro-seen', true); S.introStep = 0; S.flow = 'signup'; go('signup'); },
  'start-login': () => { S.flow = 'login'; S.err = ''; go('login'); },

  'signup-continue': async () => {
    const d = S.draft;
    const b = readBday();
    if (b.state !== 'ok') { S.err = b.state === 'under' ? 'You must be 18 or older to use Kuhit.' : 'Check your birthday.'; return render(); }
    d.birthdate = b.iso;
    S.err = '';
    if (S.user) {
      await withBusy(async () => {
        await S.be.createAccount({ name: d.name.trim(), birthdate: d.birthdate, phone: S.user.phone });
        S.account = await S.be.getAccount();
        go('face');
      });
      return;
    }
    const phone = normalizePhone(d.phone);
    if (!phone) { S.err = 'Enter a PH mobile number, like 0917 555 4821.'; return render(); }
    S.flow = 'signup';
    await sendCode(phone);
  },
  'login-send': async () => {
    const phone = normalizePhone(S.draft.phone);
    if (!phone) { S.err = 'Enter a PH mobile number, like 0917 555 4821.'; return render(); }
    S.flow = 'login';
    S.draft.name = ''; S.draft.birthdate = '';
    await sendCode(phone);
  },
  resend: async () => { await sendCode(S.draft.phoneE164); },
  'verify-code': async () => {
    await withBusy(async () => {
      try { await S.be.confirmCode(S.draft.code); } catch (e) { S.draft.code = ''; throw new Error(authMessage(e)); }
    });
  },
  google: async () => {
    S.flow = 'login';
    await withBusy(async () => { try { await S.be.signInGoogle(); } catch (e) { throw new Error(authMessage(e)); } });
  },

  'face-start': async () => {
    const v = document.getElementById('cam');
    if (!stopCam || !v?.videoWidth) { S.camErr = "Couldn't see your face"; stopCamera(); go('face-failed'); return; }
    // Prompted liveness steps. A verification partner's SDK replaces this before launch.
    for (let i = 1; i <= 5; i++) {
      S.verify.step = i;
      render();
      await new Promise((r) => setTimeout(r, 1700));
      if (parseHash().name !== 'face') { S.verify.step = 0; return; }
    }
    await S.be.setVerified({ face: true, id: false });
    S.account = await S.be.getAccount();
    S.verify.step = 0;
    stopCamera();
    go('id');
  },
  'face-retry': () => { S.camErr = ''; go('face'); },
  'face-demo-pass': async () => {
    await S.be.setVerified({ face: true, id: false });
    S.account = await S.be.getAccount();
    S.err = '';
    go('id');
  },
  'id-type': (el) => { S.verify.idType = el.dataset.v; render(); },
  'scan-capture': () => {
    const v = document.getElementById('cam');
    const img = v && captureFrame(v);
    if (!img) {
      if (S.be.mode === 'demo') { S.verify.idImg = demoIdImage(); go('id-review'); return; }
      S.err = 'Camera not ready yet. Try again.'; render(); return;
    }
    S.verify.idImg = img;
    stopCamera();
    go('id-review');
  },
  'id-use': async () => {
    // The ID photo stays on this device: it is dropped here, never uploaded.
    S.verify.idImg = null;
    go('id-pending');
    await new Promise((r) => setTimeout(r, 2500));
    await S.be.setVerified({ face: true, id: true, idType: S.verify.idType });
    S.account = await S.be.getAccount();
    startWatchers();
    go('verified');
  },
  'perm-loc': () => { store.set('kuhit-loc-ok', true); startLocation(); render(); },
  'perm-loc-on': () => { store.set('kuhit-loc-ok', true); S.loc = { state: 'idle' }; startLocation(); },
  'perm-notif': async () => {
    if (notificationsOn()) { store.set('kuhit-notif', false); render(); return; }
    if (!('Notification' in window)) { showToast('Notifications not supported', 'Add Kuhit to your home screen first.'); return; }
    const p = await Notification.requestPermission();
    store.set('kuhit-notif', p === 'granted');
    if (p !== 'granted') showToast('Notifications are off', 'Allow them in your browser settings.');
    render();
  },

  'selfie-close': () => { store.set('kuhit-skip-selfie-intro', true); go('nearby'); },
  'selfie-capture': async () => {
    const v = document.getElementById('cam');
    const img = v && captureSquare(v);
    if (!img) { S.err = 'Camera not ready yet. Allow camera access and try again.'; render(); return; }
    await saveSelfie(img);
  },
  'selfie-demo': async () => { await saveSelfie(demoSelfie()); },
  'status-sugg': (el) => { S.draft.status = el.dataset.v; render(); },
  'status-vis': () => { S.draft.visible = !(S.draft.visible ?? (S.profile?.visible ?? true)); render(); },
  'status-save': async () => {
    await withBusy(async () => {
      await S.be.updateProfile({ status: (S.draft.status ?? S.profile?.status ?? '').trim(), visible: S.draft.visible ?? true });
      delete S.draft.status; delete S.draft.visible;
      if (S.loc.state !== 'ok') { store.set('kuhit-loc-ok', true); startLocation(); }
      go('nearby');
    });
  },
  'vis-toggle': async () => {
    if (!hasSelfie()) { go('selfie'); return; }
    await S.be.updateProfile({ visible: !S.profile?.visible });
  },
  'refresh-nearby': () => {
    if (S.loc.state === 'ok') { S.nearbyCell = null; onPosition(S.loc.lat, S.loc.lng); }
  },

  'open-kuhit': (el) => {
    if (!isVisible() || kuhitsLeft() < 1 || S.pending) return;
    S.err = '';
    S.sheet = { type: 'kuhit', uid: el.dataset.uid, choice: 'friendly', back: !!el.dataset.back };
    render();
  },
  'kuhit-type': (el) => { S.sheet.choice = el.dataset.v; render(); },
  'send-kuhit': () => {
    const { uid, choice } = S.sheet;
    if (S.pending) return;
    S.sheet = null;
    S.pending = { uid, choice, until: Date.now() + UNDO_MS, timer: setTimeout(commitKuhit, UNDO_MS) };
    go('sent', choice);
  },
  'undo-kuhit': () => {
    if (!S.pending) return;
    clearTimeout(S.pending.timer);
    S.pending = null;
    showToast('Kuhit cancelled', 'Nothing was sent.');
    go('nearby');
  },
  'notif-ask-yes': async () => { store.set('kuhit-notif-asked', true); await ACTIONS['perm-notif'](); },
  'notif-ask-no': () => { store.set('kuhit-notif-asked', true); render(); },
  'kuhits-sent': () => { S.kuhitsTab = 'sent'; go('kuhits'); },
  ktab: (el) => { S.kuhitsTab = el.dataset.v; render(); },

  ice: async (el) => { await S.be.sendMessage(parseHash().arg, el.dataset.v).catch((e) => showToast("Couldn't send", e.message)); },
  'open-block': (el) => { S.err = ''; S.sheet = { type: 'block', uid: el.dataset.uid, match: el.dataset.match, reason: null }; render(); },
  'block-reason': (el) => { S.sheet.reason = el.dataset.v; render(); },
  'do-block': async () => {
    const { uid, match, reason } = S.sheet;
    const name = S.reveal[uid]?.name || 'Someone';
    await withBusy(async () => {
      const reported = reason !== 'Just want to block';
      if (reported) await S.be.report({ about: uid, reason, matchId: match });
      await S.be.block(uid, name);
      S.sheet = { type: 'reported', name, reported };
    });
  },
  'close-sheet': () => { S.sheet = null; S.err = ''; render(); },
  'close-sheet-chats': () => { S.sheet = null; go('chats'); },
  backdrop: (el, ev) => { if (ev.target === el && S.sheet?.type !== 'reported') ACTIONS['close-sheet'](); },

  'open-status': () => { S.draft.status = S.profile?.status || ''; S.sheet = { type: 'status' }; render(); },
  'save-status': async () => {
    await withBusy(async () => {
      await S.be.updateProfile({ status: (S.draft.status || '').trim() });
      delete S.draft.status;
      S.sheet = null;
    });
  },
  unblock: async (el) => { await S.be.unblock(el.dataset.uid); },
  logout: async () => { stopWatchers(); await S.be.signOut(); S.draft = {}; go('welcome'); },
  'open-delete': () => { S.err = ''; S.sheet = { type: 'delete' }; render(); },
  'delete-account': async () => {
    await withBusy(async () => {
      stopWatchers();
      await S.be.deleteAccount();
      ['kuhit-seen-matches', 'kuhit-read', 'kuhit-loc-ok', 'kuhit-notif', 'kuhit-skip-selfie-intro'].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
      S.sheet = null; S.draft = {}; S.account = null; S.profile = null; S.reveal = {};
      go('welcome');
    });
  },
  download: async () => {
    const data = await S.be.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kuhit-my-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'clear-location': async () => {
    if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    store.set('kuhit-loc-ok', false);
    await S.be.clearLocation();
    S.loc = { state: 'idle' }; lastUpload = null;
    showToast('Location deleted', "You're hidden until you turn location on again.");
    render();
  },
};

const UNDO_MS = 5000;
// Sends the kuhit once its undo window has passed.
async function commitKuhit() {
  const p = S.pending;
  if (!p) return;
  try {
    await S.be.sendKuhit(p.uid, p.choice);
  } catch (e) {
    S.pending = null;
    showToast("Couldn't send your kuhit", kuhitMessage(e));
    render();
    return;
  }
  S.pending = null;
  const theirs = S.inbox.find((i) => i.from === p.uid);
  if (theirs) {
    const id = await S.be.createMatch(p.uid, p.choice, theirs.type);
    const seen = new Set(store.get('kuhit-seen-matches', []));
    seen.add(id); store.set('kuhit-seen-matches', [...seen]);
    ensureReveal(p.uid);
    go('mutual', id);
  } else {
    render();
  }
}

async function withBusy(fn) {
  if (S.busy) return;
  S.busy = true; S.err = ''; render();
  try { await fn(); } catch (e) { S.err = e.message || 'Something went wrong. Try again.'; console.warn(e); }
  S.busy = false; render();
}
async function sendCode(phone) {
  await withBusy(async () => {
    try {
      await S.be.startPhone(phone, 'recaptcha');
    } catch (e) { throw new Error(authMessage(e)); }
    S.draft.phoneE164 = phone;
    S.draft.code = '';
    S.resendAt = Date.now() + 45000;
    go('otp');
  });
}
async function saveSelfie(img) {
  await withBusy(async () => {
    const blur = await blurThumb(img);
    await S.be.saveSelfie(img, blur);
    S.reveal[me()] = { name: S.account?.name, img };
    stopCamera();
    S.draft.status = S.profile?.status || '';
    S.draft.visible = true;
    go('status');
  });
}
function authMessage(e) {
  const c = e?.code || '';
  if (c.includes('invalid-verification-code') || c.includes('invalid-code')) return "That code didn't work. Check it and try again.";
  if (c.includes('code-expired')) return 'That code expired. Tap Resend code.';
  if (c.includes('too-many-requests')) return 'Too many tries. Wait a bit and try again.';
  if (c.includes('invalid-phone-number')) return 'Check your mobile number.';
  if (c.includes('popup-closed')) return 'Sign-in was cancelled.';
  if (c.includes('operation-not-allowed')) return 'This sign-in method is not turned on yet.';
  if (c.includes('billing')) return 'SMS sign-in needs the Firebase Blaze plan. Use Google for now.';
  return e?.message || 'Something went wrong. Try again.';
}
function kuhitMessage(e) {
  const m = e?.message || '';
  if (m.includes('out-of-kuhits')) return "You're out of kuhits today. Come back tomorrow.";
  if (m.includes('already') || e?.code === 'permission-denied') return "Couldn't send this kuhit. You may have kuhit them already.";
  return m || "Couldn't send. Try again.";
}

// Demo stand-ins when there's no camera (desktop browsers): drawn, not real photos.
function demoSelfie() {
  const c = document.createElement('canvas');
  c.width = c.height = 480;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 480, 480);
  gr.addColorStop(0, '#FFD60A'); gr.addColorStop(1, '#E63946');
  g.fillStyle = gr; g.fillRect(0, 0, 480, 480);
  g.fillStyle = 'rgba(17,17,17,.55)';
  g.beginPath(); g.arc(240, 200, 90, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(240, 480, 170, 150, 0, Math.PI, 0); g.fill();
  return c.toDataURL('image/jpeg', 0.85);
}
function demoIdImage() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#e8eefc'; g.fillRect(0, 0, 640, 400);
  g.fillStyle = '#1D4ED8'; g.fillRect(0, 0, 640, 70);
  g.fillStyle = '#f4a261'; g.fillRect(40, 110, 170, 210);
  g.fillStyle = '#9aa7c7';
  [120, 160, 200, 240, 280].forEach((y, i) => g.fillRect(250, y, 330 - i * 30, 18));
  return c.toDataURL('image/jpeg', 0.8);
}

// ---------- events ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { if (el.tagName === 'A' && !el.getAttribute('href')?.startsWith('#')) return; ev.preventDefault(); fn(el, ev); }
});
const onField = (ev) => {
  const el = ev.target;
  const k = el.dataset?.model;
  if (!k) return;
  if (el.dataset.live) { onLiveField(el, ev); return; }
  let v = el.value;
  if (S.draft[k] === v && ev.type === 'change') return;
  if (k === 'code') { v = v.replace(/\D/g, '').slice(0, 6); el.value = v; }
  S.draft[k] = v;
  if (k !== 'msg') { S.err = ''; render(); }
  if (k === 'code' && v.length === 6) ACTIONS['verify-code']();
};
// Sign-up fields update in place (no full re-render), so typing stays smooth.
function onLiveField(el, ev) {
  const k = el.dataset.model;
  const deleting = ev.inputType?.startsWith('delete');
  const caretAtEnd = el.selectionStart === el.value.length;
  if (k === 'phone') {
    // Someone typing the +63 themselves: leave "+", "+6", "+63", "6", "63" as typed until the number starts.
    if (/^\+?6?3?$/.test(el.value.replace(/\s/g, '')) && el.value.trim()) { S.draft.phone = ''; S.err = ''; refreshLive(); return; }
    let d = phoneDigits(el.value);
    // Backspacing over a space or the "+63 " should still remove a digit.
    if (deleting && d === (S.draft.phone || '') && caretAtEnd) d = d.slice(0, -1);
    S.draft.phone = d;
    const f = phoneDisplay(d);
    if (el.value !== f && caretAtEnd) el.value = f;
  } else if (k === 'bd') {
    let d = bdayDigits(el.value);
    if (deleting && d === (S.draft.bd || '') && caretAtEnd) d = d.slice(0, -1);
    S.draft.bd = d;
    const f = fmtBday(d);
    if (el.value !== f && caretAtEnd) el.value = f;
  } else {
    S.draft[k] = el.value;
  }
  S.err = '';
  refreshLive();
}
document.addEventListener('focusout', (ev) => {
  if (ev.target?.id === 'f-phone') {
    S.phoneTouched = true;
    refreshLive();
  }
});
document.addEventListener('input', onField);
document.addEventListener('change', onField);
document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('[data-form="send"]');
  if (!form) return;
  ev.preventDefault();
  const text = (S.draft.msg || '').trim();
  if (!text) return;
  S.draft.msg = '';
  const input = document.getElementById('f-msg');
  if (input) input.value = '';
  try { await S.be.sendMessage(parseHash().arg, text); } catch (e) { S.draft.msg = text; showToast("Couldn't send", e.message); render(); }
});
window.addEventListener('hashchange', () => { S.err = ''; S.sheet = null; render(); });
setInterval(() => {
  const r = parseHash().name;
  if (r === 'otp') { const el = document.getElementById('resend'); if (el && Date.now() < S.resendAt + 1000) render(true); }
  else if (['nearby', 'kuhits', 'chats'].includes(r) && !S.sheet) render(true); // keeps "x min ago" fresh
}, 30000);
setInterval(() => { if (parseHash().name === 'otp' && Date.now() < S.resendAt + 1500) render(true); }, 1000);

// Mark received kuhits as seen when the Kuhits tab or a kuhit is opened.
window.addEventListener('hashchange', () => {
  const { name, arg } = parseHash();
  if (name === 'kuhit' && arg) S.be?.markInboxSeen(arg);
});

// ---------- boot ----------
async function boot() {
  const cfg = window.KUHIT_FIREBASE_CONFIG;
  try {
    if (cfg) {
      const { createFirebaseBackend } = await import('./backend-firebase.js');
      S.be = await createFirebaseBackend(cfg);
    } else {
      const { createDemoBackend } = await import('./backend-demo.js');
      S.be = await createDemoBackend();
    }
  } catch (e) {
    $app.innerHTML = `<div class="pad col center-col fill"><div class="logo-k">K</div><h1 class="h2 center">Kuhit can't load</h1><p class="sub center">Check your connection and reload.</p><button class="btn btn-primary" onclick="location.reload()">Reload</button></div>`;
    console.error(e);
    return;
  }
  S.be.onAuth(async (u) => {
    const prev = S.user?.uid;
    S.user = u;
    S.booting = false;
    if (!u) { stopWatchers(); S.account = null; S.profile = null; render(); return; }
    if (prev === u.uid && S.account) return;
    S.account = undefined;
    render();
    let acc = null;
    try {
      acc = await S.be.getAccount();
      if (!acc && S.flow === 'signup' && S.draft.name && S.draft.birthdate) {
        await S.be.createAccount({ name: S.draft.name.trim(), birthdate: S.draft.birthdate, phone: S.draft.phoneE164 });
        acc = await S.be.getAccount();
      }
    } catch (e) { console.warn(e); S.err = e.message; }
    S.account = acc;
    if (!acc) { S.flow = 'signup'; if (u.displayName && !S.draft.name) S.draft.name = u.displayName.split(' ')[0]; }
    if (acc?.verified?.id) startWatchers();
    render();
  });
  render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot();
