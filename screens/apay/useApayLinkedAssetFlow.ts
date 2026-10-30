/**
 * APay Bridge-Asset checkout — see docs/apay-linked-asset-mvp.md and
 * docs/apay-linked-asset-options.uk.md (option A, as revised in §10).
 *
 * Two assets, both ordinary IFA contracts issued on the Faucet and unrelated to
 * each other. What makes them interchangeable is utexo-lsp's CONVERTIBLE_PAIRS;
 * no RGB Asset Link is involved anywhere in this flow.
 *
 * Both legs are real on-chain RGB channels, no virtual channels anywhere:
 *  - LSP → B (merchant): unchanged mechanism (the LSP's own cron opens it,
 *    same as every other APay flow) — just the payout asset (LNUSDT, the only
 *    one this stack serves) and a regular, not trusted_no_broadcast, channel.
 *    Requires `TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh`.
 *  - A (buyer) → LSP: A opens this itself, funded in the *bridge* asset
 *    (BUSDT) — genuine self-funded outbound capacity, not LSP-pushed
 *    liquidity. A receives BUSDT on-chain from the Faucet first, then colors
 *    its own channel-open with it.
 *
 * The buyer has no LNUSDT to spend, so the conversion happens on the LSP's
 * books, between the two legs of one APay payment:
 *
 *     A --(BUSDT)--> LSP        inbound leg, quoted by the LNURL callback
 *     LSP --(LNUSDT)--> B       outbound leg, always the merchant's payout asset
 *
 * Both are ordinary single-hop payments; atomicity comes from the shared
 * payment hash (the LSP claims the buyer's HODL only after B revealed the
 * preimage), not from Lightning routing. The node-level linked-asset swap is
 * NOT involved and could not be even if the assets were linked: the invoice is
 * hosted, so the payee is the LSP, and `find_linked_asset_channel` drops every
 * channel whose counterparty is the payee — which is all of A's.
 *
 * Which asset to be quoted in is the payer's decision, made here by the SDK:
 * `lspA.payAddress` with an asset amount but no assetId reads the merchant's
 * payout asset from LNURL discovery, checks local liquidity, and falls back to
 * the bridge asset discovery advertises as accepted — conversion is the
 * fallback, never the default.
 *
 * `externalInvoice: true` flips that around: the *merchant* quotes with
 * `lspB.requestExternalInvoice` and the buyer settles the resulting BOLT11 with
 * a bare `payLightningInvoice`. The invoice is hosted either way, so this is
 * what a payer that only speaks `/sendpayment` — no LNURL, no SDK — would do.
 *
 * The flow then exercises two more directions against the same stack:
 *  - top-up: B calls `receiveAsset` naming only LNUSDT, the LSP issues the RGB
 *    invoice in BUSDT, and the Faucet pays it on-chain — conversion inbound.
 *  - recipient C: a third node served the ordinary way (connect, cron opens it
 *    an LNUSDT channel, it registers an address, B pays it). Both legs LNUSDT,
 *    no conversion at all — the control case proving the two-asset config did
 *    not break plain APay.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { mine, sendToAddress } from '@/utils/wallet-flow';
import { createWallet, PasswordRLNSigner, UTEXOWallet, type LspPeer } from '@utexo/rgb-sdk-rn';

import { faucet } from '../lsp-regtest/daemons';
import { logRgbBalanceDelta, logRgbBalanceSnap, snapshotRgbBalances } from './balance';
import {
  formatAssetAmount,
  host,
  BRIDGE_ASSET,
  LSP_LDK_PORT,
  LSP_URL,
  MERCHANT_KEEPALIVE_MS,
  normHash,
  ONCHAIN_SETTLE_TIMEOUT_S,
  POLL_INTERVAL_MS,
  REGTEST_UNLOCK,
  SETTLE_TIMEOUT_S,
  short,
  sleep,
  toDaemonUrl,
  type LogEntry,
} from './config';

const CHANNEL_TIMEOUT_S = 240; // real (confirmed) channels, not 0-conf virtual — see doc "Open items"

export type LinkedPhase =
  | 'idle'
  | 'b_init' | 'b_fund' | 'b_utxos' | 'b_channel' | 'register'
  | 'a_init' | 'a_fund' | 'a_utxos' | 'a_asset_receive' | 'a_channel'
  | 'send' | 'settle'
  | 'refund_register' | 'refund' | 'refund_settle'
  | 'topup'
  | 'c_init' | 'c_fund' | 'c_utxos' | 'c_channel' | 'c_register' | 'c_pay' | 'c_settle'
  | 'ls_quote' | 'ls_settle'
  | 'done' | 'error';

export const LINKED_PHASE_LABELS: Record<LinkedPhase, string> = {
  idle: 'Idle',
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

export type UseApayLinkedAssetFlowOptions = {
  storagePrefix?: string;
  merchantPortBase?: number;
  buyerPortBase?: number;
  recipientPortBase?: number;
  merchantKeepalive?: boolean;
  setupScriptHint?: string;
  /**
   * Quote the cart with `lspB.requestExternalInvoice` and let the buyer settle
   * the raw BOLT11, instead of `lspA.payAddress`.
   *
   * Same two legs and the same conversion — what changes is who chooses the
   * asset and how much the payer has to know. Models a payer that only has
   * `/sendpayment`: no LNURL discovery, no asset selection, no LSP client.
   */
  externalInvoice?: boolean;
};

export function useApayLinkedAssetFlow(options: UseApayLinkedAssetFlowOptions = {}) {
  const {
    storagePrefix = 'apay_linked',
    merchantPortBase = 49000,
    buyerPortBase = 51000,
    recipientPortBase = 53000,
    merchantKeepalive = true,
    setupScriptHint = 'TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh',
    externalInvoice = false,
  } = options;

  const {
    bridgeAssetId, bridgeTicker, payoutAssetId, payoutTicker, precision,
    paymentMsat, paymentAssetAmount, aFundUnits, aChannelCapacitySat, aChannelPushMsat,
    refundAssetAmount, refundMsat, topupAssetAmount, topupMsat,
    recipientAssetAmount, recipientMsat, relayAssetAmount, relayMsat,
  } = BRIDGE_ASSET;

  const envReady = !!bridgeAssetId && !!payoutAssetId;
  const logTag = 'apay-linked';

  const [phase, setPhase] = useState<LinkedPhase>('idle');
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

    const req =(label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');
    const fmtPayout = (units: number) => `${formatAssetAmount(units, precision)} ${payoutTicker}`;
    const fmtBridge = (units: number) => `${formatAssetAmount(units, precision)} ${bridgeTicker}`;

    try {
      if (!envReady) {
        throw new Error(
          `Missing BRIDGE_ASSET_ID/IFA_ASSET_ID — run: ${setupScriptHint}`,
        );
      }

      req('GET /get_info (LSP pubkey)');
      const lspInfo = await fetch(`${LSP_URL}/get_info`).then(r => r.json()) as { pubkey?: string };
      const lspPeerPubkey = lspInfo?.pubkey ?? '';
      if (!lspPeerPubkey) throw new Error('Could not fetch LSP pubkey — is the LSP stack running?');
      res('LSP pubkey', { pubkey: short(lspPeerPubkey) });
      const lspPeerUri = `${lspPeerPubkey}@${host}:${LSP_LDK_PORT}`;
      // Explicit-peer form of createLsp() — the no-arg (auto-discovery) form
      // unconditionally calls enableVirtualChannelsForPeer(), which forces
      // enable_virtual_channels_v0=true on the calling node toward this LSP
      // pubkey (rgb-sdk-rn utexo-wallet.ts:921-934, no opt-out). That flag
      // makes the accept side require option_scid_alias on *every* inbound
      // channel from this peer, virtual or not — option_scid_alias only
      // gets negotiated on private channels, so a public regular channel
      // (like B's below) gets rejected with "unsupported_scid_alias".
      // Passing the peer explicitly skips that call entirely — confirmed
      // this is the same pattern lsp-regtest/useLspFlow.ts already uses.
      const LSP_PEER: LspPeer = { baseUrl: LSP_URL, peerPubkey: lspPeerPubkey, peerHost: host, peerPort: LSP_LDK_PORT };

      // ── Merchant wallet (B) — unchanged mechanism, payout asset, no virtual ──
      setPhase('b_init');
      const keysB = await createWallet('regtest' as any);
      const portB = merchantPortBase + Math.floor(Math.random() * 2000);
      const dirB = `${documentDirectory ?? ''}${storagePrefix}_b_${Date.now()}`;
      await FileSystem.makeDirectoryAsync(dirB, { intermediates: true });

      const wB = new UTEXOWallet(
        {
          storageDirPath: dirB.replace('file://', ''),
          daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1,
          network: 'regtest',
          lspBaseUrl: LSP_URL,
          // No enableVirtualChannelsV0 / virtualPeerPubkeys — nothing virtual in this flow.
        },
        new PasswordRLNSigner('apaylinkedB', keysB.mnemonic),
      );
      walletBRef.current = wB;
      const lspB = await wB.createLsp(LSP_PEER);
      await wB.init();
      await wB.unlock(REGTEST_UNLOCK);

      const bPubkey = String((await wB.getNodeInfo())?.pubkey ?? '');
      setPubkeyB(bPubkey);
      res('merchant.init', { pubkey: short(bPubkey) });

      setPhase('b_fund');
      const addrB = await wB.getAddress();
      req('sendToAddress merchant 1 BTC');
      await sendToAddress(addrB, 1);
      await mine(6);
      await sleep(3000);
      await wB.syncWallet();
      res('merchant.funded');

      setPhase('b_utxos');
      req('merchant.createUtxos');
      await wB.syncWallet();
      await wB.refreshWallet();
      await wB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await wB.syncWallet();
      res('merchant.createUtxos');

      setPhase('b_channel');
      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');

      addLog(`Mining blocks — the LSP cron opens a real on-chain ${payoutTicker} channel to the merchant…`);
      await mine(2);
      await sleep(6000);

      addLog(`Waiting for confirmed ${payoutTicker} channel…`);
      const chanB = await lspB.waitForChannel(payoutAssetId, {
        timeoutMs: CHANNEL_TIMEOUT_S * 1000,
        pollIntervalMs: POLL_INTERVAL_MS,
        onProgress: (msg: string) => addLog(`merchant ${msg}`),
        onEachPoll: () => mine(1),
      });
      setChannelB(chanB);
      addLog(`Merchant on-chain ${payoutTicker} channel usable ✓  cap=${chanB.capacitySat} sat`, 'success');

      const merchantSnapStart = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
      logRgbBalanceSnap('merchant', 'START (after channel)', merchantSnapStart, addLog);

      await wB.syncWallet();
      await mine(2);
      await sleep(5000);

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
        addLog('Merchant keepalive: lsp.connect() every 15s', 'info');
        (async () => {
          while (keepaliveActiveRef.current && !abortRef.current) {
            await sleep(MERCHANT_KEEPALIVE_MS);
            if (!keepaliveActiveRef.current || abortRef.current) break;
            try { await lspB.connect(); } catch { /* already connected */ }
          }
        })();
      }

      try {
        // ── Buyer wallet (A) ────────────────────────────────────────────────
        setPhase('a_init');
        const keysA = await createWallet('regtest' as any);
        const portA = buyerPortBase + Math.floor(Math.random() * 2000);
        const dirA = `${documentDirectory ?? ''}${storagePrefix}_a_${Date.now()}`;
        await FileSystem.makeDirectoryAsync(dirA, { intermediates: true });

        const wA = new UTEXOWallet(
          {
            storageDirPath: dirA.replace('file://', ''),
            daemonListeningPort: portA,
            ldkPeerListeningPort: portA + 1,
            network: 'regtest',
            lspBaseUrl: LSP_URL,
          },
          new PasswordRLNSigner('apaylinkedA', keysA.mnemonic),
        );
        walletARef.current = wA;
        const lspA = await wA.createLsp(LSP_PEER);
        await wA.init();
        await wA.unlock(REGTEST_UNLOCK);
        res('buyer.init', { pubkey: short(String((await wA.getNodeInfo())?.pubkey ?? '')) });

        setPhase('a_fund');
        const addrA = await wA.getAddress();
        req('sendToAddress buyer 1 BTC');
        await sendToAddress(addrA, 1);
        await mine(6);
        await sleep(3000);
        await wA.syncWallet();
        res('buyer.funded');

        setPhase('a_utxos');
        req('buyer.createUtxos');
        await wA.syncWallet();
        await wA.refreshWallet();
        await wA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
        await mine(1);
        await wA.syncWallet();
        res('buyer.createUtxos');

        // ── Buyer receives the BRIDGE asset on-chain from Faucet ────────────
        // The Faucet issues the bridge asset in this stack
        // (`TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh`), so this is the same
        // hand-out every other demo flow does. Plain on-chain RGB receive
        // (blind), not lightning_receive: A needs colored UTXOs of the bridge
        // asset *before* it can fund a channel with them — there is no channel
        // yet at this point.
        setPhase('a_asset_receive');
        // "Any asset" invoice — A's wallet has never seen the bridge contract
        // yet, and requesting a specific assetId 403s (UnknownContractId).
        // Mirrors start-lsp-regtest.sh's own bootstrap-transfer invoice: the
        // sender (Faucet, below) supplies the real assetId + amount via
        // /sendrgb's recipient_map, which is what registers the contract
        // with A's wallet on receipt.
        req('buyer.onchainReceive (any asset)');
        const recv = await wA.onchainReceive({
          durationSeconds: 3600,
          minConfirmations: 1,
          witness: false,
        });
        res('buyer.onchainReceive', { invoice: short(recv.invoice, 32) });

        req('faucet.decodergbinvoice');
        const decoded = await faucet.decodeRgbInvoice(recv.invoice);
        const recipientId = decoded.recipient_id ?? recv.recipientId;
        // A's node minted this invoice, so on Android its endpoints say
        // 10.0.2.2 — an alias only the emulator understands. The faucet runs on
        // the dev machine and needs 127.0.0.1.
        const transportEndpoints = (decoded.transport_endpoints ?? [`rpc://${host}:3000/json-rpc`])
          .map(toDaemonUrl);
        res('faucet.decodergbinvoice', { recipientId: short(recipientId, 24) });

        req('faucet.sendrgb', { amount: aFundUnits, recipientId: short(recipientId, 20) });
        await faucet.sendRgb({
          donation: false, fee_rate: 7, min_confirmations: 1, skip_sync: false,
          recipient_map: {
            [bridgeAssetId]: [{
              recipient_id: recipientId,
              assignment: { type: 'Fungible', value: aFundUnits },
              transport_endpoints: transportEndpoints,
            }],
          },
        });
        res('faucet.sendrgb');

        await mine(1);
        await sleep(2000);
        await faucet.refresh();

        addLog(`Waiting for buyer ${bridgeTicker} receive to settle…`);
        const recvDeadline = Date.now() + SETTLE_TIMEOUT_S * 1000;
        let recvSettled = false;
        while (Date.now() < recvDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await mine(1);
          await sleep(POLL_INTERVAL_MS);
          await wA.syncWallet();
          await wA.refreshWallet();
          await faucet.refresh();
          const bal = await wA.getAssetBalance(bridgeAssetId).catch(() => null);
          addLog(`buyer ${bridgeTicker} spendable: ${bal?.spendable ?? 0} / ${aFundUnits}`);
          if (Number(bal?.spendable ?? 0) >= aFundUnits) { recvSettled = true; break; }
        }
        if (!recvSettled) throw new Error(`Buyer ${bridgeTicker} receive did not settle in time`);
        addLog(`Buyer received ${fmtBridge(aFundUnits)} on-chain ✓`, 'success');

        // The blind receive above burned one of the uncolored UTXOs a_utxos
        // created (same reason start-lsp-regtest.sh sizes LSP_UTXO_NUM/
        // FAUCET_UTXO_NUM generously: "each blinded receive burns one UTXO").
        // Top up before the channel-open needs a plain uncolored UTXO for
        // the BTC side of the funding tx.
        req('buyer.createUtxos (post-receive top-up)');
        await wA.syncWallet();
        await wA.createUtxos({ upTo: false, num: 5, feeRate: 7 });
        await mine(1);
        await wA.syncWallet();
        res('buyer.createUtxos');

        // ── Buyer opens its OWN channel to the LSP, funded in the bridge asset ──
        // Client-initiated, not LSP-pushed — genuine self-funded outbound
        // capacity. No --enable-virtual-channels-v0 anywhere in this stack, so
        // the LSP's accept side takes this as a plain regular channel.
        setPhase('a_channel');
        req('buyer.connectPeer', { lspPeerUri: short(lspPeerUri, 40) });
        try { await wA.connectPeer(lspPeerUri); } catch { /* already connected */ }
        res('buyer.connectPeer');

        req('buyer.openChannel', { assetId: short(bridgeAssetId), assetLocalAmount: aFundUnits, capacitySat: aChannelCapacitySat });
        const openResp = await wA.openChannel({
          peerPubkey: lspPeerUri,
          capacitySat: aChannelCapacitySat,
          pushMsat: aChannelPushMsat,
          isPublic: false,
          withAnchors: true,
          assetId: bridgeAssetId,
          assetLocalAmount: aFundUnits,
        });
        res('buyer.openChannel', { temporaryChannelId: short(openResp.temporaryChannelId, 24) });

        addLog('Mining blocks for buyer channel-open confirmation…');
        await mine(2);
        await sleep(6000);

        const chanA = await lspA.waitForChannel(bridgeAssetId, {
          timeoutMs: CHANNEL_TIMEOUT_S * 1000,
          pollIntervalMs: POLL_INTERVAL_MS,
          onProgress: (msg: string) => addLog(`buyer ${msg}`),
          onEachPoll: () => mine(1),
        });
        setChannelA(chanA);
        addLog(`Buyer self-opened ${bridgeTicker} channel usable ✓`, 'success');

        const buyerSnapStart = await snapshotRgbBalances(wA, bridgeAssetId, lspPeerPubkey);
        const merchantSnapCheckout = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'START (pre-checkout)', buyerSnapStart, addLog);
        logRgbBalanceSnap('merchant', 'START (pre-checkout)', merchantSnapCheckout, addLog);

        let balBefore = Number((await wB.getAssetBalance(payoutAssetId))?.offchainOutbound ?? 0);

        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();

        if (!lnAddr.address) throw new Error('Lightning Address missing');

        // ── Discovery: what is this address actually paid out in? ───────────
        // Nothing below hardcodes an asset. The merchant's payout asset comes
        // from the LSP, and the buyer's wallet decides what to be quoted in.
        setPhase('send');
        req('lspA.discoverAddress', { address: lnAddr.address });
        const discovery = await lspA.discoverAddress(lnAddr.address);
        res('discoverAddress', {
          payoutAsset: discovery.payoutAsset?.ticker ?? '(none advertised)',
          accepted: (discovery.acceptedAssets ?? []).map(a => a.ticker ?? short(a.assetId)).join(','),
        });
        if (!discovery.payoutAsset) {
          throw new Error(
            'Discovery advertises no payout asset — the merchant channel is not up, or utexo-lsp predates payout_asset.',
          );
        }

        let invoice: string;
        let payRes: any;

        if (externalInvoice) {
          // ── The merchant quotes, an APay-unaware node pays ────────────────
          // requestExternalInvoice hands back the hosted BOLT11 instead of
          // paying it. The asset comes from LNURL discovery, not from config:
          // with no `asset` argument it takes the single convertible asset the
          // merchant's address advertises, which is exactly BUSDT here.
          //
          // The buyer then settles it as a plain invoice — no LNURL, no asset
          // selection, no LSP client at all. That is all an external
          // `POST /sendpayment` would do, and it is why this path is worth
          // demonstrating: the RGB contract id and amount ride inside the
          // BOLT11, so the payer needs nothing else.
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
            invoice: short(invoice, 32),
          });
          addLog(
            `Merchant quoted ${formatAssetAmount(paymentAssetAmount, precision)} ` +
            `${ext.asset?.ticker ?? bridgeTicker} for an external payer — ` +
            (ext.converted ? `LSP converts 1:1 to ${payoutTicker}` : 'no conversion'),
            'success',
          );
          addLog(`External node would run: POST /sendpayment {"invoice":"${short(invoice, 24)}"}`, 'info');

          req('buyer.payLightningInvoice (no LSP client involved)');
          payRes = await wA.payLightningInvoice({ lnInvoice: invoice });
          res('payLightningInvoice', { status: payRes.status });
        } else {
          // ── Pay, letting the SDK choose the inbound asset ─────────────────
          // The buyer holds only BUSDT, so selection lands on the bridge asset
          // and the LSP converts 1:1 on its books. Had the buyer held
          // enough of the payout asset, the very same call would have quoted
          // that instead, with no conversion and no rate to trust.
          req('lspA.payAddress (asset selected by SDK)', { address: lnAddr.address, amtMsat: paymentMsat, assetAmount: paymentAssetAmount });
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
            `Cart payment failed — check the buyer has spendable ${bridgeTicker} and that utexo-lsp lists the pair in CONVERTIBLE_PAIRS.`,
          );
        }
        addLog('Cart paid — HTLC held at LSP, waiting for the outbound leg to the merchant…', 'success');
        await sleep(3000);

        setPhase('settle');
        addLog('Waiting for LSP outbox settlement…');
        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();
        await wB.refreshWallet();
        await mine(1);

        const deadline = Date.now() + SETTLE_TIMEOUT_S * 1000;
        let settled = false;
        let reconnectEvery = 0;
        while (Date.now() < deadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_INTERVAL_MS);
          await mine(1);

          reconnectEvery += POLL_INTERVAL_MS;
          if (reconnectEvery >= MERCHANT_KEEPALIVE_MS) {
            reconnectEvery = 0;
            await lspB.connect();
            addLog('lspB.connect (settle keepalive)');
          }

          await wA.syncWallet();
          await wB.syncWallet();
          await wB.refreshWallet();

          const status = pHash ? await wA.getLightningSendStatus(pHash) : 'Pending';
          setSendStatus(status ?? 'Pending');
          addLog(`buyer getLightningSendStatus: ${status}`);

          let balAfter = balBefore;
          const b1 = await wB.getAssetBalance(payoutAssetId).catch(() => null);
          if (b1) { balAfter = Number(b1.offchainOutbound ?? 0); setFinalBalB(b1); }

          const pays = await wB.listPayments().catch(() => []);
          const mp = pays.find(p => normHash(p.paymentHash) === normHash(pHash));
          if (mp) addLog(`merchant inbound: ${mp.paymentType}/${mp.status}`, 'info');

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

        const buyerSnapEnd = await snapshotRgbBalances(wA, bridgeAssetId, lspPeerPubkey);
        const merchantSnapEnd = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'END (settled)', buyerSnapEnd, addLog);
        logRgbBalanceSnap('merchant', 'END (settled)', merchantSnapEnd, addLog);
        logRgbBalanceDelta(`buyer (${bridgeTicker})`, buyerSnapStart, buyerSnapEnd, addLog);
        logRgbBalanceDelta(`merchant (${payoutTicker})`, merchantSnapCheckout, merchantSnapEnd, addLog);

        // What contracts does the buyer's node actually hold? With the cron no
        // longer pushing it a channel in the served asset, the answer should be
        // "only the bridge asset" — it received, spent and was refunded in that
        // one asset and never resolved the other contract.
        //
        // Worth asserting rather than assuming: it is the observable proof that
        // CHANNEL_PROVISION_GRACE + the payout-asset rule kept the cron off a
        // self-provisioned peer (docs/apay-linked-asset-options.uk.md §9.2.1),
        // and it keeps the buyer's wallet minimal — one contract for one asset
        // it actually uses.
        const buyerAssets = await wA.listAssets().catch(() => null);
        const buyerAssetIds = [
          ...(buyerAssets?.nia ?? []), ...(buyerAssets?.cfa ?? []),
          ...(buyerAssets?.uda ?? []), ...(buyerAssets?.ifa ?? []),
        ].map((a: any) => String(a?.assetId ?? a?.asset_id ?? ''));
        addLog(
          `buyer node knows ${buyerAssetIds.length} contract(s): ` +
          buyerAssetIds.map(id => (id === bridgeAssetId ? bridgeTicker : id === payoutAssetId ? payoutTicker : short(id, 16))).join(', '),
        );
        addLog(
          buyerAssetIds.includes(payoutAssetId)
            ? `buyer has resolved the ${payoutTicker} contract — the cron opened it a channel in the served asset after all`
            : `buyer never resolved the ${payoutTicker} contract ✓ — it only ever held ${bridgeTicker}`,
          buyerAssetIds.includes(payoutAssetId) ? 'info' : 'success',
        );

        // ── Refund leg: the same conversion, in the other direction ─────────
        // The merchant now pays the buyer back through APay. It holds only
        // payout asset, and the buyer is paid out in the bridge asset, so the
        // LSP converts payout → bridge — the mirror of the checkout.
        //
        // Which asset the buyer is paid in is the LSP's per-account payout
        // asset, derived from the channels it holds with that peer. The buyer's
        // only channel is the bridge one it funded itself — the cron leaves a
        // self-provisioned peer alone (CHANNEL_PROVISION_GRACE covers the gap
        // between its connect and its funding tx), and CONVERTIBLE_ASSET_IDS is
        // what makes an asset the LSP never provisions still deliverable. See
        // docs/apay-linked-asset-options.uk.md §9. Against an LSP without those,
        // the buyer's payout asset resolves to the served one and the refund
        // arrives unconverted; the flow reports which happened rather than
        // assuming.
        setPhase('refund_register');
        req('lspA.connect');
        await lspA.connect();
        res('lspA.connect');
        req('lspA.enableLightningAddress');
        const buyerAddr = await lspA.enableLightningAddress();
        setBuyerAddress(buyerAddr.address);
        res('enableLightningAddress (buyer)', { address: buyerAddr.address, unusedHashes: buyerAddr.unusedHashes });

        const refundBridgeBefore = Number((await wA.getAssetBalance(bridgeAssetId))?.offchainOutbound ?? 0);
        const refundPayoutBefore = Number((await wA.getAssetBalance(payoutAssetId).catch(() => null))?.offchainOutbound ?? 0);

        setPhase('refund');
        req('lspB.discoverAddress', { address: buyerAddr.address });
        const refundDiscovery = await lspB.discoverAddress(buyerAddr.address);
        res('discoverAddress (buyer)', {
          payoutAsset: refundDiscovery.payoutAsset?.ticker ?? '(none advertised)',
          accepted: (refundDiscovery.acceptedAssets ?? []).map(a => a.ticker ?? short(a.assetId)).join(','),
        });
        const refundPayoutIsBridge = refundDiscovery.payoutAsset?.assetId === bridgeAssetId;
        if (!refundPayoutIsBridge) {
          addLog(
            `Buyer's payout asset is ${refundDiscovery.payoutAsset?.ticker ?? '(unknown)'}, not ${bridgeTicker} — ` +
            'refund will arrive unconverted. Set CONVERTIBLE_ASSET_IDS / PAYOUT_ASSET_PREFERENCE on utexo-lsp.',
            'info',
          );
        }

        // The RGB amount rides an HTLC, so the outbound leg needs sats on the
        // LSP's side of the buyer's channel — asset balance alone delivers
        // nothing. utexo-lsp discovers a shortfall only as a bare `NoRoute` from
        // /sendpayment, retried every 15 s with the merchant's HODL standing, so
        // check it here where the numbers can still be named.
        const buyerChannels = await wA.listChannels();
        const bridgeChannel = buyerChannels.find(c => c.assetId === bridgeAssetId);
        const lspOutboundMsat = Number(bridgeChannel?.inboundBalanceMsat ?? 0);
        addLog(`LSP outbound on the buyer ${bridgeTicker} channel: ${lspOutboundMsat} msat (refund needs ${refundMsat})`);
        if (lspOutboundMsat < refundMsat) {
          throw new Error(
            `refund leg: the LSP holds only ${lspOutboundMsat} msat on the buyer's ${bridgeTicker} channel, ` +
            `below the ${refundMsat} msat this refund carries. The buyer opens that channel with ` +
            `aChannelPushMsat — raise it (a 1% channel reserve is unspendable on top).`,
          );
        }

        // Same call as the checkout, roles swapped: the merchant names an amount,
        // not an asset, and the SDK quotes the only asset it can pay with.
        req('lspB.payAddress (refund, asset selected by SDK)', { address: buyerAddr.address, amtMsat: refundMsat, assetAmount: refundAssetAmount });
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
        res('payAddress (refund)', { invoice: short(refundInvoice, 32), status: refundRes.status, paymentHash: short(refundPHash) });
        if (String(refundRes.status ?? '').toLowerCase() === 'failed') {
          throw new Error(
            `refund leg: payAddress failed — merchant needs spendable ${payoutTicker} and the LSP needs ${bridgeTicker} on the buyer's channel.`,
          );
        }

        setPhase('refund_settle');
        addLog('Refund paid — waiting for the outbound leg to the buyer…');
        const refundDeadline = Date.now() + SETTLE_TIMEOUT_S * 1000;
        let refundSettled = false;
        let refundReconnect = 0;
        while (Date.now() < refundDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_INTERVAL_MS);
          await mine(1);

          refundReconnect += POLL_INTERVAL_MS;
          if (refundReconnect >= MERCHANT_KEEPALIVE_MS) {
            refundReconnect = 0;
            try { await lspA.connect(); } catch { /* already connected */ }
            addLog('lspA.connect (refund keepalive)');
          }

          await wA.syncWallet();
          await wB.syncWallet();

          const status = refundPHash ? await wB.getLightningSendStatus(refundPHash) : 'Pending';
          setRefundStatus(status ?? 'Pending');
          addLog(`merchant getLightningSendStatus (refund): ${status}`);

          const bridgeBal = await wA.getAssetBalance(bridgeAssetId).catch(() => null);
          const payoutBal = await wA.getAssetBalance(payoutAssetId).catch(() => null);
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
            'refund leg: timeout waiting for settlement — check logs/utexo-lsp.log for the outbox job. ' +
            `A repeating NoRoute means the LSP cannot reach the buyer in ${bridgeTicker}; the merchant's ` +
            'HODL is not lost, it expires and is refunded, but the outbox retries until then.',
          );
        }

        const buyerSnapRefund = await snapshotRgbBalances(wA, bridgeAssetId, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'END (after refund)', buyerSnapRefund, addLog);
        logRgbBalanceDelta(`buyer (${bridgeTicker}, refund)`, buyerSnapEnd, buyerSnapRefund, addLog);

        // ── Top-up: paid on-chain in the bridge asset, delivered in the payout ──
        //
        // The third direction. The merchant holds a payout-asset channel and
        // nothing else, and names only that asset. The LSP resolves the on-chain
        // leg from its own CONVERTIBLE_PAIRS, so the RGB invoice comes back in
        // the bridge asset — an id the merchant never configured and never sees
        // until the response carries it.
        //
        // The payer is the Faucet: a plain RLN node with no channel to anyone
        // and no idea what APay is. It just sends RGB on-chain.
        setPhase('topup');
        const topupBefore = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
        logRgbBalanceSnap('merchant', 'START (pre-topup)', topupBefore, addLog);

        req('lspB.receiveAsset (on-chain asset left to the LSP)', {
          assetId: short(payoutAssetId, 20), amountRgb: topupAssetAmount, amountSats: topupMsat / 1000,
        });
        const topup = await lspB.receiveAsset({
          assetId: payoutAssetId,
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
            'top-up leg: the LSP quoted the on-chain leg in the payout asset, not the bridge asset. ' +
            'Either CONVERTIBLE_PAIRS is not declared for it, or utexo-lsp predates convertible ' +
            'lightning_receive (it would then have required rgb_invoice.asset_id and failed earlier).',
          );
        }
        if (topup.onchainAssetId && topup.onchainAssetId !== bridgeAssetId) {
          throw new Error(
            `top-up leg: LSP resolved the on-chain asset to ${topup.onchainAssetId}, expected ${bridgeAssetId}`,
          );
        }
        addLog(
          `Merchant asked to be paid ${fmtPayout(topupAssetAmount)} and was handed an RGB invoice ` +
          `in ${bridgeTicker} — resolved by the LSP, never named by the client ✓`,
          'success',
        );

        // Read the assignment back off the invoice rather than assuming it: a
        // converted receive is pinned to Fungible/<amount>, which is the only
        // thing tying what the Faucet sends to what the LSP will pay out.
        req('faucet.decodergbinvoice (top-up)');
        const topupDecoded = await faucet.decodeRgbInvoice(topup.rgbInvoice);
        const topupAssignment = topupDecoded.assignment ?? { type: 'Fungible', value: topupAssetAmount };
        const topupEndpoints = (topupDecoded.transport_endpoints ?? [`rpc://${host}:3000/json-rpc`])
          .map(toDaemonUrl);
        res('faucet.decodergbinvoice', {
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

        req('faucet.sendrgb (top-up)', { asset: bridgeTicker, amount: topupAssetAmount });
        await faucet.sendRgb({
          donation: false, fee_rate: 7, min_confirmations: 1, skip_sync: false,
          recipient_map: {
            [bridgeAssetId]: [{
              recipient_id: topupDecoded.recipient_id,
              assignment: topupAssignment,
              transport_endpoints: topupEndpoints,
            }],
          },
        });
        res('faucet.sendrgb (top-up)');
        await mine(1);
        await faucet.refresh();

        addLog(`Waiting for the LSP to settle the ${bridgeTicker} leg and deliver ${payoutTicker}…`);
        req('lspB.awaitReceiveSettlement');
        const topupOutcome = await lspB.awaitReceiveSettlement(topup.lnInvoice, {
          timeoutMs: ONCHAIN_SETTLE_TIMEOUT_S * 1000,
          pollIntervalMs: POLL_INTERVAL_MS,
          onEachPoll: async () => {
            await mine(1);
            await faucet.refresh();
            try { await lspB.connect(); } catch { /* already connected */ }
          },
          onProgress: s => addLog(`merchant lightning_receive status: ${s}`),
        });
        res('awaitReceiveSettlement', { outcome: topupOutcome });
        if (topupOutcome !== 'settled') {
          throw new Error(
            'top-up leg: timed out waiting for delivery — check logs/utexo-lsp.log. The RGB leg may still ' +
            `be unconfirmed, or the LSP may be short of ${payoutTicker} on the merchant's channel.`,
          );
        }

        await wB.syncWallet();
        await wB.refreshWallet();
        const topupAfter = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
        setTopupBalB(topupAfter);
        logRgbBalanceSnap('merchant', 'END (after topup)', topupAfter, addLog);
        logRgbBalanceDelta(`merchant (${payoutTicker}, topup)`, topupBefore, topupAfter, addLog);

        // The point of the whole leg: liquidity moved in an asset nobody sent.
        const topupDelta = topupAfter.offchainOutbound - topupBefore.offchainOutbound;
        if (topupDelta <= 0) {
          throw new Error(
            `top-up leg: the LSP reported the receive as settled but the merchant's ${payoutTicker} ` +
            `balance did not move (${topupBefore.offchainOutbound} → ${topupAfter.offchainOutbound}).`,
          );
        }
        addLog(
          `Merchant ${payoutTicker} liquidity +${fmtPayout(topupDelta)} — paid on-chain in ${bridgeTicker} ✓`,
          'success',
        );

        // ── Recipient (C): plain APay, one asset on both legs ────────────────
        //
        // A third node with no history at all. It is served the ordinary way —
        // connect, the LSP cron opens it a channel in the *served* asset
        // (LNUSDT, the only entry in SUPPORTED_ASSET_IDS), it registers a
        // Lightning Address, the merchant pays it.
        //
        // Both legs are LNUSDT, so no conversion is involved anywhere: this is
        // the control case proving the bridge-asset configuration did not break
        // plain APay for a peer that never touches the second asset.
        setPhase('c_init');
        const keysC = await createWallet('regtest' as any);
        const portC = recipientPortBase + Math.floor(Math.random() * 2000);
        const dirC = `${documentDirectory ?? ''}${storagePrefix}_c_${Date.now()}`;
        await FileSystem.makeDirectoryAsync(dirC, { intermediates: true });

        const wC = new UTEXOWallet(
          {
            storageDirPath: dirC.replace('file://', ''),
            daemonListeningPort: portC,
            ldkPeerListeningPort: portC + 1,
            network: 'regtest',
            lspBaseUrl: LSP_URL,
          },
          new PasswordRLNSigner('apaylinkedC', keysC.mnemonic),
        );
        walletCRef.current = wC;
        const lspC = await wC.createLsp(LSP_PEER);
        await wC.init();
        await wC.unlock(REGTEST_UNLOCK);

        const cPubkey = String((await wC.getNodeInfo())?.pubkey ?? '');
        setPubkeyC(cPubkey);
        res('recipient.init', { pubkey: short(cPubkey) });

        setPhase('c_fund');
        const addrC = await wC.getAddress();
        req('sendToAddress recipient 1 BTC');
        await sendToAddress(addrC, 1);
        await mine(6);
        await sleep(3000);
        await wC.syncWallet();
        res('recipient.funded');

        setPhase('c_utxos');
        req('recipient.createUtxos');
        await wC.syncWallet();
        await wC.refreshWallet();
        await wC.createUtxos({ upTo: false, num: 10, feeRate: 7 });
        await mine(1);
        await wC.syncWallet();
        res('recipient.createUtxos');

        setPhase('c_channel');
        req('lspC.connect');
        await lspC.connect();
        res('lspC.connect');

        // CHANNEL_PROVISION_GRACE (30s under TWO_ASSETS=1) makes the cron ignore
        // a peer it has only just seen with no channels — it cannot yet tell one
        // that is about to fund its own from one waiting to be served, which is
        // exactly the buyer/recipient distinction. So the first ~30s of this
        // wait is expected silence, not a fault.
        addLog(
          `Waiting out CHANNEL_PROVISION_GRACE, then the LSP cron opens a real ` +
          `on-chain ${payoutTicker} channel to the recipient…`,
        );
        await mine(2);
        await sleep(6000);

        const chanC = await lspC.waitForChannel(payoutAssetId, {
          timeoutMs: CHANNEL_TIMEOUT_S * 1000,
          pollIntervalMs: POLL_INTERVAL_MS,
          onProgress: (msg: string) => addLog(`recipient ${msg}`),
          onEachPoll: () => mine(1),
        });
        setChannelC(chanC);
        addLog(`Recipient on-chain ${payoutTicker} channel usable ✓  cap=${chanC.capacitySat} sat`, 'success');

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

        // C must stay reachable: APay's second leg is the LSP paying C's own
        // node, and it can only do that while C is connected.
        (async () => {
          while (keepaliveActiveRef.current && !abortRef.current) {
            await sleep(MERCHANT_KEEPALIVE_MS);
            if (!keepaliveActiveRef.current || abortRef.current) break;
            try { await lspC.connect(); } catch { /* already connected */ }
          }
        })();

        setPhase('c_pay');
        const recipientBefore = await snapshotRgbBalances(wC, payoutAssetId, lspPeerPubkey);
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
            `recipient leg: the SDK quoted ${cSelection.asset?.ticker ?? cSelection.assetId} and the LSP ` +
            `would convert — both legs here should be ${payoutTicker}. The recipient's payout asset was ` +
            'mis-derived, which usually means its channel is not usable yet.',
          );
        }
        const cPHash = cRes.txid ?? '';
        setRecipientHash(cPHash);
        res('payAddress (recipient)', { invoice: short(cInvoice, 32), status: cRes.status, paymentHash: short(cPHash) });
        if (String(cRes.status ?? '').toLowerCase() === 'failed') {
          throw new Error(
            `recipient leg: payAddress failed — the merchant needs both spendable ${payoutTicker} and ` +
            `${recipientMsat / 1000} sat of outbound on its own channel.`,
          );
        }

        setPhase('c_settle');
        addLog('Merchant paid — waiting for the LSP to deliver to the recipient…');
        const cDeadline = Date.now() + SETTLE_TIMEOUT_S * 1000;
        let cSettled = false;
        while (Date.now() < cDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_INTERVAL_MS);
          await mine(1);
          await wB.syncWallet();
          await wC.syncWallet();

          const status = cPHash ? await wB.getLightningSendStatus(cPHash) : 'Pending';
          setRecipientStatus(status ?? 'Pending');
          addLog(`merchant getLightningSendStatus (recipient): ${status}`);

          const cBal = await wC.getAssetBalance(payoutAssetId).catch(() => null);
          if (cBal) setFinalBalC(cBal);
          if (status === 'Succeeded' && Number(cBal?.offchainOutbound ?? 0) > recipientBefore.offchainOutbound) {
            cSettled = true;
            break;
          }
          if (status === 'Failed') throw new Error('recipient leg: merchant payment Failed during LSP settlement');
        }
        if (!cSettled) {
          throw new Error(
            'recipient leg: timeout waiting for settlement — check logs/utexo-lsp.log for the outbox job. ' +
            `A NoRoute there means the LSP is short of ${payoutTicker} or sats on the recipient's channel.`,
          );
        }

        const recipientAfter = await snapshotRgbBalances(wC, payoutAssetId, lspPeerPubkey);
        setFinalBalC(recipientAfter);
        logRgbBalanceSnap('recipient', 'END (settled)', recipientAfter, addLog);
        logRgbBalanceDelta(`recipient (${payoutTicker})`, recipientBefore, recipientAfter, addLog);

        const cDelta = recipientAfter.offchainOutbound - recipientBefore.offchainOutbound;
        if (cDelta <= 0) {
          throw new Error(
            `recipient leg: payment reported Succeeded but the recipient's ${payoutTicker} balance ` +
            `did not move (${recipientBefore.offchainOutbound} → ${recipientAfter.offchainOutbound}).`,
          );
        }
        addLog(
          `Recipient ${payoutTicker} balance +${fmtPayout(cDelta)} — plain APay, no conversion ✓`,
          'success',
        );

        // ── /lightning_send: paying a plain BOLT11 out of the other asset ────
        //
        // The fourth direction, and the exact mirror of the external-payer leg
        // above. There the external node was the *payer* and knew nothing about
        // APay; here it is the *payee* and knows just as little — it signs an
        // ordinary BUSDT invoice with `createLightningInvoice`, no LNURL, no
        // APay, no hash batch, no SDK.
        //
        // The buyer plays that external node: it is the only party with a BUSDT
        // channel, and it funded that channel itself. The merchant pays it while
        // holding nothing but LNUSDT — the LSP quotes the merchant a HODL invoice
        // in LNUSDT carrying the buyer's own payment hash, holds that HTLC, pays
        // the buyer in BUSDT, and only then claims.
        //
        // The shared hash is the whole atomicity: the LSP cannot claim the
        // merchant's LNUSDT without a preimage only the buyer can release, and
        // the buyer releases it only on being paid.
        //
        // Liquidity here is the interesting part. The LSP delivers BUSDT out of
        // its own side of the buyer's channel, which exists only because the
        // buyer spent through it earlier: 500 000 at checkout less 200 000
        // refunded leaves the LSP 300 000 BUSDT facing the buyer. It never
        // provisioned a unit of it — BUSDT is CONVERTIBLE_ASSET_IDS only.
        setPhase('ls_quote');
        const relayPayeeBefore = await snapshotRgbBalances(wA, bridgeAssetId, lspPeerPubkey);
        const relayPayerBefore = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
        logRgbBalanceSnap('buyer', 'START (pre-relay)', relayPayeeBefore, addLog);
        addLog(
          `LSP holds ${fmtBridge(relayPayeeBefore.offchainInbound)} facing the buyer — ` +
          `that is what the relay is delivered from`,
        );

        req('buyer.createLightningInvoice (plain BOLT11, no APay)', {
          assetId: short(bridgeAssetId, 20), assetAmount: relayAssetAmount, msat: relayMsat,
        });
        const relayTarget = await wA.createLightningInvoice({
          amountSats: relayMsat / 1000,
          expirySeconds: 3600,
          asset: { assetId: bridgeAssetId, amount: relayAssetAmount },
        });
        res('buyer.createLightningInvoice', { invoice: short(relayTarget.lnInvoice, 32) });
        addLog(
          `Buyer signed a plain ${bridgeTicker} invoice — the merchant holds none of it`,
          'info',
        );

        req('lspB.payExternalInvoice (merchant holds only ' + payoutTicker + ')', {
          invoice: short(relayTarget.lnInvoice, 32),
        });
        const { quote: relayQuote, sendResult: relayRes } = await lspB.payExternalInvoice({
          invoice: relayTarget.lnInvoice,
        });
        res('payExternalInvoice', {
          payWith: relayQuote.inbound.assetId === payoutAssetId ? payoutTicker : short(relayQuote.inbound.assetId ?? ''),
          deliver: relayQuote.outbound.assetId === bridgeAssetId ? bridgeTicker : short(relayQuote.outbound.assetId ?? ''),
          converted: relayQuote.converted,
          paymentHash: short(relayQuote.paymentHash),
          status: relayRes.status,
        });

        // The SDK already refused anything that did not bind the two legs — this
        // asserts the shape of the relay, not its safety.
        if (!relayQuote.converted) {
          throw new Error(
            `relay leg: the LSP quoted the merchant in ${relayQuote.inbound.assetId}, the same asset ` +
            'it delivers — no conversion happened, so this leg proves nothing. Check CONVERTIBLE_PAIRS.',
          );
        }
        if (relayQuote.inbound.assetId !== payoutAssetId) {
          throw new Error(
            `relay leg: the merchant holds only ${payoutTicker} but was quoted ${relayQuote.inbound.assetId}`,
          );
        }
        if (relayQuote.outbound.assetId !== bridgeAssetId) {
          throw new Error(
            `relay leg: expected delivery in ${bridgeTicker}, LSP reported ${relayQuote.outbound.assetId}`,
          );
        }
        addLog(
          `Merchant pays ${fmtPayout(relayQuote.inbound.assetAmount ?? 0)}, buyer is delivered ` +
          `${fmtBridge(relayQuote.outbound.assetAmount ?? 0)} — one hash, verified locally ` +
          `against the buyer's invoice ✓`,
          'success',
        );

        setPhase('ls_settle');
        addLog('Relay paid — LSP holds the HTLC until the buyer is paid…');

        // Two different questions, and the leg is only done when both answer yes.
        //
        // `settled` is the LSP's own bookkeeping: it means the LSP called
        // claimhodlinvoice. The payer's asset does not move at that instant — its
        // node still has to receive the update_fulfill_htlc and re-derive the
        // channel's RGB balance. Asserting the balance off the LSP's status alone
        // reads the payer's books one round trip too early, which is exactly what
        // every other leg here avoids by waiting on the money rather than on a
        // status.
        const relayDeadline = Date.now() + SETTLE_TIMEOUT_S * 1000;
        let relayLspSettled = false;
        let relayPayeeAfter = relayPayeeBefore;
        let relayPayerAfter = relayPayerBefore;
        let relaySettled = false;
        while (Date.now() < relayDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_INTERVAL_MS);
          await mine(1);
          await wA.syncWallet();
          await wB.syncWallet();
          await wB.refreshWallet();

          if (!relayLspSettled) {
            const relayStatus = await lspB.externalPaymentStatus(relayQuote.paymentHash);
            setRelayStatus(relayStatus.status);
            addLog(`lightning_send status: ${relayStatus.status}${relayStatus.reason ? ` (${relayStatus.reason})` : ''}`);

            if (relayStatus.status === 'settled') relayLspSettled = true;
            // Terminal and refunded: the merchant lost nothing, but the leg failed.
            if (relayStatus.status === 'cancelled' || relayStatus.status === 'failed') {
              throw new Error(
                `relay leg: LSP reported ${relayStatus.status}${relayStatus.reason ? ` — ${relayStatus.reason}` : ''}. ` +
                'The merchant was refunded; the usual cause is the LSP being short of ' +
                `${bridgeTicker} or sats on the buyer's channel.`,
              );
            }
          }
          if (!relayLspSettled) continue;

          // The merchant's own node is the authority on whether its HTLC resolved.
          const payerStatus = await wB.getLightningSendStatus(relayQuote.paymentHash);
          relayPayeeAfter = await snapshotRgbBalances(wA, bridgeAssetId, lspPeerPubkey);
          relayPayerAfter = await snapshotRgbBalances(wB, payoutAssetId, lspPeerPubkey);
          setRelayBalA(relayPayeeAfter);
          addLog(
            `merchant getLightningSendStatus: ${payerStatus} | ${payoutTicker} outbound ` +
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
              ? `relay leg: the LSP settled and the buyer was paid, but the merchant's ${payoutTicker} ` +
                'balance never moved — its node did not apply the fulfilled HTLC within the timeout.'
              : 'relay leg: timeout waiting for settlement — check logs/utexo-lsp.log for the ' +
                'lightning_send_pay_outbound job.',
          );
        }

        setRelayBalA(relayPayeeAfter);
        logRgbBalanceDelta(`merchant (${payoutTicker}, relay)`, relayPayerBefore, relayPayerAfter, addLog);
        logRgbBalanceDelta(`buyer (${bridgeTicker}, relay)`, relayPayeeBefore, relayPayeeAfter, addLog);

        const relaySpent = relayPayerBefore.offchainOutbound - relayPayerAfter.offchainOutbound;
        const relayGained = relayPayeeAfter.offchainOutbound - relayPayeeBefore.offchainOutbound;
        if (relaySpent <= 0 || relayGained <= 0) {
          throw new Error(
            `relay leg: settled but the balances did not move as expected — merchant -${relaySpent} ` +
            `${payoutTicker}, buyer +${relayGained} ${bridgeTicker}`,
          );
        }
        addLog(
          `Merchant -${fmtPayout(relaySpent)}, buyer +${fmtBridge(relayGained)} — a plain ` +
          'invoice paid out of an asset its payee never heard of ✓',
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
    addLog, envReady, setupScriptHint,
    bridgeAssetId, bridgeTicker, payoutAssetId, payoutTicker, precision,
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
    setupScriptHint,
    bridgeTicker,
    payoutTicker,
    isRunning: !['idle', 'done', 'error'].includes(phase),
  };
}
