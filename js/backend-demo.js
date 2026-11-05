// Demo backend: runs when firebase-config.js is null. Everything lives in this browser's
// localStorage, and a few simulated people around you kuhit, kuhit back and chat, so every
// screen can be tried on one phone. Same interface as backend-firebase.js.

import { manilaDay } from './geo.js';

const KEY = 'kuhit-demo-v1';
export const DAILY_KUHITS = 5;

const PEOPLE = [
  { uid: 'd-aya', name: 'Aya', status: 'Kape buddy? Naa ko sa Centrio', m: 40, ago: 2, hue: [28, 340], kuhitsMe: 'friendly' },
  { uid: 'd-jonas', name: 'Jonas', status: 'Bored sa jeep padulong Cogon', m: 70, ago: 1, hue: [200, 250], backs: 'friendly' },
  { uid: 'd-bea', name: 'Bea', status: 'Study mo later? XU library', m: 150, ago: 6, hue: [300, 20], kuhitsMe: 'crush' },
  { uid: 'd-migs', name: 'Migs', status: 'New in CDO, tour me?', m: 320, ago: 9, hue: [140, 190] },
  { uid: 'd-rica', name: 'Rica', status: 'Naghulat ug ulan mohunong', m: 520, ago: 4, hue: [45, 10], backs: 'crush' },
  { uid: 'd-paolo', name: 'Paolo', status: 'Basketball later sa Pelaez?', m: 950, ago: 12, hue: [230, 180] },
];

const REPLIES = [
  'Hala hi! 😄', 'Uy, kumusta?', 'Haha naa ra ko diri duol', 'Asa ka padulong?', 'Sige, kape ta later?',
  'Taga asa ka diay?', 'Wow same! 😂', 'Ganahan ko ana', 'Chill ra, ikaw?',
];

function selfieSvg(p, clear) {
  const [a, b] = p.hue;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 85% 62%)"/><stop offset="1" stop-color="hsl(${b} 80% 55%)"/></linearGradient></defs><rect width="120" height="120" fill="url(#g)"/><circle cx="60" cy="50" r="22" fill="hsl(${a} 40% 30%)" opacity=".55"/><path d="M18 120c4-26 22-38 42-38s38 12 42 38z" fill="hsl(${b} 40% 25%)" opacity=".55"/>${clear ? `<text x="60" y="58" font-family="Archivo Black, sans-serif" font-size="26" text-anchor="middle" fill="#fff">${p.name[0]}</text>` : ''}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export async function createDemoBackend() {
  let db = load();
  const subs = new Set();
  const emit = () => { save(); subs.forEach((f) => f()); };
  const watch = (fn) => { subs.add(fn); fn(); return () => subs.delete(fn); };
  let authCb = null;
  let pendingPhone = null;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { return fresh(); }
  }
  function fresh() {
    return { user: null, account: null, profile: null, selfie: null, inbox: [], sent: [], matches: [],
      messages: {}, blocks: { ids: [], names: {} }, limit: { day: 0, count: 0 }, reports: [] };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage full or blocked */ }
  }
  const person = (uid) => PEOPLE.find((p) => p.uid === uid);
  const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  function seedInbox() {
    const now = Date.now();
    db.inbox = PEOPLE.filter((p) => p.kuhitsMe).map((p, i) =>
      ({ from: p.uid, type: p.kuhitsMe, at: now - (i * 7 + 5) * 60000, seen: false }));
  }

  function addMatch(other, myType, theirType, at = Date.now()) {
    const id = pairId('me', other);
    if (db.matches.some((m) => m.id === id)) return id;
    db.matches.push({ id, members: ['me', other].sort(), types: { me: myType, [other]: theirType },
      crush: myType === 'crush' && theirType === 'crush', at, lastAt: at, lastText: '', lastFrom: '' });
    return id;
  }

  const api = {
    mode: 'demo',
    DAILY_KUHITS,

    onAuth(cb) {
      authCb = cb;
      setTimeout(() => cb(db.user), 0);
      return () => { authCb = null; };
    },
    async startPhone(phone) { pendingPhone = phone; await wait(500); },
    async confirmCode(code) {
      await wait(400);
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code.');
      db.user = { uid: 'me', phone: pendingPhone || '+639170000000' };
      emit(); authCb?.(db.user);
    },
    async signInGoogle() {
      await wait(300);
      db.user = { uid: 'me', email: 'demo@kuhit.app', displayName: 'Demo' };
      emit(); authCb?.(db.user);
    },
    async signOut() { db.user = null; emit(); authCb?.(null); },

    async getAccount() { return db.account; },
    async createAccount({ name, birthdate, phone }) {
      db.account = { name, birthdate, phone: phone || db.user?.phone || null, verified: null, createdAt: Date.now() };
      seedInbox();
      emit();
    },
    async setVerified({ face, id, idType }) {
      db.account.verified = { face, id, idType, mode: 'demo', at: Date.now() };
      emit();
    },

    watchProfile(cb) { return watch(() => cb(db.profile ? { ...db.profile } : null)); },
    async saveSelfie(img, blur) {
      db.selfie = { img, at: Date.now() };
      db.profile = { visible: true, status: '', ...db.profile, blur, selfieAt: Date.now() };
      emit();
    },
    async getSelfie(uid) {
      if (uid === 'me') return db.selfie;
      const p = person(uid);
      if (!p || !db.matches.some((m) => m.id === pairId('me', uid))) return null;
      return { img: selfieSvg(p, true), at: Date.now() };
    },
    async getProfile(uid) {
      const p = person(uid);
      if (!p) return null;
      return { uid, status: p.status, blur: selfieSvg(p, false), visible: true, selfieAt: Date.now() - 3 * 3600000,
        seenAt: Date.now() - p.ago * 60000, lat: null, lng: null };
    },
    async getName(uid) {
      if (uid === 'me') return db.account?.name || null;
      const p = person(uid);
      return p && db.matches.some((m) => m.id === pairId('me', uid)) ? p.name : null;
    },
    async updateProfile(patch) {
      db.profile = { visible: false, status: '', ...db.profile };
      if ('status' in patch) db.profile.status = String(patch.status || '').slice(0, 40);
      if ('visible' in patch) db.profile.visible = !!patch.visible;
      emit();
    },
    async updateLocation(lat, lng) {
      db.profile = { visible: false, status: '', ...db.profile, lat, lng, seenAt: Date.now() };
      save();
    },
    async clearLocation() {
      if (db.profile) { delete db.profile.lat; delete db.profile.lng; db.profile.visible = false; }
      emit();
    },

    watchNearby({ lat, lng }, cb) {
      const send = () => {
        const now = Date.now();
        cb(PEOPLE.map((p, i) => {
          const ang = (i * 137) * Math.PI / 180;
          return { uid: p.uid, status: p.status, blur: selfieSvg(p, false), visible: true,
            selfieAt: now - 3 * 3600000, seenAt: now - p.ago * 60000,
            lat: lat + (p.m * Math.cos(ang)) / 111320, lng: lng + (p.m * Math.sin(ang)) / (111320 * Math.cos(lat * Math.PI / 180)) };
        }));
      };
      const t = setTimeout(send, 700); // short delay so the "looking around" state shows
      return () => clearTimeout(t);
    },

    watchLimit(cb) { return watch(() => cb({ ...db.limit })); },

    async sendKuhit(to, type) {
      await wait(250);
      const today = manilaDay();
      const cur = db.limit.day === today ? db.limit.count : 0;
      if (cur >= DAILY_KUHITS) throw new Error('out-of-kuhits');
      if (db.sent.some((k) => k.to === to)) throw new Error('already-sent');
      if (db.blocks.ids.includes(to)) throw new Error('blocked');
      db.sent.push({ from: 'me', to, type, at: Date.now() });
      db.limit = { day: today, count: cur + 1, last: `me_${to}` };
      emit();
      // Simulate someone who kuhits back a few seconds later.
      const p = person(to);
      if (p?.backs && !db.inbox.some((i) => i.from === to)) {
        setTimeout(() => {
          if (db.blocks.ids.includes(to)) return;
          db.inbox.push({ from: to, type: p.backs, at: Date.now(), seen: true });
          addMatch(to, type, p.backs);
          emit();
        }, 4500);
      }
    },
    async createMatch(other, myType, theirType) {
      const id = addMatch(other, myType, theirType);
      emit();
      return id;
    },

    watchInbox(cb) { return watch(() => cb(db.inbox.map((x) => ({ ...x })))); },
    async markInboxSeen(from) {
      const i = db.inbox.find((x) => x.from === from);
      if (i && !i.seen) { i.seen = true; emit(); }
    },
    watchSent(cb) { return watch(() => cb(db.sent.map((x) => ({ ...x })))); },
    watchMatches(cb) { return watch(() => cb(db.matches.map((x) => ({ ...x })))); },
    watchMessages(matchId, cb) { return watch(() => cb((db.messages[matchId] || []).map((x) => ({ ...x })))); },
    async sendMessage(matchId, text) {
      text = String(text).trim().slice(0, 500);
      if (!text) return;
      const m = db.matches.find((x) => x.id === matchId);
      if (!m) throw new Error('This chat has closed.');
      const push = (from, t) => {
        (db.messages[matchId] ||= []).push({ id: `${Date.now()}-${Math.random()}`, from, text: t, at: Date.now() });
        Object.assign(m, { lastAt: Date.now(), lastText: t.slice(0, 80), lastFrom: from });
        emit();
      };
      push('me', text);
      const other = m.members.find((u) => u !== 'me');
      setTimeout(() => {
        if (!db.matches.includes(m)) return;
        push(other, REPLIES[Math.floor(Math.random() * REPLIES.length)]);
      }, 1800);
    },

    watchBlocks(cb) { return watch(() => cb({ ids: [...db.blocks.ids], names: { ...db.blocks.names } })); },
    async block(uid, name) {
      if (!db.blocks.ids.includes(uid)) db.blocks.ids.push(uid);
      db.blocks.names[uid] = name || 'Someone';
      db.matches = db.matches.filter((m) => m.id !== pairId('me', uid));
      emit();
    },
    async unblock(uid) {
      db.blocks.ids = db.blocks.ids.filter((x) => x !== uid);
      delete db.blocks.names[uid];
      emit();
    },
    async report(r) { db.reports.push({ ...r, at: Date.now() }); emit(); },

    async exportData() {
      const { user, account, profile, sent, inbox, matches, blocks } = db;
      return { user, account, profile, kuhitsSent: sent, kuhitsReceived: inbox, matches, blocks };
    },
    async deleteAccount() {
      db = fresh();
      emit(); authCb?.(null);
    },
  };
  return api;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
