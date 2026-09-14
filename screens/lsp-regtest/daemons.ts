import { FAUCET_DAEMON_URL, LSP_DAEMON_URL } from './config';

// ── Low-level HTTP helpers (mirrors e2e RlnClient) ────────────────────────────

export async function daemonPost(url: string, path: string, body: object = {}): Promise<any> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function daemonGet(url: string, path: string): Promise<any> {
  const res = await fetch(`${url}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

// mirrors refresh_transfers_for_clients in harness.py (double refresh)
async function refreshTransfers(daemonUrl: string): Promise<void> {
  await daemonPost(daemonUrl, '/refreshtransfers', { filter: [], skip_sync: false });
  await daemonPost(daemonUrl, '/refreshtransfers', { filter: [], skip_sync: false });
}

// ── Demo helpers: faucet daemon (external RLN node, NOT the SDK) ─────────────
export const faucet = {
  assetBalance:     (assetId: string) => daemonPost(FAUCET_DAEMON_URL, '/assetbalance',     { asset_id: assetId }),
  decodeRgbInvoice: (invoice: string) => daemonPost(FAUCET_DAEMON_URL, '/decodergbinvoice', { invoice }),
  sendRgb:          (body: object)    => daemonPost(FAUCET_DAEMON_URL, '/sendrgb',           body),
  listTransfers:    (assetId: string) => daemonPost(FAUCET_DAEMON_URL, '/listtransfers',     { asset_filter: { type: 'Id', value: assetId } }),
  refresh:          ()                => refreshTransfers(FAUCET_DAEMON_URL),
  refreshOnce:      ()                => daemonPost(FAUCET_DAEMON_URL, '/refreshtransfers',  { filter: [], skip_sync: false }),
};

// ── Demo helpers: LSP daemon (external RLN node, NOT the SDK) ────────────────
export const lspDaemon = {
  nodeInfo:      ()                => daemonGet(LSP_DAEMON_URL,  '/nodeinfo'),
  listTransfers: (assetId: string) => daemonPost(LSP_DAEMON_URL, '/listtransfers', { asset_filter: { type: 'Id', value: assetId } }),
  refresh:       ()                => refreshTransfers(LSP_DAEMON_URL),
  refreshOnce:   ()                => daemonPost(LSP_DAEMON_URL, '/refreshtransfers', { filter: [], skip_sync: false }),
};
