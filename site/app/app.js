// Agent Brain: your chats, and chats shared with you.
// Plain JS, no build step. Every string from the server is escaped before it
// reaches the DOM; the only markup kept is <b> in search snippets.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const snippetHtml = (s) => esc(s).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'undated');
const toolOf = (s) => (s.provider && s.provider !== s.source ? `${s.source} · ${s.provider}` : s.source);
const brainLabel = (b) => (b ? b.split('/').pop().replace(/-knowledge$/, '') : 'no client');

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new Error('signed out');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const state = { me: null, current: null, results: [] };

// ---------- routing ----------
function route() {
  const share = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  const tab = share ? 'share' : location.hash === '#shared' ? 'shared' : location.hash === '#shares' ? 'shares' : 'mine';
  for (const v of ['mine', 'shared', 'shares', 'share']) $(`#view-${v}`).hidden = v !== tab;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (tab === 'mine') loadMine();
  if (tab === 'shared') loadShared();
  if (tab === 'shares') loadShares();
  if (tab === 'share') openShare(share[1]);
}
window.addEventListener('hashchange', route);

// ---------- my chats ----------
let facetsLoaded = false;
async function loadFacets() {
  if (facetsLoaded) return;
  facetsLoaded = true;
  const { brains, tools } = await api('/facets');
  $('#f-brain').insertAdjacentHTML('beforeend', brains.filter((b) => b.brain).map((b) => `<option value="${esc(b.brain)}">${esc(brainLabel(b.brain))} (${b.count})</option>`).join(''));
  $('#f-tool').insertAdjacentHTML('beforeend', tools.map((t) => `<option value="${esc(t.tool)}">${esc(t.tool)} (${t.count})</option>`).join(''));
}

let searchSeq = 0;
async function loadMine() {
  loadFacets().catch(() => {});
  const seq = ++searchSeq;
  const params = new URLSearchParams();
  for (const [key, el] of [['q', '#q'], ['brain', '#f-brain'], ['tool', '#f-tool'], ['since', '#f-since'], ['until', '#f-until']]) {
    if ($(el).value) params.set(key, $(el).value);
  }
  $('#results').innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  try {
    const { sessions } = await api(`/sessions?${params}`);
    if (seq !== searchSeq) return;
    state.results = sessions;
    renderResults();
  } catch (error) {
    $('#results').innerHTML = `<li class="empty">${esc(error.message)}</li>`;
  }
}

function renderResults() {
  const list = $('#results');
  if (!state.results.length) {
    list.innerHTML = '<li class="empty">No chats match. Try fewer words or clear a filter.</li>';
    return;
  }
  list.innerHTML = state.results.map((s, i) => `
    <li><button class="card${state.current && state.current.id === s.id && state.current.source === s.source ? ' active' : ''}" data-i="${i}">
      <h3>${esc(s.title)}</h3>
      <div class="meta"><span class="chip tool">${esc(toolOf(s))}</span><span class="chip brain">${esc(brainLabel(s.brain))}</span><span class="chip">${esc(day(s.updated_at || s.started_at))}</span><span class="chip">${s.turn_count} turns</span></div>
      ${s.snippet ? `<p class="snippet">${snippetHtml(s.snippet)}</p>` : ''}
    </button></li>`).join('');
}

$('#results').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const s = state.results[Number(card.dataset.i)];
  openChat({ session: s.id, source: s.source });
});

let debounce;
$('#search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadMine, 250); });
$('#search').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(debounce); loadMine(); });

async function openChat(ref, from) {
  const detail = $('#detail');
  detail.hidden = false;
  $('.split').classList.add('open');
  if (!from) detail.innerHTML = '<div class="skeleton"></div>';
  const params = new URLSearchParams({ session: ref.session, source: ref.source, max: '60' });
  if (from) params.set('from', String(from));
  try {
    const { session } = await api(`/session?${params}`);
    if (from && state.current) {
      state.current.turns.push(...session.turns);
      state.current.window = session.window;
    } else {
      state.current = session;
    }
    renderResults();
    renderChat(detail, state.current, { mine: true });
  } catch (error) {
    detail.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function renderChat(el, s, { mine, owner, shareInfo } = {}) {
  const firstShown = s.allowed.from;
  const turns = s.turns.map((t, i) => {
    const n = firstShown + i;
    const role = t.role === 'user' || t.role === 'assistant' ? t.role : 'other';
    const long = t.text.length > 1400;
    return `<div class="turn ${role}${long ? ' clamped' : ''}" id="turn-${n}">
      <div class="who">${esc(t.role || 'turn')} · turn ${n}</div>
      <div class="text">${esc(t.text)}</div>
      ${long ? '<button class="btn small more" data-act="expand">Show all</button>' : ''}
    </div>`;
  }).join('');
  const more = s.window.to < s.allowed.to ? `<button class="btn" data-act="more" data-from="${s.window.to + 1}">Load more turns (${s.allowed.to - s.window.to} left)</button>` : '';
  const banner = mine
    ? ''
    : `<p class="banner">Shared with you by <strong>${esc(owner)}</strong>${s.allowed.from > 1 || s.allowed.to < s.turn_count ? `, turns ${s.allowed.from} to ${s.allowed.to} of ${s.turn_count}` : ''}. Read only.${shareInfo && shareInfo.note ? ` Note: “${esc(shareInfo.note)}”` : ''}</p>`;
  el.innerHTML = `
    <header>
      ${banner}
      <h2>${esc(s.title)}</h2>
      <div class="meta"><span class="chip tool">${esc(toolOf(s))}</span><span class="chip brain">${esc(brainLabel(s.brain))}</span><span class="chip">${esc(day(s.started_at))}</span><span class="chip">${s.turn_count} turns</span></div>
      ${mine ? '<div class="bar"><button class="btn primary" data-act="share">Share this chat</button><button class="btn ghost" data-act="close">Close</button></div>' : ''}
    </header>
    ${turns || '<p class="empty">No turns.</p>'}
    ${more}`;
}

$('#detail').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'expand') { e.target.closest('.turn').classList.remove('clamped'); e.target.remove(); }
  if (act === 'more') openChat({ session: state.current.id, source: state.current.source }, Number(e.target.dataset.from));
  if (act === 'close') { $('#detail').hidden = true; $('.split').classList.remove('open'); state.current = null; renderResults(); }
  if (act === 'share') openShareDialog(state.current);
});

// ---------- share dialog ----------
const dialog = $('#share-dialog');
let shareTarget = null;

function shareBody() {
  const exp = $('#s-expires').value;
  return {
    session: shareTarget.id,
    source: shareTarget.source,
    with: $('#s-with').value.trim(),
    from_turn: $('#s-from').value ? Number($('#s-from').value) : undefined,
    to_turn: $('#s-to').value ? Number($('#s-to').value) : undefined,
    expires: exp === 'never' ? 'never' : Number(exp),
    note: $('#s-note').value.trim() || undefined,
  };
}

function resetShareResult() {
  $('#s-preview').hidden = true;
  $('#s-error').hidden = true;
  $('#s-done').hidden = true;
  $('#s-confirm').disabled = true;
  $('#s-preview-btn').hidden = false;
  $('#s-confirm').hidden = false;
}

function openShareDialog(session) {
  shareTarget = session;
  $('#share-title').textContent = `“${session.title}”, ${session.turn_count} turns`;
  $('#s-to').max = $('#s-from').max = String(session.turn_count);
  for (const id of ['#s-with', '#s-from', '#s-to', '#s-note']) $(id).value = '';
  $('#s-expires').value = '30';
  resetShareResult();
  dialog.showModal();
  $('#s-with').focus();
}

for (const id of ['#s-with', '#s-from', '#s-to', '#s-expires', '#s-note']) {
  $(id).addEventListener('input', () => { if (!$('#s-done').hidden) return; resetShareResult(); });
}

$('#s-preview-btn').addEventListener('click', async () => {
  $('#s-error').hidden = true;
  try {
    const { preview } = await api('/shares/preview', { method: 'POST', body: JSON.stringify(shareBody()) });
    $('#s-preview').textContent = preview;
    $('#s-preview').hidden = false;
    $('#s-confirm').disabled = false;
  } catch (error) {
    $('#s-error').textContent = error.message;
    $('#s-error').hidden = false;
  }
});

$('#s-confirm').addEventListener('click', async () => {
  $('#s-confirm').disabled = true;
  try {
    const { link } = await api('/shares', { method: 'POST', body: JSON.stringify(shareBody()) });
    $('#s-link').value = link;
    $('#s-done').hidden = false;
    $('#s-preview-btn').hidden = true;
    $('#s-confirm').hidden = true;
  } catch (error) {
    $('#s-error').textContent = error.message;
    $('#s-error').hidden = false;
    $('#s-confirm').disabled = false;
  }
});

$('#s-copy').addEventListener('click', async () => {
  $('#s-link').select();
  try { await navigator.clipboard.writeText($('#s-link').value); $('#s-copy').textContent = 'Copied'; } catch { document.execCommand('copy'); }
  setTimeout(() => { $('#s-copy').textContent = 'Copy'; }, 1500);
});
$('#s-cancel').addEventListener('click', () => dialog.close());

// ---------- shared with me ----------
async function loadShared() {
  const list = $('#shared-list');
  list.innerHTML = '<li class="skeleton"></li>';
  try {
    const { email, shares } = await api('/shared-with-me');
    $('#shared-email').textContent = email ? `Chats shared with ${email}.` : 'Your sign-in has no verified email, so no shares can reach you.';
    list.innerHTML = shares.length
      ? shares.map((s) => `<li><a class="card" href="/s/${esc(s.id)}"><h3>${esc(s.title)}</h3><div class="meta"><span class="chip">from ${esc(s.owner)}</span><span class="chip">${esc(day(s.created_at))}</span>${s.expires_at ? `<span class="chip">until ${esc(day(s.expires_at))}</span>` : ''}</div></a></li>`).join('')
      : '<li class="empty">Nothing is shared with you yet.</li>';
  } catch (error) {
    list.innerHTML = `<li class="empty">${esc(error.message)}</li>`;
  }
}

// ---------- my shares ----------
async function loadShares() {
  const list = $('#shares-list');
  list.innerHTML = '<li class="skeleton"></li>';
  try {
    const { shares } = await api('/shares');
    list.innerHTML = shares.length
      ? shares.map((s) => `<li><div class="card" style="cursor:default">
          <h3>${esc(s.title || s.session_id)}</h3>
          <div class="meta"><span class="chip brain">${esc(s.with)}</span><span class="chip">${s.turn_from || s.turn_to ? `turns ${s.turn_from || 1}-${s.turn_to || 'end'}` : 'whole chat'}</span><span class="chip">${s.expires_at ? `until ${esc(day(s.expires_at))}` : 'no expiry'}</span><span class="chip status-${s.status}">${s.status}</span></div>
          <div class="bar"><a class="btn small" href="/s/${esc(s.id)}">Open</a>${s.status === 'active' ? `<button class="btn small danger" data-revoke="${esc(s.id)}">Revoke</button>` : ''}</div>
        </div></li>`).join('')
      : '<li class="empty">You have not shared any chats.</li>';
  } catch (error) {
    list.innerHTML = `<li class="empty">${esc(error.message)}</li>`;
  }
}

$('#shares-list').addEventListener('click', async (e) => {
  const id = e.target.dataset.revoke;
  if (!id || !confirm('Revoke this share? The link stops working right away.')) return;
  try {
    await api(`/shares/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    loadShares();
  } catch (error) {
    alert(error.message);
  }
});

// ---------- a share link ----------
let shareView = null;
async function openShare(id, from) {
  const el = $('#share-detail');
  if (!from) el.innerHTML = '<div class="skeleton"></div>';
  try {
    const params = new URLSearchParams({ max: '60' });
    if (from) params.set('from', String(from));
    const data = await api(`/share/${encodeURIComponent(id)}?${params}`);
    if (from && shareView) {
      shareView.session.turns.push(...data.session.turns);
      shareView.session.window = data.session.window;
    } else {
      shareView = data;
    }
    renderChat(el, shareView.session, { mine: false, owner: shareView.mine ? 'you' : shareView.owner, shareInfo: shareView.share });
    el.dataset.share = id;
  } catch (error) {
    el.innerHTML = `<h2 class="h2">This chat is not available</h2><p class="hint">${esc(error.message)}</p>`;
  }
}

$('#share-detail').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'expand') { e.target.closest('.turn').classList.remove('clamped'); e.target.remove(); }
  if (act === 'more') openShare($('#share-detail').dataset.share, Number(e.target.dataset.from));
});

// ---------- boot ----------
api('/me').then((me) => { state.me = me; $('#me-email').textContent = me.email || me.name; }).catch(() => {});
route();
