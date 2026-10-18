// Builds dist/any-schema.html: one self-contained file (CSS + JS inlined) that works offline
// from file:// - handy for sharing or for locked-down machines. Fonts and the Mermaid
// diagram library still load from their CDNs when online; without them the app falls
// back to system fonts and shows Mermaid source instead of the drawing.
// Also writes dist/artifact.html (page body only) for hosts that add their own <html> shell.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'src/ui/app.js')],
  bundle: true, format: 'iife', minify: true, write: false, target: ['es2020'], legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pick = (name) => {
  const m = new RegExp(`<!-- build:${name} -->([\\s\\S]*?)<!-- /build:${name} -->`).exec(html);
  if (!m) throw new Error(`marker build:${name} missing in index.html`);
  return m[1].trim();
};
const head = pick('head');
const body = pick('body');
const title = /<title>(.*?)<\/title>/.exec(html)[1];
const desc = /<meta name="description" content="([^"]*)"/.exec(html)[1];

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
${head}
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'any-schema.html'), full);

const artifact = `<title>${title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${head.replace(/<link rel="preconnect"[^>]*>\n?/g, '')}
<style>
${css}
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
</style>
${body}
<script>window.ANY_SCHEMA_NO_DOWNLOAD = true;</script>
<script>
${js}
</script>
`;
fs.writeFileSync(path.join(out, 'artifact.html'), artifact);
console.log(`dist/any-schema.html ${(full.length / 1024).toFixed(0)} KB, dist/artifact.html ${(artifact.length / 1024).toFixed(0)} KB`);
