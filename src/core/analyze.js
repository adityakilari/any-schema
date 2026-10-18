// Turns the canonical model into explanations: relationships, table roles, column explanations,
// findings (with fix SQL), a privacy scan and a narrative summary. Pure functions, no DOM.
import { words, rawWords, entityNoun, plural, singular, normKey, qualifiedName, findTable, findColumn } from './model.js';

// ------------------------------------------------------------------ helpers
const list = (arr, max = 4) => {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a.join('');
  const shown = a.slice(0, max);
  const more = a.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const article = (w) => (/^[aeiou]/i.test(w) && !/^(uni|eu|one|use|user)/i.test(w) ? 'an' : 'a');
const code = (s) => `\`${s}\``;

const AUDIT_NAMES = /^(created|updated|modified|deleted|inserted|changed|last ?modified|system ?modstamp|last ?viewed|last ?referenced|last ?activity)( ?(at|on|date|time|timestamp|by|by id|date time|stamp))?$|^(createdby(id)?|lastmodifiedby(id)?|createddate|lastmodifieddate|systemmodstamp|ts|row ?version|lock ?version|version)$/;

const AUDIT_RAW = /^(row|rec|record)_(ins_|upd_|crt_|lst_upd_)?(tmsp|ts|uid|usr|user|src_cd|src|dt|ver|version|id)$|^(ins|upd|crt|lst_upd|last_upd|create|created|update|updated|modify|modified|chg|change)_(tmsp|ts|dt|dttm|date|uid|usr|user|user_id|by|id|src_cd|pgm)$|^(dw|etl|load|audit)_/i;
function isAuditColumn(col) {
  if (AUDIT_RAW.test(col.name)) return true;
  const w = words(col.name);
  return AUDIT_NAMES.test(w) || AUDIT_NAMES.test(normKey(col.name)) || /^(created|updated|modified|deleted)_?(by|at|on|date)/i.test(col.name);
}

// ------------------------------------------------------------------ relationships
function buildTableIndex(schema) {
  const idx = new Map();
  const add = (k, t) => { if (k && !idx.has(k)) idx.set(k, t); };
  for (const t of schema.tables) {
    if (t.kind === 'embedded') continue;
    add(normKey(t.name), t);
    add(normKey(singular(t.name)), t);
    add(normKey(plural(t.name)), t);
    const stripped = t.name.replace(/^(tbl|tb|t|dim|fact|fct|stg|int|raw|app|sys)_/i, '');
    add(normKey(stripped), t);
    add(normKey(singular(stripped)), t);
  }
  return idx;
}

function compatible(a, b) {
  const g = (c) => ({ integer: 'num', decimal: 'num', float: 'num', uuid: 'str', string: 'str', text: 'str', reference: 'any', other: 'any', unknown: 'any' }[c] || c);
  const x = g(a.category); const y = g(b.category);
  return x === 'any' || y === 'any' || x === y;
}

// X_ID next to X_TYPE / X_TYPE_CD / X_TABLE: a generic pointer whose target table varies per row
export function polymorphicPartner(col, t) {
  const m = /^(.+?)[_]?(id|key)$/i.exec(col.name);
  if (!m || !m[1]) return null;
  const base = normKey(m[1]);
  return t.columns.find((c) => c !== col && [`${base}type`, `${base}typecd`, `${base}typecode`, `${base}table`, `${base}tbl`, `${base}entity`, `${base}class`, `${base}model`].includes(normKey(c.name))) || null;
}

const USER_TABLES = ['users', 'user', 'appusers', 'accounts', 'members', 'people', 'persons', 'employees', 'staff', 'admins'];
const SELF_NAMES = /^(parent|manager|supervisor|reports ?to|master|root|previous|next|replaced ?by|duplicate ?of|original|merged ?into|referrer|referred ?by|mentor)$/;
const PERSON_ROLE = /^(manager|supervisor|reports ?to|mentor|referrer|referred ?by|owner|author|creator|assignee|reviewer|approver|requester|reporter|user|created ?by|updated ?by|modified ?by)$/;
const PERSON_TABLES = ['employees', 'employee', 'users', 'user', 'appusers', 'staff', 'people', 'persons', 'members', 'accounts', 'admins'];

export function buildRelationships(schema) {
  const rels = [];
  const idx = buildTableIndex(schema);
  let n = 0;
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      const target = findTable(schema, fk.refTable, fk.refSchema);
      const refCols = fk.refColumns && fk.refColumns.length ? fk.refColumns : target ? target.primaryKey : [];
      const fromCols = fk.columns.map((c) => findColumn(t, c)).filter(Boolean);
      const nullable = fromCols.some((c) => c.nullable);
      let type = 'many-to-one';
      if (fk.embedded) type = fk.cardinality === 'many' ? 'embeds-many' : fk.cardinality === 'parent' ? 'embedded-in' : 'embeds-one';
      else {
        const set = fk.columns.map((c) => c.toLowerCase()).sort().join(',');
        const pk = t.primaryKey.map((c) => c.toLowerCase()).sort().join(',');
        const uniq = t.uniques.some((u) => u.map((c) => c.toLowerCase()).sort().join(',') === set);
        if ((set && set === pk) || uniq || (fromCols.length === 1 && fromCols[0].unique)) type = 'one-to-one';
      }
      rels.push({
        id: `r${++n}`,
        from: { table: qualifiedName(t), name: t.name, columns: fk.columns },
        to: { table: target ? qualifiedName(target) : fk.refTable, name: target ? target.name : fk.refTable, columns: refCols },
        type,
        source: fk.embedded ? 'embedded' : 'declared',
        confidence: 'declared',
        nullable,
        onDelete: fk.onDelete || null,
        constraint: fk.name || null,
        polymorphic: !!fk.polymorphic,
        masterDetail: !!fk.masterDetail,
        external: !target,
        self: !!target && target === t,
        system: fromCols.length === 1 && isAuditColumn(fromCols[0]),
        via: fk.via || null,
      });
    }
  }
  // inferred from naming
  const covered = new Set();
  for (const r of rels) for (const c of r.from.columns) covered.add(`${r.from.table}|${c.toLowerCase()}`);
  const pkNameIndex = new Map();
  for (const t of schema.tables) {
    if (t.primaryKey.length === 1 && !['id', '_id'].includes(t.primaryKey[0].toLowerCase()) && t.kind !== 'view') {
      const k = normKey(t.primaryKey[0]);
      if (!pkNameIndex.has(k)) pkNameIndex.set(k, t);
    }
  }
  for (const t of schema.tables) {
    if (t.kind === 'view' || t.kind === 'materialized view') continue;
    for (const col of t.columns) {
      if (covered.has(`${qualifiedName(t)}|${col.name.toLowerCase()}`)) continue;
      if (col.meta && col.meta.container) continue;
      if (col.category === 'array') {
        const am = /^(.+?)[_\s-]?(ids|uuids|keys|refs)$/i.exec(col.name);
        const hit = am && (idx.get(normKey(am[1])) || idx.get(normKey(plural(am[1]))));
        if (hit && hit.primaryKey.length === 1) {
          covered.add(`${qualifiedName(t)}|${col.name.toLowerCase()}`);
          rels.push({ id: `r${++n}`, from: { table: qualifiedName(t), name: t.name, columns: [col.name] }, to: { table: qualifiedName(hit), name: hit.name, columns: hit.primaryKey }, type: 'many-to-many', source: 'inferred', confidence: 'medium', reason: 'array of ids', nullable: col.nullable, onDelete: null, constraint: null, polymorphic: false, external: false, self: hit === t, system: false, arrayRef: true });
        }
        continue;
      }
      // NUMBER / TEXT ids (Oracle, Snowflake, dbt) are still keys
      if (['boolean', 'datetime', 'date', 'time', 'json', 'binary', 'float', 'decimal', 'enum', 'text'].includes(col.category) && !(['text', 'decimal'].includes(col.category) && /id$/i.test(col.name) && !/\(\s*\d+\s*,\s*[1-9]/.test(col.rawType))) continue;
      const isSolePk = t.primaryKey.length === 1 && t.primaryKey[0] === col.name;
      const poly = polymorphicPartner(col, t);
      if (poly) { col.meta = { ...(col.meta || {}), polymorphicWith: poly.name }; continue; }
      let target = null;
      let confidence = 'medium';
      let reason = '';
      // 1) same name as another table's distinctive PK (customer_id -> customers.customer_id)
      const byPk = pkNameIndex.get(normKey(col.name));
      if (byPk && byPk !== t) { target = byPk; confidence = 'high'; reason = `same name as the primary key of ${byPk.name}`; }
      // 2) <entity>_id / <entity>Id / <entity>_uuid
      if (!target) {
        const m = /^(.+?)[_\s-]?(id|uuid|guid|fk|key|ref)$/i.exec(col.name);
        if (m && normKey(m[1])) {
          const base = normKey(m[1].replace(/__c$/i, ''));
          const ws = words(m[1]);
          const wsRaw = rawWords(m[1]);
          let hit = idx.get(base) || idx.get(normKey(plural(m[1]))) || idx.get(normKey(singular(m[1])));
          if (hit) confidence = 'high';
          // role prefix: RSPBL_SM_ID -> SM (column suffix matches another table's key)
          if (!hit && /_/.test(col.name)) {
            const parts = col.name.split('_');
            for (let i = 1; i < parts.length - 1 && !hit; i++) {
              const suffix = parts.slice(i).join('_');
              const byKey = pkNameIndex.get(normKey(suffix));
              if (byKey && byKey !== t) { hit = byKey; confidence = 'medium'; reason = `role prefix ${parts.slice(0, i).join('_')}_`; }
              const byName = !hit && idx.get(normKey(parts.slice(i, -1).join('_')));
              if (byName && byName !== t && parts.length - 1 - i >= 1 && parts.slice(i, -1).join('').length >= 2) { hit = byName; confidence = 'medium'; }
            }
          }
          // last word only: billing_address_id -> addresses, primary_contact_id -> contacts
          if (!hit && wsRaw.includes(' ')) {
            const last = wsRaw.split(' ').pop();
            hit = idx.get(normKey(last)) || idx.get(normKey(plural(last))) || idx.get(normKey(ws.split(' ').pop())) || idx.get(normKey(plural(ws.split(' ').pop())));
            if (hit) confidence = 'medium';
          }
          if (!hit && PERSON_ROLE.test(ws)) {
            if (/^(manager|supervisor|reports ?to|mentor|referrer|referred ?by)$/.test(ws) && PERSON_TABLE.test(t.name)) hit = t;
            else for (const u of PERSON_TABLES) { if (idx.get(u)) { hit = idx.get(u); break; } }
            if (hit) confidence = 'medium';
          }
          if (!hit && SELF_NAMES.test(ws) && !PERSON_ROLE.test(ws)) { hit = t; confidence = 'medium'; }
          if (hit) { target = hit; reason = reason || `column name ${col.name}`; }
        }
      }
      // 3) created_by / updated_by without _id
      if (!target && /^[a-z]+ed_?by$/i.test(col.name) && ['integer', 'uuid', 'string', 'reference'].includes(col.category)) {
        for (const u of USER_TABLES) { if (idx.get(u)) { target = idx.get(u); confidence = 'medium'; reason = 'audit column naming'; break; } }
      }
      if (!target) continue;
      if (target === t && !SELF_NAMES.test(words(col.name.replace(/[_-]?(id|uuid|guid)$/i, '')))) continue;
      if (target === t && t.primaryKey.length > 1 && t.primaryKey.some((c) => c.toLowerCase() === col.name.toLowerCase())) continue;
      if (isSolePk && target === t) continue;
      const targetCols = target.primaryKey.length === 1 ? target.primaryKey : findColumn(target, 'id') ? [findColumn(target, 'id').name] : findColumn(target, col.name) ? [col.name] : [];
      if (!targetCols.length) continue;
      const tc = findColumn(target, targetCols[0]);
      if (tc && !compatible(col, tc)) continue;
      // in data CSVs only trust high confidence
      covered.add(`${qualifiedName(t)}|${col.name.toLowerCase()}`);
      rels.push({
        id: `r${++n}`,
        from: { table: qualifiedName(t), name: t.name, columns: [col.name] },
        to: { table: qualifiedName(target), name: target.name, columns: targetCols },
        type: isSolePk || col.unique ? 'one-to-one' : 'many-to-one',
        source: 'inferred',
        confidence,
        reason,
        nullable: col.nullable,
        onDelete: null,
        constraint: null,
        polymorphic: false,
        external: false,
        self: target === t,
        system: isAuditColumn(col),
      });
    }
  }
  return rels;
}

// ------------------------------------------------------------------ table roles
const LOOKUP_NAME = /(^|_|\s)(types?|status(es)?|categor(y|ies)|kinds?|countr(y|ies)|currenc(y|ies)|languages?|locales?|states?|regions?|units?|priorit(y|ies)|levels?|genders?|titles?|tags?|labels?|reasons?|codes?|lookups?|ref|reference|enum)$/i;
const LOG_NAME = /(^|_|\s)(logs?|audits?|audit ?trail|histor(y|ies)|events?|activit(y|ies)|journals?|trails?|changes?|changelogs?|versions?|snapshots?|tracking|outbox|webhooks? ?deliveries)$/i;
const TXN_NAME = /(order|invoice|payment|transaction|booking|reservation|shipment|purchase|sale|subscription|charge|refund|transfer|ticket|appointment|enrol?lment|opportunit|loan|claim|quote|contract|donation|deposit|withdrawal)/i;
const DETAIL_NAME = /(_|\s|^)(items?|lines?|line ?items?|details?|entries|rows?)$/i;
const CONFIG_NAME = /(setting|config|preference|option|feature ?flag|parameter|propert(y|ies)$)/i;
const NAMEISH = /^(name|title|label|code|description|display ?name|value|key|slug|abbreviation|iso ?code|symbol)$/;
const MONEY = /(amount|price|total|subtotal|cost|fee|balance|tax|discount|salary|wage|revenue|payment|paid|refund|charge|credit|debit|budget|value ?usd|amt|cents|amountcents|pricecents|lifetimevalue|ltv|arr|mrr)$/i;

function classifyTable(t, ctx) {
  const w = words(t.name);
  const outgoing = ctx.out.get(t) || [];
  const incoming = ctx.in.get(t) || [];
  const realOut = outgoing.filter((r) => !r.system && r.source !== 'embedded');
  if (t.kind === 'view' || t.kind === 'materialized view') return ['view', 'Defined as a query over other tables.'];
  if (t.kind === 'embedded') return ['embedded', 'Lives inside a parent document rather than in its own table.'];
  const fkCols = new Set(realOut.flatMap((r) => r.from.columns.map((c) => c.toLowerCase())));
  const payload = t.columns.filter((c) => !fkCols.has(c.name.toLowerCase()) && !isAuditColumn(c) && !(t.primaryKey.length === 1 && t.primaryKey[0] === c.name && /^(id|_id)$/i.test(c.name)) && !/^(id|_id|sort_?order|position)$/i.test(c.name));
  const targets = new Set(realOut.map((r) => r.to.table));
  const pkAllFk = t.primaryKey.length >= 2 && t.primaryKey.every((c) => fkCols.has(c.toLowerCase()));
  const nameishCols = t.columns.filter((c) => NAMEISH.test(words(c.name)) || /( name| title)$/.test(words(c.name)));
  const linkName = /(^|_|\s)(map|maps|mapping|link|links|xref|assignments?|memberships?|members|relations?|associations?)$/i.test(w) || [...targets].some((x) => w.includes(entityNoun(x.split('.').pop())));
  const lightPayload = payload.length <= 2 && !payload.some((c) => ['text', 'json'].includes(c.category) || /^(body|content|comment|notes?|description|amount|total|price)$/i.test(c.name));
  if (realOut.length >= 2 && lightPayload && (pkAllFk || (!LOG_NAME.test(w) && !nameishCols.length && linkName && t.columns.length <= 8))) return ['junction', `Mostly made of foreign keys (${list(realOut.map((r) => r.from.columns.join('+')))}).`];
  if (LOG_NAME.test(w)) return ['log', 'Name suggests a history/log of events.'];
  if (CONFIG_NAME.test(w) && !TXN_NAME.test(w)) return ['config', 'Name suggests settings or configuration.'];
  if (DETAIL_NAME.test(w) && realOut.length >= 1 && w.split(' ').length > 1) return ['detail', 'Name and foreign keys suggest line items of a parent record.'];
  const nameish = t.columns.filter((c) => NAMEISH.test(words(c.name))).length;
  const nonPk = t.columns.filter((c) => !t.primaryKey.includes(c.name) && !isAuditColumn(c));
  const allNameish = nonPk.length >= 1 && nonPk.every((c) => NAMEISH.test(words(c.name)) || /^(sort ?order|position|is ?active|active|color|icon)$/.test(words(c.name)));
  if (realOut.length === 0 && t.columns.length <= 6 && (LOOKUP_NAME.test(w) || (allNameish && incoming.length >= 1))) return ['lookup', 'Small table of named values that other tables point to.'];
  if (TXN_NAME.test(w)) return ['transaction', 'Name suggests a business transaction or event.'];
  const inc = incoming.filter((r) => !r.system && !r.self).length;
  if (inc >= 3 || (inc >= 2 && ctx.topIncoming.includes(t))) return ['core', `Referenced by ${inc} other tables.`];
  return ['entity', 'Stores records of a single kind.'];
}

export const ROLE_LABEL = {
  core: 'Core entity', entity: 'Entity', transaction: 'Transaction', detail: 'Line items', junction: 'Join table',
  lookup: 'Lookup', log: 'Log / history', config: 'Configuration', view: 'View', embedded: 'Embedded',
};

// ------------------------------------------------------------------ column explanations
const DEFAULT_TEXT = (d) => {
  if (d === null || d === undefined || d === '') return null;
  const s = String(d);
  if (/nextval|autoincrement\(\)|identity/i.test(s)) return 'an auto-incrementing number';
  if (/now\(\)|current_timestamp|getdate|sysdate|systimestamp|sysdatetime|getutcdate|localtimestamp|current_date|curdate/i.test(s)) return 'the current date/time';
  if (/uuid|newid|gen_random_uuid|sys_guid|newsequentialid|cuid|nanoid/i.test(s)) return 'a newly generated unique id';
  return code(s.replace(/::[\w ."]+(\[\])?/g, '').replace(/^\((.*)\)$/, '$1').replace(/^\((.*)\)$/, '$1').slice(0, 60));
};

function isBoolDefault(col, d) {
  if (col.category !== 'boolean') return d;
  if (/^`'?(0|false|f|n)'?`$/i.test(d)) return '`false`';
  if (/^`'?(1|true|t|y)'?`$/i.test(d)) return '`true`';
  return d;
}

const CATEGORY_TEXT = {
  integer: 'Whole number', decimal: 'Exact decimal number', float: 'Floating-point number', string: 'Text', text: 'Long text',
  boolean: 'Yes/no flag', date: 'Calendar date', datetime: 'Date and time', time: 'Time of day', uuid: 'UUID',
  json: 'Structured JSON data', array: 'List of values', binary: 'Binary data (file or bytes)', enum: 'One of a fixed set of values',
  reference: 'Reference to another record', other: 'Value', unknown: 'Value',
};

const IRREGULAR_PP = /^(paid|sent|built|sold|bought|made|read|won|lost|shut|set|put|cut|begun|done|seen|given|taken|written|chosen|spent|held|kept|left|met|drawn|shown|known|hidden|frozen|broken|stolen|signed in|logged in|checked in|checked out)$/;
const INTRANSITIVE = /^(occurred|happened|arrived|departed|expired|failed|succeeded|ended|started|began|finished|logged ?in|signed ?in|joined|left|visited|responded|replied|opened|clicked|bounced|churned)$/;
function verbPhrase(base) {
  // "shipped" -> "was shipped"; "expires" -> "expires"; "occurred" -> "occurred"
  const b = base.trim();
  if (!b) return null;
  if (/^last /.test(b)) return null;
  if (INTRANSITIVE.test(b)) return { intransitive: b };
  if (IRREGULAR_PP.test(b)) return `was ${b}`;
  if (/ed$/.test(b) && !/(need|seed|speed|feed|bed)$/.test(b)) return `was ${b}`;
  if (/(expires|starts|ends|begins|closes|opens|renews)$/.test(b)) return b;
  return null;
}

function explainColumn(col, t, ctx) {
  const noun = t.label ? t.label.toLowerCase() : entityNoun(t.name);
  const leaf = col.name.includes('.') ? col.name.split('.').pop() : col.name;
  const w = words(leaf);
  const k = normKey(leaf);
  const tags = [];
  const details = [];
  let main = null;
  const out = (ctx.out.get(t) || []).filter((r) => r.from.columns.some((c) => c.toLowerCase() === col.name.toLowerCase()));
  const isPk = t.primaryKey.some((c) => c.toLowerCase() === col.name.toLowerCase());
  const meta = col.meta || {};

  if (isPk) {
    tags.push('PK');
    if (t.primaryKey.length > 1) main = `Part of the composite primary key (${t.primaryKey.map(code).join(' + ')}): together these columns identify each ${noun} uniquely.`;
    else if (out.length && !out[0].embedded) main = `Primary key that is also a foreign key to ${code(out[0].to.name)}: each ${noun} shares its identifier with exactly one ${entityNoun(out[0].to.name)} (one-to-one).`;
    else if (col.name === '_id') main = `Document id: uniquely identifies each ${noun} in the collection${col.category === 'reference' || /objectid/i.test(col.rawType) ? ' (a MongoDB ObjectId, which also encodes the creation time)' : ''}.`;
    else if (ctx.dialect === 'salesforce') main = `Salesforce record Id: the 18-character id that uniquely identifies each ${noun}.`;
    else main = `Primary key: uniquely identifies each ${noun}.`;
    if (col.autoIncrement) details.push('Generated automatically by the database.');
    else if (col.category === 'uuid') details.push('A UUID, so ids can be created anywhere without asking the database.');
    if (t.meta && t.meta.pkInferred) details.push('Assumed primary key (unique, never empty), not declared in the source.');
  }

  const rels = out.filter((r) => !(isPk && t.primaryKey.length === 1 && r.type === 'one-to-one' && main && main.includes('shares')));
  if (rels.length) {
    const r = rels[0];
    const tn = r.to.name;
    const tnoun = entityNoun(tn);
    if (r.source === 'embedded') {
      tags.push('Embedded');
      if (!main) main = r.type === 'embeds-many' ? `List of embedded ${code(tn)} objects stored inside each ${noun}.` : `Embedded ${code(tn)} object stored inside each ${noun}.`;
    } else {
      tags.push(r.source === 'inferred' ? 'FK?' : 'FK');
      let s;
      if (r.arrayRef) s = `List of ${code(tn)} ids: each ${noun} can reference many ${plural(tnoun)} (a many-to-many relationship stored as an array).`;
      else if (r.polymorphic) s = `Polymorphic reference: points to ${list(rels.map((x) => code(x.to.name)), 6)}.`;
      else if (r.self) {
        const roleWord = w.replace(/ ?(id|uuid|guid|key|fk|ref)$/, '').trim();
        s = /^reports ?to$/.test(roleWord) ? `Points to the ${noun} this ${noun} reports to, which builds a reporting hierarchy.` : !roleWord || /^(parent|parent ?\w+)$/.test(roleWord)
          ? `Points to another ${noun} in the same table, which builds a hierarchy (for example parent and child ${plural(noun)}).`
          : `Points to another ${noun} ${PERSON_TABLE.test(t.name) ? 'who' : 'that'} is this ${noun}'s ${roleWord}, which builds a hierarchy.`;
      }
      else if (meta.relationshipName === 'Owner' || /^owner/i.test(col.name)) s = `The ${tnoun} who owns this ${noun}.`;
      else if (r.system) s = `The ${tnoun} who ${/created/i.test(col.name) ? 'created' : /deleted/i.test(col.name) ? 'deleted' : 'last changed'} this ${noun}.`;
      else if (r.type === 'one-to-one') s = `Links each ${noun} to exactly one ${tnoun} (one-to-one).`;
      else {
        const roleFull = w.replace(/ ?(id|uuid|guid|key|fk|ref|code|no|reference)$/, '').trim();
        const stripped = roleFull.endsWith(` ${tnoun}`) ? roleFull.slice(0, -tnoun.length - 1).trim() : roleFull;
        const personRole = /^(manager|supervisor|mentor|author|creator|assignee|reviewer|approver|requester|reporter|owner|referrer|sales ?rep|agent|instructor|teacher|doctor|coach|lead|responsible|attending|ordering|prescribing|primary|verified|uploaded|approval|verifying|uploader)$/.test(stripped) && (PERSON_TABLE.test(tn) || PERSON_TABLE.test(tnoun));
        const roleWord = personRole ? stripped : roleFull;
        const sameAsTarget = !roleWord || normKey(roleWord) === normKey(tnoun) || normKey(singular(roleWord)) === normKey(singular(tn)) || normKey(roleWord) === normKey(tn);
        if (sameAsTarget) s = `Links each ${noun} to the ${tnoun} it belongs to; one ${tnoun} can have many ${plural(noun)}.`;
        else if (personRole) s = `The ${tnoun} who is this ${noun}'s ${roleWord.replace(/^(verified|uploaded|approval)$/, (x) => ({ verified: 'verifier', uploaded: 'uploader', approval: 'approver' }[x]))} ${/^(attending|ordering|prescribing|primary|responsible)$/.test(roleWord) ? tnoun : ''}`.replace(/ +$/, '') + '.';
        else s = `Links each ${noun} to its ${roleWord} (${article(tnoun)} ${tnoun} record).`;
      }
      if (r.source === 'inferred') {
        main = main || `Probably references ${code(`${tn}.${r.to.columns.join(', ')}`)}. ${s}`;
        details.push('Inferred from the column name: no foreign-key constraint is declared.');
      } else {
        main = main || `Foreign key → ${code(`${tn}.${r.to.columns.join(', ')}`)}. ${s}`;
        if (r.masterDetail) details.push(`Master-detail: the ${tnoun} owns this record, and deleting it deletes this ${noun} too.`);
        else if (/cascade/i.test(r.onDelete || '')) details.push(`Deleting the ${tnoun} also deletes its ${plural(noun)}.`);
        else if (/set null/i.test(r.onDelete || '')) details.push(`If the ${tnoun} is deleted, this is cleared.`);
        else if (/restrict|no action/i.test(r.onDelete || '')) details.push(`${cap(article(tnoun))} ${tnoun} cannot be deleted while ${plural(noun)} still point to it.`);
      }
      if (!isPk && !r.self && !r.arrayRef && !r.system && !r.polymorphic) details.push(col.nullable ? `Optional: ${article(noun)} ${noun} can exist without ${article(tnoun)} ${tnoun}.` : `Required: every ${noun} must have ${article(tnoun)} ${tnoun}.`);
      if (!isPk && r.self) details.push(col.nullable ? `Empty for top-level ${plural(noun)}.` : 'Required.');
    }
  }

  if (!main && meta.polymorphicWith) {
    tags.push('Polymorphic');
    main = `Generic reference: together with ${code(meta.polymorphicWith)} it points at a different table depending on the row (a polymorphic link), so it cannot have a single foreign key.`;
  }
  // name-based meaning
  if (!main) main = byName(col, t, w, k, noun, tags, ctx);
  if (!main && col.name.includes('.')) {
    const segs = col.name.split('.');
    const parent = words(segs[segs.length - 2]);
    for (const alt of [`${w} ${parent}`, `${parent} ${w}`]) { main = byName(col, t, alt, normKey(alt), noun, tags, ctx); if (main) break; }
  }
  if (!main && col.label && words(col.label) !== w) main = byName(col, t, words(col.label.replace(/\(.*?\)/g, '')), normKey(col.label), noun, tags, ctx);
  if (!main && col.label && col.label.toLowerCase() !== w) main = `${cap(col.label)}.`;
  if (!main) {
    const ct = CATEGORY_TEXT[col.category] || 'Value';
    main = `${ct}${col.length && ['string', 'text'].includes(col.category) ? ` (up to ${col.length} characters)` : ''}${w && w !== noun ? `: the ${noun}'s ${w}` : ''}.`;
  }

  // details: constraints and facts
  if (!isPk && !rels.length) {
    if (!col.nullable) details.push('Required.');
    if (col.unique) { tags.push('UK'); details.push(`Unique: no two ${plural(noun)} can share the same value.`); }
  } else if (!isPk && col.unique && !tags.includes('UK')) tags.push('UK');
  if (col.autoIncrement && !isPk) { details.push('Auto-generated number.'); }
  if (col.autoIncrement) tags.push('Auto');
  const d = DEFAULT_TEXT(col.default);
  if (d && d !== '`NULL`' && !(isPk && col.autoIncrement) && !/auto-incrementing/.test(d)) details.push(`Defaults to ${isBoolDefault(col, d)}.`);
  if (col.enumValues && col.enumValues.length && !/one of:/i.test(main)) {
    tags.push('Enum');
    const ev = col.enumValues.slice(0, 8).map(code).join(', ');
    details.push(`${meta.inferredEnum ? 'Values seen' : 'Allowed values'}: ${ev}${col.enumValues.length > 8 ? ` (+${col.enumValues.length - 8} more)` : ''}.`);
  }
  if (col.computed) { tags.push('Computed'); details.push(`Computed from ${code(col.computed.slice(0, 80))}.`); }
  if (meta.formula || meta.calculated) { tags.push('Formula'); details.push('Formula field: calculated by Salesforce, read-only.'); }
  if (meta.externalId) { tags.push('External ID'); details.push('External ID: used to match records from other systems during upserts.'); }
  if (meta.updatedAt) details.push('Prisma updates this automatically on every write.');
  if (meta.leadingZeros) details.push('Contains leading zeros, so keep it as text (not a number).');
  if (meta.moneyText) details.push('Stored as text with a currency symbol; convert to a decimal for calculations.');
  if (col.indexed && !isPk && !col.unique) tags.push('Indexed');
  if (col.stats) {
    const st = col.stats;
    const bits = [];
    if (st.examples && st.examples.length && !(col.enumValues && col.enumValues.length)) bits.push(`e.g. ${st.examples.map(code).join(', ')}`);
    if (st.min !== undefined && st.max !== undefined && st.min !== st.max) bits.push(`range ${st.min} → ${st.max}`);
    if (st.sampled && st.nulls) bits.push(`${Math.round((st.nulls / st.sampled) * 100)}% empty`);
    if (st.presence !== undefined && st.presence < 1) bits.push(`present in ${Math.round(st.presence * 100)}% of records`);
    if (st.mixedTypes) bits.push(`mixed types: ${st.mixedTypes.join(', ')}`);
    if (meta.distinctInSample) bits.push('every sampled value is different');
    if (bits.length) details.push(`Sample: ${bits.join(' · ')}.`);
  }
  if (isAuditColumn(col)) tags.push('Audit');
  return { main, details, tags: [...new Set(tags)], documented: col.comment || null };
}

function byName(col, t, w, k, noun, tags, ctx) {
  const cat = col.category;
  const isTime = ['date', 'datetime', 'time'].includes(cat);
  const isBool = cat === 'boolean';
  if (col.meta && col.meta.container) return `Nested object; its sub-fields are listed below as ${code(col.name + '.*')}.`;
  if (col.meta && col.meta.childTable) return `List of embedded documents, described separately as ${code(col.meta.childTable)}.`;
  if (isBool && /(opt ?in|opted ?in|consent|subscribed|newsletter)/.test(w)) return `Consent flag: whether the ${noun} agreed to ${w.replace(/ ?(opt ?in|opted ?in|consent|subscribed)$/, '').replace(/^(has |is )/, '') || 'this'}.`;
  if (isBool && /^[a-z]+ed$/.test(w)) return `Yes/no flag: whether the ${noun} is ${w}.`;
  const ev = col.enumValues && col.enumValues.length ? ` One of: ${col.enumValues.slice(0, 8).map(code).join(', ')}${col.enumValues.length > 8 ? ` (+${col.enumValues.length - 8} more)` : ''}.` : '';
  if (/^(created|inserted|added)( ?(at|on|date|time|timestamp))?$|^createddate$|^date ?created$|^creation ?date$/.test(w) && (isTime || cat === 'integer' || cat === 'unknown')) return `When the ${noun} was created.`;
  if (/^(updated|modified|changed|last ?modified|last ?updated)( ?(at|on|date|time|timestamp))?$|^date ?modified$|^lastmodifieddate$/.test(w) && (isTime || cat === 'integer' || cat === 'unknown')) return `When the ${noun} was last changed.`;
  if (/^system ?modstamp$/.test(w)) return 'System timestamp: updated whenever the record changes, including changes made by automation.';
  if (/^(deleted|removed|archived)( ?(at|on|date))?$/.test(w) && isTime) { tags.push('Soft delete'); return `Soft-delete marker: when set, the ${noun} counts as deleted but the row is kept.`; }
  if (/^(is ?)?archived$/.test(w) && isBool) return `Archive flag: true means the ${noun} is archived (hidden from normal use but kept).`;
  if (/^(is ?)?(deleted|removed)$/.test(w) && isBool) { tags.push('Soft delete'); return `Soft-delete flag: true means the ${noun} counts as deleted, but the row is kept.`; }
  if (/^(created|updated|modified|deleted) ?by( ?id)?$/.test(w)) return `Who ${w.split(' ')[0]} this ${noun}.`;
  if (/^(row|record)( (inserted|updated|created|modified))? user( id)?$/.test(w)) return `User or process that ${/inserted|created/.test(w) ? 'created' : 'last changed'} this ${noun} record.`;
  if (/^(row|record)( (inserted|updated|created))? source( code)?$/.test(w)) return `System or process that ${/inserted|created/.test(w) ? 'created' : 'last wrote'} this ${noun} record.`;
  if (/^last ?(viewed|referenced) ?date$/.test(w)) return `When a user last ${w.includes('viewed') ? 'viewed' : 'referenced'} this ${noun}.`;
  if (/^(is|has|can|should|allow|allows|enable|enabled|needs|was|did|requires)\b/.test(w) && (isBool || cat === 'unknown' || cat === 'integer')) {
    const rest = w.replace(/^(is|has|can|should|allow|allows|enable|enabled|needs|was|did|requires) ?/, '');
    const verb = w.split(' ')[0];
    return `Yes/no flag: whether the ${noun} ${verb === 'enable' || verb === 'enabled' ? 'has' : verb} ${rest || 'this'}${verb === 'enable' || verb === 'enabled' ? ' enabled' : ''}.`;
  }
  if (isBool && /^(active|enabled|verified|confirmed|published|visible|approved|locked|paid|default|primary|featured|public|archived|completed|done)$/.test(w)) return `Yes/no flag: whether the ${noun} is ${w}.`;
  if (/(password|passwd|pwd)/.test(k)) {
    if (/(hash|digest|encrypted|crypt|bcrypt|salt)/.test(k)) return 'Password hash: a one-way hash of the password, never the password itself.';
    return 'Password field. Make sure only a strong hash (bcrypt, scrypt, argon2) is stored here, never the plain password.';
  }
  if (/(^| )salt$/.test(w)) return 'Random salt used when hashing a secret.';
  if (/(api ?key|secret|access ?token|refresh ?token|auth ?token|private ?key|client ?secret|webhook ?secret|otp|totp)/.test(w)) return 'Secret credential. Store it hashed or encrypted and keep it out of logs and exports.';
  if (/^(token|reset ?token|verification ?token|confirmation ?token|invite ?token)$/.test(w)) return 'One-time token (for example, for email verification or password reset). Treat it as a secret.';
  if (/e ?mail/.test(w) && !isBool && !isTime) return `Email address${col.unique ? ` of the ${noun}; unique, so it can be used to sign in or look the ${noun} up` : ''}.`;
  if (/(phone|mobile|cell|fax|telephone)/.test(w) && !isBool) return `${/fax/.test(w) ? 'Fax' : 'Phone'} number.`;
  if (/^(first|given) ?name$/.test(w)) return 'First (given) name.';
  if (/^(last|family|sur) ?name$|^surname$/.test(w)) return 'Last (family) name.';
  if (/^(middle) ?name$/.test(w)) return 'Middle name.';
  if (/^(full|display|legal|user) ?name$|^username$/.test(w)) return w.includes('user') ? `Username: the handle the ${noun} signs in with or is shown as.` : `${cap(w)} of the ${noun}.`;
  if (/^(name|title|label)$/.test(w) || [`${noun} name`, `${noun} title`, `${noun} label`].includes(w) || (normKey(w).endsWith('name') && normKey(w).replace(/name$/, '') === normKey(singular(t.name.replace(/^(tbl|dim|fct|stg)_/i, ''))))) return `Name of the ${noun}, as shown to people.`;
  if (/(date of birth|birth ?date|dob|birthday)/.test(w)) return 'Date of birth.';
  if (/^(description|desc|summary|details|notes?|remarks?|comments?|body|content|bio|about|message|text)$/.test(w)) return `Free-text ${w === 'body' || w === 'content' ? 'content' : 'description or notes'} for the ${noun}.`;
  if (/(^| )(status|state|stage|phase)$/.test(w) && !/^(state|province)$/.test(w) || (w === 'state' && (col.enumValues || /status|workflow/.test(normKey(t.name))))) return `Current ${w} of the ${noun}.${ev || (['string', 'text'].includes(cat) ? ` Stored as free text; listing the allowed values (${ctx.dialect === 'mongodb' ? 'a validator enum' : ctx.dialect === 'salesforce' ? 'a picklist' : 'an enum or check constraint'}) would prevent typos.` : '')}`;
  if (/(^| )(type|kind|category|class|classification|segment|tier|plan)$/.test(w) && !/(content|mime|media)/.test(w)) return `Classifies the ${noun} by ${w}.${ev}`;
  if (/^(priority|severity|level)$/.test(w)) return `${cap(w)} of the ${noun}.${ev}`;
  if (/^(isbn|ean|upc|gtin|isbn ?13|isbn ?10)$/.test(w)) return `${w.toUpperCase().replace(' ', '-')}: the standard barcode number that identifies this ${noun} worldwide.`;
  if (/^sku$/.test(w)) return 'Stock-keeping unit: the code that identifies a sellable product variant.';
  if ((/^(code|short ?code|ref|reference|number|no|num)$/.test(w) || w === `${noun} code` || w === `${noun} number` || w === `${noun} no`) && !/(phone|postal|zip|country|currency|language|area)/.test(w)) return `Business ${/number|no|num/.test(w) ? 'number' : 'code'} people use to refer to the ${noun}${col.unique ? ' (unique)' : ''}.`;
  if (/ (code|number|no)$/.test(w) && !/(phone|postal|zip|country|currency|language|area)/.test(w) && ['string', 'text', 'integer'].includes(cat)) return `${cap(w)}${col.nullable ? ' (optional)' : ''}.`;
  if (/^slug$/.test(w)) return `URL-friendly identifier for the ${noun}, usually derived from its name.`;
  if (/(^| )(url|uri|link|website|homepage|href)$/.test(w)) return /image|avatar|photo|logo|thumbnail|picture/.test(w) ? 'Link to an image file.' : 'Web address (URL).';
  if (/(avatar|photo|image|picture|logo|thumbnail)/.test(w)) return `Image for the ${noun} (or a reference to it).`;
  if (/^(uuid|guid|public ?id|external ?id|ext ?id)$/.test(w)) return w.includes('external') || w.includes('ext') ? `Identifier of this ${noun} in an external system.` : `Public unique identifier, safe to expose instead of the internal id.`;
  if (/(^| )currency( ?(code|iso))?$/.test(w)) return `${col.length === 3 ? 'Three-letter currency code (ISO 4217, for example USD or EUR)' : 'Currency (for example USD or EUR)'} used for the amounts on this ${noun}.`;
  if (MONEY.test(k) && ['decimal', 'float', 'integer'].includes(cat)) {
    tags.push('Money');
    const what = w;
    const store = cat === 'decimal' ? ' Stored as an exact decimal, which is right for money.' : cat === 'float' ? ' Stored as floating point, which can introduce rounding errors in money calculations.' : ' Stored as a whole number, probably in minor units (cents).';
    return `Monetary amount: ${what} of the ${noun}.${store}`;
  }
  if (/^(stock|inventory|on ?hand|in ?stock|stock ?level)$/.test(w) && ['integer', 'decimal'].includes(cat)) return `Units of this ${noun} currently in stock.`;
  if (/^(quantity|qty|units|count)$/.test(w)) return `How many units this ${noun} covers.`;
  if (/(^| )(quantity|qty)$/.test(w) && ['integer', 'decimal'].includes(cat)) return `${cap(w)}: a count of units.`;
  if (cat === 'integer' && /^[a-z]+s$/.test(w) && !/(status|address|class|access|process|bonus|alias|series)$/.test(w)) return `Number of ${w} for this ${noun}.`;
  if (/ count$/.test(w)) return `Number of ${plural(w.replace(/ count$/, ''))} for this ${noun} (often a cached counter).`;
  if (/^(percent|percentage|rate|ratio|pct)$|( percent| percentage| rate| pct)$/.test(w)) return `${cap(w)} value.`;
  if (/^(sort ?order|display ?order|position|rank|ordinal|sequence|seq|order ?index|sort)$/.test(w)) return `Ordering position used to sort ${plural(noun)}.`;
  if (/^(version|lock ?version|row ?version|revision|rev|etag|v)$/.test(w) || k === '__v') return k === '__v' ? 'Mongoose version key: increments when arrays in the document change.' : 'Version number for change tracking or optimistic locking.';
  if (/^(lat|latitude)$/.test(w)) return 'Latitude (north/south position).';
  if (/^(lng|lon|long|longitude)$/.test(w)) return 'Longitude (east/west position).';
  if (/(^| )(address|street|address ?line ?\d?|line ?\d)$/.test(w) && !/(ip|mac|email)/.test(w)) return `Street address${/billing|shipping|mailing|home|work/.test(w) ? ` (${w.split(' ')[0]})` : ''}.`;
  if (/^(city|town)$/.test(w)) return 'City.';
  if (/^(state|province|region|county)$/.test(w)) return 'State, province or region.';
  if (/^(country|country ?code|nation|country ?iso)$/.test(w)) return col.length === 2 ? 'Two-letter country code (ISO 3166, for example US or DE).' : col.length === 3 ? 'Three-letter country code (ISO 3166 alpha-3, for example USA).' : 'Country.';
  if (/(card ?last ?(4|four)|last ?(4|four)( digits)?)$/.test(w)) return 'Last four digits of the payment card: enough to show the customer which card was used, without storing the full number.';
  if (/(zip|postal|post ?code|postcode)/.test(w)) return 'Postal / ZIP code.';
  if (/(ip ?address|^ip$|remote ?addr)/.test(w)) return 'IP address of the client.';
  if (/user ?agent/.test(w)) return 'Browser or client identifier (user agent string).';
  if (/^(tenant|org|organization|organisation|workspace|company|account) ?id$/.test(w)) return 'Identifies which tenant or organization this row belongs to (multi-tenant data).';
  if (/^(gender|sex)$/.test(w)) return `Gender of the ${noun}.${ev}`;
  if (/(^| )(age)$/.test(w)) return 'Age in years.';
  if (/^(weight|height|width|length|depth|size|volume|duration|distance)$/.test(w) || /( weight| height| width| duration| distance)$/.test(w)) return `${cap(w)} of the ${noun}.`;
  if (/^(meta|metadata|data|payload|attributes|attrs|props|properties|extra|extras|settings|config|options|preferences|custom ?fields|context|details ?json)$/.test(w) || (cat === 'json' && !(col.meta && col.meta.container))) return cat === 'json' ? `Flexible ${w} stored as JSON; its keys can vary from row to row.` : `${cap(w)} for the ${noun}.`;
  if (col.meta && col.meta.container) return `Nested object with the sub-fields listed below it (${code(col.name + '.*')}).`;
  if (/^(locale|language|lang|timezone|time ?zone|tz)$/.test(w)) return `${/zone|tz/.test(w) ? 'Time zone' : 'Language / locale'} preference.`;
  if (/^(color|colour|hex)$/.test(w)) return 'Colour value.';
  if (/^(rating|score|stars)$/.test(w)) return `${cap(w)} given to the ${noun}.`;
  if (/^(start|end|begin|due|expiry|expiration|close|open|effective|valid ?from|valid ?to|valid ?until|from|to)( ?(at|on|date|time))?$/.test(w) && isTime) return `${cap(w.replace(/ ?(at|on|date|time)$/, '') || w)} ${cat === 'date' ? 'date' : cat === 'time' ? 'time' : 'date and time'} of the ${noun}.`;
  if (isTime) {
    const m = /^(.*?) ?(at|on|date|time|timestamp|ts|datetime)$/.exec(w);
    const base = m && m[1] ? m[1] : /ed$/.test(w) ? w : null;
    if (base) {
      if (/^last /.test(base)) {
        const rest = base.slice(5);
        if (/^(login|log in|logged in|sign ?in|signed in|seen|active|activity|visit|visited)$/.test(rest)) return `When the ${noun} was last ${/login|log|sign/.test(rest) ? 'signed in' : /visit/.test(rest) ? 'visited' : 'active'}.`;
        return /ed$/.test(rest) ? `When the ${noun} was last ${rest}.` : `Date and time of the most recent ${rest}.`;
      }
      const parts = base.split(' ');
      const last = parts[parts.length - 1];
      if (/^(row|record)$/.test(base)) return `When this ${noun} record was last written.`;
      if (/^(row|record) /.test(base) && /ed$/.test(last)) return `When this ${noun} record was ${last}.`;
      if (parts.length > 1 && /ed$/.test(last) && !INTRANSITIVE.test(base)) return `When the ${noun}'s ${parts.slice(0, -1).join(' ')} was ${last}.`;
      const vp = verbPhrase(base);
      if (vp && vp.intransitive) return `When it ${vp.intransitive}.`;
      if (vp) return `When the ${noun} ${vp}.`;
      if (normKey(base) === normKey(noun)) return `Date${cat === 'datetime' ? ' and time' : ''} of the ${noun}.`;
      return `Date${cat === 'datetime' ? ' and time' : ''} of ${base}.`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ privacy
const PII_RULES = [
  ['Government ID', 'high', /(ssn|social security|national ?id|nin\b|passport|driver ?s? ?licen[cs]e|tax ?id|^tin$|^sin$|aadhaar|pan ?number|ein\b|nhs ?number|voter ?id)/],
  ['Payment card', 'high', /(credit ?card|card ?number|cc ?number|cc ?num|^pan$|cvv|cvc|card ?expir)/],
  ['Bank account', 'high', /(iban|bank ?account|account ?number|routing ?number|sort ?code|swift|bic\b)/],
  ['Credential', 'high', /(password|passwd|pwd|secret|api ?key|access ?token|refresh ?token|auth ?token|private ?key|otp\b|totp|security ?answer)/],
  ['Health', 'high', /(diagnos|medical|health|blood|allerg|medication|prescription|disease|disabilit|insurance ?(id|number)|patient ?notes|symptom)/],
  ['Special category', 'high', /(race|ethnic|religio|sexual ?orient|political|union ?member|biometric|fingerprint|face ?id)/],
  ['Date of birth', 'medium', /(date of birth|birth ?date|dob\b|birthday)/],
  ['Contact', 'medium', /(e ?mail|phone|mobile|cell ?phone|fax|telephone|whatsapp)/],
  ['Address', 'medium', /(street|address ?line|^address$|billing ?address|shipping ?address|home ?address|mailing|postal|zip|post ?code|postcode)/],
  ['Person name', 'medium', /^(first|last|middle|full|given|family|maiden|legal|sur|nick) ?name$|^surname$/],
  ['Compensation', 'medium', /(salary|wage|income|compensation|bonus|pay ?rate|net ?worth)/],
  ['Location', 'medium', /^(lat|latitude|lng|lon|longitude|geo ?location|gps|coordinates)$/],
  ['Demographic', 'low', /^(gender|sex|age|nationality|marital ?status)$/],
  ['Online identifier', 'low', /(ip ?address|^ip$|user ?agent|device ?id|mac ?address|cookie|fingerprint ?id|advertising ?id)/],
];
const PERSON_TABLE = /(user|customer|client|employee|staff|contact|person|people|member|patient|student|lead|applicant|candidate|guest|subscriber|author|account ?holder|driver|traveler|traveller|passenger|volunteer|donor|tenant|provider|physician|doctor|nurse|clinician|producer|agent)/i;

function privacyFor(col, t) {
  if (['boolean'].includes(col.category) || (col.meta && col.meta.container)) return null;
  const segs = col.name.split('.');
  let w = words(segs[segs.length - 1]);
  if (segs.length > 1 && /^(first|last|middle|full|given|family)$/.test(w) && /name/i.test(segs[segs.length - 2])) w = `${w} name`;
  if (/(hash|digest|encrypted|masked|count|id$|_id$|type$|status$|verified|confirmed|opt ?in|consent)/.test(w) && !/^(national|tax|passport|device|advertising) ?id$/.test(w) && !/^(ssn|dob)/.test(w)) {
    if (!/password|secret|token/.test(w)) return null;
    if (/hash|digest|encrypted/.test(w)) return null;
  }
  if (['datetime', 'time'].includes(col.category) && !/birth|dob/.test(w)) return null;
  for (const [category, level, re] of PII_RULES) if (re.test(w)) return { category, level };
  if (/^(name|display ?name)$/.test(w) && PERSON_TABLE.test(t.name)) return { category: 'Person name', level: 'medium' };
  return null;
}

// ------------------------------------------------------------------ domain guess
const DOMAINS = [
  ['e-commerce', ['product', 'order', 'cart', 'customer', 'sku', 'inventory', 'shipment', 'coupon', 'checkout', 'review', 'variant', 'wishlist', 'store']],
  ['CRM', ['account', 'contact', 'lead', 'opportunity', 'campaign', 'case', 'deal', 'pipeline', 'activity', 'quote']],
  ['HR / people', ['employee', 'department', 'job', 'salary', 'payroll', 'leave', 'position', 'applicant', 'timesheet', 'location', 'region', 'country']],
  ['billing / finance', ['invoice', 'payment', 'ledger', 'transaction', 'subscription', 'plan', 'charge', 'refund', 'journal', 'price', 'tax']],
  ['blog / CMS', ['post', 'comment', 'tag', 'author', 'page', 'article', 'media', 'category', 'menu']],
  ['SaaS / identity', ['user', 'role', 'permission', 'session', 'organization', 'tenant', 'membership', 'team', 'invitation', 'workspace', 'apikey', 'project']],
  ['education', ['student', 'course', 'enrollment', 'enrolment', 'teacher', 'instructor', 'class', 'grade', 'lesson', 'school', 'assignment']],
  ['healthcare', ['patient', 'doctor', 'physician', 'appointment', 'prescription', 'diagnosis', 'visit', 'clinic', 'encounter']],
  ['library', ['book', 'author', 'loan', 'member', 'publisher', 'copy', 'borrow', 'isbn']],
  ['inventory / supply chain', ['warehouse', 'stock', 'supplier', 'vendor', 'purchaseorder', 'item', 'shipment', 'bin', 'receipt']],
  ['bookings / events', ['booking', 'reservation', 'event', 'ticket', 'venue', 'room', 'seat', 'guest']],
  ['project management', ['project', 'task', 'issue', 'sprint', 'milestone', 'board', 'label', 'epic']],
];

function guessDomain(schema) {
  const names = new Set(schema.tables.flatMap((t) => [normKey(singular(t.name.replace(/__c$/i, ''))), ...words(t.name).split(' ').map((x) => normKey(singular(x)))]));
  const scored = DOMAINS.map(([d, keys]) => [d, keys.filter((k) => names.has(k))]).filter(([, hits]) => hits.length >= 2).sort((a, b) => b[1].length - a[1].length);
  if (!scored.length) return null;
  return { name: scored[0][0], signals: scored[0][1], secondary: scored[1] && scored[1][1].length >= 3 ? scored[1][0] : null };
}

// ------------------------------------------------------------------ findings
const RESERVED = new Set(['user', 'order', 'group', 'select', 'table', 'where', 'from', 'check', 'default', 'desc', 'asc', 'limit', 'offset', 'column', 'index', 'key', 'primary', 'references', 'grant', 'session', 'end', 'case', 'when', 'to', 'by', 'in', 'is', 'as', 'on', 'or', 'and', 'not', 'null', 'all', 'any', 'between', 'distinct', 'having', 'join', 'union', 'into', 'values', 'range', 'rank', 'row', 'rows', 'level', 'size', 'comment', 'date', 'time', 'timestamp', 'uid', 'number', 'mode', 'file', 'type', 'value', 'year', 'month', 'day']);
const STRONG_RESERVED = new Set(['user', 'order', 'group', 'select', 'table', 'where', 'from', 'check', 'default', 'desc', 'asc', 'limit', 'offset', 'column', 'index', 'primary', 'references', 'grant', 'end', 'case', 'when', 'to', 'by', 'in', 'is', 'as', 'on', 'or', 'and', 'not', 'null', 'all', 'distinct', 'having', 'join', 'union', 'into', 'values', 'range', 'rank', 'rows', 'key', 'level', 'size', 'comment', 'uid', 'number', 'mode', 'session']);

function q(name, dialect) {
  const reserved = STRONG_RESERVED.has(String(name).toLowerCase());
  if (!reserved) {
    if (dialect === 'oracle' && /^[A-Z][A-Z0-9_$#]*$/.test(name)) return name;
    if (['sqlserver', 'mysql', 'sqlite'].includes(dialect) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
    if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  }
  if (dialect === 'mysql') return `\`${name}\``;
  if (dialect === 'sqlserver') return `[${name}]`;
  return `"${name}"`;
}
const qt = (t, d) => (t.schema ? `${q(t.schema, d)}.${q(t.name, d)}` : q(t.name, d));

function buildFindings(schema, ctx) {
  const F = [];
  const d = ctx.dialect;
  const sqlish = ['postgres', 'mysql', 'sqlserver', 'oracle', 'sqlite', 'snowflake', 'bigquery', 'ansi', null].includes(d) && !['salesforce', 'mongodb', 'openapi'].includes(d) && !/(^|\+)(json-data|jsonschema|json-tables|prisma|csv-data)(\+|$)/.test(schema.source.format);
  const add = (f) => F.push({ id: `f${F.length + 1}`, ...f });
  const isPrisma = schema.source.format === 'prisma';
  const sqlish2 = sqlish || isPrisma;
  const tzCols = [];
  const tables = schema.tables.filter((t) => !['view', 'materialized view', 'embedded'].includes(t.kind));
  for (const t of tables) {
    const noun = entityNoun(t.name);
    if (!t.primaryKey.length && t.columns.length && !(t.meta && t.meta.derived) && (sqlish || isPrisma) && schema.constraintsKnown !== false) {
      add({ severity: 'high', rule: 'no-primary-key', table: t.name, title: `${t.name} has no primary key`, detail: `Without a primary key, rows can be duplicated, updates and deletes are ambiguous, and many tools (ORMs, replication, CDC) will not work properly.`, fix: isPrisma ? `// add @id to a field, or @@id([a, b]) for a composite key` : `ALTER TABLE ${qt(t, d)} ADD PRIMARY KEY (<column>);` });
    }
    if (t.columns.length > 50) add({ severity: 'low', rule: 'wide-table', table: t.name, title: `${t.name} is very wide (${t.columns.length} columns)`, detail: 'Wide tables are often several concepts in one. Consider splitting rarely used or optional groups of columns into their own tables.' });
    for (const col of t.columns) {
      const w = words(col.name);
      if (MONEY.test(normKey(col.name)) && col.category === 'float' && sqlish2) {
        add({ severity: 'high', rule: 'money-as-float', table: t.name, column: col.name, title: `${t.name}.${col.name} stores money as floating point`, detail: `${col.rawType} cannot represent values like 0.10 exactly, so totals drift by fractions of a cent. Use an exact type.`, fix: isPrisma ? `${col.name} Decimal @db.Decimal(12, 2)` : alterType(t, col, d === 'oracle' ? 'NUMBER(12,2)' : 'DECIMAL(12,2)', d) });
      }
      if (/(^| )(password|passwd|pwd)$/.test(w) && !/(hash|digest|crypt)/.test(w) && ['string', 'text'].includes(col.category)) {
        add({ severity: 'high', rule: 'plaintext-password', table: t.name, column: col.name, title: `${t.name}.${col.name} may hold plain-text passwords`, detail: 'The name does not say it is a hash. Store only a slow, salted hash (bcrypt, scrypt or argon2) and consider renaming the column to password_hash so its contents are clear.' });
      }
      if (d === 'postgres' && (/^timestamp( ?\(\d\))?( without time zone)?$/i.test(col.rawType) || (isPrisma && /^DateTime( @db\.Timestamp(\(\d\))?)?$/.test(col.rawType)))) {
        tzCols.push([t, col]);
      }
      if (sqlish && ['string', 'text'].includes(col.category) && /^(meta|metadata|payload|attributes|properties|settings|config|options|extra|data|json|.*_json)$/i.test(col.name)) {
        add({ severity: 'info', rule: 'json-in-text', table: t.name, column: col.name, title: `${t.name}.${col.name} looks like JSON stored as text`, detail: 'A native JSON type validates the content and lets the database query inside it.', fix: d === 'postgres' ? alterType(t, col, 'jsonb', d) + ` -- add USING ${q(col.name, d)}::jsonb if needed` : null });
      }
      if (/^(status|state)$/.test(w) && ['string', 'text'].includes(col.category) && !col.enumValues && sqlish2) {
        add({ severity: 'info', rule: 'unconstrained-status', table: t.name, column: col.name, title: `${t.name}.${col.name} accepts any text`, detail: 'Status-like columns usually have a fixed set of values. A CHECK constraint, enum or lookup table prevents typos such as "Shipped" vs "shipped".', fix: isPrisma ? `enum ${t.name}${cap(col.name)} {\n  VALUE_1\n  VALUE_2\n}\n// then: ${col.name} ${t.name}${cap(col.name)}` : `ALTER TABLE ${qt(t, d)} ADD CONSTRAINT ${q(`${t.name}_${col.name}_check`, d)} CHECK (${q(col.name, d)} IN ('<value1>', '<value2>'));` });
      }
      if (col.stats && col.stats.mixedTypes && col.stats.mixedTypes.length > 1) {
        add({ severity: 'medium', rule: 'mixed-types', table: t.name, column: col.name, title: `${t.name}.${col.name} has mixed value types`, detail: `Values look like ${col.stats.mixedTypes.join(' and ')}. Clean the data before loading it into a typed column.` });
      }
      if (col.meta && col.meta.moneyText) add({ severity: 'medium', rule: 'money-as-text', table: t.name, column: col.name, title: `${t.name}.${col.name} stores amounts as text`, detail: 'Values include currency symbols, so they cannot be summed or compared numerically. Store a decimal amount and a separate currency code.' });
    }
  }
  if (tzCols.length) {
    const names = tzCols.map(([t, c]) => `${t.name}.${c.name}`);
    add({ severity: 'low', rule: 'timestamp-without-tz', column: null, title: `${tzCols.length} timestamp column${tzCols.length > 1 ? 's do' : ' does'} not store a time zone`, detail: `${list(names.map(code), 6)} ${tzCols.length > 1 ? 'are' : 'is'} \`timestamp without time zone\`. Values are ambiguous once servers or users span time zones; \`timestamptz\` stores an absolute instant.`, fix: isPrisma ? tzCols.map(([t, c]) => `// model ${t.name}\n${c.name} DateTime @db.Timestamptz(6)`).join('\n') : tzCols.map(([t, c]) => alterType(t, c, 'timestamptz', d)).join('\n') });
  }
  // relationships
  for (const r of ctx.rels) {
    const t = findTable(schema, r.from.name, r.from.table.includes('.') ? r.from.table.split('.')[0] : null);
    if (!t) continue;
    if (r.source === 'declared' && ctx.indexesKnown && d !== 'mysql' && !r.from.columns.every((c) => t.primaryKey[0] && t.primaryKey[0].toLowerCase() === c.toLowerCase())) {
      const first = findColumn(t, r.from.columns[0]);
      const covered = (first && first.indexed) || t.indexes.some((i) => i.columns[0] && i.columns[0].toLowerCase() === r.from.columns[0].toLowerCase()) || (t.primaryKey[0] || '').toLowerCase() === r.from.columns[0].toLowerCase();
      if (!covered) {
        add({ severity: 'medium', rule: 'unindexed-foreign-key', table: t.name, column: r.from.columns.join(', '), title: `Foreign key ${t.name}.${r.from.columns.join(', ')} has no index`, detail: `Joins from ${r.to.name} to ${t.name}, and deletes on ${r.to.name}, will scan the whole ${t.name} table. ${d === 'postgres' ? 'PostgreSQL' : d === 'oracle' ? 'Oracle' : d === 'sqlserver' ? 'SQL Server' : 'The database'} does not index foreign keys automatically.`, fix: isPrisma ? `// inside model ${t.name}\n@@index([${r.from.columns.join(', ')}])` : `CREATE INDEX ${q(`idx_${t.name}_${r.from.columns.join('_')}`.toLowerCase().slice(0, 60), d)} ON ${qt(t, d)} (${r.from.columns.map((c) => q(c, d)).join(', ')});` });
      }
    }
    if (r.source === 'inferred' && r.confidence === 'high' && sqlish && schema.source.format !== 'csv-data' && schema.constraintsKnown !== false) {
      add({ severity: 'medium', rule: 'missing-foreign-key', table: t.name, column: r.from.columns[0], title: `${t.name}.${r.from.columns[0]} looks like a foreign key but has no constraint`, detail: `Nothing stops it from pointing at a ${entityNoun(r.to.name)} that does not exist. Add a constraint after checking for orphan rows.`, fix: `ALTER TABLE ${qt(t, d)} ADD CONSTRAINT ${q(`fk_${t.name}_${r.from.columns[0]}`.toLowerCase().slice(0, 60), d)} FOREIGN KEY (${q(r.from.columns[0], d)}) REFERENCES ${r.to.table.split('.').map((x) => q(x, d)).join('.')} (${r.to.columns.map((c) => q(c, d)).join(', ')});` });
    }
  }
  // naming consistency (schema-wide)
  const cols = tables.flatMap((t) => t.columns.map((c) => c.name)).filter((n) => !/^_/.test(n) && /[a-z]/.test(n));
  if (ctx.dialect !== 'salesforce' && cols.length >= 10) {
    const snake = cols.filter((n) => /_/.test(n) && n === n.toLowerCase()).length;
    const camel = cols.filter((n) => /^[a-z]+[A-Z]/.test(n)).length;
    if (snake >= 3 && camel >= 3) {
      const minority = snake < camel ? 'snake_case' : 'camelCase';
      const examples = cols.filter((n) => (minority === 'snake_case' ? /_/.test(n) && n === n.toLowerCase() : /^[a-z]+[A-Z]/.test(n))).slice(0, 4);
      add({ severity: 'low', rule: 'mixed-naming', title: 'Column names mix snake_case and camelCase', detail: `${snake} snake_case vs ${camel} camelCase names (for example ${examples.map((e) => code(e)).join(', ')}). Pick one convention so names are predictable in queries.` });
    }
  }
  if (tables.length >= 4 && ctx.dialect !== 'salesforce') {
    const lastWord = (t) => words(t.name).split(' ').pop();
    const plurals = tables.filter((t) => { const lw = lastWord(t); return lw !== singular(lw); });
    const singulars = tables.filter((t) => { const lw = lastWord(t); return lw === singular(lw) && !/(data|info|media|staff|history|status|address|news|series)$/.test(lw); });
    if (plurals.length >= 2 && singulars.length >= 2) add({ severity: 'low', rule: 'mixed-plurality', title: 'Table names mix singular and plural', detail: `Plural: ${list(plurals.map((t) => code(t.name)))}. Singular: ${list(singulars.map((t) => code(t.name)))}. A single convention avoids guessing.` });
  }
  const reserved = tables.filter((t) => RESERVED.has(t.name.toLowerCase())).map((t) => t.name);
  const reservedCols = tables.flatMap((t) => t.columns.filter((c) => STRONG_RESERVED.has(c.name.toLowerCase())).map((c) => `${t.name}.${c.name}`));
  if ((reserved.length || reservedCols.length) && sqlish) add({ severity: 'low', rule: 'reserved-word', title: 'Some names are SQL reserved words', detail: `${list([...reserved, ...reservedCols].map(code), 6)} must be quoted in many databases and tools. Renaming (for example ${code('user')} → ${code('app_user')}) avoids subtle errors.` });
  // audit columns consistency
  const withCreated = tables.filter((t) => t.columns.some((c) => /^(created|inserted)_?(at|on|date)$|^createddate$/i.test(c.name)));
  if (ctx.dialect !== 'salesforce' && withCreated.length >= Math.max(2, tables.length * 0.4) && withCreated.length < tables.length) {
    const missing = tables.filter((t) => !withCreated.includes(t) && !['lookup', 'junction'].includes(ctx.roles.get(t)));
    if (missing.length) add({ severity: 'info', rule: 'missing-audit-columns', title: `${missing.length} table${missing.length > 1 ? 's do' : ' does'} not record when rows are created`, detail: `${withCreated.length} tables have a created timestamp, but ${list(missing.map((t) => code(t.name)), 6)} do not. Audit timestamps make debugging and data syncing much easier.` });
  }
  // isolated tables
  if (tables.length > 3) {
    const linked = new Set(ctx.rels.flatMap((r) => [r.from.table, r.to.table]));
    const isolated = tables.filter((t) => !linked.has(qualifiedName(t)) && !['lookup', 'log', 'config'].includes(ctx.roles.get(t)));
    if (isolated.length && isolated.length < tables.length) add({ severity: 'info', rule: 'isolated-tables', title: `${isolated.length} table${isolated.length > 1 ? 's are' : ' is'} not connected to anything`, detail: `${list(isolated.map((t) => code(t.name)), 6)} ${isolated.length > 1 ? 'have' : 'has'} no declared or inferred relationships. This is fine for staging or standalone tables; otherwise a foreign key may be missing.` });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return F.sort((a, b) => order[a.severity] - order[b.severity]);
}

function alterType(t, col, newType, d) {
  if (d === 'mysql') return `ALTER TABLE ${qt(t, d)} MODIFY ${q(col.name, d)} ${newType}${col.nullable ? '' : ' NOT NULL'};`;
  if (d === 'sqlserver') return `ALTER TABLE ${qt(t, d)} ALTER COLUMN ${q(col.name, d)} ${newType}${col.nullable ? '' : ' NOT NULL'};`;
  if (d === 'oracle') return `ALTER TABLE ${qt(t, d)} MODIFY (${q(col.name, d)} ${newType});`;
  if (d === 'sqlite') return null;
  return `ALTER TABLE ${qt(t, d)} ALTER COLUMN ${q(col.name, d)} TYPE ${newType};`;
}

// ------------------------------------------------------------------ table purpose
function purpose(t, role, ctx) {
  const noun = t.label ? t.label.toLowerCase() : entityNoun(t.name);
  const many = plural(noun);
  const out = (ctx.out.get(t) || []).filter((r) => !r.system && r.source !== 'embedded' && !r.self);
  const inc = (ctx.in.get(t) || []).filter((r) => !r.system && r.source !== 'embedded' && !r.self);
  const s = [];
  switch (role) {
    case 'junction': {
      const targets = [...new Set(out.map((r) => r.to.name))];
      if (targets.length >= 2) s.push(`Connects ${code(targets[0])} and ${code(targets[1])} in a many-to-many relationship: each row pairs one ${entityNoun(targets[0])} with one ${entityNoun(targets[1])}, so a ${entityNoun(targets[0])} can have many ${plural(entityNoun(targets[1]))} and the other way round.`);
      else if (targets.length === 1) s.push(`Links ${plural(entityNoun(targets[0]))} to each other (many-to-many within ${code(targets[0])}).`);
      break;
    }
    case 'lookup': s.push(`Reference list of ${many}: a small, mostly static set of values that other ${ctx.objWord}s point to instead of repeating the text.`); break;
    case 'log': s.push(`History table: each row records something that happened${out.length ? ` to ${list([...new Set(out.map((r) => entityNoun(r.to.name)))].map((x) => `${article(x)} ${x}`))}` : ''}. Rows are usually only ever added, not changed.`); break;
    case 'config': s.push(`Holds settings: each row is a ${noun} value that changes how the application behaves.`); break;
    case 'view': s.push(`A saved query${t.meta && t.meta.sources && t.meta.sources.length ? ` that reads from ${list(t.meta.sources.map(code), 5)}` : ''}. It stores no data of its own.`); break;
    case 'embedded': {
      const parent = (ctx.out.get(t) || []).find((r) => r.type === 'embedded-in');
      s.push(`Embedded documents stored inside each ${parent ? code(parent.to.name) : 'parent'} record${parent && parent.via ? ` under the ${code(parent.via)} field` : ''}.`);
      break;
    }
    case 'detail': {
      const parent = out[0];
      s.push(`The individual lines of ${parent ? `${article(entityNoun(parent.to.name))} ${entityNoun(parent.to.name)}` : 'a parent record'}: one row per ${noun}.`);
      break;
    }
    case 'transaction': s.push(`Records ${many}: each row is one ${noun}${t.primaryKey.length === 1 ? `, identified by ${code(t.primaryKey[0])}` : ''}.`); break;
    default: s.push(`Stores ${many}: one row per ${noun}${t.primaryKey.length === 1 ? `, identified by ${code(t.primaryKey[0])}` : t.primaryKey.length > 1 ? `, identified by the combination of ${t.primaryKey.map(code).join(' + ')}` : ''}.`);
  }
  if (!['junction', 'embedded', 'view'].includes(role)) {
    const req = out.filter((r) => !r.nullable && r.type !== 'one-to-one');
    const opt = out.filter((r) => r.nullable && r.type !== 'one-to-one');
    const one = out.filter((r) => r.type === 'one-to-one');
    const dedupe = (rs) => [...new Map(rs.map((r) => [r.to.name, r])).values()];
    const owned = req.filter((r) => /^owner/i.test(r.from.columns[0]));
    const reqOther = req.filter((r) => !owned.includes(r));
    if (reqOther.length) s.push(`Each ${noun} belongs to ${list(dedupe(reqOther).map((r) => `${article(entityNoun(r.to.name))} ${entityNoun(r.to.name)}`))}.`);
    if (owned.length) s.push(`Each ${noun} is owned by ${article(entityNoun(owned[0].to.name))} ${entityNoun(owned[0].to.name)}.`);
    if (opt.length) s.push(`It can optionally be linked to ${list(dedupe(opt).map((r) => `${article(entityNoun(r.to.name))} ${entityNoun(r.to.name)}`))}.`);
    if (one.length) s.push(`It extends ${list(dedupe(one).map((r) => code(r.to.name)))} one-to-one.`);
    const selfRefs = (ctx.out.get(t) || []).filter((r) => r.self && !r.system);
    if (selfRefs.length) s.push(`${cap(plural(noun))} can point to other ${plural(noun)} (via ${list(selfRefs.map((r) => code(r.from.columns.join(', '))))}), forming a hierarchy.`);
  }
  if (inc.length) {
    const names = [...new Set(inc.map((r) => r.from.name))];
    s.push(`${names.length === 1 ? 'Referenced by' : `Referenced by ${names.length} ${ctx.objWord}s:`} ${list(names.map(code), 6)}.`);
  }
  if (t.rowCount !== undefined && t.rowCount !== null) s.push(`${t.meta && t.meta.fromData ? 'Analysed from' : 'Contains about'} ${Number(t.rowCount).toLocaleString('en-US')} ${t.kind === 'collection' ? 'documents' : 'rows'}.`);
  return s.join(' ');
}

// ------------------------------------------------------------------ main
export function analyze(schema) {
  const rels = buildRelationships(schema);
  const out = new Map();
  const inn = new Map();
  for (const t of schema.tables) { out.set(t, []); inn.set(t, []); }
  const byQName = new Map(schema.tables.map((t) => [qualifiedName(t), t]));
  for (const r of rels) {
    const f = byQName.get(r.from.table);
    const to = byQName.get(r.to.table);
    if (f) out.get(f).push(r);
    if (to && r.source !== 'embedded') inn.get(to).push(r);
  }
  const incCount = (t) => inn.get(t).filter((r) => !r.self && !r.system).length;
  const topIncoming = [...schema.tables].sort((a, b) => incCount(b) - incCount(a)).slice(0, 3);
  const ctx = { out, in: inn, topIncoming, dialect: schema.source.dialect, indexesKnown: !!schema.indexesKnown, rels, objWord: schema.source.dialect === 'salesforce' ? 'object' : schema.source.dialect === 'mongodb' ? 'collection' : 'table' };
  // many-to-many via junctions
  const roles = new Map();
  for (const t of schema.tables) roles.set(t, classifyTable(t, ctx)[0]);
  ctx.roles = roles;
  const manyToMany = [];
  for (const t of schema.tables) {
    if (roles.get(t) !== 'junction') continue;
    const targets = [...new Map(out.get(t).filter((r) => !r.system && r.source !== 'embedded').map((r) => [r.to.table, r])).values()];
    if (targets.length >= 2) manyToMany.push({ id: `m${manyToMany.length + 1}`, a: targets[0].to.name, b: targets[1].to.name, via: t.name, type: 'many-to-many' });
  }
  const tables = schema.tables.map((t) => {
    const [role, roleReason] = classifyTable(t, ctx);
    const columns = t.columns.map((c) => {
      const ex = explainColumn(c, t, ctx);
      const p = privacyFor(c, t);
      if (p) ex.tags.push(`PII`);
      return { name: c.name, ...ex, privacy: p };
    });
    return {
      key: qualifiedName(t), name: t.name, role, roleLabel: ROLE_LABEL[role], roleReason,
      purpose: purpose(t, role, ctx), documented: t.comment || null,
      outgoing: out.get(t).map((r) => r.id), incoming: inn.get(t).map((r) => r.id),
      incomingCount: new Set(inn.get(t).filter((r) => !r.self && !r.system).map((r) => r.from.table)).size,
      degree: out.get(t).filter((r) => !r.system).length + inn.get(t).filter((r) => !r.system).length,
      columns,
    };
  });
  const findings = buildFindings(schema, ctx);
  const privacy = [];
  for (const t of tables) for (const c of t.columns) if (c.privacy) privacy.push({ table: t.name, column: c.name, ...c.privacy });
  const domain = guessDomain(schema);
  const stats = {
    tables: schema.tables.filter((t) => !['view', 'materialized view', 'embedded'].includes(t.kind)).length,
    views: schema.tables.filter((t) => ['view', 'materialized view'].includes(t.kind)).length,
    embedded: schema.tables.filter((t) => t.kind === 'embedded').length,
    columns: schema.tables.reduce((n, t) => n + t.columns.filter((c) => !(c.meta && c.meta.container)).length, 0),
    relationships: rels.filter((r) => !r.external).length,
    declared: rels.filter((r) => r.source === 'declared' && !r.external).length,
    inferred: rels.filter((r) => r.source === 'inferred').length,
    external: rels.filter((r) => r.external).length,
    manyToMany: manyToMany.length,
    enums: schema.enums.length,
  };
  return { stats, domain, tables, relationships: rels, manyToMany, findings, privacy, summary: summarize(schema, stats, domain, tables, findings, privacy) };
}

const FORMAT_LABEL = {
  sql: 'SQL DDL', prisma: 'Prisma schema', jsonschema: 'JSON Schema', openapi: 'OpenAPI', salesforce: 'Salesforce describe',
  'csv-metadata': 'metadata CSV', 'csv-data': 'data CSV', 'json-data': 'sample JSON data', 'json-tables': 'JSON table list', 'json-metadata': 'JSON column list',
};
const DIALECT_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', sqlserver: 'SQL Server', oracle: 'Oracle', sqlite: 'SQLite', snowflake: 'Snowflake', bigquery: 'BigQuery', salesforce: 'Salesforce', mongodb: 'MongoDB', ansi: 'generic SQL', openapi: 'OpenAPI' };

export function sourceLabel(schema) {
  const f = schema.source.format.split('+').map((x) => FORMAT_LABEL[x] || x).join(' + ');
  const d = schema.source.dialect ? schema.source.dialect.split('+').map((x) => DIALECT_LABEL[x] || x).join(' + ') : null;
  return d && !f.toLowerCase().includes(d.toLowerCase()) ? `${f} (${d})` : f;
}

function summarize(schema, stats, domain, tables, findings, privacy) {
  const parts = [];
  const obj = schema.source.dialect === 'salesforce' ? 'object' : schema.source.dialect === 'mongodb' ? 'collection' : 'table';
  parts.push(`This ${sourceLabel(schema)} describes ${stats.tables} ${obj}${stats.tables === 1 ? '' : 's'}${stats.views ? ` and ${stats.views} view${stats.views === 1 ? '' : 's'}` : ''} with ${stats.columns} ${schema.source.dialect === 'salesforce' ? 'fields' : 'columns'} in total.`);
  if (domain) parts.push(`It ${domain.signals.length >= 3 ? 'looks like' : 'may be'} ${article(domain.name)} ${domain.name} data model (based on ${list(domain.signals.map((s) => code(s)), 5)})${domain.secondary ? `, with some ${domain.secondary} elements` : ''}.`);
  const core = tables.filter((t) => !['view', 'embedded'].includes(t.role) && t.incomingCount >= 2).sort((a, b) => b.incomingCount - a.incomingCount).slice(0, 3);
  if (core.length) parts.push(`The central ${core.length === 1 ? obj : `${obj}s`} ${core.length === 1 ? 'is' : 'are'} ${list(core.map((t) => `${code(t.name)} (referenced by ${t.incomingCount} ${obj}s)`))}.`);
  if (stats.relationships) parts.push(`There ${stats.relationships === 1 ? 'is 1 relationship' : `are ${stats.relationships} relationships`}: ${stats.declared} declared${stats.inferred ? ` and ${stats.inferred} inferred from column names` : ''}${stats.manyToMany ? `, including ${stats.manyToMany} many-to-many via join tables` : ''}.`);
  else if (stats.tables > 1) parts.push('No relationships between tables were found.');
  if (stats.external) parts.push(`${stats.external} reference${stats.external === 1 ? ' points' : 's point'} to ${obj}s that are not in this file.`);
  const sev = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) sev[f.severity]++;
  if (findings.length) parts.push(`The review found ${sev.high} high, ${sev.medium} medium and ${sev.low} low priority issues${sev.info ? `, plus ${sev.info} suggestion${sev.info === 1 ? '' : 's'}` : ''}.`);
  else parts.push('The review found no issues.');
  if (privacy.length) {
    const high = privacy.filter((p) => p.level === 'high').length;
    parts.push(`${privacy.length} ${schema.source.dialect === 'salesforce' ? 'field' : 'column'}${privacy.length === 1 ? '' : 's'} look${privacy.length === 1 ? 's' : ''} like personal or sensitive data${high ? `, ${high} of them highly sensitive` : ''}.`);
  }
  return parts.join(' ');
}
