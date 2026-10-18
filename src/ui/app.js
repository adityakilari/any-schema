// Any Schema - browser UI. Two screens: a home page to load a schema, and a schema atlas
// (map, relationships, documentation, review, export) that opens as its own page (#map, #docs ...).
// Everything runs locally; the only network call is the optional "Ask Claude" request.
import { parseInputs, FORMATS } from '../core/parse.js';
import { analyze, sourceLabel } from '../core/analyze.js';
import { qualifiedName, entityNoun, plural, rawWords, ABBREVIATIONS } from '../core/model.js';
import { assignModules } from '../core/modules.js';
import { findJoinPath } from '../core/paths.js';
import { toMermaid, toMarkdown, toDbml, toJson, VERSION } from '../core/render.js';
import { QUERIES, SAMPLES } from '../generated/assets.js';
import { GUIDES } from './guides.js';

const SAMPLES_LIST = [
  { id: 'clinic', label: 'Clinic system', meta: 'Oracle column export · 38 tables', note: 'ALL_TAB_COLUMNS from DBeaver, no keys: everything inferred', files: ['clinic-oracle-columns.json'] },
  { id: 'pg', label: 'Web shop', meta: 'PostgreSQL pg_dump · 12 tables', note: 'Declared keys, enums, comments and a view', files: ['ecommerce-postgres.sql'] },
  { id: 'sf', label: 'Sales CRM', meta: 'Salesforce describe · 4 objects', note: 'Lookups, master-detail, picklists, formulas', files: ['salesforce-describe.json'] },
  { id: 'ora', label: 'HR', meta: 'Oracle DDL · 7 tables', files: ['hr-oracle.sql'] },
  { id: 'mssql', label: 'CRM', meta: 'SQL Server script · 5 tables', files: ['crm-sqlserver.sql'] },
  { id: 'mysql', label: 'Blog', meta: 'MySQL dump · 6 tables', files: ['blog-mysql.sql'] },
  { id: 'prisma', label: 'SaaS app', meta: 'Prisma schema · 6 models', files: ['saas.prisma'] },
  { id: 'mongo', label: 'Shop', meta: 'MongoDB export · 4 collections', files: ['mongodb-shop.json'] },
  { id: 'jsonschema', label: 'Library API', meta: 'JSON Schema · 6 objects', files: ['library.schema.json'] },
  { id: 'data', label: 'Orders data', meta: '2 data CSVs', files: ['customers.csv', 'orders.csv'] },
];
const VIEWS = ['map', 'relationships', 'docs', 'review', 'export'];
// Hosts that block downloads and new tabs (embedded previews) set this flag.
const STANDALONE = !window.ANY_SCHEMA_NO_DOWNLOAD;
// Schemas are never stored. Older versions kept the last one in localStorage; it is deleted on load.
const OLD_CACHE_KEY = 'anyschema.last';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const fmt = (n) => Number(n).toLocaleString('en-US');
const plur = (n, w, p = `${w}s`) => `${fmt(n)} ${n === 1 ? w : p}`;
const store = {
  removeLocal(k) { try { window.localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  sget(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { if (v === null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, v); } catch { /* unavailable */ } },
};

// ------------------------------------------------------------------ state
let S = null; // canonical schema
let A = null; // analysis
let MODS = null; // { modules, of }
let INPUTS = [];
const T = new Map(); // key -> table
const AT = new Map(); // key -> analysis table
const REL = new Map(); // id -> relationship
const OUT = new Map(); // key -> outgoing rels
const IN = new Map(); // key -> incoming rels
let curMod = null;
let curTable = null;
let showAudit = false;
let showAuditLinks = false;
let built = {};
const ui = { sev: 'all', exportKind: 'markdown', guide: 'oracle', relFilter: '', relSource: 'all' };

const objWord = () => (S && S.source.dialect === 'salesforce' ? 'object' : S && S.source.dialect === 'mongodb' ? 'collection' : 'table');
const colWord = () => (S && S.source.dialect === 'salesforce' ? 'field' : 'column');
const modName = (id) => (MODS.modules.find((m) => m.id === id) || {}).name || id;
const modOf = (key) => MODS.of.get(key);
const isAuditCol = (ac) => ac.tags.includes('Audit');
const roleGroup = (role) => ({ core: 'core', entity: 'core', transaction: 'txn', detail: 'txn', lookup: 'ref', config: 'ref', log: 'ref', junction: 'join', view: 'view', embedded: 'view' }[role] || 'core');

// ------------------------------------------------------------------ loading
function setStatus(msg, err = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

async function readFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  setStatus(`Reading ${files.map((f) => f.name).join(', ')}…`);
  try {
    const read = (f) => (typeof f.text === 'function' ? f.text() : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f); }));
    const inputs = await Promise.all(files.map((f) => read(f).then((text) => ({ text, name: f.name }))));
    openSchema(inputs, 'auto');
  } catch (e) {
    setStatus(`The file could not be read: ${e.message}`, true);
  }
}

function openSchema(inputs, format = 'auto', view = 'map') {
  let schema;
  try {
    schema = parseInputs(inputs, format);
    if (!schema.tables.length) throw new Error(schema.notes[0] || 'No tables, objects or collections were found.');
  } catch (e) {
    console.error(e);
    setStatus(`Could not read ${inputs.map((i) => i.name).join(', ')}: ${String(e.message).replace(/\.$/, '')}. Check that it is one of the supported formats, or paste it and pick the format by hand.`, true);
    if (location.hash.slice(1) !== 'home' && location.hash) location.hash = 'home';
    return false;
  }
  setStatus('');
  INPUTS = inputs;
  S = schema;
  A = analyze(S);
  MODS = assignModules(S);
  T.clear(); AT.clear(); REL.clear(); OUT.clear(); IN.clear();
  for (const t of S.tables) { T.set(qualifiedName(t), t); OUT.set(qualifiedName(t), []); IN.set(qualifiedName(t), []); }
  for (const t of A.tables) AT.set(t.key, t);
  for (const r of A.relationships) {
    REL.set(r.id, r);
    if (OUT.has(r.from.table)) OUT.get(r.from.table).push(r);
    if (!r.external && IN.has(r.to.table) && r.source !== 'embedded') IN.get(r.to.table).push(r);
  }
  built = {};
  curMod = null; curTable = null; showAudit = false;
  renderAtlasChrome();
  showLoadedBanner(inputs);
  setStatus(`Opened ${inputs.map((i) => i.name).join(', ')}. The schema guide is shown above this box.`);
  justOpened = true;
  if (location.hash.slice(1) === view) route(); else location.hash = view;
  return true;
}

function schemaTitle() {
  const schemas = [...new Set(S.tables.map((t) => t.schema).filter(Boolean))];
  if (schemas.length === 1 && !/^(public|dbo|main)$/i.test(schemas[0])) return schemas[0];
  const f = INPUTS[0] ? INPUTS[0].name.replace(/\.[^.]+$/, '') : 'Schema';
  return INPUTS.length > 1 ? `${f} + ${INPUTS.length - 1} more` : f;
}

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash.slice(1);
  if (VIEWS.includes(h)) {
    if (!S) { location.hash = 'home'; return; }
    showAtlas(h);
    return;
  }
  showHome();
  if (h === 'guides') $('#guides').scrollIntoView();
}

function showHome() {
  $('#jump').hidden = true;
  if (jumpObserver) jumpObserver.disconnect();
  $('#atlas').hidden = true;
  $('#home').hidden = false;
  document.title = 'Any Schema';
  window.scrollTo(0, 0);
}

function showAtlas(view) {
  const wasHidden = $('#atlas').hidden;
  $('#home').hidden = true;
  $('#atlas').hidden = false;
  document.title = `${schemaTitle()} · Any Schema`;
  setView(view);
  if (wasHidden || justOpened) revealAtlas();
  justOpened = false;
}

// Bring the new guide into view. Inside some embedded viewers the page cannot scroll its own
// frame, so if the header is still off screen a floating "show it" button appears as well.
let justOpened = false;
let jumpObserver = null;
function revealAtlas() {
  try { window.scrollTo(0, 0); } catch { /* not supported */ }
  const title = $('#title');
  requestAnimationFrame(() => {
    try { title.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { try { title.scrollIntoView(); } catch { /* no-op */ } }
    try { title.focus({ preventScroll: true }); } catch { /* no-op */ }
  });
  const jump = $('#jump');
  if (jumpObserver) jumpObserver.disconnect();
  jump.hidden = true;
  if (!('IntersectionObserver' in window)) return;
  let seen = false;
  jumpObserver = new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.isIntersecting);
    if (visible) { seen = true; jump.hidden = true; jumpObserver.disconnect(); }
  });
  jumpObserver.observe(title);
  setTimeout(() => { if (!seen && !$('#atlas').hidden) jump.hidden = false; }, 900);
}

function showLoadedBanner(inputs) {
  const names = inputs.map((i) => i.name).join(', ');
  $('#loaded-text').innerHTML = `<b>${esc(names)}</b> loaded: ${plur(A.stats.tables, objWord())}, ${plur(A.stats.columns, colWord())} and ${plur(A.stats.relationships, 'relationship')}. Use the tabs below to explore the map, read every relationship, or open the full documentation.`;
  $('#loaded-banner').hidden = false;
}

function setView(v) {
  $$('.tabs [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  for (const id of VIEWS) $(`#view-${id}`).hidden = id !== v;
  $('#mods').hidden = !['map', 'docs'].includes(v);
  if (v === 'map' && !built.map) { built.map = true; startMap(); }
  if (v === 'relationships' && !built.rel) { built.rel = true; renderRelationships(); }
  if (v === 'docs' && !built.docs) { built.docs = true; renderDocs(); }
  if (v === 'review' && !built.review) { built.review = true; renderReview(); }
  if (v === 'export' && !built.export) { built.export = true; renderExport(); }
}

// ------------------------------------------------------------------ atlas chrome
function renderAtlasChrome() {
  $('#title').textContent = schemaTitle();
  $('#srcfile').textContent = `${INPUTS.map((i) => i.name).join(', ')} · ${sourceLabel(S)}`;
  const s = A.stats;
  $('#stats').innerHTML = [
    [s.tables, `${objWord()}s`], [s.columns, `${colWord()}s`], [s.relationships, s.inferred ? `relationships (${fmt(s.inferred)} inferred)` : 'relationships'],
    [MODS.modules.length, MODS.modules.length === 1 ? 'module' : 'modules'], [A.findings.length, 'findings'],
  ].map(([n, l]) => `<div class="stat"><b>${fmt(n)}</b><span>${esc(l)}</span></div>`).join('');
  $('#lede').innerHTML = rich(A.summary);
  $('#review-count').textContent = A.findings.length + A.privacy.length ? fmt(A.findings.length) : '';
  $('#mods').innerHTML = MODS.modules.length > 1 ? MODS.modules.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="false" title="${esc(m.code ? `Tables starting with ${m.code}` : m.name)}">${esc(m.name)} <small>${m.keys.length}</small></button>`).join('') : '';
  $('#q').value = '';
  $('#results').hidden = true;
}

// ------------------------------------------------------------------ map
function startMap() {
  const sizes = MODS.modules.filter((m) => m.id !== 'other');
  const first = (sizes.length ? sizes : MODS.modules).slice().sort((a, b) => b.keys.length - a.keys.length)[0];
  setMod(first.id);
  const core = first.keys.slice().sort((a, b) => incomingTables(b).length - incomingTables(a).length)[0];
  if (core) selectTable(core);
}

const incomingTables = (key) => [...new Set((IN.get(key) || []).filter((r) => (showAuditLinks || !r.system) && !r.self).map((r) => r.from.table))];

function setMod(id, keepTable) {
  curMod = id;
  $$('#mods button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === id)));
  const m = MODS.modules.find((x) => x.id === id);
  const cols = m.keys.reduce((n, k) => n + T.get(k).columns.length, 0);
  $('#mod-title').textContent = `${m.name} · ${plur(m.keys.length, objWord())} · ${plur(cols, colWord())}`;
  drawDiagram(id);
  if (!keepTable) { curTable = null; renderCard(); }
}

const ROW = 30;
const NODE_H = 22;
const GAP_X = 70;
const MAX_ROWS = 18;
const PAD = 24;
let nodePos = {};

function drawDiagram(id) {
  const m = MODS.modules.find((x) => x.id === id);
  const inMod = new Set(m.keys);
  const ext = new Set();
  const edges = [];
  for (const key of m.keys) {
    const seen = new Set();
    for (const r of OUT.get(key) || []) {
      if (r.external || r.self || (r.system && !showAuditLinks) || r.type === 'embedded-in') continue;
      if (seen.has(r.to.table)) continue;
      seen.add(r.to.table);
      if (!inMod.has(r.to.table)) ext.add(r.to.table);
      edges.push({ from: key, to: r.to.table, ext: !inMod.has(r.to.table), inferred: r.source === 'inferred' });
    }
  }
  // tables in other modules that point into this one
  for (const key of m.keys) for (const r of IN.get(key) || []) {
    if (!inMod.has(r.from.table) && !(r.system && !showAuditLinks) && !r.self && m.keys.length <= 80 && !edges.some((e) => e.from === r.from.table && e.to === key)) {
      ext.add(r.from.table);
      edges.push({ from: r.from.table, to: key, ext: true, inferred: r.source === 'inferred', incoming: true });
    }
  }
  const parents = {};
  inMod.forEach((n) => { parents[n] = []; });
  edges.forEach((e) => { if (!e.ext) parents[e.from].push(e.to); });
  const depth = {};
  const visiting = new Set();
  const d = (n) => {
    if (depth[n] != null) return depth[n];
    if (visiting.has(n)) return 0;
    visiting.add(n);
    let v = 0;
    parents[n].forEach((p) => { v = Math.max(v, d(p) + 1); });
    visiting.delete(n);
    depth[n] = Math.min(v, 6);
    return depth[n];
  };
  inMod.forEach(d);
  const layers = {};
  inMod.forEach((n) => { (layers[depth[n]] = layers[depth[n]] || []).push(n); });
  const keys = Object.keys(layers).map(Number).sort((a, b) => a - b);
  const ordered = [];
  const label = (k) => T.get(k).name;
  if (ext.size) ordered.push({ label: 'Other modules', nodes: [...ext].sort((a, b) => label(a).localeCompare(label(b))), ext: true });
  keys.forEach((k, i) => ordered.push({ label: i === 0 ? (keys.length > 1 ? 'Parents' : objWord() + 's') : i === keys.length - 1 ? 'Children' : `Level ${i + 1}`, nodes: layers[k].sort((a, b) => label(a).localeCompare(label(b))) }));
  const idx = {};
  ordered.forEach((L) => L.nodes.forEach((n, i) => { idx[n] = i; }));
  for (let pass = 0; pass < 2; pass++) {
    ordered.forEach((L, li) => {
      if (li === 0) return;
      const score = (n) => { const ps = edges.filter((e) => e.from === n && idx[e.to] != null).map((e) => idx[e.to]); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1e3 + idx[n]; };
      L.nodes.sort((a, b) => score(a) - score(b));
      L.nodes.forEach((n, i) => { idx[n] = i; });
    });
  }
  const cols = [];
  ordered.forEach((L) => { for (let i = 0; i < L.nodes.length; i += MAX_ROWS) cols.push({ label: i === 0 ? L.label : '', nodes: L.nodes.slice(i, i + MAX_ROWS), ext: L.ext }); });
  nodePos = {};
  let x = PAD;
  let maxRows = 0;
  cols.forEach((c) => {
    const w = Math.max(...c.nodes.map((n) => label(n).length)) * 7 + 50;
    c.x = x; c.w = w;
    c.nodes.forEach((n, i) => { nodePos[n] = { x, y: PAD + 22 + i * ROW, w, ext: !!c.ext }; });
    x += w + GAP_X;
    maxRows = Math.max(maxRows, c.nodes.length);
  });
  const W = Math.max(x - GAP_X + PAD, 200);
  const H = PAD * 2 + 22 + maxRows * ROW;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" id="svg" role="img" aria-label="Relationship map for ${esc(m.name)}">`;
  cols.forEach((c) => { if (c.label) s += `<text class="colhead" x="${c.x}" y="${PAD + 8}">${esc(c.label)}</text>`; });
  s += '<g>';
  edges.forEach((e) => {
    const a = nodePos[e.from];
    const b = nodePos[e.to];
    if (!a || !b) return;
    let x1; let x2;
    if (b.x < a.x) { x1 = a.x; x2 = b.x + b.w; } else if (b.x > a.x) { x1 = a.x + a.w; x2 = b.x; } else { x1 = a.x; x2 = b.x; }
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    const dx = b.x === a.x ? -40 : (x2 - x1) / 2;
    s += `<path class="edge${e.ext ? ' ext' : ''}${e.inferred ? ' inf' : ''}" data-f="${esc(e.from)}" data-t="${esc(e.to)}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
  });
  s += '</g><g>';
  Object.entries(nodePos).forEach(([n, p]) => {
    const t = T.get(n);
    const at = AT.get(n);
    const tip = p.ext ? `${t.name} (${modName(modOf(n))})` : `${t.name} · ${at.roleLabel} · ${t.columns.length} ${colWord()}s`;
    s += `<g class="node${p.ext ? ' ext' : ''}" data-n="${esc(n)}" tabindex="0" role="button" aria-label="${esc(t.name)}"><title>${esc(tip)}</title><rect class="box" x="${p.x}" y="${p.y}" width="${p.w}" height="${NODE_H}" rx="3"/>${p.ext ? '' : `<rect class="role r-${roleGroup(at.role)}" x="${p.x + 1}" y="${p.y + 1}" width="4" height="${NODE_H - 2}" rx="1"/>`}<text x="${p.x + 10}" y="${p.y + 15}">${esc(t.name)}</text>${p.ext ? '' : `<text class="k" x="${p.x + p.w - 6}" y="${p.y + 15}" text-anchor="end">${t.columns.length}</text>`}</g>`;
  });
  s += '</g></svg>';
  $('#diagram').innerHTML = `${s}`;
  if (!$('#role-key')) $('#diagram').insertAdjacentHTML('afterend', '<div class="role-key" id="role-key"><span style="--c:var(--role-core)">entity</span><span style="--c:var(--role-txn)">transaction / line items</span><span style="--c:var(--role-ref)">lookup / log / config</span><span style="--c:var(--role-join)">join table</span><span>number = columns</span></div>');
  $('#diagram').scrollTo(0, 0);
  highlight();
}

function highlight() {
  const svg = $('#svg');
  if (!svg) return;
  svg.classList.toggle('dim', !!(curTable && nodePos[curTable]));
  const nb = new Set();
  svg.querySelectorAll('.edge').forEach((p) => {
    const hot = curTable && (p.dataset.f === curTable || p.dataset.t === curTable);
    p.classList.toggle('hot', !!hot);
    if (hot) { nb.add(p.dataset.f); nb.add(p.dataset.t); }
  });
  svg.querySelectorAll('.node').forEach((g) => {
    g.classList.toggle('sel', g.dataset.n === curTable);
    g.classList.toggle('nb', g.dataset.n !== curTable && nb.has(g.dataset.n));
  });
}

function selectTable(key, fromDiagram) {
  if (!T.has(key)) return;
  if (modOf(key) !== curMod) setMod(modOf(key), true);
  curTable = key;
  showAudit = false;
  renderCard();
  highlight();
  const p = nodePos[key];
  if (p && !fromDiagram) $('#diagram').scrollTo({ left: Math.max(0, p.x - 60), top: Math.max(0, p.y - 120) });
}

/** The column explanation, minus the "Foreign key → x." lead, used as the relationship sentence. */
function relSay(r) {
  if (r.arrayRef || r.type === 'many-to-many') return `Each ${entityNoun(r.from.name)} lists several ${plural(entityNoun(r.to.name))} in ${'`' + r.from.columns[0] + '`'} (many-to-many stored as a list).`;
  if (r.source === 'embedded') {
    if (r.type === 'embedded-in') return `Stored inside each ${entityNoun(r.to.name)} document${r.via ? ` under ${'`' + r.via + '`'}` : ''}.`;
    return `Each ${entityNoun(r.from.name)} contains ${r.type === 'embeds-many' ? 'a list of' : 'one'} embedded ${'`' + r.to.name + '`'} ${r.type === 'embeds-many' ? 'objects' : 'object'}.`;
  }
  const at = AT.get(r.from.table);
  const c = at && at.columns.find((x) => x.name === r.from.columns[0]);
  const main = c ? c.main.replace(/^(Foreign key → `[^`]+`\.|Probably references `[^`]+`\.)\s*/, '') : '';
  if (main && !/^(Part of the composite|Primary key)/.test(main)) return main;
  const child = entityNoun(r.from.name);
  const parent = entityNoun(r.to.name);
  if (r.type === 'one-to-one') return `Each ${child} is linked to exactly one ${parent} (one-to-one).`;
  return `Each ${child} belongs to one ${parent}; one ${parent} can have many ${plural(child)}.`;
}

function relBadges(r) {
  const b = [];
  b.push(r.source === 'inferred' ? `<span class="b fi" title="${esc(r.reason || 'from column names')}">inferred · ${esc(r.confidence)}</span>` : r.source === 'embedded' ? '<span class="b x">embedded</span>' : '<span class="b f">declared</span>');
  const kind = { 'many-to-one': 'many → one', 'one-to-one': 'one → one', 'many-to-many': 'many ↔ many', 'embeds-one': 'embeds one', 'embeds-many': 'embeds many', 'embedded-in': 'embedded in' }[r.type] || r.type;
  b.push(`<span class="b u">${esc(kind)}</span>`);
  if (r.source !== 'embedded' && !r.arrayRef) b.push(`<span class="b x">${r.nullable ? 'optional' : 'required'}</span>`);
  if (r.onDelete) b.push(`<span class="b x">on delete ${esc(String(r.onDelete).toLowerCase())}</span>`);
  if (r.masterDetail) b.push('<span class="b x">master-detail</span>');
  if (r.polymorphic) b.push('<span class="b x">polymorphic</span>');
  if (r.self) b.push('<span class="b x">hierarchy</span>');
  if (r.system) b.push('<span class="b x">audit</span>');
  if (r.external) b.push('<span class="b x">not in file</span>');
  return b.join('');
}

function keyLabel(t, at) {
  if (!t.primaryKey.length) return `<span class="tag">None ${S.constraintsKnown === false ? 'inferred' : 'declared'}. ${at.role === 'log' ? 'Common for log tables.' : 'It may use a composite key, be a staging table, or have no key.'}</span>`;
  const pk = t.primaryKey.map((c) => `<code>${esc(c)}</code>`).join(' + ');
  const notes = [];
  if (t.meta && t.meta.pkInferred) notes.push('inferred from the name');
  if (t.primaryKey.length > 1) notes.push('composite');
  return `${pk}${notes.length ? ` <span class="tag">${notes.join(', ')}</span>` : ''}`;
}

function renderCard() {
  const card = $('#card');
  if (!curTable) { card.innerHTML = `<div class="empty">Select a ${objWord()} in the map to see what it stores, its ${colWord()}s and how it connects to other ${objWord()}s.</div>`; return; }
  const t = T.get(curTable);
  const at = AT.get(curTable);
  const audits = at.columns.filter(isAuditCol);
  const rows = at.columns.map((c, i) => {
    const col = t.columns.find((x) => x.name === c.name);
    if (isAuditCol(c) && !showAudit) return '';
    const fks = (OUT.get(curTable) || []).filter((r) => r.from.columns.includes(c.name) && r.source !== 'embedded');
    let b = '';
    if (t.primaryKey.includes(c.name)) b += '<span class="b p">PK</span>';
    for (const r of fks) b += `<span class="b ${r.source === 'inferred' ? 'fi' : 'f'}">FK</span>${r.external ? `<span class="tag">${esc(r.to.name)}</span>` : `<button class="fkto" data-go="${esc(r.to.table)}">${esc(r.to.name)}</button>`} `;
    if (c.tags.includes('UK') && !t.primaryKey.includes(c.name)) b += '<span class="b u">UK</span>';
    if (c.tags.includes('Polymorphic')) b += '<span class="b x">POLY</span>';
    if (c.privacy) b += `<span class="b pii" title="${esc(c.privacy.category)}">PII</span>`;
    return `<tr class="${isAuditCol(c) ? 'aud' : ''}"><td class="o">${i + 1}</td><td class="n">${esc(c.name)}<div class="ex">${rich(c.main)}${c.documented ? ` <i>${esc(c.documented)}</i>` : ''}</div></td><td class="t">${esc(col.rawType || col.category)}</td><td class="o">${col.nullable ? '' : 'NN'}</td><td>${b}</td></tr>`;
  }).join('');
  const group = (list, side) => {
    const g = new Map();
    for (const r of list) {
      const k = side === 'to' ? r.to.table : r.from.table;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const outs = group((OUT.get(curTable) || []).filter((r) => (showAuditLinks || !r.system) && r.type !== 'embedded-in'), 'to');
  const ins = group((IN.get(curTable) || []).filter((r) => (showAuditLinks || !r.system) && !r.self), 'from');
  const hidden = (OUT.get(curTable) || []).filter((r) => r.system).length;
  const relItem = (key, rs, side) => {
    const r = rs[0];
    const name = side === 'to' ? r.to.name : r.from.name;
    const link = r.external ? `<span class="go" style="text-decoration:none;color:var(--muted)">${esc(name)} (not in file)</span>` : `<button class="go" data-go="${esc(key)}">${esc(name)}</button>`;
    return `<li>${link} <span class="via">${side === 'to' ? 'via' : 'by'} ${esc(rs.map((x) => x.from.columns.join(', ')).join(', '))}</span>${r.source === 'inferred' ? ' <span class="b fi">inferred</span>' : ''}<span class="say">${rich(side === 'to' ? relSay(r) : childSay(r))}</span></li>`;
  };
  const poly = at.columns.filter((c) => c.tags.includes('Polymorphic'));
  card.innerHTML = `
    <div class="panel-h"><h3>${esc(t.name)}</h3><div class="chips"><span class="chip role">${esc(at.roleLabel)}</span>${MODS.modules.length > 1 ? `<span class="chip" data-mod="${esc(modOf(curTable))}">${esc(modName(modOf(curTable)))}</span>` : ''}</div></div>
    <div class="purpose">${rich(at.purpose)}${at.documented ? `<div class="doc">${esc(at.documented)}</div>` : ''}</div>
    <dl class="kv">
      <dt>Primary key</dt><dd>${keyLabel(t, at)}</dd>
      <dt>${colWord()[0].toUpperCase() + colWord().slice(1)}s</dt><dd>${t.columns.length}${audits.length ? ` <span class="tag">(${audits.length} audit)</span>` : ''}</dd>
      <dt>Links</dt><dd>${plur(outs.length, 'parent')}, ${plur(ins.length, `child ${objWord()}`)}${hidden && !showAuditLinks ? ` <span class="tag">(+${hidden} audit link${hidden > 1 ? 's' : ''} hidden)</span>` : ''}</dd>
      ${poly.length ? `<dt>Polymorphic</dt><dd>${poly.map((c) => `<code>${esc(c.name)}</code>`).join(', ')} point at different ${objWord()}s per row</dd>` : ''}
    </dl>
    <div style="overflow-x:auto"><table class="cols"><thead><tr><th>#</th><th>${colWord()} and meaning</th><th>Type</th><th>Null</th><th>Key</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${audits.length ? `<button class="toggle-aud" id="ta" type="button">${showAudit ? 'Hide' : 'Show'} ${audits.length} audit ${colWord()}s (${esc(audits.slice(0, 4).map((c) => c.name).join(', '))}${audits.length > 4 ? '…' : ''})</button>` : ''}
    <div class="rel"><h4>References (parents)</h4>${outs.length ? `<ul>${outs.map(([k, rs]) => relItem(k, rs, 'to')).join('')}</ul>` : '<span class="tag">None</span>'}</div>
    <div class="rel"><h4>Referenced by (children)</h4>${ins.length ? `<ul>${ins.map(([k, rs]) => relItem(k, rs, 'from')).join('')}</ul>` : '<span class="tag">None</span>'}</div>
    <div class="rel"><button class="btn ghost small" data-docs="${esc(curTable)}" type="button">Open in documentation</button> <button class="btn ghost small" data-path-from="${esc(curTable)}" type="button">How does it connect to…</button></div>`;
}

function childSay(r) {
  const child = entityNoun(r.from.name);
  const parent = entityNoun(T.get(r.to.table) ? T.get(r.to.table).name : r.to.name);
  if (r.type === 'one-to-one') return `Each ${parent} can have one ${child} (one-to-one).`;
  if (r.arrayRef) return `${plural(child)} list ${plural(parent)} in an array.`;
  return `One ${parent} can have many ${plural(child)}${r.nullable ? '' : '; every ' + child + ' needs one'}.`;
}

// ------------------------------------------------------------------ search
let hits = [];
let hi = 0;
function search() {
  const q = $('#q').value.trim().toLowerCase();
  const r = $('#results');
  if (q.length < 2) { r.hidden = true; return; }
  hits = [];
  for (const t of S.tables) {
    const key = qualifiedName(t);
    const n = t.name.toLowerCase();
    if (n.includes(q) || (t.label || '').toLowerCase().includes(q)) hits.push({ key, label: t.name, sub: AT.get(key).roleLabel + (MODS.modules.length > 1 ? ` · ${modName(modOf(key))}` : ''), rank: n.startsWith(q) ? 0 : 1 });
  }
  for (const t of S.tables) {
    const key = qualifiedName(t);
    for (const c of t.columns) if (c.name.toLowerCase().includes(q)) hits.push({ key, label: t.name, sub: `${colWord()} ${c.name}`, rank: 2 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  hits = hits.slice(0, 60);
  hi = 0;
  r.innerHTML = hits.length ? hits.map((h, i) => `<button type="button" data-i="${i}" class="${i === 0 ? 'on' : ''}"><span class="mono">${esc(h.label)}</span><small>${esc(h.sub)}</small></button>`).join('') : `<div style="padding:8px 10px;color:var(--muted)">No ${objWord()} or ${colWord()} matches.</div>`;
  r.hidden = false;
}
function pickHit(h) {
  $('#results').hidden = true;
  location.hash = 'map';
  setTimeout(() => selectTable(h.key), 0);
}

// ------------------------------------------------------------------ relationships page
function renderRelationships() {
  const ow = objWord();
  const rels = A.relationships;
  const real = rels.filter((r) => !r.external);
  const declared = real.filter((r) => r.source === 'declared').length;
  const inferred = real.filter((r) => r.source === 'inferred').length;
  const sys = real.filter((r) => r.system).length;
  const external = rels.filter((r) => r.external);
  const hubs = [...T.keys()].map((k) => [k, incomingTables(k).length]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const poly = [];
  for (const at of A.tables) for (const c of at.columns) if (c.tags.includes('Polymorphic')) poly.push({ key: at.key, table: at.name, col: c });
  const options = [...T.keys()].sort().map((k) => `<option value="${esc(k)}"></option>`).join('');
  $('#view-relationships').innerHTML = `
    <div class="page">
      <div class="intro">
        <h2>How the ${ow}s are connected</h2>
        <p>${A.stats.relationships ? `There ${real.length === 1 ? 'is' : 'are'} ${plur(real.length, 'relationship')} between ${plur(A.stats.tables, ow)}: ${fmt(declared)} declared in the source${inferred ? ` and ${fmt(inferred)} inferred from ${colWord()} names` : ''}${sys ? ` (${fmt(sys)} of them are audit links such as created-by, hidden in the map by default)` : ''}.` : `No relationships were found between these ${ow}s.`}</p>
        <p>Each relationship below says which ${ow} points to which, through which ${colWord()}s, and what it means in practice: whether the link is required, what happens on delete, and how many rows can be on each side. <span class="b f">declared</span> links come from foreign keys, Prisma relations or Salesforce lookups. <span class="b fi">inferred</span> links come from naming, for example <code>CUSTOMER_ID</code> → <code>CUSTOMERS</code>, and should be confirmed.</p>
      </div>

      <div class="box">
        <h3>How do two ${ow}s connect?</h3>
        <div class="pathform">
          <input id="path-from" list="tbl-list" placeholder="From ${ow}" aria-label="From ${ow}" autocomplete="off">
          <span class="tag">to</span>
          <input id="path-to" list="tbl-list" placeholder="To ${ow}" aria-label="To ${ow}" autocomplete="off">
          <button class="btn" id="path-go" type="button">Show the path</button>
          <datalist id="tbl-list">${options}</datalist>
        </div>
        <div id="path-out"><p class="tag">Pick two ${ow}s to see the chain of relationships between them and the SQL joins.</p></div>
      </div>

      ${hubs.length ? `<div class="stack" style="display:grid;gap:8px"><h3>Most connected ${ow}s</h3><p class="tag">These are the ${ow}s most others depend on. Start here to understand the data model.</p><div class="hubs">${hubs.map(([k, n]) => `<button class="hub" type="button" data-go="${esc(k)}"><b>${esc(T.get(k).name)}</b><small>${plur(n, `child ${ow}`)} · ${esc(AT.get(k).roleLabel)}</small></button>`).join('')}</div></div>` : ''}

      ${A.manyToMany.length ? `<div style="display:grid;gap:8px"><h3>Many-to-many relationships</h3><ul class="rels">${A.manyToMany.map((m) => { const key = [...T.keys()].find((k) => T.get(k).name === m.via); return `<li><div><div class="say"><b>${esc(m.a)}</b> and <b>${esc(m.b)}</b> are linked many-to-many through the join ${ow} <button class="go" data-go="${esc(key)}">${esc(m.via)}</button>: each row pairs one ${esc(entityNoun(m.a))} with one ${esc(entityNoun(m.b))}, so either side can have many of the other.</div></div></li>`; }).join('')}</ul></div>` : ''}

      ${poly.length ? `<div style="display:grid;gap:8px"><h3>Polymorphic links</h3><p class="tag">These ${colWord()}s store an id whose ${ow} depends on a type ${colWord()} in the same row, so no single foreign key exists and they are not drawn on the map.</p><ul class="rels">${poly.map((p) => `<li><div><div class="line"><button class="go" data-go="${esc(p.key)}">${esc(p.table)}</button>.${esc(p.col.name)}</div><div class="say">${rich(p.col.main)}</div></div></li>`).join('')}</ul></div>` : ''}

      <div style="display:grid;gap:10px">
        <h3>Every relationship, grouped by parent ${ow}</h3>
        <div class="filters">
          <input id="rel-filter" type="search" placeholder="Filter by ${ow} or ${colWord()}" aria-label="Filter relationships" value="${esc(ui.relFilter)}">
          <select id="rel-source" aria-label="Source"><option value="all">Declared and inferred</option><option value="declared">Declared only</option><option value="inferred">Inferred only</option></select>
          <label class="tag"><input type="checkbox" id="rel-audit"> include audit links</label>
        </div>
        <div id="rel-groups" style="display:grid;gap:10px"></div>
      </div>

      ${external.length ? `<div style="display:grid;gap:8px"><h3>References to ${ow}s not in this file</h3><p class="tag">These ${colWord()}s point to ${ow}s that were not part of the upload. Add those ${ow}s to the export to see them on the map.</p><ul class="rels">${external.map((r) => `<li><div><div class="line"><button class="go" data-go="${esc(r.from.table)}">${esc(r.from.name)}</button>.${esc(r.from.columns.join(', '))} → ${esc(r.to.name)}</div><div class="say">${rich(relSay(r))}</div></div></li>`).join('')}</ul></div>` : ''}
    </div>`;
  $('#rel-source').value = ui.relSource;
  $('#rel-filter').addEventListener('input', (e) => { ui.relFilter = e.target.value; renderRelGroups(); });
  $('#rel-source').addEventListener('change', (e) => { ui.relSource = e.target.value; renderRelGroups(); });
  $('#rel-audit').addEventListener('change', () => renderRelGroups());
  $('#path-go').addEventListener('click', showPath);
  renderRelGroups();
}

function renderRelGroups() {
  const q = ui.relFilter.trim().toLowerCase();
  const withAudit = $('#rel-audit') && $('#rel-audit').checked;
  const rels = A.relationships.filter((r) => !r.external && r.type !== 'embedded-in' && (withAudit || !r.system) && (ui.relSource === 'all' || r.source === ui.relSource)
    && (!q || [r.from.name, r.to.name, ...r.from.columns, ...r.to.columns].some((x) => String(x).toLowerCase().includes(q))));
  const byParent = new Map();
  for (const r of rels) { if (!byParent.has(r.to.table)) byParent.set(r.to.table, []); byParent.get(r.to.table).push(r); }
  const byMod = new Map();
  for (const key of byParent.keys()) { const m = modOf(key); if (!byMod.has(m)) byMod.set(m, []); byMod.get(m).push(key); }
  const modsOrdered = MODS.modules.filter((m) => byMod.has(m.id));
  const many = rels.length > 120;
  const ow = objWord();
  $('#rel-groups').innerHTML = rels.length ? modsOrdered.map((m, mi) => {
    const parents = byMod.get(m.id).sort((a, b) => byParent.get(b).length - byParent.get(a).length);
    const count = parents.reduce((n, k) => n + byParent.get(k).length, 0);
    return `<details class="grp" ${!many || mi === 0 || q ? 'open' : ''}>
      <summary><h3>${esc(MODS.modules.length > 1 ? m.name : `All ${ow}s`)}</h3><span class="tag">${plur(count, 'relationship')} into ${plur(parents.length, ow)}</span></summary>
      ${parents.map((pk) => {
        const list = byParent.get(pk);
        const childTables = new Set(list.map((r) => r.from.table)).size;
        return `<div class="parent"><div class="parent-h"><button class="go" data-go="${esc(pk)}">${esc(T.get(pk).name)}</button><span class="tag">${esc(AT.get(pk).roleLabel)} · referenced by ${plur(childTables, ow)}</span></div>
          <ul class="rels">${list.map((r) => `<li class="${r.source === 'inferred' ? 'inferred' : ''}${r.system ? ' system' : ''}"><div style="display:grid;gap:3px">
            <div class="line"><button class="go" data-go="${esc(r.from.table)}">${esc(r.from.name)}</button>.${esc(r.from.columns.join(', '))} → ${esc(r.to.name)}.${esc(r.to.columns.join(', '))}</div>
            <div class="say">${rich(relSay(r))} ${rich(childSay(r))}</div>
            <div class="meta">${relBadges(r)}</div></div></li>`).join('')}</ul></div>`;
      }).join('')}
    </details>`;
  }).join('') : '<p class="tag">No relationships match.</p>';
}

function resolveTable(text) {
  const v = String(text || '').trim().toLowerCase();
  if (!v) return null;
  for (const k of T.keys()) if (k.toLowerCase() === v) return k;
  for (const k of T.keys()) if (T.get(k).name.toLowerCase() === v) return k;
  return null;
}

function showPath() {
  const from = resolveTable($('#path-from').value);
  const to = resolveTable($('#path-to').value);
  const out = $('#path-out');
  const ow = objWord();
  if (!from || !to) { out.innerHTML = `<p class="status err">Pick both ${ow}s from the list.</p>`; return; }
  const p = findJoinPath(S, A, from, to);
  if (!p) { out.innerHTML = `<p>No chain of relationships connects <code>${esc(T.get(from).name)}</code> and <code>${esc(T.get(to).name)}</code>. They may be linked only through ${ow}s missing from this file, or by a polymorphic ${colWord()}.</p>`; return; }
  if (!p.steps.length) { out.innerHTML = `<p>That is the same ${ow}.</p>`; return; }
  out.innerHTML = `<p>${esc(T.get(from).name)} reaches ${esc(T.get(to).name)} in ${plur(p.steps.length, 'step')}:</p>
    <ol class="steps">${p.steps.map((st) => { const r = st.rel; return `<li><code>${esc(T.get(st.from).name)}</code> → <code>${esc(T.get(st.to).name)}</code> ${st.forward ? `through <code>${esc(T.get(st.from).name)}.${esc(r.from.columns.join(', '))}</code>` : `because <code>${esc(T.get(st.to).name)}.${esc(r.from.columns.join(', '))}</code> points back`}. <span class="tag">${rich(st.forward ? relSay(r) : childSay(r))}</span> ${r.source === 'inferred' ? '<span class="b fi">inferred</span>' : ''}</li>`; }).join('')}</ol>
    <div class="codebox"><pre class="code" id="path-sql">${esc(p.sql)}</pre><button class="btn ghost small" data-copy="#path-sql" type="button">Copy</button></div>`;
}

// ------------------------------------------------------------------ documentation page
function abbreviationsUsed() {
  const found = new Map();
  for (const t of S.tables) for (const n of [t.name, ...t.columns.map((c) => c.name)]) {
    const parts = rawWords(n).split(' ');
    parts.forEach((w, i) => {
      if (w === 'ins') found.set('ins', /^(tmsp|ts|dt|dttm|date|uid|usr|user|by)$/.test(parts[i + 1] || '') ? 'inserted / insurance (by context)' : 'insurance / inserted (by context)');
      else if (ABBREVIATIONS[w]) found.set(w, ABBREVIATIONS[w]);
    });
  }
  return [...found.entries()].sort();
}

function renderDocs() {
  const ow = objWord();
  const cw = colWord();
  const audit = new Set();
  for (const at of A.tables) for (const c of at.columns) if (isAuditCol(c)) audit.add(c.name);
  const declared = A.relationships.filter((r) => r.source === 'declared' && !r.external).length;
  const inferredPk = S.tables.filter((t) => t.meta && t.meta.pkInferred).length;
  const withPk = S.tables.filter((t) => t.primaryKey.length).length;
  const abbr = abbreviationsUsed();
  const d = S.source.dialect;
  const realQuery = { oracle: 'oracle.sql', postgres: 'postgres.sql', mysql: 'mysql.sql', sqlserver: 'sqlserver.sql', sqlite: 'sqlite.sql', snowflake: 'snowflake.sql', bigquery: 'bigquery.sql' }[d];
  const noKeys = S.constraintsKnown === false;
  let h = `<div class="page">
    <div class="doc-intro">
      <h2>About this schema</h2>
      <p>${rich(A.summary)}</p>
      <h3>How this guide was built</h3>
      <p>Source: ${esc(INPUTS.map((i) => i.name).join(', '))}, read as ${esc(sourceLabel(S))}. ${noKeys ? `The file lists ${ow}s, ${cw}s, types and nullability but no constraints, so keys and relationships were inferred from names:` : `Keys and relationships come from the source (${fmt(declared)} declared)${A.stats.inferred ? `, plus ${fmt(A.stats.inferred)} inferred from names where no constraint exists` : ''}:`}</p>
      <ul class="rules">
        ${noKeys || inferredPk ? `<li><b>Primary key.</b> A ${cw} named <code>ID</code> or <code>&lt;TABLE&gt;_ID</code>, or else a NOT NULL first ${cw} ending in <code>_ID</code>. ${fmt(withPk)} of ${plur(S.tables.length, ow)} have one.</li>` : `<li><b>Primary keys.</b> ${fmt(withPk)} of ${plur(S.tables.length, ow)} have a declared primary key.</li>`}
        <li><b>Foreign key${noKeys ? '' : ' (inferred)'}.</b> A ${cw} whose name matches another ${ow}'s key (<code>CUSTOMER_ID</code> → <code>CUSTOMER</code>), including role prefixes such as <code>MGR_SM_ID</code> → <code>SM</code>, and <code>parent_id</code> pointing back to the same ${ow}. Each inferred link is marked <span class="b fi">inferred</span>.</li>
        <li><b>${ow[0].toUpperCase() + ow.slice(1)} roles.</b> Core entities are referenced by many ${ow}s; transactions and line items record events; lookups are small lists of codes; join ${ow}s link two others many-to-many.</li>
        ${audit.size ? `<li><b>Audit ${cw}s</b> (${[...audit].slice(0, 8).map((a) => `<code>${esc(a)}</code>`).join(', ')}${audit.size > 8 ? '…' : ''}) record who changed a row and when. They are collapsed in the ${ow} cards.</li>` : ''}
        <li><b>Polymorphic links.</b> An <code>X_ID</code> next to <code>X_TYPE</code> or <code>X_TYPE_CD</code> points at different ${ow}s per row, so it is flagged rather than drawn.</li>
        ${abbr.length ? `<li><b>Abbreviations expanded in explanations:</b> ${abbr.map(([k, v]) => `<code>${esc(k.toUpperCase())}</code> ${esc(v)}`).join(' · ')}.</li>` : ''}
      </ul>
      ${noKeys && realQuery ? `<p>To replace the inferred keys with the real constraints, run <code>export-queries/${realQuery}</code> and load its export instead:</p><details><summary class="label" style="cursor:pointer">Show the query</summary><div class="codebox" style="margin-top:8px"><pre class="code" id="doc-sql">${esc(QUERIES[realQuery])}</pre><button class="btn ghost small" data-copy="#doc-sql" type="button">Copy</button></div></details>` : ''}
    </div>`;
  for (const m of MODS.modules) {
    const ts = m.keys.map((k) => T.get(k));
    const cols = ts.reduce((n, t) => n + t.columns.length, 0);
    const core = m.keys.slice().sort((a, b) => incomingTables(b).length - incomingTables(a).length).filter((k) => incomingTables(k).length).slice(0, 3);
    const outside = {};
    for (const k of m.keys) for (const r of OUT.get(k) || []) if (!r.external && !r.system && modOf(r.to.table) !== m.id) outside[modOf(r.to.table)] = (outside[modOf(r.to.table)] || 0) + 1;
    const deps = Object.entries(outside).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => modName(id));
    h += `<article class="docmod" id="doc-${esc(m.id)}">
      <h2>${esc(MODS.modules.length > 1 ? m.name : `${ow[0].toUpperCase() + ow.slice(1)}s`)}</h2>
      <p class="meta">${plur(ts.length, ow)} · ${plur(cols, cw)}${m.code ? ` · names start with <code>${esc(m.code)}</code>` : ''}${core.length ? ` · Central: ${core.map((k) => `<code>${esc(T.get(k).name)}</code> (${incomingTables(k).length} children)`).join(', ')}` : ''}${deps.length ? ` · Depends on: ${deps.map(esc).join(', ')}` : ''}</p>
      <div class="tw"><table class="doc"><thead><tr><th>${ow}</th><th>Role</th><th>What it stores</th><th>Primary key</th><th>References</th><th style="text-align:right">Children</th><th style="text-align:right">${cw}s</th><th></th></tr></thead><tbody>
      ${m.keys.map((k) => {
        const t = T.get(k);
        const at = AT.get(k);
        const refs = [...new Set((OUT.get(k) || []).filter((r) => !r.system && r.type !== 'embedded-in').map((r) => r.to.name))];
        const first = (at.purpose.match(/^.+?[.!?](\s|$)/) || [at.purpose])[0];
        return `<tr><td><button class="go" data-go="${esc(k)}">${esc(t.name)}</button></td><td>${esc(at.roleLabel)}</td><td>${rich(first)}</td><td>${t.primaryKey.length ? `<span class="mono">${esc(t.primaryKey.join(' + '))}</span>` : '<span class="tag">none</span>'}</td><td><span class="mono">${refs.map(esc).join(', ') || '<span class="tag">none</span>'}</span></td><td class="num">${incomingTables(k).length || ''}</td><td class="num">${t.columns.length}</td><td><button class="xbtn" data-detail="${esc(k)}" type="button" aria-expanded="false">Details</button></td></tr>`;
      }).join('')}
      </tbody></table></div></article>`;
  }
  h += `<div class="box ai">${aiBox()}</div></div>`;
  $('#view-docs').innerHTML = h;
  bindAi();
}

function tableDocHtml(key) {
  const t = T.get(key);
  const at = AT.get(key);
  const outs = (OUT.get(key) || []).filter((r) => !r.system && r.type !== 'embedded-in');
  const ins = (IN.get(key) || []).filter((r) => !r.system && !r.self);
  return `<div class="tdoc">
    <p>${rich(at.purpose)}</p>
    ${at.documented ? `<p class="tag"><i>Source comment: ${esc(at.documented)}</i></p>` : ''}
    <div style="overflow-x:auto"><table class="cols"><thead><tr><th>#</th><th>${colWord()}</th><th>Type</th><th>Null</th><th>Meaning</th></tr></thead><tbody>
    ${at.columns.map((c, i) => { const col = t.columns.find((x) => x.name === c.name); return `<tr class="${isAuditCol(c) ? 'aud' : ''}"><td class="o">${i + 1}</td><td class="n">${esc(c.name)}</td><td class="t">${esc(col.rawType || col.category)}</td><td class="o">${col.nullable ? '' : 'NN'}</td><td class="ex">${rich(c.main)}${c.details.length ? `<div class="det">${rich(c.details.join(' '))}</div>` : ''}${c.documented ? `<div class="det"><i>Source comment: ${esc(c.documented)}</i></div>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${outs.length ? `<div><b>Points to</b><ul class="rels" style="margin-top:6px">${outs.map((r) => `<li class="${r.source === 'inferred' ? 'inferred' : ''}"><div><div class="line">${esc(r.from.columns.join(', '))} → ${r.external ? esc(r.to.name) : `<button class="go" data-go="${esc(r.to.table)}">${esc(r.to.name)}</button>`}</div><div class="say">${rich(relSay(r))}</div><div class="meta">${relBadges(r)}</div></div></li>`).join('')}</ul></div>` : ''}
    ${ins.length ? `<div><b>Used by</b><ul class="rels" style="margin-top:6px">${ins.map((r) => `<li class="${r.source === 'inferred' ? 'inferred' : ''}"><div><div class="line"><button class="go" data-go="${esc(r.from.table)}">${esc(r.from.name)}</button>.${esc(r.from.columns.join(', '))}</div><div class="say">${rich(childSay(r))}</div></div></li>`).join('')}</ul></div>` : ''}
  </div>`;
}

function toggleDetail(btn) {
  const tr = btn.closest('tr');
  const open = btn.getAttribute('aria-expanded') === 'true';
  if (open) { tr.nextElementSibling.remove(); btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Details'; return; }
  tr.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="8">${tableDocHtml(btn.dataset.detail)}</td></tr>`);
  btn.setAttribute('aria-expanded', 'true');
  btn.textContent = 'Hide';
}

function openDocsFor(key) {
  location.hash = 'docs';
  setTimeout(() => {
    const btn = $$('#view-docs [data-detail]').find((b) => b.dataset.detail === key);
    if (!btn) return;
    if (btn.getAttribute('aria-expanded') !== 'true') toggleDetail(btn);
    btn.closest('tr').scrollIntoView({ block: 'start' });
  }, 0);
}

// ------------------------------------------------------------------ AI (optional)
function aiBox() {
  const key = store.sget('anyschema.key') || '';
  return `<h3>Ask Claude for a narrative guide (optional)</h3>
    <p class="tag">Sends ${objWord()} and ${colWord()} names, types, relationships and findings (no data rows) to the Claude API with your own key. Everything else on this page runs in your browser.</p>
    <label class="label" for="ai-key">Anthropic API key</label>
    <input id="ai-key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(key)}">
    <div class="row">
      <label class="tag row" style="gap:4px"><input id="ai-remember" type="checkbox" ${key ? 'checked' : ''}> Remember for this tab</label>
      <select id="ai-model" aria-label="Model"><option value="claude-sonnet-5-5">Claude Sonnet 5.5</option><option value="claude-opus-5-5">Claude Opus 5.5</option><option value="claude-haiku-5-5">Claude Haiku 5.5</option></select>
      <button class="btn" id="ai-run" type="button">Write the guide</button>
    </div>
    <div id="ai-out" class="ai-out"></div>`;
}

function bindAi() {
  const btn = $('#ai-run');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const key = $('#ai-key').value.trim();
    const out = $('#ai-out');
    if (!key) { out.innerHTML = '<p class="status err">Enter an Anthropic API key first. You can create one at console.anthropic.com.</p>'; return; }
    store.sset('anyschema.key', $('#ai-remember').checked ? key : null);
    btn.disabled = true;
    out.innerHTML = '<p class="tag">Asking Claude…</p>';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: $('#ai-model').value, max_tokens: 3000, messages: [{ role: 'user', content: aiPrompt() }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
      out.innerHTML = miniMarkdown((body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
    } catch (e) {
      out.innerHTML = `<p class="status err">The request failed: ${esc(e.message)}. If this page is embedded somewhere that blocks network calls, open the GitHub Pages version or run it locally with npm start.</p>`;
    } finally { btn.disabled = false; }
  });
}

function aiPrompt() {
  const lines = [];
  for (const t of S.tables.slice(0, 150)) {
    const at = AT.get(qualifiedName(t));
    lines.push(`${t.name} [${at.roleLabel}]${t.comment ? ` -- ${t.comment}` : ''}`);
    for (const c of at.columns.slice(0, 50)) {
      if (isAuditCol(c)) continue;
      const col = t.columns.find((x) => x.name === c.name);
      lines.push(`  ${c.name} ${col.rawType || col.category}${col.nullable ? '' : ' NOT NULL'}${c.tags.length ? ` {${c.tags.join(',')}}` : ''}`);
    }
  }
  const rels = A.relationships.filter((r) => !r.system && !r.external).slice(0, 400).map((r) => `${r.from.name}.${r.from.columns.join(',')} -> ${r.to.name} (${r.type}, ${r.source})`);
  return `You are a senior data architect onboarding a new engineer to this ${sourceLabel(S)} schema.

Write a clear explanation in Markdown with these sections:
## What the system does
## Main entities and how they relate (walk through the core flows in business terms)
## How to query it (3-5 example questions a team would ask, each with the tables to join and SQL)
## Things to watch out for (use the automated findings below, prioritise, explain the impact)
## Open questions to ask the team (ambiguous names, inferred relationships to confirm)

Use the real table and column names in backticks and do not invent tables. Abbreviations may be expanded as: ${abbreviationsUsed().map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.

Automated summary: ${A.summary}

Tables:
${lines.join('\n')}

Relationships:
${rels.join('\n')}

Findings:
${A.findings.map((f) => `- [${f.severity}] ${f.title}`).join('\n') || 'none'}`;
}

function miniMarkdown(md) {
  const out = [];
  let list = false;
  let code = null;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) { if (code === null) code = []; else { out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`); code = null; } continue; }
    if (code !== null) { code.push(line); continue; }
    const li = /^\s*[-*]\s+(.*)/.exec(line) || /^\s*\d+\.\s+(.*)/.exec(line);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const hd = /^#{1,4}\s+(.*)/.exec(line);
    if (hd) out.push(`<h4>${inline(hd[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  if (code) out.push(`<pre class="code">${esc(code.join('\n'))}</pre>`);
  return out.join('');
}

// ------------------------------------------------------------------ review page
function renderReview() {
  const sevs = ['high', 'medium', 'low', 'info'];
  const list = A.findings.filter((f) => ui.sev === 'all' || f.severity === ui.sev);
  const by = {};
  for (const p of A.privacy) (by[p.category] = by[p.category] || []).push(p);
  const lv = { high: 0, medium: 1, low: 2 };
  const keyOf = (name) => [...T.keys()].find((k) => T.get(k).name === name) || '';
  $('#view-review').innerHTML = `
    <div class="page">
      <div class="intro"><h2>Review</h2><p>Automated checks for common schema problems. Each finding explains the impact and, where possible, includes a fix you can adapt.${S.constraintsKnown === false ? ' Checks that need real constraints (missing primary keys, unindexed foreign keys) are skipped because this file has none.' : ''}</p></div>
      <div class="sev-filter">
        <button class="chipbtn" data-sev-filter="all" aria-pressed="${ui.sev === 'all'}" type="button">All · ${A.findings.length}</button>
        ${sevs.map((s) => `<button class="chipbtn" data-sev-filter="${s}" aria-pressed="${ui.sev === s}" type="button">${s} · ${A.findings.filter((f) => f.severity === s).length}</button>`).join('')}
      </div>
      <div class="findings">${list.length ? list.map((f, i) => `
        <article class="finding" data-sev="${f.severity}"><div class="body">
          <span class="sev">${f.severity}</span>
          <h4>${rich(f.title)}</h4>
          <p>${rich(f.detail)}</p>
          ${f.fix ? `<div class="codebox"><pre class="code" id="fix-${i}">${esc(f.fix)}</pre><button class="btn ghost small" data-copy="#fix-${i}" type="button">Copy</button></div>` : ''}
          ${f.table ? `<div><button class="go" data-go="${esc(keyOf(f.table))}">${esc(f.table)}</button></div>` : ''}
        </div></article>`).join('') : '<p class="tag">Nothing at this level.</p>'}</div>
      <div class="intro"><h2>Personal and sensitive data</h2><p>${colWord()[0].toUpperCase() + colWord().slice(1)}s whose names suggest personal data. Use this as a starting list for masking in test environments, access control and privacy records. It is based on names only, so check the actual contents.</p></div>
      ${A.privacy.length ? `<div class="tw"><table class="doc" style="min-width:600px"><thead><tr><th>Category</th><th>Sensitivity</th><th>${colWord()}s</th></tr></thead><tbody>
        ${Object.entries(by).sort((x, y) => lv[x[1][0].level] - lv[y[1][0].level]).map(([cat, ps]) => `<tr><td>${esc(cat)}</td><td><span class="level" data-level="${ps[0].level}">${ps[0].level}</span></td><td>${ps.map((p) => `<button class="go" data-go="${esc(keyOf(p.table))}">${esc(p.table)}.${esc(p.column)}</button>`).join(', ')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="tag">No columns look like personal data.</p>'}
    </div>`;
}

// ------------------------------------------------------------------ export page
const EXPORTS = {
  markdown: { label: 'SCHEMA.md', hint: 'Full guide with a diagram that renders on GitHub', file: 'SCHEMA.md', type: 'text/markdown', make: () => toMarkdown(S, A, { title: schemaTitle() }) },
  mermaid: { label: 'Mermaid diagram', hint: 'erDiagram source for docs, Notion, GitLab', file: 'schema.mmd', type: 'text/plain', make: () => toMermaid(S, A, { columns: S.tables.length > 15 ? 'keys' : 'all', maxTables: 60 }) },
  dbml: { label: 'DBML', hint: 'Paste into dbdiagram.io to edit visually', file: 'schema.dbml', type: 'text/plain', make: () => toDbml(S, A) },
  json: { label: 'JSON', hint: 'Model and analysis; drop it back in to reload', file: 'schema.any-schema.json', type: 'application/json', make: () => toJson(S, A) },
};

function renderExport() {
  const ex = EXPORTS[ui.exportKind];
  const text = ex.make();
  $('#view-export').innerHTML = `
    <div class="export-grid">
      <div class="export-options">${Object.entries(EXPORTS).map(([k, e]) => `<button class="export-option" type="button" data-export="${k}" aria-pressed="${k === ui.exportKind}"><b>${esc(e.label)}</b><span>${esc(e.hint)}</span></button>`).join('')}
        <p class="tag">Commit SCHEMA.md next to your migrations so the explanation stays with the code.</p></div>
      <div class="export-preview">
        <div class="row">
          ${STANDALONE ? `<button class="btn" id="export-download" type="button">Download ${esc(ex.file)}</button>` : ''}
          <button class="btn${STANDALONE ? ' ghost' : ''}" data-copy="#export-text" type="button">Copy ${esc(ex.file)}</button>
          ${ui.exportKind === 'dbml' ? '<a class="btn ghost" href="https://dbdiagram.io/d" target="_blank" rel="noopener">Open dbdiagram.io</a>' : ''}
          <span class="tag">${(text.length / 1024).toFixed(1)} KB</span>
        </div>
        <pre class="code" id="export-text">${esc(text)}</pre>
      </div>
    </div>`;
  if (STANDALONE) $('#export-download').addEventListener('click', () => download(ex.file, text, ex.type));
}

function download(name, text, type) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloaded ${name}`);
  } catch { toast('Download is blocked here. Use Copy instead.'); }
}

// ------------------------------------------------------------------ home: guides & samples
function renderGuides() {
  const g = GUIDES.find((x) => x.id === ui.guide) || GUIDES[0];
  const codeBlock = (id, text) => `<div class="codebox"><pre class="code" id="${id}">${esc(text)}</pre><button class="btn ghost small" data-copy="#${id}" type="button">Copy</button></div>`;
  $('#panel-guides').innerHTML = `
    <div class="guide-layout">
      <nav class="guide-nav" aria-label="Databases">${GUIDES.map((x) => `<button type="button" data-guide="${x.id}" aria-current="${x.id === g.id}">${esc(x.name)}</button>`).join('')}</nav>
      <section class="guide">
        <div style="display:grid;gap:4px"><h3>${esc(g.name)}</h3><p class="tag">${esc(g.covers)}</p></div>
        <ol>${g.steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>
        <div style="display:grid;gap:6px"><span class="label">Command</span>${codeBlock('g-cmd', g.command)}</div>
        ${g.alternative ? `<div style="display:grid;gap:6px"><span class="label">${esc(g.alternative.label)}</span>${codeBlock('g-alt', g.alternative.command)}</div>` : ''}
        <div style="display:grid;gap:6px"><div class="row"><span class="label">Query</span><span class="mono tag">export-queries/${esc(g.file)}</span>${STANDALONE ? '<button class="btn ghost small" id="g-dl" type="button">Download</button>' : ''}</div>${codeBlock('g-q', QUERIES[g.file])}</div>
        ${g.alternative && g.alternative.file ? `<div style="display:grid;gap:6px"><span class="label">export-queries/${esc(g.alternative.file)}</span>${codeBlock('g-q2', QUERIES[g.alternative.file])}</div>` : ''}
        ${g.extra ? `<div style="display:grid;gap:6px"><span class="label">${esc(g.extra.label)}</span>${codeBlock('g-x1', g.extra.command)}${codeBlock('g-x2', QUERIES[g.extra.file])}</div>` : ''}
      </section>
    </div>`;
  if (STANDALONE) $('#g-dl').addEventListener('click', () => download(g.file, QUERIES[g.file], 'text/plain'));
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

async function copyFrom(sel) {
  const el = $(sel);
  if (!el) return;
  try { await navigator.clipboard.writeText(el.textContent); toast('Copied'); } catch {
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    toast('Selected: press Ctrl+C or ⌘C to copy');
  }
}

// ------------------------------------------------------------------ init
function init() {
  store.removeLocal(OLD_CACHE_KEY);
  $('#version').textContent = `v${VERSION}`;
  $('#format').innerHTML = Object.entries(FORMATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#samples').innerHTML = SAMPLES_LIST.map((s) => `<button class="sample" type="button" data-sample="${s.id}"><b>${esc(s.label)}</b><span>${esc(s.meta)}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</button>`).join('');
  renderGuides();

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { e.stopPropagation(); readFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!$('#home').hidden && e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
  $('#file').addEventListener('change', (e) => { readFiles(e.target.files); e.target.value = ''; });
  $('#toggle-paste').addEventListener('click', () => { const p = $('#paste-wrap'); p.hidden = !p.hidden; if (!p.hidden) $('#paste').focus(); });
  $('#explain').addEventListener('click', () => {
    const text = $('#paste').value;
    if (!text.trim()) { setStatus('Paste a schema first, or choose files.', true); return; }
    openSchema([{ text, name: 'pasted schema' }], $('#format').value);
  });
  $('#load-new').addEventListener('click', () => { location.hash = 'home'; });
  $('#jump').addEventListener('click', () => {
    $('#jump').hidden = true;
    const title = $('#title');
    try { title.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { title.scrollIntoView(); }
    try { title.focus({ preventScroll: true }); } catch { /* no-op */ }
  });
  $('#banner-close').addEventListener('click', () => { $('#loaded-banner').hidden = true; });
  $('#show-audit-links').addEventListener('change', (e) => { showAuditLinks = e.target.checked; drawDiagram(curMod); renderCard(); });
  $('#q').addEventListener('input', search);
  $('#q').addEventListener('keydown', (e) => {
    const r = $('#results');
    if (r.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, Math.min(hits.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1))); r.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === hi)); }
    if (e.key === 'Enter' && hits[hi]) pickHit(hits[hi]);
    if (e.key === 'Escape') r.hidden = true;
  });
  $('#diagram').addEventListener('keydown', (e) => { const g = e.target.closest('.node'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectTable(g.dataset.n, true); } });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search') && $('#results')) $('#results').hidden = true;
    const t = e.target.closest('[data-view], [data-jump], [data-sample], [data-m], [data-mod], [data-go], .node, [data-copy], [data-guide], [data-sev-filter], [data-export], [data-detail], [data-docs], [data-path-from], #ta, #results button, [data-tab-go]');
    if (!t) return;
    if (t.dataset.view) { location.hash = t.dataset.view; return; }
    if (t.dataset.jump) { if (location.hash.slice(1) !== 'map') location.hash = 'map'; setTimeout(() => { const el = document.getElementById(t.dataset.jump); try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { el.scrollIntoView(); } }, 0); return; }
    if (t.dataset.sample) { const s = SAMPLES_LIST.find((x) => x.id === t.dataset.sample); openSchema(s.files.map((f) => ({ name: f, text: SAMPLES[f] }))); return; }
    if (t.dataset.m) { setMod(t.dataset.m); if (location.hash.slice(1) === 'docs') { const a = document.getElementById(`doc-${t.dataset.m}`); if (a) a.scrollIntoView(); } return; }
    if (t.dataset.mod) { setMod(t.dataset.mod, true); highlight(); return; }
    if (t.matches('#results button')) { pickHit(hits[Number(t.dataset.i)]); return; }
    if (t.dataset.go) { if (location.hash.slice(1) !== 'map') location.hash = 'map'; setTimeout(() => { selectTable(t.dataset.go); window.scrollTo({ top: 0 }); }, 0); return; }
    if (t.classList.contains('node')) { selectTable(t.dataset.n, true); return; }
    if (t.dataset.copy) { copyFrom(t.dataset.copy); return; }
    if (t.dataset.guide) { ui.guide = t.dataset.guide; renderGuides(); return; }
    if (t.dataset.sevFilter) { ui.sev = t.dataset.sevFilter; renderReview(); return; }
    if (t.dataset.export) { ui.exportKind = t.dataset.export; renderExport(); return; }
    if (t.dataset.detail) { toggleDetail(t); return; }
    if (t.dataset.docs) { openDocsFor(t.dataset.docs); return; }
    if (t.dataset.pathFrom) { location.hash = 'relationships'; setTimeout(() => { $('#path-from').value = T.get(t.dataset.pathFrom).name; $('#path-to').focus(); }, 0); return; }
    if (t.dataset.tabGo) { e.preventDefault(); $('#guides').scrollIntoView(); return; }
    if (t.id === 'ta') { showAudit = !showAudit; renderCard(); }
  });
  window.addEventListener('hashchange', route);
  route();
}

init();
