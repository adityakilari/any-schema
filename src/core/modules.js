// Groups tables into modules so large schemas stay readable: by schema when there are
// several, otherwise by table-name prefix (AGY_*, INDV_*, ORDER_*), with the rest in "Other".
import { qualifiedName, words } from './model.js';

const prefixOf = (name) => {
  const n = String(name).replace(/__c$/i, '');
  if (/_/.test(n)) return n.split('_')[0].toUpperCase();
  const m = /^([A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|$))/.exec(n);
  return (m ? m[1] : n).toUpperCase();
};

function prettyPrefix(p) {
  return words(p).replace(/\b\w/g, (c) => c.toUpperCase());
}

/** -> { modules: [{ id, name, keys: [qualified table names] }], of: Map(key -> module id) } */
export function assignModules(schema, options = {}) {
  const minSize = options.minSize || 3;
  const tables = schema.tables;
  const of = new Map();
  const single = (name = 'All tables') => {
    for (const t of tables) of.set(qualifiedName(t), 'all');
    return { modules: [{ id: 'all', name, keys: tables.map(qualifiedName) }], of };
  };
  if (tables.length <= (options.singleUpTo ?? 24)) return single(schema.source.dialect === 'salesforce' ? 'All objects' : schema.source.dialect === 'mongodb' ? 'All collections' : 'All tables');

  const groups = new Map();
  const add = (id, name, t) => {
    if (!groups.has(id)) groups.set(id, { id, name, keys: [] });
    groups.get(id).keys.push(qualifiedName(t));
    of.set(qualifiedName(t), id);
  };
  if (schema.source.dialect === 'salesforce') {
    for (const t of tables) add(/__c$/i.test(t.name) ? 'custom' : 'standard', /__c$/i.test(t.name) ? 'Custom objects' : 'Standard objects', t);
    return { modules: [...groups.values()], of };
  }
  const schemas = [...new Set(tables.map((t) => t.schema || ''))];
  if (schemas.length > 1 && schemas.every((s) => tables.filter((t) => (t.schema || '') === s).length >= minSize)) {
    for (const t of tables) add(`s_${t.schema || 'default'}`, t.schema ? `Schema ${t.schema}` : 'Default schema', t);
    return { modules: [...groups.values()].sort((a, b) => b.keys.length - a.keys.length), of };
  }
  const count = new Map();
  for (const t of tables) count.set(prefixOf(t.name), (count.get(prefixOf(t.name)) || 0) + 1);
  const keep = [...count.entries()].filter(([, c]) => c >= minSize).sort((a, b) => b[1] - a[1]).slice(0, options.maxModules || 30).map(([p]) => p);
  if (keep.length < 2) return single();
  for (const t of tables) {
    const p = prefixOf(t.name);
    if (keep.includes(p)) { add(`p_${p}`, prettyPrefix(p), t); groups.get(`p_${p}`).code = `${p}_`; }
    else add('other', 'Other tables', t);
  }
  const mods = [...groups.values()].filter((g) => g.id !== 'other').sort((a, b) => a.name.localeCompare(b.name));
  if (groups.has('other')) mods.push(groups.get('other'));
  return { modules: mods, of };
}
