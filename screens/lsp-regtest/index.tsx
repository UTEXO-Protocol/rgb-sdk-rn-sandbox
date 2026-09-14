/**
 * LSP tab — implements test_flow0_full_e2e from utexo-lsp e2e tests.
 * Flow logic: useLspFlow.ts  |  Daemon helpers: daemons.ts  |  Config: config.ts
 *
 * Prerequisites: ./scripts/start-lsp-regtest.sh
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
  ASSET_ID, FAUCET_DAEMON_URL, FAUCET_PAY_AMOUNT,
  LSP_DAEMON_URL, LSP_URL, PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT,
  satStr, short,
} from './config';
import { ALL_PHASES, InfoCard, LogPane, PhaseRow, PHASES_P1, PHASES_P2 } from './components';
import { useLspFlow } from './useLspFlow';

type LspScreenProps = { embedded?: boolean; virtual?: boolean };

function LspScreen({ embedded = false, virtual = false }: LspScreenProps) {
  const flow = useLspFlow({ channelMode: virtual ? 'virtual' : 'regular' });

  const isRunning = !['idle', 'done', 'error'].includes(flow.phase);
  const spA = (flow.balA?.vanilla?.spendable ?? 0) + (flow.balA?.colored?.spendable ?? 0);
  const stA = (flow.balA?.vanilla?.settled   ?? 0) + (flow.balA?.colored?.settled   ?? 0);
  const envReady = !!ASSET_ID;

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
          <Text style={s.title}>
            {virtual ? 'LSP · lightning_receive (Virtual)' : 'LSP · lightning_receive (Regular)'}
          </Text>
          <Text style={s.subtitle}>
            {virtual
              ? 'Regtest · test_flow0_full_e2e · trusted_no_broadcast virtual channels'
              : 'Regtest · test_flow0_full_e2e · on-chain funded RGB channels'}
          </Text>
          <View style={s.badge}>
            <View style={[s.dot, { backgroundColor: envReady ? AppColors.success : AppColors.error }]} />
            <Text style={s.badgeTxt}>{envReady ? 'LSP configured' : 'Run start-lsp-regtest.sh first'}</Text>
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
            <Text style={s.cardTitle}>
              {virtual ? 'test_flow0_full_e2e — Virtual Channels' : 'test_flow0_full_e2e — Regular Channels'}
            </Text>
            <Text style={s.cardDesc}>
              {virtual
                ? ('Regtest e2e flow — same test_flow0_full_e2e.py steps on-device.\n\n' +
                   'Setup:\n' +
                   'LSP opens 0-conf virtual RGB channels (trusted_no_broadcast) to both users after connectPeer. ' +
                   'Wallets use enableVirtualChannelsV0 + virtualPeerPubkeys=[LSP]. ' +
                   'Requires ./scripts/start-lsp-regtest.sh (LSP runs with --enable-virtual-channels-v0).\n\n' +
                   'Part 1 — lightning_receive:\n' +
                   'Node A calls receiveAsset — LN + RGB invoices created in one call. ' +
                   'Faucet sends RGB on-chain to the LSP. ' +
                   'Once settled, LSP pays Node A\'s LN invoice via the virtual channel.\n\n' +
                   'Part 2 — Node A pays Node B:\n' +
                   'After outbound liquidity is confirmed, Node A pays Node B\'s LN invoice ' +
                   'via the LSP as routing node.')
                : ('Regtest e2e flow — test_flow0_full_e2e.py on-device.\n\n' +
                   'Setup:\n' +
                   'LSP opens standard on-chain funded RGB channels to both Node A and Node B after connectPeer. ' +
                   'Wallets omit enableVirtualChannelsV0. ' +
                   'LSP must run without --enable-virtual-channels-v0; channel confirmation needs mined blocks.\n\n' +
                   'Part 1 — lightning_receive:\n' +
                   'Node A calls receiveAsset — LN + RGB invoices created in one call. ' +
                   'Faucet sends RGB on-chain to the LSP. ' +
                   'Once settled, LSP pays Node A\'s LN invoice via the channel.\n\n' +
                   'Part 2 — Node A pays Node B:\n' +
                   'After outbound liquidity is confirmed, Node A pays Node B\'s LN invoice ' +
                   'via the LSP as routing node.')}
            </Text>

            {!envReady && (
              <View style={s.warnCard}>
                <Text style={s.warnTxt}>
                  {'Run the setup script first:\n\n  ./scripts/start-lsp-regtest.sh\n\nThen rebuild the app to pick up .env.lsp.local'}
                </Text>
              </View>
            )}

            <View style={s.paramCard}>
              <Text style={s.paramTitle}>Config from env</Text>
              <Text style={s.paramLine}>LSP API     {LSP_URL}</Text>
              <Text style={s.paramLine}>LSP daemon  {LSP_DAEMON_URL}</Text>
              <Text style={s.paramLine}>Faucet      {FAUCET_DAEMON_URL}</Text>
              <Text style={s.paramLine}>Asset ID    {ASSET_ID ? short(ASSET_ID, 28) : '(not set)'}</Text>
              <Text style={s.paramLine}>Payment     {PAYMENT_MSAT / 1000} sat + {PAYMENT_ASSET_AMOUNT} RGB unit</Text>
            </View>

            <TouchableOpacity
              style={[s.startBtn, !envReady && { opacity: 0.4 }]}
              onPress={flow.run}
              disabled={!envReady}
              activeOpacity={0.8}>
              <Text style={s.startBtnTxt}>
                {virtual ? '▶  Run Virtual Channel E2E' : '▶  Run Regular Channel E2E'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Spinners */}
        {isRunning && ['preflight', 'init', 'utxos'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'preflight' ? 'Checking LSP + Faucet daemons …'
                : flow.phase === 'init'   ? 'Creating User A node on regtest …'
                : 'Creating UTXOs …'}
            </Text>
          </View>
        )}
        {flow.phase === 'fund' && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>Funding User A (sendToAddress + mine 6) …</Text>
            {flow.addrA ? <Text style={[s.spinnerTxt, { marginTop: 8, fontSize: 11, fontFamily: AppColors.mono }]}>{flow.addrA}</Text> : null}
          </View>
        )}
        {flow.phase === 'channel' && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {virtual ? 'Waiting for LSP to open virtual RGB channel …' : 'Waiting for LSP to open RGB channel …'}
            </Text>
            <Text style={[s.spinnerTxt, { fontSize: 11, marginTop: 4 }]}>
              {virtual ? '(0-conf virtual — LSP cron ≈ 5s)' : '(mining blocks, LSP cron ≈ 30s)'}
            </Text>
          </View>
        )}
        {['b_init', 'b_channel'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'b_init'
                ? 'Creating User B node …'
                : virtual
                  ? 'Waiting for LSP → User B virtual RGB channel …'
                  : 'Waiting for LSP → User B RGB channel …'}
            </Text>
          </View>
        )}
        {['lsp_flow', 'rgb_send', 'settle'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'lsp_flow' ? 'LSP lightningReceive …'
                : flow.phase === 'rgb_send' ? 'Faucet sending RGB to LSP …'
                : `Part 1: waiting for User A invoice … ${flow.invoiceStatus || 'Pending'}`}
            </Text>
          </View>
        )}
        {['p2_pay', 'p2_settle'].includes(flow.phase) && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {flow.phase === 'p2_pay' ? 'Part 2: User A sending payment to User B …'
                : `Part 2: waiting for User B invoice … ${flow.invoiceStatusB || 'Pending'}`}
            </Text>
          </View>
        )}

        {/* Info cards */}
        {flow.lspInfo && (
          <InfoCard title="LSP (utexo-lsp)" accent={AppColors.success} rows={[
            ['API',      LSP_URL],
            ['Pubkey',   short(flow.lspInfo.pubkey, 28)],
            ['Network',  flow.lspInfo.network],
          ]} />
        )}
        {flow.addrA && (
          <InfoCard title="User A (embedded SDK)" rows={[
            ['Address',   flow.addrA],
            ['Settled',   satStr(stA)],
            ['Spendable', satStr(spA)],
          ]} />
        )}
        {flow.channelInfo && (
          <InfoCard title={virtual ? 'Virtual RGB Channel (LSP → User A)' : 'RGB Channel (LSP → User A)'} accent={AppColors.primary} rows={[
            ['Asset',    short(ASSET_ID, 28)],
            ['Capacity', `${flow.channelInfo.capacitySat ?? flow.channelInfo.capacity_sat ?? '?'} sat`],
            ['Status',   'Usable ✓'],
          ]} />
        )}
        {flow.lnInvoiceA && (
          <InfoCard title="User A — LN Invoice" rows={[
            ['BOLT11',  short(flow.lnInvoiceA, 32)],
            ['Amount',  `${PAYMENT_MSAT / 1000} sat + ${PAYMENT_ASSET_AMOUNT} RGB`],
            ['Status',  flow.invoiceStatus || 'Pending'],
          ]} />
        )}
        {flow.rgbInvoiceLsp && (
          <InfoCard title="LSP → RGB Invoice (Faucet pays this)" rows={[
            ['RGB Invoice', short(flow.rgbInvoiceLsp, 32)],
            ['Send amount', `${FAUCET_PAY_AMOUNT} RGB unit`],
          ]} />
        )}
        {flow.addrB && (
          <InfoCard title="User B (embedded SDK)" rows={[['Address', flow.addrB]]} />
        )}
        {flow.channelInfoB && (
          <InfoCard title={virtual ? 'Virtual RGB Channel (LSP → User B)' : 'RGB Channel (LSP → User B)'} accent={AppColors.primary} rows={[
            ['Asset',    short(ASSET_ID, 28)],
            ['Capacity', `${flow.channelInfoB.capacitySat ?? flow.channelInfoB.capacity_sat ?? '?'} sat`],
            ['Status',   'Usable ✓'],
          ]} />
        )}
        {flow.lnInvoiceB && (
          <InfoCard title="User B — LN Invoice" rows={[
            ['BOLT11',  short(flow.lnInvoiceB, 32)],
            ['Amount',  `${PAYMENT_MSAT / 1000} sat + ${PAYMENT_ASSET_AMOUNT} RGB`],
            ['Status',  flow.invoiceStatusB || 'Pending'],
          ]} />
        )}

        {/* Done */}
        {flow.phase === 'done' && (
          <View style={[s.card, { borderColor: flow.invoiceStatusB === 'Settled' ? AppColors.successBorder : AppColors.border }]}>
            <Text style={[s.cardTitle, { color: flow.invoiceStatusB === 'Settled' ? AppColors.success : AppColors.textPrimary }]}>
              {flow.invoiceStatusB === 'Settled' ? '✓ Full E2E Flow Complete' : '⚠ Flow done — check settlement'}
            </Text>
            <Text style={s.cardDesc}>
              {'Part 1: Faucet → LSP → User A via RGB Lightning channel\n' +
               'Part 2: User A → LSP → User B via RGB Lightning\n\n' +
               `User A offchain inbound: ${flow.finalBalA?.offchainInbound ?? 0} → outbound: ${flow.finalBalA?.offchainOutbound ?? 0}\n` +
               `User B offchain inbound: ${flow.finalBalB?.offchainInbound ?? 0}`}
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
  warnCard:    { backgroundColor: AppColors.errorBg, borderRadius: 8, padding: 12, marginVertical: 12, borderWidth: 1, borderColor: AppColors.errorBorder },
  warnTxt:     { fontSize: 12, color: '#FCA5A5', fontFamily: AppColors.mono, lineHeight: 20 },
  paramCard:   { backgroundColor: AppColors.bgCardElevated, borderRadius: 8, padding: 12, marginVertical: 12 },
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

export default function LspRegtestScreen(props: Omit<LspScreenProps, 'virtual'>) {
  return <LspScreen {...props} virtual={false} />;
}

export function LspRegtestVirtualScreen(props: Omit<LspScreenProps, 'virtual'>) {
  return <LspScreen {...props} virtual />;
}
