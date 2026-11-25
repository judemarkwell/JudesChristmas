import { CONFIG } from './config.js';
import { createStore } from './store.js';
import { readLink, asinOf } from './links.js';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const safeLink = (u) => {
  try {
    const url = new URL(u, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch { return '#'; }
};
const safeImg = (u) => (typeof u === 'string' && u.startsWith('data:image/') ? u : safeLink(u));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const shopSearch = (q) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wish';
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Friend';

async function loadJSON(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch { return fallback; }
}

const ICONS = ['🎁', '🖱️', '⌨️', '🎧', '🖥️', '💻', '📱', '🔌', '🔋', '⚡', '🎮', '📚',
  '👟', '👕', '🧥', '🧢', '🧦', '⌚', '💍', '🕶️', '🎒', '🧴', '🪒', '🛁',
  '🏓', '🟡', '⚾', '🏀', '⛳', '🚴', '♟️', '🎲', '🧩', '🎨', '🎸', '📷',
  '☕', '🍫', '🍪', '🕯️', '🌲', '🚗', '🔧', '🛞', '🗄️', '🛋️', '🪴', '🧸'];
const SIZE_FIELDS = [
  ['shirt', 'Shirt'], ['hoodie', 'Hoodie / jacket'], ['pants', 'Pants'],
  ['shoe', 'Shoe'], ['ring', 'Ring'], ['hat', 'Hat'],
];
const FAVORITE_FIELDS = [
  ['colors', 'Colors', 'e.g. forest green, black'],
  ['brands', 'Brands', 'e.g. Razer, ASICS'],
  ['stores', 'Stores', 'e.g. Target, REI'],
  ['treats', 'Snacks & treats', 'e.g. dark chocolate'],
];
const PAYBACK_FIELDS = [['venmo', 'Venmo', '@username'], ['paypal', 'PayPal', 'email or link'], ['cashapp', 'Cash App', '$cashtag']];

// ---------- state ----------
const state = {
  store: null,
  ready: false,
  user: null,
  profile: null,
  circleIds: [],
  circles: {},        // cid -> circle doc (name, inviteCode, createdBy)
  circleMembers: {},  // cid -> members (including pending)
  circleMemories: {}, // cid -> memories
  items: {},          // uid -> wishlist
  claims: {},         // uid -> { itemId: claim }   (never filled for yourself)
  profiles: {},       // uid -> profile
  profileMemories: {},// uid -> memories on their profile
  pending: readPending(),
  pendingStatus: {},  // cid -> 'pending' | 'active' | 'gone'
  invites: {},        // code -> invite | null
  seedItems: [],
  filter: { cat: 'All', q: '', hideClaimed: false },
};

function readPending() { try { return JSON.parse(ls.get('jc.pending')) || []; } catch { return []; } }
function writePending() { ls.set('jc.pending', JSON.stringify(state.pending)); }

// ---------- subscriptions ----------
const subs = new Map();
function sub(key, unsubscribe) { subs.get(key)?.(); subs.set(key, unsubscribe); }
function unsub(prefix) {
  for (const [k, fn] of subs) if (k.startsWith(prefix)) { fn(); subs.delete(k); }
}

// ---------- routing ----------
// #circles · #circle-<id> · #settings-<id> · #mine · #shop · #profile · #person-<uid> · #list-<uid> · #join-<code>
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  for (const [prefix, v, key] of [['join-', 'join', 'code'], ['circle-', 'circle', 'cid'], ['settings-', 'settings', 'cid'],
    ['person-', 'person', 'uid'], ['list-', 'list', 'uid']]) {
    if (h.startsWith(prefix)) return { view: v, [key]: h.slice(prefix.length) };
  }
  if (['circles', 'mine', 'shop', 'profile'].includes(h)) return { view: h };
  return { view: 'circles' };
}
const TAB_FOR = { circles: 'circles', circle: 'circles', settings: 'circles', person: 'circles', list: 'circles', mine: 'mine', shop: 'shop', profile: 'profile' };
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };
const view = () => $('#view');

// ---------- modal & toast ----------
const modal = $('#modal');
const isPhone = () => matchMedia('(max-width: 600px)').matches;
function openModal(html, { wide = false } = {}) {
  $('.modal-body', modal).innerHTML = html;
  modal.classList.toggle('modal-wide', wide);
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
  // On phones, don't pop the keyboard up before the person has tapped a field.
  const first = modal.querySelector('input:not([type=radio]):not([type=checkbox]), select, textarea');
  if (first && !isPhone()) first.focus({ preventScroll: true });
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});

// In-page confirm step (browser confirm() is blocked in some embedded viewers).
function askConfirm(title, text, okLabel) {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="cf-no">Cancel</button>
        <button type="button" class="btn btn-danger" id="cf-yes">${esc(okLabel)}</button>
      </div>`);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      modal.removeEventListener('close', onClose);
      resolve(v);
    };
    const onClose = () => finish(false);
    modal.addEventListener('close', onClose);
    $('#cf-yes').addEventListener('click', () => finish(true));
    $('#cf-no').addEventListener('click', () => { finish(false); closeModal(); });
  });
}

// Phones: keep the open sheet above the on-screen keyboard (see css: top-pinned action bar).
function fitToVisibleArea() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  document.documentElement.style.setProperty('--vvtop', `${Math.round(vv.offsetTop)}px`);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitToVisibleArea);
  visualViewport.addEventListener('scroll', fitToVisibleArea);
  fitToVisibleArea();
}
let typingTimer;
modal.addEventListener('focusin', (e) => {
  const field = e.target.closest('input, textarea, select');
  if (!field || ['radio', 'checkbox', 'file'].includes(field.type) || !isPhone()) return;
  clearTimeout(typingTimer);
  modal.classList.add('typing');
  const lift = () => field.scrollIntoView({ block: 'start', behavior: 'smooth' });
  requestAnimationFrame(lift);
  setTimeout(lift, 350);
});
// Same idea for the few forms that sit on the page itself (rename, invite link box).
$('#view').addEventListener('focusin', (e) => {
  const field = e.target.closest('.form input, .form textarea, .invite-box input');
  if (!field || ['radio', 'checkbox', 'file'].includes(field.type) || !isPhone()) return;
  const lift = () => { if (document.activeElement === field) field.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  requestAnimationFrame(lift);
  setTimeout(lift, 350);
});
modal.addEventListener('focusout', () => {
  typingTimer = setTimeout(() => {
    if (!modal.contains(document.activeElement)) modal.classList.remove('typing');
  }, 200);
});
modal.addEventListener('close', () => { modal.classList.remove('typing'); render(); });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
function oops(err) {
  console.error(err);
  toast(err?.code === 'permission-denied' ? '🔒 Not allowed. Ask a circle admin.' : '😬 Something went wrong. Try again.');
}

// ---------- data wiring ----------
// Everything for every circle you're in is kept live: each circle's details, members and
// memories, and for every person in any of your circles their profile, list, claims and
// profile memories. Families are small, so this keeps every screen instant.
async function onAuth(user) {
  unsub('');
  Object.assign(state, {
    user, profile: null, circleIds: [], circles: {}, circleMembers: {}, circleMemories: {},
    items: {}, claims: {}, profiles: {}, profileMemories: {}, pendingStatus: {},
  });
  if (!user) { state.ready = true; render(); return; }
  try {
    await state.store.ensureAccount(user);
  } catch (err) {
    console.error(err);
    state.setupError = err?.code || String(err);
  }
  const uid = user.uid;
  sub('me:profile', state.store.watchProfile(uid, (p) => { state.profile = p; state.profiles[uid] = p; scheduleRender(); }));
  sub('me:items', state.store.watchItems(uid, (l) => { state.items[uid] = l || []; scheduleRender(); }));
  sub('me:memories', state.store.watchProfileMemories(uid, (l) => { state.profileMemories[uid] = l || []; scheduleRender(); }));
  sub('me:index', state.store.watchIndex(uid, onCircleIds));
  watchPending();
  state.ready = true;
  render();
}

function onCircleIds(ids) {
  const before = state.circleIds;
  state.circleIds = ids || [];
  // Requests that have been approved are now real circles.
  const approved = state.pending.filter((p) => state.circleIds.includes(p.cid));
  if (approved.length) {
    state.pending = state.pending.filter((p) => !state.circleIds.includes(p.cid));
    writePending();
    approved.forEach((p) => unsub(`me:pending:${p.cid}`));
    toast(`🎉 You're in ${approved[0].name}!`);
  }
  for (const cid of state.circleIds) {
    if (subs.has(`c:${cid}:doc`)) continue;
    sub(`c:${cid}:doc`, state.store.watchCircle(cid, (c) => { state.circles[cid] = c; scheduleRender(); }));
    sub(`c:${cid}:members`, state.store.watchMembers(cid, (m) => { state.circleMembers[cid] = m || []; syncPeople(); }));
    sub(`c:${cid}:memories`, state.store.watchMemories(cid, (m) => { state.circleMemories[cid] = m || []; scheduleRender(); }));
  }
  for (const cid of before.filter((c) => !state.circleIds.includes(c))) {
    unsub(`c:${cid}:`);
    delete state.circles[cid];
    delete state.circleMembers[cid];
    delete state.circleMemories[cid];
  }
  syncPeople();
}

// Everyone active in any of your circles, except you.
function people() {
  const ids = new Set();
  for (const cid of state.circleIds) {
    for (const m of state.circleMembers[cid] || []) if (m.status === 'active' && m.id !== me()) ids.add(m.id);
  }
  return [...ids];
}

function syncPeople() {
  const now = people();
  for (const uid of now) {
    if (subs.has(`p:${uid}:items`)) continue;
    sub(`p:${uid}:items`, state.store.watchItems(uid, (l) => { state.items[uid] = l || []; scheduleRender(); }));
    sub(`p:${uid}:claims`, state.store.watchClaims(uid, (c) => { state.claims[uid] = c || {}; scheduleRender(); }));
    sub(`p:${uid}:profile`, state.store.watchProfile(uid, (p) => { state.profiles[uid] = p; scheduleRender(); }));
    sub(`p:${uid}:memories`, state.store.watchProfileMemories(uid, (l) => { state.profileMemories[uid] = l || []; scheduleRender(); }));
  }
  for (const key of [...subs.keys()].filter((k) => k.startsWith('p:'))) {
    const uid = key.split(':')[1];
    if (!now.includes(uid)) {
      unsub(`p:${uid}:`);
      delete state.items[uid];
      delete state.claims[uid];
      delete state.profiles[uid];
      delete state.profileMemories[uid];
    }
  }
  scheduleRender();
}

function watchPending() {
  for (const p of state.pending) {
    if (subs.has(`me:pending:${p.cid}`)) continue;
    sub(`me:pending:${p.cid}`, state.store.watchMembership(p.cid, state.user.uid, (m) => {
      state.pendingStatus[p.cid] = m ? m.status : 'gone';
      scheduleRender();
    }));
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Don't wipe a form someone is filling in; closing the modal re-renders.
    if (!modal.open) render();
  });
}

// ---------- shared bits ----------
const me = () => state.user?.uid;
const membersOf = (cid) => state.circleMembers[cid] || [];
const activeIn = (cid) => membersOf(cid).filter((m) => m.status === 'active');
const pendingIn = (cid) => membersOf(cid).filter((m) => m.status === 'pending');
const myRoleIn = (cid) => membersOf(cid).find((m) => m.id === me());
const isAdminOf = (cid) => myRoleIn(cid)?.role === 'admin' && myRoleIn(cid)?.status === 'active';
const isCreatorOf = (cid) => state.circles[cid]?.createdBy === me();
const memberRecord = (uid) => {
  for (const cid of state.circleIds) {
    const m = membersOf(cid).find((x) => x.id === uid);
    if (m) return m;
  }
  return null;
};
const personOf = (uid) => state.profiles[uid] || memberRecord(uid) || {};
const displayName = (uid) => personOf(uid).name || 'Someone';
const sharedCircles = (uid) => state.circleIds.filter((cid) => activeIn(cid).some((m) => m.id === uid));
const inviteLink = (code) => `${location.origin}${location.pathname}#join-${code}`;
const profileHref = (uid) => (uid === me() ? '#profile' : `#person-${encodeURIComponent(uid)}`);

function avatarHTML(person, size = 'md') {
  const name = person?.name || '?';
  const photo = person?.photoURL;
  return photo
    ? `<img class="avatar avatar-${size}" src="${esc(safeLink(photo))}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar avatar-${size}" aria-hidden="true">${esc(firstName(name).charAt(0).toUpperCase())}</span>`;
}

function countdownHTML() {
  const now = new Date();
  if (now.getMonth() === 11 && now.getDate() === 25) return '🎄 <strong>Merry Christmas!</strong> 🎄';
  let xmas = new Date(now.getFullYear(), 11, 25);
  if (now > xmas) xmas = new Date(now.getFullYear() + 1, 11, 25);
  const days = Math.ceil((xmas - now) / 86400000);
  return `<span class="count-num">${days}</span> <span>sleep${days === 1 ? '' : 's'} till Christmas</span>`;
}

function daysUntilBirthday(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  if (!m || !d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), m - 1, d);
  if (next < today) next = new Date(now.getFullYear() + 1, m - 1, d);
  return Math.round((next - today) / 86400000);
}
const birthdayText = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '');

// The hero animates in once per visit, not on every live update.
let entered = false;
function enterAttr() { if (entered) return ''; entered = true; return 'data-enter'; }

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast('Couldn’t copy. Press and hold the link to copy it.');
    return false;
  }
}

// ---------- rendering ----------
function render() {
  if (!state.ready) return;
  const r = route();
  const signedIn = !!state.user;
  document.body.classList.toggle('no-nav', !signedIn || r.view === 'join');
  const tab = TAB_FOR[r.view];
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === tab;
    t.classList.toggle('active', active);
    if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  $('#storage-note').textContent = state.store?.mode === 'mock' ? '🧪 Test mode: data stays in this browser.' : '';

  if (!signedIn) return renderLanding(r);
  switch (r.view) {
    case 'join': return renderJoin(r.code);
    case 'circle': return renderCircle(r.cid);
    case 'settings': return renderSettings(r.cid);
    case 'mine': return renderMine();
    case 'shop': return renderShop();
    case 'profile': return renderProfile(me());
    case 'person': return r.uid === me() ? go('#profile') : renderProfile(r.uid);
    case 'list': return r.uid === me() ? go('#mine') : renderList(r.uid);
    default: return renderCircles();
  }
}

// ----- signed out -----
function renderLanding(r) {
  const invited = r.view === 'join';
  view().innerHTML = `
    <section class="landing">
      <div class="hero" ${enterAttr()}>
        <h1 class="enter-1">Gift Circles</h1>
        <p class="tagline enter-2">Wishlists for your family. Claim a gift without spoiling the surprise.</p>
      </div>
      ${invited ? `<p class="invite-note">🎟️ You've been invited to a family circle. Sign in to accept.</p>` : ''}
      <button type="button" class="btn btn-google" id="sign-in">
        <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.8 6C12.3 13.4 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z"/><path fill="#FBBC05" d="M10.4 28.8c-.5-1.4-.8-3-.8-4.8s.3-3.3.8-4.8l-7.8-6C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.7-3.9-13.6-9.4l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>
        Sign in with Google
      </button>
      <p class="muted small center">If nothing opens, open this page in Safari or Chrome. Google doesn't allow signing in inside some in-app browsers.</p>
      <ul class="feature-list">
        <li><span aria-hidden="true">🎁</span><div><strong>Your wishlist</strong><br><span class="muted">Links, priorities, sizes and cheaper options.</span></div></li>
        <li><span aria-hidden="true">🙈</span><div><strong>No spoilers</strong><br><span class="muted">Family can see who's buying what. You never can.</span></div></li>
        <li><span aria-hidden="true">🧦</span><div><strong>Sizes in one place</strong><br><span class="muted">No more texting around for ring and shoe sizes.</span></div></li>
      </ul>
      <div class="countdown">${countdownHTML()}</div>
    </section>`;
  $('#sign-in').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await state.store.signIn();
    } catch (err) {
      console.error(err);
      toast(err?.code === 'auth/unauthorized-domain'
        ? '🔒 This address isn’t on Firebase’s allowed domains yet.'
        : '😬 Sign-in didn’t work. Try again, or open this page in Safari or Chrome.');
    } finally {
      btn.disabled = false;
    }
  });
}

// ----- circles tab -----
function pendingCardsHTML() {
  return state.pending.map((p) => {
    if (state.pendingStatus[p.cid] === 'gone') {
      return `<div class="banner banner-warn"><span>Your request to join <strong>${esc(p.name)}</strong> wasn't approved.</span>
        <button type="button" class="btn btn-ghost small" data-dismiss="${esc(p.cid)}">Dismiss</button></div>`;
    }
    return `<div class="banner"><span>⏳ Waiting for an admin of <strong>${esc(p.name)}</strong> to let you in.</span></div>`;
  }).join('');
}
function bindPendingDismiss(root) {
  root.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
    state.pending = state.pending.filter((p) => p.cid !== b.dataset.dismiss);
    writePending();
    unsub(`me:pending:${b.dataset.dismiss}`);
    render();
  }));
}

function avatarStackHTML(members) {
  const shown = members.slice(0, 5);
  const more = members.length - shown.length;
  return `<span class="avatar-stack">${shown.map((m) => avatarHTML(personOf(m.id).name ? personOf(m.id) : m, 'sm')).join('')}${more > 0 ? `<span class="avatar avatar-sm avatar-more">+${more}</span>` : ''}</span>`;
}

function renderCircles() {
  const name = firstName(state.profile?.name || state.user.name);
  const has = state.circleIds.length > 0;
  view().innerHTML = `
    <section class="circles">
      <div class="hero" ${enterAttr()}>
        <h1 class="enter-1">${has ? 'Your circles' : `Hi ${esc(name)}!`}</h1>
        ${has ? `<div class="countdown enter-2">${countdownHTML()}</div>`
          : '<p class="tagline enter-2">Start a circle for your family, or join one you were invited to.</p>'}
      </div>
      ${state.setupError ? `<div class="banner banner-warn">Account setup hit a problem (${esc(state.setupError)}). If this keeps happening, the database rules may not be published yet.</div>` : ''}
      ${pendingCardsHTML()}
      <div class="circle-grid">
        ${state.circleIds.map((cid) => {
          const c = state.circles[cid];
          const active = activeIn(cid);
          const waiting = isAdminOf(cid) ? pendingIn(cid).length : 0;
          return `
            <a class="circle-card" href="#circle-${esc(cid)}">
              <span class="circle-card-top">
                <span class="circle-name">${c ? esc(c.name) : '<span class="muted">Loading…</span>'}</span>
                ${isCreatorOf(cid) ? '<span class="pill pill-green">Creator</span>' : isAdminOf(cid) ? '<span class="pill pill-green">Admin</span>' : ''}
              </span>
              ${avatarStackHTML(active)}
              <span class="person-meta">${active.length} member${active.length === 1 ? '' : 's'}</span>
              ${waiting ? `<span class="pill pill-gold">🎟️ ${waiting} waiting to join</span>` : ''}
              <span class="circle-open">Open →</span>
            </a>`;
        }).join('')}
        <button type="button" class="circle-card circle-action" id="start-circle">
          <span class="avatar avatar-md avatar-ghost" aria-hidden="true">＋</span>
          <span class="circle-name">Start a circle</span>
          <span class="person-meta">For family, friends, in-laws…</span>
        </button>
        <button type="button" class="circle-card circle-action" id="join-circle">
          <span class="avatar avatar-md avatar-ghost" aria-hidden="true">🎟️</span>
          <span class="circle-name">Join with a link</span>
          <span class="person-meta">Paste an invite you were sent</span>
        </button>
      </div>
    </section>`;
  bindPendingDismiss(view());
  $('#start-circle').addEventListener('click', openCreateCircle);
  $('#join-circle').addEventListener('click', openJoinWithLink);
}

function openCreateCircle() {
  openModal(`
    <h2>Start a circle 🎄</h2>
    <p class="muted">You'll be its creator and admin, and get an invite link to send out.</p>
    <form id="create-form" class="form">
      <label>Circle name
        <input name="name" required maxlength="40" placeholder="e.g. Markwell Family">
      </label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Create circle</button>
      </div>
    </form>`);
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = String(new FormData(e.target).get('name') || '').trim();
    if (!name) return;
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { id, code } = await state.store.createCircle({ ...state.user, name: state.profile?.name || state.user.name }, name);
      closeModal();
      go(`#circle-${id}`);
      showCircleReady(name, code, id);
    } catch (err) {
      oops(err);
      btn.disabled = false;
      btn.textContent = 'Create circle';
    }
  });
}

function openJoinWithLink() {
  openModal(`
    <h2>Join a circle 🎟️</h2>
    <p class="muted">Paste the invite link someone sent you.</p>
    <form id="paste-form" class="form">
      <label>Invite link
        <input name="link" required placeholder="https://…#join-…" autocomplete="off">
      </label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Open invite</button>
      </div>
    </form>`);
  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = String(new FormData(e.target).get('link') || '').trim();
    const code = (raw.match(/join-([a-z0-9]+)/i) || [])[1] || (/^[a-z0-9]{8,}$/i.test(raw) ? raw : '');
    if (!code) { toast('That doesn’t look like an invite link.'); return; }
    closeModal();
    go(`#join-${code}`);
  });
}

function showCircleReady(name, code) {
  const link = inviteLink(code);
  openModal(`
    <div class="celebrate">
      <div class="empty-emoji" aria-hidden="true">🎄</div>
      <h2>${esc(name)} is ready!</h2>
      <p class="muted">You're its creator and admin. Two things to do next:</p>
    </div>
    <ol class="next-steps">
      <li>
        <strong>Invite your family</strong>
        <span class="muted small">Text them this link. They sign in and ask to join, and you let them in.</span>
        <div class="invite-box">
          <input id="ready-link" readonly value="${esc(link)}" aria-label="Invite link">
          <button type="button" class="btn btn-primary" id="ready-copy">Copy</button>
        </div>
      </li>
      <li>
        <strong>Add your wishes and sizes</strong>
        <span class="muted small">On the My list and Profile tabs.</span>
      </li>
    </ol>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-close>Later</button>
      <button type="button" class="btn btn-secondary" id="ready-mine">Go to My list</button>
    </div>`);
  $('#ready-copy').addEventListener('click', () => copyText(link, '🔗 Copied. Text it to family!'));
  $('#ready-mine').addEventListener('click', () => { closeModal(); go('#mine'); });
}

// ----- joining -----
async function renderJoin(code) {
  if (!(code in state.invites)) {
    view().innerHTML = '<p class="loading">Checking your invite…</p>';
    state.invites[code] = await state.store.getInvite(code);
    if (route().code !== code) return;
  }
  const inv = state.invites[code];
  let body;
  if (!inv) {
    body = `<div class="empty-emoji">🧐</div><h2>That invite link doesn't work</h2>
      <p class="muted">It may have been replaced with a new one. Ask whoever sent it for the latest link.</p>
      <a class="btn btn-ghost" href="#circles">Go to my circles</a>`;
  } else if (state.circleIds.includes(inv.circleId)) {
    body = `<div class="empty-emoji">🎄</div><h2>You're already in ${esc(inv.circleName)}</h2>
      <a class="btn btn-primary" href="#circle-${esc(inv.circleId)}">Open it</a>`;
  } else if (state.pending.some((p) => p.cid === inv.circleId)) {
    body = `<div class="empty-emoji">⏳</div><h2>Request sent</h2>
      <p class="muted">An admin of ${esc(inv.circleName)} will let you in soon.</p>
      <a class="btn btn-ghost" href="#circles">OK</a>`;
  } else {
    body = `<div class="empty-emoji">🎟️</div><h2>Join ${esc(inv.circleName)}?</h2>
      <p class="muted">Once an admin lets you in, you'll see everyone's profiles and wishlists, and they'll see yours.</p>
      <button type="button" class="btn btn-primary" id="ask-join">Ask to join</button>`;
  }
  view().innerHTML = `<section class="locked">${body}</section>`;
  $('#ask-join')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await state.store.requestJoin({ ...state.user, name: state.profile?.name || state.user.name, photoURL: state.profile?.photoURL || state.user.photoURL }, inv);
      state.pending.push({ cid: inv.circleId, name: inv.circleName });
      writePending();
      watchPending();
      toast('📨 Request sent');
      render();
    } catch (err) {
      oops(err);
      btn.disabled = false;
    }
  });
}

// ----- one circle: members and memories -----
function notInCircle() {
  view().innerHTML = `<section class="locked"><div class="empty-emoji">🤷</div><h2>You're not in that circle</h2>
    <a class="btn btn-ghost" href="#circles">Back to my circles</a></section>`;
}

function renderCircle(cid) {
  if (!state.circleIds.includes(cid)) return notInCircle();
  const c = state.circles[cid];
  const members = activeIn(cid).sort((a, b) => (a.id === me() ? -1 : b.id === me() ? 1 : a.name.localeCompare(b.name)));
  const waiting = isAdminOf(cid) ? pendingIn(cid).length : 0;
  const memories = state.circleMemories[cid];
  view().innerHTML = `
    <section class="page">
      <a class="back-link" href="#circles">← Circles</a>
      <div class="circle-head">
        <h1>${c ? esc(c.name) : '…'}</h1>
        <p class="muted">${members.length} member${members.length === 1 ? '' : 's'}</p>
        <div class="circle-actions">
          <button type="button" class="btn btn-primary" id="invite">🔗 Copy invite link</button>
          <a class="btn btn-ghost" href="#settings-${esc(cid)}">⚙️ Settings</a>
        </div>
      </div>
      ${waiting ? `
        <a class="banner banner-action" href="#settings-${esc(cid)}">
          <span>🎟️ <strong>${waiting}</strong> ${waiting === 1 ? 'person wants' : 'people want'} to join</span>
          <span class="banner-cta">Review →</span>
        </a>` : ''}

      <h2 class="section-title">Members</h2>
      <div class="people">${members.map(personCardHTML).join('')}</div>

      <div class="memories-head">
        <h2 class="section-title">Memories</h2>
        <button type="button" class="btn btn-primary" id="add-memory">＋ Add a memory</button>
      </div>
      ${memories == null ? '<p class="loading">Opening the scrapbook…</p>' : memoriesGridHTML(memories, 'No memories yet. Add the first photo and start the scrapbook.')}
    </section>`;
  $('#invite').addEventListener('click', () => (c?.inviteCode
    ? copyText(inviteLink(c.inviteCode), '🔗 Invite link copied. Text it to family!')
    : go(`#settings-${cid}`)));
  $('#add-memory').addEventListener('click', () => openAddMemory({ type: 'circle', cid }));
  bindMemoriesGrid(memories || [], { type: 'circle', cid });
}

function personCardHTML(m) {
  const mine = m.id === me();
  const p = personOf(m.id).name ? personOf(m.id) : m;
  const items = state.items[m.id];
  const claims = state.claims[m.id] || {};
  const n = items ? items.length : 0;
  const claimed = items ? items.filter((i) => claims[i.id]).length : 0;
  const bday = daysUntilBirthday(state.profiles[m.id]?.birthday);
  let meta = items == null ? '…' : `${n} wish${n === 1 ? '' : 'es'}`;
  if (!mine && n) meta += ` · ${claimed} claimed`;
  return `
    <a class="person-card" href="${profileHref(m.id)}">
      ${avatarHTML(p, 'md')}
      <span class="person-name">${esc(firstName(p.name))}${mine ? ' <span class="muted">(you)</span>' : ''}</span>
      <span class="person-meta">${esc(meta)}</span>
      ${bday != null && bday <= 45 ? `<span class="pill pill-gold">🎂 ${bday === 0 ? 'Today!' : `in ${bday} day${bday === 1 ? '' : 's'}`}</span>` : ''}
      ${m.role === 'admin' ? '<span class="pill pill-green">Admin</span>' : ''}
    </a>`;
}

// ----- circle settings -----
function renderSettings(cid) {
  if (!state.circleIds.includes(cid)) return notInCircle();
  const c = state.circles[cid];
  if (!c) { view().innerHTML = '<p class="loading">Opening settings…</p>'; return; }
  const admin = isAdminOf(cid);
  const creator = isCreatorOf(cid);
  const waiting = pendingIn(cid);
  const members = activeIn(cid).sort((a, b) => a.name.localeCompare(b.name));
  view().innerHTML = `
    <section class="page settings">
      <a class="back-link" href="#circle-${esc(cid)}">← ${esc(c.name)}</a>
      <h2 class="section-title">${esc(c.name)} settings</h2>

      <div class="panel">
        <div class="panel-head"><h3>Invite link</h3></div>
        <p class="muted small">Anyone with this link can ask to join. An admin lets them in.</p>
        <div class="invite-box">
          <input id="invite-link" readonly value="${esc(c.inviteCode ? inviteLink(c.inviteCode) : '')}" aria-label="Invite link">
          <button type="button" class="btn btn-primary" id="copy-invite">Copy</button>
        </div>
        ${admin ? `<button type="button" class="btn btn-ghost small wrap" id="new-invite">Make a new link (old one stops working)</button>` : ''}
      </div>

      ${admin ? `
      <div class="panel">
        <div class="panel-head"><h3>Waiting to join</h3><span class="muted small">${waiting.length}</span></div>
        ${waiting.length ? `<ul class="member-list">${waiting.map((m) => `
          <li>
            ${avatarHTML(m, 'sm')}
            <span class="member-name">${esc(m.name)}</span>
            <span class="member-actions">
              <button type="button" class="btn btn-ghost small" data-decline="${esc(m.id)}">Decline</button>
              <button type="button" class="btn btn-primary small" data-approve="${esc(m.id)}">Let in</button>
            </span>
          </li>`).join('')}</ul>` : '<p class="panel-text muted">No one is waiting.</p>'}
      </div>` : ''}

      <div class="panel">
        <div class="panel-head"><h3>Members</h3><span class="muted small">${members.length}</span></div>
        <ul class="member-list">${members.map((m) => `
          <li>
            <a class="member-link" href="${profileHref(m.id)}">${avatarHTML(personOf(m.id).name ? personOf(m.id) : m, 'sm')}
              <span class="member-name">${esc(m.name)}${m.id === me() ? ' <span class="muted">(you)</span>' : ''}</span></a>
            ${c.createdBy === m.id ? '<span class="pill pill-green">Creator</span>' : m.role === 'admin' ? '<span class="pill pill-green">Admin</span>' : ''}
            ${admin && m.id !== me() && c.createdBy !== m.id ? `
              <span class="member-actions">
                <button type="button" class="btn btn-ghost small" data-role="${esc(m.id)}">${m.role === 'admin' ? 'Make member' : 'Make admin'}</button>
                <button type="button" class="btn btn-danger small" data-remove="${esc(m.id)}">Remove</button>
              </span>` : ''}
          </li>`).join('')}</ul>
      </div>

      ${admin ? `
      <div class="panel">
        <div class="panel-head"><h3>Circle name</h3></div>
        <form id="rename-form" class="form form-inline">
          <label>Name<input name="name" required maxlength="40" value="${esc(c.name)}"></label>
          <button type="submit" class="btn btn-secondary">Rename</button>
        </form>
      </div>` : ''}

      <div class="panel panel-danger">
        <div class="panel-head"><h3>${creator ? 'Disband circle' : 'Leave circle'}</h3></div>
        ${creator
          ? `<p class="panel-text muted small">Deletes ${esc(c.name)} for everyone, including its shared memories. Wishlists and profiles aren't touched. Members can save photos to their profiles first.</p>
             <button type="button" class="btn btn-danger" id="disband">Disband ${esc(c.name)}</button>`
          : `<p class="panel-text muted small">You'll stop seeing this circle's profiles, lists and memories, and they'll stop seeing yours. You can rejoin with an invite link.</p>
             <button type="button" class="btn btn-danger" id="leave">Leave ${esc(c.name)}</button>`}
      </div>
    </section>`;

  $('#copy-invite').addEventListener('click', () => copyText($('#invite-link').value, '🔗 Copied. Text it to family!'));
  $('#new-invite')?.addEventListener('click', async () => {
    if (!(await askConfirm('Make a new invite link?', 'The current link will stop working. People already waiting stay on the list.', 'Make new link'))) return;
    try { await state.store.newInvite(state.user, { ...c, id: cid }); toast('🔗 New link ready. The old one no longer works.'); } catch (err) { oops(err); }
  });
  view().querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await state.store.approve(cid, b.dataset.approve); toast('🎉 Welcome to the circle!'); } catch (err) { oops(err); b.disabled = false; }
  }));
  view().querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', async () => {
    try { await state.store.removeMember(cid, b.dataset.decline, false); } catch (err) { oops(err); }
  }));
  view().querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', async () => {
    const m = membersOf(cid).find((x) => x.id === b.dataset.role);
    try { await state.store.setRole(cid, m.id, m.role === 'admin' ? 'member' : 'admin'); } catch (err) { oops(err); }
  }));
  view().querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const m = membersOf(cid).find((x) => x.id === b.dataset.remove);
    if (!(await askConfirm(`Remove ${m.name}?`, `${firstName(m.name)} won't see this circle anymore, and its members won't see ${firstName(m.name)}'s lists unless you share another circle.`, 'Remove'))) return;
    try { await state.store.removeMember(cid, m.id, true); toast(`${firstName(m.name)} was removed`); } catch (err) { oops(err); }
  }));
  $('#rename-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = String(new FormData(e.target).get('name') || '').trim();
    if (!name) return;
    try { await state.store.renameCircle(cid, name); toast('✅ Renamed'); } catch (err) { oops(err); }
  });
  $('#leave')?.addEventListener('click', async () => {
    if (!(await askConfirm(`Leave ${c.name}?`, 'You can rejoin later with an invite link.', 'Leave'))) return;
    try { await state.store.removeMember(cid, me(), true); go('#circles'); toast(`You left ${c.name}`); } catch (err) { oops(err); }
  });
  $('#disband')?.addEventListener('click', async () => {
    if (!(await askConfirm(`Disband ${c.name}?`, `This deletes the circle and its ${(state.circleMemories[cid] || []).length} shared memories for all ${members.length} members. It can't be undone.`, 'Disband for everyone'))) return;
    try {
      toast('Disbanding…');
      await state.store.disbandCircle(cid, {
        uid: me(), members: membersOf(cid), memories: state.circleMemories[cid] || [], inviteCode: c.inviteCode,
      });
      go('#circles');
      toast(`${c.name} was disbanded`);
    } catch (err) { oops(err); }
  });
}

// ----- memories (circle scrapbooks and profiles) -----
function memoriesGridHTML(list, emptyText) {
  if (!list.length) return `<div class="empty"><div class="empty-emoji">📷</div><p>${esc(emptyText)}</p></div>`;
  const byYear = list.reduce((acc, m) => {
    const y = Number(m.year) || 'Undated';
    (acc[y] ||= []).push(m);
    return acc;
  }, {});
  return Object.keys(byYear).sort((a, b) => (Number(b) || 0) - (Number(a) || 0)).map((y) => `
    <h3 class="year-title"><span>${esc(y)}</span></h3>
    <div class="polaroids">
      ${byYear[y].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((m) => `
        <figure class="polaroid" data-mem="${esc(m.id)}" tabindex="0" role="button" aria-label="Open photo: ${esc(m.caption || 'memory')}">
          <img src="${safeImg(m.image)}" alt="${esc(m.caption || 'Memory')}" loading="lazy">
          <figcaption>${esc(m.caption || '')}</figcaption>
        </figure>`).join('')}
    </div>`).join('');
}

function bindMemoriesGrid(list, ctx) {
  view().querySelectorAll('.polaroid[data-mem]').forEach((el) => {
    const open = () => { const m = list.find((x) => String(x.id) === el.dataset.mem); if (m) openLightbox(m, ctx); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function openLightbox(m, ctx) {
  const inCircle = ctx.type === 'circle';
  const source = inCircle ? `${ctx.cid}/${m.id}` : '';
  const saved = inCircle && (state.profileMemories[me()] || []).some((x) => x.source === source);
  const canDelete = inCircle ? (m.by === me() || isAdminOf(ctx.cid)) : ctx.uid === me();
  openModal(`
    <figure class="lightbox">
      <img src="${safeImg(m.image)}" alt="${esc(m.caption || 'Memory')}">
      <figcaption>
        <strong>${esc(m.year || '')}</strong> ${esc(m.caption || '')}
        ${m.byName ? `<br><span class="muted small">Added by ${esc(firstName(m.byName))}</span>` : ''}
        ${m.from ? `<br><span class="muted small">Saved from ${esc(m.from)}</span>` : ''}
      </figcaption>
    </figure>
    <div class="form-actions">
      ${canDelete ? `<button type="button" class="btn btn-danger small" id="del-memory">Delete</button>` : ''}
      <span class="spacer"></span>
      ${inCircle ? (saved
        ? '<span class="pill pill-green">✓ On your profile</span>'
        : '<button type="button" class="btn btn-secondary" id="save-memory">⭐ Save to my profile</button>') : ''}
    </div>`, { wide: true });
  $('#save-memory')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await state.store.addProfileMemory(me(), {
        image: m.image, caption: m.caption || '', year: m.year || null,
        from: state.circles[ctx.cid]?.name || '', source, by: me(), byName: state.profile?.name || state.user.name,
      });
      closeModal();
      toast('⭐ Saved to your profile');
    } catch (err) { oops(err); }
  });
  $('#del-memory')?.addEventListener('click', async () => {
    const where = inCircle ? 'for everyone in the circle' : 'from your profile';
    if (!(await askConfirm('Delete this memory?', `This photo will be removed ${where}.`, 'Delete'))) return;
    try {
      if (inCircle) await state.store.deleteMemory(ctx.cid, m.id);
      else await state.store.deleteProfileMemory(me(), m.id);
      closeModal();
      toast('🗑️ Memory deleted');
    } catch (err) { oops(err); }
  });
}

function openAddMemory(target) {
  const year = new Date().getFullYear();
  const where = target.type === 'circle' ? (state.circles[target.cid]?.name || 'the circle') : 'your profile';
  openModal(`
    <h2>Add a memory 📸</h2>
    <p class="muted">Posts to ${esc(where)}.</p>
    <form id="memory-form" class="form">
      <label>Photo
        <input name="file" type="file" accept="image/*" required>
      </label>
      <div class="form-row">
        <label>Year
          <input name="year" type="number" inputmode="numeric" min="1950" max="${year + 1}" value="${year}" required>
        </label>
        <label>Caption
          <input name="caption" maxlength="140" placeholder="e.g. Cookie marathon">
        </label>
      </div>
      <p class="form-error" id="mem-error" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Post memory</button>
      </div>
    </form>`);
  $('#memory-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const file = fd.get('file');
    const err = $('#mem-error');
    const submit = e.target.querySelector('[type=submit]');
    try {
      if (!file || !file.size) throw new Error('Pick a photo first.');
      submit.disabled = true;
      submit.textContent = 'Posting…';
      const memory = {
        year: Number(fd.get('year')),
        caption: String(fd.get('caption') || '').trim(),
        image: await shrinkImage(file, CONFIG.memoryMaxSize),
        by: me(),
        byName: state.profile?.name || state.user.name,
      };
      if (target.type === 'circle') await state.store.addMemory(target.cid, memory);
      else await state.store.addProfileMemory(me(), memory);
      closeModal();
      toast('📸 Memory posted!');
    } catch (ex) {
      console.error(ex);
      err.textContent = ex.code === 'permission-denied' ? 'Not allowed to add photos here.' : ex.message || 'Could not save that photo.';
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Post memory';
    }
  });
}

// ----- profiles (yours and everyone else's) -----
function renderProfile(uid) {
  const mine = uid === me();
  if (!mine && !people().includes(uid)) {
    view().innerHTML = `<section class="locked"><div class="empty-emoji">🤷</div><h2>You don't share a circle with them</h2>
      <a class="btn btn-ghost" href="#circles">Back to my circles</a></section>`;
    return;
  }
  const p = mine ? (state.profile || state.user) : personOf(uid);
  const items = state.items[uid];
  const n = items ? items.length : 0;
  const memories = state.profileMemories[uid];
  const circles = sharedCircles(uid).map((cid) => state.circles[cid]?.name).filter(Boolean);
  const myCircles = mine ? state.circleIds.map((cid) => state.circles[cid]?.name).filter(Boolean) : circles;
  const bday = birthdayText(p.birthday);
  const until = daysUntilBirthday(p.birthday);
  view().innerHTML = `
    <section class="page profile-page">
      ${mine ? '' : `<a class="back-link" href="javascript:history.back()">← Back</a>`}
      <div class="profile-card">
        ${avatarHTML(p, 'xl')}
        <h1>${esc(p.name || 'Someone')}</h1>
        <p class="profile-meta">
          ${bday ? `<span>🎂 ${esc(bday)}${until != null && until <= 45 ? ` <span class="pill pill-gold">${until === 0 ? 'today!' : `in ${until} days`}</span>` : ''}</span>` : ''}
          ${myCircles.length ? `<span>🎄 ${esc(myCircles.join(' · '))}</span>` : ''}
          ${mine ? `<span>${p.visibility === 'public' ? '🌍 Public profile' : '🔒 Only your circles'}</span>` : ''}
        </p>
        <div class="profile-actions">
          ${mine
            ? `<button type="button" class="btn btn-primary" id="edit-profile">✏️ Edit profile</button>
               <a class="btn btn-ghost" href="#mine">🎁 My wishlist (${n})</a>`
            : `<a class="btn btn-primary" href="#list-${encodeURIComponent(uid)}">🎁 View wishlist${items ? ` (${n})` : ''}</a>`}
        </div>
      </div>

      <div class="profile">${profilePanelsHTML(p, { compact: !mine })}</div>

      <div class="memories-head">
        <h2 class="section-title">${mine ? 'My memories' : `${esc(firstName(p.name))}'s memories`}</h2>
        ${mine ? '<button type="button" class="btn btn-primary" id="post-memory">＋ Post a memory</button>' : ''}
      </div>
      ${memories == null ? '<p class="loading">Loading…</p>' : memoriesGridHTML(memories,
        mine ? 'Post a photo here, or tap ⭐ Save to my profile on any circle memory.' : 'No memories on this profile yet.')}

      ${mine ? '<button type="button" class="btn btn-ghost sign-out" id="sign-out">👋 Sign out</button>' : ''}
    </section>`;
  $('#edit-profile')?.addEventListener('click', openProfileEditor);
  $('#post-memory')?.addEventListener('click', () => openAddMemory({ type: 'profile' }));
  $('#sign-out')?.addEventListener('click', async () => { await state.store.signOut(); go('#circles'); });
  view().querySelector('.back-link')?.addEventListener('click', (e) => {
    if (history.length <= 1) { e.preventDefault(); go('#circles'); }
  });
  bindMemoriesGrid(memories || [], { type: 'profile', uid });
}

// ----- my list -----
function renderMine() {
  const p = state.profile || state.user;
  const items = state.items[me()] || [];
  const canImport = !items.length && state.seedItems.length
    && firstName(p.name).toLowerCase() === String(CONFIG.starterListFor || '').toLowerCase();
  view().innerHTML = `
    <section class="page">
      <div class="page-head">
        ${avatarHTML(p, 'lg')}
        <div class="page-id">
          <h2>My wishlist</h2>
          <p class="muted">${items.length} wish${items.length === 1 ? '' : 'es'}</p>
        </div>
        <a class="btn btn-ghost" href="#profile">👤 My profile</a>
      </div>
      <p class="hint-line">🙈 You'll never see who claimed what on your list. That's the point!</p>
      ${canImport ? `
        <div class="banner banner-action">
          <span>📋 Bring over your starter list (${state.seedItems.length} wishes)?</span>
          <button type="button" class="btn btn-primary small" id="import-starter">Import</button>
        </div>` : ''}
      ${wishlistToolbarHTML(items, { owner: true })}
    </section>`;
  bindWishlist(me(), true);
  $('#import-starter')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await state.store.saveItems(me(), state.seedItems.map((it, order) => ({ ...it, order })));
      toast(`✨ Imported ${state.seedItems.length} wishes`);
    } catch (err) { oops(err); }
  });
}

// ----- someone else's wishlist -----
function renderList(uid) {
  if (!people().includes(uid)) {
    view().innerHTML = `<section class="locked"><div class="empty-emoji">🤷</div><h2>You don't share a circle with them</h2>
      <a class="btn btn-ghost" href="#circles">Back to my circles</a></section>`;
    return;
  }
  const p = personOf(uid);
  const items = state.items[uid];
  view().innerHTML = `
    <section class="page">
      <a class="back-link" href="#person-${encodeURIComponent(uid)}">← ${esc(firstName(p.name))}'s profile</a>
      <div class="page-head">
        ${avatarHTML(p, 'lg')}
        <div class="page-id">
          <h2>${esc(firstName(p.name))}'s wishlist</h2>
          <p class="muted">${items ? `${items.length} wish${items.length === 1 ? '' : 'es'}` : ''}</p>
        </div>
      </div>
      ${items == null ? '<p class="loading">Opening the list…</p>' : wishlistToolbarHTML(items, { giver: true })}
    </section>`;
  if (items != null) bindWishlist(uid, false);
}

// ----- shopping -----
function renderShop() {
  const groups = [];
  let total = 0;
  let bought = 0;
  for (const uid of people()) {
    const claims = state.claims[uid] || {};
    const ids = new Set((state.items[uid] || []).map((i) => i.id));
    const rows = Object.entries(claims).filter(([, c]) => c.by === me()).map(([id, c]) => ({ id, c, removed: !ids.has(id) }));
    if (!rows.length) continue;
    total += rows.length;
    bought += rows.filter((r) => r.c.purchased).length;
    groups.push({ uid, rows });
  }
  groups.sort((a, b) => displayName(a.uid).localeCompare(displayName(b.uid)));
  view().innerHTML = `
    <section class="shop">
      <h2 class="section-title">My shopping 🛷</h2>
      <div class="stats">
        <div class="stat"><span class="stat-num">${total}</span><span>claimed</span></div>
        <div class="stat"><span class="stat-num">${bought}</span><span>bought</span></div>
        <div class="stat"><span class="stat-num">${total - bought}</span><span>to buy</span></div>
      </div>
      ${groups.length ? groups.map(({ uid, rows }) => `
        <h3 class="elf-name"><a href="#list-${encodeURIComponent(uid)}">${avatarHTML(personOf(uid), 'xs')} For ${esc(firstName(displayName(uid)))}</a></h3>
        <ul class="shop-list">
          ${rows.map(({ id, c, removed }) => `
            <li class="shop-row ${c.purchased ? 'is-bought' : ''}">
              <span class="row-emoji" aria-hidden="true">${esc(c.itemEmoji || '🎁')}</span>
              <div class="row-main">
                <strong>${esc(c.itemName || 'Gift')}</strong>
                ${removed ? `<span class="row-note warn">⚠️ ${esc(firstName(displayName(uid)))} took this off their list</span>` : ''}
                ${c.note ? `<span class="row-note">“${esc(c.note)}”</span>` : ''}
              </div>
              <button type="button" class="btn ${c.purchased ? 'btn-secondary' : 'btn-ghost'} small" data-bought="${esc(uid)}|${esc(id)}" aria-pressed="${!!c.purchased}">${c.purchased ? '✓ Bought' : 'Mark bought'}</button>
              <button type="button" class="btn btn-ghost small" data-manage="${esc(uid)}|${esc(id)}" aria-label="Manage ${esc(c.itemName || 'gift')}">⋯</button>
            </li>`).join('')}
        </ul>`).join('')
      : `<div class="empty"><div class="empty-emoji">🛍️</div><p>Nothing claimed yet. Open a <a href="#circles">circle</a>, pick someone, and claim a gift from their wishlist.</p></div>`}
    </section>`;
  view().querySelectorAll('[data-bought]').forEach((b) => b.addEventListener('click', async () => {
    const [owner, id] = b.dataset.bought.split('|');
    const c = state.claims[owner]?.[id];
    if (!c) return;
    try { await state.store.updateClaim(owner, id, { purchased: !c.purchased }); } catch (err) { oops(err); }
  }));
  view().querySelectorAll('[data-manage]').forEach((b) => b.addEventListener('click', () => {
    const [owner, id] = b.dataset.manage.split('|');
    openManage(owner, id);
  }));
}

// ----- wishlist grid (shared by My list and person pages) -----
function wishlistToolbarHTML(items, { owner, giver }) {
  const cats = ['All', ...new Set(items.map((i) => i.category).filter(Boolean))];
  const f = state.filter;
  if (!cats.includes(f.cat)) f.cat = 'All';
  return `
    <div class="toolbar">
      <div class="toolbar-row">
        <input id="search" class="search" type="search" placeholder="Search the list…" value="${esc(f.q)}" aria-label="Search the list">
        ${owner ? `<button type="button" class="btn btn-primary" id="add-wish">＋ Add a wish</button>` : ''}
        ${giver ? `
          <label class="switch">
            <input type="checkbox" id="hide-claimed" ${f.hideClaimed ? 'checked' : ''}>
            <span class="switch-track" aria-hidden="true"></span> Hide claimed
          </label>` : ''}
      </div>
      ${cats.length > 2 ? `<div class="chips" role="group" aria-label="Filter by category">
        ${cats.map((c) => `<button type="button" class="chip ${c === f.cat ? 'active' : ''}" data-cat="${esc(c)}" aria-pressed="${c === f.cat}">${esc(c)}</button>`).join('')}
      </div>` : ''}
    </div>
    <div id="grid" class="grid"></div>`;
}

function bindWishlist(ownerUid, isOwner) {
  const f = state.filter;
  const draw = () => {
    const grid = $('#grid');
    if (!grid) return;
    const items = state.items[ownerUid] || [];
    const claims = isOwner ? {} : (state.claims[ownerUid] || {});
    const needle = f.q.trim().toLowerCase();
    const list = items.filter((i) => {
      if (f.cat !== 'All' && i.category !== f.cat) return false;
      if (!isOwner && f.hideClaimed && claims[i.id]) return false;
      return !needle || [i.name, i.category, i.note].join(' ').toLowerCase().includes(needle);
    });
    grid.innerHTML = list.length
      ? list.map((i) => cardHTML(i, ownerUid, isOwner, claims[i.id])).join('')
      : `<div class="empty"><div class="empty-emoji">☃️</div><p>${items.length ? 'Nothing here. Try another filter.' : 'No wishes yet.'}</p></div>`;
  };
  view().querySelectorAll('.chip[data-cat]').forEach((b) => b.addEventListener('click', () => {
    f.cat = b.dataset.cat;
    view().querySelectorAll('.chip[data-cat]').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b);
    });
    draw();
  }));
  $('#search')?.addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $('#hide-claimed')?.addEventListener('change', (e) => { f.hideClaimed = e.target.checked; draw(); });
  $('#add-wish')?.addEventListener('click', () => openItemEditor());
  $('#grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = (state.items[ownerUid] || []).find((i) => i.id === btn.dataset.id);
    if (!item) return;
    const a = btn.dataset.action;
    if (a === 'alts') openAlternatives(item);
    if (a === 'edit') openItemEditor(item);
    if (a === 'claim') openClaim(ownerUid, item);
    if (a === 'manage') openManage(ownerUid, item.id);
  });
  draw();
}

function priorityHTML(p) {
  const n = Math.max(0, Math.min(3, Number(p) || 0));
  if (!n) return '';
  const label = ['', 'Nice to have', 'Would love it', 'Top wish!'][n];
  return `<span class="priority" title="${label}" aria-label="${label}">${'❤️'.repeat(n)}${'🤍'.repeat(3 - n)}</span>`;
}

function cardHTML(item, ownerUid, isOwner, claim) {
  const mine = claim && claim.by === me();
  let status = '';
  let mainBtn = '';
  if (isOwner) {
    mainBtn = `<button type="button" class="btn btn-ghost" data-action="edit" data-id="${esc(item.id)}" aria-label="Edit ${esc(item.name)}">✏️ Edit</button>`;
  } else if (claim) {
    status = `<p class="status ${claim.purchased ? 'bought' : 'claimed'}">${claim.purchased ? '🎁 Bought' : '🔖 Claimed'} by ${mine ? 'you' : esc(firstName(claim.byName))}</p>`;
    mainBtn = mine ? `<button type="button" class="btn btn-secondary" data-action="manage" data-id="${esc(item.id)}">Manage</button>` : '';
  } else {
    status = `<p class="status open">✨ Up for grabs</p>`;
    mainBtn = `<button type="button" class="btn btn-primary" data-action="claim" data-id="${esc(item.id)}">Claim it</button>`;
  }
  return `
    <article class="tag-card ${claim ? 'is-claimed' : ''}">
      <span class="tag-hole" aria-hidden="true"></span>
      <div class="card-top">
        <span class="card-emoji" aria-hidden="true">${esc(item.emoji || '🎁')}</span>
        ${priorityHTML(item.priority)}
      </div>
      <h3 class="card-title">${esc(item.name)}</h3>
      ${item.category ? `<p class="card-cat">${esc(item.category)}</p>` : ''}
      ${item.note ? `<p class="card-note">${esc(item.note)}</p>` : ''}
      ${item.details?.length ? `<ul class="card-details">${item.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      ${item.price ? `<p class="price">About $${esc(item.price)}</p>` : ''}
      ${status}
      <div class="card-actions">
        ${item.url ? `<a class="btn btn-ghost" href="${safeLink(item.url)}" target="_blank" rel="noopener noreferrer">View item ↗</a>` : ''}
        <button type="button" class="btn btn-ghost" data-action="alts" data-id="${esc(item.id)}">Cheaper options</button>
        ${mainBtn}
      </div>
    </article>`;
}

// ----- profile panels (shared by My list and person pages) -----
function profilePanelsHTML(p, { compact = false } = {}) {
  const sizes = p?.sizes || {};
  const fav = p?.favorites || {};
  const pay = p?.payback || {};
  const empty = '<span class="muted">Not added yet</span>';
  const filled = SIZE_FIELDS.filter(([k]) => sizes[k]);
  const favFilled = FAVORITE_FIELDS.filter(([k]) => fav[k]);
  if (compact) {
    return `
      <div class="panel">
        <div class="panel-head"><h3>Sizes</h3></div>
        ${filled.length ? `<dl class="size-grid">${filled.map(([k, label]) => `
          <div class="size-tile"><dt>${label}</dt><dd>${esc(sizes[k])}</dd></div>`).join('')}</dl>`
          : '<p class="panel-text muted">No sizes added yet.</p>'}
      </div>
      ${favFilled.length || p?.avoid ? `
      <div class="panel">
        <dl class="fact-list">
          ${favFilled.map(([k, label]) => `<div><dt>${label}</dt><dd>${esc(fav[k])}</dd></div>`).join('')}
          ${p?.avoid ? `<div><dt>Please don't buy</dt><dd>${esc(p.avoid)}</dd></div>` : ''}
        </dl>
      </div>` : ''}`;
  }
  return `
    <div class="panel">
      <div class="panel-head"><h3>Sizes</h3><span class="muted small">${filled.length}/${SIZE_FIELDS.length} added</span></div>
      <dl class="size-grid">
        ${SIZE_FIELDS.map(([k, label]) => `
          <div class="size-tile ${sizes[k] ? '' : 'is-empty'}"><dt>${label}</dt><dd>${sizes[k] ? esc(sizes[k]) : '—'}</dd></div>`).join('')}
      </dl>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Favorites</h3></div>
      <dl class="fact-list">
        ${FAVORITE_FIELDS.map(([k, label]) => `<div><dt>${label}</dt><dd>${fav[k] ? esc(fav[k]) : empty}</dd></div>`).join('')}
        <div><dt>Please don't buy</dt><dd>${p?.avoid ? esc(p.avoid) : empty}</dd></div>
      </dl>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Pay-back handles</h3><span class="muted small">for group gifts</span></div>
      <dl class="fact-list">
        ${PAYBACK_FIELDS.map(([k, label]) => `<div><dt>${label}</dt><dd>${pay[k] ? esc(pay[k]) : empty}</dd></div>`).join('')}
      </dl>
    </div>`;
}

// ----- item editor -----
function openItemEditor(existing) {
  const it = existing || { priority: 2, emoji: '🎁' };
  const mine = state.items[me()] || [];
  const cats = [...new Set(mine.map((i) => i.category).filter(Boolean))];
  const iconChoices = ICONS.includes(it.emoji) ? ICONS : [it.emoji, ...ICONS];
  openModal(`
    <h2>${existing ? 'Edit wish ✏️' : 'Add a wish ✨'}</h2>
    <form id="item-form" class="form" novalidate>
      <label>Link
        <input name="url" type="url" inputmode="url" placeholder="Paste a product link" value="${esc(it.url)}">
        <span class="hint" id="link-hint">Paste a link and the title fills in when the store's address includes it.</span>
      </label>
      <label>Title
        <input name="name" required maxlength="80" placeholder="What is it?" value="${esc(it.name)}">
      </label>
      <fieldset class="field">
        <legend>Icon</legend>
        <div class="icon-grid" role="radiogroup" aria-label="Icon">
          ${iconChoices.map((e) => `
            <label class="icon-opt">
              <input type="radio" name="emoji" value="${esc(e)}" ${e === it.emoji ? 'checked' : ''}>
              <span aria-hidden="true">${esc(e)}</span>
            </label>`).join('')}
        </div>
      </fieldset>
      <fieldset class="field">
        <legend>How much do you want it?</legend>
        <div class="segmented segmented-stack" role="radiogroup" aria-label="Priority">
          ${[[1, 'Nice to have'], [2, 'Would love it'], [3, 'Top wish']].map(([v, label]) => `
            <label class="seg-opt">
              <input type="radio" name="priority" value="${v}" ${Number(it.priority) === v ? 'checked' : ''}>
              <span><span class="seg-hearts" aria-hidden="true">${'❤️'.repeat(v)}</span>${label}</span>
            </label>`).join('')}
        </div>
      </fieldset>
      <div class="form-row">
        <label>Category
          <input name="category" list="cat-list" maxlength="30" placeholder="e.g. Pickleball" value="${esc(it.category)}">
          <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        </label>
        <label><span>Price <span class="muted">(about)</span></span>
          <input name="price" type="number" inputmode="decimal" min="0" step="1" placeholder="$" value="${esc(it.price ?? '')}">
        </label>
      </div>
      <label>Notes for family
        <textarea name="note" rows="2" maxlength="300" placeholder="Why you want it, which version…">${esc(it.note)}</textarea>
      </label>
      <label><span>Size, color or model <span class="muted">(one per line)</span></span>
        <textarea name="details" rows="2" maxlength="300" placeholder="Men's 10.5&#10;Black">${esc((it.details || []).join('\n'))}</textarea>
      </label>
      <p class="form-error" id="item-error" hidden></p>
      <div class="form-actions">
        ${existing ? `<button type="button" class="btn btn-danger" id="delete-item">Remove</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${existing ? 'Save' : 'Add to list'}</button>
      </div>
    </form>`, { wide: true });

  const form = $('#item-form');
  const urlInput = form.elements.url;
  const nameInput = form.elements.name;
  const hint = $('#link-hint');
  let autoTitle = '';
  const onLink = () => {
    if (!urlInput.value.trim()) { hint.textContent = 'Paste a link and the title fills in when the store\'s address includes it.'; return; }
    const info = readLink(urlInput.value);
    if (!info) { hint.textContent = 'That doesn’t look like a link.'; return; }
    urlInput.value = info.url;
    // Fill the title only if it's empty or still the one we filled from a previous link.
    const current = nameInput.value.trim();
    if (info.title && (!current || current === autoTitle)) {
      nameInput.value = info.title;
      autoTitle = info.title;
      hint.textContent = `From ${info.store}. Tidy the title if you like.`;
    } else if (info.title) {
      hint.textContent = `From ${info.store}.`;
    } else {
      hint.textContent = `From ${info.store}. This link doesn't include the product's name, so type a title.`;
    }
  };
  urlInput.addEventListener('paste', () => setTimeout(onLink, 0));
  urlInput.addEventListener('change', onLink);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const err = $('#item-error');
    if (!name) {
      err.textContent = 'Give it a title.';
      err.hidden = false;
      nameInput.focus();
      return;
    }
    const rawUrl = String(fd.get('url') || '').trim();
    const order = existing?.order ?? (Math.max(-1, ...mine.map((i) => i.order ?? 0)) + 1);
    const item = {
      ...(existing || {}),
      id: existing?.id || `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      url: rawUrl ? (readLink(rawUrl)?.url || rawUrl) : '',
      emoji: String(fd.get('emoji') || '🎁'),
      priority: Number(fd.get('priority') || 2),
      category: String(fd.get('category') || '').trim(),
      price: fd.get('price') ? Number(fd.get('price')) : null,
      note: String(fd.get('note') || '').trim(),
      details: String(fd.get('details') || '').split('\n').map((s) => s.trim()).filter(Boolean),
      order,
    };
    try {
      await state.store.saveItem(me(), item);
      closeModal();
      toast(existing ? '✅ Wish updated' : `✨ Added ${item.name}`);
    } catch (ex) {
      console.error(ex);
      err.textContent = 'Could not save. Try again.';
      err.hidden = false;
    }
  });

  $('#delete-item')?.addEventListener('click', async () => {
    if (!(await askConfirm('Remove this wish?', `"${existing.name}" will come off your list. If someone already claimed it, they'll see it was removed.`, 'Remove'))) return;
    try {
      await state.store.deleteItem(me(), existing.id);
      closeModal();
      toast('🗑️ Removed from your list');
    } catch (ex) { oops(ex); }
  });
}

// ----- cheaper alternatives -----
function openAlternatives(item) {
  const alts = item.alternatives || [];
  const asin = asinOf(item.url);
  openModal(`
    <h2>Cheaper options 💸</h2>
    <p class="muted">For <strong>${esc(item.name)}</strong></p>
    ${alts.length ? `
      <ul class="alt-list">
        ${alts.map((a) => `
          <li>
            <div><strong>${esc(a.name)}</strong>${a.note ? `<p>${esc(a.note)}</p>` : ''}</div>
            <a class="btn btn-ghost small" href="${shopSearch(a.query || a.name)}" target="_blank" rel="noopener noreferrer">Find it ↗</a>
          </li>`).join('')}
      </ul>` : `<p>No budget picks for this one yet, but the price links below can still help.</p>`}
    <div class="deal-links">
      <a class="btn btn-secondary" href="${shopSearch(item.name)}" target="_blank" rel="noopener noreferrer">🔎 Compare prices</a>
      ${asin ? `<a class="btn btn-secondary" href="https://camelcamelcamel.com/product/${asin}" target="_blank" rel="noopener noreferrer">📉 Amazon price history</a>` : ''}
    </div>`);
}

// ----- claiming -----
function openClaim(owner, item) {
  openModal(`
    <h2>Claim this gift 🎁</h2>
    <p class="muted">${esc(item.name)} for ${esc(firstName(displayName(owner)))}</p>
    <form id="claim-form" class="form">
      <label><span>Note for others <span class="muted">(optional)</span></span>
        <input name="note" maxlength="140" placeholder="e.g. getting the blue one">
      </label>
      <label class="check"><input type="checkbox" name="purchased"> I've already bought it</label>
      <p class="muted small">${esc(firstName(displayName(owner)))} won't see this. Everyone else in the circle will, so nobody doubles up.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Claim it</button>
      </div>
    </form>`);
  $('#claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await state.store.claim(owner, item.id, {
        by: me(),
        byName: state.profile?.name || state.user.name,
        itemName: item.name,
        itemEmoji: item.emoji || '🎁',
        note: String(fd.get('note') || '').trim(),
        purchased: fd.get('purchased') === 'on',
      });
      closeModal();
      toast(`🎉 ${item.name} is yours to wrap!`);
    } catch (err) {
      closeModal();
      if (err.message === 'already-claimed') toast('🏃 Someone just claimed that one!');
      else oops(err);
    }
  });
}

function openManage(owner, itemId) {
  const claim = state.claims[owner]?.[itemId];
  if (!claim) return;
  openModal(`
    <h2>Your gift 🎀</h2>
    <p class="muted">${esc(claim.itemName || 'Gift')} for ${esc(firstName(displayName(owner)))}</p>
    <form id="manage-form" class="form">
      <label>Note for others
        <input name="note" maxlength="140" value="${esc(claim.note)}">
      </label>
      <label class="check"><input type="checkbox" name="purchased" ${claim.purchased ? 'checked' : ''}> Bought it</label>
      <div class="form-actions">
        <button type="button" class="btn btn-danger" id="unclaim-btn">Release it</button>
        <span class="spacer"></span>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await state.store.updateClaim(owner, itemId, {
        note: String(fd.get('note') || '').trim(),
        purchased: fd.get('purchased') === 'on',
      });
      closeModal();
      toast('✅ Saved');
    } catch (err) { oops(err); }
  });
  $('#unclaim-btn').addEventListener('click', async () => {
    if (!(await askConfirm('Release this gift?', `"${claim.itemName || 'This gift'}" goes back on the list so someone else can claim it.`, 'Release'))) return;
    try {
      await state.store.unclaim(owner, itemId);
      closeModal();
      toast('🎈 Released back to the list');
    } catch (err) { oops(err); }
  });
}

// ----- profile editor -----
function openProfileEditor() {
  const p = state.profile || { name: state.user.name };
  const sizes = p.sizes || {};
  const fav = p.favorites || {};
  const pay = p.payback || {};
  openModal(`
    <h2>Your profile 🧦</h2>
    <form id="profile-form" class="form">
      <div class="form-row">
        <label>Name <input name="name" maxlength="40" value="${esc(p.name)}"></label>
        <label>Birthday <input name="birthday" type="date" value="${esc(p.birthday)}"></label>
      </div>
      <fieldset class="field">
        <legend>Who can see it</legend>
        <div class="segmented" role="radiogroup" aria-label="Profile visibility">
          <label class="seg-opt"><input type="radio" name="visibility" value="circle" ${p.visibility !== 'public' ? 'checked' : ''}><span>🔒 My circles</span></label>
          <label class="seg-opt"><input type="radio" name="visibility" value="public" ${p.visibility === 'public' ? 'checked' : ''}><span>🌍 Anyone with a link</span></label>
        </div>
      </fieldset>
      <fieldset class="field">
        <legend>Sizes</legend>
        <div class="form-grid">
          ${SIZE_FIELDS.map(([k, label]) => `<label>${label}<input name="size_${k}" maxlength="30" value="${esc(sizes[k])}"></label>`).join('')}
        </div>
      </fieldset>
      <fieldset class="field">
        <legend>Favorites</legend>
        <div class="form-grid">
          ${FAVORITE_FIELDS.map(([k, label, ph]) => `<label>${label}<input name="fav_${k}" maxlength="120" placeholder="${esc(ph)}" value="${esc(fav[k])}"></label>`).join('')}
        </div>
      </fieldset>
      <label>Please don't buy
        <textarea name="avoid" rows="2" maxlength="300" placeholder="Things you have or don't want">${esc(p.avoid)}</textarea>
      </label>
      <fieldset class="field">
        <legend>Pay-back handles <span class="muted">(for group gifts)</span></legend>
        <div class="form-grid">
          ${PAYBACK_FIELDS.map(([k, label, ph]) => `<label>${label}<input name="pay_${k}" maxlength="80" placeholder="${esc(ph)}" value="${esc(pay[k])}"></label>`).join('')}
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save profile</button>
      </div>
    </form>`, { wide: true });

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pick = (prefix, fields) => Object.fromEntries(fields.map(([k]) => [k, String(fd.get(`${prefix}_${k}`) || '').trim()]));
    const name = String(fd.get('name') || '').trim() || state.user.name;
    const next = {
      ...p,
      name,
      photoURL: p.photoURL || state.user.photoURL || '',
      birthday: String(fd.get('birthday') || ''),
      visibility: fd.get('visibility') === 'public' ? 'public' : 'circle',
      sizes: pick('size', SIZE_FIELDS),
      favorites: pick('fav', FAVORITE_FIELDS),
      avoid: String(fd.get('avoid') || '').trim(),
      payback: pick('pay', PAYBACK_FIELDS),
    };
    try {
      await state.store.saveProfile(me(), next);
      if (name !== p.name && state.circleIds.length) {
        await state.store.updateMyMemberships(me(), state.circleIds, { name });
      }
      closeModal();
      toast('✅ Profile saved');
    } catch (err) { oops(err); }
  });
}

// Shrinks a photo (keeping proportions) so it fits in one database record (under ~900 KB).
function shrinkImage(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(src);
      let size = maxSize;
      let quality = 0.82;
      let out = '';
      for (let i = 0; i < 6; i += 1) {
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        out = canvas.toDataURL('image/jpeg', quality);
        if (out.length < 850000) return resolve(out);
        size = Math.round(size * 0.8);
        quality = Math.max(0.6, quality - 0.06);
      }
      reject(new Error('That photo is too large. Try a smaller one.'));
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('That file doesn’t look like an image.')); };
    img.src = src;
  });
}

// ---------- festive extras ----------
function startSnow() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const snow = $('#snow');
  const flakes = ['❄', '❅', '❆', '•'];
  const count = innerWidth < 600 ? 18 : 34;
  snow.innerHTML = Array.from({ length: count }, () => {
    const size = 0.5 + Math.random() * 1.1;
    return `<span class="flake" style="left:${Math.random() * 100}%;font-size:${size}rem;animation-duration:${8 + Math.random() * 10}s,${3 + Math.random() * 3}s;animation-delay:-${Math.random() * 18}s,0s;opacity:${0.3 + Math.random() * 0.45}">${flakes[Math.floor(Math.random() * flakes.length)]}</span>`;
  }).join('');
}

// ---------- boot ----------
async function init() {
  startSnow();
  const seed = await loadJSON('data/items.json', { items: [] });
  state.seedItems = seed.items || [];
  try {
    state.store = await createStore();
  } catch (err) {
    console.error(err);
    view().innerHTML = `<section class="locked"><div class="empty-emoji">📡</div><h2>Couldn't reach the server</h2>
      <p class="muted">Check your connection and reload.</p></section>`;
    return;
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });
  state.store.onAuth(onAuth);
}

init();
