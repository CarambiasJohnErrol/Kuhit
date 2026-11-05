// Firebase backend: Auth (phone OTP, Google) + Firestore. No Cloud Functions and no paid
// Cloud Storage: every privacy rule (mutual reveal, blurred until mutual, daily kuhit limit,
// selfie expiry) is enforced by firestore.rules, so read that file next to this one.
//
// users/<uid>                 private account: name, birthdate, phone, verification (owner only)
// names/<uid>                 first name, readable by the owner and their mutual matches
// selfies/<uid>               today's clear selfie, readable by the owner and matches for 24 h
// profiles/<uid>              what people nearby see: blurred thumb, status, ~100 m location
// kuhits/<from>_<to>          a kuhit, readable only by the person who sent it
// inbox/<to>/items/<from>     "someone kuhit you": type and time, read by the receiver
// limits/<uid>                today's kuhit count (max 5), can only go up by one per kuhit
// matches/<a>_<b>             a mutual kuhit (a < b), and its chat in /messages
// blocks/<uid>                who this person blocked
// reports/<id>                block and report reasons, create only

import { geohash, nearbyCells, manilaDay, roundCoord } from './geo.js';

const V = '10.12.2';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export const DAILY_KUHITS = 5;

export async function createFirebaseBackend(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  auth.useDeviceLanguage();
  const db = F.getFirestore(app);
  const { doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy,
    limit, limitToLast, writeBatch, runTransaction, serverTimestamp, Timestamp, arrayUnion, arrayRemove,
    getDocs, deleteField } = F;

  const me = () => auth.currentUser?.uid;
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : t ?? null);
  const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  let verifier = null;
  let confirmation = null;

  const api = {
    mode: 'firebase',
    DAILY_KUHITS,

    onAuth(cb) {
      return A.onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, phone: u.phoneNumber, email: u.email, displayName: u.displayName } : null));
    },

    async startPhone(phone, anchor) {
      if (!verifier) verifier = new A.RecaptchaVerifier(auth, anchor, { size: 'invisible' });
      confirmation = await A.signInWithPhoneNumber(auth, phone, verifier);
    },
    async confirmCode(code) {
      if (!confirmation) throw new Error('Send the code first.');
      await confirmation.confirm(code);
    },
    async signInGoogle() {
      await A.signInWithPopup(auth, new A.GoogleAuthProvider());
    },
    signOut: () => A.signOut(auth),

    async getAccount() {
      const s = await getDoc(doc(db, 'users', me()));
      if (!s.exists()) return null;
      const d = s.data();
      return { ...d, birthdate: d.birthdateText || '', createdAt: ms(d.createdAt) };
    },
    async createAccount({ name, birthdate, phone }) {
      const b = writeBatch(db);
      b.set(doc(db, 'users', me()), {
        name, phone: phone || auth.currentUser.phoneNumber || null,
        birthdate: Timestamp.fromDate(new Date(`${birthdate}T00:00:00+08:00`)),
        birthdateText: birthdate,
        verified: null,
        createdAt: serverTimestamp(),
      });
      b.set(doc(db, 'names', me()), { name });
      await b.commit();
    },
    async setVerified({ face, id, idType }) {
      // Placeholder until a verification partner (Yoti, Persona, Veriff) is connected:
      // the partner, not the app, should set this through a server.
      await updateDoc(doc(db, 'users', me()), {
        verified: { face: !!face, id: !!id, idType: idType || null, mode: 'placeholder', at: serverTimestamp() },
      });
    },

    watchProfile(cb) {
      return onSnapshot(doc(db, 'profiles', me()), (s) => {
        if (!s.exists()) return cb(null);
        const d = s.data();
        cb({ ...d, selfieAt: ms(d.selfieAt), seenAt: ms(d.seenAt) });
      }, () => cb(null));
    },
    async saveSelfie(img, blur) {
      const b = writeBatch(db);
      b.set(doc(db, 'selfies', me()), { img, at: serverTimestamp() });
      b.set(doc(db, 'profiles', me()), { blur, selfieAt: serverTimestamp() }, { merge: true });
      await b.commit();
    },
    async getSelfie(uid) {
      try {
        const s = await getDoc(doc(db, 'selfies', uid));
        if (!s.exists()) return null;
        const d = s.data();
        return { img: d.img, at: ms(d.at) };
      } catch { return null; } // not a match, or older than 24 h
    },
    async getProfile(uid) {
      try {
        const s = await getDoc(doc(db, 'profiles', uid));
        if (!s.exists()) return null;
        const x = s.data();
        return { uid, status: x.status || '', blur: x.blur || null, visible: !!x.visible,
          selfieAt: ms(x.selfieAt), seenAt: ms(x.seenAt), lat: x.lat, lng: x.lng };
      } catch { return null; }
    },
    async getName(uid) {
      try {
        const s = await getDoc(doc(db, 'names', uid));
        return s.exists() ? s.data().name : null;
      } catch { return null; }
    },
    async updateProfile(patch) {
      const allowed = {};
      if ('status' in patch) allowed.status = String(patch.status || '').slice(0, 40);
      if ('visible' in patch) allowed.visible = !!patch.visible;
      await setDoc(doc(db, 'profiles', me()), allowed, { merge: true });
    },
    async updateLocation(lat, lng) {
      lat = roundCoord(lat); lng = roundCoord(lng);
      await setDoc(doc(db, 'profiles', me()),
        { lat, lng, cell: geohash(lat, lng), seenAt: serverTimestamp() }, { merge: true });
    },
    async clearLocation() {
      await setDoc(doc(db, 'profiles', me()),
        { lat: deleteField(), lng: deleteField(), cell: deleteField(), visible: false }, { merge: true });
    },

    watchNearby({ lat, lng }, cb) {
      const q = query(collection(db, 'profiles'), where('cell', 'in', nearbyCells(lat, lng)), limit(50));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.filter((d) => d.id !== me()).map((d) => {
          const x = d.data();
          return { uid: d.id, status: x.status || '', blur: x.blur || null, visible: !!x.visible,
            selfieAt: ms(x.selfieAt), seenAt: ms(x.seenAt), lat: x.lat, lng: x.lng };
        }));
      }, (e) => { console.warn('nearby', e); cb([]); });
    },

    watchLimit(cb) {
      return onSnapshot(doc(db, 'limits', me()), (s) => cb(s.exists() ? s.data() : { day: 0, count: 0 }),
        () => cb({ day: 0, count: 0 }));
    },

    async sendKuhit(to, type) {
      const uid = me();
      const id = `${uid}_${to}`;
      const limRef = doc(db, 'limits', uid);
      await runTransaction(db, async (tx) => {
        const lim = await tx.get(limRef);
        const today = manilaDay();
        const cur = lim.exists() && lim.data().day === today ? lim.data().count : 0;
        if (cur >= DAILY_KUHITS) throw new Error('out-of-kuhits');
        tx.set(doc(db, 'kuhits', id), { from: uid, to, type, at: serverTimestamp() });
        tx.set(limRef, { day: today, count: cur + 1, last: id });
        tx.set(doc(db, 'inbox', to, 'items', uid), { from: uid, type, at: serverTimestamp(), seen: false });
      });
    },
    // Called when you kuhit back someone whose kuhit is in your inbox: firestore.rules only
    // allows it when both kuhits exist, so a match can't be faked.
    async createMatch(other, myType, theirType) {
      const uid = me();
      const members = [uid, other].sort();
      const id = members.join('_');
      const types = { [uid]: myType, [other]: theirType };
      await setDoc(doc(db, 'matches', id), {
        members, types, crush: myType === 'crush' && theirType === 'crush',
        at: serverTimestamp(), lastAt: serverTimestamp(), lastText: '', lastFrom: '',
      });
      return id;
    },

    watchInbox(cb) {
      return onSnapshot(collection(db, 'inbox', me(), 'items'), (snap) =>
        cb(snap.docs.map((d) => ({ ...d.data(), from: d.id, at: ms(d.data().at) }))), () => cb([]));
    },
    markInboxSeen(from) {
      return updateDoc(doc(db, 'inbox', me(), 'items', from), { seen: true }).catch(() => {});
    },
    watchSent(cb) {
      return onSnapshot(query(collection(db, 'kuhits'), where('from', '==', me())), (snap) =>
        cb(snap.docs.map((d) => ({ ...d.data(), at: ms(d.data().at) }))), () => cb([]));
    },
    watchMatches(cb) {
      return onSnapshot(query(collection(db, 'matches'), where('members', 'array-contains', me())), (snap) =>
        cb(snap.docs.map((d) => {
          const x = d.data();
          return { ...x, id: d.id, at: ms(x.at), lastAt: ms(x.lastAt) };
        })), () => cb([]));
    },
    watchMessages(matchId, cb) {
      const q = query(collection(db, 'matches', matchId, 'messages'), orderBy('at'), limitToLast(300));
      return onSnapshot(q, (snap) =>
        cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), at: ms(d.data().at) ?? Date.now() }))), () => cb([]));
    },
    async sendMessage(matchId, text) {
      text = String(text).trim().slice(0, 500);
      if (!text) return;
      const b = writeBatch(db);
      b.set(doc(collection(db, 'matches', matchId, 'messages')), { from: me(), text, at: serverTimestamp() });
      b.update(doc(db, 'matches', matchId), { lastAt: serverTimestamp(), lastText: text.slice(0, 80), lastFrom: me() });
      await b.commit();
    },

    watchBlocks(cb) {
      return onSnapshot(doc(db, 'blocks', me()), (s) => cb(s.exists() ? { ids: [], names: {}, ...s.data() } : { ids: [], names: {} }),
        () => cb({ ids: [], names: {} }));
    },
    async block(uid, name) {
      await setDoc(doc(db, 'blocks', me()), { ids: arrayUnion(uid), names: { [uid]: name || 'Someone' } }, { merge: true });
      await deleteDoc(doc(db, 'matches', pairId(me(), uid))).catch(() => {});
    },
    async unblock(uid) {
      await setDoc(doc(db, 'blocks', me()), { ids: arrayRemove(uid), names: { [uid]: deleteField() } }, { merge: true });
    },
    async report({ about, reason, matchId }) {
      await setDoc(doc(collection(db, 'reports')), { from: me(), about, reason, matchId: matchId || null, at: serverTimestamp() });
    },

    async exportData() {
      const uid = me();
      const get = async (path) => { try { const s = await getDoc(doc(db, ...path)); return s.exists() ? s.data() : null; } catch { return null; } };
      const list = async (q) => { try { return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() })); } catch { return []; } };
      return {
        account: await get(['users', uid]),
        profile: await get(['profiles', uid]),
        kuhitsSent: await list(query(collection(db, 'kuhits'), where('from', '==', uid))),
        kuhitsReceived: await list(collection(db, 'inbox', uid, 'items')),
        matches: await list(query(collection(db, 'matches'), where('members', 'array-contains', uid))),
        blocks: await get(['blocks', uid]),
      };
    },

    async deleteAccount() {
      const uid = me();
      const del = (ref) => deleteDoc(ref).catch(() => {});
      const sent = await getDocs(query(collection(db, 'kuhits'), where('from', '==', uid))).catch(() => ({ docs: [] }));
      for (const d of sent.docs) {
        await del(doc(db, 'inbox', d.data().to, 'items', uid));
        await del(d.ref);
      }
      const inbox = await getDocs(collection(db, 'inbox', uid, 'items')).catch(() => ({ docs: [] }));
      for (const d of inbox.docs) await del(d.ref);
      const matches = await getDocs(query(collection(db, 'matches'), where('members', 'array-contains', uid))).catch(() => ({ docs: [] }));
      for (const d of matches.docs) await del(d.ref);
      for (const c of ['profiles', 'selfies', 'names', 'blocks', 'users']) await del(doc(db, c, uid));
      // limits/<uid> stays (it can't be deleted), so deleting and re-joining can't reset the daily limit.
      try {
        await auth.currentUser.delete();
      } catch (e) {
        await A.signOut(auth);
        if (e.code !== 'auth/requires-recent-login') throw e;
      }
    },
  };
  return api;
}
