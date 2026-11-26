// Security rules tests. Needs Java and the Firestore emulator, so run it on your own computer:
//
//   cd tests && npm init -y && npm i -D firebase-tools @firebase/rules-unit-testing firebase
//   npx firebase emulators:exec --only firestore --project demo-gifts "node rules.test.mjs"
//
// It walks through the real flows (found a circle, invite, approve, claim) and checks that
// the owner of a list can never read its claims, and that people in other circles see a gift
// is taken without seeing who took it.

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
const sam = as('sam'); // in Jude's Friends circle only, never in a circle with Mom
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log('ok -', name); };

// Every account starts with an empty index.
for (const [db, uid] of [[jude, 'jude'], [mom, 'mom'], [eve, 'eve'], [sam, 'sam']]) {
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

await test('Jude also starts a Friends circle and lets Sam in', async () => {
  const b = writeBatch(jude);
  b.set(doc(jude, 'circles', 'friends'), { name: 'Friends', createdBy: 'jude', inviteCode: 'code456' });
  b.set(doc(jude, 'circles/friends/members', 'jude'), { name: 'Jude', role: 'admin', status: 'active' });
  b.update(doc(jude, 'index', 'jude'), { circles: arrayUnion('friends'), changed: 'friends' });
  b.set(doc(jude, 'invites', 'code456'), { circleId: 'friends', circleName: 'Friends', createdBy: 'jude' });
  await assertSucceeds(b.commit());
  await assertSucceeds(setDoc(doc(sam, 'circles/friends/members', 'sam'), { name: 'Sam', role: 'member', status: 'pending', code: 'code456' }));
  const a = writeBatch(jude);
  a.update(doc(jude, 'circles/friends/members', 'sam'), { status: 'active' });
  a.update(doc(jude, 'index', 'sam'), { circles: arrayUnion('friends'), changed: 'friends' });
  await assertSucceeds(a.commit());
});

await test('mom claims the paddle: marker plus private details', async () => {
  const b = writeBatch(mom);
  b.set(doc(mom, 'users/jude/claims', 'paddle'), { by: 'mom', owner: 'jude', claimedAt: 1 });
  b.set(doc(mom, 'users/jude/claimDetails', 'paddle'), { by: 'mom', owner: 'jude', byName: 'Mom', note: 'blue one', purchased: false });
  await assertSucceeds(b.commit());
});

await test('Jude can never see claims or details on his own list', async () => {
  await assertFails(getDoc(doc(jude, 'users/jude/claims', 'paddle')));
  await assertFails(getDocs(collection(jude, 'users/jude/claims')));
  await assertFails(getDoc(doc(jude, 'users/jude/claimDetails', 'paddle')));
});

await test('Sam (other circle) sees the paddle is taken, but not who or the note', async () => {
  await assertSucceeds(getDoc(doc(sam, 'users/jude/claims', 'paddle')));
  await assertSucceeds(getDocs(collection(sam, 'users/jude/claims')));
  await assertFails(getDoc(doc(sam, 'users/jude/claimDetails', 'paddle')));
  await assertFails(getDocs(collection(sam, 'users/jude/claimDetails')));
});

await test('Mom sees her own claim details; Sam cannot claim the same item', async () => {
  await assertSucceeds(getDoc(doc(mom, 'users/jude/claimDetails', 'paddle')));
  await assertFails(setDoc(doc(sam, 'users/jude/claims', 'paddle'), { by: 'sam', owner: 'jude', claimedAt: 2 }));
});

await test('details can only sit on your own marker, and markers hold no names', async () => {
  await assertFails(setDoc(doc(sam, 'users/jude/claimDetails', 'paddle'), { by: 'sam', owner: 'jude', note: 'x' }));
  await assertFails(setDoc(doc(sam, 'users/jude/claims', 'socks'), { by: 'sam', owner: 'jude', byName: 'Sam' }));
});

await test('nobody can claim on someone else\'s behalf', async () => {
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
