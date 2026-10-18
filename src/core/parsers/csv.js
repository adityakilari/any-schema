// CSV / TSV parser. Two modes:
//   1. Metadata CSV - one row per column, e.g. the output of the queries in /export-queries
//      (or information_schema.columns, a Salesforce FieldDefinition export, a data dictionary).
//   2. Data CSV - a plain data extract; column types and statistics are inferred from the values.
import { createSchema, createTable, createColumn, setColumnType, finalizeTable, normKey, findTable, findColumn } from '../model.js';
import { inferTable } from '../infer.js';

export function parseDelimited(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const candidates = [',', '\t', ';', '|'];
  const delim = candidates.map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // drop noise: blank lines, sqlcmd "-----" separator lines, "(12 rows affected)" footers, psql "(12 rows)"
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''))
    .filter((r) => !r.every((c) => /^[-\s]*$/.test(c)))
    .filter((r) => !(r.length === 1 && /^\(\d+ rows?( affected)?\)$/i.test(r[0].trim())));
  return { delimiter: delim, rows: clean.map((r) => r.map((c) => c.trim())) };
}

// header aliases (normalized: lowercase, letters+digits only)
const ALIASES = {
  table: ['tablename', 'table', 'entity', 'entityname', 'object', 'objectname', 'sobject', 'collection', 'entitydefinitionqualifiedapiname', 'entitydefinitiondeveloper', 'tabname', 'relname'],
  schema: ['tableschema', 'schema', 'schemaname', 'owner', 'dataset', 'tableschem', 'database', 'tablecatalog'],
  column: ['columnname', 'column', 'field', 'fieldname', 'qualifiedapiname', 'attribute', 'attname', 'colname', 'apiname', 'fieldapiname'],
  type: ['datatype', 'type', 'columntype', 'typename', 'fieldtype', 'dtype', 'udtname'],
  nullable: ['isnullable', 'nullable', 'isnillable', 'nillable', 'null', 'allownull', 'allownulls'],
  notnull: ['notnull', 'required', 'isrequired', 'mandatory'],
  default: ['columndefault', 'default', 'datadefault', 'defaultvalue', 'dfltvalue', 'defaultvalueformula'],
  pk: ['isprimarykey', 'primarykey', 'pk', 'ispk', 'iskey', 'keytype', 'columnkey'],
  unique: ['isunique', 'unique'],
  auto: ['isautoincrement', 'isidentity', 'autoincrement', 'identity', 'isautonumber', 'extra'],
  fkName: ['fkconstraintname', 'fkname', 'foreignkeyname', 'constraintname'],
  refSchema: ['fkrefschema', 'referencedtableschema', 'refschema', 'referencedschema', 'fkschema'],
  refTable: ['fkreftable', 'referencedtablename', 'referencestable', 'reftable', 'referencedtable', 'referenceto', 'references', 'fktable', 'lookupobject'],
  refColumn: ['fkrefcolumn', 'referencedcolumnname', 'refcolumn', 'referencedcolumn', 'fkcolumn'],
  comment: ['columncomment', 'comment', 'comments', 'description', 'remarks', 'columndescription', 'helptext', 'inlinehelptext'],
  tableComment: ['tablecomment', 'tabledescription', 'tableremarks', 'objectdescription'],
  label: ['label', 'columnlabel', 'fieldlabel', 'displayname'],
  tableType: ['tabletype', 'kind', 'objecttype', 'relkind'],
  indexed: ['isindexed', 'indexed', 'hasindex'],
  enumValues: ['enumvalues', 'picklistvalues', 'allowedvalues'],
  ordinal: ['ordinalposition', 'position', 'columnid', 'cid', 'ordinal', 'attnum', 'colorder'],
  length: ['length', 'characterlength', 'charactermaximumlength', 'maxlength', 'datalength'],
  precision: ['precision', 'numericprecision', 'dataprecision'],
  scale: ['scale', 'numericscale', 'datascale'],
};

function mapHeaders(headers) {
  const keys = headers.map(normKey);
  const idx = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const i = keys.indexOf(n);
      if (i !== -1 && !Object.values(idx).includes(i)) { idx[field] = i; break; }
    }
  }
  // a bare "name" header is the column name when a table header exists
  if (idx.table !== undefined && idx.column === undefined) {
    const i = keys.indexOf('name');
    if (i !== -1) idx.column = i;
  }
  return idx;
}

export function isMetadataHeader(headers) {
  const idx = mapHeaders(headers);
  return idx.table !== undefined && idx.column !== undefined && (idx.type !== undefined || idx.nullable !== undefined || idx.pk !== undefined);
}

const truthy = (v) => /^(y|yes|true|t|1|pri|primary|p|pk|x|✓|auto_increment|identity)$/i.test(String(v || '').trim()) || /auto_increment|identity/i.test(String(v || ''));
const isNullish = (v) => v === undefined || v === null || /^(|null|\\n|none|<null>|\(null\))$/i.test(String(v).trim());

function salesforceType(dt) {
  // FieldDefinition.DataType: "Lookup(Account)", "Master-Detail(Opportunity)", "Text(80)", "Number(18, 0)", "Picklist", "Date/Time" ...
  const m = /^(Lookup|Master-Detail|Hierarchy|External Lookup|Indirect Lookup)\((.*)\)$/i.exec(dt || '');
  if (m) return { raw: 'reference', refs: m[2].split(',').map((s) => s.trim()).filter(Boolean), masterDetail: /master/i.test(m[1]) };
  const map = [
    [/^text area|^long text area|^rich text area/i, 'textarea'], [/^text\b|^encrypted text/i, 'string'], [/^number/i, 'double'],
    [/^currency/i, 'currency'], [/^percent/i, 'percent'], [/^checkbox/i, 'boolean'], [/^date\/time/i, 'datetime'],
    [/^date$/i, 'date'], [/^time$/i, 'time'], [/^picklist \(multi-select\)/i, 'multipicklist'], [/^picklist/i, 'picklist'],
    [/^email/i, 'email'], [/^phone/i, 'phone'], [/^url/i, 'url'], [/^auto number/i, 'autonumber'], [/^formula\s*\((.*)\)/i, 'formula'],
    [/^roll-up summary/i, 'rollup'], [/^address/i, 'address'], [/^geolocation/i, 'location'],
  ];
  for (const [re, t] of map) if (re.test(dt || '')) {
    const len = /\(([\d,\s]+)\)/.exec(dt);
    return { raw: len && !/formula/i.test(t) ? `${t}(${len[1].replace(/\s/g, '')})` : t, formula: t === 'formula' ? dt : null };
  }
  return { raw: dt };
}

function parseMetadata(rows, fileName) {
  const [headers, ...data] = rows;
  const idx = mapHeaders(headers);
  const get = (r, f) => (idx[f] === undefined ? undefined : r[idx[f]]);
  const isSalesforce = headers.some((h) => /entitydefinition|qualifiedapiname|isnillable/i.test(normKey(h)));
  const schema = createSchema('csv-metadata', isSalesforce ? 'salesforce' : null);
  schema.source.files.push(fileName);
  schema.indexesKnown = idx.indexed !== undefined;
  const fkGroups = new Map();
  const ordered = data.map((r, i) => ({ r, i })).sort((a, b) => {
    const oa = Number(get(a.r, 'ordinal')); const ob = Number(get(b.r, 'ordinal'));
    return Number.isFinite(oa) && Number.isFinite(ob) ? 0 : a.i - b.i;
  });
  for (const { r } of ordered) {
    const tname = get(r, 'table');
    const cname = get(r, 'column');
    if (!tname || !cname) continue;
    const sname = isNullish(get(r, 'schema')) ? null : get(r, 'schema');
    let table = findTable(schema, tname, sname);
    if (!table || (sname && table.schema && table.schema.toLowerCase() !== sname.toLowerCase())) {
      const tt = (get(r, 'tableType') || '').toLowerCase();
      table = createTable(tname, sname, /materialized/.test(tt) ? 'materialized view' : /view|^v$|^m$/.test(tt) ? 'view' : isSalesforce ? 'object' : 'table');
      schema.tables.push(table);
    }
    if (!table.comment && !isNullish(get(r, 'tableComment'))) table.comment = get(r, 'tableComment');
    let col = findColumn(table, cname);
    const fresh = !col;
    if (fresh) col = createColumn(cname, '');
    // type (+ optional length/precision/scale columns)
    let rawType = get(r, 'type') || '';
    let sf = null;
    if (isSalesforce) { sf = salesforceType(rawType); rawType = sf.raw; }
    const len = get(r, 'length'); const prec = get(r, 'precision'); const scale = get(r, 'scale');
    if (rawType && !/\(/.test(rawType)) {
      if (/char|binary|string/i.test(rawType) && Number(len) > 0) rawType += `(${len})`;
      else if (/^(decimal|numeric|number)$/i.test(rawType) && Number(prec) > 0) rawType += `(${prec},${Number(scale) || 0})`;
    }
    if (fresh || rawType) setColumnType(col, rawType);
    if (isSalesforce) {
      if (sf.raw === 'double' || sf.raw.startsWith('double(')) col.category = 'decimal';
      if (sf.formula) col.meta = { ...(col.meta || {}), formula: sf.formula, calculated: true };
    }
    const nul = get(r, 'nullable'); const notnull = get(r, 'notnull');
    if (nul !== undefined && nul !== '') col.nullable = /^(y|yes|true|t|1|nullable|null)$/i.test(nul);
    else if (notnull !== undefined && notnull !== '') col.nullable = !truthy(notnull);
    const def = get(r, 'default');
    if (!isNullish(def)) col.default = def;
    const pkv = get(r, 'pk');
    if (pkv !== undefined && truthy(pkv) && !/^mul|^uni/i.test(pkv)) { if (!table.primaryKey.includes(col.name)) table.primaryKey.push(col.name); }
    if (isSalesforce && /^id$/i.test(cname)) { table.primaryKey = [col.name]; setColumnType(col, 'id'); col.category = 'string'; }
    if (pkv && /^uni$/i.test(pkv)) col.unique = true;
    if (truthy(get(r, 'unique'))) { col.unique = true; if (!table.uniques.some((u) => u.length === 1 && u[0] === col.name)) table.uniques.push([col.name]); }
    const auto = get(r, 'auto');
    if (auto !== undefined && truthy(auto)) col.autoIncrement = true;
    if (/^nextval\(/i.test(col.default || '')) col.autoIncrement = true;
    if (!isNullish(get(r, 'comment'))) col.comment = get(r, 'comment');
    if (!isNullish(get(r, 'label'))) col.label = get(r, 'label');
    if (idx.indexed !== undefined) col.indexed = truthy(get(r, 'indexed'));
    if (pkv && /^(pri|uni|mul)$/i.test(pkv)) col.indexed = true; // MySQL COLUMN_KEY
    const ev = get(r, 'enumValues');
    if (!isNullish(ev)) { col.enumValues = ev.split(/\s*[|;]\s*/).filter(Boolean); if (col.category === 'other') col.category = 'enum'; }
    if (!col.enumValues) {
      const m = /^enum\((.*)\)$/i.exec(col.rawType);
      if (m) { col.enumValues = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]); col.category = 'enum'; }
    }
    // foreign keys: grouped by constraint name so composite keys stay together
    const refTable = sf && sf.refs ? sf.refs : !isNullish(get(r, 'refTable')) ? [get(r, 'refTable')] : [];
    refTable.forEach((rt, k) => {
      const key = `${table.schema}.${table.name}.${isNullish(get(r, 'fkName')) || isSalesforce ? `${col.name}#${k}` : get(r, 'fkName')}`;
      let fk = fkGroups.get(key);
      if (!fk) {
        fk = { name: isNullish(get(r, 'fkName')) ? null : get(r, 'fkName'), columns: [], refSchema: isNullish(get(r, 'refSchema')) ? null : get(r, 'refSchema'), refTable: rt, refColumns: [], onDelete: null, onUpdate: null };
        if (sf && sf.refs) { fk.polymorphic = sf.refs.length > 1; fk.masterDetail = sf.masterDetail; fk.refColumns = ['Id']; }
        fkGroups.set(key, fk);
        table.foreignKeys.push(fk);
      }
      if (!fk.columns.includes(col.name)) fk.columns.push(col.name);
      const rc = get(r, 'refColumn');
      if (!isNullish(rc) && !(sf && sf.refs)) fk.refColumns.push(rc);
    });
    if (fresh) table.columns.push(col);
  }
  schema.constraintsKnown = idx.pk !== undefined || idx.refTable !== undefined || isSalesforce;
  if (!schema.constraintsKnown) {
    schema.notes.push(`${fileName} has no primary/foreign key columns, so keys were inferred from column names. Use the database-specific export query for exact keys.`);
    for (const t of schema.tables) {
      const tk = normKey(t.name).replace(/s$/, '');
      const pk = t.columns.find((c) => !c.nullable && ['id', `${tk}id`, `${normKey(t.name)}id`].includes(normKey(c.name)))
        || (t.columns[0] && !t.columns[0].nullable && /_?id$/i.test(t.columns[0].name) ? t.columns[0] : null);
      if (pk && !/view/.test(t.kind)) { t.primaryKey = [pk.name]; t.meta.pkInferred = true; }
    }
  }
  for (const t of schema.tables) finalizeTable(t);
  if (!schema.source.dialect) schema.source.dialect = sniffDialectFromTypes(schema.tables.flatMap((t) => t.columns.map((c) => c.rawType)).join('\n'));
  return schema;
}

function sniffDialectFromTypes(types) {
  const tests = [
    ['postgres', /character varying|timestamp with(out)? time zone|\bjsonb\b|\bbpchar\b|double precision|\btimestamptz\b/i],
    ['oracle', /\bvarchar2\b|\bnvarchar2\b|\bnumber\(|\bclob\b|\bbyte\)/i],
    ['sqlserver', /\bnvarchar\b|\bdatetime2\b|\buniqueidentifier\b|\bsmallmoney\b|\bdatetimeoffset\b/i],
    ['snowflake', /\btimestamp_(ntz|ltz|tz)\b|\bvariant\b/i],
    ['bigquery', /\bINT64\b|\bFLOAT64\b|\bBIGNUMERIC\b|\bSTRING\b/],
    ['mysql', /\bunsigned\b|\btinyint\(1\)|\bmediumtext\b|\blongtext\b|^enum\(/im],
  ];
  for (const [d, re] of tests) if (re.test(types)) return d;
  return null;
}

/** Rows of objects (e.g. a JSON export of information_schema.columns or ALL_TAB_COLUMNS) -> schema. */
export function parseMetadataObjects(objects, fileName) {
  const headers = [...new Set(objects.flatMap((o) => Object.keys(o)))];
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rows = [headers, ...objects.map((o) => headers.map((h) => cell(o[h])))];
  const s = parseMetadata(rows, fileName);
  s.source.format = 'json-metadata';
  return s;
}

export function parseCsv(text, fileName = 'data.csv') {
  const { rows, delimiter } = parseDelimited(text);
  if (!rows.length) {
    const s = createSchema('csv', null);
    s.notes.push(`${fileName} is empty.`);
    return s;
  }
  if (isMetadataHeader(rows[0])) {
    const s = parseMetadata(rows, fileName);
    s.source.delimiter = delimiter;
    return s;
  }
  // data CSV -> one table named after the file
  if (rows.length < 2 || rows[0].length < 2) {
    const s = createSchema('csv', null);
    s.source.files.push(fileName);
    s.notes.push(`${fileName} was not recognised as SQL, Prisma, JSON or CSV. A CSV needs a header row with at least two columns and one data row.`);
    return s;
  }
  const schema = createSchema('csv-data', null);
  schema.source.files.push(fileName);
  schema.indexesKnown = false;
  const headers = rows[0].map((h, i) => h || `column_${i + 1}`);
  const objects = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] === undefined ? null : r[i]])));
  const name = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
  schema.tables.push(inferTable(name, objects, headers));
  schema.notes.push(`${fileName}: column types were inferred from ${Math.min(objects.length, 5000)} sample rows.`);
  return schema;
}
