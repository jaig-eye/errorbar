// Bundles the GitHub Action (dist/index.js) and the CLI (dist/cli.js).
// Output is committed: an Action runs straight from the repository, so dist must be current.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ESM bundles still contain CommonJS dependencies that call require() on Node built-ins.
const requireShim =
  "import { createRequire as __eb_createRequire } from 'node:module';\n" +
  'const require = __eb_createRequire(import.meta.url);';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  define: { __VERSION__: JSON.stringify(pkg.version) },
};

await build({
  ...common,
  entryPoints: ['src/action/main.ts'],
  outfile: 'dist/index.js',
  banner: { js: requireShim },
});

await build({
  ...common,
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli.js',
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
});
