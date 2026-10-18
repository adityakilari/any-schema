// JSON parser. Recognises, in this order:
//   - an Any Schema export (round-trip)
//   - Salesforce describe results (sf sobject describe --json, the export script's merged array, REST /describe)
//   - OpenAPI / Swagger documents (components.schemas or definitions)
//   - JSON Schema (single schema, $defs / definitions bundles, MongoDB $jsonSchema validators with bsonType)
//   - plain sample data (array of records, or { tableName: [records] })
import { createSchema, createTable, createColumn, setColumnType, finalizeTable } from '../model.js';
import { inferTable } from '../infer.js';
import { isMetadataHeader, parseMetadataObjects } from './csv.js';

export function sniffJsonKind(doc) {
  if (!doc || typeof doc !== 'object') return 'unknown';
  if (doc.anySchemaVersion && doc.schema) return 'any-schema';
  const sfList = salesforceObjects(doc);
  if (sfList) return 'salesforce';
  if (doc.openapi || doc.swagger) return 'openapi';
  if (metadataRows(doc)) return 'metadata-rows';
  if (tableDefinitions(doc)) return 'tables';
  if (!Array.isArray(doc) && (doc.$schema || doc.$defs || doc.definitions || doc.properties || doc.bsonType || doc.type === 'object' || doc['x-any-schema'])) return 'jsonschema';
  return 'data';
}

// ------------------------------------------------------------------ Salesforce
function isDescribe(o) {
  return o && typeof o === 'object' && typeof o.name === 'string' && Array.isArray(o.fields) && o.fields.length > 0 &&
    o.fields.every((f) => f && typeof f.name === 'string' && typeof f.type === 'string') && o.fields.some((f) => 'nillable' in f || 'soapType' in f || 'referenceTo' in f);
}

function salesforceObjects(doc) {
  const unwrap = (o) => (o && o.result && !Array.isArray(o.result) ? o.result : o);
  if (Array.isArray(doc)) {
    const list = doc.map(unwrap);
    return list.length && list.every(isDescribe) ? list : null;
  }
  if (doc.result && Array.isArray(doc.result) && doc.result.every(isDescribe)) return doc.result;
  if (doc.objects && Array.isArray(doc.objects) && doc.objects.every(isDescribe)) return doc.objects;
  const one = unwrap(doc);
  return isDescribe(one) ? [one] : null;
}

const SF_TYPES = {
  id: 'string', reference: 'reference', string: 'string', textarea: 'text', email: 'string', phone: 'string', url: 'string',
  encryptedstring: 'string', boolean: 'boolean', int: 'integer', long: 'integer', double: 'decimal', currency: 'decimal', percent: 'decimal',
  date: 'date', datetime: 'datetime', time: 'time', picklist: 'enum', multipicklist: 'enum', combobox: 'enum', address: 'json', location: 'json',
  base64: 'binary', anytype: 'other', complexvalue: 'json', json: 'json',
};

function parseSalesforce(objects, fileName) {
  const schema = createSchema('salesforce', 'salesforce');
  schema.source.files.push(fileName);
  schema.indexesKnown = false;
  for (const o of objects) {
    const t = createTable(o.name, null, 'object');
    t.label = o.label || null;
    t.meta = { custom: !!o.custom, keyPrefix: o.keyPrefix || null, labelPlural: o.labelPlural || null, queryable: o.queryable, childRelationships: (o.childRelationships || []).length };
    if (o.custom) t.comment = `Custom object${o.labelPlural ? ` (${o.labelPlural})` : ''}.`;
    for (const f of o.fields) {
      const type = String(f.type).toLowerCase();
      let raw = type;
      if (['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring'].includes(type) && f.length) raw = `${type}(${f.length})`;
      if (['double', 'currency', 'percent'].includes(type) && f.precision) raw = `${type}(${f.precision},${f.scale || 0})`;
      if (f.calculated && f.calculatedFormula) raw = `formula ${raw}`;
      const col = createColumn(f.name, raw);
      col.category = SF_TYPES[type] || col.category;
      col.label = f.label || null;
      col.nullable = f.nillable !== false;
      col.unique = !!f.unique;
      col.autoIncrement = !!f.autoNumber;
      col.default = f.defaultValueFormula || (f.defaultValue !== undefined && f.defaultValue !== null ? String(f.defaultValue) : null);
      col.comment = f.inlineHelpText || null;
      col.length = f.length || null;
      if (Array.isArray(f.picklistValues) && f.picklistValues.length) col.enumValues = f.picklistValues.filter((p) => p.active !== false).map((p) => p.value).slice(0, 100);
      col.meta = {
        custom: !!f.custom, externalId: !!f.externalId, calculated: !!f.calculated, formula: f.calculatedFormula || null,
        relationshipName: f.relationshipName || null, idLookup: !!f.idLookup, nameField: !!f.nameField,
      };
      if (f.externalId || f.idLookup) col.indexed = true;
      if (type === 'id') t.primaryKey = [f.name];
      if (type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length) {
        for (const target of f.referenceTo) {
          t.foreignKeys.push({
            name: f.relationshipName || null, columns: [f.name], refSchema: null, refTable: target, refColumns: ['Id'],
            onDelete: f.cascadeDelete ? 'CASCADE' : f.restrictedDelete ? 'RESTRICT' : null, onUpdate: null,
            polymorphic: f.referenceTo.length > 1, masterDetail: !!f.cascadeDelete || (f.relationshipOrder !== undefined && f.relationshipOrder !== null),
          });
        }
      }
      t.columns.push(col);
    }
    finalizeTable(t);
    schema.tables.push(t);
  }
  return schema;
}

// ------------------------------------------------------------------ JSON Schema / OpenAPI / Mongo
const BSON = {
  objectId: ['objectId', 'reference'], string: ['string', 'string'], int: ['int', 'integer'], long: ['long', 'integer'], double: ['double', 'float'],
  decimal: ['decimal128', 'decimal'], bool: ['bool', 'boolean'], date: ['date', 'datetime'], timestamp: ['timestamp', 'datetime'],
  object: ['object', 'json'], array: ['array', 'array'], binData: ['binData', 'binary'], null: ['null', 'unknown'], number: ['number', 'decimal'],
};

function resolveRef(ref) {
  // "#/$defs/Customer" | "#/components/schemas/Customer" | "#/definitions/Customer" | "customer.json"
  if (!ref) return null;
  const last = ref.split('/').pop();
  return decodeURIComponent(last.replace(/\.json$/, '').replace(/~1/g, '/').replace(/~0/g, '~'));
}

function schemaType(p) {
  // returns { raw, category, nullable }
  let nullable = p.nullable === true;
  let types = p.type !== undefined ? p.type : p.bsonType;
  if (Array.isArray(types)) { nullable = nullable || types.includes('null'); types = types.filter((x) => x !== 'null'); types = types.length === 1 ? types[0] : types; }
  if (p.bsonType !== undefined && !p.type) {
    const list = Array.isArray(types) ? types : [types];
    const b = BSON[list[0]] || [list[0], 'other'];
    return { raw: list.length > 1 ? list.join('|') : b[0], category: b[1], nullable };
  }
  if (Array.isArray(types)) return { raw: types.join('|'), category: 'other', nullable };
  const fmt = p.format;
  if (types === 'string') {
    if (fmt === 'date-time') return { raw: 'string (date-time)', category: 'datetime', nullable };
    if (fmt === 'date') return { raw: 'string (date)', category: 'date', nullable };
    if (fmt === 'time') return { raw: 'string (time)', category: 'time', nullable };
    if (fmt === 'uuid') return { raw: 'string (uuid)', category: 'uuid', nullable };
    if (fmt === 'byte' || fmt === 'binary') return { raw: `string (${fmt})`, category: 'binary', nullable };
    if (fmt === 'decimal') return { raw: 'string (decimal)', category: 'decimal', nullable };
    if (p.enum) return { raw: 'string (enum)', category: 'enum', nullable };
    const len = p.maxLength ? `(${p.maxLength})` : '';
    return { raw: `string${len}${fmt ? ` (${fmt})` : ''}`, category: 'string', nullable };
  }
  if (types === 'integer') return { raw: fmt ? `integer (${fmt})` : 'integer', category: 'integer', nullable };
  if (types === 'number') return { raw: fmt ? `number (${fmt})` : 'number', category: fmt === 'float' || fmt === 'double' ? 'float' : 'decimal', nullable };
  if (types === 'boolean') return { raw: 'boolean', category: 'boolean', nullable };
  if (types === 'object') return { raw: 'object', category: 'json', nullable };
  if (types === 'array') return { raw: 'array', category: 'array', nullable };
  if (p.enum) return { raw: 'enum', category: 'enum', nullable };
  return { raw: types || 'any', category: types ? 'other' : 'unknown', nullable };
}

function mergeAllOf(p, defs) {
  if (!p || !Array.isArray(p.allOf)) return p;
  const out = { ...p, properties: { ...(p.properties || {}) }, required: [...(p.required || [])] };
  delete out.allOf;
  for (const part of p.allOf) {
    const target = part.$ref ? defs[resolveRef(part.$ref)] : part;
    if (!target) continue;
    const merged = mergeAllOf(target, defs);
    Object.assign(out.properties, merged.properties || {});
    out.required.push(...(merged.required || []));
    if (!out.type && merged.type) out.type = merged.type;
  }
  return out;
}

function parseJsonSchemaDoc(doc, fileName, kind) {
  const schema = createSchema(kind, kind === 'openapi' ? 'openapi' : null);
  schema.source.files.push(fileName);
  schema.indexesKnown = false;
  let defs = {};
  if (kind === 'openapi') defs = (doc.components && doc.components.schemas) || doc.definitions || {};
  else defs = { ...(doc.definitions || {}), ...(doc.$defs || {}) };
  const isMongo = JSON.stringify(doc).includes('"bsonType"');
  if (isMongo) schema.source.dialect = 'mongodb';
  const roots = [];
  for (const [name, def] of Object.entries(defs)) roots.push([name, def]);
  if (kind === 'jsonschema' && (doc.properties || doc.allOf)) roots.unshift([doc.title || fileName.replace(/\.[^.]+$/, '').replace(/\.schema$/, '') || 'root', doc]);
  const defNames = new Set(Object.keys(defs));
  for (const [name, rawDef] of roots) {
    const def = mergeAllOf(rawDef, defs);
    if (!def || (!def.properties && def.type !== 'object' && !def.bsonType)) {
      if (def && def.enum) schema.enums.push({ name, values: def.enum.map(String), comment: def.description || null });
      continue;
    }
    const isCollection = !!def['x-collection'] || (isMongo && !!(def.properties && def.properties._id));
    const table = createTable(name, null, isCollection ? 'collection' : kind === 'openapi' ? 'model' : 'object');
    table.comment = def.description || null;
    table.label = def.title && def.title !== name ? def.title : null;
    if (def['x-document-count'] !== undefined) table.rowCount = def['x-document-count'];
    if (def['x-sampled'] !== undefined) table.meta.sampled = def['x-sampled'];
    addProperties(schema, table, def, '', defNames, defs, 0);
    for (const ix of def['x-indexes'] || []) {
      const cols = Object.keys(ix.key || {});
      if (!cols.length || (cols.length === 1 && cols[0] === '_id')) continue;
      table.indexes.push({ name: ix.name || null, columns: cols, unique: !!ix.unique });
      if (ix.unique) table.uniques.push(cols);
    }
    const pk = table.columns.find((c) => c.name === '_id') || table.columns.find((c) => c.name.toLowerCase() === 'id');
    if (def['x-primary-key']) table.primaryKey = [].concat(def['x-primary-key']);
    else if (pk) { table.primaryKey = [pk.name]; table.meta.pkInferred = pk.name !== '_id'; }
    finalizeTable(table);
    schema.tables.push(table);
  }
  if (!schema.tables.length) schema.notes.push('No object schemas with properties were found.');
  return schema;
}

function addProperties(schema, table, def, prefix, defNames, defs, depth) {
  const required = new Set(def.required || []);
  for (const [pname, rawP] of Object.entries(def.properties || {})) {
    const p = mergeAllOf(rawP || {}, defs);
    const path = prefix ? `${prefix}.${pname}` : pname;
    const ref = p.$ref ? resolveRef(p.$ref) : null;
    const itemRef = p.items && p.items.$ref ? resolveRef(p.items.$ref) : null;
    const oneRef = (p.oneOf || p.anyOf || []).map((x) => x.$ref && resolveRef(x.$ref)).filter(Boolean);
    let col;
    if (ref || oneRef.length) {
      const targets = ref ? [ref] : oneRef;
      const target = defs[targets[0]] || {};
      if (target.enum) {
        col = createColumn(path, `enum ${targets[0]}`);
        col.category = 'enum';
        col.enumValues = target.enum.map(String);
      } else {
        col = createColumn(path, `object (${targets.join(' | ')})`);
        col.category = 'json';
        for (const tg of targets) if (defNames.has(tg)) table.foreignKeys.push({ name: null, columns: [path], refSchema: null, refTable: tg, refColumns: [], embedded: true, cardinality: 'one', polymorphic: targets.length > 1 });
      }
      col.nullable = !required.has(pname) || p.nullable === true || (p.oneOf || p.anyOf || []).some((x) => x.type === 'null');
    } else if ((p.type === 'array' || p.bsonType === 'array') && itemRef) {
      col = createColumn(path, `array<${itemRef}>`);
      col.category = 'array';
      col.nullable = !required.has(pname);
      if (defNames.has(itemRef)) table.foreignKeys.push({ name: null, columns: [path], refSchema: null, refTable: itemRef, refColumns: [], embedded: true, cardinality: 'many' });
    } else if ((p.type === 'array' || p.bsonType === 'array') && p.items && (p.items.properties || p.items.bsonType === 'object' || p.items.type === 'object') && depth < 3) {
      // array of inline objects -> child table (embedded documents)
      const child = createTable(`${table.name}.${path}`, table.schema, 'embedded');
      child.comment = p.description || `Embedded list inside ${table.name}.${path}.`;
      addProperties(schema, child, p.items, '', defNames, defs, depth + 1);
      child.foreignKeys.push({ name: null, columns: [], refSchema: null, refTable: table.name, refColumns: [], embedded: true, cardinality: 'parent', via: path });
      finalizeTable(child);
      schema.tables.push(child);
      col = createColumn(path, `array<object>`);
      col.category = 'array';
      col.nullable = !required.has(pname);
      col.meta = { childTable: child.name };
    } else if ((p.properties) && depth < 3) {
      // nested object -> flatten with dot paths
      const container = createColumn(path, 'object');
      container.category = 'json';
      container.nullable = !required.has(pname);
      container.comment = p.description || null;
      container.meta = { container: true };
      table.columns.push(container);
      addProperties(schema, table, p, path, defNames, defs, depth + 1);
      continue;
    } else {
      const st = schemaType(p);
      col = createColumn(path, st.raw);
      col.category = st.category;
      col.nullable = !required.has(pname) || st.nullable;
      if (p.items && (p.items.type || p.items.bsonType)) { const it = schemaType(p.items); setColumnType(col, `array<${it.raw}>`); col.category = 'array'; if (p.items.enum) col.enumValues = p.items.enum.map(String); }
    }
    if (p.enum && !col.enumValues) { col.enumValues = p.enum.filter((x) => x !== null).map(String); if (col.category === 'string' || col.category === 'other') col.category = 'enum'; }
    if (p.description) col.comment = p.description;
    if (p.title) col.label = p.title;
    if (p.default !== undefined) col.default = JSON.stringify(p.default);
    if (p.maxLength) col.length = p.maxLength;
    if (p.readOnly) col.meta = { ...(col.meta || {}), readOnly: true };
    if (p.format) col.meta = { ...(col.meta || {}), format: p.format };
    if (p['x-unique']) col.unique = true;
    if (p['x-references']) table.foreignKeys.push({ name: null, columns: [path], refSchema: null, refTable: String(p['x-references']).split('.')[0], refColumns: String(p['x-references']).split('.').slice(1), onDelete: null });
    if (p['x-presence'] !== undefined) col.stats = { ...(col.stats || {}), presence: p['x-presence'] };
    if (p['x-examples']) col.stats = { ...(col.stats || {}), examples: p['x-examples'] };
    table.columns.push(col);
  }
}


// ------------------------------------------------------------------ one row per column (catalog query exported as JSON)
// DBeaver, DataGrip, SQL Developer, Azure Data Studio and most APIs export query results as
//   [ { "TABLE_NAME": "...", "COLUMN_NAME": "...", "DATA_TYPE": "..." }, ... ]
// or { "<query or table>": [ ...rows ] }. Those are column lists, not sample data.
function metadataRows(doc) {
  const lists = [];
  if (Array.isArray(doc)) lists.push(doc);
  else if (doc && typeof doc === 'object') {
    for (const v of Object.values(doc)) if (Array.isArray(v)) lists.push(v);
    if (Array.isArray(doc.rows)) lists.push(doc.rows);
    if (Array.isArray(doc.results)) for (const r of doc.results) if (r && Array.isArray(r.items)) lists.push(r.items); // SQL Developer
  }
  const rows = [];
  for (const l of lists) {
    if (!l.length || !l.every(isObj)) continue;
    if (isMetadataHeader([...new Set(l.slice(0, 50).flatMap((o) => Object.keys(o)))])) rows.push(...l);
  }
  return rows.length ? rows : null;
}

// ------------------------------------------------------------------ generic "list of tables" JSON
// Covers hand-written and tool-exported layouts such as
//   { "tables": [ { "name": "users", "columns": [ { "name": "id", "type": "int", "primary_key": true } ] } ] }
//   [ { "table_name": "users", "fields": [...] } ]
//   { "users": { "columns": { "id": "int", "email": { "type": "varchar(255)", "nullable": false } } } }
//   { "users": [ { "name": "id", "type": "int" } ] }        (map of table -> column list)
//   dbt catalog.json / manifest.json  ({ "nodes": { "model.x.y": { "metadata"|"name", "columns": {...} } } })
const T_NAME = ['name', 'table_name', 'tableName', 'table', 'entity', 'entity_name', 'model', 'collection', 'object', 'title', 'id'];
const T_COLS = ['columns', 'fields', 'attributes', 'properties', 'cols', 'schema'];
const C_NAME = ['name', 'column_name', 'columnName', 'column', 'field', 'field_name', 'fieldName', 'attribute', 'key'];
const C_TYPE = ['type', 'data_type', 'dataType', 'datatype', 'column_type', 'columnType', 'db_type', 'sql_type', 'udt_name'];
const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function columnEntries(cols) {
  // -> [ [name, spec] ] where spec is an object (possibly { type } from a string)
  if (Array.isArray(cols)) {
    const out = cols.map((c) => (typeof c === 'string' ? [c, {}] : isObj(c) ? [pick(c, C_NAME), c] : [null, null])).filter(([n]) => typeof n === 'string' && n);
    return out.length === cols.length && out.length ? out : null;
  }
  if (isObj(cols)) {
    const ents = Object.entries(cols);
    if (!ents.length) return null;
    if (ents.every(([, v]) => typeof v === 'string' || isObj(v))) {
      // reject JSON Schema property maps that we already handle elsewhere only when they use JSON Schema keywords
      return ents.map(([k, v]) => [isObj(v) && typeof pick(v, C_NAME) === 'string' ? pick(v, C_NAME) : k, typeof v === 'string' ? { type: v } : v]);
    }
  }
  return null;
}

function looksLikeColumns(ents) {
  if (!ents || !ents.length) return false;
  const withType = ents.filter(([, spec]) => pick(spec, C_TYPE) !== undefined || typeof spec.type === 'string').length;
  return withType / ents.length >= 0.5;
}

function tableDefinitions(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const fromList = (list) => {
    if (!Array.isArray(list) || !list.length || !list.every(isObj)) return null;
    const out = [];
    for (const t of list) {
      const name = pick(t, T_NAME);
      const colsRaw = pick(t, T_COLS);
      const ents = columnEntries(colsRaw);
      if (typeof name !== 'string' || !looksLikeColumns(ents)) return null;
      out.push({ name, def: t, cols: ents });
    }
    return out;
  };
  const fromMap = (map) => {
    if (!isObj(map)) return null;
    const ents = Object.entries(map);
    if (!ents.length) return null;
    const out = [];
    for (const [k, v] of ents) {
      let colsRaw = null; let def = {};
      if (Array.isArray(v)) colsRaw = v;
      else if (isObj(v)) { def = v; colsRaw = pick(v, T_COLS); }
      const cols = columnEntries(colsRaw);
      if (!looksLikeColumns(cols)) return null;
      const meta = isObj(def.metadata) ? def.metadata : {};
      out.push({ name: meta.name || (typeof def.name === 'string' ? def.name : k.split('.').pop()), def: { ...def, schema: def.schema && typeof def.schema === 'string' ? def.schema : meta.schema, comment: def.comment || def.description || meta.comment }, cols });
    }
    return out;
  };
  if (doc.$schema || doc.openapi || doc.swagger || doc.$defs || doc.definitions) return null;
  // dbt catalog / manifest
  if (isObj(doc.nodes) && (doc.metadata && /dbt/i.test(JSON.stringify(doc.metadata).slice(0, 400)))) {
    const nodes = Object.fromEntries(Object.entries(doc.nodes).filter(([k]) => /^(model|seed|snapshot|source)\./.test(k)));
    if (isObj(doc.sources)) Object.assign(nodes, doc.sources);
    return fromMap(nodes);
  }
  if (Array.isArray(doc)) return fromList(doc);
  for (const key of ['tables', 'entities', 'models', 'collections', 'objects', 'data']) {
    const v = doc[key];
    const r = Array.isArray(v) ? fromList(v) : fromMap(v);
    if (r) return r;
  }
  for (const nest of ['schema', 'database', 'db']) if (isObj(doc[nest])) { const r = tableDefinitions(doc[nest]); if (r) return r; }
  return fromMap(doc);
}

const truthyVal = (v) => v === true || v === 1 || /^(y|yes|true|1|pri|pk|primary)$/i.test(String(v ?? ''));

function refOf(spec) {
  const r = pick(spec, ['references', 'reference', 'foreign_key', 'foreignKey', 'fk', 'ref', 'refersTo', 'relation']);
  if (r === undefined || r === false) return null;
  if (typeof r === 'string') {
    const m = /^\s*([\w$."]+?)\s*(?:\(\s*([\w$"]+)\s*\)|\.([\w$"]+))?\s*$/.exec(r.replace(/"/g, ''));
    if (!m) return null;
    const parts = m[1].split('.');
    if (!m[2] && !m[3] && parts.length >= 2) return { table: parts[parts.length - 2], column: parts[parts.length - 1] };
    return { table: parts[parts.length - 1], column: m[2] || m[3] || null };
  }
  if (isObj(r)) return { table: pick(r, ['table', 'table_name', 'ref_table', 'references', 'model', 'entity']), column: pick(r, ['column', 'column_name', 'ref_column', 'field', 'key']) || null };
  return null;
}

function parseTableDefinitions(list, fileName) {
  const schema = createSchema('json-tables', null);
  schema.source.files.push(fileName);
  schema.indexesKnown = list.some((t) => Array.isArray(t.def.indexes));
  let anyKeys = false;
  let anyPk = false;
  for (const { name, def, cols } of list) {
    const parts = String(name).split('.');
    const t = createTable(parts.pop(), typeof def.schema === 'string' ? def.schema : parts.pop() || null, /view/i.test(String(def.type || def.kind || def.table_type || (def.metadata && def.metadata.type) || '')) ? 'view' : 'table');
    t.comment = typeof def.description === 'string' ? def.description : typeof def.comment === 'string' ? def.comment : null;
    for (const [cname, spec] of cols) {
      const col = createColumn(cname, String(pick(spec, C_TYPE) ?? ''));
      const nul = pick(spec, ['nullable', 'is_nullable', 'isNullable', 'null', 'optional']);
      const req = pick(spec, ['required', 'not_null', 'notNull', 'notnull', 'mandatory']);
      if (nul !== undefined) col.nullable = typeof nul === 'boolean' ? nul : /^(y|yes|true|1)$/i.test(String(nul));
      else if (req !== undefined) col.nullable = !truthyVal(req);
      const d = pick(spec, ['default', 'default_value', 'defaultValue', 'column_default']);
      if (d !== undefined) col.default = typeof d === 'string' ? d : JSON.stringify(d);
      const c = pick(spec, ['description', 'comment', 'comments', 'doc', 'note', 'notes']);
      if (typeof c === 'string') col.comment = c;
      if (typeof spec.label === 'string') col.label = spec.label;
      const ev = pick(spec, ['enum', 'values', 'allowed_values', 'allowedValues', 'enum_values', 'options']);
      if (Array.isArray(ev) && ev.length) { col.enumValues = ev.map(String); if (['other', 'string', 'unknown'].includes(col.category)) col.category = 'enum'; }
      if (truthyVal(pick(spec, ['primary_key', 'primaryKey', 'pk', 'is_primary_key', 'isPrimaryKey', 'key']))) { t.primaryKey.push(cname); anyKeys = true; anyPk = true; }
      if (truthyVal(pick(spec, ['unique', 'is_unique', 'isUnique']))) { col.unique = true; t.uniques.push([cname]); }
      if (truthyVal(pick(spec, ['auto_increment', 'autoIncrement', 'identity', 'is_identity', 'serial', 'autoincrement']))) col.autoIncrement = true;
      if (truthyVal(pick(spec, ['indexed', 'index', 'is_indexed']))) col.indexed = true;
      const ref = refOf(spec);
      if (ref && ref.table) { t.foreignKeys.push({ name: null, columns: [cname], refSchema: null, refTable: ref.table, refColumns: ref.column ? [ref.column] : [], onDelete: spec.on_delete || spec.onDelete || null, onUpdate: null }); anyKeys = true; }
      t.columns.push(col);
    }
    const pk = pick(def, ['primary_key', 'primaryKey', 'pk', 'primary_keys', 'primaryKeys']);
    if (pk) { t.primaryKey = [].concat(pk).map(String); anyKeys = true; anyPk = true; }
    for (const f of [].concat(pick(def, ['foreign_keys', 'foreignKeys', 'relations', 'relationships', 'references']) || [])) {
      if (!isObj(f)) continue;
      const colsF = [].concat(pick(f, ['columns', 'column', 'from', 'from_column', 'field', 'fields']) || []).map(String);
      const target = pick(f, ['references', 'ref_table', 'referenced_table', 'to_table', 'table', 'target', 'to']);
      const tr = typeof target === 'string' ? (/\./.test(target) && !pick(f, ['ref_columns', 'referenced_columns', 'to_column', 'ref_column', 'referenced_column']) ? { table: target.split('.').slice(-2)[0], column: target.split('.').pop() } : { table: target, column: null }) : isObj(target) ? { table: pick(target, ['table', 'name']), column: pick(target, ['column', 'columns']) } : null;
      if (!colsF.length || !tr || !tr.table) continue;
      const refCols = [].concat(pick(f, ['ref_columns', 'referenced_columns', 'to_columns', 'ref_column', 'referenced_column', 'to_column']) || tr.column || []).map(String);
      t.foreignKeys.push({ name: f.name || null, columns: colsF, refSchema: null, refTable: tr.table, refColumns: refCols, onDelete: f.on_delete || f.onDelete || null, onUpdate: null });
      anyKeys = true;
    }
    for (const ix of Array.isArray(def.indexes) ? def.indexes : []) {
      const icols = [].concat(isObj(ix) ? pick(ix, ['columns', 'column', 'fields']) || [] : ix).map(String);
      if (icols.length) { t.indexes.push({ name: isObj(ix) ? ix.name || null : null, columns: icols, unique: isObj(ix) && truthyVal(ix.unique) }); if (isObj(ix) && truthyVal(ix.unique)) t.uniques.push(icols); }
    }
    finalizeTable(t);
    schema.tables.push(t);
  }
  schema.constraintsKnown = anyPk;
  if (!anyPk) {
    schema.notes.push(`${fileName} does not mark primary keys${anyKeys ? '' : ' or foreign keys'}, so ${anyKeys ? 'primary keys were' : 'keys were'} inferred from column names (\`id\`, \`<table>_id\`).`);
    for (const t of schema.tables) {
      const base = t.name.toLowerCase().replace(/^(dim|fct|fact|stg|int|raw|tbl)_/, '').replace(/s$/, '');
      const pk = t.columns.find((c) => /^(id|_id)$/i.test(c.name) || c.name.toLowerCase() === `${base}_id` || c.name.toLowerCase() === `${base}id`)
        || (t.columns[0] && !t.columns[0].nullable && /_?id$/i.test(t.columns[0].name) ? t.columns[0] : null);
      if (pk) { t.primaryKey = [pk.name]; t.meta.pkInferred = true; finalizeTable(t); }
    }
  }
  return schema;
}

// ------------------------------------------------------------------ sample data
function parseData(doc, fileName) {
  const schema = createSchema('json-data', null);
  schema.source.files.push(fileName);
  schema.indexesKnown = false;
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_') || 'data';
  const add = (name, rows) => {
    const flat = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => flatten(r));
    if (!flat.length) return;
    const t = inferTable(name, flat, null, { presence: true, kind: 'table' });
    schema.tables.push(t);
  };
  if (Array.isArray(doc)) add(base, doc);
  else {
    let found = false;
    for (const [k, v] of Object.entries(doc)) {
      if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) { add(k, v); found = true; }
    }
    if (!found) add(base, [doc]);
  }
  schema.notes.push(`${fileName} was read as sample records (data), not as a schema definition, so each top-level list became a table and the fields were inferred from the values. If this file describes tables and columns in its own layout, see "Supported JSON layouts" in the README or open an issue with an example.`);
  return schema;
}

function flatten(obj, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !v.$oid && !v.$date && !v.$numberDecimal && !v.$numberLong && depth < 2) flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

// ------------------------------------------------------------------ entry
export function parseJson(text, fileName = 'schema.json') {
  let doc;
  try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    // JSON Lines (mongoexport) fallback
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try { doc = lines.map((l) => JSON.parse(l)); } catch { throw new Error(`Invalid JSON: ${e.message}`); }
  }
  const kind = sniffJsonKind(doc);
  if (kind === 'any-schema') return doc.schema;
  if (kind === 'salesforce') return parseSalesforce(salesforceObjects(doc), fileName);
  if (kind === 'metadata-rows') return parseMetadataObjects(metadataRows(doc), fileName);
  if (kind === 'tables') return parseTableDefinitions(tableDefinitions(doc), fileName);
  if (kind === 'openapi' || kind === 'jsonschema') return parseJsonSchemaDoc(doc, fileName, kind);
  return parseData(doc, fileName);
}
