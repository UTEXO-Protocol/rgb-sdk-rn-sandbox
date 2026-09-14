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

type Scenario = (ctx: ScenarioContext) => Promise<void>;

const SCENARIOS: { id: string; title: string; run: Scenario }[] = [
  { id: 'A', title: 'lifecycle & node', run: scenarioA },
  { id: 'B', title: 'on-chain & UTXO', run: scenarioB },
  { id: 'C', title: 'RGB assets', run: scenarioC },
  { id: 'D', title: 'IFA + inflation', run: scenarioD },
  { id: 'E', title: 'lightning', run: scenarioE },
  { id: 'H', title: 'backup survives device loss', run: scenarioH },
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

  try {
    fx = parseFixtures(opts.fixtures);
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
  } catch (e) {
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
    // `state` comes across by reference on purpose — C hands its assetId to D/E.
    const scoped: ScenarioContext = { ...ctx, step: makeStep(scenario.id) };
    try {
      await scenario.run(scoped);
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
    await ctx.wallet.dispose();
    const disposed = ctx.wallet.isDisposed();
    if (!disposed) throw new Error('isDisposed() is false after dispose()');
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
