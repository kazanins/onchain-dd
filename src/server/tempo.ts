import { createPublicClient, http, defineChain } from 'viem'

export const tempoTestnet = defineChain({
  id: 0, // if you know Tempo testnet chainId, set it. For watchEvent + RPC it usually still works,
        // but best practice is to set the real id.
  name: 'Tempo Testnet',
  nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.TEMPO_RPC_URL ?? ''] },
    public: { http: [process.env.TEMPO_RPC_URL ?? ''] },
  },
})

export const client = createPublicClient({
  chain: tempoTestnet,
  transport: http(process.env.TEMPO_RPC_URL),
})

export const ALPHA_USD: `0x${string}` =
  '0x20c0000000000000000000000000000000000001'