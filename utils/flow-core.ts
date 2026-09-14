export type RlnFlowResults = { steps: any[]; success: boolean; error: any };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPoisonLike(e: unknown): boolean {
  const err = e as { message?: string; code?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  const msg = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
  return (
    code.includes('nodestatecorrupted') ||
    msg.includes('poisonerror') ||
    msg.includes('poison error') ||
    msg.includes('node internal state is corrupted')
  );
}

// TEMP(esplora): Poll until a node's asset `spendable` balance reaches `minSpendable`,
// mining + syncing + refreshing each iteration to absorb the Esplora REST indexer's
// tip lag. With the Electrum indexer a freshly mined block was reflected almost
// instantly, so flows could `mine(1)` and immediately start the next colored op.
// Esplora's REST tip lags a few seconds, leaving the prior transfer in
// WaitingConfirmations (spendable=0) and the next colored op fails with
// "conflict with current node state". Remove this gate when switching back to Electrum.
export async function waitForAssetSpendable(
  node: {
    getAssetBalance: (assetId: string) => Promise<{ spendable?: number } | null>;
    syncWallet: () => Promise<unknown>;
    refreshWallet: () => Promise<unknown>;
  },
  assetId: string,
  minSpendable: number,
  opts: {
    mine?: (n: number) => Promise<unknown>;
    attempts?: number;
    delayMs?: number;
    label?: string;
  } = {}
): Promise<boolean> {
  const { mine, attempts = 30, delayMs = 1000, label = 'node' } = opts;
  for (let i = 1; i <= attempts; i += 1) {
    const bal = await node.getAssetBalance(assetId).catch(() => null);
    const spendable = bal?.spendable ?? 0;
    if (spendable >= minSpendable) {
      console.log(
        `[TEMP wait] ${label} asset spendable=${spendable} >= ${minSpendable} (attempt ${i})`
      );
      return true;
    }
    console.log(
      `[TEMP wait] ${label} asset spendable=${spendable} < ${minSpendable}, attempt ${i}/${attempts}`
    );
    if (mine) await mine(1).catch(() => undefined);
    await node.syncWallet().catch(() => undefined);
    await node.refreshWallet().catch(() => undefined);
    await sleep(delayMs);
  }
  console.warn(
    `[TEMP wait] ${label} asset spendable never reached ${minSpendable} after ${attempts} attempts`
  );
  return false;
}

let activeDemoFlow: string | null = null;

export function beginExclusiveFlow(flowName: string) {
  if (activeDemoFlow && activeDemoFlow !== flowName) {
    throw new Error(
      `Flow "${flowName}" blocked: "${activeDemoFlow}" is currently running. Run flows sequentially to avoid RLN/node state conflicts.`
    );
  }
  activeDemoFlow = flowName;
}

export function endExclusiveFlow(flowName: string) {
  if (activeDemoFlow === flowName) {
    activeDemoFlow = null;
  }
}

export function createFlowResults(): {
  results: RlnFlowResults;
  addStep: (step: string, status: string, data?: any, error?: string) => void;
  failFlow: (flowName: string, error: any) => RlnFlowResults;
} {
  const results: RlnFlowResults = { steps: [], success: false, error: null };
  let lastStep: string | null = null;

  const addStep = (step: string, status: string, data?: any, error?: string) => {
    const idx = results.steps.findIndex((s: any) => s.step === step);
    const entry = { step, status, data, error };
    if (idx >= 0) results.steps[idx] = entry;
    else results.steps.push(entry);
    lastStep = step;
    if (status === 'error' || error) {
      console.error(`[flow] ✗ step="${step}" error="${error ?? '(none)'}"`, data ?? null);
    } else if (status === 'running') {
      console.log(`[flow] ▶ step="${step}"`);
    } else {
      console.log(`[flow] ✓ step="${step}"`, data ?? null);
    }
  };

  const failFlow = (flowName: string, error: any): RlnFlowResults => {
    const message = error?.message ?? String(error);
    const stack = error?.stack ?? null;
    console.error(
      `[flow] ✗ FLOW FAILED flowName="${flowName}" lastStep="${lastStep ?? 'none'}" error="${message}"`,
      stack ? `\n${stack}` : ''
    );
    results.success = false;
    results.error = { message, lastStep, stack };
    return results;
  };

  return { results, addStep, failFlow };
}
