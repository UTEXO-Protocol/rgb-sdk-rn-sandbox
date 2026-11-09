import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppColors as C } from '@/constants/theme';
import { demoWallet, type DemoWalletState } from '@/utils/wallet';
import { formatBurnAmount } from '@/utils/wallet/burn';
import { canSendAsset, prepareSendInput } from '@/utils/wallet/send';

export function WalletSend({ state, initialAssetId = '' }: { state: DemoWalletState; initialAssetId?: string }) {
  const assets = state.assets.filter(canSendAsset);
  const [selected, setSelected] = useState(initialAssetId);
  const [amount, setAmount] = useState('');
  const [invoice, setInvoice] = useState('');
  const [txid, setTxid] = useState('');
  const asset = assets.find((item) => item.assetId === selected) ?? assets[0];
  const disabled = state.busy || !!state.prompt || !!state.activeRequest;
  const form = { assetId: asset?.assetId || '', amount, invoice };
  let validation = '';
  try { prepareSendInput(form, asset); }
  catch (error) { validation = error instanceof Error ? error.message : 'Check the transfer details.'; }

  return <View style={styles.group}>
    <Text style={styles.heading}>Send RGB</Text>
    {!assets.length && <Text style={styles.text}>Receive RGB tokens before sending.</Text>}
    {!!assets.length && <>
      <Text style={styles.label}>Token</Text>
      {assets.map((item) => <Pressable key={item.assetId} accessibilityRole="radio"
        accessibilityLabel={`${item.ticker || item.name}, ${item.assetId}`}
        accessibilityState={{ checked: item.assetId === asset?.assetId, disabled }} disabled={disabled}
        onPress={() => { setSelected(item.assetId); setAmount(''); }}
        style={[styles.choice, item.assetId === asset?.assetId && styles.selected]}>
        <Text style={styles.text}>{item.assetId === asset?.assetId ? '●' : '○'} {item.ticker || item.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.hint}>{item.assetId}</Text>
      </Pressable>)}
      <Text style={styles.label}>Amount{asset?.ticker ? ` (${asset.ticker})` : ''}</Text>
      <TextInput accessibilityLabel="Send token amount" value={amount} onChangeText={setAmount}
        placeholder="0.00" placeholderTextColor={C.textTertiary} keyboardType="decimal-pad"
        editable={!disabled} style={styles.input} />
      <Text style={styles.hint}>Available: {asset && Number.isSafeInteger(asset.balance.spendable)
        ? formatBurnAmount(String(asset.balance.spendable), asset.precision) : 'Refresh required'}</Text>
      <Text style={styles.label}>Recipient RGB invoice</Text>
      <TextInput accessibilityLabel="Recipient RGB invoice" value={invoice} onChangeText={setInvoice}
        placeholder="rgb:…" placeholderTextColor={C.textTertiary} multiline
        autoCapitalize="none" autoCorrect={false} editable={!disabled} style={styles.input} />
      <Text style={styles.hint}>Paste a blinded invoice from the receiving wallet. An invoice without an amount is accepted. BTC is needed for the network fee.</Text>
      {!!amount.trim() && !!invoice.trim() && !!validation && <Text accessibilityRole="alert" style={styles.error}>{validation}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || !!validation }}
        disabled={disabled || !!validation} style={[styles.button, (disabled || !!validation) && styles.disabled]}
        onPress={() => { void demoWallet.sendAsset(form).then((result) => {
          if (result) { setTxid(result.txid); setAmount(''); setInvoice(''); }
        }); }}>
        <Text style={styles.buttonText}>{state.busy ? 'Processing…' : 'Review transfer'}</Text>
      </Pressable>
    </>}
    {!!txid && <>
      <Text style={styles.label}>Latest transfer</Text>
      <Text selectable style={styles.hint}>{txid}</Text>
      <Text style={styles.text}>Refresh both wallets to track confirmation in Activity.</Text>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  group: { gap: 12 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  text: { color: C.textSecondary, fontSize: 14, lineHeight: 21 },
  label: { color: C.textPrimary, fontSize: 14, fontWeight: '500' },
  hint: { color: C.textSecondary, fontSize: 12, lineHeight: 18 },
  choice: { padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  selected: { backgroundColor: C.primaryBg, borderColor: C.primary },
  input: { color: C.textPrimary, backgroundColor: C.bgInput, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: C.border, minHeight: 46 },
  button: { backgroundColor: C.primaryBg, borderColor: C.primary, borderWidth: 1, padding: 13, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: C.textPrimary, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.4 },
  error: { color: C.error, lineHeight: 21 },
});
