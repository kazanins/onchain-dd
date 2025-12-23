// src/server/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWalletClient, http, parseUnits, pad, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo } from 'tempo.ts/chains'

import { client, ALPHA_USD } from './tempo.js'
import { broadcast, addClient, removeClient } from './sse.js'
import { makeInvoiceId, type Invoice } from './invoices.js'

const app = express()
app.use(cors())
app.use(express.json())

// Serve the UI
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
app.use(express.static(path.join(__dirname, '../../public')))

const port = Number(process.env.PORT ?? 3000)

// Merchant receive address (static; no private key needed)
const merchantAddress = process.env.MERCHANT_ADDRESS as `0x${string}` | undefined
if (!merchantAddress) {
  throw new Error('Set MERCHANT_ADDRESS in .env')
}
const invoiceRegistryAddress = process.env.INVOICE_REGISTRY_ADDRESS as `0x${string}` | undefined
if (!invoiceRegistryAddress) {
  throw new Error('Set INVOICE_REGISTRY_ADDRESS in .env')
}
const merchantPk = process.env.MERCHANT_PK as `0x${string}` | undefined
if (!merchantPk) {
  throw new Error('Set MERCHANT_PK in .env')
}

const merchantAccount = privateKeyToAccount(merchantPk)
const walletClient = createWalletClient({
  account: merchantAccount,
  chain: tempo({ feeToken: ALPHA_USD }),
  transport: http(process.env.TEMPO_RPC_URL),
})

// In-memory invoice store (swap for DB later)
let invoices: Invoice[] = []

function invoiceByMemoHex(memoHex: string) {
  const key = memoHex.toLowerCase()
  return invoices.find((inv) => inv.memoHex.toLowerCase() === key)
}

// --- API

app.get('/api/config', (_req, res) => {
  res.json({
    merchantAddress,
    alphaUsd: ALPHA_USD,
    invoiceRegistryAddress,
  })
})

app.get('/api/invoices', (_req, res) => {
  res.json({ invoices })
})

app.post('/api/invoices/generate', (_req, res) => {
  res.status(400).json({ error: 'Use POST /api/invoices/create with a payee.' })
})

const invoiceRegistryAbi = [
  {
    type: 'function',
    name: 'nextInvoiceNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'createInvoice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'currency', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'dueDate', type: 'uint256' },
      { name: 'invoiceId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

app.post('/api/invoices/create', async (req, res) => {
  try {
    const payee = req.body?.payee as `0x${string}` | undefined
    if (!payee) return res.status(400).json({ error: 'Missing payee address' })

    const nextNumber = await client.readContract({
      address: invoiceRegistryAddress,
      abi: invoiceRegistryAbi,
      functionName: 'nextInvoiceNumber',
    })
    const invoiceId = makeInvoiceId(nextNumber)
    const amount = (Math.random() * 99.99 + 0.01).toFixed(2)
    const amountUnits = parseUnits(amount, 6)
    const dueInDays = Math.floor(Math.random() * 7) + 1
    const dueDate = BigInt(Math.floor(Date.now() / 1000) + dueInDays * 24 * 60 * 60)
    const invoiceIdBytes = pad(stringToHex(invoiceId), { size: 32 })

    const hash = await walletClient.writeContract({
      address: invoiceRegistryAddress,
      abi: invoiceRegistryAbi,
      functionName: 'createInvoice',
      args: [payee, ALPHA_USD, amountUnits, dueDate, invoiceIdBytes],
      feeToken: ALPHA_USD,
    } as never)

    res.json({
      hash,
      invoiceId,
      amount,
      dueDate: dueDate.toString(),
      number: nextNumber.toString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create invoice'
    res.status(500).json({ error: message })
  }
})

app.get('/api/events', (req, res) => {
  // Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const id = addClient(res)

  // initial push
  res.write(`event: invoices\ndata: ${JSON.stringify({ invoices })}\n\n`)

  req.on('close', () => removeClient(id))
})

// SPA fallback (Express 5 + path-to-regexp v8 prefers regex over bare '*')
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'))
})

// --- Chain listener: TIP-20 TransferWithMemo -> mark invoice Paid
function startInvoiceWatcher() {
  const merchant = merchantAddress
  if (!merchant) return
  return client.watchEvent({
    address: ALPHA_USD,
    event: {
      type: 'event',
      name: 'TransferWithMemo',
      inputs: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256' },
        { name: 'memo', type: 'bytes32', indexed: true },
      ],
    },
    onLogs: (logs) => {
      for (const log of logs) {
        // Only consider payments to our merchant address
        if ((log.args.to as string)?.toLowerCase() !== merchant.toLowerCase()) continue

        const memo = log.args.memo as `0x${string}`
        const inv = invoiceByMemoHex(memo)
        if (!inv) continue
        if (inv.status === 'Paid') continue

        inv.status = 'Paid'
        inv.paidTxHash = log.transactionHash as `0x${string}`
        inv.paidFrom = log.args.from as `0x${string}`
        inv.paidAmount = String(log.args.value)

        broadcast('invoicePaid', { invoice: inv })
        broadcast('invoices', { invoices })
      }
    },
  })
}

app.listen(port, () => {
  console.log(`http://localhost:${port}`)
  console.log(`Merchant receive address: ${merchantAddress}`)
  startInvoiceWatcher()
})
