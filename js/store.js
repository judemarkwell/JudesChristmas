// Data layer. The app only talks to this interface, so the same screens run against
// Firebase in real use and against js/mock-store.js (add ?mock to the URL) for testing.
//
// watch* functions call back with fresh data on every change and return an unsubscribe.
// A watch that isn't allowed (not approved yet, removed from a circle) calls back with null.

import { CONFIG } from './config.js';

const V = '10.12.2';

export async function createStore() {
  if (new URLSearchParams(location.search).has('mock')) {
    const { createMockStore } = await import('./mock-store.js');
    return createMockStore();
  }
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(CONFIG.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const { doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch,
    runTransaction, arrayUnion, arrayRemove } = F;

  const toUser = (u) => u && ({
    uid: u.uid,
    name: u.displayName || (u.email ? u.email.split('@')[0] : 'Friend'),
    photoURL: u.photoURL || '',
    email: u.email || '',
  });

  // A listener refused by the rules stops for good. Right after a write (creating a circle,
  // being approved), the first read can reach the server a moment before the write has
  // landed and be refused, so retry a few times before reporting "no access".
  const resilient = (listen, cb) => {
    let stop = null;
    let stopped = false;
    let tries = 0;
    let timer;
    const run = () => {
      stop = listen((v) => { tries = 0; cb(v); }, (err) => {
        if (stopped) return;
        if (err?.code === 'permission-denied' && tries < 5) {
          tries += 1;
          timer = setTimeout(run, 500 * 2 ** (tries - 1));
        } else {
          console.warn('Listener stopped', err);
          cb(null);
        }
      });
    };
    run();
    return () => { stopped = true; clearTimeout(timer); stop?.(); };
  };
  const watchDoc = (ref, cb) => resilient((ok, fail) => onSnapshot(ref,
    (s) => ok(s.exists() ? { id: s.id, ...s.data() } : null), fail), cb);
  const watchCol = (ref, cb) => resilient((ok, fail) => onSnapshot(ref,
    (s) => ok(s.docs.map((d) => ({ id: d.id, ...d.data() }))), fail), cb);
  const strip = ({ id, ...rest }) => rest;

  return {
    mode: 'firebase',

    // ----- auth -----
    onAuth(cb) { return A.onAuthStateChanged(auth, (u) => cb(toUser(u))); },
    // Popup only. The redirect flow can't work here: the site (github.io) and Firebase's sign-in
    // page (firebaseapp.com) are different sites, and Safari, Firefox and Chrome block the storage
    // the redirect needs ("missing initial state"). If the popup is blocked, the app explains.
    async signIn() {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await A.signInWithPopup(auth, provider);
      } catch (err) {
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
        throw err;
      }
    },
    signOut() { return A.signOut(auth); },

    // Creates the profile and circle index the first time someone signs in.
    async ensureAccount(user) {
      const pRef = doc(db, 'users', user.uid);
      const iRef = doc(db, 'index', user.uid);
      const [p, i] = await Promise.all([getDoc(pRef), getDoc(iRef)]);
      if (!p.exists()) {
        await setDoc(pRef, {
          name: user.name, photoURL: user.photoURL, birthday: '', visibility: 'circle',
          sizes: {}, favorites: {}, avoid: '', payback: {}, createdAt: Date.now(),
        });
      }
      if (!i.exists()) await setDoc(iRef, { circles: [], changed: '' });
    },

    // ----- circles -----
    // Only act on the server's copy, so a circle isn't opened before its write has landed.
    watchIndex(uid, cb) {
      return resilient((ok, fail) => onSnapshot(doc(db, 'index', uid), (s) => {
        if (s.metadata.hasPendingWrites) return;
        ok(s.exists() ? s.data().circles || [] : []);
      }, fail), cb);
    },
    watchCircle(cid, cb) { return watchDoc(doc(db, 'circles', cid), cb); },
    watchMembers(cid, cb) { return watchCol(collection(db, 'circles', cid, 'members'), cb); },
    watchMembership(cid, uid, cb) { return watchDoc(doc(db, 'circles', cid, 'members', uid), cb); },

    async createCircle(user, name) {
      const ref = doc(collection(db, 'circles'));
      const code = newCode();
      const b = writeBatch(db);
      b.set(ref, { name, createdBy: user.uid, inviteCode: code, createdAt: Date.now() });
      b.set(doc(db, 'circles', ref.id, 'members', user.uid), {
        name: user.name, photoURL: user.photoURL || '', role: 'admin', status: 'active', joinedAt: Date.now(),
      });
      b.update(doc(db, 'index', user.uid), { circles: arrayUnion(ref.id), changed: ref.id });
      b.set(doc(db, 'invites', code), { circleId: ref.id, circleName: name, createdBy: user.uid });
      await b.commit();
      return { id: ref.id, code };
    },
    async renameCircle(cid, name) { await updateDoc(doc(db, 'circles', cid), { name }); },
    async newInvite(user, circle) {
      const code = newCode();
      const b = writeBatch(db);
      b.set(doc(db, 'invites', code), { circleId: circle.id, circleName: circle.name || '', createdBy: user.uid });
      b.update(doc(db, 'circles', circle.id), { inviteCode: code });
      if (circle.inviteCode) b.delete(doc(db, 'invites', circle.inviteCode));
      await b.commit();
      return code;
    },
    async getInvite(code) {
      try {
        const s = await getDoc(doc(db, 'invites', code));
        return s.exists() ? { code, ...s.data() } : null;
      } catch { return null; }
    },
    async requestJoin(user, invite) {
      await setDoc(doc(db, 'circles', invite.circleId, 'members', user.uid), {
        name: user.name, photoURL: user.photoURL || '', role: 'member', status: 'pending',
        code: invite.code, requestedAt: Date.now(),
      });
    },
    async approve(cid, uid) {
      const b = writeBatch(db);
      b.update(doc(db, 'circles', cid, 'members', uid), { status: 'active' });
      b.update(doc(db, 'index', uid), { circles: arrayUnion(cid), changed: cid });
      await b.commit();
    },
    async setRole(cid, uid, role) { await updateDoc(doc(db, 'circles', cid, 'members', uid), { role }); },
    // Decline a request, remove a member, or leave (uid = yourself).
    async removeMember(cid, uid, wasActive) {
      const b = writeBatch(db);
      b.delete(doc(db, 'circles', cid, 'members', uid));
      if (wasActive) b.update(doc(db, 'index', uid), { circles: arrayRemove(cid), changed: cid });
      await b.commit();
    },
    async updateMyMemberships(uid, cids, patch) {
      const b = writeBatch(db);
      cids.forEach((cid) => b.update(doc(db, 'circles', cid, 'members', uid), patch));
      await b.commit();
    },

    // ----- profiles -----
    watchProfile(uid, cb) { return watchDoc(doc(db, 'users', uid), cb); },
    async saveProfile(uid, profile) { await setDoc(doc(db, 'users', uid), strip(profile)); },

    // ----- wishlists -----
    watchItems(uid, cb) {
      return watchCol(collection(db, 'users', uid, 'items'),
        (list) => cb(list && list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))));
    },
    async saveItem(uid, item) { await setDoc(doc(db, 'users', uid, 'items', item.id), strip(item)); },
    async saveItems(uid, items) {
      const b = writeBatch(db);
      items.forEach((it) => b.set(doc(db, 'users', uid, 'items', it.id), strip(it)));
      await b.commit();
    },
    async deleteItem(uid, id) { await deleteDoc(doc(db, 'users', uid, 'items', id)); },

    // ----- claims (never requested for your own list) -----
    watchClaims(owner, cb) {
      return resilient((ok, fail) => onSnapshot(collection(db, 'users', owner, 'claims'), (s) => {
        const out = {};
        s.forEach((d) => { out[d.id] = d.data(); });
        ok(out);
      }, fail), cb);
    },
    async claim(owner, itemId, data) {
      const ref = doc(db, 'users', owner, 'claims', itemId);
      await runTransaction(db, async (tx) => {
        const s = await tx.get(ref);
        if (s.exists()) throw new Error('already-claimed');
        tx.set(ref, { purchased: false, note: '', ...data, owner, claimedAt: Date.now() });
      });
    },
    async updateClaim(owner, itemId, patch) { await updateDoc(doc(db, 'users', owner, 'claims', itemId), patch); },
    async unclaim(owner, itemId) { await deleteDoc(doc(db, 'users', owner, 'claims', itemId)); },

    // Only the creator can do this (enforced by the rules). Removes everyone first, in small
    // batches so each stays well inside the rules' per-write lookup limit, then the circle.
    async disbandCircle(cid, { uid, members, memories, inviteCode }) {
      for (const m of members.filter((x) => x.id !== uid)) {
        const b = writeBatch(db);
        b.delete(doc(db, 'circles', cid, 'members', m.id));
        if (m.status === 'active') b.update(doc(db, 'index', m.id), { circles: arrayRemove(cid), changed: cid });
        await b.commit();
      }
      for (let i = 0; i < memories.length; i += 20) {
        const b = writeBatch(db);
        memories.slice(i, i + 20).forEach((m) => b.delete(doc(db, 'circles', cid, 'memories', m.id)));
        await b.commit();
      }
      const b = writeBatch(db);
      b.delete(doc(db, 'circles', cid, 'members', uid));
      b.update(doc(db, 'index', uid), { circles: arrayRemove(cid), changed: cid });
      if (inviteCode) b.delete(doc(db, 'invites', inviteCode));
      b.delete(doc(db, 'circles', cid));
      await b.commit();
    },

    // ----- profile memories -----
    watchProfileMemories(uid, cb) { return watchCol(collection(db, 'users', uid, 'memories'), cb); },
    async addProfileMemory(uid, memory) {
      await setDoc(doc(collection(db, 'users', uid, 'memories')), { ...memory, createdAt: Date.now() });
    },
    async deleteProfileMemory(uid, id) { await deleteDoc(doc(db, 'users', uid, 'memories', id)); },

    // ----- memories -----
    watchMemories(cid, cb) { return watchCol(collection(db, 'circles', cid, 'memories'), cb); },
    async addMemory(cid, memory) {
      await setDoc(doc(collection(db, 'circles', cid, 'memories')), { ...memory, createdAt: Date.now() });
    },
    async deleteMemory(cid, id) { await deleteDoc(doc(db, 'circles', cid, 'memories', id)); },
  };
}

// 16 random letters and digits: unguessable invite codes.
export function newCode() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}
