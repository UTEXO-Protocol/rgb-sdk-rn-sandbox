import { WalletScreen } from '@/components/wallet-screen';
import { rgbLibWallet } from '@/utils/wallet';

export default function RgbLibTab() {
  return <WalletScreen wallet={rgbLibWallet} />;
}
