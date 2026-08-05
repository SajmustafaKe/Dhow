/**
 * Bundles the compiled main process into a single JavaScript file.
 * 
 * Why we bundle:
 * - pnpm uses symlinks for workspace packages (@x/core, @x/shared)
 * - Electron Forge's dependency walker (flora-colossus) cannot follow these symlinks
 * - Bundling inlines all dependencies into a single file, eliminating node_modules
 * 
 * This script is called by the generateAssets hook in forge.config.js before packaging.
 */

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// In CommonJS, import.meta.url doesn't exist. We need to polyfill it.
// The banner defines __import_meta_url at the top of the bundle,
// and we use define to replace all import.meta.url references with it.
const cjsBanner = `var __import_meta_url = require('url').pathToFileURL(__filename).href;`;
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

await esbuild.build({
  entryPoints: ['./dist/main.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: './.package/dist/main.cjs',
  // electron is provided by the runtime. node-pty and uiohook-napi are NATIVE
  // modules: they can't be inlined (their loaders require .node binaries
  // relative to their own package dirs), so they stay external and are copied
  // into .package/node_modules below, where require() from dist/main.cjs
  // finds them.
  // electron-liquid-glass is staged below on macOS (its only platform);
  // elsewhere the quick-ask bar's lazy import fails and it keeps the solid
  // capsule.
  // @duckdb/node-api is Data Mode's engine. It resolves a platform package
  // holding duckdb.node plus libduckdb, so it gets the same treatment.
  external: [
    'electron',
    'node-pty',
    'uiohook-napi',
    'electron-liquid-glass',
    '@duckdb/node-api',
    '@duckdb/node-bindings',
  ],
  // Use CommonJS format - many dependencies use require() which doesn't work
  // well with esbuild's ESM shim. CJS handles dynamic requires natively.
  format: 'cjs',
  // Inject the polyfill variable at the top
  banner: { js: cjsBanner },
  // Replace import.meta.url directly with our polyfill variable
  define: {
    'import.meta.url': '__import_meta_url',
  },
});

// Ship node-pty next to the bundle. Resolve through pnpm's symlink to the real
// package dir and copy only what's needed at runtime (compiled JS + prebuilt
// binaries). The macOS spawn-helper must be executable — pnpm extraction drops
// the bit, and a non-executable helper makes every PTY spawn fail.
const here = path.dirname(fileURLToPath(import.meta.url));
const ptySrc = fs.realpathSync(path.join(here, 'node_modules', 'node-pty'));
const ptyDest = path.join(here, '.package', 'node_modules', 'node-pty');
fs.rmSync(ptyDest, { recursive: true, force: true });
fs.mkdirSync(ptyDest, { recursive: true });
for (const item of ['package.json', 'lib']) {
  fs.cpSync(path.join(ptySrc, item), path.join(ptyDest, item), { recursive: true, dereference: true });
}
// Stage only the CURRENT platform's prebuilds. Each OS packages natively in CI,
// so other platforms' binaries are dead weight — and worse: Windows code signing
// walks every .node file in the app and signtool hard-fails on the Mach-O darwin
// pty.node ("file format cannot be signed").
const prebuildsSrc = path.join(ptySrc, 'prebuilds');
const prebuildsDir = path.join(ptyDest, 'prebuilds');
fs.mkdirSync(prebuildsDir, { recursive: true });
for (const dir of fs.readdirSync(prebuildsSrc)) {
  if (!dir.startsWith(`${process.platform}-`)) continue;
  fs.cpSync(path.join(prebuildsSrc, dir), path.join(prebuildsDir, dir), { recursive: true, dereference: true });
}
for (const dir of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}

// Self-heal: node-pty ships prebuilt binaries only for darwin/win32, so on any
// host whose prebuild is absent (notably Linux) the staged package has no loadable
// pty.node and the app crashes on launch. Compile the native module for the host
// platform+arch if needed and stage it under prebuilds/<platform>-<arch>/, where
// node-pty's loader looks first. Keeps dev and CI working without a manual node-gyp
// step (the CI workflow's explicit build is the fast path; this is the safety net).
const hostTriple = `${process.platform}-${process.arch}`;
const stagedBinary = path.join(prebuildsDir, hostTriple, 'pty.node');
if (!fs.existsSync(stagedBinary)) {
  const builtBinary = path.join(ptySrc, 'build', 'Release', 'pty.node');
  if (!fs.existsSync(builtBinary)) {
    console.log(`node-pty: no prebuilt binary for ${hostTriple}; compiling with node-gyp…`);
    execSync('npx node-gyp rebuild', { cwd: ptySrc, stdio: 'inherit' });
  }
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`node-pty: failed to produce a native binary for ${hostTriple}`);
  }
  fs.mkdirSync(path.dirname(stagedBinary), { recursive: true });
  fs.copyFileSync(builtBinary, stagedBinary);
  console.log(`✅ node-pty: staged ${hostTriple}/pty.node`);
}
console.log('✅ node-pty staged in .package/node_modules');

// Ship uiohook-napi (global push-to-talk key hook) the same way. Its loader
// is node-gyp-build, which resolves prebuilds/<platform>-<arch>/*.node
// relative to the package dir — stage the package plus the loader. Only the
// current platform's prebuild ships (same code-signing reason as node-pty).
const uiohookSrc = fs.realpathSync(path.join(here, 'node_modules', 'uiohook-napi'));
const uiohookDest = path.join(here, '.package', 'node_modules', 'uiohook-napi');
fs.rmSync(uiohookDest, { recursive: true, force: true });
fs.mkdirSync(uiohookDest, { recursive: true });
for (const item of ['package.json', 'dist']) {
  fs.cpSync(path.join(uiohookSrc, item), path.join(uiohookDest, item), { recursive: true, dereference: true });
}
const uiohookPrebuildsSrc = path.join(uiohookSrc, 'prebuilds');
const uiohookPrebuildsDest = path.join(uiohookDest, 'prebuilds');
fs.mkdirSync(uiohookPrebuildsDest, { recursive: true });
for (const dir of fs.readdirSync(uiohookPrebuildsSrc)) {
  if (!dir.startsWith(`${process.platform}-`)) continue;
  fs.cpSync(path.join(uiohookPrebuildsSrc, dir), path.join(uiohookPrebuildsDest, dir), { recursive: true, dereference: true });
}
// The node-gyp-build loader itself (resolved through pnpm's virtual store —
// it's a sibling of the real uiohook-napi package dir).
const nodeGypBuildSrc = fs.realpathSync(path.join(uiohookSrc, '..', 'node-gyp-build'));
const nodeGypBuildDest = path.join(here, '.package', 'node_modules', 'node-gyp-build');
fs.rmSync(nodeGypBuildDest, { recursive: true, force: true });
fs.cpSync(nodeGypBuildSrc, nodeGypBuildDest, { recursive: true, dereference: true });
console.log('✅ uiohook-napi staged in .package/node_modules');

// electron-liquid-glass (quick-ask bar's glass material): same node-gyp-build
// loader + prebuilds layout as uiohook-napi. macOS-only prebuilds — on other
// platforms nothing is staged and the lazy import in quick-ask.ts falls back
// to the solid capsule.
if (process.platform === 'darwin') {
  const glassSrc = fs.realpathSync(path.join(here, 'node_modules', 'electron-liquid-glass'));
  const glassDest = path.join(here, '.package', 'node_modules', 'electron-liquid-glass');
  fs.rmSync(glassDest, { recursive: true, force: true });
  fs.mkdirSync(glassDest, { recursive: true });
  for (const item of ['package.json', 'dist']) {
    fs.cpSync(path.join(glassSrc, item), path.join(glassDest, item), { recursive: true, dereference: true });
  }
  const glassPrebuildsSrc = path.join(glassSrc, 'prebuilds');
  const glassPrebuildsDest = path.join(glassDest, 'prebuilds');
  fs.mkdirSync(glassPrebuildsDest, { recursive: true });
  for (const dir of fs.readdirSync(glassPrebuildsSrc)) {
    if (!dir.startsWith(`${process.platform}-`)) continue;
    fs.cpSync(path.join(glassPrebuildsSrc, dir), path.join(glassPrebuildsDest, dir), { recursive: true, dereference: true });
  }
  console.log('✅ electron-liquid-glass staged in .package/node_modules');
}

// electron-chrome-extensions injects a preload script into browser tabs to
// implement the chrome.* extension APIs. It resolves that file at runtime:
// via require.resolve when node_modules is present (dev), falling back to a
// file next to the running bundle (packaged app, where node_modules is
// gone). Stage it next to main.cjs for the packaged case.
const crxPreloadSrc = fs.realpathSync(
  path.join(here, 'node_modules', 'electron-chrome-extensions', 'dist', 'chrome-extension-api.preload.js'),
);
fs.copyFileSync(crxPreloadSrc, path.join(here, '.package', 'dist', 'chrome-extension-api.preload.js'));
console.log('✅ electron-chrome-extensions preload staged');

// ---------------------------------------------------------------- Data Mode
//
// @duckdb/node-api is a Node-API addon, so it needs no electron-rebuild (the
// forge config disables rebuild entirely for exactly this reason). What it
// DOES need is staging: the loader requires duckdb.node and libduckdb from
// its own package dir, and forge strips the workspace node_modules.
//
// The macOS dylib ships as a 112 MB universal binary. Each DMG is built per
// arch, so lipo-thinning it halves the installer to ~55 MB. That is worth the
// twenty lines.
const duckdbApiSrc = fs.realpathSync(
  path.dirname(createRequire(path.join(here, 'x.js')).resolve('@duckdb/node-api')),
);
const duckdbApiRoot = fs.realpathSync(path.join(duckdbApiSrc, '..'));
const duckdbReq = createRequire(path.join(duckdbApiRoot, 'x.js'));
const duckdbBindingsRoot = fs.realpathSync(
  path.dirname(duckdbReq.resolve('@duckdb/node-bindings')),
);
const platformPkg = `@duckdb/node-bindings-${process.platform}-${process.arch}`;
const bindingsReq = createRequire(path.join(duckdbBindingsRoot, 'x.js'));
let duckdbPlatformRoot = null;
try {
  duckdbPlatformRoot = fs.realpathSync(
    path.dirname(bindingsReq.resolve(`${platformPkg}/package.json`)),
  );
} catch {
  throw new Error(
    `DuckDB platform package ${platformPkg} is not installed. Data Mode cannot work in this build.`,
  );
}

const stageDuckPkg = (srcDir, key) => {
  const dest = path.join(here, '.package', 'node_modules', ...key.split('/'));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(srcDir, dest, { recursive: true, dereference: true });
  return dest;
};
stageDuckPkg(duckdbApiRoot, '@duckdb/node-api');
stageDuckPkg(duckdbBindingsRoot, '@duckdb/node-bindings');
const stagedPlatform = stageDuckPkg(duckdbPlatformRoot, platformPkg);

// Thin the universal dylib down to the arch this build targets.
if (process.platform === 'darwin') {
  const dylib = path.join(stagedPlatform, 'libduckdb.dylib');
  if (fs.existsSync(dylib)) {
    const before = fs.statSync(dylib).size;
    try {
      execSync(`lipo -thin ${process.arch === 'arm64' ? 'arm64' : 'x86_64'} "${dylib}" -output "${dylib}.thin"`, {
        stdio: 'pipe',
      });
      fs.renameSync(`${dylib}.thin`, dylib);
      const after = fs.statSync(dylib).size;
      console.log(
        `✅ libduckdb thinned ${(before / 1048576).toFixed(0)}MB -> ${(after / 1048576).toFixed(0)}MB`,
      );
    } catch {
      // Already thin, or lipo unavailable. Shipping the fat binary is only a
      // size regression, never a correctness one.
      fs.rmSync(`${dylib}.thin`, { force: true });
    }
  }
}

// Bundle the signed extensions Data Mode needs, so everything works OFFLINE.
// DuckDB defaults autoinstall/autoload to true, which would silently fetch a
// binary from extensions.duckdb.org on first use; the engine turns both off
// and points extension_directory here instead.
//
//   excel  - read_xlsx, kept as a fallback path.
//   httpfs - NOT for networking. DuckDB's built-in mbedtls crypto module is
//            READ-ONLY, so writing an encrypted database fails with "DuckDB
//            currently has a read-only crypto module loaded" unless httpfs is
//            loaded. Encryption at rest is a hard requirement for finance
//            data, so this extension is mandatory, and the reader still runs
//            with enable_external_access=false so no network is reachable.
const DUCKDB_EXTENSIONS = ['excel', 'httpfs'];
const extStageDir = path.join(here, '.package', 'duckdb-extensions');
fs.rmSync(extStageDir, { recursive: true, force: true });
fs.mkdirSync(extStageDir, { recursive: true });
try {
  const duckdbNodeApi = duckdbReq(path.join(duckdbApiRoot, 'lib', 'index.js'));
  const inst = await duckdbNodeApi.DuckDBInstance.create(':memory:', {
    extension_directory: extStageDir,
  });
  const conn = await inst.connect();
  for (const ext of DUCKDB_EXTENSIONS) await conn.run(`INSTALL ${ext}`);
  conn.disconnectSync();
  inst.closeSync();
  const staged = fs.existsSync(extStageDir)
    ? execSync(`find "${extStageDir}" -name '*.duckdb_extension'`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
    : [];
  if (!staged.length) throw new Error('no extension file produced');
  const missing = DUCKDB_EXTENSIONS.filter((e) => !staged.some((f) => f.includes(e)));
  if (missing.length) throw new Error(`missing extension(s): ${missing.join(', ')}`);
  console.log(`✅ DuckDB extensions staged: ${DUCKDB_EXTENSIONS.join(', ')}`);
} catch (err) {
  // httpfs is load-bearing for encryption, so this is a hard failure rather
  // than a warning: a build without it produces an app that cannot create its
  // own encrypted store.
  throw new Error(
    `DuckDB extensions could not be staged (${err.message}). ` +
      'httpfs is required for encrypted-at-rest storage; this build would ship broken.',
  );
}

// pdf-parse stays a computed-path dynamic import in parsing.ts so pdfjs-dist's
// DOM polyfills never enter the main bundle. That means it must be staged, or
// every PDF drop in a packaged build fails with "Cannot find module".
// Resolve a package DIRECTORY by walking node_modules the way Node does.
// Deliberately not require.resolve(`${pkg}/package.json`): that throws for any
// package whose `exports` map does not expose package.json, which pdf-parse
// does not. forge.config.cjs hit the same trap and solved it the same way.
const realDirOf = (key, fromDir) => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...key.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

for (const pkg of ['pdf-parse']) {
  const src = realDirOf(pkg, here);
  if (!src) {
    console.warn(`⚠️  ${pkg} not found; PDF parsing will fail in a packaged build.`);
    continue;
  }
  stageDuckPkg(src, pkg);
  console.log(`✅ ${pkg} staged in .package/node_modules`);
}

// Stage tesseract.js language data so OCR works offline in packaged builds.
// The file is ~3 MB gzipped; without it tesseract.js downloads from a CDN on
// first use, which is unacceptable for an app that may launch without network.
const TESSERACT_LANG_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const tesseractLangDir = path.join(here, '.package', 'tesseract-langs');
fs.rmSync(tesseractLangDir, { recursive: true, force: true });
fs.mkdirSync(tesseractLangDir, { recursive: true });
try {
  const res = await fetch(TESSERACT_LANG_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(tesseractLangDir, 'eng.traineddata.gz'), buffer);
  console.log(`✅ tesseract eng.traineddata staged (${(buffer.length / 1048576).toFixed(1)}MB)`);
} catch (err) {
  console.warn(
    `⚠️  tesseract language data could not be downloaded (${err.message}). ` +
      'OCR on Windows/Linux will require network on first use.',
  );
}

// Compile the Vision OCR helper (macOS only, best effort). Without it Data
// Mode falls back to tesseract.js, which is bundled JS and always available.
if (process.platform === 'darwin') {
  const ocrSrc = path.join(here, 'native', 'ocr.swift');
  const ocrOut = path.join(here, '.package', 'dist', 'ocr');
  const upToDate =
    fs.existsSync(ocrOut) && fs.statSync(ocrOut).mtimeMs >= fs.statSync(ocrSrc).mtimeMs;
  if (upToDate) {
    console.log('✅ ocr helper up to date');
  } else {
    try {
      execSync(`swiftc -O "${ocrSrc}" -o "${ocrOut}"`, { stdio: 'inherit' });
      console.log('✅ ocr helper compiled');
    } catch {
      console.warn('⚠️  ocr helper not built (swiftc unavailable?) — OCR falls back to tesseract.js');
    }
  }
}

// Compile the mic-monitor helper (ambient meeting detection) on macOS.
// Best-effort: without swiftc — or on other platforms — the app still works,
// ad-hoc meeting detection just stays off (main checks the binary exists).
if (process.platform === 'darwin') {
  const swiftSrc = path.join(here, 'native', 'mic-monitor.swift');
  const helperOut = path.join(here, '.package', 'dist', 'mic-monitor');
  const upToDate = fs.existsSync(helperOut) &&
    fs.statSync(helperOut).mtimeMs >= fs.statSync(swiftSrc).mtimeMs;
  if (upToDate) {
    console.log('✅ mic-monitor helper up to date');
  } else {
    try {
      execSync(`swiftc -O "${swiftSrc}" -o "${helperOut}"`, { stdio: 'inherit' });
      console.log('✅ mic-monitor helper compiled');
    } catch {
      console.warn('⚠️  mic-monitor helper not built (swiftc unavailable?) — meeting detection disabled');
    }
  }
}

// Bundle the vendored agent-slack CLI into a single self-contained script next
// to main.cjs. It runs as a child process (process.execPath with
// ELECTRON_RUN_AS_NODE=1), so it must exist as a real file on disk — it can't
// be inlined into main.cjs. Bundling here means the packaged app needs neither
// node_modules nor a global npm install.
const agentSlackPkg = JSON.parse(
  await readFile(new URL('./node_modules/agent-slack/package.json', import.meta.url), 'utf8'),
);
await esbuild.build({
  entryPoints: ['./node_modules/agent-slack/dist/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: './.package/dist/agent-slack.cjs',
  format: 'cjs',
  banner: { js: cjsBanner },
  define: {
    'import.meta.url': '__import_meta_url',
    // Without this constant the CLI's --version walks up the directory tree
    // for a package.json and would find Dhow's instead of agent-slack's.
    'AGENT_SLACK_BUILD_VERSION': JSON.stringify(agentSlackPkg.version),
  },
  // The CLI probes bun:sqlite via dynamic import inside a try/catch and falls
  // back to node:sqlite; keep it external so the probe fails at runtime the
  // same way it does under plain node.
  external: ['bun:sqlite'],
});

console.log(`✅ Main process bundled to .package/dist/main.cjs (+ agent-slack ${agentSlackPkg.version} CLI)`);
