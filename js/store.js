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

  // Claims made before claim details were split out kept the name and note on the marker.
  // The person who made one moves those details into claimDetails the next time they open the app.
  const migrating = new Set();
  function migrateClaim(owner, itemId, data) {
    const extra = Object.keys(data).some((k) => !['by', 'owner', 'claimedAt'].includes(k));
    const key = `${owner}/${itemId}`;
    if (!extra || data.by !== auth.currentUser?.uid || migrating.has(key)) return;
    migrating.add(key);
    const b = writeBatch(db);
    b.set(doc(db, 'users', owner, 'claimDetails', itemId), { purchased: false, note: '', ...data });
    b.set(doc(db, 'users', owner, 'claims', itemId), { by: data.by, owner: data.owner || owner, claimedAt: data.claimedAt || Date.now() });
    b.commit().catch((err) => console.warn('Claim migration failed', err)).finally(() => migrating.delete(key));
  }

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
    // A claim is two documents:
    //   claims/{itemId}        a marker that the item is taken: { by, owner, claimedAt }.
    //                          Everyone who shares a circle with the owner can read it.
    //   claimDetails/{itemId}  who, their note, and whether it's bought. Readable only by
    //                          people who also share a circle with the person who claimed it.
    // So a gift claimed in one circle shows as taken in every circle, but people in other
    // circles just see "claimed by someone in another circle".
    watchClaims(owner, cb) {
      const markers = {};
      const details = {};
      const detailSubs = {};
      let ready = false;
      const emit = () => {
        if (!ready) return;
        const out = {};
        for (const [id, m] of Object.entries(markers)) {
          const d = details[id];
          out[id] = d === undefined ? { ...m, loading: true } : d === null ? { ...m, hidden: true } : { ...d, ...m };
        }
        cb(out);
      };
      const watchDetail = (id, by) => {
        let tries = 0;
        const listen = () => onSnapshot(doc(db, 'users', owner, 'claimDetails', id), (s) => {
          details[id] = s.exists() ? s.data() : null;
          emit();
        }, (err) => {
          // Your own brand-new claim can be read a moment before its write lands: retry briefly.
          if (err?.code === 'permission-denied' && by === auth.currentUser?.uid && tries < 3) {
            tries += 1;
            detailSubs[id] = setTimeout(() => { detailSubs[id] = listen(); }, 400 * tries);
            return;
          }
          details[id] = null;
          emit();
        });
        detailSubs[id] = listen();
      };
      const stopDetail = (id) => {
        const s = detailSubs[id];
        if (typeof s === 'function') s(); else clearTimeout(s);
        delete detailSubs[id];
        delete details[id];
      };
      const stopMarkers = resilient((ok, fail) => onSnapshot(collection(db, 'users', owner, 'claims'), (s) => {
        const seen = new Set();
        s.forEach((d) => {
          const data = d.data();
          seen.add(d.id);
          migrateClaim(owner, d.id, data);
          markers[d.id] = { by: data.by, owner: data.owner, claimedAt: data.claimedAt };
          if (!(d.id in detailSubs)) watchDetail(d.id, data.by);
        });
        for (const id of Object.keys(markers)) if (!seen.has(id)) { delete markers[id]; stopDetail(id); }
        ready = true;
        ok();
      }, fail), (v) => { if (v === null) cb(null); else emit(); });
      return () => { stopMarkers(); Object.keys(detailSubs).forEach(stopDetail); };
    },
    async claim(owner, itemId, data) {
      const marker = doc(db, 'users', owner, 'claims', itemId);
      const detail = doc(db, 'users', owner, 'claimDetails', itemId);
      const by = auth.currentUser.uid;
      await runTransaction(db, async (tx) => {
        const s = await tx.get(marker);
        if (s.exists()) throw new Error('already-claimed');
        const claimedAt = Date.now();
        tx.set(marker, { by, owner, claimedAt });
        tx.set(detail, { purchased: false, note: '', ...data, by, owner, claimedAt });
      });
    },
    async updateClaim(owner, itemId, patch) {
      await updateDoc(doc(db, 'users', owner, 'claimDetails', itemId), patch);
    },
    async unclaim(owner, itemId) {
      const b = writeBatch(db);
      b.delete(doc(db, 'users', owner, 'claimDetails', itemId));
      b.delete(doc(db, 'users', owner, 'claims', itemId));
      await b.commit();
    },

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
