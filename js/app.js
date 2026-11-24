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
const asinOf = (url) => (String(url).match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

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

// ---------- state ----------
const state = {
  store: null,
  items: [],
  claims: {},
  staticMemories: [],
  savedMemories: [],
  filter: { cat: 'All', q: '', hideClaimed: false },
  elf: ls.get('jc.elf') === '1',
  elfName: ls.get('jc.elfName') || '',
};

const view = () => $('#view');
const currentView = () => {
  const v = location.hash.replace('#', '');
  return ['catalog', 'shop', 'memories'].includes(v) ? v : 'catalog';
};

// ---------- modal & toast ----------
const modal = $('#modal');
function openModal(html) {
  $('.modal-body', modal).innerHTML = html;
  if (!modal.open) modal.showModal();
  const first = modal.querySelector('input, select, textarea');
  if (first) first.focus();
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});

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
    : '🧪 Demo mode: claims are only saved on this device until the shared database is connected.';
}

// ----- catalog -----
function renderCatalog() {
  const cats = ['All', ...new Set(state.items.map((i) => i.category))];
  const f = state.filter;
  view().innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Filter by category">
        ${cats.map((c) => `<button type="button" class="chip ${c === f.cat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div class="toolbar-row">
        <input id="search" class="search" type="search" placeholder="Search the list…" value="${esc(f.q)}" aria-label="Search the list">
        ${state.elf ? `
          <label class="switch">
            <input type="checkbox" id="hide-claimed" ${f.hideClaimed ? 'checked' : ''}>
            <span class="switch-track" aria-hidden="true"></span> Hide claimed
          </label>` : ''}
      </div>
    </div>
    <div id="grid" class="grid"></div>`;

  view().querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    f.cat = b.dataset.cat;
    view().querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === b));
    renderGrid();
  }));
  $('#search').addEventListener('input', (e) => { f.q = e.target.value; renderGrid(); });
  $('#hide-claimed')?.addEventListener('change', (e) => { f.hideClaimed = e.target.checked; renderGrid(); });
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
    : `<div class="empty"><div class="empty-emoji">☃️</div><p>Nothing here. Try another filter.</p></div>`;
}

function priorityHTML(p) {
  const n = Math.max(0, Math.min(3, Number(p) || 0));
  if (!n) return '';
  const label = ['', 'Nice to have', 'Would love it', 'Top wish!'][n];
  return `<span class="priority" title="${label}" aria-label="${label}">${'❤️'.repeat(n)}${'🤍'.repeat(3 - n)}</span>`;
}

function cardHTML(item, index) {
  const claim = state.claims[item.id];
  const mine = claim && sameName(claim.name, state.elfName);
  const rot = ((index * 37) % 5) - 2; // gentle, stable tilt per card
  let status = '';
  let claimBtn = '';
  if (state.elf) {
    if (claim) {
      status = `<p class="status ${claim.purchased ? 'bought' : 'claimed'}">${claim.purchased ? '🎁 Bought' : '🔖 Claimed'} by ${esc(claim.name)}${mine ? ' (you)' : ''}</p>`;
      claimBtn = mine ? `<button type="button" class="btn btn-secondary" data-action="manage" data-id="${esc(item.id)}">Manage</button>` : '';
    } else {
      status = `<p class="status open">✨ Up for grabs</p>`;
      claimBtn = `<button type="button" class="btn btn-primary" data-action="claim" data-id="${esc(item.id)}">Claim it</button>`;
    }
  }
  return `
    <article class="tag-card ${state.elf && claim ? 'is-claimed' : ''}" style="--rot:${rot}deg">
      <span class="tag-hole" aria-hidden="true"></span>
      <div class="card-top">
        <span class="card-emoji" aria-hidden="true">${esc(item.emoji || '🎁')}</span>
        ${priorityHTML(item.priority)}
      </div>
      <h3 class="card-title">${esc(item.name)}</h3>
      <p class="card-cat">${esc(item.category)}</p>
      ${item.note ? `<p class="card-note">${esc(item.note)}</p>` : ''}
      ${item.details?.length ? `<ul class="card-details">${item.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      ${item.price ? `<p class="price">About $${esc(item.price)}</p>` : ''}
      ${status}
      <div class="card-actions">
        <a class="btn btn-ghost" href="${safeLink(item.url)}" target="_blank" rel="noopener noreferrer">View item ↗</a>
        <button type="button" class="btn btn-ghost" data-action="alts" data-id="${esc(item.id)}">Cheaper options</button>
        ${claimBtn}
      </div>
    </article>`;
}

function onCardAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === btn.dataset.id);
  if (!item) return;
  if (btn.dataset.action === 'alts') openAlternatives(item);
  if (btn.dataset.action === 'claim') openClaim(item);
  if (btn.dataset.action === 'manage') openManage(item);
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
      </ul>` : `<p>No budget picks for this one yet, but the price check links below can still help.</p>`}
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
      <label>Note for other elves <span class="muted">(optional)</span>
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
    if (!confirm(`Release "${item.name}" so another elf can claim it?`)) return;
    await state.store.unclaim(item.id);
    closeModal();
    toast('🎈 Released back to the list');
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

      <h2 class="section-title">Your sleigh 🛷</h2>
      ${mine.length ? `<ul class="shop-list">${mine.map((i) => row(i, true)).join('')}</ul>`
        : `<p class="muted">You haven't claimed anything yet. Pick something below or from the catalog.</p>`}

      <h2 class="section-title">Other elves</h2>
      ${Object.keys(byElf).length ? Object.entries(byElf).map(([name, list]) => `
        <h3 class="elf-name">🧝 ${esc(name)}</h3>
        <ul class="shop-list">${list.map((i) => row(i, false)).join('')}</ul>`).join('')
        : `<p class="muted">No one else has claimed anything yet.</p>`}

      <h2 class="section-title">Still up for grabs ✨</h2>
      ${open.length ? `<ul class="shop-list">${open.map((i) => `
        <li class="shop-row">
          <span class="row-emoji" aria-hidden="true">${esc(i.emoji || '🎁')}</span>
          <div class="row-main"><strong>${esc(i.name)}</strong><span class="row-note">${esc(i.category)}</span></div>
          <button type="button" class="btn btn-primary small" data-action="claim" data-id="${esc(i.id)}">Claim</button>
        </li>`).join('')}</ul>`
        : `<p class="muted">Every wish is claimed. Great work, elves! 🎉</p>`}
    </section>`;
  view().querySelector('.shop').addEventListener('click', onCardAction);
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
          ${byYear[y].map((m, i) => `
            <figure class="polaroid" style="--rot:${(i % 2 ? 1 : -1) * (1 + (i % 3))}deg" data-id="${esc(m.id)}" tabindex="0" role="button" aria-label="Open photo: ${esc(m.caption || 'memory')}">
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
    ${deletable ? `<div class="form-actions"><button type="button" class="btn btn-danger small" id="del-memory">Delete photo</button></div>` : ''}`);
  $('#del-memory')?.addEventListener('click', async () => {
    if (!confirm('Delete this memory? This can’t be undone.')) return;
    await state.store.deleteMemory(m.id);
    await refreshMemories();
    closeModal();
    render();
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
      render();
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
  const count = innerWidth < 600 ? 22 : 40;
  snow.innerHTML = Array.from({ length: count }, () => {
    const size = 0.5 + Math.random() * 1.1;
    return `<span class="flake" style="left:${Math.random() * 100}%;font-size:${size}rem;animation-duration:${8 + Math.random() * 10}s,${3 + Math.random() * 3}s;animation-delay:-${Math.random() * 18}s,0s;opacity:${0.35 + Math.random() * 0.5}">${flakes[Math.floor(Math.random() * flakes.length)]}</span>`;
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
  const [itemsData, memoriesData] = await Promise.all([
    loadJSON('data/items.json', { items: [] }),
    loadJSON('data/memories.json', { memories: [] }),
  ]);
  state.items = itemsData.items || [];
  state.staticMemories = memoriesData.memories || [];
  state.store = await createStore();
  renderStorageNote();
  await refreshMemories();
  state.store.subscribeClaims((claims) => {
    state.claims = claims;
    // Don't wipe a form the user is filling in; the next render catches up.
    if (!modal.open) render();
  });
  modal.addEventListener('close', render);
  window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#mode-btn').addEventListener('click', onModeClick);
  render();
}

init();
