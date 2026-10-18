// Any Schema - MongoDB schema export (mongosh)
// -----------------------------------------------------------------------------
// MongoDB has no fixed schema, so this script samples documents in every
// collection and writes a JSON Schema bundle (one $defs entry per collection)
// that Any Schema can read. It also includes $jsonSchema validators and indexes.
//
// Run:
//   mongosh "mongodb://USER:PASS@HOST:27017/DBNAME" --quiet --file mongodb.js > mongo-schema.json
//
// Options (environment variables):
//   SAMPLE_SIZE=500          documents sampled per collection (default 500)
//   INCLUDE_EXAMPLES=true    include up to 3 example values per field.
//                            Off by default because examples may contain personal data.
// -----------------------------------------------------------------------------

const SAMPLE_SIZE = Number((typeof process !== 'undefined' && process.env.SAMPLE_SIZE) || 500);
const INCLUDE_EXAMPLES = typeof process !== 'undefined' && /^(1|true|yes)$/i.test(process.env.INCLUDE_EXAMPLES || '');

function bsonTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  const bt = v && v._bsontype;
  if (bt) {
    return ({ ObjectId: 'objectId', ObjectID: 'objectId', Decimal128: 'decimal', Long: 'long', Int32: 'int', Double: 'double',
      Binary: 'binData', UUID: 'binData', Timestamp: 'timestamp', BSONRegExp: 'regex', Code: 'javascript', MinKey: 'minKey', MaxKey: 'maxKey' })[bt] || String(bt).toLowerCase();
  }
  switch (typeof v) {
    case 'string': return 'string';
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(v) ? 'int' : 'double';
    case 'bigint': return 'long';
    case 'object': return 'object';
    default: return 'string';
  }
}

// Collect stats for every field path, recursing into sub-documents and arrays.
function newNode() { return { count: 0, types: {}, props: {}, items: null, examples: [] }; }

function visit(node, value) {
  node.count++;
  const t = bsonTypeOf(value);
  node.types[t] = (node.types[t] || 0) + 1;
  if (t === 'object') {
    for (const [k, v] of Object.entries(value)) {
      node.props[k] = node.props[k] || newNode();
      visit(node.props[k], v);
    }
  } else if (t === 'array') {
    node.items = node.items || newNode();
    for (const el of value.slice(0, 50)) visit(node.items, el);
  } else if (INCLUDE_EXAMPLES && t !== 'null' && node.examples.length < 3) {
    const s = String(value).slice(0, 60);
    if (!node.examples.includes(s)) node.examples.push(s);
  }
}

function toSchema(node, parentCount) {
  const types = Object.keys(node.types);
  const out = { bsonType: types.length === 1 ? types[0] : types };
  if (parentCount) out['x-presence'] = Math.round((node.count / parentCount) * 1000) / 1000;
  if (node.examples.length) out['x-examples'] = node.examples;
  if (node.types.object) {
    const objCount = node.types.object;
    out.properties = {};
    const required = [];
    for (const [k, child] of Object.entries(node.props)) {
      out.properties[k] = toSchema(child, objCount);
      if (child.count === objCount && !child.types.null) required.push(k);
    }
    if (required.length) out.required = required;
  }
  if (node.items) out.items = toSchema(node.items, 0);
  return out;
}

const result = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: db.getName(),
  description: `MongoDB database ${db.getName()} sampled on ${new Date().toISOString()} (up to ${SAMPLE_SIZE} documents per collection).`,
  'x-source': 'mongodb',
  $defs: {},
};

for (const info of db.getCollectionInfos({ type: 'collection' })) {
  const name = info.name;
  if (name.startsWith('system.')) continue;
  const coll = db.getCollection(name);
  const docs = coll.aggregate([{ $sample: { size: SAMPLE_SIZE } }], { allowDiskUse: true }).toArray();
  const root = newNode();
  for (const d of docs) visit(root, d);
  const schema = docs.length ? toSchema(root, 0) : { bsonType: 'object', properties: {} };
  const validator = info.options && info.options.validator && info.options.validator.$jsonSchema;
  if (validator) {
    // declared validator wins for types/required; keep sampled presence where available
    schema['x-validator'] = true;
    for (const [k, v] of Object.entries(validator.properties || {})) {
      schema.properties = schema.properties || {};
      schema.properties[k] = { ...(schema.properties[k] || {}), ...v };
    }
    if (validator.required) schema.required = validator.required;
    if (validator.description) schema.description = validator.description;
  }
  schema['x-collection'] = true;
  schema['x-document-count'] = coll.estimatedDocumentCount();
  schema['x-sampled'] = docs.length;
  schema['x-indexes'] = coll.getIndexes().map((ix) => ({ name: ix.name, key: ix.key, unique: !!ix.unique }));
  result.$defs[name] = schema;
}

print(JSON.stringify(result, null, 2));
