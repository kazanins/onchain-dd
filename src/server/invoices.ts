import { pad, stringToHex } from 'viem'

export type InvoiceStatus = 'Unpaid' | 'Paid'

export type Invoice = {
  number: number
  id: string            // human-readable
  memoHex: `0x${string}` // bytes32 padded hex
  amountUsd: string
  status: InvoiceStatus
  paidTxHash?: `0x${string}`
  paidAmount?: string
  paidFrom?: `0x${string}`
}

function randomShortId() {
  return Math.random().toString(16).slice(2, 10)
}

export function makeInvoiceId(n: number) {
  return `INV-${String(n).padStart(4, '0')}-${randomShortId()}`
}

export function toMemoHex(invoiceId: string): `0x${string}` {
  // TIP-20 memo is bytes32; pad short strings to 32 bytes
  return pad(stringToHex(invoiceId), { size: 32 })
}

export function generateInvoices(count = 10): Invoice[] {
  return Array.from({ length: count }, (_, i) => {
    const number = i + 1
    const id = makeInvoiceId(number)
    const amountUsd = (Math.random() * 99.99 + 0.01).toFixed(2)
    return {
      number,
      id,
      memoHex: toMemoHex(id),
      amountUsd,
      status: 'Unpaid',
    }
  })
}
