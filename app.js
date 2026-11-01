'use strict';

// Šuplík pro iPhone: stejné soubory jako na Macu, jen přímo přes GitHub (bez gitu v telefonu).

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('suplik.' + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem('suplik.' + key);
      else localStorage.setItem('suplik.' + key, JSON.stringify(value));
    } catch { /* plné nebo zakázané úložiště – nevadí */ }
  },
};

const state = {
  token: store.get('token'),
  login: store.get('login'),
  repo: store.get('repo'),          // "owner/name"
  branch: null,
  files: [],                         // cesty všech souborů v repozitáři
  open: new Set(store.get('openDirs', [])),
  path: null,                        // otevřený soubor
  sha: null,                         // verze souboru na GitHubu
  loadedText: '',
  pins: store.get('pins', null),
  mode: store.get('mode', 'edit'),
  saving: false,
};

// Jednorázový úklid: moje_poznamky.txt se už nepoužívá (uloženo v telefonech z dřívějška).
if (state.pins && !store.get('cleanup1')) {
  state.pins = state.pins.filter((p) => !(p.repo.endsWith('/sekretarka') && p.path === 'agenda/moje_poznamky.txt'));
  store.set('pins', state.pins);
  store.set('cleanup1', true);
}

const editor = $('editor');
const preview = $('preview');

// MARK: GitHub

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, options = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + state.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).message || message; } catch { /* bez těla */ }
    throw new GitHubError(res.status, message);
  }
  return res.status === 204 ? null : res.json();
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function friendlyError(err) {
  if (!(err instanceof GitHubError)) return 'Bez připojení k internetu nebo GitHub neodpovídá.';
  if (err.status === 401) return 'GitHub klíč neplatí (možná vypršel). Odhlas se v menu ☰ a přihlas se novým.';
  if (err.status === 403) return 'GitHub to nedovolil: ' + err.message;
  if (err.status === 404) return 'Nenalezeno (soubor nebo repozitář neexistuje, nebo k němu klíč nemá přístup).';
  return 'Chyba GitHubu: ' + err.message;
}

// MARK: Obrazovky

function show(screen) {
  for (const id of ['login', 'repos', 'main']) $(id).hidden = id !== screen;
}

function setStatus(text) { $('status').textContent = text; }

async function start() {
  if (!state.token) { show('login'); return; }
  if (!state.repo) { await showRepos(); return; }
  show('main');
  renderPins();
  syncPins();
  await openRepo(state.repo);
  const last = store.get('lastFile');
  if (last && last.repo === state.repo && state.files.includes(last.path)) await openFile(last.path);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token').value.trim();
  if (!token) return;
  $('login-error').textContent = '';
  state.token = token;
  try {
    const user = await gh('/user');
    state.login = user.login;
    store.set('token', token);
    store.set('login', user.login);
    $('token').value = '';
    if (!state.pins) {
      // Stejné výchozí rychlé odkazy jako na Macu.
      state.pins = [
        { repo: user.login + '/sekretarka', path: 'agenda/DNES.md' },
      ];
      store.set('pins', state.pins);
    }
    start();
  } catch (err) {
    state.token = null;
    $('login-error').textContent = err instanceof GitHubError && err.status === 401
      ? 'Tenhle klíč GitHub nepřijal. Zkontroluj, že jsi ho zkopíroval celý.'
      : friendlyError(err);
  }
});

// MARK: Repozitáře

let allRepos = [];

async function showRepos() {
  show('repos');
  $('repos-back').hidden = !state.repo;
  const list = $('repo-list');
  list.innerHTML = '<li>Načítám repozitáře…</li>';
  try {
    allRepos = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await gh(`/user/repos?per_page=100&sort=full_name&page=${page}`);
      allRepos.push(...batch);
      if (batch.length < 100) break;
    }
    renderRepos();
  } catch (err) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = friendlyError(err);
    list.append(li);
  }
}

function renderRepos() {
  const q = $('repo-search').value.trim().toLowerCase();
  const list = $('repo-list');
  list.innerHTML = '';
  for (const repo of allRepos.filter((r) => r.full_name.toLowerCase().includes(q))) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.textContent = repo.full_name;
    if (repo.private) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.textContent = '🔒';
      name.append(lock);
    }
    li.append(name);
    if (repo.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = repo.description;
      li.append(desc);
    }
    li.addEventListener('click', async () => {
      if (!(await leaveFile())) return;
      show('main');
      renderPins();
      await openRepo(repo.full_name);
      openDrawer();
    });
    list.append(li);
  }
}

$('repo-search').addEventListener('input', renderRepos);
$('repos-back').addEventListener('click', () => show('main'));

async function openRepo(name) {
  setStatus('Otevírám ' + name + '…');
  try {
    const info = await gh('/repos/' + name);
    state.branch = info.default_branch;
    if (state.repo !== name) { state.repo = name; store.set('repo', name); closeFile(); }
    $('repo-title').textContent = name;
    $('drawer-repo').textContent = name.split('/')[1];
    await loadTree();
    setStatus('Aktuální');
    return true;
  } catch (err) {
    setStatus(friendlyError(err));
    return false;
  }
}

async function loadTree() {
  const tree = await gh(`/repos/${state.repo}/git/trees/${encodeURIComponent(state.branch)}?recursive=1`);
  state.files = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path)
    .filter((p) => !p.split('/').some((part) => part === '.DS_Store'));
  renderTree();
}

// MARK: Strom souborů

function renderTree() {
  const root = { dirs: new Map(), files: [] };
  for (const path of state.files) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(parts[parts.length - 1]);
  }
  const ul = $('tree');
  ul.innerHTML = '';
  const cmp = (a, b) => a.localeCompare(b, 'cs', { numeric: true, sensitivity: 'base' });
  const walk = (node, prefix, depth) => {
    for (const name of [...node.dirs.keys()].sort(cmp)) {
      const full = prefix + name;
      const open = state.open.has(full);
      ul.append(treeItem((open ? '▾' : '▸'), name, depth, 'dir', () => {
        open ? state.open.delete(full) : state.open.add(full);
        store.set('openDirs', [...state.open]);
        renderTree();
      }));
      if (open) walk(node.dirs.get(name), full + '/', depth + 1);
    }
    for (const name of node.files.sort(cmp)) {
      const full = prefix + name;
      const li = treeItem(isMarkdown(name) ? '📝' : '📄', name, depth, full === state.path ? 'current' : '', async () => {
        closeDrawer();
        await openFile(full);
      });
      ul.append(li);
    }
  };
  walk(root, '', 0);
}

function treeItem(icon, name, depth, cls, onClick) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.style.paddingLeft = (12 + depth * 18) + 'px';
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = icon;
  li.append(ico, document.createTextNode(name));
  li.addEventListener('click', onClick);
  return li;
}

// MARK: Soubory

const isMarkdown = (path) => /\.(md|markdown|mdown)$/i.test(path || '');
const draftKey = () => `draft:${state.repo}:${state.path}`;
const isDirty = () => state.path !== null && editor.value !== state.loadedText;

async function openFile(path, { quiet = false } = {}) {
  if (path !== state.path && !(await leaveFile())) return;
  setStatus('Načítám ' + path + '…');
  try {
    const file = await gh(`/repos/${state.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`);
    if (Array.isArray(file) || file.type !== 'file') throw new Error('není soubor');
    let text;
    if (file.encoding === 'base64' && file.content) text = decodeBase64Utf8(file.content);
    else if (file.size === 0) text = '';
    else throw new Error('velký soubor');
    state.path = path;
    state.sha = file.sha;
    state.loadedText = text;
    editor.value = text;
    // Neuložený koncept z minula (např. když se aplikace zavřela), pokud soubor mezitím nikdo nezměnil.
    const draft = store.get(draftKey());
    let restored = false;
    if (draft && draft.sha === file.sha && draft.text !== text) { editor.value = draft.text; restored = true; }
    else store.set(draftKey(), null);
    store.set('lastFile', { repo: state.repo, path });
    editor.scrollTop = 0;
    preview.scrollTop = 0;
    renderFile();
    renderTree();
    if (!quiet) setStatus(restored ? 'Obnoven neuložený koncept – nezapomeň uložit.' : 'Otevřeno');
  } catch (err) {
    if (err instanceof GitHubError) setStatus(friendlyError(err));
    else if (err.message === 'velký soubor') setStatus('Soubor je moc velký, Šuplík na telefonu ho neotevře.');
    else setStatus('Tento soubor není textový, Šuplík ho neumí upravit.');
  }
}

function closeFile() {
  state.path = null;
  state.sha = null;
  state.loadedText = '';
  editor.value = '';
  renderFile();
}

/// Před přepnutím jinam uloží rozepsané změny (stejně jako na Macu).
async function leaveFile() {
  if (!isDirty()) return true;
  return save();
}

async function save() {
  if (!state.path || state.saving) return false;
  if (!isDirty()) { setStatus('Beze změn'); return true; }
  state.saving = true;
  renderFile();
  const path = state.path;
  const text = editor.value;
  setStatus('Odesílám ' + path + ' na GitHub…');
  try {
    const res = await gh(`/repos/${state.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Šuplík (iPhone): ' + path,
        content: encodeUtf8Base64(text),
        sha: state.sha || undefined,
        branch: state.branch,
      }),
    });
    if (state.path === path) {
      state.sha = res.content.sha;
      state.loadedText = text;
      store.set(draftKey(), null);
    }
    if (!state.files.includes(path)) { state.files.push(path); renderTree(); }
    setStatus('Uloženo a odesláno na GitHub');
    return true;
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 409 || err.status === 422)) {
      setStatus('Soubor se mezitím změnil jinde (třeba na Macu). Tvůj text zůstal v editoru – zkopíruj si ho, pak dej ↻ Stáhnout novinky.');
    } else {
      setStatus('Neuloženo: ' + friendlyError(err) + ' Text zůstává v telefonu, zkus Uložit znovu.');
    }
    return false;
  } finally {
    state.saving = false;
    renderFile();
  }
}

$('save-btn').addEventListener('click', () => save());

async function newFile() {
  const base = state.path && state.path.includes('/') ? state.path.slice(0, state.path.lastIndexOf('/') + 1) : '';
  const name = prompt('Název nového souboru (může obsahovat i složku, např. napady/novy.md):', base + 'poznamka.md');
  if (!name) return;
  const path = name.trim().replace(/^\/+/, '');
  if (!path || path.split('/').includes('..')) return;
  if (state.files.includes(path)) { setStatus('Soubor ' + path + ' už existuje'); return; }
  if (!(await leaveFile())) return;
  closeDrawer();
  state.path = path;
  state.sha = null;
  state.loadedText = '\u0000';   // vynutí první uložení
  editor.value = '';
  await save();
  state.loadedText = editor.value;
  store.set('lastFile', { repo: state.repo, path });
  renderFile();
  renderTree();
  editor.focus();
}

// Rozepsaný text se průběžně ukládá do telefonu, aby se neztratil při zavření aplikace.
let draftTimer = null;
editor.addEventListener('input', () => {
  if (!$('findbar').hidden) computeHits(false);
  renderHighlight();
  renderDirty();
  schedulePreview();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(storeDraft, 400);
});

function storeDraft() {
  if (!state.path) return;
  store.set(draftKey(), isDirty() ? { sha: state.sha, text: editor.value } : null);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) storeDraft(); });
window.addEventListener('pagehide', storeDraft);

// MARK: Vykreslení

function renderFile() {
  const has = state.path !== null;
  $('empty').hidden = has;
  $('file-title').textContent = has ? state.path.split('/').pop() : 'Šuplík';
  const md = has && isMarkdown(state.path);
  $('modes').hidden = !md;
  const mode = md ? effectiveMode() : 'edit';
  $('toolbar').hidden = !md || mode === 'preview';
  $('edit-wrap').hidden = !has || mode === 'preview';
  $('edit-wrap').classList.toggle('on', has && Highlight.ok);
  $('find-btn').disabled = !has;
  if (!has) closeFind();
  else if (!$('findbar').hidden) computeHits(true);
  renderHighlight();
  preview.hidden = !has || mode === 'edit';
  $('work').classList.toggle('split', mode === 'split');
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === mode);
  if (!preview.hidden) renderPreview();
  renderDirty();
  renderPins();
}

function effectiveMode() {
  return state.mode === 'split' && !window.matchMedia('(min-width: 800px)').matches ? 'edit' : state.mode;
}

function renderDirty() {
  const dirty = isDirty();
  $('save-btn').disabled = !dirty || state.saving;
  $('save-btn').textContent = state.saving ? 'Ukládám…' : 'Uložit';
  if (state.path) $('file-title').textContent = (dirty ? '● ' : '') + state.path.split('/').pop();
}

marked.setOptions({ gfm: true, breaks: false });

function renderPreview() {
  const html = marked.parse(editor.value);
  preview.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  for (const a of preview.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
  for (const box of preview.querySelectorAll('input[type=checkbox]')) box.disabled = true;
}

let previewTimer = null;
function schedulePreview() {
  if (preview.hidden) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { const top = preview.scrollTop; renderPreview(); preview.scrollTop = top; syncPreview(); }, 150);
}

// Vedle sebe (na iPadu / širokém displeji): náhled jede s editorem.
function syncPreview() {
  if (effectiveMode() !== 'split') return;
  const max = editor.scrollHeight - editor.clientHeight;
  const ratio = max > 0 ? editor.scrollTop / max : 0;
  preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
}
editor.addEventListener('scroll', () => { $('hl').scrollTop = editor.scrollTop; syncPreview(); });

// Obarvení Markdownu (kopie textu pod průhledným polem).
function renderHighlight() {
  const wrap = $('edit-wrap');
  if (!wrap.classList.contains('on') || wrap.hidden) return;
  const hl = $('hl');
  const marks = finder.hits.map(([a, b], i) => [a, b, i === finder.cur ? 'md-find-cur' : 'md-find']);
  hl.innerHTML = Highlight.html(editor.value, { markdown: isMarkdown(state.path), marks }) + '\n ';
  hl.scrollTop = editor.scrollTop;
}
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.documentElement.classList.add('ios');
}

// iPhone: s vysunutou klávesnicí Safari posouvá pole a obarvenou kopii různě, takže kurzor ujede od textu.
// Proto se tam při psaní ukazuje obyčejné pole (bez barev); barvy se vrátí po zavření klávesnice.
if (document.documentElement.classList.contains('ios')) {
  editor.addEventListener('focus', () => $('edit-wrap').classList.add('typing'));
  editor.addEventListener('blur', () => { $('edit-wrap').classList.remove('typing'); renderHighlight(); });
}

for (const b of document.querySelectorAll('#modes button')) {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    store.set('mode', state.mode);
    renderFile();
  });
}
window.addEventListener('resize', () => { if (state.path) renderFile(); });

// MARK: Rychlé odkazy

function currentPin() {
  return state.path && state.repo ? { repo: state.repo, path: state.path } : null;
}
const samePin = (a, b) => a && b && a.repo === b.repo && a.path === b.path;

function renderPins() {
  const bar = $('pins');
  bar.innerHTML = '';
  const cur = currentPin();
  for (const pin of state.pins || []) {
    const b = document.createElement('button');
    b.textContent = '★ ' + pin.path.split('/').pop();
    if (pin.repo !== state.repo) {
      const repo = document.createElement('span');
      repo.className = 'repo';
      repo.textContent = pin.repo.split('/')[1];
      b.append(repo);
    }
    if (samePin(pin, cur)) b.classList.add('active');
    b.addEventListener('click', () => openPin(pin));
    bar.append(b);
  }
  const pinned = (state.pins || []).some((p) => samePin(p, cur));
  $('pin-btn').textContent = pinned ? '★' : '☆';
  $('pin-btn').disabled = !cur;
}

// Rychlé odkazy jsou sdílené s Macem: leží v souboru v soukromém úložišti Šuplíku na GitHubu.
const PINS_PATH = 'nastaveni/rychle-odkazy.json';
let pinsSha = null;
const pinsUrl = () => `/repos/${state.login}/suplik/contents/${PINS_PATH}`;

function setPins(pins) {
  state.pins = pins;
  store.set('pins', pins);
  renderPins();
  pushPins();
}

async function syncPins() {
  try {
    if (!state.login) { state.login = (await gh('/user')).login; store.set('login', state.login); }
    const file = await gh(pinsUrl());
    pinsSha = file.sha;
    const remote = JSON.parse(decodeBase64Utf8(file.content));
    if (Array.isArray(remote) && JSON.stringify(remote) !== JSON.stringify(state.pins)) {
      state.pins = remote;
      store.set('pins', remote);
      renderPins();
    }
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) { pinsSha = null; await pushPins(); }
    // jinak (bez signálu apod.) zůstanou odkazy uložené v telefonu
  }
}

async function pushPins() {
  if (!state.login) return;
  const put = () => gh(pinsUrl(), {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Rychlé odkazy (iPhone)',
      content: encodeUtf8Base64(JSON.stringify(state.pins || [], null, 2) + '\n'),
      sha: pinsSha || undefined,
    }),
  });
  try {
    pinsSha = (await put()).content.sha;
  } catch (err) {
    if (!(err instanceof GitHubError) || (err.status !== 409 && err.status !== 422)) return;
    try {
      pinsSha = (await gh(pinsUrl())).sha;
      pinsSha = (await put()).content.sha;
    } catch { /* příště */ }
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) syncPins(); });

async function openPin(pin) {
  if (pin.repo !== state.repo) {
    if (!(await leaveFile())) return;
    if (!(await openRepo(pin.repo))) return;
  }
  if (!state.files.includes(pin.path)) {
    setStatus(`Soubor ${pin.path} v repozitáři ${pin.repo} už není`);
    if (confirm(`Soubor ${pin.path.split('/').pop()} už neexistuje. Odebrat ho z rychlých odkazů?`)) {
      setPins(state.pins.filter((p) => !samePin(p, pin)));
    }
    return;
  }
  await openFile(pin.path);
}

$('pin-btn').addEventListener('click', () => {
  const cur = currentPin();
  if (!cur) return;
  const pins = state.pins || [];
  const i = pins.findIndex((p) => samePin(p, cur));
  if (i >= 0) pins.splice(i, 1); else pins.push(cur);
  setPins(pins);
  setStatus(i >= 0 ? 'Odebráno z rychlých odkazů' : 'Přidáno do rychlých odkazů nahoře');
});

// MARK: Boční menu

function openDrawer() { $('drawer').hidden = false; renderTree(); }
function closeDrawer() { $('drawer').hidden = true; }
$('menu-btn').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', (e) => { if (e.target === $('drawer')) closeDrawer(); });
$('new-file-btn').addEventListener('click', newFile);
$('switch-repo-btn').addEventListener('click', () => { closeDrawer(); showRepos(); });
$('refresh-btn').addEventListener('click', async () => {
  if (!(await leaveFile())) return;
  closeDrawer();
  setStatus('Stahuji novinky…');
  try {
    await loadTree();
    if (state.path && state.files.includes(state.path)) await openFile(state.path, { quiet: true });
    setStatus('Aktuální');
  } catch (err) { setStatus(friendlyError(err)); }
});
$('logout-btn').addEventListener('click', () => {
  if (isDirty() && !confirm('Máš neuložené změny. Opravdu se odhlásit? Změny zůstanou jen v tomto telefonu.')) return;
  if (!confirm('Odhlásit Šuplík z tohoto telefonu? Klíč se z telefonu smaže.')) return;
  store.set('token', null);
  state.token = null;
  closeDrawer();
  closeFile();
  show('login');
});

// MARK: Formátování Markdownu

const FORMATS = [
  { label: 'H1', line: '# ' },
  { label: 'H2', line: '## ' },
  { label: 'H3', line: '### ' },
  null,
  { label: '•', line: '- ' },
  { label: '1.', line: 'num' },
  { label: '☐', line: '- [ ] ' },
  { label: '❝', line: '> ' },
  null,
  { label: 'B', wrap: '**', cls: 'fmt-b' },
  { label: 'I', wrap: '*', cls: 'fmt-i' },
  { label: 'S', wrap: '~~', cls: 'fmt-s' },
  { label: '</>', wrap: '`' },
  { label: '🔗', link: true },
  null,
  { label: '—', block: '---' },
  { label: '▦', block: '| Sloupec 1 | Sloupec 2 |\n| --- | --- |\n|  |  |' },
];

const PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/;

function buildToolbar() {
  const bar = $('toolbar');
  for (const f of FORMATS) {
    if (!f) { const s = document.createElement('span'); s.className = 'sep'; bar.append(s); continue; }
    const b = document.createElement('button');
    b.textContent = f.label;
    if (f.cls) b.className = f.cls;
    // Klepnutí nesmí vzít editoru kurzor (a schovat klávesnici).
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => applyFormat(f));
    bar.append(b);
  }
}

/// Nahradí kus textu tak, aby šlo změnu vrátit (Zpět).
function replaceRange(start, end, text, selStart, selEnd) {
  editor.focus();
  editor.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok || editor.value.slice(start, start + text.length) !== text) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  editor.setSelectionRange(selStart, selEnd);
}

function applyFormat(f) {
  const v = editor.value;
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  if (f.line) {
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split('\n');
    const kind = (p) => (p ? (/^\d+[.)] $/.test(p) ? 'num' : p) : '');
    const all = lines.every((l) => kind(l.match(PREFIX)[2]) === f.line);
    let n = 0;
    const out = lines.map((l) => {
      const [, indent, , ] = l.match(PREFIX);
      const rest = l.slice(l.match(PREFIX)[0].length);
      if (all) return indent + rest;
      const prefix = f.line === 'num' ? `${++n}. ` : f.line;
      return indent + prefix + rest;
    }).join('\n');
    const caret = ls + out.length;
    replaceRange(ls, le, out, lines.length === 1 ? caret : ls, caret);
  } else if (f.wrap) {
    const m = f.wrap;
    const sel = v.slice(s, e);
    if (sel.startsWith(m) && sel.endsWith(m) && sel.length >= 2 * m.length) {
      const inner = sel.slice(m.length, sel.length - m.length);
      replaceRange(s, e, inner, s, s + inner.length);
    } else if (v.slice(s - m.length, s) === m && v.slice(e, e + m.length) === m) {
      replaceRange(s - m.length, e + m.length, sel, s - m.length, e - m.length);
    } else {
      replaceRange(s, e, m + sel + m, s + m.length, e + m.length);
    }
  } else if (f.link) {
    const sel = v.slice(s, e) || 'text';
    const text = `[${sel}](https://)`;
    const urlStart = s + sel.length + 3;
    replaceRange(s, e, text, urlStart, urlStart + 8);
  } else if (f.block) {
    const before = v.slice(0, s);
    const pre = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const text = pre + f.block + '\n';
    replaceRange(s, e, text, s + text.length, s + text.length);
  }
}

// MARK: Hledání v souboru

const finder = { hits: [], cur: -1 };

// Bez ohledu na velikost písmen a háčky/čárky („mleko“ najde i „Mléko“); délka textu zůstává stejná.
function fold(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    out += f.length === 1 ? f : s[i];
  }
  return out;
}

function computeHits(jump) {
  const q = fold($('find-input').value);
  const prev = finder.hits[finder.cur];
  finder.hits = [];
  if (q) {
    const hay = fold(editor.value);
    for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) finder.hits.push([at, at + q.length]);
  }
  if (!finder.hits.length) finder.cur = -1;
  else if (jump) {
    const from = prev ? prev[0] : editor.selectionStart;
    const i = finder.hits.findIndex(([a]) => a >= from);
    finder.cur = i >= 0 ? i : 0;
  } else finder.cur = Math.min(Math.max(finder.cur, 0), finder.hits.length - 1);
  renderFindCount();
}

function renderFindCount() {
  const q = $('find-input').value;
  $('find-count').textContent = !q ? '' : finder.hits.length ? `${finder.cur + 1}/${finder.hits.length}` : '0';
  $('find-prev').disabled = $('find-next').disabled = finder.hits.length < 2;
}

function showHit() {
  renderHighlight();
  renderFindCount();
  const hit = finder.hits[finder.cur];
  if (!hit) return;
  editor.setSelectionRange(hit[0], hit[1]);
  const el = $('hl').querySelector('.md-find-cur');
  if (el) {
    editor.scrollTop = Math.max(0, el.offsetTop - editor.clientHeight / 3);
    $('hl').scrollTop = editor.scrollTop;
  }
}

function step(delta) {
  if (!finder.hits.length) return;
  finder.cur = (finder.cur + delta + finder.hits.length) % finder.hits.length;
  showHit();
}

function openFind() {
  if (!state.path) return;
  if (state.mode === 'preview') { state.mode = 'edit'; store.set('mode', 'edit'); renderFile(); }
  $('findbar').hidden = false;
  const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes('\n')) $('find-input').value = sel;
  $('find-input').focus();
  $('find-input').select();
  computeHits(true);
  showHit();
}

function closeFind() {
  if ($('findbar').hidden) return;
  $('findbar').hidden = true;
  finder.hits = [];
  finder.cur = -1;
  renderHighlight();
}

$('find-btn').addEventListener('click', () => ($('findbar').hidden ? openFind() : closeFind()));
$('find-close').addEventListener('click', closeFind);
$('find-next').addEventListener('click', () => step(1));
$('find-prev').addEventListener('click', () => step(-1));
$('find-input').addEventListener('input', () => { finder.cur = -1; computeHits(true); showHit(); });
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFind();
});
for (const b of [$('find-prev'), $('find-next')]) b.addEventListener('pointerdown', (e) => e.preventDefault());

// MARK: Spuštění

buildToolbar();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
