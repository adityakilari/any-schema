// SQL DDL parser. Handles CREATE TABLE / VIEW / INDEX / TYPE ... AS ENUM, ALTER TABLE ADD CONSTRAINT,
// COMMENT ON, MySQL inline COMMENT, SQL Server sp_addextendedproperty, and output from
// pg_dump, mysqldump, SSMS "Script as", Oracle DBMS_METADATA.GET_DDL, sqlite .schema and Snowflake GET_DDL.
import { createSchema, createTable, createColumn, setColumnType, finalizeTable, findTable, findColumn, typeCategory } from '../model.js';

// ---------------------------------------------------------------- tokenizer
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let lineStart = true;
  const push = (type, value) => {
    out.push({ type, value, upper: type === 'word' ? value.toUpperCase() : value });
    lineStart = false;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { lineStart = true; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '﻿') { i++; continue; }
    // batch separators on their own line: GO (SQL Server), / (Oracle)
    if (lineStart) {
      const eol = src.indexOf('\n', i);
      const line = src.slice(i, eol === -1 ? n : eol).trim();
      if (/^go(\s+\d+)?$/i.test(line) || line === '/') {
        push('punct', ';');
        i = eol === -1 ? n : eol;
        continue;
      }
      if (ch === '#') { i = eol === -1 ? n : eol; continue; } // MySQL comment
    }
    if (ch === '-' && src[i + 1] === '-') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (ch === "'") { const [v, j] = readQuoted(src, i, "'", true); push('string', v); i = j; continue; }
    if (ch === '"') { const [v, j] = readQuoted(src, i, '"', false); push('ident', v); i = j; continue; }
    if (ch === '`') {
      // BigQuery quotes whole paths: `project.dataset.table`
      const [v, j] = readQuoted(src, i, '`', false);
      v.split('.').forEach((part, k) => { if (k) push('punct', '.'); push('ident', part); });
      i = j; continue;
    }
    if (ch === '[') {
      const e = src.indexOf(']', i + 1);
      const inner = e === -1 ? '' : src.slice(i + 1, e);
      if (e !== -1 && inner.length && /^[^\]'",()\n]+$/.test(inner) && !/^\s*\d+\s*$/.test(inner)) {
        push('ident', inner); i = e + 1; continue;
      }
      push('punct', '['); i++; continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        const end = e === -1 ? n : e + tag.length;
        push('string', src.slice(i + tag.length, e === -1 ? n : e));
        i = end; continue;
      }
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(src[j])) j++;
      push('number', src.slice(i, j)); i = j; continue;
    }
    if (/[\p{L}_@]/u.test(ch)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$#@]/u.test(src[j])) j++;
      const word = src.slice(i, j);
      // string prefixes: N'..' E'..' B'..' X'..'
      if (src[j] === "'" && /^(n|e|b|x|u&)$/i.test(word)) {
        const [v, k] = readQuoted(src, j, "'", true); push('string', v); i = k; continue;
      }
      push('word', word); i = j; continue;
    }
    if (ch === ':' && src[i + 1] === ':') { push('op', '::'); i += 2; continue; }
    push('punct', ch); i++;
  }
  return out;
}

function readQuoted(src, i, q, allowBackslash) {
  let j = i + 1;
  let v = '';
  while (j < src.length) {
    const c = src[j];
    if (allowBackslash && c === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
    if (c === q) {
      if (src[j + 1] === q) { v += q; j += 2; continue; }
      return [v, j + 1];
    }
    v += c; j++;
  }
  return [v, j];
}

function splitStatements(tokens) {
  const stmts = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === '(') depth++;
    if (t.type === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    if (t.type === 'punct' && t.value === ';' ) {
      if (cur.length) stmts.push(cur);
      cur = []; depth = 0; continue;
    }
    cur.push(t);
  }
  if (cur.length) stmts.push(cur);
  return stmts;
}

// ---------------------------------------------------------------- token cursor
class Cursor {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  get done() { return this.i >= this.t.length; }
  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  isWord(w, k = 0) { const t = this.peek(k); return !!t && t.type === 'word' && t.upper === w; }
  isPunct(p, k = 0) { const t = this.peek(k); return !!t && t.type === 'punct' && t.value === p; }
  acceptWord(...ws) { if (ws.some((w) => this.isWord(w))) return this.next(); return null; }
  acceptSeq(...ws) {
    for (let k = 0; k < ws.length; k++) if (!this.isWord(ws[k], k)) return false;
    this.i += ws.length; return true;
  }
  acceptPunct(p) { if (this.isPunct(p)) return this.next(); return null; }
  isName(k = 0) { const t = this.peek(k); return !!t && (t.type === 'word' || t.type === 'ident'); }
  // a.b.c possibly quoted -> ['a','b','c']
  readName() {
    const parts = [];
    if (!this.isName()) return parts;
    parts.push(this.next().value);
    while (this.isPunct('.') && this.isName(1)) { this.next(); parts.push(this.next().value); }
    return parts;
  }
  // consume a balanced (...) group; returns inner tokens
  readParens() {
    if (!this.isPunct('(')) return null;
    this.next();
    const inner = [];
    let depth = 1;
    while (!this.done) {
      const t = this.next();
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) break; }
      inner.push(t);
    }
    return inner;
  }
}

function splitTopLevel(tokens, sep = ',', angles = false) {
  const parts = [];
  let cur = [];
  let depth = 0;
  let angle = 0;
  let prev = null;
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === '(') depth++;
    if (t.type === 'punct' && t.value === ')') depth--;
    // generic types: ARRAY<...>, STRUCT<...>, MAP<...> (only at paren depth 0)
    if (angles && depth === 0 && t.type === 'punct' && t.value === '<' && (angle > 0 || (prev && prev.type === 'word' && /^(ARRAY|STRUCT|MAP|RANGE|OBJECT|VECTOR)$/.test(prev.upper)))) angle++;
    else if (angles && depth === 0 && angle > 0 && t.type === 'punct' && t.value === '>') angle--;
    prev = t;
    if (depth === 0 && angle === 0 && t.type === 'punct' && t.value === sep) { parts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export function tokensToText(tokens) {
  const parts = tokens.map((t) => (t.type === 'string' ? `'${t.value.replace(/'/g, "''")}'` : t.type === 'ident' ? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value) ? t.value : `"${t.value}"`) : t.value));
  return parts.join(' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*::\s*/g, '::')
    .replace(/\s+/g, ' ')
    .trim();
}

// "((0))" -> "0", "(getdate())" -> "getdate()"  (SQL Server wraps defaults in parentheses)
export function unwrapParens(text) {
  let t = (text || '').trim();
  for (;;) {
    if (!(t.startsWith('(') && t.endsWith(')'))) return t;
    let depth = 0;
    let closesEarly = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') { depth--; if (depth === 0 && i < t.length - 1) { closesEarly = true; break; } }
    }
    if (closesEarly) return t;
    t = t.slice(1, -1).trim();
  }
}

function identList(tokens) {
  // "(a ASC, b DESC, lower(c))" -> ['a','b','lower(c)']
  return splitTopLevel(tokens).map((part) => {
    const named = part.filter((t) => !(t.type === 'word' && /^(ASC|DESC|NULLS|FIRST|LAST|COLLATE)$/.test(t.upper)));
    if (named.length === 1 && (named[0].type === 'word' || named[0].type === 'ident')) return named[0].value;
    // INDEX (col(10)) MySQL prefix length
    if (named.length >= 2 && named[0].type !== 'punct' && named[1].type === 'punct' && named[1].value === '(' && named.slice(2).every((t) => t.type === 'number' || t.value === ')')) return named[0].value;
    return tokensToText(named);
  }).filter(Boolean);
}

// ---------------------------------------------------------------- column definitions
const COLUMN_STOP = new Set([
  'CONSTRAINT', 'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COLLATE', 'IDENTITY',
  'AUTO_INCREMENT', 'AUTOINCREMENT', 'GENERATED', 'COMMENT', 'ON', 'ENCODE', 'CHARSET', 'ENABLE', 'DISABLE',
  'SPARSE', 'ROWGUIDCOL', 'FILESTREAM', 'MASKED', 'WITH', 'AS', 'VISIBLE', 'INVISIBLE', 'SRID', 'KEY', 'OPTIONS',
  'STORAGE', 'COMPRESSION', 'NOVALIDATE', 'VALIDATE', 'RELY', 'NORELY', 'DEFERRABLE', 'INITIALLY', 'USING',
  'MASKING', 'TAG', 'COLUMN_FORMAT', 'PERSISTED', 'FOREIGN', 'SORTKEY', 'DISTKEY', 'NOORDER', 'ORDER', 'START', 'INCREMENT',
]);

function readTypeTokens(c) {
  const typeToks = [];
  while (!c.done) {
    const t = c.peek();
    if (t.type === 'punct' && t.value === ',') break;
    if (t.type === 'word' && t.upper === 'WITH' && (c.isWord('TIME', 1) || c.isWord('LOCAL', 1))) { typeToks.push(c.next()); continue; }
    if (t.type === 'word' && COLUMN_STOP.has(t.upper)) break;
    if (t.type === 'word' && t.upper === 'CHARACTER' && c.isWord('SET', 1)) break;
    if (t.type === 'punct' && t.value === '(') {
      typeToks.push(t);
      const inner = c.readParens();
      typeToks.push(...inner, { type: 'punct', value: ')' });
      continue;
    }
    if (t.type === 'string') break;
    // BigQuery/Snowflake: ARRAY<STRING>, STRUCT<a INT64>
    if (t.type === 'punct' && t.value === '<') {
      let depth = 0;
      while (!c.done) {
        const x = c.next(); typeToks.push(x);
        if (x.value === '<') depth++;
        if (x.value === '>') { depth--; if (depth === 0) break; }
      }
      continue;
    }
    typeToks.push(c.next());
    if (typeToks.length > 12) break;
  }
  return typeToks;
}

function typeText(toks) {
  let s = '';
  for (const t of toks) {
    if (t.type === 'punct' && ['(', ')', ',', '[', ']', '<', '>', '.'].includes(t.value)) { s += t.value; continue; }
    if (t.type === 'string') { s += `'${t.value}'`; continue; }
    if (s && !/[(,<\[.]$/.test(s)) s += ' ';
    s += t.value;
  }
  return s.trim();
}

function enumFromCheck(tokens, colName) {
  const strings = tokens.filter((t) => t.type === 'string').map((t) => t.value);
  if (strings.length < 2) return null;
  const mentions = !colName || tokens.some((t) => (t.type === 'word' || t.type === 'ident') && t.value.toLowerCase() === colName.toLowerCase());
  const looksLikeList = tokens.some((t) => t.type === 'word' && (t.upper === 'IN' || t.upper === 'ANY' || t.upper === 'ARRAY'));
  return mentions && looksLikeList ? [...new Set(strings)] : null;
}

function parseColumnDef(toks, table, pending) {
  const c = new Cursor(toks);
  const nameTok = c.next();
  if (!nameTok) return;
  const col = createColumn(nameTok.value, '');
  // SQL Server computed column:  [Total] AS ([Qty]*[Price]) PERSISTED
  if (c.isWord('AS')) {
    c.next();
    const expr = c.readParens() || [];
    col.computed = tokensToText(expr);
    setColumnType(col, 'computed');
  } else {
    const typeToks = readTypeTokens(c);
    setColumnType(col, typeText(typeToks));
    const enumM = /^(enum|set)\s*\((.*)\)$/i.exec(col.rawType);
    if (enumM) col.enumValues = typeToks.filter((t) => t.type === 'string').map((t) => t.value);
    if (/\bserial\b|serial[248]?$/i.test(col.rawType)) col.autoIncrement = true;
  }
  let constraintName = null;
  while (!c.done) {
    if (c.acceptWord('CONSTRAINT')) { constraintName = c.readName().pop() || null; continue; }
    if (c.acceptSeq('NOT', 'NULL')) { col.nullable = false; continue; }
    if (c.acceptWord('NULL')) { col.nullable = true; continue; }
    if (c.acceptWord('DEFAULT')) {
      const exprToks = [];
      while (!c.done) {
        const t = c.peek();
        if (t.type === 'word' && COLUMN_STOP.has(t.upper) && !(t.upper === 'NULL' && exprToks.length === 0)) break;
        if (t.type === 'punct' && t.value === ',') break;
        if (t.type === 'punct' && t.value === '(') { exprToks.push(t, ...c.readParens(), { type: 'punct', value: ')' }); continue; }
        exprToks.push(c.next());
      }
      col.default = unwrapParens(tokensToText(exprToks));
      if (/nextval/i.test(col.default)) col.autoIncrement = true;
      continue;
    }
    if (c.acceptSeq('PRIMARY', 'KEY')) {
      c.acceptWord('ASC', 'DESC', 'CLUSTERED', 'NONCLUSTERED');
      table.primaryKey = [col.name];
      if (c.acceptWord('AUTOINCREMENT')) col.autoIncrement = true;
      continue;
    }
    if (c.acceptWord('UNIQUE')) { c.acceptWord('KEY'); c.acceptWord('CLUSTERED', 'NONCLUSTERED'); table.uniques.push([col.name]); continue; }
    if (c.acceptWord('REFERENCES')) {
      const fk = readReferences(c, [col.name], constraintName);
      if (fk) table.foreignKeys.push(fk);
      constraintName = null;
      continue;
    }
    if (c.acceptWord('CHECK')) {
      const inner = c.readParens() || [];
      const ev = enumFromCheck(inner, col.name);
      if (ev && !col.enumValues) col.enumValues = ev;
      continue;
    }
    if (c.acceptWord('IDENTITY')) { col.autoIncrement = true; c.readParens(); continue; }
    if (c.acceptWord('AUTO_INCREMENT', 'AUTOINCREMENT')) { col.autoIncrement = true; continue; }
    if (c.acceptWord('GENERATED')) {
      // GENERATED {ALWAYS|BY DEFAULT [ON NULL]} AS IDENTITY [(...)]  |  GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]
      while (c.acceptWord('ALWAYS', 'BY', 'DEFAULT', 'ON', 'NULL')) { /* skip */ }
      if (c.acceptWord('AS')) {
        if (c.acceptWord('IDENTITY')) { col.autoIncrement = true; c.readParens(); }
        else { col.computed = tokensToText(c.readParens() || []); c.acceptWord('STORED', 'VIRTUAL', 'PERSISTED'); }
      }
      continue;
    }
    if (c.acceptWord('AS')) { const p = c.readParens(); if (p) col.computed = tokensToText(p); continue; }
    if (c.acceptWord('COMMENT')) { c.acceptPunct('='); const s = c.next(); if (s && s.type === 'string') col.comment = s.value; continue; }
    if (c.acceptWord('COLLATE', 'CHARSET', 'ENCODE', 'SRID', 'COLUMN_FORMAT', 'STORAGE', 'COMPRESSION')) { c.next(); continue; }
    if (c.acceptSeq('CHARACTER', 'SET')) { c.next(); continue; }
    if (c.acceptWord('ON')) {
      // MySQL: ON UPDATE CURRENT_TIMESTAMP[(n)]
      if (c.acceptWord('UPDATE')) { const x = c.next(); if (c.isPunct('(')) c.readParens(); col.onUpdate = x ? x.value : null; }
      continue;
    }
    if (c.acceptWord('OPTIONS')) { const d = optionsDescription(c.readParens() || []); if (d) col.comment = d; continue; }
    if (c.acceptWord('START', 'INCREMENT')) { c.acceptWord('WITH', 'BY'); c.next(); continue; }
    if (c.isPunct('(')) { c.readParens(); continue; }
    c.next(); // ENABLE, SPARSE, NOORDER, PERSISTED, etc.
  }
  table.columns.push(col);
  return col;
}

function optionsDescription(inner) {
  for (const kv of splitTopLevel(inner)) {
    if (kv[0] && /^description$/i.test(kv[0].value)) {
      const v = kv.find((t, i) => i > 0 && (t.type === 'string' || t.type === 'ident'));
      if (v) return v.value;
    }
  }
  return null;
}

function readReferences(c, columns, name) {
  const parts = c.readName();
  if (!parts.length) return null;
  const refTable = parts[parts.length - 1];
  const refSchema = parts.length > 1 ? parts[parts.length - 2] : null;
  const refCols = c.isPunct('(') ? identList(c.readParens()) : [];
  const fk = { name: name || null, columns, refSchema, refTable, refColumns: refCols, onDelete: null, onUpdate: null };
  while (!c.done) {
    if (c.acceptSeq('ON', 'DELETE')) { fk.onDelete = readAction(c); continue; }
    if (c.acceptSeq('ON', 'UPDATE')) { fk.onUpdate = readAction(c); continue; }
    if (c.acceptWord('MATCH')) { c.next(); continue; }
    if (c.acceptWord('DEFERRABLE', 'INITIALLY', 'DEFERRED', 'IMMEDIATE', 'ENABLE', 'DISABLE', 'VALIDATE', 'NOVALIDATE', 'RELY', 'NORELY', 'NOT')) continue;
    if (c.acceptSeq('FOR', 'REPLICATION')) continue;
    break;
  }
  return fk;
}

function readAction(c) {
  if (c.acceptSeq('SET', 'NULL')) return 'SET NULL';
  if (c.acceptSeq('SET', 'DEFAULT')) return 'SET DEFAULT';
  if (c.acceptSeq('NO', 'ACTION')) return 'NO ACTION';
  const t = c.next();
  return t ? t.upper : null;
}

// table-level constraint or index inside CREATE TABLE ( ... ) / after ALTER TABLE ADD
function parseTableElement(toks, table) {
  const c = new Cursor(toks);
  let cname = null;
  if (c.acceptWord('CONSTRAINT')) cname = c.readName().pop() || null;
  if (c.acceptSeq('PRIMARY', 'KEY')) {
    c.acceptWord('CLUSTERED', 'NONCLUSTERED');
    if (c.isName() && !c.isPunct('(')) c.next(); // MySQL: PRIMARY KEY name (..)
    c.acceptWord('USING') && c.next();
    table.primaryKey = identList(c.readParens() || []);
    return true;
  }
  if (c.isWord('UNIQUE')) {
    c.next();
    c.acceptWord('KEY', 'INDEX');
    c.acceptWord('CLUSTERED', 'NONCLUSTERED');
    let iname = cname;
    if (c.isName() && !c.isPunct('(')) iname = c.next().value;
    if (c.acceptWord('USING')) c.next();
    const cols = identList(c.readParens() || []);
    if (cols.length) {
      table.uniques.push(cols);
      table.indexes.push({ name: iname, columns: cols, unique: true });
    }
    return true;
  }
  if (c.acceptSeq('FOREIGN', 'KEY')) {
    if (c.isName() && !c.isPunct('(')) c.next(); // MySQL index name
    const cols = identList(c.readParens() || []);
    if (!c.acceptWord('REFERENCES')) return true;
    const fk = readReferences(c, cols, cname);
    if (fk) table.foreignKeys.push(fk);
    return true;
  }
  if (c.acceptWord('CHECK')) {
    const inner = c.readParens() || [];
    const ev = enumFromCheck(inner, null);
    if (ev) {
      const target = table.columns.find((col) => inner.some((t) => (t.type === 'word' || t.type === 'ident') && t.value.toLowerCase() === col.name.toLowerCase()));
      if (target && !target.enumValues) target.enumValues = ev;
    }
    return true;
  }
  if (c.isWord('KEY') || c.isWord('INDEX') || c.isWord('FULLTEXT') || c.isWord('SPATIAL')) {
    // decide: index definition vs. a column literally named key/index
    const save = c.i;
    c.next();
    c.acceptWord('KEY', 'INDEX');
    let iname = null;
    if (c.isName() && !c.isPunct('(')) iname = c.next().value;
    if (c.acceptWord('USING')) c.next();
    if (c.isPunct('(')) {
      const inner = c.readParens();
      if (inner.length && !inner.every((t) => t.type === 'number' || t.value === ',')) {
        table.indexes.push({ name: iname, columns: identList(inner), unique: false });
        return true;
      }
    }
    c.i = save;
    return false;
  }
  if (c.isWord('EXCLUDE') || c.isWord('PERIOD') || c.isWord('LIKE') || c.isWord('SHARD') || c.isWord('SUPPLEMENTAL')) return true;
  return !!cname;
}

// ---------------------------------------------------------------- statements
function parseCreateTable(c, schema) {
  const ifNot = () => c.acceptSeq('IF', 'NOT', 'EXISTS');
  ifNot();
  const parts = c.readName();
  if (!parts.length) return;
  const table = createTable(parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null, 'table');
  if (c.acceptWord('AS') || c.isWord('LIKE') || c.isWord('CLONE')) {
    table.comment = null;
    table.meta.derived = true;
    schema.notes.push(`Table ${table.name} is created from a query or clone; its columns could not be read from the DDL.`);
    schema.tables.push(table);
    return;
  }
  if (c.acceptWord('OF')) c.next(); // typed table
  if (c.acceptWord('PARTITION')) { c.acceptWord('OF'); c.readName(); }
  const body = c.readParens();
  if (!body) return;
  for (const el of splitTopLevel(body, ',', true)) {
    if (!el.length) continue;
    if (parseTableElement(el, table)) continue;
    parseColumnDef(el, table);
  }
  // trailing table options: COMMENT='..', COMMENT '..', ENGINE=..., WITH (...), TABLESPACE ...
  while (!c.done) {
    if (c.acceptWord('COMMENT')) { c.acceptPunct('='); const s = c.next(); if (s && s.type === 'string') table.comment = s.value; continue; }
    if (c.acceptWord('OPTIONS')) { const d = optionsDescription(c.readParens() || []); if (d) table.comment = d; continue; }
    if (c.isPunct('(')) { c.readParens(); continue; }
    c.next();
  }
  schema.tables.push(table);
}

function parseCreateView(c, schema, materialized) {
  c.acceptSeq('IF', 'NOT', 'EXISTS');
  const parts = c.readName();
  if (!parts.length) return;
  const view = createTable(parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null, materialized ? 'materialized view' : 'view');
  let explicit = null;
  if (c.isPunct('(')) explicit = identList(c.readParens());
  while (!c.done && !c.isWord('AS')) c.next();
  c.acceptWord('AS');
  const rest = c.t.slice(c.i);
  view.meta.definition = tokensToText(rest).slice(0, 4000);
  const names = explicit || selectListNames(rest);
  for (const n of names) view.columns.push(createColumn(n, ''));
  // which tables does the view read from?
  const from = [];
  for (let i = 0; i < rest.length - 1; i++) {
    if (rest[i].type === 'word' && (rest[i].upper === 'FROM' || rest[i].upper === 'JOIN')) {
      let j = i + 1;
      while (rest[j] && rest[j].type === 'punct' && rest[j].value === '(') j++;
      const cur = new Cursor(rest.slice(j));
      const p = cur.readName();
      if (p.length) from.push(p[p.length - 1]);
    }
  }
  view.meta.sources = [...new Set(from)];
  schema.tables.push(view);
}

function selectListNames(rest) {
  const idx = rest.findIndex((t) => t.type === 'word' && t.upper === 'SELECT');
  if (idx === -1) return [];
  let depth = 0;
  const items = [];
  let cur = [];
  for (let i = idx + 1; i < rest.length; i++) {
    const t = rest[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    if (t.type === 'punct' && t.value === ')') depth--;
    if (depth === 0 && t.type === 'word' && t.upper === 'FROM') break;
    if (depth === 0 && t.type === 'punct' && t.value === ',') { items.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) items.push(cur);
  return items.map((it, k) => {
    const toks = it.filter((t) => !(t.type === 'word' && t.upper === 'DISTINCT'));
    const last = toks[toks.length - 1];
    if (!last) return `expr_${k + 1}`;
    if (last.value === '*') return null;
    const asIdx = toks.findIndex((t, j) => t.type === 'word' && t.upper === 'AS' && j === toks.length - 2);
    if (asIdx !== -1) return last.value;
    if ((last.type === 'word' || last.type === 'ident') && (toks.length === 1 || toks[toks.length - 2].value === '.' )) return last.value;
    if ((last.type === 'word' || last.type === 'ident') && toks.length >= 2 && !/^[().]$/.test(toks[toks.length - 2].value)) return last.value;
    return `expr_${k + 1}`;
  }).filter(Boolean);
}

function parseCreateIndex(c, schema, unique) {
  c.acceptWord('CLUSTERED', 'NONCLUSTERED', 'BITMAP', 'FULLTEXT', 'SPATIAL');
  c.acceptWord('INDEX');
  c.acceptWord('CONCURRENTLY');
  c.acceptSeq('IF', 'NOT', 'EXISTS');
  let name = null;
  if (!c.isWord('ON')) name = c.readName().pop() || null;
  if (!c.acceptWord('ON')) return;
  c.acceptWord('ONLY');
  const parts = c.readName();
  if (c.acceptWord('USING')) c.next();
  const cols = identList(c.readParens() || []);
  const table = findTable(schema, parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null);
  if (!table || !cols.length) return;
  table.indexes.push({ name, columns: cols, unique });
  if (unique) table.uniques.push(cols);
}

function parseAlterTable(c, schema) {
  c.acceptWord('ONLY');
  c.acceptSeq('IF', 'EXISTS');
  c.acceptWord('ONLY');
  const parts = c.readName();
  const table = findTable(schema, parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null);
  if (!table) return;
  // split multiple actions: ADD ..., ADD ..., MODIFY ...
  const actions = splitTopLevel(c.t.slice(c.i));
  for (const act of actions) {
    const a = new Cursor(act);
    a.acceptWord('WITH'); a.acceptWord('CHECK', 'NOCHECK');
    if (a.acceptWord('ADD')) {
      a.acceptWord('COLUMN');
      a.acceptSeq('IF', 'NOT', 'EXISTS');
      const save = a.i;
      if (a.acceptWord('CONSTRAINT')) a.readName();
      if (!a.isWord('DEFAULT')) a.i = save;
      if (a.acceptWord('DEFAULT')) {
        const forIdx = act.findIndex((t, k) => k >= a.i && t.type === 'word' && t.upper === 'FOR');
        if (forIdx !== -1) { const col = findColumn(table, act[forIdx + 1] && act[forIdx + 1].value); if (col) col.default = unwrapParens(tokensToText(act.slice(a.i, forIdx))); }
        continue;
      }
      const rest = act.slice(a.i);
      if (!parseTableElement(rest, table)) parseColumnDef(rest, table);
      continue;
    }
    if (a.acceptWord('MODIFY') || a.acceptWord('CHANGE')) {
      a.acceptWord('COLUMN');
      if (act[a.i - 1] && act[a.i - 1].upper === 'CHANGE') a.next();
      const rest = act.slice(a.i);
      const tmp = createTable('tmp');
      const col = parseColumnDef(rest, tmp);
      const existing = col && findColumn(table, col.name);
      if (existing && col) {
        if (col.rawType) setColumnType(existing, col.rawType);
        if (col.autoIncrement) existing.autoIncrement = true;
        if (!col.nullable) existing.nullable = false;
        if (col.comment) existing.comment = col.comment;
      }
      continue;
    }
    if (a.acceptWord('ALTER')) {
      a.acceptWord('COLUMN');
      const colName = a.readName().pop();
      const col = findColumn(table, colName);
      if (!col) continue;
      const text = tokensToText(act.slice(a.i)).toUpperCase();
      if (/NEXTVAL|AS IDENTITY|IDENTITY/.test(text)) col.autoIncrement = true;
      if (/SET NOT NULL/.test(text)) col.nullable = false;
      if (/SET DEFAULT/.test(text)) col.default = tokensToText(act.slice(a.i + 2));
    }
  }
}

function parseCommentOn(c, schema) {
  const kind = c.next();
  if (!kind) return;
  if (kind.upper === 'MATERIALIZED') c.acceptWord('VIEW');
  if (kind.upper === 'FOREIGN') c.acceptWord('TABLE');
  const parts = c.readName();
  if (!c.acceptWord('IS')) return;
  const s = c.next();
  if (!s || s.type !== 'string') return;
  if (['TABLE', 'VIEW', 'MATERIALIZED', 'FOREIGN'].includes(kind.upper)) {
    const t = findTable(schema, parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null);
    if (t) t.comment = s.value;
  } else if (kind.upper === 'COLUMN') {
    const col = parts[parts.length - 1];
    const t = findTable(schema, parts[parts.length - 2], parts.length > 2 ? parts[parts.length - 3] : null);
    const cc = findColumn(t, col);
    if (cc) cc.comment = s.value;
  } else if (kind.upper === 'TYPE') {
    // ignore
  }
}

function parseExtendedProperty(stmt, schema) {
  // EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'...', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'x', @level2type=N'COLUMN', @level2name=N'y'
  const args = {};
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i];
    if (t.type === 'word' && t.value.startsWith('@') && stmt[i + 1] && stmt[i + 1].value === '=' && stmt[i + 2]) {
      args[t.value.slice(1).toLowerCase()] = stmt[i + 2].value;
    }
  }
  const positional = stmt.filter((t) => t.type === 'string').map((t) => t.value);
  const get = (k, pos) => args[k] ?? positional[pos];
  if (!/description/i.test(get('name', 0) || '')) return;
  const value = get('value', 1);
  const tableName = get('level1name', 5);
  const colType = get('level2type', 6);
  const colName = get('level2name', 7);
  const t = findTable(schema, tableName, get('level0name', 3));
  if (!t) return;
  if (colType && /column/i.test(colType)) { const cc = findColumn(t, colName); if (cc) cc.comment = value; }
  else t.comment = value;
}

function parseCreateType(c, schema) {
  const parts = c.readName();
  if (!c.acceptWord('AS')) return;
  if (!c.acceptWord('ENUM')) return;
  const values = (c.readParens() || []).filter((t) => t.type === 'string').map((t) => t.value);
  schema.enums.push({ name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : null, values });
}

// ---------------------------------------------------------------- dialect sniffing
export function detectSqlDialect(text) {
  const score = { postgres: 0, mysql: 0, sqlserver: 0, oracle: 0, sqlite: 0, snowflake: 0, bigquery: 0 };
  const t = text.slice(0, 200000);
  const count = (re) => (t.match(re) || []).length;
  score.mysql += count(/`/g) > 4 ? 3 : 0;
  score.mysql += count(/\bENGINE\s*=|\bAUTO_INCREMENT\b|\bunsigned\b|\bCHARSET\b/gi) * 2;
  score.sqlserver += count(/\[\w+\]\.\[\w+\]|^\s*GO\s*$|\bIDENTITY\s*\(|\bNVARCHAR\b|\bCLUSTERED\b|\bsp_addextendedproperty\b/gim) * 2;
  score.oracle += count(/\bVARCHAR2\b|\bNUMBER\s*\(|\bTABLESPACE\b|\bENABLE\b|\bSEGMENT CREATION\b|\bNOCOMPRESS\b|\bCLOB\b/gi) * 2;
  score.postgres += count(/\bSERIAL\b|\bBIGSERIAL\b|::|\bALTER TABLE ONLY\b|\bnextval\(|\bwith time zone\b|\bCOMMENT ON\b|\bjsonb\b|\bpg_catalog\b|\bOWNER TO\b|\bTIMESTAMPTZ\b/gi) * 2;
  score.sqlite += count(/\bAUTOINCREMENT\b|\bsqlite_|\bWITHOUT ROWID\b/gi) * 3;
  score.snowflake += count(/\bcreate or replace (transient )?TABLE\b|\bVARIANT\b|\bautoincrement start\b|\bNUMBER\(38,0\)|\bTIMESTAMP_NTZ\b|\bTIMESTAMP_LTZ\b/gi) * 2;
  score.bigquery += count(/\bINT64\b|\bFLOAT64\b|\bSTRING\b|\bSTRUCT</g) * 2 + count(/`[\w-]+\.[\w]+\.[\w]+`/g) * 3;
  // AUTOINCREMENT alone also matches snowflake
  if (score.snowflake > score.sqlite) score.sqlite = 0;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'ansi';
}

// ---------------------------------------------------------------- entry
export function parseSql(text, fileName = 'schema.sql') {
  const schema = createSchema('sql', detectSqlDialect(text));
  schema.source.files.push(fileName);
  schema.indexesKnown = true;
  const statements = splitStatements(tokenize(text));
  const deferred = [];
  for (const stmt of statements) {
    const c = new Cursor(stmt);
    if (c.isWord('EXEC') || c.isWord('EXECUTE')) { deferred.push(stmt); continue; }
    if (c.acceptWord('CREATE')) {
      c.acceptSeq('OR', 'REPLACE');
      c.acceptWord('GLOBAL', 'LOCAL');
      c.acceptWord('TEMPORARY', 'TEMP', 'TRANSIENT', 'VOLATILE', 'UNLOGGED', 'EXTERNAL', 'MULTISET', 'SET', 'VIRTUAL', 'HYBRID', 'ICEBERG', 'DYNAMIC');
      if (c.acceptWord('TABLE')) { parseCreateTable(c, schema); continue; }
      if (c.isWord('UNIQUE') || c.isWord('INDEX') || c.isWord('CLUSTERED') || c.isWord('NONCLUSTERED') || c.isWord('BITMAP')) { deferred.push(stmt); continue; }
      if (c.acceptWord('MATERIALIZED')) { if (c.acceptWord('VIEW')) parseCreateView(c, schema, true); continue; }
      if (c.acceptWord('TYPE')) { parseCreateType(c, schema); continue; }
      // VIEW, possibly after MySQL/Snowflake noise: ALGORITHM=.. DEFINER=.. SQL SECURITY .. / SECURE / RECURSIVE
      const viewAt = stmt.findIndex((t, k) => k >= c.i && k < c.i + 20 && t.type === 'word' && t.upper === 'VIEW');
      if (viewAt !== -1 && !stmt.slice(c.i, viewAt).some((t) => t.type === 'word' && ['TABLE', 'FUNCTION', 'PROCEDURE', 'TRIGGER'].includes(t.upper))) {
        c.i = viewAt + 1; parseCreateView(c, schema, false);
      }
      continue;
    }
    if (c.isWord('ALTER') || c.isWord('COMMENT')) deferred.push(stmt);
  }
  // second pass: things that reference tables defined anywhere in the file
  for (const stmt of deferred) {
    const c = new Cursor(stmt);
    if (c.acceptWord('ALTER')) { if (c.acceptWord('TABLE')) parseAlterTable(c, schema); continue; }
    if (c.acceptWord('COMMENT')) { if (c.acceptWord('ON')) parseCommentOn(c, schema); continue; }
    if (c.acceptWord('CREATE')) { const u = !!c.acceptWord('UNIQUE'); parseCreateIndex(c, schema, u); continue; }
    if (c.isWord('EXEC') || c.isWord('EXECUTE')) parseExtendedProperty(stmt, schema);
  }
  // enum types -> columns
  for (const t of schema.tables) {
    for (const col of t.columns) {
      const typeName = col.rawType.replace(/^.*\./, '').replace(/"/g, '').replace(/\[\]$/, '');
      const en = schema.enums.find((e) => e.name.toLowerCase() === typeName.toLowerCase());
      if (en) { col.enumValues = en.values; col.category = 'enum'; }
      if (col.enumValues && col.category !== 'enum' && col.category !== 'array') col.meta = { ...(col.meta || {}), checkEnum: true };
    }
    finalizeTable(t);
  }
  if (!schema.tables.length) schema.notes.push('No CREATE TABLE or CREATE VIEW statements were found.');
  return schema;
}

export { typeCategory };
