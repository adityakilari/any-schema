// Canonical schema model shared by every parser, the analyzer and the renderers.
//
// Schema   { source: {format, dialect, files[]}, tables: Table[], enums: Enum[], notes: string[] }
// Table    { name, schema, kind, comment, label, columns: Column[], primaryKey: string[],
//            uniques: string[][], indexes: Index[], foreignKeys: ForeignKey[], rowCount?, meta? }
// Column   { name, type, rawType, category, nullable, default, autoIncrement, unique,
//            comment, label, enumValues, length, indexed, stats? }
// ForeignKey { name, columns: string[], refSchema, refTable, refColumns: string[],
//              onDelete, onUpdate, polymorphic? }
// Index    { name, columns: string[], unique }

export function createSchema(format, dialect = null) {
  return { source: { format, dialect, files: [] }, tables: [], enums: [], notes: [] };
}

export function createTable(name, schema = null, kind = 'table') {
  return {
    name,
    schema: schema || null,
    kind,
    comment: null,
    label: null,
    columns: [],
    primaryKey: [],
    uniques: [],
    indexes: [],
    foreignKeys: [],
    meta: {},
  };
}

export function createColumn(name, rawType = '') {
  const raw = (rawType || '').trim();
  return {
    name,
    type: raw.toLowerCase(),
    rawType: raw,
    category: typeCategory(raw),
    nullable: true,
    default: null,
    autoIncrement: false,
    unique: false,
    comment: null,
    label: null,
    enumValues: null,
    length: extractLength(raw),
    indexed: null, // null = unknown, true/false = known
  };
}

export function setColumnType(col, rawType) {
  col.rawType = (rawType || '').trim();
  col.type = col.rawType.toLowerCase();
  col.category = typeCategory(col.rawType);
  col.length = extractLength(col.rawType);
}

function extractLength(raw) {
  const m = /\(\s*(\d+)\s*(?:,\s*\d+\s*)?\)/.exec(raw || '');
  return m ? Number(m[1]) : null;
}

// Broad, dialect-independent type families used for explanations and lint rules.
const CATEGORY_RULES = [
  ['uuid', /^(uuid|uniqueidentifier|guid)\b/],
  ['boolean', /^(bool|boolean|bit)\b(?!\s*\(\s*([2-9]|\d\d))|^checkbox$|^tinyint\s*\(\s*1\s*\)/],
  ['integer', /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|smallserial|bigserial|long|short|byte|int64|int32|number\s*\(\s*\d+\s*(,\s*0\s*)?\)|number\s*\(\s*\*\s*,\s*0\s*\)|pls_integer|binary_integer)(?![\w])|^autonumber$/],
  ['decimal', /^(decimal|numeric|number|money|smallmoney|dec|bignumeric|currency|percent)\b/],
  ['float', /^(float|real|double|float4|float8|double precision|binary_float|binary_double|float64)\b/],
  ['datetime', /^(timestamp|timestamptz|datetime|datetime2|datetimeoffset|smalldatetime|date-time)\b/],
  ['date', /^date\b/],
  ['time', /^(time|timetz|interval)\b/],
  ['json', /^(json|jsonb|variant|object|super|map|struct|record|hstore|xml|xmltype|address|location)\b/],
  ['array', /^(array|anyarray|set)\b|\[\]$/],
  ['binary', /^(bytea|blob|longblob|mediumblob|tinyblob|binary|varbinary|raw|long raw|image|bytes|base64)\b/],
  ['enum', /^(enum|picklist|multipicklist|combobox)\b/],
  ['reference', /^(reference|objectid|id|lookup|master-detail|masterdetail|hierarchy)\b/],
  ['text', /^(text|tinytext|mediumtext|longtext|clob|nclob|ntext|textarea|long|citext)\b/],
  ['string', /^(varchar|varchar2|nvarchar|nvarchar2|char|nchar|character|character varying|string|bpchar|email|phone|url|encryptedstring|name)\b/],
];

export function typeCategory(rawType) {
  const t = (rawType || '').toLowerCase().trim().replace(/^"|"$/g, '');
  if (!t) return 'unknown';
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  if (/char|text|string/.test(t)) return 'string';
  if (/int/.test(t)) return 'integer';
  if (/time/.test(t)) return 'datetime';
  return 'other';
}

// ---------- naming helpers ----------

// Common database abbreviations, expanded so explanations read naturally
// ("LIC_EXPR_DT" -> "license expiration date"). Edit to suit your naming standards.
export const ABBREVIATIONS = {
  acct: 'account', addr: 'address', adj: 'adjustment', agy: 'agency', amt: 'amount', appl: 'application', apprv: 'approval',
  assgn: 'assignment', asgn: 'assignment', attr: 'attribute', avg: 'average', bal: 'balance', bgn: 'begin', beg: 'begin',
  busn: 'business', cat: 'category', cd: 'code', cfg: 'configuration', chg: 'charge', clm: 'claim', cmnt: 'comment',
  cmpln: 'complaint', cmpny: 'company', cnt: 'count', cntry: 'country', ctry: 'country', cnty: 'county', conf: 'configuration',
  crt: 'created', curr: 'currency', cust: 'customer', dept: 'department', desc: 'description', dsc: 'description',
  dt: 'date', dtm: 'datetime', dttm: 'datetime', eff: 'effective', eml: 'email', emp: 'employee', empl: 'employee',
  err: 'error', exp: 'expiration', expr: 'expiration', fac: 'facility', flg: 'flag', fname: 'first name', freq: 'frequency',
  grp: 'group', hdr: 'header', hist: 'history', imp: 'import', ind: 'indicator', indv: 'individual', ins: 'inserted',
  intrfc: 'interface', inv: 'invoice', lic: 'license', lname: 'last name', ln: 'line', loc: 'location', lst: 'last',
  mgr: 'manager', mod: 'modified', msg: 'message', mth: 'month', nbr: 'number', nm: 'name', num: 'number', org: 'organization',
  orig: 'original', pct: 'percent', pgm: 'program', ph: 'phone', phn: 'phone', pmt: 'payment', pol: 'policy',
  prdcr: 'producer', pref: 'preference', prem: 'premium', prev: 'previous', proc: 'process', prog: 'program',
  prv: 'provider', pymt: 'payment', qty: 'quantity', rcvd: 'received', rcv: 'received', rec: 'record', ref: 'reference',
  reg: 'regulatory', req: 'request', rqst: 'request', rsn: 'reason', rspbl: 'responsible', sch: 'schedule', seq: 'sequence',
  src: 'source', stat: 'status', sts: 'status', svc: 'service', tmpl: 'template', tmsp: 'timestamp', tot: 'total',
  trx: 'transaction', txn: 'transaction', typ: 'type', uid: 'user id', upd: 'updated', usr: 'user', val: 'value',
  ver: 'version', viol: 'violation', vol: 'volume', wk: 'week', yr: 'year',
  sm: 'staff member', pat: 'patient', enc: 'encounter', dx: 'diagnosis', rx: 'prescription', appt: 'appointment',
  ord: 'order', rslt: 'result', attnd: 'attending', dschrg: 'discharge', prscrb: 'prescribing', spclty: 'specialty',
  vrfy: 'verified', abn: 'abnormal', upld: 'uploaded', evt: 'event', cncl: 'cancel', mthd: 'method', dur: 'duration',
  ctrl: 'controlled', subst: 'substance', mrn: 'medical record number', attch: 'attachment', doc: 'document',
  po: 'purchase order', mgmt: 'management', admin: 'administration', instr: 'instructor', stdnt: 'student',
  crs: 'course', enrl: 'enrollment', emplr: 'employer', pos: 'position', dtl: 'detail',
};
const AUDIT_NEXT = /^(tmsp|ts|dt|dttm|date|uid|usr|user|by|pgm|src)$/;

export function rawWords(name) {
  return String(name || '')
    .replace(/__c$|__r$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Lower-case words with abbreviations expanded: "LIC_EXPR_DT" -> "license expiration date". */
export function words(name) {
  const parts = rawWords(name).split(' ');
  return parts.map((w, i) => {
    // "ins" is "inserted" in ROW_INS_TMSP but "insurance" in PAT_INS
    if (w === 'ins') return AUDIT_NEXT.test(parts[i + 1] || '') ? 'inserted' : 'insurance';
    return ABBREVIATIONS[w] || w;
  }).join(' ');
}

export function humanize(name) {
  return words(name);
}

const IRREGULAR = { people: 'person', children: 'child', men: 'man', women: 'woman', data: 'data', media: 'media', criteria: 'criterion', statuses: 'status', addresses: 'address', analyses: 'analysis', indices: 'index', aliases: 'alias' };

export function singular(word) {
  const w = String(word || '');
  const lower = w.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  if (/(ss|us|is)$/.test(lower)) return w;
  if (/ies$/.test(lower) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes)$/.test(lower)) return w.slice(0, -2);
  if (/s$/.test(lower) && w.length > 2) return w.slice(0, -1);
  return w;
}

export function plural(word) {
  const w = String(word || '');
  const lower = w.toLowerCase();
  if (/(data|media|staff|info|metadata|equipment|news|series|feedback|inventory)$/.test(lower)) return w;
  if (/(^| )(status|address|analysis)$/.test(lower)) return lower.endsWith('is') ? w.slice(0, -2) + 'es' : w + 'es';
  if (lower === 'person') return 'people';
  if (lower === 'child') return 'children';
  if (/(s|x|z|ch|sh)$/.test(lower)) return w + 'es';
  if (/[^aeiou]y$/.test(lower)) return w.slice(0, -1) + 'ies';
  return w + 's';
}

/** "order_items" -> "order item" */
export function entityNoun(tableName) {
  if (String(tableName).includes('.')) return String(tableName).split('.').map((seg) => entityNoun(seg)).join(' ');
  const parts = words(tableName).split(' ').filter(Boolean);
  if (!parts.length) return tableName;
  const generic = /^(tbl|t|tb|dim|fact|fct|stg|int|raw|v|vw|view|mv)$/;
  while (parts.length > 1 && generic.test(parts[0])) parts.shift();
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts.join(' ');
}

export function normKey(s) {
  return String(s || '').replace(/__[cr]$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function qualifiedName(t) {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

export function findTable(schema, name, schemaName = null) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const s = schemaName ? String(schemaName).toLowerCase() : null;
  let hit = schema.tables.find((t) => t.name.toLowerCase() === n && (!s || (t.schema || '').toLowerCase() === s));
  if (!hit) hit = schema.tables.find((t) => t.name.toLowerCase() === n);
  return hit || null;
}

export function findColumn(table, name) {
  if (!table || !name) return null;
  const n = String(name).toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === n) || null;
}

/** Make the model internally consistent after parsing (flags, PK nullability, uniques). */
export function finalizeTable(table) {
  const pk = new Set(table.primaryKey.map((c) => c.toLowerCase()));
  for (const col of table.columns) {
    if (pk.has(col.name.toLowerCase())) {
      col.nullable = false;
      if (table.primaryKey.length === 1) col.unique = true;
    }
  }
  for (const u of table.uniques) {
    if (u.length === 1) {
      const c = findColumn(table, u[0]);
      if (c) c.unique = true;
    }
  }
  for (const idx of table.indexes) {
    // expression index such as lower(email): attribute it to the column it wraps
    let first = findColumn(table, idx.columns[0]);
    if (!first && idx.columns[0]) {
      const ids = (idx.columns[0].match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((x) => findColumn(table, x)).filter(Boolean);
      if (ids.length === 1) first = ids[0];
    }
    if (first) first.indexed = true;
    if (idx.unique && idx.columns.length === 1 && first) first.unique = true;
  }
  if (table.primaryKey.length) {
    const first = findColumn(table, table.primaryKey[0]);
    if (first) first.indexed = true;
  }
  return table;
}

/** Merge several parsed schemas (multi-file upload) into one, keeping table names unique. */
export function mergeSchemas(list) {
  if (list.length === 1) return list[0];
  const out = createSchema(
    [...new Set(list.map((s) => s.source.format))].join('+'),
    [...new Set(list.map((s) => s.source.dialect).filter(Boolean))].join('+') || null,
  );
  const seen = new Set();
  for (const s of list) {
    out.source.files.push(...s.source.files);
    out.notes.push(...s.notes);
    out.enums.push(...s.enums);
    for (const t of s.tables) {
      let key = qualifiedName(t).toLowerCase();
      if (seen.has(key)) {
        let i = 2;
        while (seen.has(`${key}_${i}`)) i++;
        t.name = `${t.name}_${i}`;
        key = qualifiedName(t).toLowerCase();
      }
      seen.add(key);
      out.tables.push(t);
    }
  }
  out.indexesKnown = list.every((s) => s.indexesKnown);
  return out;
}
