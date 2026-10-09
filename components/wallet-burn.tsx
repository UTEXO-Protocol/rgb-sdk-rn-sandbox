import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppColors as C } from '@/constants/theme';
import { demoWallet, type DemoWalletState } from '@/utils/wallet';
import { burnMaxAmount, formatBurnAmount, LOCAL_BURN_ORIGIN, payoutChainLabel, prepareLocalBurn } from '@/utils/wallet/burn';

export function WalletBurn({ state, initialAssetId = '' }: { state: DemoWalletState; initialAssetId?: string }) {
  const assets = state.assets.filter((asset) => asset.schema === 'BFA');
  const [assetId, setAssetId] = useState(initialAssetId || assets[0]?.assetId || '');
  const [amount, setAmount] = useState('');
  const [payoutChainId, setPayoutChainId] = useState('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [copied, setCopied] = useState('');
  const asset = assets.find((item) => item.assetId === assetId);
  const max = asset ? burnMaxAmount(asset) : null;
  const busy = state.busy || !!state.prompt || !!state.activeRequest;
  const pending = state.burns.some((record) => record.state === 'pending');
  const unavailable = !state.ready || !state.burnAvailable || busy || pending;
  const form = { assetId, amount, payoutChainId: `eip155:${payoutChainId.trim()}`, payoutAddress };
  let validation = '';
  try { prepareLocalBurn(form, asset, state.network); }
  catch (error) { validation = error instanceof Error ? error.message : 'Check the burn details.'; }
  const latest = state.burns.filter((record) => record.metadata.origin === LOCAL_BURN_ORIGIN && record.state === 'complete').at(-1);
  const latestAsset = state.assets.find((item) => item.assetId === latest?.params.assetId);

  return <View style={styles.group}>
    <Text style={styles.heading}>Burn for an EVM payout</Text>
    <Text style={styles.text}>Burn BFA tokens here, then use the saved proof on the bridge website to request your payout.</Text>
    {!state.burnAvailable && <Text style={styles.warning}>Burn requires a compatible native build and Ethereum RPC configuration.</Text>}
    {!assets.length && <Text style={styles.text}>No BFA assets in this wallet. Receive a bridge asset first.</Text>}
    {pending && <Text accessibilityRole="alert" style={styles.warning}>
      A burn is still processing or its outcome needs review. Check Activity and refresh the wallet before starting another burn.
    </Text>}
    {!!assets.length && <>
      <Text style={styles.label}>Asset</Text>
      {assets.map((item) => <Pressable key={item.assetId} accessibilityRole="radio"
        accessibilityLabel={`${item.ticker || item.name}, ${item.assetId}`}
        accessibilityState={{ checked: item.assetId === assetId, disabled: unavailable }} disabled={unavailable}
        onPress={() => { setAssetId(item.assetId); setAmount(''); }}
        style={[styles.choice, item.assetId === assetId && styles.selected, unavailable && styles.disabled]}>
        <Text style={styles.text}>{item.assetId === assetId ? '●' : '○'} {item.ticker || item.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.hint}>{item.assetId}</Text>
      </Pressable>)}
      <View style={styles.row}>
        <Text style={styles.label}>Amount{asset?.ticker ? ` (${asset.ticker})` : ''}</Text>
        <Text style={styles.hint}>Available: {max ?? 'Refresh required'}</Text>
      </View>
      <View style={styles.row}>
        <TextInput accessibilityLabel="Burn token amount" value={amount} onChangeText={setAmount}
          placeholder="0.00" placeholderTextColor={C.textTertiary} keyboardType="decimal-pad"
          editable={!unavailable} style={[styles.input, styles.amount]} />
        <Pressable accessibilityRole="button" accessibilityLabel="Use maximum burn amount"
          accessibilityState={{ disabled: unavailable || max === null || max === '0' }}
          disabled={unavailable || max === null || max === '0'} onPress={() => max !== null && setAmount(max)}
          style={[styles.button, (unavailable || max === null || max === '0') && styles.disabled]}>
          <Text style={styles.buttonText}>Max</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>EVM payout chain ID</Text>
      <TextInput accessibilityLabel="EVM payout chain ID" value={payoutChainId} onChangeText={setPayoutChainId}
        placeholder="e.g. 1" placeholderTextColor={C.textTertiary} keyboardType="number-pad"
        editable={!unavailable} style={styles.input} />
      <Text style={styles.hint}>Ethereum: 1 · Arbitrum One: 42161</Text>
      <Text style={styles.label}>EVM payout address</Text>
      <TextInput accessibilityLabel="EVM payout address" value={payoutAddress} onChangeText={setPayoutAddress}
        placeholder="0x…" placeholderTextColor={C.textTertiary} autoCapitalize="none" autoCorrect={false}
        editable={!unavailable} style={styles.input} />
      <Text style={styles.hint}>The wallet uses 2 sat/vB and requires 3 confirmations. BTC is needed for the network fee. You will review all details before burning.</Text>
      {!!amount.trim() && !!payoutAddress.trim() && !!validation && <Text accessibilityRole="alert" style={styles.warning}>{validation}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: unavailable || !!validation }}
        disabled={unavailable || !!validation} style={[styles.button, (unavailable || !!validation) && styles.disabled]}
        onPress={() => {
          setCopied('');
          void demoWallet.burnAsset(form).then((record) => { if (record?.state === 'complete') setAmount(''); });
        }}>
        <Text style={styles.buttonText}>Review burn</Text>
      </Pressable>
    </>}
    {latest?.result && <View style={styles.result}>
      <Text style={styles.heading}>Latest burn on this device</Text>
      <Text style={styles.text}>{latestAsset
        ? `${formatBurnAmount(latest.params.amount, latestAsset.precision)} ${latestAsset.ticker || latestAsset.name}`
        : `${latest.params.amount} base units`}</Text>
      <Text style={styles.text}>Bitcoin: {state.transfers.find((transfer) => transfer.txid === latest.result!.txid && transfer.assetId === latest.params.assetId && transfer.kind === 'Burn')?.status || 'Broadcast'}</Text>
      <Text selectable style={styles.mono}>{latest.result.txid}</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => {
        void (async () => {
          try {
            const Clipboard = await import('expo-clipboard');
            if (!(await Clipboard.setStringAsync(latest.result!.txid))) throw new Error('Clipboard unavailable');
            setCopied('Transaction ID copied.');
          } catch { setCopied('Long-press the transaction ID to copy it.'); }
        })();
      }}><Text style={styles.buttonText}>Copy transaction ID</Text></Pressable>
      {!!copied && <Text accessibilityLiveRegion="polite" style={styles.hint}>{copied}</Text>}
      <Text style={styles.text}>Payout: {payoutChainLabel(latest.metadata.payout.chainId)}</Text>
      <Text selectable style={styles.mono}>{latest.metadata.payout.address}</Text>
      <Text style={styles.hint}>To request the payout, connect this wallet on the bridge website and choose Existing burn → From wallet. Select this transaction if several burns are listed.</Text>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  text: { color: C.textSecondary, fontSize: 14, lineHeight: 21 },
  label: { color: C.textPrimary, fontSize: 14, fontWeight: '500' },
  hint: { color: C.textSecondary, fontSize: 12, lineHeight: 18 },
  mono: { color: C.textPrimary, fontSize: 12, fontFamily: C.mono, lineHeight: 19 },
  input: { color: C.textPrimary, backgroundColor: C.bgInput, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: C.border, minHeight: 46 },
  amount: { flex: 1, minWidth: 100 },
  choice: { padding: 12, gap: 4, borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  selected: { backgroundColor: C.primaryBg, borderColor: C.primary },
  button: { backgroundColor: C.primaryBg, borderColor: C.primary, borderWidth: 1, padding: 13, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: C.textPrimary, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.4 },
  warning: { color: C.error, fontSize: 14, lineHeight: 21 },
  result: { gap: 10, borderTopWidth: 1, borderColor: C.border, paddingTop: 14 },
});
