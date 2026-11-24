// Storage layer. Two interchangeable backends with the same interface:
//   local    – saved in this browser only (demo / testing)
//   firebase – shared Firestore database, live-updates for everyone
//
// Interface:
//   mode                       'local' | 'firebase'
//   listItems(seed)            -> wishlist items (seeded from data/items.json the first time)
//   saveItem(item)             create or update by id
//   deleteItem(id)
//   getProfile(seed)           -> profile object
//   saveProfile(profile)
//   subscribeClaims(cb)        cb({ [itemId]: claim }) on every change; returns unsubscribe
//   claim(itemId, data)        throws Error('already-claimed') if someone got there first
//   updateClaim(itemId, patch)
//   unclaim(itemId)
//   listMemories()             -> [{ id, year, caption, image, createdAt }]
//   addMemory(memory)          -> saved memory
//   deleteMemory(id)

import { CONFIG } from './config.js';

const LS = {
  claims: 'jc.claims',
  memories: 'jc.memories',
  items: 'jc.items',
  profile: 'jc.profile',
};

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function createLocalStore() {
  let claims = readLS(LS.claims, {});
  const subscribers = new Set();
  const emit = () => subscribers.forEach((cb) => cb({ ...claims }));
  const saveClaims = () => {
    if (!writeLS(LS.claims, claims)) throw new Error('storage-failed');
    emit();
  };

  // Keep multiple tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === LS.claims) {
      claims = readLS(LS.claims, {});
      emit();
    }
  });

  return {
    mode: 'local',

    async listItems(seed) {
      return readLS(LS.items, null) ?? seed;
    },
    async saveItem(item, current) {
      const list = [...current];
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item; else list.push(item);
      if (!writeLS(LS.items, list)) throw new Error('storage-full');
      return list;
    },
    async deleteItem(id, current) {
      const list = current.filter((x) => x.id !== id);
      if (!writeLS(LS.items, list)) throw new Error('storage-full');
      return list;
    },

    async getProfile(seed) {
      return { ...seed, ...readLS(LS.profile, {}) };
    },
    async saveProfile(profile) {
      if (!writeLS(LS.profile, profile)) throw new Error('storage-full');
      return profile;
    },

    subscribeClaims(cb) {
      subscribers.add(cb);
      cb({ ...claims });
      return () => subscribers.delete(cb);
    },
    async claim(itemId, data) {
      if (claims[itemId]) throw new Error('already-claimed');
      claims[itemId] = { purchased: false, note: '', ...data, claimedAt: Date.now() };
      saveClaims();
    },
    async updateClaim(itemId, patch) {
      if (!claims[itemId]) return;
      claims[itemId] = { ...claims[itemId], ...patch };
      saveClaims();
    },
    async unclaim(itemId) {
      delete claims[itemId];
      saveClaims();
    },

    async listMemories() {
      return readLS(LS.memories, []);
    },
    async addMemory(memory) {
      const list = readLS(LS.memories, []);
      const saved = { id: `m${Date.now()}`, ...memory, createdAt: Date.now() };
      list.push(saved);
      if (!writeLS(LS.memories, list)) throw new Error('storage-full');
      return saved;
    },
    async deleteMemory(id) {
      writeLS(LS.memories, readLS(LS.memories, []).filter((m) => m.id !== id));
    },
  };
}

async function createFirebaseStore(firebaseConfig) {
  const v = '10.12.2';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`);
  const fs = await import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`);

  const app = initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);
  const claimsCol = fs.collection(db, 'claims');
  const memoriesCol = fs.collection(db, 'memories');
  const itemsCol = fs.collection(db, 'items');
  const profileRef = fs.doc(db, 'profiles', 'owner');

  return {
    mode: 'firebase',

    async listItems(seed) {
      const snap = await fs.getDocs(itemsCol);
      if (snap.empty) return seed;
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveItem(item, current) {
      // First save copies the seed list into the database so it becomes the source of truth.
      const list = [...current];
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item; else list.push(item);
      const batch = fs.writeBatch(db);
      list.forEach((it, order) => {
        const { id, ...rest } = it;
        batch.set(fs.doc(db, 'items', id), { ...rest, order });
      });
      await batch.commit();
      return list;
    },
    async deleteItem(id, current) {
      await fs.deleteDoc(fs.doc(db, 'items', id));
      return current.filter((x) => x.id !== id);
    },

    async getProfile(seed) {
      const snap = await fs.getDoc(profileRef);
      return { ...seed, ...(snap.exists() ? snap.data() : {}) };
    },
    async saveProfile(profile) {
      await fs.setDoc(profileRef, profile);
      return profile;
    },

    subscribeClaims(cb) {
      return fs.onSnapshot(
        claimsCol,
        (snap) => {
          const out = {};
          snap.forEach((d) => { out[d.id] = d.data(); });
          cb(out);
        },
        (err) => console.error('Claims listener failed', err),
      );
    },
    async claim(itemId, data) {
      const ref = fs.doc(db, 'claims', itemId);
      // Transaction so two elves can't claim the same gift at the same moment.
      await fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error('already-claimed');
        tx.set(ref, { purchased: false, note: '', ...data, claimedAt: Date.now() });
      });
    },
    async updateClaim(itemId, patch) {
      await fs.updateDoc(fs.doc(db, 'claims', itemId), patch);
    },
    async unclaim(itemId) {
      await fs.deleteDoc(fs.doc(db, 'claims', itemId));
    },

    async listMemories() {
      const snap = await fs.getDocs(memoriesCol);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async addMemory(memory) {
      const data = { ...memory, createdAt: Date.now() };
      const ref = await fs.addDoc(memoriesCol, data);
      return { id: ref.id, ...data };
    },
    async deleteMemory(id) {
      await fs.deleteDoc(fs.doc(db, 'memories', id));
    },
  };
}

export async function createStore() {
  if (CONFIG.firebase && CONFIG.firebase.apiKey) {
    try {
      return await createFirebaseStore(CONFIG.firebase);
    } catch (err) {
      console.warn('Firebase unavailable, falling back to local storage.', err);
    }
  }
  return createLocalStore();
}
