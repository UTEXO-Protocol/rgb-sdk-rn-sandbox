/**
 * UTEXO signet mirror of test_virtual_channel_asset_payment_succeeds.
 *
 * Same logic as the regtest virtual channel flow, adapted for signet:
 *  - Funding via sendToAddressUtexo (faucet) instead of sendToAddress + mine
 *  - No mine() calls — blocks arrive naturally every ~100 s
 *  - Longer timeouts throughout
 *  - network: 'utexo', unlock via buildUtexoConfig()
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { sendToAddressUtexo } from '@/utils/wallet-flow';
import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';

import {
  CHANNEL_ASSET_AMOUNT, CHANNEL_CAPACITY_SAT, CHANNEL_TIMEOUT_MS,
  FAUCET_AMOUNT_SAT, FUND_TIMEOUT_MS, ISSUE_TIMEOUT_MS,
  PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT, PAYMENT_TIMEOUT_MS,
  POLL_MS, UTXO_TIMEOUT_MS, VIRTUAL_OPEN_MODE,
  UNLOCK, sleep, short, satStr,
  type LogEntry, type Phase,
} from './config';

export function useVirtualChannelSignetFlow() {
  const [phase,     setPhase]     = useState<Phase>('idle');
  const [log,       setLog]       = useState<LogEntry[]>([]);
  const [pubkeyA,   setPubkeyA]   = useState('');
  const [pubkeyB,   setPubkeyB]   = useState('');
  const [addrA,     setAddrA]     = useState('');
  const [addrB,     setAddrB]     = useState('');
  const [assetId,   setAssetId]   = useState('');
  const [chanA,     setChanA]     = useState<any>(null);
  const [chanB,     setChanB]     = useState<any>(null);
  const [invoiceAB, setInvoiceAB] = useState('');
  const [invoiceBA, setInvoiceBA] = useState('');
  const [statusAB,  setStatusAB]  = useState('');
  const [statusBA,  setStatusBA]  = useState('');
  const [balA,      setBalA]      = useState<any>(null);
  const [balB,      setBalB]      = useState<any>(null);
  const [errorMsg,  setErrorMsg]  = useState('');

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef   = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[vc-signet][${type}] ${msg}`);
  }, []);

  // Poll until settled BTC balance > 0
  const pollFunded = useCallback(async (w: UTEXOWallet<'RGB_LN'>, label: string): Promise<void> => {
    const deadline = Date.now() + FUND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (abortRef.current) throw new Error('Cancelled');
      await sleep(POLL_MS);
      try {
        await w.syncWallet();
        const b = await w.getBtcBalance() as any;
        const st = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
        addLog(`${label} settled: ${satStr(st)}`);
        if (st > 0) { addLog(`${label} funded ✓`, 'success'); return; }
      } catch (e: any) { addLog(`fund poll error: ${e?.message ?? e}`, 'error'); }
    }
    throw new Error(`Timed out waiting for ${label} to be funded`);
  }, [addLog]);

  // Poll until any spendable BTC appears (createUtxos tx confirmed)
  const pollUtxosConfirmed = useCallback(async (w: UTEXOWallet<'RGB_LN'>, label: string): Promise<void> => {
    const deadline = Date.now() + UTXO_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (abortRef.current) throw new Error('Cancelled');
      await sleep(POLL_MS);
      try {
        await w.syncWallet();
        const b = await w.getBtcBalance() as any;
        const sp = (b?.vanilla?.spendable ?? 0) + (b?.colored?.spendable ?? 0);
        addLog(`${label} spendable: ${satStr(sp)}`);
        if (sp > 0) { addLog(`${label} UTXOs confirmed ✓`, 'success'); return; }
      } catch (e: any) { addLog(`utxo poll error: ${e?.message ?? e}`, 'error'); }
    }
    addLog(`${label} UTXO confirmation timeout — continuing`);
  }, [addLog]);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setAssetId(''); setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setBalA(null); setBalB(null); setErrorMsg('');

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    try {
      // ── Init Node A ──────────────────────────────────────────────────────────
      setPhase('init');

      req('createWallet nodeA');
      const keysA = await createWallet('utexo' as any);
      res('createWallet nodeA', { fp: keysA.masterFingerprint });

      const ts    = Date.now();
      const portA = 43000 + Math.floor(Math.random() * 1000);
      const dirAUri = `${documentDirectory ?? ''}vc_sig_na_${ts}`;
      await FileSystem.makeDirectoryAsync(dirAUri, { intermediates: true });
      addLog(`nodeA storage: ${dirAUri.replace('file://', '')}`);

      const wA = new UTEXOWallet(
        { storageDirPath: dirAUri.replace('file://', ''), daemonListeningPort: portA,
          ldkPeerListeningPort: portA + 1, network: 'utexo',
          enableVirtualChannelsV0: true },
        new PasswordRLNSigner('vcpass_a', keysA.mnemonic),
      );
      walletARef.current = wA;
      await wA.init();
      await wA.unlock(UNLOCK);

      const infoA = await wA.getNodeInfo();
      const pkA = String(infoA.pubkey ?? '');
      setPubkeyA(pkA);
      res('nodeA.init+unlock', { pubkey: short(pkA, 20) });

      req('nodeA.getAddress');
      const addressA = await wA.getAddress();
      setAddrA(addressA);
      res('nodeA.getAddress', { address: addressA });

      // ── Init Node B ──────────────────────────────────────────────────────────
      setPhase('init_b');

      req('createWallet nodeB');
      const keysB = await createWallet('utexo' as any);
      res('createWallet nodeB', { fp: keysB.masterFingerprint });

      const portB   = portA + 200;
      const dirBUri = `${documentDirectory ?? ''}vc_sig_nb_${ts}`;
      await FileSystem.makeDirectoryAsync(dirBUri, { intermediates: true });
      addLog(`nodeB storage: ${dirBUri.replace('file://', '')}`);

      const wB = new UTEXOWallet(
        { storageDirPath: dirBUri.replace('file://', ''), daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1, network: 'utexo',
          enableVirtualChannelsV0: true,
          virtualPeerPubkeys: pkA ? [pkA] : null },
        new PasswordRLNSigner('vcpass_b', keysB.mnemonic),
      );
      walletBRef.current = wB;
      await wB.init();
      await wB.unlock(UNLOCK);

      const infoB = await wB.getNodeInfo();
      const pkB = String(infoB.pubkey ?? '');
      setPubkeyB(pkB);
      res('nodeB.init+unlock', { pubkey: short(pkB, 20) });

      req('nodeB.getAddress');
      const addressB = await wB.getAddress();
      setAddrB(addressB);
      res('nodeB.getAddress', { address: addressB });

      // ── Fund both nodes via signet faucet ────────────────────────────────────
      setPhase('fund');

      addLog(`Funding both nodes via faucet (${FAUCET_AMOUNT_SAT} sat each) …`);
      try {
        await sendToAddressUtexo(addressA, FAUCET_AMOUNT_SAT);
        addLog(`Faucet → nodeA sent ✓`);
      } catch (e: any) {
        addLog(`Faucet → nodeA: ${e?.message ?? e}`, 'error');
      }
      try {
        await sendToAddressUtexo(addressB, FAUCET_AMOUNT_SAT);
        addLog(`Faucet → nodeB sent ✓`);
      } catch (e: any) {
        addLog(`Faucet → nodeB: ${e?.message ?? e}`, 'error');
      }
      addLog(`Waiting for nodeA balance to settle on signet (up to 15 min) …`);
      await pollFunded(wA, 'nodeA');
      addLog(`Waiting for nodeB balance to settle …`);
      await pollFunded(wB, 'nodeB');

      // ── Create UTXOs on both nodes ───────────────────────────────────────────
      setPhase('utxos');

      await wA.syncWallet(); await wB.syncWallet();
      await wA.refreshWallet(); await wB.refreshWallet();

      req('nodeA.createUtxos', { num: 5, size: 7000, feeRate: 2 });
      await wA.createUtxos({ upTo: false, num: 5, size: 7000, feeRate: 2 });
      req('nodeB.createUtxos', { num: 5, size: 7000, feeRate: 2 });
      await wB.createUtxos({ upTo: false, num: 5, size: 7000, feeRate: 2 });
      res('createUtxos nodeA+B');

      addLog('Waiting for createUtxos to confirm on signet …');
      await pollUtxosConfirmed(wA, 'nodeA');

      // ── Node A issues RGB asset ──────────────────────────────────────────────
      setPhase('issue');

      await wA.refreshWallet();

      req('nodeA.issueAssetNia', { ticker: 'VTST', supply: 1000 });
      const asset = await wA.issueAssetNia({ ticker: 'VTST', name: 'Virtual Test', precision: 0, amounts: [1000] });
      const aid = asset.assetId;
      setAssetId(aid);
      res('nodeA.issueAssetNia', { assetId: short(aid, 20) });

      addLog('Waiting for asset issuance to settle on signet (up to 30 min) …');
      const issueDeadline = Date.now() + ISSUE_TIMEOUT_MS;
      while (Date.now() < issueDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        await wA.syncWallet();
        const ab = await wA.getAssetBalance(aid);
        if ((ab?.settled ?? 0) > 0) {
          addLog(`nodeA asset settled: ${ab.settled} VTST ✓`, 'success');
          break;
        }
      }

      // ── Connect peers ────────────────────────────────────────────────────────
      setPhase('connect');

      const peerUri = `${pkB}@127.0.0.1:${portB + 1}`;
      req('nodeA.connectPeer', { uri: short(peerUri, 30) });
      await wA.connectPeer(peerUri);
      await sleep(2000);
      res('nodeA.connectPeer');

      // ── Open virtual RGB channel ─────────────────────────────────────────────
      setPhase('open_channel');

      req('nodeA.openChannel', { capacitySat: CHANNEL_CAPACITY_SAT, assetAmount: CHANNEL_ASSET_AMOUNT, virtualOpenMode: VIRTUAL_OPEN_MODE });
      const openResp = await wA.openChannel({
        peerPubkey: peerUri,
        capacitySat: CHANNEL_CAPACITY_SAT,
        pushMsat: 0,
        isPublic: false,
        withAnchors: true,
        assetId: aid,
        assetLocalAmount: CHANNEL_ASSET_AMOUNT,
        pushAssetAmount: null,
        virtualOpenMode: VIRTUAL_OPEN_MODE,
      });
      res('nodeA.openChannel', { tmpChanId: short(openResp.temporaryChannelId, 16) });

      // ── Wait for channel usable (no mining — pure polling) ───────────────────
      setPhase('wait_channel');

      addLog(`Waiting for virtual RGB channel (timeout ${CHANNEL_TIMEOUT_MS / 60000} min) …`);
      const chanDeadline = Date.now() + CHANNEL_TIMEOUT_MS;
      let nodeAChan: any = null;
      let nodeBChan: any = null;
      while (Date.now() < chanDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        try {
          await wA.syncWallet(); await wB.syncWallet();
          const chansA = (await wA.listChannels()) ?? [];
          nodeAChan = (chansA as any[]).find(c => c.assetId === aid && (c.isUsable === true || c.is_usable === true)) ?? null;
          const chansB = (await wB.listChannels()) ?? [];
          nodeBChan = (chansB as any[]).find(c => c.assetId === aid && (c.isUsable === true || c.is_usable === true)) ?? null;
          addLog(`nodeA: ${nodeAChan ? 'usable ✓' : 'waiting…'}  nodeB: ${nodeBChan ? 'visible ✓' : 'waiting…'}`);
          if (nodeAChan && nodeBChan) break;
        } catch (e: any) {
          addLog(`listChannels: ${e?.message ?? e}`, 'error');
        }
      }

      if (!nodeAChan) throw new Error(`Timed out waiting for Node A virtual RGB channel after ${CHANNEL_TIMEOUT_MS / 60000} min`);
      setChanA(nodeAChan);
      if (nodeBChan) setChanB(nodeBChan);
      else addLog('Node B channel not yet visible — continuing');
      addLog(`Channel open ✓  mode=${nodeAChan.virtualOpenMode ?? VIRTUAL_OPEN_MODE}  localAsset=${nodeAChan.assetLocalAmount ?? '?'}`, 'success');

      await wA.syncWallet(); await wB.syncWallet();
      const initBalA = await wA.getAssetBalance(aid);
      const initBalB = await wB.getAssetBalance(aid);
      addLog(`initial offchain: nodeA outbound=${initBalA?.offchainOutbound ?? 'n/a'}  nodeB outbound=${initBalB?.offchainOutbound ?? 'n/a'}`);

      // ── Part 1: A → B payment ────────────────────────────────────────────────
      setPhase('pay_ab');

      req('nodeB.createLightningInvoice', { msat: PAYMENT_MSAT, assetAmount: PAYMENT_ASSET_AMOUNT });
      const invAB = await wB.createLightningInvoice({
        amountSats: PAYMENT_MSAT / 1000,
        expirySeconds: 3600,
        asset: { assetId: aid, amount: PAYMENT_ASSET_AMOUNT },
      });
      const invoiceABStr = invAB.lnInvoice;
      setInvoiceAB(invoiceABStr);
      res('nodeB.createLightningInvoice', { invoice: short(invoiceABStr, 28) });

      req('nodeA.payLightningInvoice → nodeB');
      const payAB = await wA.payLightningInvoice({ lnInvoice: invoiceABStr });
      const payABStatus = String((payAB as any)?.status ?? '').toUpperCase();
      res('nodeA.payLightningInvoice', { status: (payAB as any)?.status ?? 'sent' });
      if (payABStatus === 'FAILED') throw new Error('A→B payment failed immediately');

      // ── Wait for A→B settlement ──────────────────────────────────────────────
      setPhase('settle_ab');
      setStatusAB('Pending');

      addLog('Waiting for A→B invoice to settle …');
      const deadlineAB = Date.now() + PAYMENT_TIMEOUT_MS;
      let settledAB = false;
      while (Date.now() < deadlineAB) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        await wA.syncWallet(); await wB.syncWallet();
        try {
          const st = String(await wB.invoiceStatus(invoiceABStr) ?? 'Pending');
          setStatusAB(st);
          addLog(`A→B invoice: ${st}`);
          if (st === 'SUCCEEDED') { settledAB = true; break; }
          if (st === 'FAILED' || st === 'CANCELLED') throw new Error(`A→B invoice ${st}`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.includes('FAILED') || msg.includes('CANCELLED')) throw e;
          addLog(`invoiceStatus error: ${msg}`);
        }
      }
      if (!settledAB) addLog('A→B settlement timeout — invoice may still be processing');
      else addLog('A→B payment Succeeded ✓', 'success');

      const afterABbalA = await wA.getAssetBalance(aid);
      const afterABbalB = await wB.getAssetBalance(aid);
      setBalA(afterABbalA); setBalB(afterABbalB);
      addLog(`offchain after A→B: nodeA=${afterABbalA?.offchainOutbound ?? 'n/a'}  nodeB=${afterABbalB?.offchainOutbound ?? 'n/a'}`);

      // ── Part 2: B → A reverse payment ────────────────────────────────────────
      setPhase('pay_ba');

      req('nodeA.createLightningInvoice (reverse)', { msat: PAYMENT_MSAT, assetAmount: PAYMENT_ASSET_AMOUNT });
      const invBA = await wA.createLightningInvoice({
        amountSats: PAYMENT_MSAT / 1000,
        expirySeconds: 3600,
        asset: { assetId: aid, amount: PAYMENT_ASSET_AMOUNT },
      });
      const invoiceBAStr = invBA.lnInvoice;
      setInvoiceBA(invoiceBAStr);
      res('nodeA.createLightningInvoice', { invoice: short(invoiceBAStr, 28) });

      req('nodeB.payLightningInvoice → nodeA');
      const payBA = await wB.payLightningInvoice({ lnInvoice: invoiceBAStr });
      const payBAStatus = String((payBA as any)?.status ?? '').toUpperCase();
      res('nodeB.payLightningInvoice', { status: (payBA as any)?.status ?? 'sent' });
      if (payBAStatus === 'FAILED') throw new Error('B→A reverse payment failed immediately');

      // ── Wait for B→A settlement ──────────────────────────────────────────────
      setPhase('settle_ba');
      setStatusBA('Pending');

      addLog('Waiting for B→A reverse invoice to settle …');
      const deadlineBA = Date.now() + PAYMENT_TIMEOUT_MS;
      let settledBA = false;
      while (Date.now() < deadlineBA) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_MS);
        await wA.syncWallet(); await wB.syncWallet();
        try {
          const st = String(await wA.invoiceStatus(invoiceBAStr) ?? 'Pending');
          setStatusBA(st);
          addLog(`B→A invoice: ${st}`);
          if (st === 'SUCCEEDED') { settledBA = true; break; }
          if (st === 'FAILED' || st === 'CANCELLED') throw new Error(`B→A invoice ${st}`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.includes('FAILED') || msg.includes('CANCELLED')) throw e;
          addLog(`invoiceStatus error: ${msg}`);
        }
      }
      if (!settledBA) addLog('B→A settlement timeout — invoice may still be processing');
      else addLog('B→A reverse payment Succeeded ✓', 'success');

      const finalBalA = await wA.getAssetBalance(aid);
      const finalBalB = await wB.getAssetBalance(aid);
      setBalA(finalBalA); setBalB(finalBalB);
      addLog(`final offchain: nodeA=${finalBalA?.offchainOutbound ?? 'n/a'}  nodeB=${finalBalB?.offchainOutbound ?? 'n/a'}`);

      setPhase('done');

    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`Fatal: ${msg}`, 'error');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [addLog, pollFunded, pollUtxosConfirmed]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    setPhase('idle'); setLog([]);
    setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setAssetId(''); setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setBalA(null); setBalB(null); setErrorMsg('');
  }, []);

  return {
    phase, log, pubkeyA, pubkeyB, addrA, addrB, assetId,
    chanA, chanB, invoiceAB, invoiceBA, statusAB, statusBA,
    balA, balB, errorMsg, run, reset,
  };
}
