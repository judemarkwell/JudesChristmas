// Offline stand-in for Firebase, used when the URL has ?mock (local testing only).
// Everything lives in this browser's localStorage, shared between tabs, so two tabs with
// ?mock&as=jude and ?mock&as=mom behave like two people. It mirrors the main rules:
// you only see people you share a circle with, and never the claims on your own list.

import { newCode } from './store.js';

const KEY = 'mock.db';
const blank = () => ({ users: {}, index: {}, circles: {}, invites: {}, items: {}, claims: {}, pmem: {} });
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { return blank(); } };
const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

export function createMockStore() {
  const params = new URLSearchParams(location.search);
  const as = (params.get('as') || 'jude').toLowerCase();
  const me = {
    uid: `u-${as}`,
    name: as.charAt(0).toUpperCase() + as.slice(1),
    photoURL: '',
    email: `${as}@example.com`,
  };
  const signedKey = `mock.signedIn.${as}`;
  const watchers = new Set();
  const authCbs = new Set();

  const emit = () => watchers.forEach((w) => w());
  window.addEventListener('storage', (e) => { if (e.key === KEY) emit(); });
  const mutate = (fn) => { const db = load(); const r = fn(db); save(db); emit(); return r; };
  const watch = (read, cb) => {
    let last;
    const w = () => {
      const v = read(load());
      const s = JSON.stringify(v);
      if (s !== last) { last = s; cb(clone(v)); }
    };
    watchers.add(w);
    setTimeout(w, 0);
    return () => watchers.delete(w);
  };
  const circlesOf = (db, uid) => db.index[uid]?.circles || [];
  const shares = (db, uid) => circlesOf(db, me.uid).some((c) => circlesOf(db, uid).includes(c));
  const active = (db, cid, uid) => db.circles[cid]?.members?.[uid]?.status === 'active';
  const isSignedIn = () => localStorage.getItem(signedKey) === '1';

  return {
    mode: 'mock',
    onAuth(cb) { authCbs.add(cb); setTimeout(() => cb(isSignedIn() ? { ...me } : null), 0); return () => authCbs.delete(cb); },
    async signIn() { localStorage.setItem(signedKey, '1'); authCbs.forEach((cb) => cb({ ...me })); },
    async signOut() { localStorage.removeItem(signedKey); authCbs.forEach((cb) => cb(null)); },
    async ensureAccount(user) {
      mutate((db) => {
        db.users[user.uid] ||= { name: user.name, photoURL: '', birthday: '', visibility: 'circle', sizes: {}, favorites: {}, avoid: '', payback: {} };
        db.index[user.uid] ||= { circles: [] };
        db.items[user.uid] ||= {};
        db.claims[user.uid] ||= {};
      });
    },

    watchIndex(uid, cb) { return watch((db) => circlesOf(db, uid), cb); },
    watchCircle(cid, cb) {
      return watch((db) => (active(db, cid, me.uid) && db.circles[cid]
        ? { id: cid, name: db.circles[cid].name, inviteCode: db.circles[cid].inviteCode, createdBy: db.circles[cid].createdBy } : null), cb);
    },
    watchMembers(cid, cb) {
      return watch((db) => (active(db, cid, me.uid)
        ? Object.entries(db.circles[cid].members).map(([id, m]) => ({ id, ...m })) : null), cb);
    },
    watchMembership(cid, uid, cb) { return watch((db) => { const m = db.circles[cid]?.members?.[uid]; return m ? { id: uid, ...m } : null; }, cb); },
    async createCircle(user, name) {
      return mutate((db) => {
        const cid = `c${Date.now().toString(36)}`;
        const code = newCode();
        db.circles[cid] = { name, createdBy: user.uid, inviteCode: code, members: {
          [user.uid]: { name: user.name, photoURL: '', role: 'admin', status: 'active', joinedAt: Date.now() },
        }, memories: {} };
        db.index[user.uid].circles.push(cid);
        db.invites[code] = { circleId: cid, circleName: name, createdBy: user.uid };
        return { id: cid, code };
      });
    },
    async renameCircle(cid, name) { mutate((db) => { db.circles[cid].name = name; }); },
    async newInvite(user, circle) {
      return mutate((db) => {
        const code = newCode();
        delete db.invites[circle.inviteCode];
        db.invites[code] = { circleId: circle.id, circleName: circle.name, createdBy: user.uid };
        db.circles[circle.id].inviteCode = code;
        return code;
      });
    },
    async getInvite(code) { const i = load().invites[code]; return i ? { code, ...i } : null; },
    async requestJoin(user, invite) {
      mutate((db) => {
        db.circles[invite.circleId].members[user.uid] = { name: user.name, photoURL: '', role: 'member', status: 'pending', code: invite.code, requestedAt: Date.now() };
      });
    },
    async approve(cid, uid) {
      mutate((db) => {
        db.circles[cid].members[uid].status = 'active';
        if (!db.index[uid].circles.includes(cid)) db.index[uid].circles.push(cid);
      });
    },
    async setRole(cid, uid, role) { mutate((db) => { db.circles[cid].members[uid].role = role; }); },
    async removeMember(cid, uid) {
      mutate((db) => {
        delete db.circles[cid].members[uid];
        db.index[uid].circles = db.index[uid].circles.filter((c) => c !== cid);
      });
    },
    async updateMyMemberships(uid, cids, patch) {
      mutate((db) => cids.forEach((cid) => Object.assign(db.circles[cid].members[uid], patch)));
    },

    watchProfile(uid, cb) {
      return watch((db) => (uid === me.uid || shares(db, uid) || db.users[uid]?.visibility === 'public'
        ? (db.users[uid] ? { id: uid, ...db.users[uid] } : null) : null), cb);
    },
    async saveProfile(uid, profile) { mutate((db) => { const { id, ...rest } = profile; db.users[uid] = rest; }); },

    watchItems(uid, cb) {
      return watch((db) => (uid === me.uid || shares(db, uid)
        ? Object.entries(db.items[uid] || {}).map(([id, it]) => ({ id, ...it })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        : null), cb);
    },
    async saveItem(uid, item) { mutate((db) => { const { id, ...rest } = item; db.items[uid][id] = rest; }); },
    async saveItems(uid, items) { mutate((db) => items.forEach(({ id, ...rest }) => { db.items[uid][id] = rest; })); },
    async deleteItem(uid, id) { mutate((db) => { delete db.items[uid][id]; }); },

    watchClaims(owner, cb) {
      return watch((db) => (owner !== me.uid && shares(db, owner) ? db.claims[owner] || {} : null), cb);
    },
    async claim(owner, itemId, data) {
      mutate((db) => {
        if (db.claims[owner][itemId]) throw new Error('already-claimed');
        db.claims[owner][itemId] = { purchased: false, note: '', ...data, owner, claimedAt: Date.now() };
      });
    },
    async updateClaim(owner, itemId, patch) { mutate((db) => Object.assign(db.claims[owner][itemId], patch)); },
    async unclaim(owner, itemId) { mutate((db) => { delete db.claims[owner][itemId]; }); },

    async disbandCircle(cid) {
      mutate((db) => {
        const c = db.circles[cid];
        if (!c || c.createdBy !== me.uid) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
        for (const uid of Object.keys(c.members)) {
          if (db.index[uid]) db.index[uid].circles = db.index[uid].circles.filter((x) => x !== cid);
        }
        delete db.invites[c.inviteCode];
        delete db.circles[cid];
      });
    },
    watchProfileMemories(uid, cb) {
      return watch((db) => (uid === me.uid || shares(db, uid) || db.users[uid]?.visibility === 'public'
        ? Object.entries(db.pmem?.[uid] || {}).map(([id, m]) => ({ id, ...m })) : null), cb);
    },
    async addProfileMemory(uid, memory) {
      mutate((db) => { ((db.pmem ||= {})[uid] ||= {})[`p${Date.now()}`] = { ...memory, createdAt: Date.now() }; });
    },
    async deleteProfileMemory(uid, id) { mutate((db) => { delete db.pmem[uid][id]; }); },

    watchMemories(cid, cb) {
      return watch((db) => (active(db, cid, me.uid) ? Object.entries(db.circles[cid].memories || {}).map(([id, m]) => ({ id, ...m })) : null), cb);
    },
    async addMemory(cid, memory) { mutate((db) => { db.circles[cid].memories[`m${Date.now()}`] = { ...memory, createdAt: Date.now() }; }); },
    async deleteMemory(cid, id) { mutate((db) => { delete db.circles[cid].memories[id]; }); },
  };
}
