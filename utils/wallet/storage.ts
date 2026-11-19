import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeBurnRecord,
  type BurnOperationRecord,
  type BurnOperationStore,
} from '@utexo/rgb-sdk/webrgb';

/** One journal per wallet account; every record is validated on read and write. */
export function createBurnStore(
  account: () => string,
  onSaved: (records: BurnOperationRecord[]) => void,
) {
  const key = () => {
    if (!account()) throw new Error('Open the wallet before reading its journal');
    return `utexo-burn-journal-v1:${account()}`;
  };
  const readAll = async (): Promise<BurnOperationRecord[]> => {
    const saved = await AsyncStorage.getItem(key());
    const records: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(records)) throw new Error('Burn journal is unreadable');
    return records.map(normalizeBurnRecord);
  };
  return {
    readAll,
    async write(record: BurnOperationRecord) {
      const next = [...(await readAll()).filter((item) => item.id !== record.id), record];
      await AsyncStorage.setItem(key(), JSON.stringify(next));
      onSaved(next);
    },
  } satisfies BurnOperationStore;
}
