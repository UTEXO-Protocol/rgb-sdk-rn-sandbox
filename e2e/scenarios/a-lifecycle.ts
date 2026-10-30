/**
 * Scenario A — lifecycle & node (§7a.3).
 *
 * The wallet is already `init`+`unlock`ed by the harness (every scenario needs
 * it), so what is asserted here is what comes back afterwards: node info,
 * network info, `capabilities` against the live object, and `isDisposed`.
 * `dispose()` itself is the teardown step in `run.ts` — the other scenarios
 * still need the node.
 *
 * This is also where `runConformanceChecks` gets a **live** rn wallet, closing
 * the §6.0f gap on this platform the way §6.0l closed it on web: the runtime
 * block (`invoiceStatus`, `listChannels`, `listPayments`, `estimateFeeRate`)
 * has only ever run against a stub loader here.
 */
import { UTEXOWallet } from '@utexo/rgb-sdk-rn';
import {
  expectFields,
  expectNoWireKeys,
  runConformanceChecks,
  HEX_PUBKEY,
} from '@utexo/rgb-sdk-core/conformance';

import { assert, assertEq, buildWalletSync, type ScenarioContext } from '../harness';

const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'regtest', 'signet', 'utexo'];

export async function scenarioA(ctx: ScenarioContext): Promise<void> {
  const { wallet, step } = ctx;

  await step(
    'getNetwork',
    async () => wallet.getNetwork(),
    (n) => ({ network: n })
  );
  assertEq(wallet.getNetwork(), 'regtest', 'getNetwork');

  // rn has no second engine, so both carriers are absent — and `capabilities`
  // is derived from that, never stored (§2.7a, invariant 2).
  await step(
    'capabilities',
    async () => wallet.capabilities,
    (caps) => caps
  );
  const caps = wallet.capabilities as unknown as Record<string, boolean>;
  assertEq(caps.psbtSigning, false, 'capabilities.psbtSigning');
  assertEq(caps.beginEndFlows, false, 'capabilities.beginEndFlows');
  assert(
    (wallet as unknown as Record<string, unknown>).psbt === undefined &&
      (wallet as unknown as Record<string, unknown>).beginEnd === undefined,
    'carriers must be absent on rn, matching capabilities'
  );

  const nodeInfo = await step(
    'getNodeInfo',
    () => wallet.getNodeInfo(),
    (i) => i
  );
  expectFields(nodeInfo, {
    pubkey: { type: 'string', nonEmpty: true, pattern: HEX_PUBKEY },
    numChannels: { type: 'number', optional: true },
    numUsableChannels: { type: 'number', optional: true },
    numPeers: { type: 'number', optional: true },
  });
  expectNoWireKeys(nodeInfo);
  ctx.state.pubkey = nodeInfo.pubkey;

  const netInfo = await step(
    'getNetworkInfo',
    () => wallet.getNetworkInfo(),
    (i) => i
  );
  expectFields(netInfo, {
    network: { type: 'string', oneOf: NETWORKS },
    blockHeight: { type: 'number', min: 1 },
  });
  assertEq(netInfo.network as string, 'regtest', 'getNetworkInfo.network');
  expectNoWireKeys(netInfo);

  await step(
    'isDisposed',
    async () => wallet.isDisposed(),
    (d) => ({ disposed: d })
  );
  assertEq(wallet.isDisposed(), false, 'isDisposed before teardown');

  // Remote backup — only when the stack runs with VSS=1 (the node's VSS client
  // is configured at init from `vssUrl`, so there is nothing to back up to
  // otherwise).
  if (ctx.fx.VSS_URL) {
    const version = await step(
      'backupNow',
      () => wallet.backupNow(),
      (v) => ({ version: v })
    );
    assert(
      typeof version === 'number' && version >= 0,
      `backupNow must return a version, got ${JSON.stringify(version)}`
    );
  }

  // ── live conformance ──────────────────────────────────────────────────────
  await step(
    'runConformanceChecks (live wallet)',
    () => runLiveConformance(wallet),
    (r) => ({ total: r.total, failed: r.failures.length })
  );
}

interface ConformanceSummary {
  total: number;
  failures: { test: string; error: string }[];
}

/**
 * Collector runner — the same pattern as the web harness (§6.0l): the checks
 * share one live wallet, so `it` bodies are chained rather than raced, and a
 * failure is recorded instead of thrown so every check still runs.
 */
async function runLiveConformance(wallet: UTEXOWallet<'RGB_LN'>): Promise<ConformanceSummary> {
  const results: { test: string; ok: boolean; error?: string }[] = [];
  const stack: string[] = [];
  let chain = Promise.resolve();

  const describe = (name: string, fn: () => void) => {
    stack.push(name);
    fn();
    stack.pop();
  };
  const it = (name: string, fn: () => void | Promise<void>) => {
    const test = [...stack, name].join(' › ');
    chain = chain.then(async () => {
      try {
        await fn();
        results.push({ test, ok: true });
      } catch (e) {
        results.push({
          test,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };
  const expect = (actual: unknown) => ({
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
      }
    },
    toContain(expected: unknown) {
      if (!Array.isArray(actual) || !actual.includes(expected)) {
        throw new Error(
          `expected array containing ${String(expected)}, got ${JSON.stringify(actual)}`
        );
      }
    },
  });

  runConformanceChecks({
    name: 'rgb-sdk-rn (live e2e wallet)',
    walletClass: UTEXOWallet,
    createWallet: async () => wallet as unknown as Record<string, unknown>,
    // Capability probes call carrier methods with no arguments; on rn every
    // carrier is absent so they return immediately, but the contract is the
    // same as web's — give them a fresh, un-initialised instance.
    createWalletSync: () => buildWalletSync() as unknown as Record<string, unknown>,
    describe,
    it,
    expect,
  });
  await chain;

  const failures = results
    .filter((r) => !r.ok)
    .map((r) => ({ test: r.test, error: r.error ?? '' }));
  if (failures.length > 0) {
    throw new Error(
      `conformance failures (${failures.length}/${results.length}):\n` +
        failures.map((f) => `  ${f.test}: ${f.error}`).join('\n')
    );
  }
  // Sanity: the suite actually ran (surface + capabilities + runtime blocks).
  assert(results.length > 50, `conformance ran only ${results.length} checks`);
  return { total: results.length, failures };
}
