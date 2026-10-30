/**
 * RGB_L1 (rgb-lib) half of the e2e harness.
 *
 * The rgb-lib scenarios (L1–L4) run two fresh wallets against the same regtest
 * stack as the RLN scenarios: `sender` issues and sends, `receiver` receives.
 * They share no state with the RLN wallet, so they can run alone
 * (`--only L1,L2,L3,L4`) without booting a Lightning node.
 */
import {
  CallbackRgbLibKeyProvider,
  UTEXOWallet,
  createWallet,
  type RgbLibUnlockParams,
} from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';

import { assert, hostUrl, waitFor, type E2EFixtures } from './harness';

export type RgbLibWallet = UTEXOWallet<'RGB_L1'>;

export interface RgbLibBoot {
  wallet: RgbLibWallet;
  mnemonic: string;
  storageDirPath: string;
}

export interface RgbLibScenarioContext {
  fx: E2EFixtures;
  unlockParams: RgbLibUnlockParams;
  /** Mutable: scenario L4 replaces the sender with its restored copy. */
  sender: RgbLibBoot;
  receiver: RgbLibBoot;
  /** Values the rgb-lib scenarios hand to each other (assetIds…). */
  state: Record<string, unknown>;
  step<T>(name: string, fn: () => Promise<T>, evidence?: (value: T) => unknown): Promise<T>;
}

// ── bitcoin bridge ───────────────────────────────────────────────────────────

let bridgeEndpoint: string | null = null;

/**
 * Point funding and mining at the fixtures' `BRIDGE_URL` (local-node-bridge.js).
 * Taken from the fixtures rather than the bundle, so the bridge can move off
 * :5000, which macOS AirPlay Receiver occupies.
 */
export function useBridge(fx: E2EFixtures) {
  if (!fx.BRIDGE_URL) throw new Error('e2e fixtures: BRIDGE_URL is missing');
  bridgeEndpoint = `${hostUrl(fx.BRIDGE_URL).replace(/\/$/, '')}/execute`;
}

async function bridgeCommand(args: string): Promise<string> {
  if (!bridgeEndpoint) throw new Error('bridge not configured — call useBridge(fx)');
  const response = await fetch(bridgeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`bridge ${args}: HTTP ${response.status} ${text}`);
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text output
  }
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; result?: unknown; output?: unknown };
    if (typeof record.error === 'string' && record.error) throw new Error(`bridge ${args}: ${record.error}`);
    if (record.result !== undefined) return String(record.result);
    if (typeof record.output === 'string') return record.output.trim();
  }
  return String(data).trim();
}

export const mine = (blocks: number) => bridgeCommand(`mine ${blocks}`);
export const sendToAddress = (address: string, btc: number) => bridgeCommand(`sendtoaddress ${address} ${btc}`);

/** Fee rate for every regtest transaction, in sat/vB. */
export const FEE_RATE = 2;

/**
 * The fixtures describe the RLN unlock body: the indexer is a bare
 * `host:port`. rgb-lib needs the scheme to choose Electrum over Esplora.
 */
export function rgbLibUnlockParams(fx: E2EFixtures): RgbLibUnlockParams {
  for (const key of ['INDEXER_URL', 'PROXY_ENDPOINT'] as const) {
    if (!fx[key]) throw new Error(`e2e fixtures: ${key} is missing — re-run scripts/start-lsp-regtest.sh`);
  }
  const indexer = /^[a-z]+:\/\//.test(fx.INDEXER_URL) ? fx.INDEXER_URL : `tcp://${fx.INDEXER_URL}`;
  return { indexerUrl: hostUrl(indexer), proxyEndpoint: hostUrl(fx.PROXY_ENDPOINT) };
}

/** A new, empty directory under the app documents (absolute path, no scheme). */
export async function freshDir(label: string): Promise<string> {
  const uri = `${documentDirectory ?? ''}rgblib_e2e_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  return uri.replace('file://', '');
}

/**
 * Open an RGB_L1 wallet and connect it. A fresh mnemonic and directory unless
 * given: a restore passes the restored `storageDirPath` and the original
 * mnemonic.
 */
export async function bootRgbLibWallet(
  unlockParams: RgbLibUnlockParams,
  opts: { label: string; mnemonic?: string; storageDirPath?: string }
): Promise<RgbLibBoot> {
  const mnemonic = opts.mnemonic ?? (await createWallet('regtest')).mnemonic;
  const storageDirPath = opts.storageDirPath ?? (await freshDir(opts.label));
  const wallet = new UTEXOWallet({
    protocol: 'RGB_L1',
    params: { network: 'regtest', storageDirPath, witnessVersion: 'taproot' },
    keys: new CallbackRgbLibKeyProvider(async () => mnemonic),
  });
  try {
    await wallet.init();
    await wallet.goOnline(unlockParams);
  } catch (error) {
    await wallet.dispose().catch(() => undefined);
    throw error;
  }
  return { wallet, mnemonic, storageDirPath };
}

/** Fund with `btc`, confirm, and wait until rgb-lib sees it as settled. */
export async function fundWallet(wallet: RgbLibWallet, btc: number): Promise<string> {
  const address = await wallet.getAddress();
  const txid = await sendToAddress(address, btc);
  await mine(1);
  await waitFor('funding to settle', async () => {
    const balance = await wallet.getBtcBalance();
    return balance.vanilla.settled > 0;
  });
  return txid;
}

/** Create colorable UTXOs and wait for them to confirm. */
export async function createColorableUtxos(wallet: RgbLibWallet, num: number): Promise<number> {
  const created = await wallet.createUtxos({ num, feeRate: FEE_RATE });
  await mine(1);
  await waitFor('colorable UTXOs', async () => {
    const unspents = await wallet.listUnspents();
    return unspents.filter((u) => u.utxo.colorable).length >= Math.min(num, created);
  });
  return created;
}

/**
 * Drive an RGB transfer to completion. Each round refreshes both wallets (the
 * receiver validates and ACKs, the sender broadcasts after the ACK) and then
 * mines a block, until `done` holds.
 */
export async function settle(
  label: string,
  wallets: RgbLibWallet[],
  done: () => Promise<boolean>
): Promise<void> {
  await waitFor(
    label,
    async () => {
      for (const wallet of wallets) await wallet.refreshWallet();
      return done();
    },
    { attempts: 40, delayMs: 1500, onAttempt: async () => { await mine(1); } }
  );
}

/** Settled balance; 0 while the wallet has not seen the asset yet (rgb-lib: AssetNotFound). */
export async function settledBalance(wallet: RgbLibWallet, assetId: string): Promise<number> {
  try {
    const balance = await wallet.getAssetBalance(assetId);
    return balance.settled ?? 0;
  } catch (error) {
    if (error instanceof Error && error.message.includes('AssetNotFound')) return 0;
    throw error;
  }
}

/** `fn` must reject; returns the error message for evidence. */
export async function expectRejects(what: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert(false, `${what} should have been rejected`);
  return '';
}
