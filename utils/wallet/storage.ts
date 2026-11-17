import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeBurnRecord,
  type AnyBurnOperationRecord,
  type BurnOperationStore,
} from '@utexo/rgb-sdk/webrgb';

/** Keep the v1 key; records migrate individually without replacing wallet data. */
export function createBurnStore(
  account: () => string,
  onSaved: (records: AnyBurnOperationRecord[]) => void,
) {
  const key = () => {
    if (!account()) throw new Error('Open the wallet before reading its journal');
    return `utexo-burn-journal-v1:${account()}`;
  };
  const readSaved = async (): Promise<unknown[]> => {
    const saved = await AsyncStorage.getItem(key());
    const records: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(records)) throw new Error('Burn journal is unreadable');
    return records;
  };
  const readAll = async () => (await readSaved()).map(normalizeBurnRecord);
  return {
    readAll,
    async write(record: AnyBurnOperationRecord) {
      // Other records stay exactly as saved: never re-encode an older burn.
      const saved = await readSaved();
      const others = saved.filter((item) => normalizeBurnRecord(item).id !== record.id);
      await AsyncStorage.setItem(key(), JSON.stringify([...others, record]));
      onSaved([...others.map(normalizeBurnRecord), record]);
    },
  } satisfies BurnOperationStore;
}
