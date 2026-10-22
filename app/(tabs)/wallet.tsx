import { WalletScreen } from '@/components/wallet-screen';
import { demoWallet } from '@/utils/wallet';

export default function WalletTab() {
  return <WalletScreen wallet={demoWallet} />;
}
