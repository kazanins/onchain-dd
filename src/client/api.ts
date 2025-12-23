export async function getConfig() {
  const r = await fetch('/api/config')
  if (!r.ok) throw new Error('Failed to load config')
  return r.json() as Promise<{
    merchantAddress: `0x${string}`
    alphaUsd: `0x${string}`
    invoiceRegistryAddress: `0x${string}`
  }>
}
