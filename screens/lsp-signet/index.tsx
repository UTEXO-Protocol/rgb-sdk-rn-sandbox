/**
 * LSP Signet tab — full lightning_receive + P2P payment flow.
 * Flow logic: useLspFlow.ts  |  Components: components.tsx  |  Config: config.ts
 *
 * Uses wallet.createLsp() with no args — peer pubkey discovered from
 * GET /get_info, host parsed from lspBaseUrl, port defaults to 9735.
 */
import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppColors } from '@/constants/theme';
import {
  LSP_URL, PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT,
  satStr, short,
} from './config';
import { ALL_PHASES, InfoCard, LogPane, PhaseRow, PHASES_P1, PHASES_P2 } from './components';
import { useLspFlow } from './useLspFlow';

export default function LspSignetScreen({ embedded = false }: { embedded?: boolean }) {
  const flow = useLspFlow();

  const isRunning = !['idle', 'done', 'error'].includes(flow.phase);
  const spA = (flow.balA?.vanilla?.spendable ?? 0) + (flow.balA?.colored?.spendable ?? 0);
  const stA = (flow.balA?.vanilla?.settled   ?? 0) + (flow.balA?.colored?.settled   ?? 0);
  const spB = (flow.balB?.vanilla?.spendable ?? 0) + (flow.balB?.colored?.spendable ?? 0);
  const stB = (flow.balB?.vanilla?.settled   ?? 0) + (flow.balB?.colored?.settled   ?? 0);

  const Root = embedded ? View : SafeAreaView;
  const rootProps = embedded
    ? { style: s.embedded }
    : { style: s.safe, edges: ['top', 'left', 'right'] as const };

  return (
    <Root {...rootProps}>
      <ScrollView
        style={embedded ? undefined : s.scroll}
        contentContainerStyle={s.content}
        scrollEnabled={!embedded}
        nestedScrollEnabled={embedded}>

        <View style={s.header}>
          <Text style={s.title}>LSP · Signet</Text>
          <Text style={s.subtitle}>lsp-signet.utexo.com · lightning_receive + P2P payment</Text>
          <View style={s.badge}>
            <View style={[s.dot, { backgroundColor: flow.lspInfo ? AppColors.success : AppColors.textTertiary }]} />
            <Text style={s.badgeTxt}>{flow.lspInfo ? 'LSP connected' : 'Not connected'}</Text>
          </View>
        </View>

        {flow.phase !== 'idle' && (
          <>
            <PhaseRow phases={PHASES_P1} phase={flow.phase} />
            <PhaseRow phases={PHASES_P2} phase={flow.phase} />
          </>
        )}

        {/* Idle */}
        {flow.phase === 'idle' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Full LSP flow — Signet</Text>
            <Text style={s.cardDesc}>
              {'Mirrors the regtest e2e flow on live signet.\n\n' +
               'Setup:\n' +
               'LSP opens RGB channels to both Node A and Node B after connectPeer. ' +
               'Channel confirmation takes ~10 min (6 blocks × 100s).\n\n' +
               'Part 1 — lightning_receive:\n' +
               'Node A calls receiveAsset — LN + RGB invoices created in one call. ' +
               'Node B (RGB issuer) sends RGB on-chain to the LSP. ' +
               'Once settled, LSP pays Node A\'s LN invoice via the channel.\n\n' +
               'Part 2 — Node A pays Node B:\n' +
               'After outbound liquidity is confirmed, Node A pays Node B\'s LN invoice ' +
               'via the LSP as routing node.'}
            </Text>
            <View style={s.paramCard}>
              <Text style={s.paramTitle}>Config</Text>
              <Text style={s.paramLine}>LSP      {LSP_URL}</Text>
              <Text style={s.paramLine}>Payment  {PAYMENT_MSAT / 1000} sat + {PAYMENT_ASSET_AMOUNT} UTST</Text>
              <Text style={s.paramLine}>Peer     discovered from GET /get_info</Text>
            </View>
            <TouchableOpacity style={s.startBtn} onPress={flow.run} activeOpacity={0.8}>
              <Text style={s.startBtnTxt}>▶  Run on Signet</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Spinners */}
        {isRunning && ['init', 'utxos', 'asset', 'lsp_flow'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'init'     ? 'Initializing Node A + B on signet …'
                : flow.phase === 'utxos'  ? 'Creating UTXOs on both nodes …'
                : flow.phase === 'asset'  ? 'Node B issuing RGB asset (UTST) …'
                : 'lspA.receiveAsset → LN + RGB invoice …'}
            </Text>
          </View>
        )}
        {flow.phase === 'fund' && (
          <View style={s.card}>
            <ActivityIndicator size="large" color={AppColors.primary} style={{ marginBottom: 12 }} />
            <Text style={s.cardTitle}>Funding via faucet</Text>
            <Text style={s.cardDesc}>Polling every 20s for confirmed balance …</Text>
          </View>
        )}
        {(flow.phase === 'channel' || flow.phase === 'b_channel') && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'channel'
                ? 'Waiting for LSP → Node A RGB channel (~10 min) …'
                : 'Waiting for LSP → Node B RGB channel (~10 min) …'}
            </Text>
            <Text style={[s.spinnerTxt, { fontSize: 11, marginTop: 4 }]}>
              LSP cron 30s · channel needs 6 confirmations
            </Text>
          </View>
        )}
        {['rgb_send', 'settle'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'rgb_send'
                ? 'Node B sending RGB on-chain to LSP …'
                : `Part 1 settling … nodeA invoice: ${flow.invoiceStatus || 'Pending'}`}
            </Text>
          </View>
        )}
        {['p2_pay', 'p2_settle'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'p2_pay'
                ? 'Part 2: Node A sending payment to Node B …'
                : `Part 2 settling … nodeB invoice: ${flow.invoiceStatusB || 'Pending'}`}
            </Text>
          </View>
        )}

        {/* Info cards */}
        {flow.lspInfo && (
          <InfoCard title="LSP (utexo-lsp signet)" accent={AppColors.success} rows={[
            ['Pubkey',   short(flow.lspInfo.pubkey, 28)],
            ['Network',  flow.lspInfo.network],
          ]} />
        )}
        {(flow.addrA || flow.addrB) && (
          <View>
            {flow.addrA ? <View style={nc.card}><Text style={[nc.label, { color: AppColors.primary }]}>Node A — Recipient</Text><Text selectable style={nc.addr}>{flow.addrA}</Text><Text style={nc.stat}>Settled: {satStr(stA)}  Spendable: {satStr(spA)}</Text></View> : null}
            {flow.addrB ? <View style={nc.card}><Text style={[nc.label, { color: AppColors.running }]}>Node B — RGB Sender</Text><Text selectable style={nc.addr}>{flow.addrB}</Text><Text style={nc.stat}>Settled: {satStr(stB)}  Spendable: {satStr(spB)}</Text></View> : null}
          </View>
        )}
        {flow.assetInfo && (
          <InfoCard title="RGB Asset (Node B issued)" accent={AppColors.running} rows={[
            ['Asset ID', short(flow.assetInfo.assetId, 28)],
            ['Ticker',   flow.assetInfo.ticker],
            ['Supply',   String(flow.assetInfo.issuedSupply)],
          ]} />
        )}
        {flow.channelA && (
          <InfoCard title="RGB Channel (LSP → Node A)" accent={AppColors.primary} rows={[
            ['Capacity', `${flow.channelA.capacitySat} sat`],
            ['Outbound', `${flow.channelA.outboundBalanceMsat} msat`],
            ['Status',   'Usable ✓'],
          ]} />
        )}
        {flow.channelB && (
          <InfoCard title="RGB Channel (LSP → Node B)" accent={AppColors.primary} rows={[
            ['Capacity', `${flow.channelB.capacitySat} sat`],
            ['Status',   'Usable ✓'],
          ]} />
        )}
        {flow.lnInvoiceA && (
          <InfoCard title="Node A — LN Invoice" rows={[
            ['BOLT11',  short(flow.lnInvoiceA, 32)],
            ['Amount',  `${PAYMENT_MSAT / 1000} sat + ${PAYMENT_ASSET_AMOUNT} UTST`],
            ['Status',  flow.invoiceStatus || 'Pending'],
          ]} />
        )}
        {flow.rgbInvoiceLsp && (
          <InfoCard title="LSP RGB Invoice (Node B pays this)" rows={[
            ['RGB Invoice', short(flow.rgbInvoiceLsp, 32)],
            ['Send amount', `${PAYMENT_ASSET_AMOUNT} UTST`],
          ]} />
        )}
        {flow.lnInvoiceB && (
          <InfoCard title="Node B — LN Invoice (Part 2)" rows={[
            ['BOLT11',  short(flow.lnInvoiceB, 32)],
            ['Amount',  `${PAYMENT_MSAT / 1000} sat + ${PAYMENT_ASSET_AMOUNT} UTST`],
            ['Status',  flow.invoiceStatusB || 'Pending'],
          ]} />
        )}

        {/* Done */}
        {flow.phase === 'done' && (
          <View style={[s.card, { borderColor: AppColors.successBorder }]}>
            <Text style={[s.cardTitle, { color: AppColors.success }]}>✓ Full LSP Flow Complete</Text>
            <Text style={s.cardDesc}>
              {'Part 1: Node B → LSP → Node A via RGB Lightning channel\n' +
               'Part 2: Node A → LSP → Node B via RGB Lightning\n\n' +
               `Node A offchain inbound: ${flow.finalBalA?.offchainInbound ?? 0}\n` +
               `Node B offchain inbound: ${flow.finalBalB?.offchainInbound ?? 0}`}
            </Text>
          </View>
        )}

        {/* Error */}
        {flow.phase === 'error' && (
          <View style={[s.card, { borderColor: AppColors.errorBorder, backgroundColor: AppColors.errorBg }]}>
            <Text style={[s.cardTitle, { color: AppColors.error }]}>Flow failed</Text>
            <Text style={[s.cardDesc, { color: '#FCA5A5' }]}>{flow.errorMsg}</Text>
          </View>
        )}

        {(flow.phase === 'done' || flow.phase === 'error') && (
          <TouchableOpacity style={s.resetBtn} onPress={flow.reset} activeOpacity={0.8}>
            <Text style={s.resetBtnTxt}>↺  Reset</Text>
          </TouchableOpacity>
        )}
        {isRunning && (
          <TouchableOpacity style={s.cancelBtn} onPress={flow.reset} activeOpacity={0.8}>
            <Text style={s.cancelBtnTxt}>✕  Cancel</Text>
          </TouchableOpacity>
        )}

        {flow.log.length > 0 && <LogPane entries={flow.log} />}

      </ScrollView>
    </Root>
  );
}

const s = StyleSheet.create({
  embedded:    { backgroundColor: AppColors.bgBase },
  safe:        { flex: 1, backgroundColor: AppColors.bgBase },
  scroll:      { flex: 1 },
  content:     { padding: 16, paddingBottom: 60 },
  header:      { marginBottom: 20 },
  title:       { fontSize: 22, fontWeight: '700', color: AppColors.textPrimary, letterSpacing: -0.3 },
  subtitle:    { fontSize: 13, color: AppColors.textSecondary, marginTop: 2 },
  badge:       { flexDirection: 'row', alignItems: 'center', marginTop: 8, backgroundColor: AppColors.bgCard, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start', borderWidth: 1, borderColor: AppColors.border },
  dot:         { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  badgeTxt:    { fontSize: 11, color: AppColors.textSecondary, fontFamily: AppColors.mono },
  card:        { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: AppColors.border, marginBottom: 16 },
  cardTitle:   { fontSize: 15, fontWeight: '700', color: AppColors.textPrimary, marginBottom: 8 },
  cardDesc:    { fontSize: 13, color: AppColors.textSecondary, lineHeight: 22 },
  paramCard:   { backgroundColor: AppColors.bgCardElevated, borderRadius: 8, padding: 12, marginVertical: 14 },
  paramTitle:  { fontSize: 11, color: AppColors.textTertiary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 },
  paramLine:   { fontSize: 12, color: AppColors.textSecondary, fontFamily: AppColors.mono, marginBottom: 2 },
  startBtn:    { backgroundColor: AppColors.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  startBtnTxt: { fontSize: 15, fontWeight: '700', color: AppColors.black },
  spinnerCard: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 32, alignItems: 'center', borderWidth: 1, borderColor: AppColors.border, marginBottom: 16 },
  spinnerTxt:  { fontSize: 14, color: AppColors.textSecondary, marginTop: 14, textAlign: 'center' },
  resetBtn:    { borderWidth: 1, borderColor: AppColors.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginBottom: 16 },
  resetBtnTxt: { fontSize: 14, fontWeight: '600', color: AppColors.primary },
  cancelBtn:   { borderWidth: 1, borderColor: AppColors.error, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginBottom: 16 },
  cancelBtnTxt:{ fontSize: 13, color: AppColors.error },
});

const nc = StyleSheet.create({
  card:  { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: AppColors.border, marginBottom: 10 },
  label: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  addr:  { fontSize: 11, color: AppColors.textAccent, fontFamily: AppColors.mono, marginBottom: 8 },
  stat:  { fontSize: 12, color: AppColors.textTertiary },
});
