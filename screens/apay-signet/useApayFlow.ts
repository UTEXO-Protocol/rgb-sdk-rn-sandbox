/**
 * APay · Signet (UTEXO) flow — async variant.
 *
 * Mirrors screens/apay/useApayFlow.ts (async) but runs against the live signet
 * stack. Key differences vs regtest:
 *   - network 'utexo' + real RGB channels (no enableVirtualChannelsV0)
 *   - no manual mining — fund / UTXO / settlement reached by polling for
 *     signet confirmations
 *   - the faucet RLN node funds BTC (sendbtc) and sends the buyer's RGB
 *     top-up on-chain to the LSP (sendrgb)
 *
 * Roles: User B = merchant/recipient (registers Lightning Address, offline at
 * pay time), User A = buyer/sender. The LSP holds the HTLC and the outbox
 * settles once the merchant reconnects — no claimHodlInvoice.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
} from '@utexo/rgb-sdk-rn';

import { formatAssetAmount, normHash, short, sleep, type LogEntry, type Phase } from '../apay/config';
import { faucet } from './daemons';
import {
  APAY_HASH_REFILL_THRESHOLD,
  ASSET_ID,
  ASSET_PRECISION,
  ASSET_TICKER,
  CHANNEL_TIMEOUT_MS,
  FAUCET_BTC_SAT,
  FEE_RATE,
  FUND_TIMEOUT_MS,
  LSP_URL,
  MERCHANT_KEEPALIVE_MS,
  PAYMENT_ASSET_AMOUNT,
  PAYMENT_MSAT,
  POLL_MS,
  SETTLE_TIMEOUT_MS,
  UNLOCK,
  UTXO_NUM,
} from './config';

export function useApayFlow() {
  const logTag = 'apay-signet';
  const merchantLabel = 'merchant';
  const buyerLabel = 'buyer';

  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const [pubkeyB, setPubkeyB] = useState('');
  const [lnaddrUsername, setLnaddrUsername] = useState('');
  const [lnaddrDomain, setLnaddrDomain] = useState('');
  const [lightningAddress, setLightningAddress] = useState('');
  const [hashPoolInfo, setHashPoolInfo] = useState<any>(null);
  const [channelB, setChannelB] = useState<any>(null);
  const [channelA, setChannelA] = useState<any>(null);
  const [hodlBolt11, setHodlBolt11] = useState('');
  const [paymentHash, setPaymentHash] = useState('');
  const [sendStatus, setSendStatus] = useState('');
  const [merchantOnline, setMerchantOnline] = useState(false);
  const [finalBalB, setFinalBalB] = useState<any>(null);
  /** True while the flow is parked on a manual gate, waiting for Continue. */
  const [awaitingContinue, setAwaitingContinue] = useState(false);

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef = useRef(false);
  const keepaliveActiveRef = useRef(false);
  const unusedHashesRef = useRef<number | null>(null);
  /** Resolver for the in-flight gate; null when the flow is not parked. */
  const continueRef = useRef<(() => void) | null>(null);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[${logTag}][${type}] ${msg}`);
  }, []);

  /** Release a flow parked on {@link waitForContinue}. No-op when not parked. */
  const continueFlow = useCallback(() => {
    const resolve = continueRef.current;
    continueRef.current = null;
    setAwaitingContinue(false);
    resolve?.();
  }, []);

  /**
   * Park the flow until the user presses Continue. Reset also releases the
   * gate, so a parked flow can always be torn down — it then throws
   * 'Cancelled' like every other abort point in this hook.
   */
  const waitForContinue = useCallback(async (label: string) => {
    addLog(`⏸ Paused — ${label}. Press Continue to proceed.`);
    setAwaitingContinue(true);
    await new Promise<void>(resolve => { continueRef.current = resolve; });
    if (abortRef.current) throw new Error('Cancelled');
    addLog('▶ Continuing…', 'success');
  }, [addLog]);

  const run = useCallback(async () => {
    abortRef.current = false;
    keepaliveActiveRef.current = false;
    unusedHashesRef.current = null;
    continueRef.current = null;
    setAwaitingContinue(false);
    setLog([]); setErrorMsg('');
    setPubkeyB(''); setLnaddrUsername(''); setLnaddrDomain('');
    setLightningAddress(''); setHashPoolInfo(null);
    setChannelB(null); setChannelA(null);
    setHodlBolt11(''); setPaymentHash(''); setSendStatus('');
    setMerchantOnline(false); setFinalBalB(null);

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    /** Base units → "0.5 USDT". Every amount below is in base units. */
    const fmtAsset = (units: number) =>
      `${formatAssetAmount(units, ASSET_PRECISION)} ${ASSET_TICKER}`;

    // Poll a wallet until it reports settled BTC > 0 (funding confirmed).
    const pollFunded = async (w: UTEXOWallet<'RGB_LN'>, label: string): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (abortRef.current) throw new Error('Cancelled');
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

    // Poll a wallet until createUtxos tx confirms (spendable appears).
    const pollUtxosConfirmed = async (w: UTEXOWallet<'RGB_LN'>, label: string): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        try {
          await w.syncWallet();
          const b = await w.getBtcBalance() as any;
          const sp = (b?.vanilla?.spendable ?? 0) + (b?.colored?.spendable ?? 0);
          addLog(`${label} spendable BTC: ${sp} sat`);
          if (sp > 0) { addLog(`${label} UTXOs confirmed ✓`, 'success'); return; }
        } catch (e: any) { console.error(`[${logTag}] utxo poll ${label}`, e?.message ?? e); }
      }
      addLog(`${label} UTXO confirmation timeout — continuing`);
    };

    /**
     * Per-poll hook for waitForChannel: keep the LDK peer session alive and
     * flag the stall the LSP cannot recover from on its own.
     *
     * The LSP's cron calls /openchannel for every connected peer, so the same
     * peer is retried every few seconds — but only until the first channel
     * completes. `virtual_channel_session_add` (rgb-lightning-node
     * `src/ldk.rs:1938`) records a session once funding is registered, and
     * `virtual_channel_add_intent` (:794) then rejects every later attempt with
     *   "virtual channel session already exists for this peer pair"
     * — including after *we* close that channel. So a channel that opens and
     * then dies on our side is never retried, and listChannels() sits at 0 for
     * the whole timeout. When that happens the reason is in this node's
     * `<storageDir>/.ldk/logs/logs.txt` (close-required error), not in the LSP
     * log, which only ever shows the 400.
     */
    const channelPollKeepalive = (w: UTEXOWallet<'RGB_LN'>, lsp: any, label: string) => {
      const startedAt = Date.now();
      let warned = false;
      return async () => {
        try { await lsp.connect(); } catch { /* already connected */ }
        const peers = await w.listPeers().catch(() => [] as any[]);
        const connected = peers.some((p: any) =>
          (p.pubkey ?? p.pubKey ?? '') === (lsp.peer?.peerPubkey ?? ''));
        if (!connected) addLog(`${label} not connected to LSP peer — reconnecting`, 'error');
        if (!warned && Date.now() - startedAt > 3 * 60 * 1000) {
          warned = true;
          addLog(
            `${label}: still 0 channels after 3 min. The LSP opens once per peer, so if the ` +
            'channel was accepted and then closed on this side it will never be retried. Check ' +
            'this node\'s .ldk/logs/logs.txt for "close-required error" — a consignment-validation ' +
            'timeout against the indexer closes the channel ~27 s after FundingCreated.',
            'error',
          );
        }
      };
    };

    try {
      // ── Preflight ──────────────────────────────────────────────────────────
      setPhase('b_init');
      addLog(`Platform=${Platform.OS}  network=utexo`);
      addLog(`LSP_URL=${LSP_URL}`);
      if (!ASSET_ID) throw new Error('APay signet asset not configured (screens/apay-signet/config.ts)');
      addLog(
        `Asset ${ASSET_TICKER} (precision ${ASSET_PRECISION})  id=${short(ASSET_ID, 24)}  ` +
        `checkout=${PAYMENT_MSAT / 1000} sat + ${fmtAsset(PAYMENT_ASSET_AMOUNT)} ` +
        `(${PAYMENT_ASSET_AMOUNT} base units)`,
        'success',
      );

      // Confirm the LSP still serves this asset before spending 10+ min on
      // funding and channel opens — it advertises one asset at a time, and a
      // virtual channel for any other never opens.
      try {
        const info = await (await fetch(`${LSP_URL}/get_info`)).json();
        const supported: any[] = info?.supported_assets ?? [];
        addLog(`LSP serves: ${supported.map(a => `${a.ticker}(p${a.precision})`).join(', ') || 'none'}`);
        const match = supported.find(a => a.asset_id === ASSET_ID);
        if (!match) {
          throw new Error(
            `LSP does not serve ${short(ASSET_ID, 24)} — it advertises ` +
            `${supported.map(a => `${a.ticker} ${short(a.asset_id, 20)}`).join(', ') || 'nothing'}. ` +
            'Update ASSET_ID in screens/apay-signet/config.ts.',
          );
        }
        if (Number(match.precision) !== ASSET_PRECISION) {
          throw new Error(
            `Precision mismatch: LSP reports ${match.precision} for ${match.ticker}, config says ` +
            `${ASSET_PRECISION}. Amounts are base units — fix config.ts before running.`,
          );
        }
        const minSendable = Number(info?.lightning_address_min_sendable_msat ?? 0);
        const maxSendable = Number(info?.lightning_address_max_sendable_msat ?? Infinity);
        if (PAYMENT_MSAT < minSendable || PAYMENT_MSAT > maxSendable) {
          throw new Error(
            `PAYMENT_MSAT=${PAYMENT_MSAT} outside the LSP's Lightning Address range ` +
            `[${minSendable}, ${maxSendable}] msat — payAddress would fail at LNURL discovery.`,
          );
        }
        addLog(`LSP ok — virtual_channel_mode=${info?.virtual_channel_mode ?? '?'}`, 'success');
      } catch (e: any) {
        addLog(`LSP /get_info: ${e?.message ?? String(e)}`, 'error');
        throw e;
      }

      // Virtual (trusted, 0-conf, no-broadcast) channels — the signet utexo-lsp
      // opens channels with DEFAULT_VIRTUAL_OPEN_MODE set (like regtest), so the
      // app wallets must enable virtual channels and trust the LSP as the peer.
      // (The LSP RLN node must also be started with --enable-virtual-channels-v0.)
      //
      // No manual /get_info fetch here: createLsp() (called before init() below)
      // auto-discovers the LSP pubkey and sets enableVirtualChannelsV0 +
      // virtualPeerPubkeys on the node params before rlnCreateNode bakes them in.

      const ts = Date.now();
      const mkDir = async (name: string) => {
        const uri = `${documentDirectory ?? ''}apay_sig_${name}_${ts}`;
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
        return uri.replace('file://', '');
      };

      // ── Merchant wallet (recipient) ────────────────────────────────────────
      const keysB = await createWallet('utexo' as any);
      const portB = 47000 + Math.floor(Math.random() * 2000);
      const wB = new UTEXOWallet(
        {
          storageDirPath: await mkDir('b'),
          daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1,
          network: 'utexo',
        },
        new PasswordRLNSigner('apaysigB', keysB.mnemonic),
      );
      walletBRef.current = wB;
      const lspB = await wB.createLsp();
      await wB.init();
      await wB.unlock(UNLOCK);

      const bPubkey = String((await wB.getNodeInfo())?.pubkey ?? '');
      setPubkeyB(bPubkey);
      res(`${merchantLabel}.init`, { pubkey: short(bPubkey) });

      setPhase('b_fund');
      const addrB = await wB.getAddress();
      req(`faucet.sendBtc ${merchantLabel}`, { amount: FAUCET_BTC_SAT, address: short(addrB, 18) });
      await faucet.sendBtc(addrB, FAUCET_BTC_SAT, FEE_RATE);
      res('faucet.sendBtc');
      await pollFunded(wB, merchantLabel);
      addLog(`${merchantLabel} funded ✓`, 'success');

      setPhase('b_utxos');
      req(`${merchantLabel}.createUtxos`, { num: UTXO_NUM, feeRate: FEE_RATE });
      await wB.syncWallet();
      await wB.refreshWallet();
      await wB.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
      res(`${merchantLabel}.createUtxos`);
      await pollUtxosConfirmed(wB, merchantLabel);

      // SDK: lsp.connect() → waitForChannel() — LSP cron opens the channel.
      setPhase('b_channel');
      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');

      addLog(`Waiting for LSP → ${merchantLabel} RGB channel (~10 min, asset ${short(ASSET_ID)})…`);
      const chanB = await lspB.waitForChannel(ASSET_ID, {
        timeoutMs: CHANNEL_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress: (msg) => addLog(`${merchantLabel} ${msg}`),
        onEachPoll: channelPollKeepalive(wB, lspB, merchantLabel),
      });
      setChannelB(chanB);
      addLog(`Merchant RGB channel usable ✓  cap=${chanB.capacitySat} sat`, 'success');

      // SDK: enableLightningAddress() = apayNew + getLightningAddressByPubkey
      setPhase('register');
      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');
      await sleep(1000);

      req('lspB.enableLightningAddress');
      const lnAddr = await lspB.enableLightningAddress();
      setLnaddrUsername(lnAddr.username);
      setLnaddrDomain(lnAddr.domain);
      setLightningAddress(lnAddr.address);
      setHashPoolInfo({ address: lnAddr.address, username: lnAddr.username, domain: lnAddr.domain });
      unusedHashesRef.current = lnAddr.unusedHashes ?? null;
      res('enableLightningAddress', { address: lnAddr.address, unusedHashes: lnAddr.unusedHashes });
      addLog(`Merchant Lightning Address: ${lnAddr.address} (unusedHashes=${lnAddr.unusedHashes ?? '?'})`, 'success');

      // Manual gate: hold here so the address can be inspected/copied before
      // the buyer wallet is created and the payment goes out.
      await waitForContinue('Lightning Address ready');

      try {
        // ── Buyer wallet (sender) ────────────────────────────────────────────
        setPhase('a_init');
        const keysA = await createWallet('utexo' as any);
        const portA = 49000 + Math.floor(Math.random() * 2000);
        const wA = new UTEXOWallet(
          {
            storageDirPath: await mkDir('a'),
            daemonListeningPort: portA,
            ldkPeerListeningPort: portA + 1,
            network: 'utexo',
          },
          new PasswordRLNSigner('apaysigA', keysA.mnemonic),
        );
        walletARef.current = wA;
        const lspA = await wA.createLsp();
        await wA.init();
        await wA.unlock(UNLOCK);
        res(`${buyerLabel}.init`, { pubkey: short(String((await wA.getNodeInfo())?.pubkey ?? '')) });

        setPhase('a_fund');
        const addrA = await wA.getAddress();
        req(`faucet.sendBtc ${buyerLabel}`, { amount: FAUCET_BTC_SAT, address: short(addrA, 18) });
        await faucet.sendBtc(addrA, FAUCET_BTC_SAT, FEE_RATE);
        res('faucet.sendBtc');
        await pollFunded(wA, buyerLabel);
        addLog(`${buyerLabel} funded ✓`, 'success');

        setPhase('a_utxos');
        req(`${buyerLabel}.createUtxos`, { num: UTXO_NUM, feeRate: FEE_RATE });
        await wA.syncWallet();
        await wA.refreshWallet();
        await wA.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
        res(`${buyerLabel}.createUtxos`);
        await pollUtxosConfirmed(wA, buyerLabel);

        setPhase('a_channel');
        req('lspA.connect');
        await lspA.connect();
        res('lspA.connect');

        addLog(`Waiting for LSP → ${buyerLabel} RGB channel (~10 min)…`);
        const chanA = await lspA.waitForChannel(ASSET_ID, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (msg) => addLog(`${buyerLabel} ${msg}`),
          onEachPoll: channelPollKeepalive(wA, lspA, buyerLabel),
        });
        setChannelA(chanA);
        addLog('Buyer RGB channel usable ✓', 'success');

        // ── Buyer top-up: deposit RGB via lightning_receive ──────────────────
        // The LSP never pushes RGB at channel open — the buyer acquires outbound
        // balance by *receiving* over the channel. The faucet node plays the
        // external on-chain RGB sender.
        setPhase('a_topup');
        req('lspA.receiveAsset', { assetId: short(ASSET_ID), amountSats: PAYMENT_MSAT / 1000, amountRgb: PAYMENT_ASSET_AMOUNT });
        const { lnInvoice: topupInvoice, rgbInvoice: topupRgbInvoice } = await lspA.receiveAsset({
          assetId: ASSET_ID,
          amountSats: PAYMENT_MSAT / 1000,
          amountRgb: PAYMENT_ASSET_AMOUNT,
        });
        res('lspA.receiveAsset', { lnInvoice: short(topupInvoice, 32), rgbInvoice: short(topupRgbInvoice, 32) });

        req('faucet.decodeRgbInvoice');
        const topupDecoded = await faucet.decodeRgbInvoice(topupRgbInvoice);
        const topupRecipientId = topupDecoded.recipient_id;
        const topupEndpoints = topupDecoded.transport_endpoints ?? [];
        const topupAssignment = (topupDecoded.assignment?.type === 'Fungible' && topupDecoded.assignment?.value > 0)
          ? topupDecoded.assignment
          : { type: 'Fungible', value: PAYMENT_ASSET_AMOUNT };
        res('faucet.decodeRgbInvoice', { recipientId: short(topupRecipientId, 24) });

        req('faucet.sendRgb', { amount: topupAssignment.value, recipientId: short(topupRecipientId, 20) });
        await faucet.sendRgb({
          donation: false, fee_rate: FEE_RATE, min_confirmations: 1, skip_sync: false,
          recipient_map: {
            [ASSET_ID]: [{ recipient_id: topupRecipientId, assignment: topupAssignment, transport_endpoints: topupEndpoints }],
          },
        });
        res('faucet.sendRgb');

        await sleep(2000);
        await faucet.refresh().catch(() => {});

        addLog('Waiting for faucet Send + LSP receive to settle (signet confirmations)…');
        const topupDeadline = Date.now() + SETTLE_TIMEOUT_MS;
        let topupSettled = false;
        while (Date.now() < topupDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_MS);
          try {
            await faucet.refresh().catch(() => {});
            const faucetTransfers = await faucet.listTransfers(ASSET_ID);
            const faucetSend = [...(faucetTransfers.transfers ?? [])].reverse().find((t: any) => t.kind === 'Send');
            addLog(`faucet Send: ${faucetSend?.status ?? 'none'}`);
            if (faucetSend?.status === 'Failed') throw new Error('Faucet RGB send transfer failed');
            if (faucetSend?.status === 'Settled') { topupSettled = true; break; }
          } catch (e: any) {
            if ((e?.message ?? '').includes('failed')) throw e;
            console.error(`[${logTag}] topup settle poll:`, e?.message ?? e);
          }
        }
        if (!topupSettled) addLog('RGB delivery settlement timeout — LSP may still be processing');
        else addLog('Faucet Send Settled ✓', 'success');

        addLog('Waiting for buyer top-up LN invoice to settle…');
        let topupLastStatus = '';
        await lspA.awaitReceiveSettlement(topupInvoice, {
          timeoutMs: SETTLE_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (s) => { topupLastStatus = s; addLog(`${buyerLabel} top-up invoice: ${s}`); },
        });
        if (topupLastStatus !== 'Succeeded') throw new Error(
          `Buyer top-up did not settle (last status: ${topupLastStatus}) — check LSP RGB inventory and proxy reachability`,
        );
        addLog(`Buyer deposited ${fmtAsset(PAYMENT_ASSET_AMOUNT)} via lightning_receive ✓`, 'success');
        await wA.syncWallet();

        // SDK: confirm buyer can route before payAddress
        req('lspA.waitForOutboundLiquidity', { minMsat: PAYMENT_MSAT });
        await lspA.waitForOutboundLiquidity(PAYMENT_MSAT, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (msg) => addLog(msg),
        });
        res('lspA.waitForOutboundLiquidity');
        addLog('Buyer outbound liquidity ready ✓', 'success');

        const balBefore = Number((await wB.getAssetBalance(ASSET_ID))?.offchainOutbound ?? 0);

        // ── LNURL-pay + HODL payment (recipient treated as offline) ──────────
        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();

        if (!lnAddr.address) throw new Error('Lightning Address missing');

        setPhase('send');
        req('lspA.payAddress', { address: lnAddr.address, amtMsat: PAYMENT_MSAT, assetAmount: PAYMENT_ASSET_AMOUNT });
        const { invoice, sendResult: payRes } = await lspA.payAddress({
          address: lnAddr.address,
          amtMsat: PAYMENT_MSAT,
          asset: { assetId: ASSET_ID, assetAmount: PAYMENT_ASSET_AMOUNT },
        });
        if (!invoice) throw new Error('payAddress returned no invoice');
        setHodlBolt11(invoice);
        const pHash = payRes.txid ?? '';
        const payStatus = String(payRes.status ?? '').toLowerCase();
        setPaymentHash(pHash);
        res('payAddress', { invoice: short(invoice, 32), status: payRes.status, paymentHash: short(pHash) });

        if (payStatus === 'failed') {
          throw new Error('payAddress failed — buyer has no spendable RGB on the LSP channel (top-up may not have settled).');
        }
        addLog('HTLC held at LSP — merchant offline (not settled yet)', 'success');
        await sleep(3000);

        // ── LSP outbox settlement — poll until buyer Settled ─────────────────
        setPhase('settle');
        setMerchantOnline(true);
        addLog('Merchant online — lspB.connect() then wait for LSP outbox…');

        req('lspB.connect');
        await lspB.connect();
        res('lspB.connect');
        await wB.syncWallet();
        await wB.refreshWallet();

        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        let settled = false;
        let reconnectEvery = 0;

        while (Date.now() < deadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_MS);

          reconnectEvery += POLL_MS;
          if (reconnectEvery >= MERCHANT_KEEPALIVE_MS) {
            reconnectEvery = 0;
            try { await lspB.connect(); } catch { /* already connected */ }
            addLog('lspB.connect (settle keepalive)');
          }

          await wA.syncWallet();
          await wB.syncWallet();
          await wB.refreshWallet();

          const status = pHash ? await wA.getLightningSendStatus(pHash) : 'Pending';
          setSendStatus(status ?? 'Pending');
          addLog(`${buyerLabel} getLightningSendStatus: ${status}`);

          let balAfter = balBefore;
          const b1 = await wB.getAssetBalance(ASSET_ID).catch(() => null);
          if (b1) { balAfter = Number(b1.offchainOutbound ?? 0); setFinalBalB(b1); }

          const pays = await wB.listPayments().catch(() => []);
          const mp = pays.find(p => normHash(p.paymentHash) === normHash(pHash));
          if (mp) addLog(`${merchantLabel} inbound: ${mp.paymentType}/${mp.status}`, 'info');

          const merchantOk = mp && ['succeeded', 'claimable'].includes(String(mp.status ?? '').toLowerCase());
          if (status === 'Succeeded' && balAfter > balBefore) {
            settled = true;
            addLog(`merchant received +${fmtAsset(balAfter - balBefore)}`, 'success');
            break;
          }
          if (status === 'Succeeded' && merchantOk) {
            settled = true;
            addLog('buyer Settled + merchant inbound SUCCEEDED — APay complete ✓', 'success');
            break;
          }
          if (status === 'Failed') throw new Error('buyer payment Failed during LSP settlement');
        }

        if (!settled) {
          throw new Error('Timeout — poll getLightningSendStatus until Settled; ensure merchant lsp.connect().');
        }

        addLog('LSP claimed buyer HTLC — APay complete ✓', 'success');

        if (unusedHashesRef.current !== null) {
          unusedHashesRef.current = Math.max(0, unusedHashesRef.current - 1);
          if (unusedHashesRef.current < APAY_HASH_REFILL_THRESHOLD) {
            try {
              const pool = await lspB.refillHashPool();
              unusedHashesRef.current = pool.unusedHashes;
              addLog(`Hash pool refilled (unusedHashes → ${pool.unusedHashes})`, 'success');
            } catch (e: any) {
              addLog(`Hash pool refill failed: ${e?.message ?? e}`, 'info');
            }
          }
        }

        setPhase('done');
      } finally {
        keepaliveActiveRef.current = false;
      }
    } catch (e: any) {
      addLog(`Fatal: ${e?.message ?? String(e)}`, 'error');
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, [addLog, waitForContinue]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    keepaliveActiveRef.current = false;
    // Release a parked gate so the awaiting run can observe the abort and exit.
    continueFlow();
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    setPhase('idle');
    setLog([]); setErrorMsg('');
    setPubkeyB(''); setLnaddrUsername(''); setLnaddrDomain('');
    setLightningAddress(''); setHashPoolInfo(null);
    setChannelB(null); setChannelA(null);
    setHodlBolt11(''); setPaymentHash('');
    setSendStatus(''); setMerchantOnline(false); setFinalBalB(null);
  }, [continueFlow]);

  const lnAddress = lightningAddress
    || (lnaddrUsername && lnaddrDomain ? `${lnaddrUsername}@${lnaddrDomain}` : '');

  return {
    phase,
    log,
    errorMsg,
    run,
    reset,
    pubkeyB,
    lnaddrUsername,
    lnaddrDomain,
    lnAddress,
    hashPoolInfo,
    channelB,
    channelA,
    hodlBolt11,
    paymentHash,
    sendStatus,
    merchantOnline,
    finalBalB,
    awaitingContinue,
    continueFlow,
    envReady: !!ASSET_ID,
    isRunning: !['idle', 'done', 'error'].includes(phase),
  };
}
