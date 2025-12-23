// src/server/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

import { client, ALPHA_USD } from './tempo.js'
import { broadcast, addClient, removeClient } from './sse.js'
import { generateInvoices, type Invoice } from './invoices.js'

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
  })
})

app.get('/api/invoices', (_req, res) => {
  res.json({ invoices })
})

app.post('/api/invoices/generate', (_req, res) => {
  invoices = generateInvoices(5)
  broadcast('invoices', { invoices })
  res.json({ invoices, merchantAddress })
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
