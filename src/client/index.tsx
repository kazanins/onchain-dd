import React from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWagmiConfig } from './tempoWagmi'
import { getConfig } from './api'
import { App, autopayDebugRef } from './App'

const qc = new QueryClient()
const root = createRoot(document.getElementById('root')!)

async function start() {
  let rpcUrl: string | undefined
  try {
    const config = await getConfig()
    rpcUrl = config.rpcUrl
  } catch (error) {
    console.warn('Failed to load config for RPC URL', error)
  }
  const wagmiConfig = createWagmiConfig(rpcUrl)
  root.render(
    <React.StrictMode>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={qc}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  )
}

start()

if (typeof window !== 'undefined') {
  ;(window as any).__debugAutopayToggle = (enabled: boolean) => {
    return autopayDebugRef.current?.(enabled)
  }
}
