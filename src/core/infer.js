// Type and statistics inference from sample data rows (data CSVs, JSON arrays, Mongo samples).
import { createColumn, createTable, finalizeTable, normKey } from './model.js';

const RE = {
  int: /^[-+]?\d{1,18}$/,
  dec: /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/,
  bool: /^(true|false|yes|no|y|n|t|f)$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  usDate: /^\d{1,2}\/\d{1,2}\/\d{2,4}( \d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?)?$/i,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  objectId: /^[0-9a-f]{24}$/i,
  sfId: /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\/\S+$/i,
  money: /^[$€£¥₹]\s?-?[\d,]+(\.\d+)?$/,
};

function classify(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    if (v.$oid) return 'objectid';
    if (v.$date) return 'datetime';
    if (v.$numberDecimal) return 'decimal';
    if (v.$numberLong || v.$numberInt) return 'integer';
    return 'object';
  }
  const s = String(v).trim();
  if (s === '' || /^(null|nil|none|n\/a|na|\\n)$/i.test(s)) return 'null';
  if (RE.int.test(s)) return s.length > 1 && s[0] === '0' && !s.includes('.') ? 'string-num' : 'integer';
  if (RE.dec.test(s)) return 'decimal';
  if (RE.bool.test(s)) return 'boolean';
  if (RE.datetime.test(s)) return 'datetime';
  if (RE.date.test(s)) return 'date';
  if (RE.usDate.test(s)) return s.includes(':') ? 'datetime' : 'date';
  if (RE.time.test(s)) return 'time';
  if (RE.uuid.test(s)) return 'uuid';
  if (RE.objectId.test(s)) return 'objectid';
  if (RE.money.test(s)) return 'money';
  if ((s[0] === '{' && s.endsWith('}')) || (s[0] === '[' && s.endsWith(']'))) {
    try { JSON.parse(s); return 'json'; } catch { /* plain text */ }
  }
  return 'string';
}

const RAW = {
  integer: 'integer', bigint: 'bigint', decimal: 'decimal', boolean: 'boolean', datetime: 'timestamp', date: 'date', time: 'time',
  uuid: 'uuid', objectid: 'objectId', json: 'json', object: 'object', array: 'array', string: 'varchar', 'string-num': 'varchar', money: 'varchar (currency text)',
};

/** Infer one column from its values. */
export function inferColumn(name, values) {
  const counts = {};
  let nulls = 0;
  let maxLen = 0;
  let maxDecimals = 0;
  let maxAbs = 0;
  const distinct = new Map();
  const nums = [];
  const dates = [];
  for (const v of values) {
    const k = classify(v);
    if (k === 'null') { nulls++; continue; }
    counts[k] = (counts[k] || 0) + 1;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
    maxLen = Math.max(maxLen, s.length);
    if (distinct.size <= 1000) distinct.set(s, (distinct.get(s) || 0) + 1);
    if (k === 'integer' || k === 'decimal') {
      const n = typeof v === 'number' ? v : Number(s);
      nums.push(n);
      maxAbs = Math.max(maxAbs, Math.abs(n));
      const d = s.includes('.') ? s.split('.')[1].replace(/[eE].*/, '').length : 0;
      maxDecimals = Math.max(maxDecimals, d);
    }
    if (k === 'date' || k === 'datetime') dates.push(s);
  }
  const nonNull = values.length - nulls;
  let kind = 'string';
  const kinds = Object.keys(counts);
  if (kinds.length === 1) kind = kinds[0];
  else if (kinds.length > 1) {
    const set = new Set(kinds);
    if ([...set].every((k) => k === 'integer' || k === 'decimal')) kind = 'decimal';
    else if ([...set].every((k) => k === 'date' || k === 'datetime')) kind = 'datetime';
    else if ([...set].every((k) => k === 'integer' || k === 'boolean') && distinct.size <= 2) kind = 'boolean';
    else {
      // dominant type with a few outliers: still report the dominant one, mark mixed
      const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      kind = n / nonNull >= 0.95 ? top : 'string';
    }
  }
  // integers that are only 0/1 on a flag-like name are booleans
  if (kind === 'integer' && distinct.size <= 2 && [...distinct.keys()].every((x) => x === '0' || x === '1') && /^(is|has|can|should|allow|enable|active|flag)|(_flag|enabled|active|deleted)$/i.test(name)) kind = 'boolean';
  if (kind === 'integer' && maxAbs > 2147483647) kind = 'bigint';
  let raw = RAW[kind] || 'varchar';
  if (kind === 'decimal') raw = `decimal(${Math.min(38, Math.max(String(Math.trunc(maxAbs)).length + maxDecimals, 1))},${maxDecimals})`;
  if (kind === 'string' || kind === 'string-num') raw = maxLen > 255 ? 'text' : `varchar(${maxLen <= 0 ? 1 : nextNice(maxLen)})`;
  if (kind === 'objectid') raw = 'objectId';
  const col = createColumn(name, raw);
  if (kind === 'objectid') col.category = 'reference';
  if (kind === 'string-num') col.meta = { leadingZeros: true };
  col.nullable = nulls > 0 || nonNull === 0;
  const top = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
  col.stats = {
    sampled: values.length,
    nulls,
    distinct: distinct.size > 1000 ? '1000+' : distinct.size,
    examples: top.slice(0, 3).map(([v]) => truncate(v, 60)),
    mixedTypes: kinds.length > 1 ? kinds : null,
  };
  if (nums.length) { col.stats.min = Math.min(...nums); col.stats.max = Math.max(...nums); }
  if (dates.length) { const sorted = dates.slice().sort(); col.stats.min = sorted[0]; col.stats.max = sorted[sorted.length - 1]; }
  if (kind === 'money') col.meta = { ...(col.meta || {}), moneyText: true };
  const allDistinct = nonNull > 1 && distinct.size === nonNull;
  const idLike = /(^|_|\b)(id|uuid|guid|key|code|sku|slug|email|number|no|ref|username|handle)$/i.test(name) || /Id$/.test(name) || kind === 'uuid' || kind === 'objectid';
  if (allDistinct && nulls === 0 && idLike) col.unique = true;
  else if (allDistinct && nonNull >= 20) col.meta = { ...(col.meta || {}), distinctInSample: true };
  // low-cardinality text -> categorical / enum-like (not for personal fields)
  if ((kind === 'string') && nonNull >= 20 && distinct.size > 0 && distinct.size <= Math.min(10, nonNull / 5) && !/name|email|city|street|address|phone|title|description|comment/i.test(name)) {
    col.enumValues = top.map(([v]) => v);
    col.meta = { ...(col.meta || {}), inferredEnum: true };
  }
  if (kind === 'string' && nonNull && [...distinct.keys()].every((x) => RE.email.test(x))) col.meta = { ...(col.meta || {}), format: 'email' };
  if (kind === 'string' && nonNull && [...distinct.keys()].every((x) => RE.url.test(x))) col.meta = { ...(col.meta || {}), format: 'url' };
  if (kind === 'string' && nonNull && maxLen <= 18 && [...distinct.keys()].every((x) => RE.sfId.test(x) && /\d/.test(x) && /[A-Za-z]/.test(x)) && /id$/i.test(name)) col.meta = { ...(col.meta || {}), format: 'salesforce-id' };
  return col;
}

function nextNice(n) {
  for (const s of [10, 20, 50, 100, 150, 255]) if (n <= s) return s;
  return n;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Build a table from rows (array of plain objects) or a header + rows matrix. */
export function inferTable(name, rows, headers = null, opts = {}) {
  const table = createTable(name, null, opts.kind || 'table');
  const cols = headers || [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const sample = rows.slice(0, opts.sampleSize || 5000);
  for (const h of cols) {
    const values = sample.map((r) => (r ? r[h] : null));
    const col = inferColumn(h, values);
    if (opts.presence) col.stats.presence = values.filter((v) => v !== undefined).length / Math.max(1, sample.length);
    table.columns.push(col);
  }
  table.rowCount = rows.length;
  table.meta.sampled = sample.length;
  table.meta.fromData = true;
  // primary key guess: id / <table>_id / <table>Id / _id that is unique and never null
  const tkey = normKey(name).replace(/s$/, '');
  const pk = table.columns.find((c) => c.unique && !c.nullable && ['id', '_id', `${tkey}id`, `${normKey(name)}id`].includes(normKey(c.name)));
  if (pk) { table.primaryKey = [pk.name]; table.meta.pkInferred = true; }
  finalizeTable(table);
  return table;
}
