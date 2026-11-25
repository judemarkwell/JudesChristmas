// Security rules tests. Needs Java and the Firestore emulator, so run it on your own computer:
//
//   cd tests && npm init -y && npm i -D firebase-tools @firebase/rules-unit-testing firebase
//   npx firebase emulators:exec --only firestore --project demo-gifts "node rules.test.mjs"
//
// It walks through the real flows (found a circle, invite, approve, claim) and checks that
// the owner of a list can never read its claims.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, arrayUnion, arrayRemove, collection, getDocs,
} from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-gifts',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
});
const as = (uid) => env.authenticatedContext(uid).firestore();
const jude = as('jude');
const mom = as('mom');
const eve = as('eve'); // never invited
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log('ok -', name); };

// Every account starts with an empty index.
for (const [db, uid] of [[jude, 'jude'], [mom, 'mom'], [eve, 'eve']]) {
  await assertSucceeds(setDoc(doc(db, 'index', uid), { circles: [], changed: '' }));
  await assertSucceeds(setDoc(doc(db, 'users', uid), { name: uid, visibility: 'circle' }));
}

await test('founder creates a circle, membership and invite in one batch', async () => {
  const b = writeBatch(jude);
  b.set(doc(jude, 'circles', 'fam'), { name: 'Markwell Family', createdBy: 'jude', inviteCode: 'code123' });
  b.set(doc(jude, 'circles/fam/members', 'jude'), { name: 'Jude', role: 'admin', status: 'active' });
  b.update(doc(jude, 'index', 'jude'), { circles: arrayUnion('fam'), changed: 'fam' });
  b.set(doc(jude, 'invites', 'code123'), { circleId: 'fam', circleName: 'Markwell Family', createdBy: 'jude' });
  await assertSucceeds(b.commit());
});

await test('nobody can add a circle to their own index', async () => {
  await assertFails(updateDoc(doc(eve, 'index', 'eve'), { circles: arrayUnion('fam'), changed: 'fam' }));
});

await test('cannot join as active or admin', async () => {
  await assertFails(setDoc(doc(eve, 'circles/fam/members', 'eve'), { name: 'Eve', role: 'admin', status: 'active', code: 'code123' }));
});

await test('cannot join with a wrong code', async () => {
  await assertFails(setDoc(doc(eve, 'circles/fam/members', 'eve'), { name: 'Eve', role: 'member', status: 'pending', code: 'nope' }));
});

await test('mom asks to join with the invite and waits', async () => {
  await assertSucceeds(setDoc(doc(mom, 'circles/fam/members', 'mom'), { name: 'Mom', role: 'member', status: 'pending', code: 'code123' }));
  await assertFails(getDoc(doc(mom, 'circles', 'fam')));
});

await test('pending member cannot approve herself', async () => {
  await assertFails(updateDoc(doc(mom, 'circles/fam/members', 'mom'), { status: 'active' }));
});

await test('admin approves mom', async () => {
  const b = writeBatch(jude);
  b.update(doc(jude, 'circles/fam/members', 'mom'), { status: 'active' });
  b.update(doc(jude, 'index', 'mom'), { circles: arrayUnion('fam'), changed: 'fam' });
  await assertSucceeds(b.commit());
});

await test('mom can read Jude\'s list and profile; eve cannot', async () => {
  await assertSucceeds(setDoc(doc(jude, 'users/jude/items', 'paddle'), { name: 'Paddle' }));
  await assertSucceeds(getDocs(collection(mom, 'users/jude/items')));
  await assertSucceeds(getDoc(doc(mom, 'users', 'jude')));
  await assertFails(getDocs(collection(eve, 'users/jude/items')));
  await assertFails(getDoc(doc(eve, 'users', 'jude')));
});

await test('mom claims the paddle; Jude can never see claims on his list', async () => {
  await assertSucceeds(setDoc(doc(mom, 'users/jude/claims', 'paddle'), { by: 'mom', owner: 'jude', purchased: false }));
  await assertFails(getDoc(doc(jude, 'users/jude/claims', 'paddle')));
  await assertFails(getDocs(collection(jude, 'users/jude/claims')));
  await assertSucceeds(getDoc(doc(mom, 'users/jude/claims', 'paddle')));
});

await test('nobody can claim on someone else\'s behalf or edit another claim', async () => {
  await assertFails(setDoc(doc(mom, 'users/jude/claims', 'other'), { by: 'jude', owner: 'jude' }));
  await assertFails(setDoc(doc(eve, 'users/jude/claims', 'other'), { by: 'eve', owner: 'jude' }));
});

await test('mom cannot edit Jude\'s list', async () => {
  await assertFails(setDoc(doc(mom, 'users/jude/items', 'x'), { name: 'Socks' }));
});

await test('admin removes mom; she loses access in the same write', async () => {
  const b = writeBatch(jude);
  b.delete(doc(jude, 'circles/fam/members', 'mom'));
  b.update(doc(jude, 'index', 'mom'), { circles: arrayRemove('fam'), changed: 'fam' });
  await assertSucceeds(b.commit());
  await assertFails(getDocs(collection(mom, 'users/jude/items')));
});

await test('a removal that leaves the membership behind is refused', async () => {
  await assertFails(updateDoc(doc(jude, 'index', 'jude'), { circles: arrayRemove('fam'), changed: 'fam' }));
});

await test('profile memories: owner posts, circle can view, others cannot', async () => {
  await assertSucceeds(setDoc(doc(jude, 'users/jude/memories', 'm1'), { image: 'data:image/jpeg;base64,xx', year: 2025 }));
  await assertFails(setDoc(doc(eve, 'users/jude/memories', 'm2'), { image: 'data:image/jpeg;base64,xx' }));
  await assertFails(getDocs(collection(eve, 'users/jude/memories')));
});

await test('only the creator can disband', async () => {
  // Make mom an admin again, then check she still cannot delete the circle.
  await assertSucceeds(setDoc(doc(mom, 'circles/fam/members', 'mom'), { name: 'Mom', role: 'member', status: 'pending', code: 'code123' }));
  const b = writeBatch(jude);
  b.update(doc(jude, 'circles/fam/members', 'mom'), { status: 'active', role: 'admin' });
  b.update(doc(jude, 'index', 'mom'), { circles: arrayUnion('fam'), changed: 'fam' });
  await assertSucceeds(b.commit());
  await assertFails(deleteDoc(doc(mom, 'circles', 'fam')));
  await assertSucceeds(deleteDoc(doc(jude, 'circles', 'fam')));
});

await env.cleanup();
assert.ok(passed > 0);
console.log(`\n${passed} rules tests passed`);
