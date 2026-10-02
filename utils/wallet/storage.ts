import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeBurnRecord,
  type BurnOperationRecord,
  type BurnOperationStore,
} from '@utexo/rgb-sdk-rn';

/** Keep the v1 key; records migrate individually without replacing wallet data. */
export function createBurnStore(
  account: () => string,
  onSaved: (records: BurnOperationRecord[]) => void,
) {
  const key = () => {
    if (!account()) throw new Error('Open the wallet before reading its journal');
    return `utexo-burn-journal-v1:${account()}`;
  };
  const readAll = async () => {
    const saved = await AsyncStorage.getItem(key());
    const records: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(records)) throw new Error('Burn journal is unreadable');
    return records.map(normalizeBurnRecord);
  };
  return {
    readAll,
    async write(record: BurnOperationRecord) {
      const records = await readAll();
      const next = [...records.filter((item) => item.id !== record.id), record];
      await AsyncStorage.setItem(key(), JSON.stringify(next));
      onSaved(next);
    },
  } satisfies BurnOperationStore;
}
