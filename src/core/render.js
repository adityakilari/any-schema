// Renderers: Mermaid erDiagram, Markdown report (SCHEMA.md), DBML (dbdiagram.io) and JSON.
import { qualifiedName } from './model.js';
import { sourceLabel } from './analyze.js';

export const VERSION = '1.0.0';
export const HOMEPAGE = 'https://github.com/adityakilari/any-schema';

// ------------------------------------------------------------------ Mermaid
const TYPE_SHORT = [
  [/character varying/gi, 'varchar'], [/timestamp\s*(\(\d\))?\s*with time zone/gi, 'timestamptz'], [/timestamp\s*(\(\d\))?\s*without time zone/gi, 'timestamp'],
  [/double precision/gi, 'double'], [/time with time zone/gi, 'timetz'], [/\s+byte\)/gi, ')'], [/\s+char\)/gi, ')'],
];

function mType(raw, category, readable = false) {
  let t = raw || category || 'unknown';
  for (const [re, rep] of TYPE_SHORT) t = t.replace(re, rep);
  t = t.replace(/^[A-Za-z_]+\.(?=[A-Za-z_])/, '');
  if (readable) t = t.replace(/\s+/g, '_').replace(/[<>]/g, '_').replace(/[^A-Za-z0-9_(),[\]]+/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  else t = t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!t) t = 'unknown';
  if (!/^[A-Za-z]/.test(t)) t = `t_${t}`;
  if (t.length > 32) return readable ? mType(raw, category, false) : t.slice(0, 32);
  return t;
}

function mName(name) {
  let n = String(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) n = 'unnamed';
  if (!/^[A-Za-z_]/.test(n)) n = `t_${n}`;
  return n;
}

/**
 * options: { tables?: string[] (qualified keys to include), columns: 'all' | 'keys', hideSystem: bool,
 *            hideExternal: bool, maxColumns: number, maxTables: number }
 */
export function toMermaid(schema, analysis, options = {}) {
  const opts = { columns: 'all', hideSystem: true, hideExternal: true, maxColumns: 30, maxTables: 60, ...options };
  let tables = schema.tables;
  if (opts.tables) {
    const set = new Set(opts.tables);
    tables = tables.filter((t) => set.has(qualifiedName(t)));
  } else if (tables.length > opts.maxTables) {
    const deg = new Map(analysis.tables.map((t) => [t.key, t.degree]));
    tables = [...tables].sort((a, b) => (deg.get(qualifiedName(b)) || 0) - (deg.get(qualifiedName(a)) || 0)).slice(0, opts.maxTables);
  }
  const included = new Set(tables.map((t) => qualifiedName(t)));
  // unique mermaid ids per table
  const ids = new Map();
  const used = new Set();
  for (const t of schema.tables) {
    let id = mName(schema.tables.filter((x) => x.name === t.name).length > 1 && t.schema ? `${t.schema}_${t.name}` : t.name);
    while (used.has(id)) id += '_';
    used.add(id);
    ids.set(qualifiedName(t), id);
  }
  const fkCols = new Map();
  for (const r of analysis.relationships) {
    if (r.source === 'embedded') continue;
    const set = fkCols.get(r.from.table) || new Set();
    r.from.columns.forEach((c) => set.add(c.toLowerCase()));
    fkCols.set(r.from.table, set);
  }
  const lines = ['erDiagram'];
  for (const t of tables) {
    const key = qualifiedName(t);
    const fks = fkCols.get(key) || new Set();
    const pk = new Set(t.primaryKey.map((c) => c.toLowerCase()));
    let cols = t.columns.filter((c) => !(c.meta && c.meta.container));
    if (opts.columns === 'keys') {
      const keyCols = cols.filter((c) => pk.has(c.name.toLowerCase()) || fks.has(c.name.toLowerCase()) || c.unique);
      cols = keyCols.length ? keyCols : cols.slice(0, 3);
    }
    const extra = cols.length > opts.maxColumns ? cols.length - opts.maxColumns : 0;
    cols = cols.slice(0, opts.maxColumns);
    lines.push(`  ${ids.get(key)} {`);
    const usedAttr = new Set();
    for (const c of cols) {
      const keys = [];
      if (pk.has(c.name.toLowerCase())) keys.push('PK');
      if (fks.has(c.name.toLowerCase())) keys.push('FK');
      if (c.unique && !pk.has(c.name.toLowerCase())) keys.push('UK');
      let an = mName(c.name);
      while (usedAttr.has(an)) an += '_';
      usedAttr.add(an);
      lines.push(`    ${mType(c.rawType, c.category, opts.readableTypes)} ${an}${keys.length ? ` ${keys.join(', ')}` : ''}`);
    }
    if (extra) lines.push(`    more ${mName(`plus_${extra}_columns`)}`);
    lines.push('  }');
  }
  const seen = new Set();
  for (const r of analysis.relationships) {
    if (!included.has(r.from.table)) continue;
    if (r.external || !included.has(r.to.table)) continue;
    if (opts.hideSystem && r.system) continue;
    const a = ids.get(r.to.table);
    const b = ids.get(r.from.table);
    if (!a || !b) continue;
    const line = r.source === 'inferred' ? '..' : '--';
    let card;
    if (r.type === 'embeds-many') card = `||${line}|{`;
    else if (r.type === 'embeds-one') card = `||${line}||`;
    else if (r.type === 'embedded-in') card = `||${line}|{`;
    else if (r.type === 'many-to-many') card = `}o${line}o{`;
    else if (r.type === 'one-to-one') card = `${r.nullable ? '|o' : '||'}${line}o|`;
    else card = `${r.nullable ? '|o' : '||'}${line}o{`;
    let label = r.type === 'embedded-in' ? (r.via || 'contains') : r.from.columns.join(', ') || 'has';
    if (r.source === 'inferred') label += ' (inferred)';
    const text = r.type === 'embeds-many' || r.type === 'embeds-one'
      ? `  ${b} ${card} ${a} : "${label.replace(/"/g, "'")}"`
      : `  ${a} ${card} ${b} : "${label.replace(/"/g, "'")}"`;
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ Markdown
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const anchor = (s) => String(s).toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');

export function toMarkdown(schema, analysis, options = {}) {
  const title = options.title || schema.source.files.join(', ') || 'Schema';
  const date = options.date || new Date().toISOString().slice(0, 10);
  const obj = schema.source.dialect === 'salesforce' ? 'Object' : schema.source.dialect === 'mongodb' ? 'Collection' : 'Table';
  const colWord = schema.source.dialect === 'salesforce' ? 'Field' : 'Column';
  const s = analysis.stats;
  const out = [];
  out.push(`# Schema guide: ${title}`, '');
  out.push(`> Generated by [Any Schema](${HOMEPAGE}) v${VERSION} on ${date} from ${sourceLabel(schema)}. Explanations are inferred from names, types and constraints, so review them before relying on them.`, '');
  out.push('## Overview', '', analysis.summary, '');
  out.push(`| ${obj}s | Views | ${colWord}s | Relationships | Inferred | Findings | Sensitive ${colWord.toLowerCase()}s |`, '|---|---|---|---|---|---|---|');
  out.push(`| ${s.tables} | ${s.views} | ${s.columns} | ${s.relationships} | ${s.inferred} | ${analysis.findings.length} | ${analysis.privacy.length} |`, '');
  if (schema.notes.length) out.push(...schema.notes.map((n) => `- _Note:_ ${n}`), '');

  const diagramTables = schema.tables.length > 40 ? { maxTables: 40, columns: 'keys' } : { columns: schema.tables.length > 15 ? 'keys' : 'all' };
  out.push('## Diagram', '');
  if (schema.tables.length > 40) out.push(`_Showing the 40 most connected of ${schema.tables.length} ${obj.toLowerCase()}s, key columns only._`, '');
  out.push('```mermaid', toMermaid(schema, analysis, diagramTables), '```', '');

  out.push(`## ${obj}s`, '');
  out.push(`| ${obj} | Role | Purpose |`, '|---|---|---|');
  for (const t of analysis.tables) out.push(`| [${esc(t.name)}](#${anchor(t.name)}) | ${t.roleLabel} | ${esc(firstSentence(t.purpose))} |`);
  out.push('');

  for (const t of analysis.tables) {
    const tbl = schema.tables.find((x) => qualifiedName(x) === t.key);
    out.push(`### ${t.name}`, '');
    out.push(`**${t.roleLabel}**${tbl.schema ? ` · schema \`${tbl.schema}\`` : ''}${tbl.label && tbl.label !== tbl.name ? ` · label "${esc(tbl.label)}"` : ''}${tbl.rowCount !== undefined && tbl.rowCount !== null ? ` · ~${Number(tbl.rowCount).toLocaleString('en-US')} rows` : ''}`, '');
    out.push(t.purpose, '');
    if (t.documented) out.push(`> ${esc(t.documented)}`, '');
    out.push(`| ${colWord} | Type | Null | Keys | Description |`, '|---|---|---|---|---|');
    for (const c of t.columns) {
      const col = tbl.columns.find((x) => x.name === c.name);
      const desc = [c.main, ...c.details].join(' ') + (c.documented ? ` _Source comment: ${esc(c.documented)}_` : '');
      out.push(`| \`${esc(c.name)}\` | ${esc(col.rawType || col.category)} | ${col.nullable ? 'yes' : 'no'} | ${c.tags.filter((x) => !['Audit'].includes(x)).join(', ')} | ${esc(desc)} |`);
    }
    out.push('');
  }

  const rels = analysis.relationships.filter((r) => !r.system);
  if (rels.length) {
    out.push('## Relationships', '', '| From | To | Type | Source |', '|---|---|---|---|');
    for (const r of rels) out.push(`| \`${esc(r.from.name)}.${esc(r.from.columns.join(', ') || r.via || '')}\` | \`${esc(r.to.name)}${r.to.columns.length ? `.${esc(r.to.columns.join(', '))}` : ''}\`${r.external ? ' (not in file)' : ''} | ${r.type}${r.polymorphic ? ' (polymorphic)' : ''}${r.masterDetail ? ' (master-detail)' : ''} | ${r.source}${r.source === 'inferred' ? ` (${r.confidence})` : ''} |`);
    for (const m of analysis.manyToMany) out.push(`| \`${esc(m.a)}\` | \`${esc(m.b)}\` | many-to-many via \`${esc(m.via)}\` | join table |`);
    out.push('');
  }

  out.push('## Findings', '');
  if (!analysis.findings.length) out.push('No issues found.', '');
  for (const f of analysis.findings) {
    out.push(`- **${f.severity.toUpperCase()}** · ${esc(f.title)}  `, `  ${esc(f.detail)}`);
    if (f.fix) out.push('', '  ```' + (schema.source.format === 'prisma' ? 'prisma' : 'sql'), ...f.fix.split('\n').map((l) => `  ${l}`), '  ```');
  }
  out.push('');

  if (analysis.privacy.length) {
    out.push('## Personal and sensitive data', '', `${colWord}s that look like personal data based on their names. Check them against your data-protection obligations (masking in non-production, access control, retention).`, '');
    out.push(`| ${obj} | ${colWord} | Category | Sensitivity |`, '|---|---|---|---|');
    for (const p of analysis.privacy) out.push(`| ${esc(p.table)} | \`${esc(p.column)}\` | ${p.category} | ${p.level} |`);
    out.push('');
  }
  if (schema.enums.length) {
    out.push('## Enumerations', '', '| Name | Values |', '|---|---|');
    for (const e of schema.enums) out.push(`| \`${esc(e.name)}\` | ${e.values.map((v) => `\`${esc(v)}\``).join(', ')} |`);
    out.push('');
  }
  return out.join('\n');
}

function firstSentence(s) {
  const m = /^(.+?[.!?])(\s|$)/.exec(s || '');
  return m ? m[1] : s;
}

// ------------------------------------------------------------------ DBML (dbdiagram.io)
const dq = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${String(n).replace(/"/g, '\\"')}"`);
const note = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;

export function toDbml(schema, analysis) {
  const out = [`// Generated by Any Schema v${VERSION} from ${sourceLabel(schema)}`, ''];
  const tname = (t) => (t.schema ? `${dq(t.schema)}.${dq(t.name)}` : dq(t.name));
  for (const e of schema.enums) {
    out.push(`Enum ${dq(e.name)} {`, ...e.values.map((v) => `  ${dq(v)}`), '}', '');
  }
  for (const t of schema.tables) {
    if (t.kind === 'embedded') continue;
    const at = analysis.tables.find((x) => x.key === qualifiedName(t));
    out.push(`Table ${tname(t)} {`);
    for (const c of t.columns) {
      if (c.meta && c.meta.container) continue;
      const settings = [];
      if (t.primaryKey.length === 1 && t.primaryKey[0] === c.name) settings.push('pk');
      if (!c.nullable && !settings.includes('pk')) settings.push('not null');
      if (c.unique && !settings.includes('pk')) settings.push('unique');
      if (c.autoIncrement) settings.push('increment');
      if (c.default && !/nextval|@updatedAt/.test(c.default)) settings.push(`default: \`${String(c.default).replace(/`/g, '')}\``);
      const ac = at && at.columns.find((x) => x.name === c.name);
      const n = c.comment || (ac ? ac.main : null);
      if (n) settings.push(`note: ${note(n)}`);
      const type = (c.rawType || c.category || 'unknown').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_(),[\]]/g, '') || 'unknown';
      out.push(`  ${dq(c.name)} ${type}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const idx = [];
    if (t.primaryKey.length > 1) idx.push(`    (${t.primaryKey.map(dq).join(', ')}) [pk]`);
    for (const i of t.indexes) {
      if (i.columns.some((c) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(c))) continue;
      idx.push(`    ${i.columns.length > 1 ? `(${i.columns.map(dq).join(', ')})` : dq(i.columns[0])}${i.unique ? ' [unique]' : ''}`);
    }
    if (idx.length) out.push('', '  indexes {', ...idx, '  }');
    if (t.comment || (at && at.purpose)) out.push('', `  Note: ${note(t.comment || at.purpose)}`);
    out.push('}', '');
  }
  for (const r of analysis.relationships) {
    if (r.external || r.source === 'embedded' || r.type === 'many-to-many' || !r.to.columns.length) continue;
    const from = schema.tables.find((t) => qualifiedName(t) === r.from.table);
    const to = schema.tables.find((t) => qualifiedName(t) === r.to.table);
    if (!from || !to || from.kind === 'embedded' || to.kind === 'embedded') continue;
    const op = r.type === 'one-to-one' ? '-' : '>';
    const cols = (t, cs) => (cs.length > 1 ? `${tname(t)}.(${cs.map(dq).join(', ')})` : `${tname(t)}.${dq(cs[0])}`);
    const action = r.onDelete ? r.onDelete.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null;
    const valid = action && ['cascade', 'restrict', 'set null', 'set default', 'no action'].includes(action);
    out.push(`Ref: ${cols(from, r.from.columns)} ${op} ${cols(to, r.to.columns)}${valid ? ` [delete: ${action}]` : ''}${r.source === 'inferred' ? ' // inferred from column name' : ''}`);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ JSON
export function toJson(schema, analysis) {
  return JSON.stringify({ anySchemaVersion: VERSION, generatedAt: new Date().toISOString(), schema, analysis }, null, 2);
}
