#!/usr/bin/env node
/**
 * Host-side runner for the rn e2e suite (MIGRATION-PLAN-v3 §6.0m).
 *
 * The SDK cannot run headless on this platform — the wallet talks to a
 * TurboModule, so the native calls only happen on a device (§7a.4). This script
 * is the host half of that: it serves a marker sink, opens the demo's
 * `app/e2e.tsx` by deep link (carrying `e2e-fixtures.json` as a parameter),
 * prints each marker as it arrives, and turns the final one into an exit code.
 *
 * **Markers arrive over HTTP, not logcat.** The original design scraped
 * `[[E2E]]` lines from `adb logcat`; that was tried and does not work — under
 * the New Architecture `console.log` goes to the Metro dev server and only RN's
 * own startup line reaches logcat. The sink also removes logcat's ~4 kB
 * per-line truncation.
 *
 * Usage:
 *   node scripts/run-e2e-android.mjs                # all scenarios
 *   node scripts/run-e2e-android.mjs --only A,D     # subset
 *   node scripts/run-e2e-android.mjs --port 8099    # marker sink port
 *
 * Prerequisites: `./scripts/start-lsp-regtest.sh` (writes the fixtures), an
 * emulator with the demo installed (`yarn android`), and Metro running if the
 * installed build is a dev client.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The emulator's alias for the host loopback (see `utils/bitcoin-node.ts`). */
let EMULATOR_HOST = '10.0.2.2';

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const options = {
  platform: argOf('platform', 'android'),
  fixtures: argOf('fixtures', process.env.RGB_E2E_FIXTURES ?? resolve(DEMO_DIR, 'e2e-fixtures.json')),
  only: argOf('only', ''),
  device: argOf('device', process.env.ANDROID_SERIAL ?? ''),
  port: Number(argOf('port', process.env.RGB_E2E_PORT ?? '8099')),
  /** Whole-run ceiling: the suite mines, waits for channels, settles HTLCs. */
  timeoutSec: Number(argOf('timeout', '2400')),
  /** No marker for this long means the app is wedged, not merely slow. */
  idleSec: Number(argOf('idle-timeout', '420')),
  /** Re-issue the deep link this often until the first marker arrives. */
  launchRetrySec: Number(argOf('launch-retry', '25')),
  noLaunch: flag('no-launch'),
};

if (!['android', 'ios'].includes(options.platform)) throw new Error('--platform must be android or ios');
if (options.platform === 'ios') EMULATOR_HOST = '127.0.0.1';
const simctl = (args) => spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });

const log = (...a) => console.log('[rn-e2e]', ...a);
const die = (msg, code = 2) => {
  console.error(`[rn-e2e] ERROR: ${msg}`);
  process.exit(code);
};

// ── adb ──────────────────────────────────────────────────────────────────────

const adbArgs = options.device ? ['-s', options.device] : [];
const adb = (args) => spawnSync('adb', [...adbArgs, ...args], { encoding: 'utf8' });

function requireDevice() {
  if (options.platform === 'ios') {
    const probe = simctl(['list', 'devices', 'booted', '--json']);
    if (probe.status !== 0) die(probe.stderr || 'Cannot query iOS simulators');
    const devices = Object.values(JSON.parse(probe.stdout).devices).flat().filter((d) => d.state === 'Booted');
    const selected = options.device ? devices.find((d) => d.udid === options.device) : devices.length === 1 ? devices[0] : null;
    if (!selected) die('Boot an iOS simulator and pass --device <UDID> if more than one is booted.');
    options.device = selected.udid;
    return selected.udid;
  }
  const probe = adb(['devices']);
  if (probe.error) die('`adb` not found on PATH — install platform-tools or add it to PATH.');
  const devices = probe.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('device'))
    .map((l) => l.split(/\s+/)[0]);
  if (devices.length === 0) {
    die(
      'no android device/emulator attached.\n' +
        '  Start one:  emulator -avd Medium_Phone_API_36.1 &\n' +
        '  Then build: yarn android'
    );
  }
  if (devices.length > 1 && !options.device) {
    die(`multiple devices attached (${devices.join(', ')}) — pass --device <serial>`);
  }
  return devices[0];
}

// ── fixtures + app identity ──────────────────────────────────────────────────

function loadFixtures() {
  if (!existsSync(options.fixtures)) {
    die(
      `fixtures not found at ${options.fixtures}\n` +
        '  Bring the stack up first: ./scripts/start-lsp-regtest.sh'
    );
  }
  const fx = JSON.parse(readFileSync(options.fixtures, 'utf8'));
  if (fx.platform !== 'rn') {
    die(`fixtures are for platform "${fx.platform}", expected "rn" — wrong demo app?`);
  }
  return fx;
}

function loadAppIdentity() {
  const appJson = JSON.parse(readFileSync(resolve(DEMO_DIR, 'app.json'), 'utf8'));
  const scheme = appJson.expo?.scheme;
  const pkg = options.platform === 'ios' ? appJson.expo?.ios?.bundleIdentifier : appJson.expo?.android?.package;
  if (!scheme || !pkg) die('app.json is missing expo.scheme or the platform app identifier');
  return { scheme, pkg };
}

// ── output ───────────────────────────────────────────────────────────────────

const GREY = (s) => `\x1b[90m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;

function printMarker(m) {
  switch (m.t) {
    case 'run':
      log(`run started — scenarios ${m.scenarios.join(', ')}`);
      break;
    case 'log':
      console.log(`  ${GREY(m.message)}`);
      break;
    case 'step': {
      const head = `  ${m.ok ? GREEN('✓') : RED('✗')} ${String(m.ms).padStart(6)}ms  ${m.scenario} · ${m.step}`;
      console.log(head);
      if (!m.ok && m.error) console.log(RED(`      ${m.error.split('\n').join('\n      ')}`));
      else if (m.value !== undefined) console.log(GREY(`      ${JSON.stringify(m.value).slice(0, 400)}`));
      break;
    }
    case 'scenario': {
      const line = `▪ scenario ${m.scenario}: ${m.ok ? 'PASS' : 'FAIL'} (${Math.round(m.ms / 1000)}s)`;
      console.log(m.ok ? GREEN(line) : RED(line));
      break;
    }
    case 'done':
      console.log('');
      console.log(
        `${m.ok ? GREEN('PASS') : RED('FAIL')} — ${m.passed} passed, ${m.failed} failed, ` +
          `${Math.round(m.ms / 1000)}s`
      );
      for (const f of m.failures ?? []) console.log(RED(`  - ${f}`));
      break;
    default:
      break;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

function launch({ scheme, pkg }, fx, runId) {
  const query = [
    'auto=1',
    `rid=${runId}`,
    `sink=${encodeURIComponent(`http://${EMULATOR_HOST}:${options.port}`)}`,
    `fx=${encodeURIComponent(JSON.stringify(fx))}`,
    options.only ? `only=${encodeURIComponent(options.only)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const url = `${scheme}://e2e?${query}`;
  // Single-quoted for the *device* shell: the query string carries `&` and `?`.
  const res = options.platform === 'ios' ? simctl(['openurl', options.device, url]) : adb(['shell', `am start -a android.intent.action.VIEW -d '${url}' ${pkg}`]);
  if (res.status !== 0 || /Error|Exception/i.test(res.stderr ?? '')) {
    die(
      'deep link failed — is the app installed on the device?\n' +
        `  ${(res.stderr || res.stdout || '').trim()}\n` +
        `  Install it with: npm run ${options.platform}`
    );
  }
  return url;
}

async function main() {
  const serial = requireDevice();
  const fx = loadFixtures();
  const app = loadAppIdentity();
  if (options.only.split(',').includes('H') && !fx.VSS_URL) die('Scenario H requires VSS_URL in fixtures; start the stack with VSS=1.');
  if (options.platform === 'ios' && !options.noLaunch) {
    const installed = simctl(['get_app_container', options.device, app.pkg, 'app']);
    if (installed.status !== 0) die('Install the demo with npm run ios first.');
    simctl(['terminate', options.device, app.pkg]);
    const started = simctl(['launch', options.device, app.pkg]);
    if (started.status !== 0) die(started.stderr || 'Cannot launch iOS demo');
  }
  log(`device ${serial} · fixtures ${options.fixtures} (generated ${fx.generatedAt})`);

  const runId = Date.now().toString(36);
  let lastMarkerAt = Date.now();
  let sawMarker = false;
  let finished = false;
  let exitCode = 2;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/marker')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204).end();
      lastMarkerAt = Date.now();
      sawMarker = true;
      let marker;
      try {
        marker = JSON.parse(body);
      } catch {
        console.error(`[rn-e2e] unparseable marker: ${body.slice(0, 200)}`);
        return;
      }
      printMarker(marker);
      if (marker.t === 'done') stop(marker.ok ? 0 : 1);
    });
  });

  const stop = (code) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    server.close(() => process.exit(exitCode));
    // The device may hold a keep-alive socket open; do not wait on it.
    setTimeout(() => process.exit(exitCode), 1000).unref();
  };

  await new Promise((ok, fail) => {
    server.once('error', (e) =>
      fail(
        new Error(
          `marker sink could not bind :${options.port} (${e.code}) — ` +
            'pass --port <free port>'
        )
      )
    );
    server.listen(options.port, '127.0.0.1', ok);
  });
  log(`marker sink on :${options.port} (device reaches it at ${EMULATOR_HOST}:${options.port})`);

  if (!options.noLaunch) {
    log(`launched ${launch(app, fx, runId).slice(0, 60)}…`);
  }

  const deadline = Date.now() + options.timeoutSec * 1000;
  let lastLaunchAt = Date.now();
  const tick = setInterval(() => {
    if (finished) {
      clearInterval(tick);
      return;
    }
    const now = Date.now();
    // Until the first marker, assume the app was still booting when the intent
    // landed and re-issue it; `rid` makes a duplicate delivery a no-op.
    if (!sawMarker && !options.noLaunch && now - lastLaunchAt > options.launchRetrySec * 1000) {
      lastLaunchAt = now;
      log('no marker yet — re-issuing the deep link');
      launch(app, fx, runId);
    }
    if (now > deadline) {
      clearInterval(tick);
      console.error(`[rn-e2e] ERROR: run exceeded --timeout ${options.timeoutSec}s`);
      stop(2);
    } else if (now - lastMarkerAt > options.idleSec * 1000) {
      clearInterval(tick);
      console.error(
        `[rn-e2e] ERROR: no marker for ${options.idleSec}s — the app is stuck or crashed.\n` +
          '  Check the screen on the device, or the Metro terminal for a JS error.'
      );
      stop(2);
    }
  }, 1000);
}

main().catch((e) => die(e?.stack ?? String(e)));
