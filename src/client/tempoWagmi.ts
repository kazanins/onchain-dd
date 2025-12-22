import { createConfig, http } from 'wagmi'
import { tempo } from 'tempo.ts/chains'
import { KeyManager, webAuthn } from 'tempo.ts/wagmi'

// AlphaUSD as feeToken (matches Tempo docs examples) :contentReference[oaicite:8]{index=8}
export const wagmiConfig = createConfig({
  chains: [tempo({ feeToken: '0x20c0000000000000000000000000000000000001' })],
  connectors: [
    webAuthn({
      keyManager: KeyManager.localStorage(),
    }),
  ],
  multiInjectedProviderDiscovery: false,
  transports: {
    [tempo.id]: http(),
  },
})