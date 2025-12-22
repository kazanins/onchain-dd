export type Invoice = {
  number: number
  id: string
  memoHex: `0x${string}`
  amountUsd: string
  status: 'Unpaid' | 'Paid'
  paidTxHash?: `0x${string}`
  paidFrom?: `0x${string}`
  paidAmount?: string
}

export async function getConfig() {
  const r = await fetch('/api/config')
  if (!r.ok) throw new Error('Failed to load config')
  return r.json() as Promise<{ merchantAddress: `0x${string}`; alphaUsd: `0x${string}` }>
}

export async function generate5Invoices() {
  const r = await fetch('/api/invoices/generate', { method: 'POST' })
  if (!r.ok) throw new Error('Failed to generate invoices')
  return r.json() as Promise<{ invoices: Invoice[]; merchantAddress: `0x${string}` }>
}

export async function getInvoices() {
  const r = await fetch('/api/invoices')
  if (!r.ok) throw new Error('Failed to load invoices')
  return r.json() as Promise<{ invoices: Invoice[] }>
}
