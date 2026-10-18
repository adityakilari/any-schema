// Prisma schema parser (schema.prisma): models, views, enums, composite types, @relation, @@id, @@unique, @@index, @@map.
import { createSchema, createTable, createColumn, finalizeTable, typeCategory } from '../model.js';

const SCALARS = {
  String: 'text', Int: 'integer', BigInt: 'bigint', Float: 'double precision', Decimal: 'decimal',
  Boolean: 'boolean', DateTime: 'timestamp', Json: 'json', Bytes: 'bytea',
};

const PROVIDER_DIALECT = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'sqlserver', mongodb: 'mongodb', cockroachdb: 'postgres' };

function stripLineComment(line) {
  // remove // comments that are not inside strings and are not /// doc comments
  let inStr = false;
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') inStr = !inStr;
    if (!inStr && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Split "@id @default(autoincrement()) @map(\"x\")" into [{name:'id',args:''},...] */
function parseAttributes(text, prefix = '@') {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@' && (prefix === '@@' ? text[i + 1] === '@' : text[i + 1] !== '@')) {
      i += prefix.length;
      let j = i;
      while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j++;
      const name = text.slice(i, j);
      let args = '';
      if (text[j] === '(') {
        let depth = 0;
        let k = j;
        let inStr = false;
        for (; k < text.length; k++) {
          const ch = text[k];
          if (ch === '"' && text[k - 1] !== '\\') inStr = !inStr;
          if (inStr) continue;
          if (ch === '(') depth++;
          if (ch === ')') { depth--; if (depth === 0) break; }
        }
        args = text.slice(j + 1, k);
        j = k + 1;
      }
      out.push({ name, args });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function listArg(args, key) {
  // fields: [a, b]  |  [a, b] (positional)
  const re = key ? new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`) : /^\s*\[([^\]]*)\]/;
  const m = re.exec(args);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/\(.*\)$/, '')).filter(Boolean);
}

function stringArg(args, key) {
  const re = key ? new RegExp(`${key}\\s*:\\s*"([^"]*)"`) : /^\s*"([^"]*)"/;
  const m = re.exec(args);
  return m ? m[1] : null;
}

export function parsePrisma(text, fileName = 'schema.prisma') {
  const schema = createSchema('prisma', null);
  schema.source.files.push(fileName);
  schema.indexesKnown = true;
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks = [];
  let cur = null;
  let doc = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('///')) { doc.push(line.slice(3).trim()); continue; }
    const clean = stripLineComment(line).trim();
    if (!cur) {
      const m = /^(model|view|enum|type|datasource|generator)\s+(\w+)\s*\{/.exec(clean);
      if (m) { cur = { kind: m[1], name: m[2], doc: doc.join(' '), lines: [] }; doc = []; }
      else if (clean) doc = [];
      continue;
    }
    if (clean === '}') { blocks.push(cur); cur = null; doc = []; continue; }
    if (clean) cur.lines.push({ text: clean, doc: doc.join(' ') });
    doc = clean ? [] : doc;
  }

  const enums = new Map();
  const composites = new Set();
  const modelNames = new Set();
  for (const b of blocks) {
    if (b.kind === 'datasource') {
      const p = b.lines.map((l) => /provider\s*=\s*"([^"]+)"/.exec(l.text)).find(Boolean);
      if (p) schema.source.dialect = PROVIDER_DIALECT[p[1]] || p[1];
    }
    if (b.kind === 'enum') {
      const values = b.lines.filter((l) => !l.text.startsWith('@@')).map((l) => l.text.split(/\s+/)[0]);
      enums.set(b.name, values);
      schema.enums.push({ name: b.name, values, comment: b.doc || null });
    }
    if (b.kind === 'type') composites.add(b.name);
    if (b.kind === 'model' || b.kind === 'view') modelNames.add(b.name);
  }

  for (const b of blocks) {
    if (b.kind !== 'model' && b.kind !== 'view') continue;
    const table = createTable(b.name, null, b.kind === 'view' ? 'view' : schema.source.dialect === 'mongodb' ? 'collection' : 'table');
    table.comment = b.doc || null;
    const relationFields = [];
    for (const { text: line, doc: fdoc } of b.lines) {
      if (line.startsWith('@@')) {
        for (const a of parseAttributes(line, '@@')) {
          if (a.name === 'id') table.primaryKey = listArg(a.args, 'fields') || listArg(a.args) || [];
          if (a.name === 'unique') { const cols = listArg(a.args, 'fields') || listArg(a.args); if (cols) { table.uniques.push(cols); table.indexes.push({ name: stringArg(a.args, 'name') || stringArg(a.args, 'map'), columns: cols, unique: true }); } }
          if (a.name === 'index') { const cols = listArg(a.args, 'fields') || listArg(a.args); if (cols) table.indexes.push({ name: stringArg(a.args, 'name') || stringArg(a.args, 'map'), columns: cols, unique: false }); }
          if (a.name === 'map') table.meta.dbName = stringArg(a.args) || stringArg(a.args, 'name');
          if (a.name === 'schema') table.schema = stringArg(a.args);
        }
        continue;
      }
      const m = /^(\w+)\s+([\w.]+(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, fname, ftype, isList, isOpt, rest] = m;
      const attrs = parseAttributes(rest, '@');
      if (modelNames.has(ftype)) {
        relationFields.push({ fname, ftype, isList: !!isList, isOpt: !!isOpt, attrs });
        continue;
      }
      const nativeAttr = attrs.find((a) => a.name.startsWith('db.'));
      const baseType = enums.has(ftype) ? `enum ${ftype}` : composites.has(ftype) ? 'json' : SCALARS[ftype] || ftype;
      const native = nativeAttr ? `${nativeAttr.name.slice(3)}${nativeAttr.args ? `(${nativeAttr.args})` : ''}` : null;
      const shown = enums.has(ftype) || composites.has(ftype) ? ftype : native ? `${ftype} @db.${native}` : ftype;
      const col = createColumn(fname, isList ? `${shown}[]` : shown);
      col.category = typeCategory(isList ? 'array' : native || baseType);
      col.length = native ? (/\((\d+)/.exec(native) || [])[1] * 1 || null : null;
      if (enums.has(ftype)) { col.category = isList ? 'array' : 'enum'; col.enumValues = enums.get(ftype); }
      if (composites.has(ftype)) { col.category = 'json'; col.meta = { compositeType: ftype }; }
      if (ftype === 'Decimal' && native && /money/i.test(native)) col.category = 'decimal';
      col.meta = { ...(col.meta || {}), prismaType: `${ftype}${isList ? '[]' : ''}${isOpt ? '?' : ''}` };
      col.nullable = !!isOpt;
      col.comment = fdoc || null;
      for (const a of attrs) {
        if (a.name === 'id') table.primaryKey = [fname];
        if (a.name === 'unique') { table.uniques.push([fname]); col.unique = true; }
        if (a.name === 'default') {
          col.default = a.args;
          if (/autoincrement\(\)|sequence\(/.test(a.args)) col.autoIncrement = true;
          if (/auto\(\)/.test(a.args)) col.autoIncrement = true;
        }
        if (a.name === 'updatedAt') { col.default = '@updatedAt (set by Prisma on every update)'; col.meta.updatedAt = true; }
        if (a.name === 'map') col.meta.dbName = stringArg(a.args) || stringArg(a.args, 'name');
      }
      table.columns.push(col);
    }
    // relations with fields/references are the owning side (foreign key lives here)
    for (const r of relationFields) {
      const rel = r.attrs.find((a) => a.name === 'relation');
      if (!rel) continue;
      const fields = listArg(rel.args, 'fields');
      const refs = listArg(rel.args, 'references');
      if (!fields || !refs) continue;
      const onDelete = /onDelete\s*:\s*(\w+)/.exec(rel.args);
      const onUpdate = /onUpdate\s*:\s*(\w+)/.exec(rel.args);
      table.foreignKeys.push({
        name: stringArg(rel.args, 'map') || stringArg(rel.args, 'name') || stringArg(rel.args),
        columns: fields, refSchema: null, refTable: r.ftype, refColumns: refs,
        onDelete: onDelete ? onDelete[1] : null, onUpdate: onUpdate ? onUpdate[1] : null,
        relationField: r.fname,
      });
      for (const f of fields) {
        const c = table.columns.find((x) => x.name === f);
        if (c) c.meta = { ...(c.meta || {}), relationField: r.fname };
      }
    }
    table.meta.relationFields = relationFields.map((r) => ({ name: r.fname, target: r.ftype, list: r.isList, optional: r.isOpt }));
    finalizeTable(table);
    schema.tables.push(table);
  }
  if (!schema.tables.length) schema.notes.push('No model blocks were found in the Prisma schema.');
  return schema;
}
