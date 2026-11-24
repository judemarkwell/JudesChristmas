import { CONFIG } from './config.js';
import { createStore } from './store.js';

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
const safeImg = (u) => {
  if (typeof u === 'string' && u.startsWith('data:image/')) return u;
  return safeLink(u);
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const shopSearch = (q) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`;
const asinOf = (url) => (String(url).match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1];
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wish';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadJSON(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (err) {
    console.error(`Could not load ${path}`, err);
    return fallback;
  }
}

// Turns a pasted shopping link into a short link plus a best-guess title.
// Amazon links carry the product name in the path ("Razer-Basilisk-Wireless-Gaming").
function readLink(raw) {
  let url;
  try { url = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`); } catch { return null; }
  const asin = asinOf(url.href);
  const isAmazon = /(^|\.)amazon\./i.test(url.hostname);
  let title = '';
  if (isAmazon) {
    const parts = url.pathname.split('/').filter(Boolean);
    const dpAt = parts.findIndex((p) => p === 'dp');
    const words = dpAt > 0 ? parts[dpAt - 1] : '';
    if (words && !/^(gp|dp)$/i.test(words)) title = words.replace(/-/g, ' ');
  } else {
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    if (/[a-z]-[a-z]/i.test(last)) title = last.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ');
  }
  title = title.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const clean = isAmazon && asin ? `https://www.amazon.com/dp/${asin}` : `${url.origin}${url.pathname}`;
  return { url: clean, title, store: url.hostname.replace(/^www\./, '') };
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
  items: [],
  seedItems: [],
  profile: {},
  claims: {},
  staticMemories: [],
  savedMemories: [],
  filter: { cat: 'All', q: '', hideClaimed: false },
  elf: ls.get('jc.elf') === '1',
  elfName: ls.get('jc.elfName') || '',
};

const VIEWS = ['catalog', 'profile', 'shop', 'memories'];
const view = () => $('#view');
const currentView = () => {
  const v = location.hash.replace('#', '');
  return VIEWS.includes(v) ? v : 'catalog';
};
const isOwnerView = () => !state.elf;

// ---------- modal & toast ----------
const isPhone = () => matchMedia('(max-width: 600px)').matches;
const modal = $('#modal');
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
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});

// Phones: keep the open sheet above the on-screen keyboard.
// visualViewport shrinks when the keyboard opens (iOS keeps the layout viewport the same size),
// so the modal sizes itself to it, and the focused field scrolls to the middle of what's visible.
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
// Some viewers (an iPhone, or a page embedded in an app) never tell the page the keyboard
// is open. So on phones, the field being typed in is moved to the top of the sheet, just
// under the pinned Cancel/Save bar, where the keyboard can't reach it. Extra room is added
// below the last field while typing so even the bottom fields can scroll up that far.
let typingTimer;
modal.addEventListener('focusin', (e) => {
  const field = e.target.closest('input, textarea, select');
  if (!field || ['radio', 'checkbox', 'file'].includes(field.type) || !isPhone()) return;
  clearTimeout(typingTimer);
  modal.classList.add('typing');
  const lift = () => field.scrollIntoView({ block: 'start', behavior: 'smooth' });
  requestAnimationFrame(lift);
  setTimeout(lift, 350); // again once the keyboard has finished opening
});
modal.addEventListener('focusout', () => {
  typingTimer = setTimeout(() => {
    if (!modal.contains(document.activeElement)) modal.classList.remove('typing');
  }, 200);
});
modal.addEventListener('close', () => modal.classList.remove('typing'));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- rendering ----------
function render() {
  const v = currentView();
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === v;
    t.classList.toggle('active', active);
    if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  document.body.classList.toggle('elf-mode', state.elf);
  renderModeButton();
  if (v === 'catalog') renderCatalog();
  else if (v === 'profile') renderProfile();
  else if (v === 'shop') renderShop();
  else renderMemories();
}

function renderModeButton() {
  const btn = $('#mode-btn');
  btn.innerHTML = state.elf
    ? `🧝 <span>Elf: ${esc(state.elfName || 'Helper')}</span>`
    : `🎅 <span>${esc(CONFIG.ownerName)}'s view</span>`;
  btn.title = state.elf ? 'Leave elf mode' : 'Family member? Enter elf mode';
}

function renderStorageNote() {
  $('#storage-note').innerHTML = state.store?.mode === 'firebase'
    ? '🌟 Claims sync live for the whole family.'
    : '🧪 Demo mode: everything is saved only on this device until the shared database is connected.';
}

// ----- wishlist -----
function renderCatalog() {
  const cats = ['All', ...new Set(state.items.map((i) => i.category).filter(Boolean))];
  const f = state.filter;
  if (!cats.includes(f.cat)) f.cat = 'All';
  view().innerHTML = `
    <div class="toolbar">
      <div class="toolbar-row">
        <input id="search" class="search" type="search" placeholder="Search the list…" value="${esc(f.q)}" aria-label="Search the list">
        ${isOwnerView() ? `<button type="button" class="btn btn-primary" id="add-wish">＋ Add a wish</button>` : ''}
        ${state.elf ? `
          <label class="switch">
            <input type="checkbox" id="hide-claimed" ${f.hideClaimed ? 'checked' : ''}>
            <span class="switch-track" aria-hidden="true"></span> Hide claimed
          </label>` : ''}
      </div>
      <div class="chips" role="group" aria-label="Filter by category">
        ${cats.map((c) => `<button type="button" class="chip ${c === f.cat ? 'active' : ''}" data-cat="${esc(c)}" aria-pressed="${c === f.cat}">${esc(c)}</button>`).join('')}
      </div>
    </div>
    <div id="grid" class="grid"></div>`;

  view().querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    f.cat = b.dataset.cat;
    view().querySelectorAll('.chip').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', x === b);
    });
    renderGrid();
  }));
  $('#search').addEventListener('input', (e) => { f.q = e.target.value; renderGrid(); });
  $('#hide-claimed')?.addEventListener('change', (e) => { f.hideClaimed = e.target.checked; renderGrid(); });
  $('#add-wish')?.addEventListener('click', () => openItemEditor());
  $('#grid').addEventListener('click', onCardAction);
  renderGrid();
}

function filteredItems() {
  const { cat, q, hideClaimed } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.items.filter((i) => {
    if (cat !== 'All' && i.category !== cat) return false;
    if (state.elf && hideClaimed && state.claims[i.id]) return false;
    if (!needle) return true;
    return [i.name, i.category, i.note].join(' ').toLowerCase().includes(needle);
  });
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const items = filteredItems();
  grid.innerHTML = items.length
    ? items.map(cardHTML).join('')
    : `<div class="empty"><div class="empty-emoji">☃️</div><p>${state.items.length ? 'Nothing here. Try another filter.' : 'The list is empty. Add the first wish!'}</p></div>`;
}

function priorityHTML(p) {
  const n = Math.max(0, Math.min(3, Number(p) || 0));
  if (!n) return '';
  const label = ['', 'Nice to have', 'Would love it', 'Top wish!'][n];
  return `<span class="priority" title="${label}" aria-label="${label}">${'❤️'.repeat(n)}${'🤍'.repeat(3 - n)}</span>`;
}

function cardHTML(item) {
  const claim = state.claims[item.id];
  const mine = claim && sameName(claim.name, state.elfName);
  let status = '';
  let mainBtn = '';
  if (state.elf) {
    if (claim) {
      status = `<p class="status ${claim.purchased ? 'bought' : 'claimed'}">${claim.purchased ? '🎁 Bought' : '🔖 Claimed'} by ${esc(claim.name)}${mine ? ' (you)' : ''}</p>`;
      mainBtn = mine ? `<button type="button" class="btn btn-secondary" data-action="manage" data-id="${esc(item.id)}">Manage</button>` : '';
    } else {
      status = `<p class="status open">✨ Up for grabs</p>`;
      mainBtn = `<button type="button" class="btn btn-primary" data-action="claim" data-id="${esc(item.id)}">Claim it</button>`;
    }
  } else {
    mainBtn = `<button type="button" class="btn btn-ghost" data-action="edit" data-id="${esc(item.id)}" aria-label="Edit ${esc(item.name)}">✏️ Edit</button>`;
  }
  return `
    <article class="tag-card ${state.elf && claim ? 'is-claimed' : ''}">
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

function onCardAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === btn.dataset.id);
  if (!item) return;
  const action = btn.dataset.action;
  if (action === 'alts') openAlternatives(item);
  if (action === 'claim') openClaim(item);
  if (action === 'manage') openManage(item);
  if (action === 'edit') openItemEditor(item);
}

// ----- item editor -----
function openItemEditor(existing) {
  const it = existing || { priority: 2, emoji: '🎁' };
  const cats = [...new Set(state.items.map((i) => i.category).filter(Boolean))];
  const iconChoices = ICONS.includes(it.emoji) ? ICONS : [it.emoji, ...ICONS];
  openModal(`
    <h2>${existing ? 'Edit wish ✏️' : 'Add a wish ✨'}</h2>
    <form id="item-form" class="form" novalidate>
      <label>Link
        <input name="url" type="url" inputmode="url" placeholder="Paste a product link" value="${esc(it.url)}">
        <span class="hint" id="link-hint">Amazon links fill in the title for you.</span>
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
  const onLink = () => {
    const info = readLink(urlInput.value);
    if (!urlInput.value.trim()) { hint.textContent = 'Amazon links fill in the title for you.'; return; }
    if (!info) { hint.textContent = 'That doesn’t look like a link.'; return; }
    urlInput.value = info.url;
    if (info.title && !nameInput.value.trim()) nameInput.value = info.title;
    hint.textContent = info.title ? `From ${info.store}. Tidy the title if you like.` : `From ${info.store}.`;
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
    };
    try {
      state.items = await state.store.saveItem(item, state.items);
      closeModal();
      toast(existing ? '✅ Wish updated' : `✨ Added ${item.name}`);
    } catch {
      err.textContent = 'Could not save. Try again.';
      err.hidden = false;
    }
  });

  $('#delete-item')?.addEventListener('click', async () => {
    if (!(await askConfirm('Remove this wish?', `"${existing.name}" will come off your list. If someone already claimed it, they'll see it was removed.`, 'Remove'))) return;
    state.items = await state.store.deleteItem(existing.id, state.items);
    closeModal();
    toast('🗑️ Removed from your list');
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
            <div>
              <strong>${esc(a.name)}</strong>
              ${a.note ? `<p>${esc(a.note)}</p>` : ''}
            </div>
            <a class="btn btn-ghost small" href="${shopSearch(a.query || a.name)}" target="_blank" rel="noopener noreferrer">Find it ↗</a>
          </li>`).join('')}
      </ul>` : `<p>No budget picks for this one yet, but the price links below can still help.</p>`}
    <div class="deal-links">
      <a class="btn btn-secondary" href="${shopSearch(item.name)}" target="_blank" rel="noopener noreferrer">🔎 Compare prices</a>
      ${asin ? `<a class="btn btn-secondary" href="https://camelcamelcamel.com/product/${asin}" target="_blank" rel="noopener noreferrer">📉 Amazon price history</a>` : ''}
    </div>`);
}

// ----- claiming -----
function openClaim(item) {
  openModal(`
    <h2>Claim this gift 🎁</h2>
    <p class="muted">${esc(item.name)}</p>
    <form id="claim-form" class="form">
      <label>Your name
        <input name="name" required maxlength="40" autocomplete="given-name" value="${esc(state.elfName)}">
      </label>
      <label><span>Note for other elves <span class="muted">(optional)</span></span>
        <input name="note" maxlength="140" placeholder="e.g. getting the blue one">
      </label>
      <label class="check"><input type="checkbox" name="purchased"> I've already bought it</label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Claim it</button>
      </div>
    </form>`);
  $('#claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name')).trim();
    if (!name) return;
    setElfName(name);
    try {
      await state.store.claim(item.id, {
        name,
        itemName: item.name,
        note: String(fd.get('note') || '').trim(),
        purchased: fd.get('purchased') === 'on',
      });
      closeModal();
      toast(`🎉 ${item.name} is yours to wrap!`);
    } catch (err) {
      closeModal();
      toast(err.message === 'already-claimed' ? '🏃 Another elf just claimed that one!' : '😬 Something went wrong. Try again.');
    }
  });
}

function openManage(item) {
  const claim = state.claims[item.id];
  if (!claim) return;
  openModal(`
    <h2>Your gift 🎀</h2>
    <p class="muted">${esc(item.name)}</p>
    <form id="manage-form" class="form">
      <label>Note for other elves
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
    await state.store.updateClaim(item.id, {
      note: String(fd.get('note') || '').trim(),
      purchased: fd.get('purchased') === 'on',
    });
    closeModal();
    toast('✅ Saved');
  });
  $('#unclaim-btn').addEventListener('click', async () => {
    if (!(await askConfirm('Release this gift?', `"${item.name}" goes back on the list so another elf can claim it.`, 'Release'))) return;
    await state.store.unclaim(item.id);
    closeModal();
    toast('🎈 Released back to the list');
  });
}

// ----- profile / sizes -----
function renderProfile() {
  const p = state.profile;
  const sizes = p.sizes || {};
  const fav = p.favorites || {};
  const pay = p.payback || {};
  const empty = '<span class="muted">Not added yet</span>';
  const initial = esc((p.name || CONFIG.ownerName || '?').trim().charAt(0).toUpperCase());
  const bday = p.birthday ? new Date(`${p.birthday}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '';
  const filledSizes = SIZE_FIELDS.filter(([k]) => sizes[k]).length;

  view().innerHTML = `
    <section class="profile">
      <div class="profile-head">
        <div class="avatar" aria-hidden="true">${initial}</div>
        <div class="profile-id">
          <h2>${esc(p.name || CONFIG.ownerName)}</h2>
          <p class="muted">${bday ? `🎂 Birthday: ${esc(bday)}` : 'Birthday not added'} · ${p.visibility === 'public' ? '🌍 Public profile' : '🔒 Family circle only'}</p>
        </div>
        ${isOwnerView() ? `<button type="button" class="btn btn-primary" id="edit-profile">✏️ Edit</button>` : ''}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Sizes</h3>
          <span class="muted small">${filledSizes}/${SIZE_FIELDS.length} added</span>
        </div>
        <dl class="size-grid">
          ${SIZE_FIELDS.map(([k, label]) => `
            <div class="size-tile ${sizes[k] ? '' : 'is-empty'}">
              <dt>${label}</dt>
              <dd>${sizes[k] ? esc(sizes[k]) : '—'}</dd>
            </div>`).join('')}
        </dl>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Favorites</h3></div>
        <dl class="fact-list">
          ${FAVORITE_FIELDS.map(([k, label]) => `<div><dt>${label}</dt><dd>${fav[k] ? esc(fav[k]) : empty}</dd></div>`).join('')}
        </dl>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Please don't buy</h3></div>
        <p class="panel-text">${p.avoid ? esc(p.avoid) : empty}</p>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Pay-back handles</h3><span class="muted small">for group gifts</span></div>
        <dl class="fact-list">
          ${PAYBACK_FIELDS.map(([k, label]) => `<div><dt>${label}</dt><dd>${pay[k] ? esc(pay[k]) : empty}</dd></div>`).join('')}
        </dl>
      </div>
    </section>`;
  $('#edit-profile')?.addEventListener('click', openProfileEditor);
}

function openProfileEditor() {
  const p = state.profile;
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
          <label class="seg-opt"><input type="radio" name="visibility" value="circle" ${p.visibility !== 'public' ? 'checked' : ''}><span>🔒 Family circle</span></label>
          <label class="seg-opt"><input type="radio" name="visibility" value="public" ${p.visibility === 'public' ? 'checked' : ''}><span>🌍 Anyone with the link</span></label>
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
    const next = {
      ...p,
      name: String(fd.get('name') || '').trim() || CONFIG.ownerName,
      birthday: String(fd.get('birthday') || ''),
      visibility: fd.get('visibility') === 'public' ? 'public' : 'circle',
      sizes: pick('size', SIZE_FIELDS),
      favorites: pick('fav', FAVORITE_FIELDS),
      avoid: String(fd.get('avoid') || '').trim(),
      payback: pick('pay', PAYBACK_FIELDS),
    };
    try {
      state.profile = await state.store.saveProfile(next);
      closeModal();
      toast('✅ Profile saved');
    } catch {
      toast('😬 Could not save. Try again.');
    }
  });
}

// ----- elf shop -----
function renderShop() {
  if (!state.elf) {
    view().innerHTML = `
      <section class="locked">
        <div class="locked-emoji" aria-hidden="true">🙈</div>
        <h2>No peeking, ${esc(CONFIG.ownerName)}!</h2>
        <p>This is where the family keeps track of who's getting what.
           If you're one of Santa's helpers, check in to see the shop.</p>
        <button type="button" class="btn btn-primary" id="enter-elf">I'm an elf 🧝</button>
      </section>`;
    $('#enter-elf').addEventListener('click', openElfCheckIn);
    return;
  }

  const total = state.items.length;
  const claimedItems = state.items.filter((i) => state.claims[i.id]);
  const bought = claimedItems.filter((i) => state.claims[i.id].purchased).length;
  const open = state.items.filter((i) => !state.claims[i.id]);
  const mine = claimedItems.filter((i) => sameName(state.claims[i.id].name, state.elfName));
  const others = claimedItems.filter((i) => !sameName(state.claims[i.id].name, state.elfName));
  const byElf = others.reduce((acc, i) => {
    const n = state.claims[i.id].name;
    (acc[n] ||= []).push(i);
    return acc;
  }, {});
  // Claims whose item the owner has since removed from the list.
  const ids = new Set(state.items.map((i) => i.id));
  const orphaned = Object.entries(state.claims)
    .filter(([id, c]) => !ids.has(id) && sameName(c.name, state.elfName));
  const pct = total ? Math.round((claimedItems.length / total) * 100) : 0;

  const row = (i, manage) => {
    const c = state.claims[i.id];
    return `
      <li class="shop-row ${c.purchased ? 'is-bought' : ''}">
        <span class="row-emoji" aria-hidden="true">${esc(i.emoji || '🎁')}</span>
        <div class="row-main">
          <strong>${esc(i.name)}</strong>
          ${c.note ? `<span class="row-note">“${esc(c.note)}”</span>` : ''}
        </div>
        <span class="pill ${c.purchased ? 'pill-green' : 'pill-gold'}">${c.purchased ? 'Bought' : 'Claimed'}</span>
        ${manage ? `<button type="button" class="btn btn-ghost small" data-action="manage" data-id="${esc(i.id)}">Manage</button>` : ''}
      </li>`;
  };

  view().innerHTML = `
    <section class="shop">
      <div class="stats">
        <div class="stat"><span class="stat-num">${claimedItems.length}/${total}</span><span>claimed</span></div>
        <div class="stat"><span class="stat-num">${bought}</span><span>bought</span></div>
        <div class="stat"><span class="stat-num">${open.length}</span><span>up for grabs</span></div>
      </div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Gifts claimed">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>

      ${orphaned.length ? `
        <div class="notice">
          <strong>Heads up:</strong> ${esc(CONFIG.ownerName)} removed ${orphaned.length === 1 ? 'a gift' : `${orphaned.length} gifts`} you claimed.
          <ul>${orphaned.map(([id, c]) => `<li>${esc(c.itemName || id)}${c.purchased ? ' (you bought it)' : ''} <button type="button" class="btn btn-ghost small" data-orphan="${esc(id)}">Dismiss</button></li>`).join('')}</ul>
        </div>` : ''}

      <h2 class="section-title">Your sleigh 🛷</h2>
      ${mine.length ? `<ul class="shop-list">${mine.map((i) => row(i, true)).join('')}</ul>`
        : `<p class="muted">You haven't claimed anything yet. Pick something below or from the wishlist.</p>`}

      <h2 class="section-title">Other elves</h2>
      ${Object.keys(byElf).length ? Object.entries(byElf).map(([name, list]) => `
        <h3 class="elf-name">🧝 ${esc(name)}</h3>
        <ul class="shop-list">${list.map((i) => row(i, false)).join('')}</ul>`).join('')
        : `<p class="muted">No one else has claimed anything yet.</p>`}

      <h2 class="section-title">Still up for grabs ✨</h2>
      ${open.length ? `<ul class="shop-list">${open.map((i) => `
        <li class="shop-row">
          <span class="row-emoji" aria-hidden="true">${esc(i.emoji || '🎁')}</span>
          <div class="row-main"><strong>${esc(i.name)}</strong><span class="row-note">${esc(i.category || '')}</span></div>
          <button type="button" class="btn btn-primary small" data-action="claim" data-id="${esc(i.id)}">Claim</button>
        </li>`).join('')}</ul>`
        : `<p class="muted">Every wish is claimed. Great work, elves! 🎉</p>`}
    </section>`;
  const shop = view().querySelector('.shop');
  shop.addEventListener('click', onCardAction);
  shop.querySelectorAll('[data-orphan]').forEach((b) => b.addEventListener('click', async () => {
    await state.store.unclaim(b.dataset.orphan);
  }));
}

// ----- elf mode -----
function setElfName(name) {
  state.elfName = name;
  ls.set('jc.elfName', name);
}

function openElfCheckIn() {
  openModal(`
    <h2>Elf check-in 🧝</h2>
    <p class="muted">Elf mode shows who has claimed what. ${esc(CONFIG.ownerName)}, close your eyes!</p>
    <form id="elf-form" class="form">
      <label>Family code
        <input name="code" type="password" required autocomplete="off">
      </label>
      <label>Your name
        <input name="name" required maxlength="40" autocomplete="given-name" value="${esc(state.elfName)}">
      </label>
      <p class="form-error" id="elf-error" hidden>That's not the code. Ask a family member for it.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Let me in</button>
      </div>
    </form>`);
  $('#elf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let ok = false;
    try {
      ok = (await sha256(String(fd.get('code')).trim().toLowerCase())) === CONFIG.familyCodeHash;
    } catch {
      ok = false;
    }
    if (!ok) {
      $('#elf-error').hidden = false;
      e.target.classList.remove('shake');
      void e.target.offsetWidth;
      e.target.classList.add('shake');
      return;
    }
    state.elf = true;
    ls.set('jc.elf', '1');
    setElfName(String(fd.get('name')).trim());
    closeModal();
    toast(`Welcome to the workshop, ${state.elfName}! 🧝`);
    render();
  });
}

function onModeClick() {
  if (!state.elf) { openElfCheckIn(); return; }
  openModal(`
    <h2>Leave elf mode?</h2>
    <p class="muted">Claims will be hidden again on this device.</p>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-close>Stay</button>
      <button type="button" class="btn btn-primary" id="leave-elf">Leave</button>
    </div>`);
  $('#leave-elf').addEventListener('click', () => {
    state.elf = false;
    ls.del('jc.elf');
    closeModal();
    if (currentView() === 'shop') location.hash = '#catalog';
    render();
  });
}

// ----- memories -----
async function refreshMemories() {
  try {
    state.savedMemories = await state.store.listMemories();
  } catch (err) {
    console.error('Could not load memories', err);
    state.savedMemories = [];
  }
}

function renderMemories() {
  const all = [...state.staticMemories, ...state.savedMemories];
  const byYear = all.reduce((acc, m) => {
    const y = Number(m.year) || 'Undated';
    (acc[y] ||= []).push(m);
    return acc;
  }, {});
  const years = Object.keys(byYear).sort((a, b) => (Number(b) || 0) - (Number(a) || 0));

  view().innerHTML = `
    <section class="memories">
      <div class="memories-head">
        <h2 class="section-title">Christmas memories</h2>
        <button type="button" class="btn btn-primary" id="add-memory">＋ Add a memory</button>
      </div>
      ${years.length ? years.map((y) => `
        <h3 class="year-title"><span>${esc(y)}</span></h3>
        <div class="polaroids">
          ${byYear[y].map((m) => `
            <figure class="polaroid" data-id="${esc(m.id)}" tabindex="0" role="button" aria-label="Open photo: ${esc(m.caption || 'memory')}">
              <img src="${safeImg(m.image)}" alt="${esc(m.caption || 'Christmas memory')}" loading="lazy">
              <figcaption>${esc(m.caption || '')}</figcaption>
            </figure>`).join('')}
        </div>`).join('')
      : `<div class="empty"><div class="empty-emoji">📷</div>
           <p>No memories yet. Add the first photo and start the scrapbook.</p></div>`}
    </section>`;

  $('#add-memory').addEventListener('click', openAddMemory);
  const open = (el) => {
    const m = all.find((x) => String(x.id) === el.dataset.id);
    if (m) openLightbox(m);
  };
  view().querySelectorAll('.polaroid').forEach((el) => {
    el.addEventListener('click', () => open(el));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(el); } });
  });
}

function openLightbox(m) {
  const deletable = state.savedMemories.some((x) => x.id === m.id);
  openModal(`
    <figure class="lightbox">
      <img src="${safeImg(m.image)}" alt="${esc(m.caption || 'Christmas memory')}">
      <figcaption><strong>${esc(m.year || '')}</strong> ${esc(m.caption || '')}</figcaption>
    </figure>
    ${deletable ? `<div class="form-actions"><button type="button" class="btn btn-danger small" id="del-memory">Delete photo</button></div>` : ''}`, { wide: true });
  $('#del-memory')?.addEventListener('click', async () => {
    if (!(await askConfirm('Delete this memory?', 'This photo will be removed for good.', 'Delete'))) return;
    await state.store.deleteMemory(m.id);
    await refreshMemories();
    closeModal();
    toast('🗑️ Memory deleted');
  });
}

function openAddMemory() {
  const year = new Date().getFullYear();
  openModal(`
    <h2>Add a memory 📸</h2>
    <form id="memory-form" class="form">
      <label>Year
        <input name="year" type="number" min="1950" max="${year + 1}" value="${year}" required>
      </label>
      <label>Caption
        <input name="caption" maxlength="140" placeholder="e.g. Grandma's cookie marathon">
      </label>
      <label>Photo
        <input name="file" type="file" accept="image/*">
      </label>
      <label>…or an image link
        <input name="url" type="url" placeholder="https://">
      </label>
      <p class="form-error" id="mem-error" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save memory</button>
      </div>
    </form>`);
  $('#memory-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const file = fd.get('file');
    const url = String(fd.get('url') || '').trim();
    const err = $('#mem-error');
    const submit = e.target.querySelector('[type=submit]');
    let image = '';
    try {
      submit.disabled = true;
      submit.textContent = 'Saving…';
      if (file && file.size) image = await shrinkImage(file, CONFIG.memoryMaxSize);
      else if (url) image = url;
      if (!image) throw new Error('Pick a photo or paste an image link.');
      await state.store.addMemory({
        year: Number(fd.get('year')),
        caption: String(fd.get('caption') || '').trim(),
        image,
      });
      await refreshMemories();
      closeModal();
      toast('📸 Memory saved!');
    } catch (ex) {
      err.textContent = ex.message === 'storage-full'
        ? 'This browser is out of space. Connecting the shared database fixes this.'
        : ex.message || 'Could not save that photo.';
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Save memory';
    }
  });
}

// Shrinks a photo so it fits comfortably in storage, keeping its proportions.
function shrinkImage(file, maxSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
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

function startCountdown() {
  const el = $('#countdown');
  const tick = () => {
    const now = new Date();
    let xmas = new Date(now.getFullYear(), 11, 25);
    if (now.getMonth() === 11 && now.getDate() === 25) {
      el.innerHTML = '🎄 <strong>Merry Christmas!</strong> 🎄';
      return;
    }
    if (now > xmas) xmas = new Date(now.getFullYear() + 1, 11, 25);
    const days = Math.ceil((xmas - now) / 86400000);
    el.innerHTML = `<span class="count-num">${days}</span> <span>sleep${days === 1 ? '' : 's'} till Christmas</span>`;
  };
  tick();
  setInterval(tick, 60 * 60 * 1000);
}

// ---------- boot ----------
async function init() {
  startSnow();
  startCountdown();
  const [itemsData, memoriesData, profileData] = await Promise.all([
    loadJSON('data/items.json', { items: [] }),
    loadJSON('data/memories.json', { memories: [] }),
    loadJSON('data/profile.json', { profile: {} }),
  ]);
  state.seedItems = itemsData.items || [];
  state.staticMemories = memoriesData.memories || [];
  state.store = await createStore();
  state.items = await state.store.listItems(state.seedItems);
  state.profile = await state.store.getProfile(profileData.profile || {});
  renderStorageNote();
  await refreshMemories();
  state.store.subscribeClaims((claims) => {
    state.claims = claims;
    // Don't wipe a form the user is filling in; closing the modal re-renders.
    if (!modal.open) render();
  });
  modal.addEventListener('close', render);
  window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });
  $('#mode-btn').addEventListener('click', onModeClick);
  render();
}

init();
