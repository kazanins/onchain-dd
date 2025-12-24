// src/server/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWalletClient, http, parseEventLogs, parseUnits, pad, stringToHex } from 'viem'
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
    name: 'getInvoice',
    stateMutability: 'view',
    inputs: [{ name: 'number', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'number', type: 'uint256' },
          { name: 'invoiceId', type: 'bytes32' },
          { name: 'payee', type: 'address' },
          { name: 'currency', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'dueDate', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'paidTxHash', type: 'bytes32' },
        ],
      },
    ],
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
  {
    type: 'function',
    name: 'markPaid',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'number', type: 'uint256' },
      { name: 'txHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

const transferWithMemoEvent = {
  type: 'event',
  name: 'TransferWithMemo',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256' },
    { name: 'memo', type: 'bytes32', indexed: true },
  ],
} as const

const LOOKBACK_BLOCKS = 20000n

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

app.post('/api/invoices/mark-paid', async (req, res) => {
  try {
    const number = req.body?.number as string | undefined
    const txHash = req.body?.txHash as `0x${string}` | undefined
    if (!number) return res.status(400).json({ error: 'Missing invoice number' })
    if (!txHash) return res.status(400).json({ error: 'Missing txHash' })
    const invoiceNumber = BigInt(number)

    const invoice = (await client.readContract({
      address: invoiceRegistryAddress,
      abi: invoiceRegistryAbi,
      functionName: 'getInvoice',
      args: [invoiceNumber],
    } as never)) as {
      invoiceId: `0x${string}`
      payee: `0x${string}`
      status: number
      paidTxHash: `0x${string}`
    }
    const invoiceId = invoice.invoiceId
    const payee = invoice.payee
    const status = Number(invoice.status)
    if (status !== 0) return res.json({ status: 'already-paid' })

    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return res.status(400).json({ error: 'Transaction not successful' })
    }

    const logs = parseEventLogs({
      abi: [transferWithMemoEvent],
      logs: receipt.logs,
    })

    const matching = logs.find((log) => {
      const args = log.args as {
        from: `0x${string}`
        to: `0x${string}`
        memo: `0x${string}`
      }
      return (
        log.address?.toLowerCase() === ALPHA_USD.toLowerCase() &&
        args.from.toLowerCase() === payee.toLowerCase() &&
        args.to.toLowerCase() === merchantAddress.toLowerCase() &&
        args.memo.toLowerCase() === invoiceId.toLowerCase()
      )
    })

    if (!matching) {
      return res.status(400).json({ error: 'No matching TransferWithMemo found' })
    }

    const hash = await walletClient.writeContract({
      address: invoiceRegistryAddress,
      abi: invoiceRegistryAbi,
      functionName: 'markPaid',
      args: [invoiceNumber, txHash],
      feeToken: ALPHA_USD,
    } as never)

    await client.waitForTransactionReceipt({ hash })
    res.json({ hash })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to mark invoice paid'
    res.status(500).json({ error: message })
  }
})

app.get('/api/invoices/refresh-status', async (_req, res) => {
  try {
    const latestBlock = await client.getBlockNumber()
    const fromBlock = latestBlock > LOOKBACK_BLOCKS ? latestBlock - LOOKBACK_BLOCKS : 0n

    const logs = await client.getLogs({
      address: ALPHA_USD,
      event: transferWithMemoEvent,
      fromBlock,
      toBlock: latestBlock,
    })

    const memoIndex = new Map<string, `0x${string}`>()
    for (const log of logs) {
      const from = (log.args?.from as `0x${string}` | undefined) ?? null
      const memo = (log.args?.memo as `0x${string}` | undefined) ?? null
      const to = (log.args?.to as `0x${string}` | undefined) ?? null
      if (!from || !memo || !to) continue
      if (to.toLowerCase() !== merchantAddress.toLowerCase()) continue
      memoIndex.set(`${from.toLowerCase()}:${memo.toLowerCase()}`, log.transactionHash)
    }

    const nextNumber = (await client.readContract({
      address: invoiceRegistryAddress,
      abi: invoiceRegistryAbi,
      functionName: 'nextInvoiceNumber',
    } as never)) as bigint

    let marked = 0
    for (let number = 1n; number < nextNumber; number++) {
      const invoice = (await client.readContract({
        address: invoiceRegistryAddress,
        abi: invoiceRegistryAbi,
        functionName: 'getInvoice',
        args: [number],
      } as never)) as {
        invoiceId: `0x${string}`
        payee: `0x${string}`
        status: number
        paidTxHash: `0x${string}`
      }

      if (invoice.status !== 0) continue
      const key = `${invoice.payee.toLowerCase()}:${invoice.invoiceId.toLowerCase()}`
      const txHash = memoIndex.get(key)
      if (!txHash) continue

      const hash = await walletClient.writeContract({
        address: invoiceRegistryAddress,
        abi: invoiceRegistryAbi,
        functionName: 'markPaid',
        args: [number, txHash],
        feeToken: ALPHA_USD,
      } as never)
      await client.waitForTransactionReceipt({ hash })
      marked++
    }

    res.json({ marked })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cron failed'
    res.status(500).json({ error: message })
  }
})

app.post('/api/faucet', async (req, res) => {
  try {
    const address = req.body?.address as `0x${string}` | undefined
    if (!address) return res.status(400).json({ error: 'Missing address' })

    const response = await fetch('https://rpc.testnet.tempo.xyz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tempo_fundAddress',
        params: [address],
      }),
    })
    const data = await response.json()
    if (!response.ok || data?.error) {
      return res.status(500).json({ error: data?.error?.message ?? 'Faucet request failed' })
    }
    res.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Faucet request failed'
    res.status(500).json({ error: message })
  }
})

app.get('/api/transactions', async (req, res) => {
  try {
    const address = req.query.address as `0x${string}` | undefined
    if (!address) return res.status(400).json({ error: 'Missing address' })

    const latestBlock = await client.getBlockNumber()
    const fromBlock = latestBlock > LOOKBACK_BLOCKS ? latestBlock - LOOKBACK_BLOCKS : 0n

    const logs = await client.getLogs({
      address: ALPHA_USD,
      event: transferWithMemoEvent,
      fromBlock,
      toBlock: latestBlock,
    })

    const normalized = address.toLowerCase()
    const transfers = logs
      .filter((log) => {
        const from = log.args?.from as `0x${string}` | undefined
        const to = log.args?.to as `0x${string}` | undefined
        if (!from || !to) return false
        return from.toLowerCase() === normalized || to.toLowerCase() === normalized
      })
      .sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)))
      .slice(0, 3)
      .map((log) => ({
        from: log.args?.from as `0x${string}`,
        to: log.args?.to as `0x${string}`,
        memo: log.args?.memo as `0x${string}`,
        value: (log.args?.value as bigint).toString(),
        txHash: log.transactionHash as `0x${string}`,
      }))

    res.json({ transfers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load transactions'
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
