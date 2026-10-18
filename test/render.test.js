import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseText } from '../src/core/parse.js';
import { analyze } from '../src/core/analyze.js';
import { toMermaid, toMarkdown, toDbml, toJson } from '../src/core/render.js';

const sample = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const run = (f) => { const s = parseText(sample(f), f); return [s, analyze(s)]; };

test('mermaid erDiagram', () => {
  const [s, a] = run('ecommerce-postgres.sql');
  const m = toMermaid(s, a);
  assert.ok(m.startsWith('erDiagram'));
  assert.match(m, /customers \|\|--o\{ orders : "customer_id"/);
  assert.match(m, /products \|\|\.\.o\{ reviews : "product_id \(inferred\)"/);
  assert.match(m, /bigint product_id PK, FK/);
  const keys = toMermaid(s, a, { columns: 'keys' });
  assert.ok(!keys.includes('first_name'));
  const focus = toMermaid(s, a, { tables: ['public.tags', 'public.product_tags'] });
  assert.ok(!focus.includes('customers {'));
  for (const f of fs.readdirSync(new URL('../samples/', import.meta.url))) {
    const [ss, aa] = run(f);
    for (const line of toMermaid(ss, aa).split('\n').slice(1)) {
      assert.match(line, /^(  [A-Za-z_][A-Za-z0-9_]* \{|    [A-Za-z][A-Za-z0-9_]* [A-Za-z_][A-Za-z0-9_]*( (PK|FK|UK)(, (PK|FK|UK))*)?|  \}|  [A-Za-z_][A-Za-z0-9_]* [|}][|o][-.]{2}[o|][|{}] [A-Za-z_][A-Za-z0-9_]* : "[^"]+")$/, `${f}: ${line}`);
    }
  }
});

test('markdown guide', () => {
  const [s, a] = run('ecommerce-postgres.sql');
  const md = toMarkdown(s, a, { title: 'Shop', date: '2026-01-01' });
  for (const h of ['# Schema guide: Shop', '## Overview', '## Diagram', '```mermaid', '## Tables', '### orders', '## Relationships', '## Findings', '## Personal and sensitive data', '## Enumerations']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('CREATE INDEX idx_addresses_customer_id'));
});

test('dbml', () => {
  const [s, a] = run('ecommerce-postgres.sql');
  const d = toDbml(s, a);
  assert.match(d, /Table public\.orders \{/);
  assert.match(d, /Ref: public\.orders\.customer_id > public\.customers\.id/);
  assert.match(d, /Enum order_status \{/);
});

test('json round-trips through the parser', () => {
  const [s, a] = run('saas.prisma');
  const again = parseText(toJson(s, a), 'x.json');
  assert.equal(again.tables.length, s.tables.length);
  assert.deepEqual(analyze(again).relationships.length, a.relationships.length);
});

test('CLI', () => {
  const cli = new URL('../bin/any-schema.js', import.meta.url).pathname;
  const sql = new URL('../samples/ecommerce-postgres.sql', import.meta.url).pathname;
  const out = execFileSync('node', [cli, sql, '-f', 'mermaid']).toString();
  assert.ok(out.startsWith('erDiagram'));
  const fail = spawnSync('node', [cli, sql, '-f', 'summary', '--fail-on', 'high']);
  assert.equal(fail.status, 1);
  const ok = spawnSync('node', [cli, new URL('../samples/salesforce-describe.json', import.meta.url).pathname, '-f', 'summary', '--fail-on', 'medium']);
  assert.equal(ok.status, 0);
  const bad = spawnSync('node', [cli, 'nope.sql']);
  assert.equal(bad.status, 2);
});

test('generated assets are up to date', () => {
  const r = spawnSync('node', [new URL('../scripts/generate.mjs', import.meta.url).pathname, '--check']);
  assert.equal(r.status, 0, r.stderr.toString());
});
