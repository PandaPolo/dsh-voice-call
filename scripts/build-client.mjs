#!/usr/bin/env node
/**
 * Build the dsh-voice client bundle: bundles `src/client/index.ts` into
 * `lib/client.js` in the web client's lazy-CJS handoff format —
 * `window.__ModuleLoader__.load({ id, factory })`. Every cross-package import
 * is externalized (the browser module table supplies `react` and the
 * `@deepseek-ai/*` client packages at runtime); only dsh-voice's own code is
 * bundled into the factory.
 *
 * The package declares `dsh.client` + the `./client` export, so the harness
 * web server serves this bundle at `/plugins/@dsh-voice/bundle/client.js`
 * and composes it into the boot graph when the bundle is installed.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const id = pkg.name;

const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  // Everything the browser module table provides stays external.
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react-dom/*'],
  minify: true,
  write: false,
  logLevel: 'warning',
});

const body = result.outputFiles[0]?.text ?? '';
if (body === '') throw new Error('build-client: esbuild produced no output');

const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n');

await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/client.js'), wrapped, 'utf8');
process.stdout.write(`build-client: wrote ${id} bundle (${Buffer.byteLength(wrapped)} bytes)\n`);
