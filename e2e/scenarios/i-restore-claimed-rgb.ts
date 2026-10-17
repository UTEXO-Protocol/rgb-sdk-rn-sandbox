/**
 * Scenario I — VSS restore of a channel that has a *claimed RGB payment*
 * (rgb-sdk-rn#58).
 *
 * H covers a BTC payment the wallet received over a channel it opened itself.
 * #58 is reported on the other path: the LSP opens the channel, delivers an RGB
 * asset over it via `receiveAsset` / `lightning_receive`, the payment is
 * claimed, and after backup → wipe → restore `unlock()` never returns. The last
 * LDK lines are the startup claim replay:
 *
 *   Completing monitor update completion action … PaymentClaimed { … pending_mpp_claim … }
 *   Delaying monitor unlock for channel X as another channel's mon update needs to complete first
 *
 * So this scenario follows the reporter's path step for step, and puts a
 * deadline on the restore boot: a hang is the bug, and it must fail the
 * scenario by name rather than surface as the runner's idle timeout.
 *
 * Needs a regular-channel LSP (the reporter's signet LSP has virtual channels
 * off): `VIRTUAL_OPEN_MODE= VSS=1 ./scripts/start-lsp-regtest.sh`.
 *
 * A timed-out restore leaves its native node running with no JS handle (see
 * CLAUDE.md, Debug note) — relaunch the app before the next run.
 */
import { UtexoLSPClient, type UtexoLsp } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';

import { mine, sendToAddress } from '@/utils/bitcoin-node';

import {
  assert,
  assertEq,
  bootWallet,
  hostAddr,
  hostUrl,
  waitFor,
  type BootedWallet,
  type ScenarioContext,
} from '../harness';

const RESTORE_DEADLINE_MS = 180_000;
const CHANNEL_TIMEOUT_MS = 240_000;
const SETTLE_TIMEOUT_MS = 180_000;

async function daemonPost(url: string, path: string, body: object = {}): Promise<any> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function scenarioI(ctx: ScenarioContext): Promise<void> {
  const { fx, step } = ctx;

  if (!fx.VSS_URL) {
    throw new Error('I requires VSS_URL (start the stack with VIRTUAL_OPEN_MODE= VSS=1)');
  }
  if (!fx.IFA_ASSET_ID || !fx.UTEXO_LSP_URL || !fx.LSP_PUBKEY || !fx.LSP_URL) {
    throw new Error('I requires IFA_ASSET_ID, UTEXO_LSP_URL, LSP_PUBKEY and LSP_URL in fixtures');
  }
  const vssUrl = hostUrl(fx.VSS_URL);
  const assetId = fx.IFA_ASSET_ID;
  const lspBaseUrl = hostUrl(fx.UTEXO_LSP_URL);
  const lspDaemonUrl = hostUrl(fx.LSP_URL);
  const faucetUrl = hostUrl(fx.FAUCET_URL);
  const amountSats = Math.ceil((fx.MIN_AMT_MSAT ?? 3_000_000) / 1000);
  const amountRgb = 10 ** (fx.IFA_PRECISION ?? 0);

  await step(
    'preflight: LSP serves the asset over regular channels',
    async () => {
      const info = await new UtexoLSPClient({ baseUrl: lspBaseUrl }).getInfo();
      if (info.virtualChannelMode) {
        throw new Error(
          `LSP opens virtual channels (${info.virtualChannelMode}); #58 is on a regular channel — ` +
            'restart with VIRTUAL_OPEN_MODE= VSS=1 ./scripts/start-lsp-regtest.sh'
        );
      }
      assert(
        info.supportedAssets.some((a) => a.assetId === assetId),
        `LSP does not serve ${assetId}`
      );
      return info;
    },
    (info) => ({ pubkey: info.pubkey, virtualChannelMode: info.virtualChannelMode ?? '' })
  );

  const lspPeer = {
    baseUrl: lspBaseUrl,
    peerPubkey: fx.LSP_PUBKEY,
    peerHost: hostAddr(fx.LSP_PEER_PORT).split(':')[0],
    peerPort: fx.LSP_PEER_PORT,
  };

  // ── the device that is about to be lost ───────────────────────────────────
  let lsp: UtexoLsp | null = null;
  const first = await step(
    'boot wallet (VSS on, LSP attached)',
    () =>
      bootWallet({
        vssUrl,
        label: 'i_a_',
        allowEmptyRestore: true,
        beforeInit: async (w) => {
          lsp = await w.createLsp(lspPeer);
        },
      }),
    (b) => ({ storageDirPath: b.storageDirPath, ports: [b.daemonPort, b.ldkPeerPort] })
  );
  const w1 = first.wallet;
  const lspA = lsp as UtexoLsp | null;
  assert(lspA, 'createLsp() did not run');
  let stopped = false;

  try {
    await step('fund + createUtxos', async () => {
      const address = await w1.getAddress();
      await sendToAddress(address, 1);
      await mine(6);
      await waitFor('funds to arrive', async () => {
        await w1.syncWallet();
        return (await w1.getBtcBalance()).vanilla.settled > 0;
      });
      const coloredBefore = (await w1.getBtcBalance()).colored.settled;
      await w1.createUtxos({ upTo: false, num: 5, size: 32500, feeRate: 7 });
      await mine(1);
      await waitFor('confirmed RGB UTXOs', async () => {
        await w1.syncWallet();
        return (await w1.getBtcBalance()).colored.settled >= coloredBefore + 5 * 32500;
      });
      return address;
    });

    const channel = await step(
      'LSP opens the RGB channel',
      async () => {
        await lspA.connect();
        await mine(2);
        return lspA.waitForChannel(assetId, {
          timeoutMs: CHANNEL_TIMEOUT_MS,
          pollIntervalMs: 3000,
          onEachPoll: async () => {
            await mine(1);
          },
        });
      },
      (c) => c
    );

    // The payment #58 needs: claimed on the restored side, carrying an asset.
    await step(
      'receive RGB over the channel (lightning_receive)',
      async () => {
        const { lnInvoice, rgbInvoice } = await lspA.receiveAsset({
          assetId,
          amountSats,
          amountRgb,
          onchainAsset: 'payout',
        });
        const decoded = await daemonPost(faucetUrl, '/decodergbinvoice', { invoice: rgbInvoice });
        const assignment =
          decoded.assignment?.type === 'Fungible' && decoded.assignment?.value > 0
            ? decoded.assignment
            : { type: 'Fungible', value: amountRgb };
        await daemonPost(faucetUrl, '/sendrgb', {
          donation: false,
          fee_rate: 7,
          min_confirmations: 1,
          skip_sync: false,
          recipient_map: {
            [assetId]: [
              {
                recipient_id: decoded.recipient_id,
                assignment,
                transport_endpoints: decoded.transport_endpoints,
              },
            ],
          },
        });
        const outcome = await lspA.awaitReceiveSettlement(lnInvoice, {
          timeoutMs: SETTLE_TIMEOUT_MS,
          pollIntervalMs: 3000,
          onEachPoll: async () => {
            await mine(1);
            const refresh = { filter: [], skip_sync: false };
            await daemonPost(faucetUrl, '/refreshtransfers', refresh).catch(() => undefined);
            await daemonPost(lspDaemonUrl, '/refreshtransfers', refresh).catch(() => undefined);
          },
        });
        assertEq(outcome, 'settled', 'lightning_receive outcome');
        return { lnInvoice, amountRgb: assignment.value };
      },
      (v) => v
    );

    const before = await step(
      'snapshot channel',
      async () => {
        const [info, channels] = await Promise.all([w1.getNodeInfo(), w1.listChannels()]);
        const chan = channels.find((c) => c.channelId === channel.channelId);
        assert(chan, `channel ${channel.channelId} missing before backup`);
        assert((chan.assetLocalAmount ?? 0) > 0, 'the claimed asset must be on our side of the channel');
        return {
          pubkey: info.pubkey,
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

    // ── restore: the call #58 says never returns ─────────────────────────────
    const second: BootedWallet = await step(
      'restore on a fresh device (init → vssClearFence → unlock)',
      () =>
        withDeadline(
          bootWallet({
            vssUrl,
            mnemonic: first.mnemonic,
            label: 'i_b_',
            allowEmptyRestore: false,
            beforeInit: async (w) => {
              await w.createLsp(lspPeer);
            },
          }),
          RESTORE_DEADLINE_MS,
          `rgb-sdk-rn#58 reproduced: restore did not return within ${RESTORE_DEADLINE_MS / 1000}s ` +
            `for channel ${before.channelId} with a claimed RGB payment. Check the native log for ` +
            '"Delaying monitor unlock … as another channel\'s mon update needs to complete first". ' +
            'Relaunch the app before the next run.'
        ),
      (b) => ({ storageDirPath: b.storageDirPath })
    );
    const w2 = second.wallet;

    try {
      await step(
        'verify restored channel',
        async () => {
          const [info, channels] = await Promise.all([w2.getNodeInfo(), w2.listChannels()]);
          const chan = channels.find((c) => c.channelId === before.channelId);
          assertEq(info.pubkey, before.pubkey, 'restored node pubkey');
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
