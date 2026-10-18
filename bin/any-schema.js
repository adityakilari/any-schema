#!/usr/bin/env node
// Any Schema CLI - explain a schema from the command line or in CI.
//
//   npx any-schema schema.sql                     -> writes SCHEMA.md
//   npx any-schema schema.prisma -o docs/DB.md
//   npx any-schema a.csv b.csv --format md|mermaid|dbml|json|summary
//   npx any-schema schema.sql --fail-on high       -> exit 1 if a high finding exists
import fs from 'node:fs';
import path from 'node:path';
import { parseInputs } from '../src/core/parse.js';
import { analyze } from '../src/core/analyze.js';
import { toMarkdown, toMermaid, toDbml, toJson, VERSION } from '../src/core/render.js';

const HELP = `Any Schema v${VERSION} - plain-English documentation for database schemas

Usage: any-schema <file...> [options]

Inputs: SQL DDL (.sql), Prisma (.prisma), JSON Schema / OpenAPI / Salesforce describe /
MongoDB export (.json), metadata or data CSV/TSV. Use "-" to read from stdin.

Options:
  -o, --out <file>       Output file (default SCHEMA.md for markdown, stdout otherwise)
  -f, --format <name>    md (default), mermaid, dbml, json, summary
      --input <format>   Force input format: sql, prisma, json, csv (default: auto-detect)
      --title <text>     Title for the Markdown guide
      --fail-on <level>  Exit with code 1 if a finding of this level or worse exists
                         (high, medium, low, info) - useful in CI
      --stdout           Print Markdown to stdout instead of writing SCHEMA.md
  -h, --help             Show this help
  -v, --version          Show the version
`;

function parseArgs(argv) {
  const o = { files: [], format: 'md', input: 'auto', out: null, title: null, failOn: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) die(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
    else if (a === '-o' || a === '--out') o.out = next();
    else if (a === '-f' || a === '--format') o.format = next();
    else if (a === '--input') o.input = next();
    else if (a === '--title') o.title = next();
    else if (a === '--fail-on') o.failOn = next();
    else if (a === '--stdout') o.stdout = true;
    else if (a.startsWith('-') && a !== '-') die(`Unknown option ${a}. Run any-schema --help.`);
    else o.files.push(a);
  }
  return o;
}

function die(msg) { console.error(`any-schema: ${msg}`); process.exit(2); }

const opts = parseArgs(process.argv.slice(2));
if (!opts.files.length) { process.stdout.write(HELP); process.exit(2); }
const inputs = opts.files.map((f) => {
  if (f === '-') return { name: 'stdin', text: fs.readFileSync(0, 'utf8') };
  if (!fs.existsSync(f)) die(`File not found: ${f}`);
  return { name: path.basename(f), text: fs.readFileSync(f, 'utf8') };
});

let schema;
try { schema = parseInputs(inputs, opts.input); } catch (e) { die(e.message); }
if (!schema.tables.length) die(schema.notes[0] || 'No tables found.');
const analysis = analyze(schema);

let output;
switch (opts.format) {
  case 'md': case 'markdown': output = toMarkdown(schema, analysis, { title: opts.title || inputs.map((i) => i.name).join(', ') }); break;
  case 'mermaid': case 'mmd': output = toMermaid(schema, analysis, { columns: schema.tables.length > 15 ? 'keys' : 'all' }); break;
  case 'dbml': output = toDbml(schema, analysis); break;
  case 'json': output = toJson(schema, analysis); break;
  case 'summary': output = `${analysis.summary}\n${analysis.findings.map((f) => `  [${f.severity}] ${f.title}`).join('\n')}`; break;
  default: die(`Unknown format "${opts.format}". Use md, mermaid, dbml, json or summary.`);
}

const isMd = ['md', 'markdown'].includes(opts.format);
const target = opts.out || (isMd && !opts.stdout ? 'SCHEMA.md' : null);
if (target) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, output.endsWith('\n') ? output : `${output}\n`);
  console.error(`any-schema: wrote ${target} (${analysis.stats.tables} tables, ${analysis.findings.length} findings)`);
} else process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);

if (opts.failOn) {
  const order = ['high', 'medium', 'low', 'info'];
  const limit = order.indexOf(opts.failOn);
  if (limit === -1) die(`--fail-on must be one of ${order.join(', ')}`);
  const bad = analysis.findings.filter((f) => order.indexOf(f.severity) <= limit);
  if (bad.length) {
    console.error(`any-schema: ${bad.length} finding(s) at "${opts.failOn}" or worse:`);
    for (const f of bad) console.error(`  [${f.severity}] ${f.title}`);
    process.exit(1);
  }
}
