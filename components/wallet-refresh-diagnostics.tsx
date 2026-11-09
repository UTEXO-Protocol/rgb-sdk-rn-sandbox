import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppColors as C } from '@/constants/theme';
import { formatRefreshDiagnostics, type WalletRefreshDiagnostics } from '@/utils/wallet/refresh-diagnostics';
import { WalletButton } from './wallet-overview';

export function WalletRefreshDiagnosticsCard({ report, appVersion }: {
  report: WalletRefreshDiagnostics;
  appVersion: string;
}) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => setFeedback(''), [report]);
  const batches = Object.entries(report.transfers ?? {});
  const failures = batches.filter(([, result]) => result.failure);
  const changed = batches.filter(([, result]) => result.updatedStatus);
  const copy = async () => {
    try {
      const Clipboard = await import('expo-clipboard');
      if (!(await Clipboard.setStringAsync(formatRefreshDiagnostics(report, appVersion))))
        throw new Error('Clipboard is unavailable');
      setFeedback('Refresh diagnostics copied.');
    } catch {
      setFeedback('Could not copy. Long-press the diagnostic text to copy it.');
    }
  };

  return <View style={styles.card}>
    <Text style={styles.heading}>Refresh diagnostics</Text>
    <Text style={styles.text}>
      {new Date(report.finishedAt).toLocaleString()} · {report.network}
    </Text>
    {report.transfers !== null && <Text style={styles.text}>
      {batches.length} batches checked · {changed.length} statuses changed · {failures.length} batch errors
    </Text>}
    {!!report.error && <Text selectable accessibilityRole="alert" style={styles.error}>
      {report.error.stage}: {report.error.name}{'\n'}{report.error.message}
    </Text>}
    {batches.map(([idx, result]) => <Text key={idx} selectable
      style={result.failure ? styles.error : styles.text}>
      Batch {idx} · {result.updatedStatus ?? 'Status unchanged'}
      {result.failure ? `\n${result.failure.name}\n${result.failure.message}` : ''}
    </Text>)}
    {report.transfers !== null && !batches.length &&
      <Text style={styles.text}>No pending transfer batches were returned.</Text>}
    <WalletButton title="Copy refresh diagnostics" onPress={() => { void copy(); }} />
    {!!feedback && <Text accessibilityLiveRegion="polite" style={styles.text}>{feedback}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.bgCard, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  text: { color: C.textSecondary, fontSize: 14 },
  error: { color: C.error, fontSize: 14 },
});
