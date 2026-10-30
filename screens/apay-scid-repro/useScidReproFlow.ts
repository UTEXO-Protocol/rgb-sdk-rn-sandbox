/**
 * APay · SCID-alias JIT reproduction flow (regtest).
 *
 * Reproduces UTEXO-Protocol/rgb-sdk-rn#49. See ./config.ts and
 * docs/issue-49-scid-alias-repro.md for the full write-up.
 *
 * Config-identical to the issue report — virtual channels ON:
 *   enableVirtualChannelsV0: true
 *   virtualPeerPubkeys: [LSP pubkey]
 *   lspBaseUrl: LSP_URL
 *   createLsp() BEFORE init()  (beta.20+ requirement)
 *
 * Shape of the reproduction (mirrors the issue's steps):
 *   1. Fresh receiver wallet with the config above; fund + UTXOs.
 *   2. lsp.connect(), then lsp.receiveAsset() — the receiver asks for inbound
 *      RGB. This is what makes the LSP open a JIT channel to deliver it.
 *   3. OUR faucet RLN node pays the RGB invoice (decodergbinvoice + sendrgb),
 *      sending the asset on-chain to the LSP.
 *   4. The RGB settles AT THE LSP (faucet Send + LSP ReceiveBlind = Settled).
 *   5. The LSP opens a JIT channel to the receiver requesting scid_alias
 *      (channel_type [0,16]); the receiver's LDK has negotiate_scid_privacy
 *      = false and force-closes it (`unsupported_scid_alias`) — EVEN THOUGH
 *      the LSP is whitelisted as a virtual peer. So the channel never becomes
 *      usable and the RGB can never be delivered.
 *   6. The receiver's LN invoice never settles and offchainInbound stays 0 —
 *      the asset is stranded at the LSP. That is #49.
 *
 * Verdict is driven by the user-visible symptom (delivery vs stranding); the
 * channel timeline is captured as supporting evidence. The literal LDK reason
 * (`unsupported_scid_alias`) lives in the LSP node log — the report says how
 * to read it.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { mine, sendToAddress } from '@/utils/wallet-flow';
import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
} from '@utexo/rgb-sdk-rn';

import { daemonPost, faucet, lspDaemon } from '../lsp-regtest/daemons';
import {
  ASSET_ID,
  DELIVER_WATCH_S,
  FAUCET_PAY_AMOUNT,
  host,
  LSP_DAEMON_URL,
  LSP_LDK_PORT,
  LSP_PEER_PUBKEY_DEFAULT,
  LSP_URL,
  PAYMENT_ASSET_AMOUNT,
  PAYMENT_MSAT,
  POLL_INTERVAL_MS,
  REGTEST_UNLOCK,
  RGB_SETTLE_S,
  short,
  sleep,
  type ChannelSample,
  type LogEntry,
  type Phase,
  type ReproVerdict,
} from './config';
import { buildReport } from './report';

export function useScidReproFlow() {
  const logTag = 'apay-scid';

  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const [pubkey, setPubkey] = useState('');
  const [verdict, setVerdict] = useState<ReproVerdict>('pending');
  const [samples, setSamples] = useState<ChannelSample[]>([]);
  const [reportMd, setReportMd] = useState('');
  const [reportPath, setReportPath] = useState('');
  const [rgbAtLsp, setRgbAtLsp] = useState<boolean | null>(null);
  const [delivered, setDelivered] = useState<boolean | null>(null);

  const walletRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[${logTag}][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setErrorMsg('');
    setPubkey(''); setVerdict('pending'); setSamples([]);
    setReportMd(''); setReportPath(''); setRgbAtLsp(null); setDelivered(null);

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    // Evidence collected for the report.
    const timeline: ChannelSample[] = [];
    const seenChannelIds = new Set<string>();
    let lspSideMax = 0;
    const startedAt = Date.now();
    const receiverPubkey = { value: '' };

    const recordChannels = async (w: UTEXOWallet<'RGB_LN'>, lspPeerPubkey: string) => {
      let channels: any[] = [];
      try { channels = (await w.listChannels()) as any[]; } catch { /* transient */ }
      const toLsp = channels.filter((c: any) => (c.peerPubkey ?? c.peer_pubkey) === lspPeerPubkey);
      for (const c of toLsp) {
        const channelId = String(c.channelId ?? c.channel_id ?? '?');
        const usable = Boolean(c.isUsable ?? c.is_usable ?? c.ready);
        timeline.push({
          atMs: Date.now() - startedAt,
          channelId,
          status: String(c.status ?? '?'),
          isUsable: usable,
          ready: Boolean(c.ready),
          capacitySat: Number(c.capacitySat ?? c.capacity_sat ?? 0),
        });
        seenChannelIds.add(channelId);
      }
      setSamples([...timeline]);
      try {
        const lspChans = await daemonPost(LSP_DAEMON_URL, '/listchannels', {});
        const arr = (lspChans?.channels ?? lspChans ?? []) as any[];
        const toUs = arr.filter((c: any) => (c.peer_pubkey ?? c.peerPubkey) === receiverPubkey.value);
        lspSideMax = Math.max(lspSideMax, toUs.length);
      } catch { /* daemon may not expose /listchannels */ }
      return toLsp;
    };

    let deliveredLocal: boolean | null = null;
    let rgbAtLspLocal: boolean | null = null;

    try {
      // ── Preflight ──────────────────────────────────────────────────────────
      setPhase('preflight');
      addLog(`Platform=${Platform.OS}  host=${host}  network=regtest`);
      addLog(`LSP_URL=${LSP_URL}`);
      addLog('Config-identical to issue #49: virtual channels ENABLED (that is not enough to avoid the bug)', 'info');
      if (!ASSET_ID) throw new Error('EXPO_PUBLIC_LSP_REGTEST_ASSET_ID not set — run ./scripts/start-lsp-regtest.sh first');
      addLog(`Asset: ${short(ASSET_ID, 28)}`, 'success');

      req('lsp daemon.nodeinfo');
      const lspNodeInfo = await fetch(`${LSP_DAEMON_URL}/nodeinfo`).then(r => r.json()).catch(() => null) as any;
      const lspPeerPubkey = lspNodeInfo?.pubkey ?? LSP_PEER_PUBKEY_DEFAULT;
      if (!lspPeerPubkey) throw new Error('Could not fetch LSP pubkey — is the LSP daemon on port 3005 running?');
      res('lsp daemon.nodeinfo', { pubkey: short(lspPeerPubkey) });

      req('faucet daemon.assetbalance', { assetId: short(ASSET_ID) });
      const faucetBal = await faucet.assetBalance(ASSET_ID);
      res('faucet.assetbalance', { settled: faucetBal.settled, spendable: faucetBal.spendable });
      if (Number(faucetBal.spendable) < FAUCET_PAY_AMOUNT) {
        throw new Error(`Faucet has no spendable RGB (${faucetBal.spendable}) — re-run start-lsp-regtest.sh`);
      }

      // ── Receiver wallet — virtual channels ON (exactly like the issue) ──────
      setPhase('init');
      const keys = await createWallet('regtest' as any);
      const port = 38000 + Math.floor(Math.random() * 2000);
      const dirUri = `${documentDirectory ?? ''}apay_scid_${Date.now()}`;
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });

      const w = new UTEXOWallet(
        {
          storageDirPath: dirUri.replace('file://', ''),
          daemonListeningPort: port,
          ldkPeerListeningPort: port + 1,
          network: 'regtest',
          lspBaseUrl: LSP_URL,
          // Same config as the #49 report — virtual channels enabled, LSP
          // whitelisted as a virtual peer. This does NOT enable
          // negotiate_scid_privacy, so the scid_alias JIT channel is still
          // force-closed.
          enableVirtualChannelsV0: true,
          virtualPeerPubkeys: [lspPeerPubkey],
        },
        new PasswordRLNSigner('scidrepro', keys.mnemonic),
      );
      walletRef.current = w;

      // createLsp() BEFORE init() — beta.20+ requirement.
      const lsp = await w.createLsp(undefined, LSP_LDK_PORT);
      await w.init();
      await w.unlock(REGTEST_UNLOCK);
      const nodePubkey = String((await w.getNodeInfo())?.pubkey ?? '');
      receiverPubkey.value = nodePubkey;
      setPubkey(nodePubkey);
      res('receiver.init', { pubkey: short(nodePubkey) });

      // ── Fund + UTXOs ────────────────────────────────────────────────────────
      setPhase('fund');
      const addr = await w.getAddress();
      req('sendToAddress receiver 1 BTC');
      await sendToAddress(addr, 1);
      await mine(6);
      await sleep(3000);
      await w.syncWallet();
      res('receiver.funded');

      setPhase('utxos');
      req('receiver.createUtxos', { num: 10, feeRate: 7 });
      await w.syncWallet();
      await w.refreshWallet();
      await w.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await w.syncWallet();
      res('receiver.createUtxos');

      // ── Connect + request inbound RGB (drives the JIT channel open) ─────────
      setPhase('connect');
      req('lsp.connect');
      await lsp.connect();
      res('lsp.connect');
      await mine(2);
      await sleep(4000);

      setPhase('receive');
      addLog('Receiver requests inbound RGB via lightning_receive — this makes the LSP open a JIT channel…');
      req('lsp.receiveAsset', { assetId: short(ASSET_ID), amountSats: PAYMENT_MSAT / 1000, amountRgb: PAYMENT_ASSET_AMOUNT });
      const { lnInvoice, rgbInvoice } = await lsp.receiveAsset({
        assetId: ASSET_ID,
        amountSats: PAYMENT_MSAT / 1000,
        amountRgb: PAYMENT_ASSET_AMOUNT,
      });
      res('lsp.receiveAsset', { lnInvoice: short(lnInvoice, 28), rgbInvoice: short(rgbInvoice, 28) });

      // ── OUR faucet node pays the RGB invoice ────────────────────────────────
      setPhase('faucet_send');
      addLog('OUR faucet RLN node pays the RGB invoice (sends the asset on-chain to the LSP)…');
      req('faucet.decodergbinvoice');
      const decoded = await faucet.decodeRgbInvoice(rgbInvoice);
      const recipientId = decoded.recipient_id;
      const endpoints = decoded.transport_endpoints ?? [`rpc://${host}:3000/json-rpc`];
      const assignment = (decoded.assignment?.type === 'Fungible' && decoded.assignment?.value > 0)
        ? decoded.assignment
        : { type: 'Fungible', value: FAUCET_PAY_AMOUNT };
      res('faucet.decodergbinvoice', { recipientId: short(recipientId, 24) });

      req('faucet.sendrgb', { amount: assignment.value, recipientId: short(recipientId, 20) });
      await faucet.sendRgb({
        donation: false, fee_rate: 7, min_confirmations: 1, skip_sync: false,
        recipient_map: {
          [ASSET_ID]: [{ recipient_id: recipientId, assignment, transport_endpoints: endpoints }],
        },
      });
      res('faucet.sendrgb');
      await mine(1);
      await sleep(2000);
      await lspDaemon.refresh();
      await faucet.refresh();

      // ── Wait for the RGB to settle AT THE LSP ───────────────────────────────
      setPhase('lsp_settle');
      addLog(`Waiting up to ${RGB_SETTLE_S}s for faucet Send + LSP receive to settle …`);
      const settleDeadline = Date.now() + RGB_SETTLE_S * 1000;
      while (Date.now() < settleDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await mine(1);
        await sleep(POLL_INTERVAL_MS);
        await lspDaemon.refresh();
        await faucet.refresh();
        await recordChannels(w, lspPeerPubkey);
        const ft = await faucet.listTransfers(ASSET_ID);
        const lt = await lspDaemon.listTransfers(ASSET_ID);
        const fSend = [...(ft.transfers ?? [])].reverse().find((t: any) => t.kind === 'Send');
        const lRecv = [...(lt.transfers ?? [])].reverse().find((t: any) => t.kind === 'ReceiveBlind');
        addLog(`faucet Send: ${fSend?.status ?? 'none'}  LSP receive: ${lRecv?.status ?? 'none'}`);
        if (fSend?.status === 'Failed') throw new Error('Faucet RGB send failed');
        if (fSend?.status === 'Settled' && lRecv?.status === 'Settled') { rgbAtLspLocal = true; break; }
      }
      setRgbAtLsp(!!rgbAtLspLocal);
      addLog(
        rgbAtLspLocal
          ? 'RGB settled AT THE LSP ✓ — the asset has left the faucet and is now held by the LSP'
          : 'RGB did not confirm at the LSP within the timeout',
        rgbAtLspLocal ? 'success' : 'error',
      );

      // ── Watch whether the LSP can deliver it (JIT channel must become usable) ─
      setPhase('deliver');
      addLog(`Watching ${DELIVER_WATCH_S}s for the LSP to deliver via a JIT channel (it should NOT — scid_alias force-close)…`);
      const deliverDeadline = Date.now() + DELIVER_WATCH_S * 1000;
      let lastInvoiceStatus = '';
      let everUsable = false;
      while (Date.now() < deliverDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await mine(1);
        await sleep(POLL_INTERVAL_MS);
        await w.syncWallet();
        const toLsp = await recordChannels(w, lspPeerPubkey);
        const usableNow = toLsp.some((c: any) => (c.isUsable ?? c.is_usable ?? c.ready));
        if (usableNow) everUsable = true;
        try { lastInvoiceStatus = String(await w.getLightningReceiveStatus(lnInvoice)); } catch { /* keep last */ }
        const bal = await w.getAssetBalance(ASSET_ID).catch(() => null) as any;
        const inbound = Number(bal?.offchainInbound ?? 0);
        addLog(
          `channels→LSP: ${toLsp.length}  usable: ${usableNow ? 'yes' : 'no'}  ` +
          `distinct: ${seenChannelIds.size}  invoice: ${lastInvoiceStatus || '?'}  offchainInbound: ${inbound}`,
          usableNow ? 'success' : 'info',
        );
        if (lastInvoiceStatus === 'Succeeded' || inbound >= PAYMENT_ASSET_AMOUNT) { deliveredLocal = true; break; }
      }
      if (deliveredLocal == null) deliveredLocal = false;
      setDelivered(deliveredLocal);

      // ── Classify ────────────────────────────────────────────────────────────
      let v: ReproVerdict;
      if (!rgbAtLspLocal) v = 'inconclusive';
      else if (deliveredLocal) v = 'not-reproduced';
      else v = 'reproduced';
      setVerdict(v);

      if (v === 'reproduced') {
        addLog(`#49 REPRODUCED: RGB settled at the LSP but was never delivered to the receiver. `
          + `LSP opened ${seenChannelIds.size} channel(s), none became usable — the scid_alias JIT channel was force-closed. `
          + `Invoice stuck at "${lastInvoiceStatus || 'Pending'}", offchainInbound 0. Asset stranded at LSP.`, 'error');
      } else if (v === 'not-reproduced') {
        addLog('RGB was delivered to the receiver — #49 NOT reproduced on this stack '
          + '(the LSP channel became usable / scid_alias was accepted).', 'success');
      } else {
        addLog('RGB never reached the LSP — infrastructure/connectivity problem, not #49. '
          + 'Check the proxy port-forward and faucet inventory, then re-run.', 'error');
      }
      void everUsable;

      // ── Report ──────────────────────────────────────────────────────────────
      setPhase('report');
      const md = buildReport({
        network: 'regtest',
        verdict: v,
        pubkey: nodePubkey,
        lspPubkey: lspPeerPubkey,
        assetId: ASSET_ID,
        distinctChannels: seenChannelIds.size,
        lspSideMax,
        timeline,
        rgbAtLsp: !!rgbAtLspLocal,
        delivered: deliveredLocal,
        lastInvoiceStatus,
        watchSeconds: DELIVER_WATCH_S,
      });
      setReportMd(md);
      try {
        const p = `${documentDirectory ?? ''}issue-49-scid-repro-${Date.now()}.md`;
        await FileSystem.writeAsStringAsync(p, md);
        setReportPath(p.replace('file://', ''));
        addLog(`Report written: ${p.replace('file://', '')}`, 'success');
      } catch (e: any) {
        addLog(`Could not write report file: ${e?.message ?? e}`, 'info');
      }

      setPhase('done');
    } catch (e: any) {
      addLog(`Fatal: ${e?.message ?? String(e)}`, 'error');
      setErrorMsg(e?.message ?? String(e));
      setPhase('error');
    }
  }, [addLog]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    if (walletRef.current) { try { await walletRef.current.destroy(); } catch {} walletRef.current = null; }
    setPhase('idle'); setLog([]); setErrorMsg('');
    setPubkey(''); setVerdict('pending'); setSamples([]);
    setReportMd(''); setReportPath(''); setRgbAtLsp(null); setDelivered(null);
  }, []);

  return {
    phase,
    log,
    errorMsg,
    pubkey,
    verdict,
    samples,
    reportMd,
    reportPath,
    rgbAtLsp,
    delivered,
    run,
    reset,
    envReady: !!ASSET_ID,
    isRunning: !['idle', 'done', 'error'].includes(phase),
  };
}
