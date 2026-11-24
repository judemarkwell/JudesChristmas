// Storage layer. Two interchangeable backends with the same interface:
//   local    – saved in this browser only (demo / testing)
//   firebase – shared Firestore database, live-updates for everyone
//
// Interface:
//   mode                       'local' | 'firebase'
//   subscribeClaims(cb)        cb({ [itemId]: claim }) on every change; returns unsubscribe
//   claim(itemId, data)        throws Error('already-claimed') if someone got there first
//   updateClaim(itemId, patch)
//   unclaim(itemId)
//   listMemories()             -> [{ id, year, caption, image, createdAt }]
//   addMemory(memory)          -> saved memory
//   deleteMemory(id)

import { CONFIG } from './config.js';

const LS_CLAIMS = 'jc.claims';
const LS_MEMORIES = 'jc.memories';

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
  let claims = readLS(LS_CLAIMS, {});
  const subscribers = new Set();
  const emit = () => subscribers.forEach((cb) => cb({ ...claims }));
  const save = () => {
    if (!writeLS(LS_CLAIMS, claims)) throw new Error('storage-failed');
    emit();
  };

  // Keep multiple tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === LS_CLAIMS) {
      claims = readLS(LS_CLAIMS, {});
      emit();
    }
  });

  return {
    mode: 'local',
    subscribeClaims(cb) {
      subscribers.add(cb);
      cb({ ...claims });
      return () => subscribers.delete(cb);
    },
    async claim(itemId, data) {
      if (claims[itemId]) throw new Error('already-claimed');
      claims[itemId] = { purchased: false, note: '', ...data, claimedAt: Date.now() };
      save();
    },
    async updateClaim(itemId, patch) {
      if (!claims[itemId]) return;
      claims[itemId] = { ...claims[itemId], ...patch };
      save();
    },
    async unclaim(itemId) {
      delete claims[itemId];
      save();
    },
    async listMemories() {
      return readLS(LS_MEMORIES, []);
    },
    async addMemory(memory) {
      const list = readLS(LS_MEMORIES, []);
      const saved = { id: `m${Date.now()}`, ...memory, createdAt: Date.now() };
      list.push(saved);
      if (!writeLS(LS_MEMORIES, list)) throw new Error('storage-full');
      return saved;
    },
    async deleteMemory(id) {
      writeLS(LS_MEMORIES, readLS(LS_MEMORIES, []).filter((m) => m.id !== id));
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

  return {
    mode: 'firebase',
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
