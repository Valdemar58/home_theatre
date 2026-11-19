// Install only explicitly approved native binaries after pnpm --ignore-scripts.
const { readdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const store = resolve('node_modules/.pnpm');
const entries = readdirSync(store).filter(n => n.startsWith('node-datachannel@'));
if (entries.length !== 1) throw new Error('Expected one locked node-datachannel version');
const nativeDir = join(store, entries[0], 'node_modules/node-datachannel');
const nativeRequire = createRequire(join(nativeDir, 'package.json'));
function run(file, args = [], cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [file, ...args], { cwd, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}
run(nativeRequire.resolve('prebuild-install/bin.js'), ['-r', 'napi'], nativeDir);
run(resolve('node_modules/ffmpeg-static/install.js'));
if (process.argv.includes('--with-electron')) run(resolve('node_modules/electron/install.js'));
