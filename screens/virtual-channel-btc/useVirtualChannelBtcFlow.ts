/**
 * Virtual Channel BTC Payment — pure-BTC variant of useVirtualChannelFlow.
 *
 * Two embedded SDK nodes open a VIRTUAL **BTC-only** channel directly (no LSP,
 * no RGB asset). Node A connects to Node B, opens the channel, then sends a
 * payment A→B and a reverse payment B→A proving bidirectional msat flow.
 *
 * BTC-only virtual channels are the simplest case: with no asset there is no
 * consignment, so the acceptor skips the RGB proxy entirely — the only moving
 * parts are the LDK virtual-channel negotiation and plain BOLT11 payments.
 *
 * Node B is created with virtualPeerPubkeys=[pkA] so it accepts Node A's
 * virtual channel open — same trust opt-in as the RGB virtual flow.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { mine, sendToAddress } from '@/utils/wallet-flow';
import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';

import {
  CHANNEL_CAPACITY_SAT, CHANNEL_TIMEOUT_S,
  PAYMENT_MSAT_AB, PAYMENT_MSAT_BA, PAYMENT_TIMEOUT_S, POLL_INTERVAL_S,
  VIRTUAL_OPEN_MODE, REGTEST_UNLOCK, sleep, short, satStr, msatStr,
  type LogEntry, type Phase,
} from './config';

export function useVirtualChannelBtcFlow() {
  const [phase,     setPhase]     = useState<Phase>('idle');
  const [log,       setLog]       = useState<LogEntry[]>([]);
  const [pubkeyA,   setPubkeyA]   = useState('');
  const [pubkeyB,   setPubkeyB]   = useState('');
  const [addrA,     setAddrA]     = useState('');
  const [addrB,     setAddrB]     = useState('');
  const [chanA,     setChanA]     = useState<any>(null);
  const [chanB,     setChanB]     = useState<any>(null);
  const [invoiceAB, setInvoiceAB] = useState('');
  const [invoiceBA, setInvoiceBA] = useState('');
  const [statusAB,  setStatusAB]  = useState('');
  const [statusBA,  setStatusBA]  = useState('');
  const [outboundA, setOutboundA] = useState<number | null>(null);
  const [outboundB, setOutboundB] = useState<number | null>(null);
  const [errorMsg,  setErrorMsg]  = useState('');

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef   = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[vc-btc][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setOutboundA(null); setOutboundB(null); setErrorMsg('');

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    // BTC channel on either node: no assetId and usable.
    const findBtcChannel = (chans: any[], peerPubkey: string) =>
      chans.find(c =>
        !(c.assetId ?? c.asset_id) &&
        (c.peerPubkey ?? c.peer_pubkey) === peerPubkey &&
        (c.isUsable === true || c.is_usable === true)
      ) ?? null;

    try {
      // ── Init Node A ──────────────────────────────────────────────────────────
      setPhase('init');

      req('createWallet nodeA');
      const keysA = await createWallet('regtest' as any);
      res('createWallet nodeA', { fp: keysA.masterFingerprint });

      const ts    = Date.now();
      const portA = 35000 + Math.floor(Math.random() * 1000);
      const dirAUri = `${documentDirectory ?? ''}vcbtc_na_${ts}`;
      await FileSystem.makeDirectoryAsync(dirAUri, { intermediates: true });
      addLog(`nodeA storage: ${dirAUri.replace('file://', '')}`);

      const wA = new UTEXOWallet(
        { storageDirPath: dirAUri.replace('file://', ''), daemonListeningPort: portA,
          ldkPeerListeningPort: portA + 1, network: 'regtest',
          enableVirtualChannelsV0: true },
        new PasswordRLNSigner('vcbtcpass_a', keysA.mnemonic),
      );
      walletARef.current = wA;
      await wA.init();
      await wA.unlock(REGTEST_UNLOCK);

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
      const keysB = await createWallet('regtest' as any);
      res('createWallet nodeB', { fp: keysB.masterFingerprint });

      // Port offset +200 keeps A and B well apart
      const portB   = portA + 200;
      const dirBUri = `${documentDirectory ?? ''}vcbtc_nb_${ts}`;
      await FileSystem.makeDirectoryAsync(dirBUri, { intermediates: true });
      addLog(`nodeB storage: ${dirBUri.replace('file://', '')}`);

      const wB = new UTEXOWallet(
        { storageDirPath: dirBUri.replace('file://', ''), daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1, network: 'regtest',
          enableVirtualChannelsV0: true,
          virtualPeerPubkeys: pkA ? [pkA] : null },
        new PasswordRLNSigner('vcbtcpass_b', keysB.mnemonic),
      );
      walletBRef.current = wB;
      await wB.init();
      await wB.unlock(REGTEST_UNLOCK);

      const infoB = await wB.getNodeInfo();
      const pkB = String(infoB.pubkey ?? '');
      setPubkeyB(pkB);
      res('nodeB.init+unlock', { pubkey: short(pkB, 20) });

      req('nodeB.getAddress');
      const addressB = await wB.getAddress();
      setAddrB(addressB);
      res('nodeB.getAddress', { address: addressB });

      // ── Fund both nodes ──────────────────────────────────────────────────────
      setPhase('fund');

      addLog('Funding both nodes (1 BTC each) …');
      await sendToAddress(addressA, 1);
      await sendToAddress(addressB, 1);
      await mine(6);
      await sleep(3000);
      await wA.syncWallet();
      await wB.syncWallet();

      const btcBal = await wA.getBtcBalance() as any;
      const spA = (btcBal?.vanilla?.spendable ?? 0) + (btcBal?.colored?.spendable ?? 0);
      addLog(`nodeA BTC spendable: ${satStr(spA)}`, 'success');

      // The virtual-open funding PSBT draws on colorable UTXOs (send_begin uses
      // manually_selected_only) — keep the same UTXO prep as the RGB virtual flow.
      req('nodeA.createUtxos');
      await wA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      req('nodeB.createUtxos');
      await wB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await wA.syncWallet();
      await wB.syncWallet();
      res('createUtxos nodeA+B');

      // ── Connect peers ────────────────────────────────────────────────────────
      setPhase('connect');

      // Intra-device connection always uses 127.0.0.1 regardless of platform.
      const peerUri = `${pkB}@127.0.0.1:${portB + 1}`;
      req('nodeA.connectPeer', { uri: short(peerUri, 30) });
      await wA.connectPeer(peerUri);
      await sleep(2000);
      res('nodeA.connectPeer');

      // ── Open virtual BTC channel (no asset) ─────────────────────────────────
      setPhase('open_channel');

      req('nodeA.openChannel', { capacitySat: CHANNEL_CAPACITY_SAT, asset: 'none (BTC only)', virtualOpenMode: VIRTUAL_OPEN_MODE });
      const openResp = await wA.openChannel({
        peerPubkey: peerUri,
        capacitySat: CHANNEL_CAPACITY_SAT,
        pushMsat: 0,
        isPublic: false,
        withAnchors: true,
        assetId: undefined,
        assetLocalAmount: undefined,
        pushAssetAmount: null,
        virtualOpenMode: VIRTUAL_OPEN_MODE,
      });
      res('nodeA.openChannel', { tmpChanId: short(openResp.temporaryChannelId, 16) });

      // ── Wait for channel usable on both nodes ────────────────────────────────
      setPhase('wait_channel');

      addLog(`Waiting for virtual BTC channel (timeout ${CHANNEL_TIMEOUT_S}s) …`);
      const chanDeadline = Date.now() + CHANNEL_TIMEOUT_S * 1000;
      let nodeAChan: any = null;
      let nodeBChan: any = null;
      while (Date.now() < chanDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await mine(1);
        await sleep(POLL_INTERVAL_S * 1000);
        try {
          const chansA = (await wA.listChannels()) ?? [];
          nodeAChan = findBtcChannel(chansA as any[], pkB);
          const chansB = (await wB.listChannels()) ?? [];
          nodeBChan = findBtcChannel(chansB as any[], pkA);
          addLog(`nodeA: ${nodeAChan ? 'usable ✓' : 'waiting…'}  nodeB: ${nodeBChan ? 'visible ✓' : 'waiting…'}`);
          if (nodeAChan && nodeBChan) break;
        } catch (e: any) {
          addLog(`listChannels: ${e?.message ?? e}`, 'error');
        }
      }

      if (!nodeAChan) throw new Error(`Timed out waiting for Node A virtual BTC channel after ${CHANNEL_TIMEOUT_S}s`);
      setChanA(nodeAChan);
      if (nodeBChan) setChanB(nodeBChan);
      else addLog('Node B channel not yet visible — continuing', 'info');
      addLog(`Channel open ✓  mode=${nodeAChan.virtualOpenMode ?? 'default'}  local=${msatStr(nodeAChan.outboundBalanceMsat ?? 0)}`, 'success');

      // ── Snapshot initial channel balances ────────────────────────────────────
      const initOutA = Number(nodeAChan?.outboundBalanceMsat ?? 0);
      const initOutB = Number(nodeBChan?.outboundBalanceMsat ?? 0);
      setOutboundA(initOutA); setOutboundB(initOutB);
      addLog(`initial outbound: nodeA=${msatStr(initOutA)}  nodeB=${msatStr(initOutB)}`);

      // ── Part 1: A → B payment (plain BTC invoice — no asset) ─────────────────
      setPhase('pay_ab');

      req('nodeB.createLightningInvoice', { msat: PAYMENT_MSAT_AB });
      const invAB = await wB.createLightningInvoice({
        amountSats: PAYMENT_MSAT_AB / 1000,
        expirySeconds: 3600,
      });
      const invoiceABStr = invAB.lnInvoice;
      setInvoiceAB(invoiceABStr);
      res('nodeB.createLightningInvoice', { invoice: short(invoiceABStr, 28) });

      req('nodeA.payLightningInvoice → nodeB');
      const payAB = await wA.payLightningInvoice({ lnInvoice: invoiceABStr });
      const payABStatus = String((payAB as any)?.status ?? '').toUpperCase();
      res('nodeA.payLightningInvoice', { status: (payAB as any)?.status ?? 'sent' });
      if (payABStatus === 'FAILED') throw new Error('nodeA.payLightningInvoice A→B failed immediately — check channel balance and route');

      // ── Wait for A→B settlement ──────────────────────────────────────────────
      setPhase('settle_ab');
      setStatusAB('Pending');

      addLog('Waiting for A→B invoice to settle …');
      const deadlineAB = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let settledAB = false;
      while (Date.now() < deadlineAB) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_INTERVAL_S * 1000);
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
      if (!settledAB) addLog('A→B settlement timeout — invoice may still be processing', 'info');
      else addLog(`A→B payment Succeeded ✓ (${msatStr(PAYMENT_MSAT_AB)})`, 'success');

      // Channel balances after A→B
      try {
        const chansA1 = (await wA.listChannels()) ?? [];
        const chansB1 = (await wB.listChannels()) ?? [];
        const a1 = findBtcChannel(chansA1 as any[], pkB);
        const b1 = findBtcChannel(chansB1 as any[], pkA);
        const outA1 = Number(a1?.outboundBalanceMsat ?? 0);
        const outB1 = Number(b1?.outboundBalanceMsat ?? 0);
        setOutboundA(outA1); setOutboundB(outB1);
        addLog(`outbound after A→B: nodeA=${msatStr(outA1)}  nodeB=${msatStr(outB1)}`);
        if (initOutA - outA1 === PAYMENT_MSAT_AB) addLog(`nodeA outbound decreased by ${msatStr(PAYMENT_MSAT_AB)} ✓`, 'success');
        if (outB1 - initOutB === PAYMENT_MSAT_AB) addLog(`nodeB outbound increased by ${msatStr(PAYMENT_MSAT_AB)} ✓`, 'success');
      } catch {}

      // ── Part 2: B → A reverse payment ────────────────────────────────────────
      setPhase('pay_ba');

      req('nodeA.createLightningInvoice (reverse)', { msat: PAYMENT_MSAT_BA });
      const invBA = await wA.createLightningInvoice({
        amountSats: PAYMENT_MSAT_BA / 1000,
        expirySeconds: 3600,
      });
      const invoiceBAStr = invBA.lnInvoice;
      setInvoiceBA(invoiceBAStr);
      res('nodeA.createLightningInvoice', { invoice: short(invoiceBAStr, 28) });

      req('nodeB.payLightningInvoice → nodeA');
      const payBA = await wB.payLightningInvoice({ lnInvoice: invoiceBAStr });
      const payBAStatus = String((payBA as any)?.status ?? '').toUpperCase();
      res('nodeB.payLightningInvoice', { status: (payBA as any)?.status ?? 'sent' });
      if (payBAStatus === 'FAILED') throw new Error('nodeB.payLightningInvoice B→A failed immediately — check channel balance and route');

      // ── Wait for B→A settlement ──────────────────────────────────────────────
      setPhase('settle_ba');
      setStatusBA('Pending');

      addLog('Waiting for B→A reverse invoice to settle …');
      const deadlineBA = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let settledBA = false;
      while (Date.now() < deadlineBA) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_INTERVAL_S * 1000);
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
      if (!settledBA) addLog('B→A settlement timeout — invoice may still be processing', 'info');
      else addLog(`B→A reverse payment Succeeded ✓ (${msatStr(PAYMENT_MSAT_BA)})`, 'success');

      // Final channel balances
      try {
        const chansA2 = (await wA.listChannels()) ?? [];
        const chansB2 = (await wB.listChannels()) ?? [];
        const a2 = findBtcChannel(chansA2 as any[], pkB);
        const b2 = findBtcChannel(chansB2 as any[], pkA);
        const outA2 = Number(a2?.outboundBalanceMsat ?? 0);
        const outB2 = Number(b2?.outboundBalanceMsat ?? 0);
        setOutboundA(outA2); setOutboundB(outB2);
        addLog(`final outbound: nodeA=${msatStr(outA2)}  nodeB=${msatStr(outB2)}`, 'success');
      } catch {}

      setPhase('done');

    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`Fatal: ${msg}`, 'error');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [addLog]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    setPhase('idle'); setLog([]);
    setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setOutboundA(null); setOutboundB(null); setErrorMsg('');
  }, []);

  return {
    phase, log, pubkeyA, pubkeyB, addrA, addrB,
    chanA, chanB, invoiceAB, invoiceBA, statusAB, statusBA,
    outboundA, outboundB, errorMsg, run, reset,
  };
}
