/**
 * Scenario J — scenario I on signet, against the reporter's infrastructure
 * (rgb-sdk-rn#58).
 *
 * I passes on regtest, and its restored LDK log shows the very lines #58 ends
 * on ("claim was redundant … Delaying monitor unlock …") followed a second
 * later by the channel being released. What I cannot reproduce is the
 * reporter's environment: signet, the public utexo-lsp, `vss-server.utexo.com`,
 * the remote esplora indexer and LNUSDT delivered by a *converted*
 * `lightning_receive` (USDT on-chain → LNUSDT over the channel). J runs the same
 * steps there, so the only differences left are the device and the SDK build.
 *
 * Nothing here is mined: every confirmation is a ~30 s signet block, so the run
 * takes 15–30 min. The host runner needs `--idle-timeout 1800 --timeout 5400`.
 *
 * Reads the UTEXO env, not the fixtures: `EXPO_PUBLIC_UTEXO_*` (indexer, proxy,
 * VSS) and `EXPO_PUBLIC_FAUCET_NODE_URL`, which must hold BTC and USDT.
 */
import { UtexoLSPClient, type UtexoLsp } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';

import {
  BRIDGE_ASSET_ID,
  BRIDGE_TICKER,
  LSP_URL,
  PAYOUT_ASSET_ID,
  PAYOUT_TICKER,
} from '@/screens/apay-linked-asset-signet/config';
import { faucet } from '@/screens/apay-signet/daemons';
import { buildUtexoConfig } from '@/utils/env';

import { emitLog } from '../marker';
import { assert, assertEq, bootWallet, sleep, type BootedWallet, type ScenarioContext } from '../harness';

const FUND_SAT = 300_000;
const FEE_RATE = 2;
const POLL_MS = 15_000;
const FUND_TIMEOUT_MS = 15 * 60_000;
const CHANNEL_TIMEOUT_MS = 30 * 60_000;
const ONCHAIN_SETTLE_TIMEOUT_MS = 45 * 60_000;
/** Regtest restores in ~4 s; signet adds a remote VSS and esplora sync. */
const RESTORE_DEADLINE_MS = 15 * 60_000;

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function pollUntil(label: string, timeoutMs: number, fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      if (await fn()) return;
    } catch (e) {
      emitLog(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`timed out after ${timeoutMs / 60_000} min waiting for ${label}`);
}

export async function scenarioJ(ctx: ScenarioContext): Promise<void> {
  const { step } = ctx;
  const { network, unlockParams } = buildUtexoConfig();
  const vssUrl = process.env.EXPO_PUBLIC_UTEXO_VSS_URL?.trim();
  if (!vssUrl) throw new Error('J requires EXPO_PUBLIC_UTEXO_VSS_URL');
  const amountSats = 3000;
  const amountRgb = 1_000_000;

  const info = await step(
    'preflight: signet LSP + faucet',
    async () => {
      const lspInfo = await new UtexoLSPClient({ baseUrl: LSP_URL }).getInfo();
      assert(!lspInfo.virtualChannelMode, `LSP opens virtual channels (${lspInfo.virtualChannelMode})`);
      assert(
        lspInfo.supportedAssets.some((a) => a.assetId === PAYOUT_ASSET_ID),
        `LSP does not serve ${PAYOUT_TICKER} ${PAYOUT_ASSET_ID}`
      );
      const btc = await faucet.btcBalance();
      const usdt = await faucet.assetBalance(BRIDGE_ASSET_ID);
      assert((btc?.vanilla?.spendable ?? 0) >= FUND_SAT * 2, 'faucet is short of BTC');
      assert(Number(usdt?.spendable ?? 0) >= amountRgb, `faucet is short of ${BRIDGE_TICKER}`);
      return { lspInfo, faucetUsdt: Number(usdt.spendable) };
    },
    (v) => ({
      lsp: LSP_URL,
      pubkey: v.lspInfo.pubkey,
      host: `${v.lspInfo.host}:${v.lspInfo.port}`,
      vssUrl,
      indexer: unlockParams.indexerUrl,
      faucetUsdt: v.faucetUsdt,
    })
  );

  const { host, port } = info.lspInfo;
  assert(host && port, 'LSP /get_info carries no peer host/port');
  const lspPeer = { baseUrl: LSP_URL, peerPubkey: info.lspInfo.pubkey, peerHost: host, peerPort: port };

  let lsp: UtexoLsp | null = null;
  const first = await step(
    'boot signet wallet (VSS on, LSP attached)',
    () =>
      bootWallet({
        network,
        unlockParams,
        vssUrl,
        label: 'j_a_',
        allowEmptyRestore: true,
        beforeInit: async (w) => {
          lsp = await w.createLsp(lspPeer);
        },
      }),
    (b) => ({ storageDirPath: b.storageDirPath })
  );
  const w1 = first.wallet;
  const lspA = lsp as UtexoLsp | null;
  assert(lspA, 'createLsp() did not run');
  let stopped = false;

  try {
    await step('fund via faucet + createUtxos', async () => {
      const address = await w1.getAddress();
      await faucet.sendBtc(address, FUND_SAT, FEE_RATE);
      await pollUntil('BTC funding confirmation', FUND_TIMEOUT_MS, async () => {
        await w1.syncWallet();
        const settled = (await w1.getBtcBalance()).vanilla.settled;
        emitLog(`J settled BTC: ${settled}`);
        return settled > 0;
      });
      const coloredBefore = (await w1.getBtcBalance()).colored.settled;
      await w1.createUtxos({ upTo: false, num: 5, size: 32500, feeRate: FEE_RATE });
      await pollUntil('createUtxos confirmation', FUND_TIMEOUT_MS, async () => {
        await w1.syncWallet();
        const colored = (await w1.getBtcBalance()).colored.settled;
        emitLog(`J colored settled: ${colored} (was ${coloredBefore})`);
        return colored > coloredBefore;
      });
      return address;
    });

    const channel = await step(
      `LSP opens the ${PAYOUT_TICKER} channel`,
      async () => {
        await lspA.connect();
        return lspA.waitForChannel(PAYOUT_ASSET_ID, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (msg) => emitLog(`J channel: ${msg}`),
          onEachPoll: async () => {
            await lspA.connect().catch(() => undefined);
            await w1.syncWallet().catch(() => undefined);
          },
        });
      },
      (c) => c
    );

    // The reporter's path: LNUSDT delivered by lightning_receive, paid on-chain
    // in USDT (the LSP resolves the counterpart from CONVERTIBLE_PAIRS).
    await step(
      `receive ${PAYOUT_TICKER} over the channel (lightning_receive, ${BRIDGE_TICKER} on-chain)`,
      async () => {
        const recv = await lspA.receiveAsset({ assetId: PAYOUT_ASSET_ID, amountSats, amountRgb });
        const decoded = await faucet.decodeRgbInvoice(recv.rgbInvoice);
        const onchainAssetId = recv.onchainAssetId ?? BRIDGE_ASSET_ID;
        const assignment = decoded.assignment?.type === 'Fungible' && decoded.assignment?.value > 0
          ? decoded.assignment
          : { type: 'Fungible', value: amountRgb };
        await faucet.sendRgb({
          donation: false,
          fee_rate: FEE_RATE,
          min_confirmations: 1,
          skip_sync: false,
          recipient_map: {
            [onchainAssetId]: [
              {
                recipient_id: decoded.recipient_id,
                assignment,
                transport_endpoints: decoded.transport_endpoints ?? [],
              },
            ],
          },
        });
        await sleep(2000);
        await faucet.refresh().catch(() => undefined);
        const outcome = await lspA.awaitReceiveSettlement(recv.lnInvoice, {
          timeoutMs: ONCHAIN_SETTLE_TIMEOUT_MS,
          pollIntervalMs: POLL_MS,
          onProgress: (s) => emitLog(`J lightning_receive: ${s}`),
          onEachPoll: async () => {
            await faucet.refresh().catch(() => undefined);
            await lspA.connect().catch(() => undefined);
          },
        });
        assertEq(outcome, 'settled', 'lightning_receive outcome');
        return { converted: recv.converted, onchainAssetId, amount: assignment.value };
      },
      (v) => v
    );

    const before = await step(
      'snapshot channel',
      async () => {
        const [nodeInfo, channels] = await Promise.all([w1.getNodeInfo(), w1.listChannels()]);
        const chan = channels.find((c) => c.channelId === channel.channelId);
        assert(chan, `channel ${channel.channelId} missing before backup`);
        assert((chan.assetLocalAmount ?? 0) > 0, 'the claimed asset must be on our side of the channel');
        return {
          pubkey: nodeInfo.pubkey,
          channelId: chan.channelId,
          capacitySat: chan.capacitySat,
          localBalanceMsat: chan.localBalanceMsat ?? 0,
          assetLocalAmount: chan.assetLocalAmount ?? 0,
        };
      },
      (v) => v
    );

    await step('backupNow', () => w1.backupNow(), (v) => ({ version: v }));

    await step(
      'wipe local state',
      async () => {
        await w1.shutdown();
        stopped = true;
        await FileSystem.deleteAsync(first.storageDirUri, { idempotent: true });
        return first.storageDirUri;
      },
      (dir) => ({ deleted: dir })
    );

    // A heartbeat while unlock runs: a hang shows as ticks with no step, and the
    // restored node's .ldk/logs/logs.txt can be read in the meantime.
    const restoreStarted = Date.now();
    const heartbeat = setInterval(
      () => emitLog(`J restore still running: ${Math.round((Date.now() - restoreStarted) / 1000)}s`),
      30_000
    );
    let second: BootedWallet;
    try {
      second = await step(
        'restore on a fresh device (init → vssClearFence → unlock)',
        () =>
          withDeadline(
            bootWallet({
              network,
              unlockParams,
              vssUrl,
              mnemonic: first.mnemonic,
              label: 'j_b_',
              allowEmptyRestore: false,
              beforeInit: async (w) => {
                await w.createLsp(lspPeer);
              },
            }),
            RESTORE_DEADLINE_MS,
            `rgb-sdk-rn#58 reproduced on signet: restore did not return within ` +
              `${RESTORE_DEADLINE_MS / 60_000} min for channel ${before.channelId}. ` +
              'Relaunch the app before the next run.'
          ),
        (b) => ({ storageDirPath: b.storageDirPath, ms: Date.now() - restoreStarted })
      );
    } finally {
      clearInterval(heartbeat);
    }
    const w2 = second.wallet;

    try {
      await step(
        'verify restored channel',
        async () => {
          const [nodeInfo, channels] = await Promise.all([w2.getNodeInfo(), w2.listChannels()]);
          const chan = channels.find((c) => c.channelId === before.channelId);
          assertEq(nodeInfo.pubkey, before.pubkey, 'restored node pubkey');
          assert(chan, `channel ${before.channelId} missing after restore`);
          assertEq(chan.capacitySat, before.capacitySat, 'restored channel capacity');
          assertEq(chan.localBalanceMsat ?? 0, before.localBalanceMsat, 'restored channel local balance');
          assertEq(chan.assetLocalAmount ?? 0, before.assetLocalAmount, 'restored channel asset amount');
          return chan;
        },
        (c) => ({ channelId: c.channelId, assetLocalAmount: c.assetLocalAmount })
      );
    } finally {
      await w2.destroy().catch(() => undefined);
    }
  } finally {
    if (!stopped) await w1.destroy().catch(() => undefined);
  }
}
