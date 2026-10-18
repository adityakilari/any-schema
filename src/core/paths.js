// How do two tables connect? Shortest path over the relationship graph, with the SQL joins.
import { qualifiedName } from './model.js';

export function findJoinPath(schema, analysis, fromKey, toKey, options = {}) {
  if (fromKey === toKey) return { steps: [] };
  const usable = analysis.relationships.filter((r) => !r.external && (r.type === 'embedded-in' || (r.source !== 'embedded' && r.to.columns.length && r.from.columns.length)) && (options.includeSystem || !r.system) && r.type !== 'many-to-many');
  const adj = new Map();
  const link = (a, b, rel, forward) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ next: b, rel, forward }); };
  for (const r of usable) { link(r.from.table, r.to.table, r, true); link(r.to.table, r.from.table, r, false); }
  // Dijkstra: declared links are cheapest, then confident name matches, then role-based guesses
  const cost = (r) => (r.source === 'declared' || r.type === 'embedded-in' ? 1 : r.confidence === 'high' ? 1.2 : 2) + (r.nullable ? 0.15 : 0);
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map([[fromKey, null]]);
  const done = new Set();
  const open = [fromKey];
  while (open.length) {
    open.sort((x, y) => dist.get(x) - dist.get(y));
    const cur = open.shift();
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === toKey) break;
    for (const e of adj.get(cur) || []) {
      const nd = dist.get(cur) + cost(e.rel);
      if (!dist.has(e.next) || nd < dist.get(e.next)) {
        dist.set(e.next, nd);
        prev.set(e.next, { from: cur, ...e });
        open.push(e.next);
      }
    }
  }
  if (!prev.has(toKey)) return null;
  const steps = [];
  for (let k = toKey; prev.get(k); k = prev.get(k).from) steps.unshift({ from: prev.get(k).from, to: k, rel: prev.get(k).rel, forward: prev.get(k).forward });
  return { steps, sql: joinSql(schema, fromKey, steps) };
}

function joinSql(schema, fromKey, steps) {
  const byKey = new Map(schema.tables.map((t) => [qualifiedName(t), t]));
  const used = new Set();
  const alias = (key) => {
    const name = byKey.get(key).name.replace(/__c$/i, '');
    let a = (name.match(/[A-Za-z0-9]+/g) || ['t']).map((p) => p[0]).join('').toLowerCase().slice(0, 4) || 't';
    if (/^\d/.test(a)) a = `t${a}`;
    let cand = a; let i = 2;
    while (used.has(cand)) cand = `${a}${i++}`;
    used.add(cand);
    return cand;
  };
  const al = new Map([[fromKey, alias(fromKey)]]);
  const lines = [`SELECT ${al.get(fromKey)}.*`, `FROM   ${fromKey} ${al.get(fromKey)}`];
  for (const s of steps) {
    al.set(s.to, alias(s.to));
    const r = s.rel;
    if (r.type === 'embedded-in') { lines.push(`-- ${r.from.name} is stored inside ${r.to.name} (embedded documents; no join needed)`); continue; }
    const childAlias = al.get(r.from.table);
    const parentAlias = al.get(r.to.table);
    const on = r.from.columns.map((c, i) => `${childAlias}.${c} = ${parentAlias}.${r.to.columns[i] || r.to.columns[0]}`).join(' AND ');
    lines.push(`${r.nullable && s.forward ? 'LEFT JOIN' : 'JOIN'}   ${s.to} ${al.get(s.to)} ON ${on}`.replace(/^JOIN {3}/, 'JOIN   ').replace(/^LEFT JOIN {3}/, 'LEFT JOIN '));
  }
  return `${lines.join('\n')};`;
}
