/**
 * APay Bridge-Asset checkout · Signet (UTEXO).
 *
 * The signet twin of `screens/apay/useApayLinkedAssetFlow.ts`, run against a
 * utexo-lsp deployed from `utexo-lsp/.env.signet`. Same six legs, same asset
 * semantics, same SDK calls — see that file for why each leg exists and what it
 * proves. What changes is everything time-shaped:
 *
 *   - `mine()` / `sendToAddress()` are gone. BTC comes from the faucet node's
 *     `/sendbtc` and every confirmation is waited out at ~30 s per signet block.
 *   - `CHANNEL_PROVISION_GRACE=60s` instead of 30 s, so an LSP-provisioned peer
 *     is expected to sit idle for a full minute before the cron touches it. The
 *     flow says so in the log rather than letting it read as a stall.
 *   - Wallets are `network: 'utexo'` and unlock against the public indexer and
 *     proxy, so no endpoint rewriting is needed anywhere: unlike the emulator's
 *     `10.0.2.2`, every address a node mints here means the same thing to the
 *     faucet and to the LSP.
 *   - A preflight against `/get_info` and the faucet's balances, because on
 *     signet the cost of finding out late is 20 minutes rather than 20 seconds.
 *
 * The LSP peer is passed to `createLsp()` explicitly, exactly as in regtest and
 * for the same reason: the no-arg form calls `enableVirtualChannelsForPeer()`,
 * which makes this node require `option_scid_alias` on every inbound channel
 * from the LSP. This deployment has no virtual channels at all
 * (`DEFAULT_VIRTUAL_OPEN_MODE=` and no `--enable-virtual-channels-v0`), so a
 * public regular channel would be rejected as `unsupported_scid_alias`.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { createWallet, PasswordRLNSigner, UTEXOWallet, type LspPeer } from '@utexo/rgb-sdk-rn';

import { logRgbBalanceDelta, logRgbBalanceSnap, snapshotRgbBalances } from '../apay/balance';
import { formatAssetAmount, normHash, short, sleep, type LogEntry } from '../apay/config';
import { faucet } from '../apay-signet/daemons';
import {
  AMOUNTS,
  ASSET_PRECISION,
  BRIDGE_ASSET_ID,
  BRIDGE_TICKER,
  CHANNEL_PROVISION_GRACE_MS,
  CHANNEL_TIMEOUT_MS,
  CRON_EVERY_MS,
  FAUCET_BTC_SAT,
  FAUCET_NODE_URL,
  FEE_RATE,
  FUND_TIMEOUT_MS,
  LSP_URL,
  MERCHANT_KEEPALIVE_MS,
  ONCHAIN_SETTLE_TIMEOUT_MS,
  PAYOUT_ASSET_ID,
  PAYOUT_TICKER,
  POLL_MS,
  RGB_INVOICE_DURATION_S,
  SETTLE_TIMEOUT_MS,
  UNLOCK,
  UTXO_NUM,
  UTXO_TOPUP_NUM,
} from './config';

export type LinkedSignetPhase =
  | 'idle'
  | 'preflight'
  | 'b_init' | 'b_fund' | 'b_utxos' | 'b_channel' | 'register'
  | 'a_init' | 'a_fund' | 'a_utxos' | 'a_asset_receive' | 'a_channel'
  | 'send' | 'settle'
  | 'refund_register' | 'refund' | 'refund_settle'
  | 'topup'
  | 'c_init' | 'c_fund' | 'c_utxos' | 'c_channel' | 'c_register' | 'c_pay' | 'c_settle'
  | 'ls_quote' | 'ls_settle'
  | 'done' | 'error';

export const LINKED_SIGNET_PHASE_LABELS: Record<LinkedSignetPhase, string> = {
  idle: 'Idle',
  preflight: 'Preflight',
  b_init: 'B Init', b_fund: 'B Fund', b_utxos: 'B UTXOs', b_channel: 'B Chan (payout, LSP-opened)', register: 'Register',
  a_init: 'A Init', a_fund: 'A Fund', a_utxos: 'A UTXOs', a_asset_receive: 'A Receive Bridge', a_channel: 'A Chan (bridge, self-opened)',
  send: 'Pay', settle: 'Settle',
  refund_register: 'Buyer Address', refund: 'Refund', refund_settle: 'Refund Settle',
  topup: 'Top-up (on-chain → LN)',
  c_init: 'C Init', c_fund: 'C Fund', c_utxos: 'C UTXOs', c_channel: 'C Chan (payout, LSP-opened)',
  c_register: 'C Address', c_pay: 'Pay Recipient', c_settle: 'Recipient Settle',
  ls_quote: 'Relay Quote', ls_settle: 'Relay Settle',
  done: 'Done', error: 'Error',
};

export type UseApayLinkedAssetSignetFlowOptions = {
  storagePrefix?: string;
  merchantPortBase?: number;
  buyerPortBase?: number;
  recipientPortBase?: number;
  merchantKeepalive?: boolean;
  /**
   * Quote the cart with `lspB.requestExternalInvoice` and let the buyer settle
   * the raw BOLT11, instead of `lspA.payAddress`. Models a payer that only has
   * `POST /sendpayment`: no LNURL, no asset selection, no LSP client.
   */
  externalInvoice?: boolean;
};

export function useApayLinkedAssetSignetFlow(options: UseApayLinkedAssetSignetFlowOptions = {}) {
  const {
    storagePrefix = 'apay_bridge_sig',
    merchantPortBase = 54000,
    buyerPortBase = 56000,
    recipientPortBase = 58000,
    merchantKeepalive = true,
    externalInvoice = false,
  } = options;

  const {
    paymentMsat, paymentAssetAmount, aFundUnits, aChannelCapacitySat, aChannelPushMsat,
    refundAssetAmount, refundMsat, topupAssetAmount, topupMsat,
    recipientAssetAmount, recipientMsat, relayAssetAmount, relayMsat,
  } = AMOUNTS;

  const envReady = !!BRIDGE_ASSET_ID && !!PAYOUT_ASSET_ID && !!FAUCET_NODE_URL;
  const logTag = 'apay-bridge-signet';

  const [phase, setPhase] = useState<LinkedSignetPhase>('idle');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const [pubkeyB, setPubkeyB] = useState('');
  const [lightningAddress, setLightningAddress] = useState('');
  const [hashPoolInfo, setHashPoolInfo] = useState<any>(null);
  const [channelB, setChannelB] = useState<any>(null);
  const [channelA, setChannelA] = useState<any>(null);
  const [paymentHash, setPaymentHash] = useState('');
  const [sendStatus, setSendStatus] = useState('');
  const [finalBalB, setFinalBalB] = useState<any>(null);
  const [buyerAddress, setBuyerAddress] = useState('');
  const [topupBalB, setTopupBalB] = useState<any>(null);
  const [pubkeyC, setPubkeyC] = useState('');
  const [channelC, setChannelC] = useState<any>(null);
  const [recipientAddress, setRecipientAddress] = useState('');
  const [recipientHash, setRecipientHash] = useState('');
  const [recipientStatus, setRecipientStatus] = useState('');
  const [finalBalC, setFinalBalC] = useState<any>(null);
  const [relayStatus, setRelayStatus] = useState('');
  const [relayBalA, setRelayBalA] = useState<any>(null);
  const [refundHash, setRefundHash] = useState('');
  const [refundStatus, setRefundStatus] = useState('');
  const [refundBalA, setRefundBalA] = useState<any>(null);

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletCRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef = useRef(false);
  const keepaliveActiveRef = useRef(false);
  const unusedHashesRef = useRef<number | null>(null);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[${logTag}][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    keepaliveActiveRef.current = false;
    unusedHashesRef.current = null;
    setLog([]); setErrorMsg('');
    setPubkeyB(''); setLightningAddress(''); setHashPoolInfo(null);
    setChannelB(null); setChannelA(null);
    setPaymentHash(''); setSendStatus(''); setFinalBalB(null);
    setBuyerAddress(''); setRefundHash(''); setRefundStatus(''); setRefundBalA(null);
    setTopupBalB(null);
    setPubkeyC(''); setChannelC(null); setRecipientAddress('');
    setRecipientHash(''); setRecipientStatus(''); setFinalBalC(null);
    setRelayStatus(''); setRelayBalA(null);

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');
    const fmtPayout = (units: number) => `${formatAssetAmount(units, ASSET_PRECISION)} ${PAYOUT_TICKER}`;
    const fmtBridge = (units: number) => `${formatAssetAmount(units, ASSET_PRECISION)} ${BRIDGE_TICKER}`;
    const checkAbort = () => { if (abortRef.current) throw new Error('Cancelled'); };

    /** Poll a wallet until the faucet's BTC send has a confirmation. */
    const pollFunded = async (w: UTEXOWallet<'RGB_LN'>, label: string): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        checkAbort();
        await sleep(POLL_MS);
        try {
          await w.syncWallet();
          const b = await w.getBtcBalance() as any;
          const st = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
          addLog(`${label} settled BTC: ${st} sat`);
          if (st > 0) return;
        } catch (e: any) { console.error(`[${logTag}] fund poll ${label}`, e?.message ?? e); }
      }
      throw new Error(`Timed out waiting for ${label} BTC funding`);
    };

    /**
     * Confirmed sats on the *colored* (External) keychain — the one
     * `createUtxos` fills.
     *
     * `settled` and not `spendable`: rgb-lib defines `spendable = future -
     * immature` and `future = confirmed + unconfirmed`, so on signet
     * `spendable` counts a createUtxos output the moment it is broadcast and
     * says nothing about confirmation. `settled` is `balance.confirmed` alone
     * (rgb-lib `_get_btc_balance`, wallet/offline.rs).
     */
    const coloredSettledSat = async (w: UTEXOWallet<'RGB_LN'>): Promise<number> => {
      const b = await w.getBtcBalance().catch(() => null) as any;
      return Number(b?.colored?.settled ?? 0);
    };

    /**
     * Poll until a `createUtxos` batch confirms, i.e. until its outputs appear
     * in the colored keychain's *confirmed* balance.
     *
     * Compared against a `before` reading rather than against zero, because the
     * buyer runs this twice: the second batch (after its blind receive) lands
     * on top of the first, which is already confirmed.
     *
     * The next step in every case needs a confirmed colorable UTXO — an
     * `openChannel` or a blind receive against an unconfirmed one fails — so
     * unlike the fund poll this one is worth failing on.
     */
    const pollUtxosConfirmed = async (w: UTEXOWallet<'RGB_LN'>, label: string, before: number): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        checkAbort();
        await sleep(POLL_MS);
        try {
          await w.syncWallet();
          const settled = await coloredSettledSat(w);
          addLog(`${label} confirmed colored BTC: ${settled} sat (was ${before})`);
          if (settled > before) { addLog(`${label} UTXOs confirmed ✓`, 'success'); return; }
        } catch (e: any) { console.error(`[${logTag}] utxo poll ${label}`, e?.message ?? e); }
      }
      throw new Error(
        `${label}: createUtxos did not confirm within ${FUND_TIMEOUT_MS / 60000} min — the colored ` +
        `keychain's confirmed balance never rose above ${before} sat.`,
      );
    };

    /**
     * Per-poll hook while waiting for a channel: hold the LDK peer session open.
     *
     * On regtest the equivalent hook mined a block; here the only thing the
     * client can usefully do is stay connected, because the LSP's cron only
     * considers peers in `/listpeers`. It also names the one stall the LSP
     * cannot recover from: a channel that was accepted and then closed on this
     * side is never retried, and the reason for that is in this node's
     * `.ldk/logs/logs.txt`, not in the LSP log.
     */
    const channelPollKeepalive = (w: UTEXOWallet<'RGB_LN'>, lsp: any, label: string) => {
      const startedAt = Date.now();
      let warned = false;
      return async () => {
        try { await lsp.connect(); } catch { /* already connected */ }
        try { await w.syncWallet(); } catch { /* transient indexer error */ }
        const elapsed = Date.now() - startedAt;
        if (elapsed < CHANNEL_PROVISION_GRACE_MS) return;
        if (!warned && elapsed > 6 * 60 * 1000) {
          warned = true;
          addLog(
            `${label}: still 0 channels after 6 min — well past the ${CHANNEL_PROVISION_GRACE_MS / 1000}s ` +
            `provisioning grace plus three confirmations. The LSP opens once per peer, so a channel that was ` +
            `accepted and then closed on this side is never retried; check this node's .ldk/logs/logs.txt ` +
            'for "close-required error" (a consignment-validation timeout against the indexer closes the ' +
            'channel ~27 s after FundingCreated).',
            'error',
          );
        }
      };
    };

    /** Keep a node reachable for the LSP's outbox for as long as the flow runs. */
    const startKeepalive = (lsp: any) => {
      (async () => {
        while (keepaliveActiveRef.current && !abortRef.current) {
          await sleep(MERCHANT_KEEPALIVE_MS);
          if (!keepaliveActiveRef.current || abortRef.current) break;
          try { await lsp.connect(); } catch { /* already connected */ }
        }
      })();
    };

    try {
      if (!PAYOUT_ASSET_ID || !BRIDGE_ASSET_ID) {
        throw new Error(
          'Bridge asset ids not configured — set EXPO_PUBLIC_SIGNET_BRIDGE_PAYOUT_ASSET_ID and ' +
          'EXPO_PUBLIC_SIGNET_BRIDGE_ASSET_ID (screens/apay-linked-asset-signet/config.ts).',
        );
      }
      if (!FAUCET_NODE_URL) {
        throw new Error(
          'EXPO_PUBLIC_FAUCET_NODE_URL is not set — the faucet RLN node funds BTC and is the on-chain ' +
          `source of ${BRIDGE_TICKER} for the buyer and the top-up.`,
        );
      }

      // ── Preflight ────────────────────────────────────────────────────────
      // Everything below costs 20+ minutes of confirmations to reach, so each
      // precondition that can be read in one request is read now.
      setPhase('preflight');
      addLog(`network=utexo  LSP=${LSP_URL}  faucet=${FAUCET_NODE_URL}`);
      addLog(
        `${BRIDGE_TICKER} ${short(BRIDGE_ASSET_ID, 24)} → ${PAYOUT_TICKER} ${short(PAYOUT_ASSET_ID, 24)}  ` +
        `checkout=${paymentMsat / 1000} sat + ${fmtBridge(paymentAssetAmount)}`,
      );

      req('GET /get_info');
      const lspInfo = await fetch(`${LSP_URL}/get_info`).then(r => r.json()) as any;
      const lspPeerPubkey = String(lspInfo?.pubkey ?? '');
      if (!lspPeerPubkey) throw new Error('Could not read the LSP pubkey from /get_info');
      const lspPeerHost = String(lspInfo?.host ?? '');
      const lspPeerPort = Number(lspInfo?.port ?? 0);
      if (!lspPeerHost || !lspPeerPort) {
        throw new Error(
          '/get_info reports no host/port — set LSP_NODE_HOST / LSP_NODE_PORT on utexo-lsp. ' +
          'The node never reports its own reachable address, so the buyer cannot dial it to open ' +
          'its own channel without them.',
        );
      }
      res('/get_info', {
        pubkey: short(lspPeerPubkey), peer: `${lspPeerHost}:${lspPeerPort}`,
        network: lspInfo?.network, apiVersion: lspInfo?.api_version,
      });

      // The payout asset is the *served* one. The bridge asset is deliberately
      // absent from supported_assets (it is CONVERTIBLE_ASSET_IDS only), so its
      // presence cannot be checked here — LNURL discovery is what advertises it,
      // and the checkout leg asserts it there.
      const supported: any[] = lspInfo?.supported_assets ?? [];
      addLog(`LSP serves: ${supported.map(a => `${a.ticker}(p${a.precision})`).join(', ') || 'none'}`);
      const served = supported.find(a => a.asset_id === PAYOUT_ASSET_ID);
      if (!served) {
        throw new Error(
          `LSP does not serve ${PAYOUT_TICKER} ${short(PAYOUT_ASSET_ID, 24)} — it advertises ` +
          `${supported.map(a => `${a.ticker} ${short(a.asset_id, 20)}`).join(', ') || 'nothing'}. ` +
          'Check SUPPORTED_ASSET_IDS on the signet utexo-lsp (utexo-lsp/.env.signet).',
        );
      }
      if (Number(served.precision) !== ASSET_PRECISION) {
        throw new Error(
          `Precision mismatch: LSP reports ${served.precision} for ${served.ticker}, config says ` +
          `${ASSET_PRECISION}. Every amount here is base units — fix config.ts before running. ` +
          '(ensureConvertiblePair also rejects a pair whose precisions differ.)',
        );
      }
      if (supported.some(a => a.asset_id === BRIDGE_ASSET_ID)) {
        throw new Error(
          `${BRIDGE_TICKER} is in SUPPORTED_ASSET_IDS. It must be CONVERTIBLE_ASSET_IDS only, or the cron ` +
          'gives every peer a second channel, burns inventory in an asset the LSP does not issue, and ' +
          "makes every peer's payout asset ambiguous.",
        );
      }

      // No virtual channels anywhere in this mode — if the deployment still has
      // them on, this is the single-asset signet LSP, not the two-asset one.
      const virtualMode = String(lspInfo?.virtual_channel_mode ?? '');
      if (virtualMode) {
        throw new Error(
          `LSP reports virtual_channel_mode=${virtualMode}. The bridge-asset flow is on-chain only: ` +
          'deploy utexo-lsp with DEFAULT_VIRTUAL_OPEN_MODE empty and its RLN node without ' +
          '--enable-virtual-channels-v0.',
        );
      }

      // The SDK validates payAddress against LNURL discovery's range, not
      // against MIN_AMT_MSAT, so a mismatch here fails client-side.
      const minSendable = Number(lspInfo?.lightning_address_min_sendable_msat ?? 0);
      const maxSendable = Number(lspInfo?.lightning_address_max_sendable_msat ?? Infinity);
      for (const [what, msat] of [
        ['checkout', paymentMsat], ['refund', refundMsat],
        ['recipient', recipientMsat], ['relay', relayMsat],
      ] as const) {
        if (msat < minSendable || msat > maxSendable) {
          throw new Error(
            `${what} leg carries ${msat} msat, outside the LSP's Lightning Address range ` +
            `[${minSendable}, ${maxSendable}] — it would be rejected at LNURL discovery.`,
          );
        }
      }
      addLog(`LSP sendable range ok: [${minSendable}, ${maxSendable}] msat`, 'success');

      // Informational only. min/max_channel_balance_sat describe channels the
      // LSP *opens*; nothing validates a peer-initiated one against them, so a
      // mismatch is worth seeing but is not a reason to refuse to run.
      addLog(
        `LSP channel policy: balance [${lspInfo?.min_channel_balance_sat}, ${lspInfo?.max_channel_balance_sat}] sat, ` +
        `asset [${lspInfo?.min_channel_asset_amount}, ${lspInfo?.max_channel_asset_amount}] — ` +
        `buyer will self-open ${aChannelCapacitySat} sat / ${aFundUnits} units`,
      );

      // The faucet is a precondition the app cannot create: it must hold enough
      // bridge asset for the buyer's channel AND the merchant's top-up, and
      // enough BTC for three nodes.
      req('faucet.btcBalance / assetBalance');
      const needBtc = FAUCET_BTC_SAT * 3;
      let fBtc: any = null;
      try {
        fBtc = await faucet.btcBalance();
      } catch (e: any) {
        // An unreachable faucet is fatal on its own — say so here rather than
        // letting the merchant's /sendbtc fail ten minutes from now.
        throw new Error(`Faucet node ${FAUCET_NODE_URL} is unreachable: ${e?.message ?? String(e)}`);
      }
      const fBtcSpendable = (fBtc?.vanilla?.spendable ?? 0) + (fBtc?.colored?.spendable ?? 0);
      addLog(`faucet spendable BTC: ${fBtcSpendable} sat (needs ≥ ${needBtc})`);
      if (fBtcSpendable < needBtc) {
        throw new Error(
          `Faucet node holds ${fBtcSpendable} sat, below the ${needBtc} sat this flow hands out ` +
          `(${FAUCET_BTC_SAT} × 3 nodes). Top it up before running.`,
        );
      }
      const fBridge = await faucet.assetBalance(BRIDGE_ASSET_ID).catch(() => null) as any;
      const fBridgeSpendable = Number(fBridge?.spendable ?? 0);
      const needBridge = aFundUnits + topupAssetAmount;
      addLog(`faucet spendable ${BRIDGE_TICKER}: ${fBridgeSpendable} (needs ≥ ${needBridge})`);
      if (fBridgeSpendable < needBridge) {
        throw new Error(
          `Faucet node holds ${fmtBridge(fBridgeSpendable)}, below the ${fmtBridge(needBridge)} this flow ` +
          `sends on-chain (${fmtBridge(aFundUnits)} to the buyer + ${fmtBridge(topupAssetAmount)} for the ` +
          `top-up). The faucet is the on-chain source of ${BRIDGE_TICKER} — issue or transfer some to it first.`,
        );
      }
      res('faucet preflight ok');

      const LSP_PEER: LspPeer = {
        baseUrl: LSP_URL,
        peerPubkey: lspPeerPubkey,
        peerHost: lspPeerHost,
        peerPort: lspPeerPort,
      };
      const lspPeerUri = `${lspPeerPubkey}@${lspPeerHost}:${lspPeerPort}`;

      const ts = Date.now();
      const mkDir = async (name: string) => {
        const uri = `${documentDirectory ?? ''}${storagePrefix}_${name}_${ts}`;
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
        return uri.replace('file://', '');
      };

      // ── Merchant wallet (B) — served the ordinary way, in the payout asset ──
      setPhase('b_init');
      const keysB = await createWallet('utexo' as any);
      const portB = merchantPortBase + Math.floor(Math.random() * 1000);
      const wB = new UTEXOWallet(
        {
          storageDirPath: await mkDir('b'),
          daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1,
          network: 'utexo',
          lspBaseUrl: LSP_URL,
          // No enableVirtualChannelsV0 / virtualPeerPubkeys — nothing virtual here.
        },
        new PasswordRLNSigner('apaybridgesigB', keysB.mnemonic),
      );
      walletBRef.current = wB;
      const lspB = await wB.createLsp(LSP_PEER);
      await wB.init();
      await wB.unlock(UNLOCK);

      const bPubkey = String((await wB.getNodeInfo())?.pubkey ?? '');
      setPubkeyB(bPubkey);
      res('merchant.init', { pubkey: short(bPubkey) });

      setPhase('b_fund');
      const addrB = await wB.getAddress();
      req('faucet.sendBtc merchant', { amount: FAUCET_BTC_SAT, address: short(addrB, 18) });
      await faucet.sendBtc(addrB, FAUCET_BTC_SAT, FEE_RATE);
      res('faucet.sendBtc');
      await pollFunded(wB, 'merchant');

      setPhase('b_utxos');
      req('merchant.createUtxos', { num: UTXO_NUM, feeRate: FEE_RATE });
      await wB.syncWallet();
      await wB.refreshWallet();
      const bColoredBefore = await coloredSettledSat(wB);
      await wB.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
      res('merchant.createUtxos');
      await pollUtxosConfirmed(wB, 'merchant', bColoredBefore);

      setPhase('b_channel');
      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');

      addLog(
        `Waiting out CHANNEL_PROVISION_GRACE (${CHANNEL_PROVISION_GRACE_MS / 1000}s), then the LSP cron ` +
        `(every ${CRON_EVERY_MS / 1000}s) opens a real on-chain ${PAYOUT_TICKER} channel to the merchant. ` +
        'Confirmations follow at ~30 s per signet block — the first couple of minutes of silence are expected.',
      );
      const chanB = await lspB.waitForChannel(PAYOUT_ASSET_ID, {
        timeoutMs: CHANNEL_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress: (msg: string) => addLog(`merchant ${msg}`),
        onEachPoll: channelPollKeepalive(wB, lspB, 'merchant'),
      });
      setChannelB(chanB);
      addLog(`Merchant on-chain ${PAYOUT_TICKER} channel usable ✓  cap=${chanB.capacitySat} sat`, 'success');

      const merchantSnapStart = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
      logRgbBalanceSnap('merchant', 'START (after channel)', merchantSnapStart, addLog);

      setPhase('register');
      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');
      await sleep(1000);

      req('lspB.enableLightningAddress');
      const lnAddr = await lspB.enableLightningAddress();
      setLightningAddress(lnAddr.address);
      setHashPoolInfo({ address: lnAddr.address, username: lnAddr.username, domain: lnAddr.domain });
      unusedHashesRef.current = lnAddr.unusedHashes ?? null;
      res('enableLightningAddress', { address: lnAddr.address, unusedHashes: lnAddr.unusedHashes });
      addLog(`Merchant Lightning Address: ${lnAddr.address}`, 'success');

      if (merchantKeepalive) {
        keepaliveActiveRef.current = true;
        addLog(`Merchant keepalive: lsp.connect() every ${MERCHANT_KEEPALIVE_MS / 1000}s`);
        startKeepalive(lspB);
      }

      try {
        // ── Buyer wallet (A) ──────────────────────────────────────────────
        //
        // The buyer must NOT touch the LSP until it is ready to fund its own
        // channel: /openchannel connects the peer itself, but any earlier
        // connect (discovery, a keepalive) puts the pubkey in /listpeers and
        // starts CHANNEL_PROVISION_GRACE — after which the cron would hand it a
        // payout-asset channel it never asked for. So `lspA` is created here but
        // not connected until a_channel.
        setPhase('a_init');
        const keysA = await createWallet('utexo' as any);
        const portA = buyerPortBase + Math.floor(Math.random() * 1000);
        const wA = new UTEXOWallet(
          {
            storageDirPath: await mkDir('a'),
            daemonListeningPort: portA,
            ldkPeerListeningPort: portA + 1,
            network: 'utexo',
            lspBaseUrl: LSP_URL,
          },
          new PasswordRLNSigner('apaybridgesigA', keysA.mnemonic),
        );
        walletARef.current = wA;
        const lspA = await wA.createLsp(LSP_PEER);
        await wA.init();
        await wA.unlock(UNLOCK);
        res('buyer.init', { pubkey: short(String((await wA.getNodeInfo())?.pubkey ?? '')) });

        setPhase('a_fund');
        const addrA = await wA.getAddress();
        req('faucet.sendBtc buyer', { amount: FAUCET_BTC_SAT, address: short(addrA, 18) });
        await faucet.sendBtc(addrA, FAUCET_BTC_SAT, FEE_RATE);
        res('faucet.sendBtc');
        await pollFunded(wA, 'buyer');

        setPhase('a_utxos');
        req('buyer.createUtxos', { num: UTXO_NUM, feeRate: FEE_RATE });
        await wA.syncWallet();
        await wA.refreshWallet();
        const aColoredBefore = await coloredSettledSat(wA);
        await wA.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
        res('buyer.createUtxos');
        await pollUtxosConfirmed(wA, 'buyer', aColoredBefore);

        // ── Buyer receives the BRIDGE asset on-chain from the Faucet ───────
        // A plain blind receive, not lightning_receive: the buyer needs colored
        // UTXOs of the bridge asset *before* it can fund a channel with them,
        // and at this point it has no channel at all.
        setPhase('a_asset_receive');
        // "Any asset" invoice — the buyer's wallet has never seen this contract,
        // and naming a specific assetId 403s with UnknownContractId. The sender
        // supplies the real id and amount via /sendrgb's recipient_map, which is
        // what registers the contract on receipt.
        req('buyer.onchainReceive (any asset)');
        const recv = await wA.onchainReceive({
          durationSeconds: RGB_INVOICE_DURATION_S,
          minConfirmations: 1,
          witness: false,
        });
        res('buyer.onchainReceive', { invoice: short(recv.invoice, 32) });

        req('faucet.decodeRgbInvoice');
        const decoded = await faucet.decodeRgbInvoice(recv.invoice);
        const recipientId = decoded.recipient_id ?? recv.recipientId;
        // No endpoint rewriting on signet: the node's proxy is the public
        // rgb-proxy.utexo.com, which means the same thing to the faucet as it
        // does to the device. (The emulator's 10.0.2.2 problem is regtest-only.)
        const transportEndpoints = decoded.transport_endpoints ?? [];
        res('faucet.decodeRgbInvoice', {
          recipientId: short(String(recipientId), 24),
          endpoints: transportEndpoints.join(','),
        });
        if (!transportEndpoints.length) {
          throw new Error(
            "Buyer's RGB invoice carries no transport endpoints — the wallet was unlocked without a " +
            'proxy endpoint, and the faucet would reject the send as InvalidTransportEndpoints.',
          );
        }

        req('faucet.sendRgb', { amount: aFundUnits, recipientId: short(String(recipientId), 20) });
        await faucet.sendRgb({
          donation: false, fee_rate: FEE_RATE, min_confirmations: 1, skip_sync: false,
          recipient_map: {
            [BRIDGE_ASSET_ID]: [{
              recipient_id: recipientId,
              assignment: { type: 'Fungible', value: aFundUnits },
              transport_endpoints: transportEndpoints,
            }],
          },
        });
        res('faucet.sendRgb');
        await sleep(2000);
        await faucet.refresh().catch(() => {});

        addLog(
          `Waiting for the buyer's ${BRIDGE_TICKER} receive to settle. Four sequential steps, each ` +
          'gated on a signet block: faucet sends → buyer acknowledges → faucet broadcasts → confirmation.',
        );
        const recvDeadline = Date.now() + ONCHAIN_SETTLE_TIMEOUT_MS;
        let recvSettled = false;
        while (Date.now() < recvDeadline) {
          checkAbort();
          await sleep(POLL_MS);
          try {
            await wA.syncWallet();
            await wA.refreshWallet();
            await faucet.refresh().catch(() => {});
            const bal = await wA.getAssetBalance(BRIDGE_ASSET_ID).catch(() => null);
            addLog(`buyer ${BRIDGE_TICKER} spendable: ${bal?.spendable ?? 0} / ${aFundUnits}`);
            if (Number(bal?.spendable ?? 0) >= aFundUnits) { recvSettled = true; break; }
            const transfers = await faucet.listTransfers(BRIDGE_ASSET_ID).catch(() => null);
            const send = [...(transfers?.transfers ?? [])].reverse().find((t: any) => t.kind === 'Send');
            if (send) addLog(`faucet Send: ${send.status}`);
            if (send?.status === 'Failed') throw new Error('Faucet RGB send transfer Failed');
          } catch (e: any) {
            if (String(e?.message ?? '').includes('Failed')) throw e;
            console.error(`[${logTag}] bridge receive poll:`, e?.message ?? e);
          }
        }
        if (!recvSettled) throw new Error(`Buyer ${BRIDGE_TICKER} receive did not settle in time`);
        addLog(`Buyer received ${fmtBridge(aFundUnits)} on-chain ✓`, 'success');

        // The blind receive burned one of the uncolored UTXOs created above.
        // Top up before the channel-open, which needs a plain one for the BTC
        // side of the funding tx.
        req('buyer.createUtxos (post-receive top-up)', { num: UTXO_TOPUP_NUM });
        await wA.syncWallet();
        const aColoredBefore2 = await coloredSettledSat(wA);
        await wA.createUtxos({ upTo: false, num: UTXO_TOPUP_NUM, feeRate: FEE_RATE });
        res('buyer.createUtxos');
        await pollUtxosConfirmed(wA, 'buyer', aColoredBefore2);

        // ── Buyer opens its OWN channel, funded in the bridge asset ────────
        // Client-initiated, not LSP-pushed — genuine self-funded outbound
        // capacity. This is the first time the buyer touches the LSP peer.
        setPhase('a_channel');
        req('buyer.connectPeer', { lspPeerUri: short(lspPeerUri, 40) });
        try { await wA.connectPeer(lspPeerUri); } catch { /* already connected */ }
        res('buyer.connectPeer');

        req('buyer.openChannel', {
          assetId: short(BRIDGE_ASSET_ID), assetLocalAmount: aFundUnits,
          capacitySat: aChannelCapacitySat, pushMsat: aChannelPushMsat,
        });
        const openResp = await wA.openChannel({
          peerPubkey: lspPeerUri,
          capacitySat: aChannelCapacitySat,
          pushMsat: aChannelPushMsat,
          isPublic: false,
          withAnchors: true,
          assetId: BRIDGE_ASSET_ID,
          assetLocalAmount: aFundUnits,
        });
        res('buyer.openChannel', { temporaryChannelId: short(openResp.temporaryChannelId, 24) });

        addLog('Waiting for the buyer channel to confirm (MIN_CHANNEL_CONFIRMATIONS = 3 blocks)…');
        const chanA = await lspA.waitForChannel(BRIDGE_ASSET_ID, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (msg: string) => addLog(`buyer ${msg}`),
          onEachPoll: channelPollKeepalive(wA, lspA, 'buyer'),
        });
        setChannelA(chanA);
        addLog(`Buyer self-opened ${BRIDGE_TICKER} channel usable ✓`, 'success');

        const buyerSnapStart = await snapshotRgbBalances(wA, BRIDGE_ASSET_ID, lspPeerPubkey);
        const merchantSnapCheckout = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'START (pre-checkout)', buyerSnapStart, addLog);
        logRgbBalanceSnap('merchant', 'START (pre-checkout)', merchantSnapCheckout, addLog);

        const balBefore = Number((await wB.getAssetBalance(PAYOUT_ASSET_ID))?.offchainOutbound ?? 0);

        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();

        if (!lnAddr.address) throw new Error('Lightning Address missing');

        // ── Discovery: what is this address actually paid out in? ──────────
        // Nothing below hardcodes an asset. The merchant's payout asset comes
        // from the LSP; the buyer's wallet decides what to be quoted in.
        setPhase('send');
        req('lspA.discoverAddress', { address: lnAddr.address });
        const discovery = await lspA.discoverAddress(lnAddr.address);
        res('discoverAddress', {
          payoutAsset: discovery.payoutAsset?.ticker ?? '(none advertised)',
          accepted: (discovery.acceptedAssets ?? []).map(a => a.ticker ?? short(a.assetId)).join(','),
        });
        if (!discovery.payoutAsset) {
          throw new Error(
            'Discovery advertises no payout asset — the merchant channel is not up, or utexo-lsp predates ' +
            'payout_asset.',
          );
        }
        // This is the only place the bridge asset's advertisement can be
        // checked: it is absent from /get_info by design.
        if (!(discovery.acceptedAssets ?? []).some(a => a.assetId === BRIDGE_ASSET_ID)) {
          throw new Error(
            `Discovery does not list ${BRIDGE_TICKER} as accepted for this address. Check ` +
            'CONVERTIBLE_ASSET_IDS and CONVERTIBLE_PAIRS on the signet utexo-lsp — being payout-eligible ' +
            'is not enough, the pair has to be declared.',
          );
        }

        let invoice: string;
        let payRes: any;

        if (externalInvoice) {
          // ── The merchant quotes, an APay-unaware node pays ──────────────
          // The asset comes from LNURL discovery, not from config: with no
          // `asset` argument requestExternalInvoice takes the single convertible
          // asset the address advertises. The buyer then settles it as a plain
          // BOLT11 — the RGB contract id and amount ride inside it, so that is
          // all an external POST /sendpayment would need.
          req('lspB.requestExternalInvoice', { amtMsat: paymentMsat, assetAmount: paymentAssetAmount });
          const ext = await lspB.requestExternalInvoice({
            amtMsat: paymentMsat,
            assetAmount: paymentAssetAmount,
          });
          invoice = ext.invoice;
          res('requestExternalInvoice', {
            asset: ext.asset?.ticker ?? short(ext.assetId ?? ''),
            converted: ext.converted,
            paymentHash: short(ext.paymentHash ?? ''),
          });
          addLog(
            `Merchant quoted ${formatAssetAmount(paymentAssetAmount, ASSET_PRECISION)} ` +
            `${ext.asset?.ticker ?? BRIDGE_TICKER} for an external payer — ` +
            (ext.converted ? `LSP converts 1:1 to ${PAYOUT_TICKER}` : 'no conversion'),
            'success',
          );
          addLog(`External node would run: POST /sendpayment {"invoice":"${short(invoice, 24)}"}`);

          req('buyer.payLightningInvoice (no LSP client involved)');
          payRes = await wA.payLightningInvoice({ lnInvoice: invoice });
          res('payLightningInvoice', { status: payRes.status });
        } else {
          // ── Pay, letting the SDK choose the inbound asset ───────────────
          // The buyer holds only the bridge asset, so selection lands there and
          // the LSP converts 1:1 on its books. Had it held enough payout asset,
          // the same call would have quoted that — conversion is the fallback,
          // never the default.
          req('lspA.payAddress (asset selected by SDK)', {
            address: lnAddr.address, amtMsat: paymentMsat, assetAmount: paymentAssetAmount,
          });
          const paid = await lspA.payAddress({
            address: lnAddr.address,
            amtMsat: paymentMsat,
            asset: { assetAmount: paymentAssetAmount },
          });
          invoice = paid.invoice;
          payRes = paid.sendResult;
          const assetSelection = paid.assetSelection;
          if (assetSelection) {
            addLog(
              `SDK quoted in ${assetSelection.asset?.ticker ?? short(assetSelection.assetId)} ` +
              `(local ${assetSelection.localAssetAmount}) — ` +
              (assetSelection.converted
                ? `LSP converts 1:1 to ${discovery.payoutAsset.ticker ?? 'payout asset'}`
                : 'no conversion, same asset on both legs'),
              'success',
            );
          }
        }
        if (!invoice) throw new Error('no invoice was quoted for the cart');
        const pHash = payRes.txid ?? '';
        const payStatus = String(payRes.status ?? '').toLowerCase();
        setPaymentHash(pHash);
        res('cart paid', { invoice: short(invoice, 32), status: payRes.status, paymentHash: short(pHash) });

        if (payStatus === 'failed') {
          throw new Error(
            `Cart payment failed — check the buyer has spendable ${BRIDGE_TICKER} and that utexo-lsp lists ` +
            'the pair in CONVERTIBLE_PAIRS.',
          );
        }
        addLog('Cart paid — HTLC held at LSP, waiting for the outbound leg to the merchant…', 'success');

        setPhase('settle');
        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();
        await wB.refreshWallet();

        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        let settled = false;
        let reconnectEvery = 0;
        while (Date.now() < deadline) {
          checkAbort();
          await sleep(POLL_MS);

          reconnectEvery += POLL_MS;
          if (reconnectEvery >= MERCHANT_KEEPALIVE_MS) {
            reconnectEvery = 0;
            try { await lspB.connect(); } catch { /* already connected */ }
          }

          await wA.syncWallet();
          await wB.syncWallet();
          await wB.refreshWallet();

          const status = pHash ? await wA.getLightningSendStatus(pHash) : 'Pending';
          setSendStatus(status ?? 'Pending');
          addLog(`buyer getLightningSendStatus: ${status}`);

          let balAfter = balBefore;
          const b1 = await wB.getAssetBalance(PAYOUT_ASSET_ID).catch(() => null);
          if (b1) { balAfter = Number(b1.offchainOutbound ?? 0); setFinalBalB(b1); }

          const pays = await wB.listPayments().catch(() => []);
          const mp = pays.find(p => normHash(p.paymentHash) === normHash(pHash));
          if (mp) addLog(`merchant inbound: ${mp.paymentType}/${mp.status}`);

          const merchantOk = mp && ['succeeded', 'claimable'].includes(String(mp.status ?? '').toLowerCase());
          if (status === 'Succeeded' && balAfter > balBefore) {
            settled = true;
            addLog(`merchant received +${fmtPayout(balAfter - balBefore)} — conversion confirmed ✓`, 'success');
            break;
          }
          if (status === 'Succeeded' && merchantOk) {
            settled = true;
            addLog('buyer Settled + merchant inbound SUCCEEDED — bridge-asset checkout complete ✓', 'success');
            break;
          }
          if (status === 'Failed') throw new Error('buyer payment Failed during LSP settlement');
        }
        if (!settled) {
          throw new Error('Timeout waiting for settlement — ensure merchant lsp.connect() and both LSP legs are up.');
        }

        if (unusedHashesRef.current !== null) {
          unusedHashesRef.current = Math.max(0, unusedHashesRef.current - 1);
        }

        const buyerSnapEnd = await snapshotRgbBalances(wA, BRIDGE_ASSET_ID, lspPeerPubkey);
        const merchantSnapEnd = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'END (settled)', buyerSnapEnd, addLog);
        logRgbBalanceSnap('merchant', 'END (settled)', merchantSnapEnd, addLog);
        logRgbBalanceDelta(`buyer (${BRIDGE_TICKER})`, buyerSnapStart, buyerSnapEnd, addLog);
        logRgbBalanceDelta(`merchant (${PAYOUT_TICKER})`, merchantSnapCheckout, merchantSnapEnd, addLog);

        // What contracts does the buyer's node actually hold? It should be only
        // the bridge asset: the observable proof that CHANNEL_PROVISION_GRACE
        // plus the payout-asset rule kept the cron off a self-provisioned peer.
        const buyerAssets = await wA.listAssets().catch(() => null);
        const buyerAssetIds = [
          ...(buyerAssets?.nia ?? []), ...(buyerAssets?.cfa ?? []),
          ...(buyerAssets?.uda ?? []), ...(buyerAssets?.ifa ?? []),
        ].map((a: any) => String(a?.assetId ?? a?.asset_id ?? ''));
        addLog(
          `buyer node knows ${buyerAssetIds.length} contract(s): ` +
          buyerAssetIds.map(id => (id === BRIDGE_ASSET_ID ? BRIDGE_TICKER : id === PAYOUT_ASSET_ID ? PAYOUT_TICKER : short(id, 16))).join(', '),
        );
        addLog(
          buyerAssetIds.includes(PAYOUT_ASSET_ID)
            ? `buyer has resolved the ${PAYOUT_TICKER} contract — the cron opened it a channel in the served asset after all`
            : `buyer never resolved the ${PAYOUT_TICKER} contract ✓ — it only ever held ${BRIDGE_TICKER}`,
          buyerAssetIds.includes(PAYOUT_ASSET_ID) ? 'info' : 'success',
        );

        // ── Refund leg: the same conversion, in the other direction ────────
        // The merchant holds only payout asset and the buyer is paid out in the
        // bridge asset, so the LSP converts payout → bridge. Which asset the
        // buyer receives is the LSP's per-account payout asset, derived from the
        // channels it holds with that peer — hence PAYOUT_ASSET_PREFERENCE.
        setPhase('refund_register');
        req('lspA.connect');
        await lspA.connect();
        res('lspA.connect');
        req('lspA.enableLightningAddress');
        const buyerAddr = await lspA.enableLightningAddress();
        setBuyerAddress(buyerAddr.address);
        res('enableLightningAddress (buyer)', { address: buyerAddr.address, unusedHashes: buyerAddr.unusedHashes });

        const refundBridgeBefore = Number((await wA.getAssetBalance(BRIDGE_ASSET_ID))?.offchainOutbound ?? 0);
        const refundPayoutBefore = Number((await wA.getAssetBalance(PAYOUT_ASSET_ID).catch(() => null))?.offchainOutbound ?? 0);

        setPhase('refund');
        req('lspB.discoverAddress', { address: buyerAddr.address });
        const refundDiscovery = await lspB.discoverAddress(buyerAddr.address);
        res('discoverAddress (buyer)', {
          payoutAsset: refundDiscovery.payoutAsset?.ticker ?? '(none advertised)',
          accepted: (refundDiscovery.acceptedAssets ?? []).map(a => a.ticker ?? short(a.assetId)).join(','),
        });
        if (refundDiscovery.payoutAsset?.assetId !== BRIDGE_ASSET_ID) {
          addLog(
            `Buyer's payout asset is ${refundDiscovery.payoutAsset?.ticker ?? '(unknown)'}, not ${BRIDGE_TICKER} — ` +
            'refund will arrive unconverted. Set CONVERTIBLE_ASSET_IDS / PAYOUT_ASSET_PREFERENCE on utexo-lsp.',
          );
        }

        // The RGB amount rides an HTLC, so the outbound leg needs *sats* on the
        // LSP's side of the buyer's channel — asset balance alone delivers
        // nothing. utexo-lsp only discovers a shortfall as a bare NoRoute from
        // /sendpayment, retried until expiry, so check it here where the numbers
        // can still be named.
        const buyerChannels = await wA.listChannels();
        const bridgeChannel = buyerChannels.find(c => c.assetId === BRIDGE_ASSET_ID);
        const lspOutboundMsat = Number(bridgeChannel?.inboundBalanceMsat ?? 0);
        addLog(`LSP outbound on the buyer ${BRIDGE_TICKER} channel: ${lspOutboundMsat} msat (refund needs ${refundMsat})`);
        if (lspOutboundMsat < refundMsat) {
          throw new Error(
            `refund leg: the LSP holds only ${lspOutboundMsat} msat on the buyer's ${BRIDGE_TICKER} channel, ` +
            `below the ${refundMsat} msat this refund carries. The buyer opens that channel with ` +
            'aChannelPushMsat — raise it (a 1% channel reserve is unspendable on top).',
          );
        }

        req('lspB.payAddress (refund, asset selected by SDK)', {
          address: buyerAddr.address, amtMsat: refundMsat, assetAmount: refundAssetAmount,
        });
        const { invoice: refundInvoice, sendResult: refundRes, assetSelection: refundSelection } =
          await lspB.payAddress({
            address: buyerAddr.address,
            amtMsat: refundMsat,
            asset: { assetAmount: refundAssetAmount },
          });
        if (!refundInvoice) throw new Error('refund leg: payAddress returned no invoice');
        if (refundSelection) {
          addLog(
            `SDK quoted the refund in ${refundSelection.asset?.ticker ?? short(refundSelection.assetId)} ` +
            `(local ${refundSelection.localAssetAmount}) — ` +
            (refundSelection.converted
              ? `LSP converts 1:1 to ${refundDiscovery.payoutAsset?.ticker ?? 'the buyer payout asset'}`
              : 'no conversion, same asset on both legs'),
            'success',
          );
        }
        const refundPHash = refundRes.txid ?? '';
        setRefundHash(refundPHash);
        res('payAddress (refund)', { status: refundRes.status, paymentHash: short(refundPHash) });
        if (String(refundRes.status ?? '').toLowerCase() === 'failed') {
          throw new Error(
            `refund leg: payAddress failed — merchant needs spendable ${PAYOUT_TICKER} and the LSP needs ` +
            `${BRIDGE_TICKER} on the buyer's channel.`,
          );
        }

        setPhase('refund_settle');
        addLog('Refund paid — waiting for the outbound leg to the buyer…');
        const refundDeadline = Date.now() + SETTLE_TIMEOUT_MS;
        let refundSettled = false;
        let refundReconnect = 0;
        while (Date.now() < refundDeadline) {
          checkAbort();
          await sleep(POLL_MS);

          refundReconnect += POLL_MS;
          if (refundReconnect >= MERCHANT_KEEPALIVE_MS) {
            refundReconnect = 0;
            try { await lspA.connect(); } catch { /* already connected */ }
          }

          await wA.syncWallet();
          await wB.syncWallet();

          const status = refundPHash ? await wB.getLightningSendStatus(refundPHash) : 'Pending';
          setRefundStatus(status ?? 'Pending');
          addLog(`merchant getLightningSendStatus (refund): ${status}`);

          const bridgeBal = await wA.getAssetBalance(BRIDGE_ASSET_ID).catch(() => null);
          const payoutBal = await wA.getAssetBalance(PAYOUT_ASSET_ID).catch(() => null);
          const bridgeAfter = Number(bridgeBal?.offchainOutbound ?? 0);
          const payoutAfter = Number(payoutBal?.offchainOutbound ?? 0);
          if (bridgeBal) setRefundBalA(bridgeBal);

          if (status === 'Succeeded' && bridgeAfter > refundBridgeBefore) {
            refundSettled = true;
            addLog(`buyer received +${fmtBridge(bridgeAfter - refundBridgeBefore)} — reverse conversion confirmed ✓`, 'success');
            break;
          }
          if (status === 'Succeeded' && payoutAfter > refundPayoutBefore) {
            refundSettled = true;
            addLog(`buyer received +${fmtPayout(payoutAfter - refundPayoutBefore)} — refund arrived unconverted`, 'success');
            break;
          }
          if (status === 'Failed') throw new Error('refund leg: merchant payment Failed during LSP settlement');
        }
        if (!refundSettled) {
          throw new Error(
            'refund leg: timeout waiting for settlement — check the utexo-lsp outbox job. A repeating ' +
            `NoRoute means the LSP cannot reach the buyer in ${BRIDGE_TICKER}; the merchant's HODL is not ` +
            'lost, it expires and is refunded, but the outbox retries until then.',
          );
        }

        const buyerSnapRefund = await snapshotRgbBalances(wA, BRIDGE_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'END (after refund)', buyerSnapRefund, addLog);
        logRgbBalanceDelta(`buyer (${BRIDGE_TICKER}, refund)`, buyerSnapEnd, buyerSnapRefund, addLog);

        // ── Top-up: paid on-chain in the bridge asset, delivered in the payout ──
        // The merchant names only the payout asset. The LSP resolves the
        // on-chain leg from its own CONVERTIBLE_PAIRS, so the RGB invoice comes
        // back in the bridge asset — an id the merchant never configured. The
        // payer is the Faucet: a plain RLN node with no channel to anyone.
        setPhase('topup');
        const topupBefore = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('merchant', 'START (pre-topup)', topupBefore, addLog);

        req('lspB.receiveAsset (on-chain asset left to the LSP)', {
          assetId: short(PAYOUT_ASSET_ID, 20), amountRgb: topupAssetAmount, amountSats: topupMsat / 1000,
        });
        const topup = await lspB.receiveAsset({
          assetId: PAYOUT_ASSET_ID,
          amountSats: topupMsat / 1000,
          amountRgb: topupAssetAmount,
        });
        res('receiveAsset', {
          rgbInvoice: short(topup.rgbInvoice, 32),
          onchainAssetId: short(topup.onchainAssetId ?? '(not reported)', 20),
          converted: topup.converted,
        });

        if (!topup.converted) {
          throw new Error(
            'top-up leg: the LSP quoted the on-chain leg in the payout asset, not the bridge asset. Either ' +
            'CONVERTIBLE_PAIRS is not declared for it, or utexo-lsp predates convertible lightning_receive.',
          );
        }
        if (topup.onchainAssetId && topup.onchainAssetId !== BRIDGE_ASSET_ID) {
          throw new Error(
            `top-up leg: LSP resolved the on-chain asset to ${topup.onchainAssetId}, expected ${BRIDGE_ASSET_ID}`,
          );
        }
        addLog(
          `Merchant asked to be paid ${fmtPayout(topupAssetAmount)} and was handed an RGB invoice in ` +
          `${BRIDGE_TICKER} — resolved by the LSP, never named by the client ✓`,
          'success',
        );

        // Read the assignment back off the invoice rather than assuming it: a
        // converted receive is pinned to Fungible/<amount>, which is the only
        // thing tying what the Faucet sends to what the LSP will pay out.
        req('faucet.decodeRgbInvoice (top-up)');
        const topupDecoded = await faucet.decodeRgbInvoice(topup.rgbInvoice);
        const topupAssignment = topupDecoded.assignment ?? { type: 'Fungible', value: topupAssetAmount };
        const topupEndpoints = topupDecoded.transport_endpoints ?? [];
        res('faucet.decodeRgbInvoice', {
          recipientId: short(String(topupDecoded.recipient_id ?? ''), 24),
          assignment: JSON.stringify(topupAssignment),
        });
        if (String(topupAssignment?.type ?? '').toLowerCase() !== 'fungible') {
          addLog(
            `top-up leg: RGB invoice assignment is ${JSON.stringify(topupAssignment)}, not a pinned amount — ` +
            'the inbound quantity is unverified against the LN leg.',
            'error',
          );
        }

        req('faucet.sendRgb (top-up)', { asset: BRIDGE_TICKER, amount: topupAssetAmount });
        await faucet.sendRgb({
          donation: false, fee_rate: FEE_RATE, min_confirmations: 1, skip_sync: false,
          recipient_map: {
            [BRIDGE_ASSET_ID]: [{
              recipient_id: topupDecoded.recipient_id,
              assignment: topupAssignment,
              transport_endpoints: topupEndpoints,
            }],
          },
        });
        res('faucet.sendRgb (top-up)');
        await sleep(2000);
        await faucet.refresh().catch(() => {});

        addLog(`Waiting for the LSP to settle the ${BRIDGE_TICKER} leg on-chain and deliver ${PAYOUT_TICKER}…`);
        req('lspB.awaitReceiveSettlement');
        const topupOutcome = await lspB.awaitReceiveSettlement(topup.lnInvoice, {
          timeoutMs: ONCHAIN_SETTLE_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onEachPoll: async () => {
            await faucet.refresh().catch(() => {});
            try { await lspB.connect(); } catch { /* already connected */ }
          },
          onProgress: s => addLog(`merchant lightning_receive status: ${s}`),
        });
        res('awaitReceiveSettlement', { outcome: topupOutcome });
        if (topupOutcome !== 'settled') {
          throw new Error(
            'top-up leg: timed out waiting for delivery. The RGB leg may still be unconfirmed, or the LSP ' +
            `may be short of ${PAYOUT_TICKER} on the merchant's channel.`,
          );
        }

        await wB.syncWallet();
        await wB.refreshWallet();
        const topupAfter = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
        setTopupBalB(topupAfter);
        logRgbBalanceSnap('merchant', 'END (after topup)', topupAfter, addLog);
        logRgbBalanceDelta(`merchant (${PAYOUT_TICKER}, topup)`, topupBefore, topupAfter, addLog);

        const topupDelta = topupAfter.offchainOutbound - topupBefore.offchainOutbound;
        if (topupDelta <= 0) {
          throw new Error(
            `top-up leg: the LSP reported the receive as settled but the merchant's ${PAYOUT_TICKER} ` +
            `balance did not move (${topupBefore.offchainOutbound} → ${topupAfter.offchainOutbound}).`,
          );
        }
        addLog(
          `Merchant ${PAYOUT_TICKER} liquidity +${fmtPayout(topupDelta)} — paid on-chain in ${BRIDGE_TICKER} ✓`,
          'success',
        );

        // ── Recipient (C): plain APay, one asset on both legs ──────────────
        // A third node with no history, served the ordinary way. Both legs are
        // the payout asset, so no conversion is involved anywhere: the control
        // case proving the two-asset config did not break plain APay.
        setPhase('c_init');
        const keysC = await createWallet('utexo' as any);
        const portC = recipientPortBase + Math.floor(Math.random() * 1000);
        const wC = new UTEXOWallet(
          {
            storageDirPath: await mkDir('c'),
            daemonListeningPort: portC,
            ldkPeerListeningPort: portC + 1,
            network: 'utexo',
            lspBaseUrl: LSP_URL,
          },
          new PasswordRLNSigner('apaybridgesigC', keysC.mnemonic),
        );
        walletCRef.current = wC;
        const lspC = await wC.createLsp(LSP_PEER);
        await wC.init();
        await wC.unlock(UNLOCK);

        const cPubkey = String((await wC.getNodeInfo())?.pubkey ?? '');
        setPubkeyC(cPubkey);
        res('recipient.init', { pubkey: short(cPubkey) });

        setPhase('c_fund');
        const addrC = await wC.getAddress();
        req('faucet.sendBtc recipient', { amount: FAUCET_BTC_SAT, address: short(addrC, 18) });
        await faucet.sendBtc(addrC, FAUCET_BTC_SAT, FEE_RATE);
        res('faucet.sendBtc');
        await pollFunded(wC, 'recipient');

        setPhase('c_utxos');
        req('recipient.createUtxos', { num: UTXO_NUM, feeRate: FEE_RATE });
        await wC.syncWallet();
        await wC.refreshWallet();
        const cColoredBefore = await coloredSettledSat(wC);
        await wC.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
        res('recipient.createUtxos');
        await pollUtxosConfirmed(wC, 'recipient', cColoredBefore);

        setPhase('c_channel');
        req('lspC.connect');
        await lspC.connect();
        res('lspC.connect');

        addLog(
          `Waiting out CHANNEL_PROVISION_GRACE (${CHANNEL_PROVISION_GRACE_MS / 1000}s) — the cron cannot yet ` +
          'tell a peer about to fund its own channel from one waiting to be served, which is exactly the ' +
          'buyer/recipient distinction. The first minute of silence is expected, not a fault.',
        );
        const chanC = await lspC.waitForChannel(PAYOUT_ASSET_ID, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (msg: string) => addLog(`recipient ${msg}`),
          onEachPoll: channelPollKeepalive(wC, lspC, 'recipient'),
        });
        setChannelC(chanC);
        addLog(`Recipient on-chain ${PAYOUT_TICKER} channel usable ✓  cap=${chanC.capacitySat} sat`, 'success');

        setPhase('c_register');
        req('lspC.connect');
        await lspC.connect();
        res('lspC.connect');
        await sleep(1000);

        req('lspC.enableLightningAddress');
        const cAddr = await lspC.enableLightningAddress();
        setRecipientAddress(cAddr.address);
        res('enableLightningAddress (recipient)', { address: cAddr.address, unusedHashes: cAddr.unusedHashes });
        addLog(`Recipient Lightning Address: ${cAddr.address}`, 'success');

        // C must stay reachable: APay's second leg is the LSP paying C's node.
        startKeepalive(lspC);

        setPhase('c_pay');
        const recipientBefore = await snapshotRgbBalances(wC, PAYOUT_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('recipient', 'START (after channel)', recipientBefore, addLog);

        req('lspB.payAddress (merchant → recipient)', {
          address: cAddr.address, amtMsat: recipientMsat, assetAmount: recipientAssetAmount,
        });
        const { invoice: cInvoice, sendResult: cRes, assetSelection: cSelection } =
          await lspB.payAddress({
            address: cAddr.address,
            amtMsat: recipientMsat,
            asset: { assetAmount: recipientAssetAmount },
          });
        if (!cInvoice) throw new Error('recipient leg: payAddress returned no invoice');
        if (cSelection?.converted) {
          throw new Error(
            `recipient leg: the SDK quoted ${cSelection.asset?.ticker ?? cSelection.assetId} and the LSP would ` +
            `convert — both legs here should be ${PAYOUT_TICKER}. The recipient's payout asset was ` +
            'mis-derived, which usually means its channel is not usable yet.',
          );
        }
        const cPHash = cRes.txid ?? '';
        setRecipientHash(cPHash);
        res('payAddress (recipient)', { status: cRes.status, paymentHash: short(cPHash) });
        if (String(cRes.status ?? '').toLowerCase() === 'failed') {
          throw new Error(
            `recipient leg: payAddress failed — the merchant needs both spendable ${PAYOUT_TICKER} and ` +
            `${recipientMsat / 1000} sat of outbound on its own channel.`,
          );
        }

        setPhase('c_settle');
        addLog('Merchant paid — waiting for the LSP to deliver to the recipient…');
        const cDeadline = Date.now() + SETTLE_TIMEOUT_MS;
        let cSettled = false;
        while (Date.now() < cDeadline) {
          checkAbort();
          await sleep(POLL_MS);
          await wB.syncWallet();
          await wC.syncWallet();

          const status = cPHash ? await wB.getLightningSendStatus(cPHash) : 'Pending';
          setRecipientStatus(status ?? 'Pending');
          addLog(`merchant getLightningSendStatus (recipient): ${status}`);

          const cBal = await wC.getAssetBalance(PAYOUT_ASSET_ID).catch(() => null);
          if (cBal) setFinalBalC(cBal);
          if (status === 'Succeeded' && Number(cBal?.offchainOutbound ?? 0) > recipientBefore.offchainOutbound) {
            cSettled = true;
            break;
          }
          if (status === 'Failed') throw new Error('recipient leg: merchant payment Failed during LSP settlement');
        }
        if (!cSettled) {
          throw new Error(
            'recipient leg: timeout waiting for settlement. A NoRoute in the utexo-lsp outbox means the LSP ' +
            `is short of ${PAYOUT_TICKER} or sats on the recipient's channel.`,
          );
        }

        const recipientAfter = await snapshotRgbBalances(wC, PAYOUT_ASSET_ID, lspPeerPubkey);
        setFinalBalC(recipientAfter);
        logRgbBalanceSnap('recipient', 'END (settled)', recipientAfter, addLog);
        logRgbBalanceDelta(`recipient (${PAYOUT_TICKER})`, recipientBefore, recipientAfter, addLog);

        const cDelta = recipientAfter.offchainOutbound - recipientBefore.offchainOutbound;
        if (cDelta <= 0) {
          throw new Error(
            `recipient leg: payment reported Succeeded but the recipient's ${PAYOUT_TICKER} balance did not ` +
            `move (${recipientBefore.offchainOutbound} → ${recipientAfter.offchainOutbound}).`,
          );
        }
        addLog(`Recipient ${PAYOUT_TICKER} balance +${fmtPayout(cDelta)} — plain APay, no conversion ✓`, 'success');

        // ── /lightning_send: paying a plain BOLT11 out of the other asset ──
        // The mirror of the external-payer leg: there the external node was the
        // payer, here it is the payee. The buyer signs an ordinary bridge-asset
        // invoice — no LNURL, no APay, no SDK — and the merchant pays it holding
        // nothing but payout asset. The shared payment hash is the atomicity.
        //
        // Liquidity is the interesting part: the LSP delivers out of its own
        // side of the buyer's channel, which exists only because the buyer spent
        // through it earlier. It never provisioned a unit of the bridge asset.
        setPhase('ls_quote');
        const relayPayeeBefore = await snapshotRgbBalances(wA, BRIDGE_ASSET_ID, lspPeerPubkey);
        const relayPayerBefore = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'START (pre-relay)', relayPayeeBefore, addLog);
        addLog(
          `LSP holds ${fmtBridge(relayPayeeBefore.offchainInbound)} facing the buyer — that is what the ` +
          'relay is delivered from',
        );

        req('buyer.createLightningInvoice (plain BOLT11, no APay)', {
          assetId: short(BRIDGE_ASSET_ID, 20), assetAmount: relayAssetAmount, msat: relayMsat,
        });
        const relayTarget = await wA.createLightningInvoice({
          amountSats: relayMsat / 1000,
          expirySeconds: 3600,
          asset: { assetId: BRIDGE_ASSET_ID, amount: relayAssetAmount },
        });
        res('buyer.createLightningInvoice', { invoice: short(relayTarget.lnInvoice, 32) });

        req(`lspB.payExternalInvoice (merchant holds only ${PAYOUT_TICKER})`);
        const { quote: relayQuote, sendResult: relayRes } = await lspB.payExternalInvoice({
          invoice: relayTarget.lnInvoice,
        });
        res('payExternalInvoice', {
          payWith: relayQuote.inbound.assetId === PAYOUT_ASSET_ID ? PAYOUT_TICKER : short(relayQuote.inbound.assetId ?? ''),
          deliver: relayQuote.outbound.assetId === BRIDGE_ASSET_ID ? BRIDGE_TICKER : short(relayQuote.outbound.assetId ?? ''),
          converted: relayQuote.converted,
          paymentHash: short(relayQuote.paymentHash),
          status: relayRes.status,
        });

        if (!relayQuote.converted) {
          throw new Error(
            `relay leg: the LSP quoted the merchant in ${relayQuote.inbound.assetId}, the same asset it ` +
            'delivers — no conversion happened, so this leg proves nothing. Check CONVERTIBLE_PAIRS.',
          );
        }
        if (relayQuote.inbound.assetId !== PAYOUT_ASSET_ID) {
          throw new Error(
            `relay leg: the merchant holds only ${PAYOUT_TICKER} but was quoted ${relayQuote.inbound.assetId}`,
          );
        }
        if (relayQuote.outbound.assetId !== BRIDGE_ASSET_ID) {
          throw new Error(
            `relay leg: expected delivery in ${BRIDGE_TICKER}, LSP reported ${relayQuote.outbound.assetId}`,
          );
        }
        addLog(
          `Merchant pays ${fmtPayout(relayQuote.inbound.assetAmount ?? 0)}, buyer is delivered ` +
          `${fmtBridge(relayQuote.outbound.assetAmount ?? 0)} — one hash, verified locally against the ` +
          "buyer's invoice ✓",
          'success',
        );

        setPhase('ls_settle');
        addLog('Relay paid — LSP holds the HTLC until the buyer is paid…');

        // Two different questions, and the leg is only done when both answer
        // yes. `settled` is the LSP's own bookkeeping (it called
        // claimhodlinvoice); the payer's asset does not move at that instant,
        // its node still has to receive update_fulfill_htlc and re-derive the
        // channel's RGB balance. So wait on the money, not on the status.
        const relayDeadline = Date.now() + SETTLE_TIMEOUT_MS;
        let relayLspSettled = false;
        let relayPayeeAfter = relayPayeeBefore;
        let relayPayerAfter = relayPayerBefore;
        let relaySettled = false;
        while (Date.now() < relayDeadline) {
          checkAbort();
          await sleep(POLL_MS);
          await wA.syncWallet();
          await wB.syncWallet();
          await wB.refreshWallet();

          if (!relayLspSettled) {
            const st = await lspB.externalPaymentStatus(relayQuote.paymentHash);
            setRelayStatus(st.status);
            addLog(`lightning_send status: ${st.status}${st.reason ? ` (${st.reason})` : ''}`);

            if (st.status === 'settled') relayLspSettled = true;
            if (st.status === 'cancelled' || st.status === 'failed') {
              throw new Error(
                `relay leg: LSP reported ${st.status}${st.reason ? ` — ${st.reason}` : ''}. The merchant was ` +
                `refunded; the usual cause is the LSP being short of ${BRIDGE_TICKER} or sats on the ` +
                "buyer's channel.",
              );
            }
          }
          if (!relayLspSettled) continue;

          const payerStatus = await wB.getLightningSendStatus(relayQuote.paymentHash);
          relayPayeeAfter = await snapshotRgbBalances(wA, BRIDGE_ASSET_ID, lspPeerPubkey);
          relayPayerAfter = await snapshotRgbBalances(wB, PAYOUT_ASSET_ID, lspPeerPubkey);
          setRelayBalA(relayPayeeAfter);
          addLog(
            `merchant getLightningSendStatus: ${payerStatus} | ${PAYOUT_TICKER} outbound ` +
            `${relayPayerBefore.offchainOutbound}→${relayPayerAfter.offchainOutbound}`,
          );

          if (relayPayerAfter.offchainOutbound < relayPayerBefore.offchainOutbound) {
            relaySettled = true;
            break;
          }
          if (payerStatus === 'Failed') {
            throw new Error(
              "relay leg: the LSP claimed the HTLC but the merchant's node reports the payment Failed",
            );
          }
        }
        if (!relaySettled) {
          throw new Error(
            relayLspSettled
              ? `relay leg: the LSP settled and the buyer was paid, but the merchant's ${PAYOUT_TICKER} ` +
                'balance never moved — its node did not apply the fulfilled HTLC within the timeout.'
              : 'relay leg: timeout waiting for settlement — check the utexo-lsp lightning_send_pay_outbound job.',
          );
        }

        setRelayBalA(relayPayeeAfter);
        logRgbBalanceDelta(`merchant (${PAYOUT_TICKER}, relay)`, relayPayerBefore, relayPayerAfter, addLog);
        logRgbBalanceDelta(`buyer (${BRIDGE_TICKER}, relay)`, relayPayeeBefore, relayPayeeAfter, addLog);

        const relaySpent = relayPayerBefore.offchainOutbound - relayPayerAfter.offchainOutbound;
        const relayGained = relayPayeeAfter.offchainOutbound - relayPayeeBefore.offchainOutbound;
        if (relaySpent <= 0 || relayGained <= 0) {
          throw new Error(
            `relay leg: settled but the balances did not move as expected — merchant -${relaySpent} ` +
            `${PAYOUT_TICKER}, buyer +${relayGained} ${BRIDGE_TICKER}`,
          );
        }
        addLog(
          `Merchant -${fmtPayout(relaySpent)}, buyer +${fmtBridge(relayGained)} — a plain invoice paid out ` +
          'of an asset its payee never heard of ✓',
          'success',
        );

        setPhase('done');
      } finally {
        keepaliveActiveRef.current = false;
      }
    } catch (e: any) {
      addLog(`Fatal: ${e?.message ?? String(e)}`, 'error');
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, [
    addLog,
    paymentMsat, paymentAssetAmount, aFundUnits, aChannelCapacitySat, aChannelPushMsat,
    refundAssetAmount, refundMsat, topupAssetAmount, topupMsat,
    recipientAssetAmount, recipientMsat, relayAssetAmount, relayMsat,
    buyerPortBase, merchantPortBase, recipientPortBase, merchantKeepalive, storagePrefix, externalInvoice,
  ]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    keepaliveActiveRef.current = false;
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    if (walletCRef.current) { try { await walletCRef.current.destroy(); } catch {} walletCRef.current = null; }
    setPhase('idle');
    setLog([]); setErrorMsg('');
    setPubkeyB(''); setLightningAddress(''); setHashPoolInfo(null);
    setChannelB(null); setChannelA(null);
    setPaymentHash(''); setSendStatus(''); setFinalBalB(null);
    setBuyerAddress(''); setRefundHash(''); setRefundStatus(''); setRefundBalA(null);
    setTopupBalB(null);
    setPubkeyC(''); setChannelC(null); setRecipientAddress('');
    setRecipientHash(''); setRecipientStatus(''); setFinalBalC(null);
    setRelayStatus(''); setRelayBalA(null);
  }, []);

  return {
    phase,
    log,
    errorMsg,
    run,
    reset,
    pubkeyB,
    lnAddress: lightningAddress,
    hashPoolInfo,
    channelB,
    channelA,
    paymentHash,
    sendStatus,
    finalBalB,
    buyerAddress,
    refundHash,
    refundStatus,
    refundBalA,
    topupBalB,
    pubkeyC,
    channelC,
    recipientAddress,
    recipientHash,
    recipientStatus,
    finalBalC,
    relayStatus,
    relayBalA,
    envReady,
    bridgeTicker: BRIDGE_TICKER,
    payoutTicker: PAYOUT_TICKER,
    isRunning: !['idle', 'done', 'error'].includes(phase),
  };
}
