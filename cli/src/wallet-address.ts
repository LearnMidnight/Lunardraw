/**
 * A wallet's two public addresses, worked out from its seed without
 * connecting to anything:
 * - `mn_addr_...`, where NIGHT is sent (the operator fee, a top-up);
 * - `mn_dust_...`, its DUST address. A NIGHT holder can designate it as where
 *   its NIGHT's DUST generation goes, so another wallet (a treasury) can fuel
 *   this one's fees without sending it NIGHT.
 * Both are public.
 */
import { DustSecretKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { WalletSeeds } from '@midnight-ntwrk/testkit-js';
import { DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { walletAddressOf } from '@nightcast/deploy';

export const walletAddressesOf = (network: 'preprod' | 'preview', seed: string): { night: string; dust: string } => {
  const dust = DustSecretKey.fromSeed(WalletSeeds.fromMasterSeed(seed).dust);
  return { night: walletAddressOf(network, seed), dust: DustAddress.encodePublicKey(network, dust.publicKey) };
};
