import React from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './tempoWagmi'
import { App, autopayDebugRef } from './App'

const qc = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)

if (typeof window !== 'undefined') {
  ;(window as any).__debugAutopayToggle = (enabled: boolean) => {
    return autopayDebugRef.current?.(enabled)
  }
}
