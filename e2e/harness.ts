/**
 * rn e2e harness — wallet lifecycle, fixtures, and the assertion plumbing the
 * scenarios share (MIGRATION-PLAN-v3 §7a.3, §6.0m).
 *
 * The scenarios themselves contain no setup: they receive a booted wallet and a
 * `step()` that turns each call into one marker line. Field verification comes
 * from `@utexo/rgb-sdk-core/conformance`, the same helpers the web suite uses,
 * so the two tracks cannot drift in what they consider a valid response.
 */
import { UTEXOWallet, PasswordRLNSigner, createWallet } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { buildRegtestConfig } from '@/utils/env';

import { emit } from './marker';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The rn half of `e2e-fixtures.json` (§6.0k), handed to the app as a deep-link
 * parameter — the app cannot read the host filesystem, and env vars are baked
 * into the bundle at build time, which would make a re-provisioned stack
 * require a rebuild.
 */
export interface E2EFixtures {
  platform: 'rn';
  generatedAt: string;
  ASSET_ID?: string;
  IFA_ASSET_ID?: string;
  LSP_PUBKEY: string;
  FAUCET_PUBKEY: string;
  LSP_URL: string;
  FAUCET_URL: string;
  UTEXO_LSP_URL: string;
  BRIDGE_URL: string;
  INDEXER_URL: string;
  PROXY_ENDPOINT: string;
  LSP_PEER_PORT: number;
  FAUCET_PEER_PORT: number;
  /** Present only when the stack was started with VSS=1. */
  VSS_URL?: string;
}

/**
 * Fixture URLs are written as `127.0.0.1` (they describe the host). From the
 * Android emulator the host is `10.0.2.2`; the demo already does exactly this
 * in `utils/bitcoin-node.ts` and `utils/env.ts`. Rewriting here rather than
 * `adb reverse`-ing every port keeps the peer ports (9737/9740) working too.
 */
export function hostUrl(url: string): string {
  if (Platform.OS !== 'android') return url;
  return url.replace('127.0.0.1', '10.0.2.2').replace('localhost', '10.0.2.2');
}

/** Bare host:port form, for peer URIs that carry no scheme. */
export function hostAddr(port: number): string {
  return `${Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1'}:${port}`;
}

export function parseFixtures(raw: unknown): E2EFixtures {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('e2e fixtures missing — pass ?fx=<uri-encoded json>');
  }
  const fx = raw as Partial<E2EFixtures>;
  const required: (keyof E2EFixtures)[] = [
    'FAUCET_PUBKEY',
    'FAUCET_URL',
    'BRIDGE_URL',
    'FAUCET_PEER_PORT',
  ];
  for (const key of required) {
    if (fx[key] === undefined || fx[key] === null || fx[key] === '') {
      throw new Error(
        `e2e fixtures: ${String(key)} is missing — re-run scripts/start-lsp-regtest.sh`
      );
    }
  }
  return fx as E2EFixtures;
}

// ── Assertions ───────────────────────────────────────────────────────────────

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `fn` returns a truthy value.
 *
 * Regtest is asynchronous everywhere that matters — block indexing, channel
 * readiness, HTLC settlement — and a fixed sleep is either flaky or slow. The
 * label is carried into the timeout message so a failure names what never
 * happened, not just that something timed out.
 */
export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { attempts?: number; delayMs?: number; onAttempt?: (i: number) => Promise<void> } = {}
): Promise<T> {
  const { attempts = 60, delayMs = 2000, onAttempt } = opts;
  let lastError = '';
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (onAttempt) await onAttempt(i).catch(() => undefined);
    await sleep(delayMs);
  }
  throw new Error(
    `timed out waiting for ${label} after ${attempts} attempts` +
      (lastError ? ` (last error: ${lastError})` : '')
  );
}

// ── Wallet boot ──────────────────────────────────────────────────────────────

export interface BootedWallet {
  wallet: UTEXOWallet;
  mnemonic: string;
  storageDirPath: string;
  storageDirUri: string;
  daemonPort: number;
  ldkPeerPort: number;
}

/**
 * Fresh node per run: a new mnemonic, a timestamped storage dir, and random
 * ports. A reused storage dir carries a checkpoint from a previous regtest
 * chain, which after a `start-lsp-regtest.sh` re-provision is a different chain
 * entirely — the demo flows use the same trick, as does the web harness.
 */
export async function bootWallet(
  opts: {
    network?: 'regtest' | 'utexo';
    unlockParams?: ReturnType<typeof buildRegtestConfig>['unlockParams'];
    password?: string;
    vssUrl?: string | null;
    /** Reuse an identity — same mnemonic means the same VSS store. */
    mnemonic?: string;
    /** Dir suffix; a fresh one is the "wiped device" of scenario H. */
    label?: string;
    /**
     * `true` turns a failed VSS restore into a silent fresh start — safe for a
     * first boot, and exactly what must NOT be set when verifying a restore.
     */
    allowEmptyRestore?: boolean;
  } = {}
): Promise<BootedWallet> {
  const password = opts.password ?? 'e2e-password';
  const defaults = buildRegtestConfig();
  const network = opts.network ?? defaults.network;
  const unlockParams = opts.unlockParams ?? defaults.unlockParams;
  const mnemonic = opts.mnemonic ?? (await createWallet(network)).mnemonic;

  const ts = Date.now();
  const basePort = 22000 + Math.floor(Math.random() * 5000);
  const storageDirUri = `${documentDirectory ?? ''}rln_e2e_${opts.label ?? ''}${ts}`;
  await FileSystem.makeDirectoryAsync(storageDirUri, { intermediates: true });
  const storageDirPath = storageDirUri.replace('file://', '');

  const wallet = new UTEXOWallet(
    {
      storageDirPath,
      daemonListeningPort: basePort,
      ldkPeerListeningPort: basePort + 1,
      network,
      enableVirtualChannelsV0: false,
      vssUrl: opts.vssUrl ?? null,
      // The regtest vss-server is plain HTTP.
      vssAllowHttp: opts.vssUrl?.startsWith('http://') ?? false,
      vssAllowEmptyRestore: opts.allowEmptyRestore ?? false,
    },
    new PasswordRLNSigner(password, mnemonic)
  );

  try {
    await wallet.init();
    // A wiped device leaves its single-writer fence behind; clearing it is what
    // lets the new node claim the store. No-op when there is nothing to clear.
    if (opts.vssUrl && opts.mnemonic) {
      await wallet.vssClearFence(password);
    }
    await wallet.unlock(unlockParams);
  } catch (error) {
    await wallet.destroy().catch(() => undefined);
    throw error;
  }

  return {
    wallet,
    mnemonic,
    storageDirPath,
    storageDirUri,
    daemonPort: basePort,
    ldkPeerPort: basePort + 1,
  };
}

/** An un-initialised instance — for the conformance capability probes only. */
export function buildWalletSync(): UTEXOWallet {
  return new UTEXOWallet(
    {
      storageDirPath: '/tmp/e2e-conformance-sync',
      daemonListeningPort: 21999,
      ldkPeerListeningPort: 21998,
      network: 'regtest',
      enableVirtualChannelsV0: false,
    },
    new PasswordRLNSigner('conformance-sync', 'x '.repeat(11) + 'x')
  );
}

// ── Scenario plumbing ────────────────────────────────────────────────────────

export interface ScenarioContext {
  wallet: UTEXOWallet;
  boot: BootedWallet;
  fx: E2EFixtures;
  /** Values scenarios hand to each other (assetId from C, ifaAssetId from D…). */
  state: Record<string, unknown>;
  /** Run one named step: emits a marker, re-throws to abort the scenario. */
  step<T>(name: string, fn: () => Promise<T>, evidence?: (value: T) => unknown): Promise<T>;
}

export function makeStep(scenario: string) {
  return async function step<T>(
    name: string,
    fn: () => Promise<T>,
    evidence?: (value: T) => unknown
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await fn();
      emit({
        t: 'step',
        scenario,
        step: name,
        ok: true,
        ms: Date.now() - started,
        value: evidence ? evidence(value) : undefined,
      });
      return value;
    } catch (e) {
      emit({
        t: 'step',
        scenario,
        step: name,
        ok: false,
        ms: Date.now() - started,
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      throw e;
    }
  };
}
