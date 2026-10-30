/**
 * APay · SCID-alias JIT reproduction flow — Signet (UTEXO).
 *
 * Mirrors screens/apay-scid-repro/useScidReproFlow.ts (regtest) but runs
 * against the live signet stack and the production LSP. See that file and
 * docs/issue-49-scid-alias-repro.md for the root-cause write-up.
 *
 * Steps (identical to the issue):
 *   1. Fresh receiver wallet, network 'utexo'; createLsp() (auto virtual
 *      channels + LSP pubkey) BEFORE init().
 *   2. OUR faucet node funds it with BTC; create colorable UTXOs.
 *   3. lsp.connect(), then lsp.receiveAsset().
 *   4. The faucet pays the RGB invoice (decodergbinvoice + sendrgb).
 *   5. Watch whether the LSP delivers over a JIT channel — if it opens a PLAIN
 *      channel the receiver force-closes it and the RGB is stranded (#49).
 *
 * Signet vs regtest: no mining (poll for confirmations), no LSP RLN daemon REST
 * (we observe the faucet Send + the receiver side only).
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

import { faucet } from '../apay-signet/daemons';
import { buildReport } from '../apay-scid-repro/report';
import {
  ASSET_ID,
  DELIVER_WATCH_MS,
  FAUCET_BTC_SAT,
  FAUCET_NODE_URL,
  FAUCET_PAY_AMOUNT,
  FEE_RATE,
  FUND_TIMEOUT_MS,
  LSP_URL,
  PAYMENT_ASSET_AMOUNT,
  PAYMENT_MSAT,
  POLL_MS,
  SETTLE_TIMEOUT_MS,
  UNLOCK,
  UTXO_NUM,
  short,
  sleep,
  type ChannelSample,
  type LogEntry,
  type Phase,
  type ReproVerdict,
} from './config';

export function useScidReproSignetFlow() {
  const logTag = 'apay-scid-sig';

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

    const timeline: ChannelSample[] = [];
    const seenChannelIds = new Set<string>();
    const startedAt = Date.now();

    // Record the receiver's channels to the LSP (fall back to all channels when
    // the LSP pubkey is unknown — a fresh wallet only has channels to the LSP).
    const recordChannels = async (w: UTEXOWallet<'RGB_LN'>, lspPubkey: string) => {
      let channels: any[] = [];
      try { channels = (await w.listChannels()) as any[]; } catch { /* transient */ }
      const toLsp = lspPubkey
        ? channels.filter((c: any) => (c.peerPubkey ?? c.peer_pubkey) === lspPubkey)
        : channels;
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
      return toLsp;
    };

    // Full asset-balance breakdown (settled / owned outbound / receivable inbound).
    const snapBal = async (w: UTEXOWallet<'RGB_LN'>, label: string) => {
      const b = await w.getAssetBalance(ASSET_ID).catch(() => null) as any;
      addLog(`${label} balance: settled=${b?.settled ?? 0} future=${b?.future ?? 0} `
        + `spendable=${b?.spendable ?? 0} offchainOutbound=${b?.offchainOutbound ?? 0} `
        + `offchainInbound=${b?.offchainInbound ?? 0}`, 'info');
      return b;
    };

    // Dump every channel with all its fields (capacity, balances, asset amounts, status).
    const dumpChannels = async (w: UTEXOWallet<'RGB_LN'>, label: string) => {
      let chans: any[] = [];
      try { chans = (await w.listChannels()) as any[]; } catch { /* transient */ }
      addLog(`${label} listChannels (${chans.length}):`, 'info');
      chans.forEach((c, i) => addLog(`  [${i}] ${JSON.stringify(c)}`, 'info'));
      return chans;
    };

    // Poll a wallet until settled BTC > 0 (funding confirmed on signet).
    const pollFunded = async (w: UTEXOWallet<'RGB_LN'>): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        try {
          await w.syncWallet();
          const b = await w.getBtcBalance() as any;
          const st = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
          addLog(`receiver settled BTC: ${st} sat`);
          if (st > 0) return;
        } catch (e: any) { console.error(`[${logTag}] fund poll`, e?.message ?? e); }
      }
      throw new Error('Timed out waiting for receiver BTC funding');
    };

    // Poll until createUtxos confirms (spendable appears).
    const pollUtxos = async (w: UTEXOWallet<'RGB_LN'>): Promise<void> => {
      const deadline = Date.now() + FUND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        try {
          await w.syncWallet();
          const b = await w.getBtcBalance() as any;
          const sp = (b?.vanilla?.spendable ?? 0) + (b?.colored?.spendable ?? 0);
          addLog(`receiver spendable BTC: ${sp} sat`);
          if (sp > 0) { addLog('receiver UTXOs confirmed ✓', 'success'); return; }
        } catch (e: any) { console.error(`[${logTag}] utxo poll`, e?.message ?? e); }
      }
      addLog('receiver UTXO confirmation timeout — continuing');
    };

    let rgbAtLspLocal: boolean | null = null;
    let deliveredLocal: boolean | null = null;

    try {
      // ── Preflight ──────────────────────────────────────────────────────────
      setPhase('preflight');
      addLog(`Platform=${Platform.OS}  network=utexo (signet)`);
      addLog(`LSP_URL=${LSP_URL}`);
      addLog('Config: createLsp() → virtual channels ON (identical to issue #49)', 'info');
      if (!ASSET_ID) throw new Error('ASSET_ID not set in apay-signet/config');
      if (!FAUCET_NODE_URL) throw new Error('EXPO_PUBLIC_FAUCET_NODE_URL not set — add the signet faucet REST URL to .env.local');
      addLog(`Asset: ${short(ASSET_ID, 28)}`, 'success');

      let lspPubkey = '';
      try {
        const info = await fetch(`${LSP_URL}/get_info`).then(r => r.json()) as { pubkey?: string };
        lspPubkey = info?.pubkey ?? '';
        addLog(`LSP pubkey: ${lspPubkey ? short(lspPubkey) : '(unknown)'}`, lspPubkey ? 'success' : 'info');
      } catch (e: any) {
        addLog(`GET /get_info failed: ${e?.message ?? e} — continuing (channel filter falls back to all)`, 'info');
      }

      req('faucet.assetBalance', { assetId: short(ASSET_ID) });
      const fBal = await faucet.assetBalance(ASSET_ID);
      res('faucet.assetBalance', { settled: fBal.settled, spendable: fBal.spendable });
      if (Number(fBal.spendable) < FAUCET_PAY_AMOUNT) {
        throw new Error(`Faucet has no spendable RGB (${fBal.spendable})`);
      }

      // ── Receiver wallet — createLsp() enables virtual channels ──────────────
      setPhase('init');
      const keys = await createWallet('utexo' as any);
      const port = 47000 + Math.floor(Math.random() * 2000);
      const dirUri = `${documentDirectory ?? ''}apay_scid_sig_${Date.now()}`;
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });

      const w = new UTEXOWallet(
        {
          storageDirPath: dirUri.replace('file://', ''),
          daemonListeningPort: port,
          ldkPeerListeningPort: port + 1,
          network: 'utexo',
        },
        // Password must be >= 8 chars (rgb-lightning-node password_min_length,
        // default 8) or rlnInitNode fails with RlnException.InvalidRequest.
        new PasswordRLNSigner('scidsignet', keys.mnemonic),
      );
      walletRef.current = w;

      // createLsp() BEFORE init() — discovers the LSP pubkey and bakes in
      // enableVirtualChannelsV0 + virtualPeerPubkeys=[LSP].
      const lsp = await w.createLsp();
      await w.init();
      await w.unlock(UNLOCK);
      const nodePubkey = String((await w.getNodeInfo())?.pubkey ?? '');
      setPubkey(nodePubkey);
      res('receiver.init', { pubkey: short(nodePubkey) });

      // ── Fund + UTXOs (via the faucet, no mining) ────────────────────────────
      setPhase('fund');
      const addr = await w.getAddress();
      req('faucet.sendBtc receiver', { amount: FAUCET_BTC_SAT, address: short(addr, 18) });
      await faucet.sendBtc(addr, FAUCET_BTC_SAT, FEE_RATE);
      res('faucet.sendBtc');
      await pollFunded(w);
      addLog('receiver funded ✓', 'success');

      setPhase('utxos');
      req('receiver.createUtxos', { num: UTXO_NUM, feeRate: FEE_RATE });
      await w.syncWallet();
      await w.refreshWallet();
      await w.createUtxos({ upTo: false, num: UTXO_NUM, feeRate: FEE_RATE });
      res('receiver.createUtxos');
      await pollUtxos(w);

      // ── Connect + request inbound RGB ───────────────────────────────────────
      setPhase('connect');
      req('lsp.connect');
      await lsp.connect();
      res('lsp.connect');

      setPhase('receive');
      addLog('Receiver requests inbound RGB via lightning_receive — LSP will open a JIT channel…');
      req('lsp.receiveAsset', { assetId: short(ASSET_ID), amountSats: PAYMENT_MSAT / 1000, amountRgb: PAYMENT_ASSET_AMOUNT });
      const { lnInvoice, rgbInvoice } = await lsp.receiveAsset({
        assetId: ASSET_ID,
        amountSats: PAYMENT_MSAT / 1000,
        amountRgb: PAYMENT_ASSET_AMOUNT,
      });
      res('lsp.receiveAsset', { lnInvoice: short(lnInvoice, 28), rgbInvoice: short(rgbInvoice, 28) });

      // ── Faucet pays the RGB invoice ─────────────────────────────────────────
      setPhase('faucet_send');
      addLog('OUR faucet node pays the RGB invoice (sends the asset to the LSP)…');
      req('faucet.decodeRgbInvoice');
      const decoded = await faucet.decodeRgbInvoice(rgbInvoice);
      const recipientId = decoded.recipient_id;
      const endpoints = decoded.transport_endpoints ?? [];
      const assignment = (decoded.assignment?.type === 'Fungible' && decoded.assignment?.value > 0)
        ? decoded.assignment
        : { type: 'Fungible', value: FAUCET_PAY_AMOUNT };
      res('faucet.decodeRgbInvoice', { recipientId: short(recipientId, 24) });

      req('faucet.sendRgb', { amount: assignment.value, recipientId: short(recipientId, 20) });
      await faucet.sendRgb({
        donation: false, fee_rate: FEE_RATE, min_confirmations: 1, skip_sync: false,
        recipient_map: {
          [ASSET_ID]: [{ recipient_id: recipientId, assignment, transport_endpoints: endpoints }],
        },
      });
      res('faucet.sendRgb');
      await sleep(3000);
      await faucet.refresh().catch(() => {});

      // ── Wait for the faucet Send to settle (RGB reaches the LSP) ────────────
      setPhase('lsp_settle');
      addLog('Waiting for faucet Send to settle (signet confirmations)…');
      const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (Date.now() < settleDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        await faucet.refresh().catch(() => {});
        await recordChannels(w, lspPubkey);
        const ft = await faucet.listTransfers(ASSET_ID).catch(() => null);
        const fSend = ft ? [...(ft.transfers ?? [])].reverse().find((t: any) => t.kind === 'Send') : null;
        addLog(`faucet Send: ${fSend?.status ?? 'none'}`);
        if (fSend?.status === 'Failed') throw new Error('Faucet RGB send failed');
        if (fSend?.status === 'Settled') { rgbAtLspLocal = true; break; }
      }
      setRgbAtLsp(!!rgbAtLspLocal);
      addLog(rgbAtLspLocal ? 'Faucet Send Settled ✓ — RGB delivered to the LSP' : 'Faucet Send did not settle in time', rgbAtLspLocal ? 'success' : 'error');

      // ── Watch whether the LSP delivers via a JIT channel ────────────────────
      // The #49 signature is the CHANNEL never becoming usable (force-close).
      // Actual payment settlement (invoice Succeeded / owned balance rising) is a
      // separate detail we also track — offchainInbound is channel receive-capacity,
      // NOT proof of delivery, so it must not be used as the delivered signal.
      setPhase('deliver');
      const startBal = await snapBal(w, 'deliver START');
      await dumpChannels(w, 'deliver START');
      const startOutbound = Number(startBal?.offchainOutbound ?? 0);

      addLog(`Watching ${Math.round(DELIVER_WATCH_MS / 60000)} min for the LSP to deliver over a JIT channel…`);
      const deliverDeadline = Date.now() + DELIVER_WATCH_MS;
      let lastInvoiceStatus = '';
      let everUsable = false;
      while (Date.now() < deliverDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        await w.syncWallet();
        const toLsp = await recordChannels(w, lspPubkey);
        const usableNow = toLsp.some((c: any) => (c.isUsable ?? c.is_usable ?? c.ready));
        if (usableNow) everUsable = true;
        try { lastInvoiceStatus = String(await w.getLightningReceiveStatus(lnInvoice)); } catch { /* keep last */ }
        const bal = await w.getAssetBalance(ASSET_ID).catch(() => null) as any;
        const inbound = Number(bal?.offchainInbound ?? 0);
        const outbound = Number(bal?.offchainOutbound ?? 0);
        const paid = lastInvoiceStatus === 'Succeeded' || (outbound - startOutbound) >= PAYMENT_ASSET_AMOUNT;
        addLog(`channels→LSP: ${toLsp.length}  usable: ${usableNow ? 'yes' : 'no'}  invoice: ${lastInvoiceStatus || '?'}  `
          + `inbound: ${inbound}  outbound: ${outbound} (Δ${outbound - startOutbound})`,
          usableNow ? 'success' : 'info');
        if (paid) { deliveredLocal = true; break; }
      }
      if (deliveredLocal == null) deliveredLocal = false;
      setDelivered(deliveredLocal);

      await snapBal(w, 'deliver END');
      await dumpChannels(w, 'deliver END');

      // ── Classify ────────────────────────────────────────────────────────────
      // Verdict keys off the channel: a usable channel means the LSP did NOT hit
      // the scid_alias force-close, so #49 did not reproduce — regardless of
      // whether the LN invoice has finished settling yet.
      let v: ReproVerdict;
      if (!rgbAtLspLocal) v = 'inconclusive';
      else if (everUsable) v = 'not-reproduced';
      else v = 'reproduced';
      setVerdict(v);

      if (v === 'reproduced') {
        addLog(`#49 REPRODUCED: RGB settled at the LSP but the JIT channel never became usable `
          + `(force-closed). LSP opened ${seenChannelIds.size} channel(s), none usable. `
          + `Invoice stuck at "${lastInvoiceStatus || 'Pending'}". Asset stranded at the LSP.`, 'error');
      } else if (v === 'not-reproduced') {
        addLog(`No #49: the LSP opened a USABLE (virtual) channel — no scid_alias force-close. `
          + `Payment ${deliveredLocal ? 'settled ✓' : `not yet settled (invoice "${lastInvoiceStatus || 'Pending'}") — `
            + `channel is up with inbound liquidity but the LN leg is still in flight`}.`,
          deliveredLocal ? 'success' : 'info');
      } else {
        addLog('RGB never reached the LSP — infra/connectivity problem, not #49.', 'error');
      }

      // ── Report ──────────────────────────────────────────────────────────────
      setPhase('report');
      const md = buildReport({
        network: 'signet (utexo)',
        verdict: v,
        pubkey: nodePubkey,
        lspPubkey,
        assetId: ASSET_ID,
        distinctChannels: seenChannelIds.size,
        timeline,
        rgbAtLsp: !!rgbAtLspLocal,
        delivered: deliveredLocal,
        lastInvoiceStatus,
        watchSeconds: Math.round(DELIVER_WATCH_MS / 1000),
      });
      setReportMd(md);
      try {
        const p = `${documentDirectory ?? ''}issue-49-scid-repro-signet-${Date.now()}.md`;
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
    envReady: !!ASSET_ID && !!FAUCET_NODE_URL,
    isRunning: !['idle', 'done', 'error'].includes(phase),
  };
}
