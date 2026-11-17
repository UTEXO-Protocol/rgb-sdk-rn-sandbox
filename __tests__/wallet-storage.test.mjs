import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { burnDestinationReason, normalizeBurnRecord } from '@utexo/rgb-sdk/webrgb';

const source = ts.transpileModule(readFileSync(new URL('../utils/wallet/storage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const destination = { version: 1, chainId: 'eip155:31337', address: '0x' + '12'.repeat(20), dstEid: 0 };
const pending = {
  id: 'saved-id',
  params: { assetId: 'rgb:test', amount: '5', burnRecipient: burnDestinationReason(destination), feeRate: 2, minConfirmations: 3 },
  metadata: { origin: 'https://mint.example', network: 'regtest', burnDestination: destination },
  state: 'pending',
};

function openStore(initial) {
  const account = 'rgb:regtest:wallet';
  const key = `utexo-burn-journal-v1:${account}`;
  const env = { saved: initial, writes: 0, published: undefined };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports,
    require(name) {
      if (name === '@utexo/rgb-sdk/webrgb') return { normalizeBurnRecord };
      assert.equal(name, '@react-native-async-storage/async-storage');
      return {
        getItem: async name => { assert.equal(name, key); return env.saved; },
        setItem: async (name, value) => { assert.equal(name, key); env.saved = value; env.writes++; },
      };
    },
  });
  env.store = module.exports.createBurnStore(() => account, records => { env.published = records; });
  return env;
}

test('wallet journal keeps its account key and replaces a record by its ID', async () => {
  const env = openStore(JSON.stringify([pending]));
  const [record] = await env.store.readAll();
  assert.deepEqual(JSON.parse(JSON.stringify(record)), pending);
  assert.equal(env.writes, 0, 'Reading never rewrites the journal');
  await env.store.write({ ...record, id: 'second-id', state: 'cancelled' });
  assert.deepEqual(JSON.parse(env.saved).map((item) => item.id), ['saved-id', 'second-id']);
  assert.equal(env.published.length, 2);
  await env.store.write({ ...record, state: 'cancelled' });
  const updated = JSON.parse(env.saved);
  assert.deepEqual(updated.map((item) => [item.id, item.state]), [['second-id', 'cancelled'], ['saved-id', 'cancelled']]);
  env.saved = '{broken';
  await assert.rejects(env.store.write(record));
  assert.equal(env.writes, 2, 'Corrupt state must never be overwritten');
});

test('a record in an earlier format or with a mismatched commitment fails closed', async () => {
  const legacy = {
    origin: 'https://mint.example', state: 'pending',
    request: { requestId: 'saved-id', network: 'regtest', assetId: 'rgb:test', amount: '5',
      burnRecipient: { chainId: 'eip155:31337', address: destination.address }, feeRate: 2, minConfirmations: 3 },
  };
  const mismatched = { ...pending, params: { ...pending.params, burnRecipient: 'ab'.repeat(32) } };
  for (const record of [legacy, mismatched]) {
    const env = openStore(JSON.stringify([record]));
    await assert.rejects(env.store.readAll());
    await assert.rejects(env.store.write(pending));
    assert.equal(env.writes, 0);
  }
});
