import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeBurnRecord } from '@utexo/rgb-sdk-rn';

const source = ts.transpileModule(readFileSync(new URL('../utils/wallet/storage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

test('wallet journal keeps its account key and migrates v1 records without losing pending burns', async () => {
  const legacy = {
    origin: 'https://mint.example', state: 'pending',
    request: { requestId: 'saved-id', network: 'regtest', assetId: 'rgb:test', amount: '5',
      burnRecipient: { chainId: 'eip155:31337', address: '0x' + '12'.repeat(20) }, feeRate: 2, minConfirmations: 3 },
  };
  const account = 'rgb:regtest:wallet';
  const key = `utexo-burn-journal-v1:${account}`;
  let saved = JSON.stringify([legacy]), writes = 0, published;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports,
    require(name) {
      if (name === '@utexo/rgb-sdk-rn') return { normalizeBurnRecord };
      assert.equal(name, '@react-native-async-storage/async-storage');
      return {
        getItem: async name => { assert.equal(name, key); return saved; },
        setItem: async (name, value) => { assert.equal(name, key); saved = value; writes++; },
      };
    },
  });
  const store = module.exports.createBurnStore(() => account, records => { published = records; });
  const [record] = await store.readAll();
  assert.equal(record.id, 'saved-id');
  assert.equal(record.state, 'pending');
  assert.equal(record.params.burnRecipient, '0'.repeat(24) + '12'.repeat(20));
  assert.equal(writes, 0, 'Reading never rewrites the journal');
  await store.write({ ...record, id: 'second-id', state: 'cancelled' });
  const records = JSON.parse(saved);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'saved-id');
  assert.equal(records[0].state, 'pending');
  assert.equal(published.length, 2);
  saved = '{broken';
  await assert.rejects(store.write(record));
  assert.equal(writes, 1, 'Corrupt state must never be overwritten');
});
