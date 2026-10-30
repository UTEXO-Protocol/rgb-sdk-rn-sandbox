/**
 * rn e2e orchestrator (MIGRATION-PLAN-v3 §6.0m).
 *
 * One wallet for A–E, which share state deliberately (H runs its own): booting
 * an RLN node and funding it takes most of the run's wall-clock time, and the
 * later scenarios need what the earlier ones produce (B's colorable UTXOs, C's
 * asset). A scenario that fails is recorded and the run continues, so one
 * failure does not hide the state of the other four.
 *
 * Everything observable leaves through `emit()` — the screen renders the same
 * markers the host runner scrapes, so what a human sees and what CI decides on
 * cannot disagree.
 */
import { emit, emitLog, flushMarkers, setMarkerSink, type Marker } from './marker';
import {
  bootWallet,
  hostUrl,
  makeStep,
  parseFixtures,
  type E2EFixtures,
  type ScenarioContext,
} from './harness';
import { scenarioA } from './scenarios/a-lifecycle';
import { scenarioB } from './scenarios/b-onchain';
import { scenarioC } from './scenarios/c-assets';
import { scenarioD } from './scenarios/d-inflation';
import { scenarioE } from './scenarios/e-lightning';
import { scenarioH } from './scenarios/h-restore';
import {
  bootRgbLibWallet,
  rgbLibUnlockParams,
  useBridge,
  type RgbLibScenarioContext,
} from './rgb-lib-harness';
import { scenarioL1 } from './scenarios/l1-rgb-lib-onchain';
import { scenarioL2 } from './scenarios/l2-rgb-lib-assets';
import { scenarioL3 } from './scenarios/l3-rgb-lib-bfa-burn';
import { scenarioL4 } from './scenarios/l4-rgb-lib-backup';

type Scenario =
  | { id: string; title: string; engine: 'RGB_LN'; run: (ctx: ScenarioContext) => Promise<void> }
  | { id: string; title: string; engine: 'RGB_L1'; run: (ctx: RgbLibScenarioContext) => Promise<void> };

const SCENARIOS: Scenario[] = [
  { id: 'A', title: 'lifecycle & node', engine: 'RGB_LN', run: scenarioA },
  { id: 'B', title: 'on-chain & UTXO', engine: 'RGB_LN', run: scenarioB },
  { id: 'C', title: 'RGB assets', engine: 'RGB_LN', run: scenarioC },
  { id: 'D', title: 'IFA + inflation', engine: 'RGB_LN', run: scenarioD },
  { id: 'E', title: 'lightning', engine: 'RGB_LN', run: scenarioE },
  { id: 'H', title: 'backup survives device loss', engine: 'RGB_LN', run: scenarioH },
  // rgb-lib (RGB_L1): two own wallets, no Lightning node. L2–L4 build on L1.
  { id: 'L1', title: 'rgb-lib wallet, BTC & sendBtc', engine: 'RGB_L1', run: scenarioL1 },
  { id: 'L2', title: 'rgb-lib asset issue & sends', engine: 'RGB_L1', run: scenarioL2 },
  { id: 'L3', title: 'rgb-lib BFA burn path', engine: 'RGB_L1', run: scenarioL3 },
  { id: 'L4', title: 'rgb-lib backup & restore', engine: 'RGB_L1', run: scenarioL4 },
];

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);

export interface RunOptions {
  fixtures: unknown;
  /** Subset of scenario ids to run, e.g. ['A','D']. Defaults to all. */
  only?: string[];
  /** Host marker sink (`http://10.0.2.2:<port>`); omit to run screen-only. */
  sink?: string | null;
  /** Mirror every marker into the on-screen log. */
  onMarker?: (marker: Marker) => void;
}

export interface RunSummary {
  ok: boolean;
  passed: number;
  failed: number;
  failures: string[];
  ms: number;
}

export async function runE2E(opts: RunOptions): Promise<RunSummary> {
  const started = Date.now();
  setMarkerSink(opts.sink ?? null);
  const selected = opts.only?.length
    ? SCENARIOS.filter((s) => opts.only!.includes(s.id))
    : SCENARIOS;

  const send = (marker: Marker) => {
    emit(marker);
    opts.onMarker?.(marker);
  };

  send({
    t: 'run',
    startedAt: new Date().toISOString(),
    scenarios: selected.map((s) => s.id),
  });

  const failures: string[] = [];
  let passed = 0;
  let fx: E2EFixtures;
  let ctx: ScenarioContext | null = null;
  let l1: RgbLibScenarioContext | null = null;
  const needsRln = selected.some((s) => s.engine === 'RGB_LN');
  const needsRgbLib = selected.some((s) => s.engine === 'RGB_L1');

  try {
    // RGB_L1-only runs need just the indexer and proxy from the fixtures.
    fx = needsRln ? parseFixtures(opts.fixtures) : (opts.fixtures as E2EFixtures);
    if (!fx || typeof fx !== 'object') throw new Error('e2e fixtures missing — pass ?fx=<uri-encoded json>');
    if (needsRln) {
      const boot = await bootWallet({
        vssUrl: fx.VSS_URL ? hostUrl(fx.VSS_URL) : null,
        allowEmptyRestore: true,
      });
      emitLog(
        `wallet booted — storage=${boot.storageDirPath} ports=${boot.daemonPort}/${boot.ldkPeerPort}`
      );
      ctx = {
        wallet: boot.wallet,
        boot,
        fx,
        state: {},
        step: makeStep('boot'),
      };
    }
    if (needsRgbLib) {
      const unlockParams = rgbLibUnlockParams(fx);
      useBridge(fx);
      const sender = await bootRgbLibWallet(unlockParams, { label: 'sender' });
      const receiver = await bootRgbLibWallet(unlockParams, { label: 'receiver' }).catch(async (e) => {
        await sender.wallet.dispose().catch(() => undefined);
        throw e;
      });
      emitLog(`rgb-lib wallets booted — sender=${sender.storageDirPath} receiver=${receiver.storageDirPath}`);
      l1 = { fx, unlockParams, sender, receiver, state: {}, step: makeStep('boot') };
    }
  } catch (e) {
    await ctx?.wallet.dispose().catch(() => undefined);
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    send({ t: 'scenario', scenario: 'boot', ok: false, ms: Date.now() - started, error });
    const summary: RunSummary = {
      ok: false,
      passed: 0,
      failed: 1,
      failures: [`boot: ${error}`],
      ms: Date.now() - started,
    };
    send({ t: 'done', ok: false, passed: 0, failed: 1, ms: summary.ms, failures: summary.failures });
    await flushMarkers();
    return summary;
  }

  for (const scenario of selected) {
    const scenarioStarted = Date.now();
    try {
      if (scenario.engine === 'RGB_LN') {
        // `state` comes across by reference on purpose — C hands its assetId to D/E.
        await scenario.run({ ...ctx!, step: makeStep(scenario.id) });
      } else {
        // Same object, new step: L4 replaces `sender` and teardown must see it.
        l1!.step = makeStep(scenario.id);
        await scenario.run(l1!);
      }
      passed += 1;
      send({
        t: 'scenario',
        scenario: scenario.id,
        ok: true,
        ms: Date.now() - scenarioStarted,
      });
    } catch (e) {
      const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
      failures.push(`${scenario.id} (${scenario.title}): ${e instanceof Error ? e.message : String(e)}`);
      send({
        t: 'scenario',
        scenario: scenario.id,
        ok: false,
        ms: Date.now() - scenarioStarted,
        error,
      });
    }
  }

  // Teardown is an assertion too: dispose must be observable (§7a.3 A).
  try {
    const wallets = [
      ...(ctx ? [ctx.wallet] : []),
      ...(l1 ? [l1.sender.wallet, l1.receiver.wallet] : []),
    ];
    for (const wallet of wallets) {
      if (!wallet.isDisposed()) await wallet.dispose();
      if (!wallet.isDisposed()) throw new Error('isDisposed() is false after dispose()');
    }
    send({ t: 'scenario', scenario: 'teardown', ok: true, ms: 0 });
  } catch (e) {
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    failures.push(`teardown: ${error}`);
    send({ t: 'scenario', scenario: 'teardown', ok: false, ms: 0, error });
  }

  const summary: RunSummary = {
    ok: failures.length === 0,
    passed,
    failed: failures.length,
    failures,
    ms: Date.now() - started,
  };
  send({
    t: 'done',
    ok: summary.ok,
    passed: summary.passed,
    failed: summary.failed,
    ms: summary.ms,
    failures: summary.failures,
  });
  await flushMarkers();
  return summary;
}
