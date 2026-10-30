import type { BurnDestinationRoute } from '@utexo/rgb-sdk-rn/webrgb';
import type { AnyUtexoWallet, WalletProtocol } from '@utexo/rgb-sdk-rn';
import { buildDemoWalletConfig, type DemoWalletNetwork } from '../env';
import type { ConnectionProfile } from './connection';
import { describeWalletConfiguration, openSavedWallet } from './node';
import { deleteSavedRgbLibWallet, describeRgbLibConfiguration, openSavedRgbLibWallet } from './rgb-lib-node';

export interface WalletProfile {
  protocol: WalletProtocol;
  networkKey: string;
  connection: ConnectionProfile;
  describe(network: DemoWalletNetwork): string;
  open(network: DemoWalletNetwork, stopped?: AnyUtexoWallet): Promise<{
    wallet: AnyUtexoWallet; address: string; account: string;
  }>;
  /** Remove this profile's persisted data after its SDK handles have closed. */
  deleteSaved?(network: DemoWalletNetwork): Promise<void>;
  burnEnabled(network: DemoWalletNetwork): boolean;
  burnDestinationRoutes?(network: DemoWalletNetwork): readonly BurnDestinationRoute[];
}

export const rlnProfile: WalletProfile = {
  protocol: 'RGB_LN',
  networkKey: 'utexo-demo-wallet-network-v1',
  connection: {
    storagePrefix: 'utexo-demo-wallet-webrgb-v2',
    name: 'UTEXO Demo Wallet',
    redirect: 'myapp://wallet',
  },
  describe: (network) => describeWalletConfiguration(buildDemoWalletConfig(network)),
  open: (network, stopped) => {
    if (stopped && stopped.protocol !== 'RGB_LN') throw new Error('Wallet profile mismatch');
    return openSavedWallet(buildDemoWalletConfig(network), stopped);
  },
  burnEnabled: (network) => !!buildDemoWalletConfig(network).unlockParams.ethRpcUrl,
};

export const rgbLibProfile: WalletProfile = {
  protocol: 'RGB_L1',
  networkKey: 'utexo-demo-wallet-network-v1-RGB_L1',
  connection: {
    storagePrefix: 'utexo-demo-wallet-webrgb-v2-RGB_L1',
    name: 'UTEXO Demo RGB Lib',
    redirect: 'myapp://rgb-lib',
  },
  describe: describeRgbLibConfiguration,
  open: (network, stopped) => {
    if (stopped && stopped.protocol !== 'RGB_L1') throw new Error('Wallet profile mismatch');
    return openSavedRgbLibWallet(network, stopped);
  },
  deleteSaved: deleteSavedRgbLibWallet,
  // The demo bridge routes cover utexo and regtest only.
  burnEnabled: (network) => network === 'utexo' || network === 'regtest',
  // Deployment routes shared with utexo-bridge-fe; never supplied by the dApp.
  burnDestinationRoutes: (network) => network === 'regtest'
    ? [{ chainId: 'eip155:31337', dstEid: 0 }]
    : [
        { chainId: 'eip155:42161', dstEid: 0 },
        { chainId: 'eip155:1', dstEid: 30101 },
        { chainId: 'eip155:137', dstEid: 30109 },
        { chainId: 'eip155:9745', dstEid: 30383 },
        { chainId: 'tron:728126428', dstEid: 30420 },
      ],
};
