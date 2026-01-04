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
    rpcUrl: process.env.TEMPO_RPC_URL ?? '',
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
    { name: 'amount', type: 'uint256' },
    { name: 'memo', type: 'bytes32', indexed: true },
  ],
} as const

const transferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256' },
  ],
} as const

const mintEvent = {
  type: 'event',
  name: 'Mint',
  inputs: [
    { name: 'to', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256' },
  ],
} as const

const LOOKBACK_BLOCKS = 200000n
const REFRESH_LOOKBACK_BLOCKS = 5000n
const TRANSACTION_LOOKBACK_BLOCKS = 5000n
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_LOG_RANGE = 500n

type LogResult = Awaited<ReturnType<typeof client.getLogs>>

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

app.get('/api/invoices/refresh-status', async (req, res) => {
  try {
    const latestBlock = await client.getBlockNumber()
    const lookbackParam = req.query.lookback as string | undefined
    const lookback =
      lookbackParam && /^\d+$/.test(lookbackParam)
        ? BigInt(lookbackParam)
        : REFRESH_LOOKBACK_BLOCKS
    const maxLookback = lookback > 0n ? lookback : REFRESH_LOOKBACK_BLOCKS
    const cappedLookback = maxLookback > LOOKBACK_BLOCKS ? LOOKBACK_BLOCKS : maxLookback
    const fromBlock = latestBlock > cappedLookback ? latestBlock - cappedLookback : 0n

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

    const response = await fetch('https://tiny-faucet.up.railway.app/api/fund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address,
        token: 'AlphaUSD',
        amount: 5000,
      }),
    })
    const data = await response.json()
    if (!response.ok || data?.error) {
      const errorMessage =
        typeof data?.error === 'string' ? data.error : data?.error?.message
      return res.status(500).json({ error: errorMessage ?? 'Faucet request failed' })
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
    const lookbackParam = req.query.lookback as string | undefined
    const lookback =
      lookbackParam && /^\d+$/.test(lookbackParam)
        ? BigInt(lookbackParam)
        : TRANSACTION_LOOKBACK_BLOCKS
    const maxLookback = lookback > 0n ? lookback : TRANSACTION_LOOKBACK_BLOCKS
    const cappedLookback = maxLookback > LOOKBACK_BLOCKS ? LOOKBACK_BLOCKS : maxLookback
    const minBlock = latestBlock > cappedLookback ? latestBlock - cappedLookback : 0n
    const memoKeySet = new Set<string>()
    const memoLogByTx = new Map<string, {
      from: `0x${string}`
      to: `0x${string}`
      memo: `0x${string}` | null
      value: string
      txHash: `0x${string}`
      logIndex: string
      blockNumber: bigint
    }>()
    const transferLogByTx = new Map<string, {
      from: `0x${string}`
      to: `0x${string}`
      memo: `0x${string}` | null
      value: string
      txHash: `0x${string}`
      logIndex: string
      blockNumber: bigint
    }>()
    const mintLogByTx = new Map<string, {
      from: `0x${string}`
      to: `0x${string}`
      memo: `0x${string}` | null
      value: string
      txHash: `0x${string}`
      logIndex: string
      blockNumber: bigint
    }>()

    let endBlock = latestBlock
    while (endBlock >= minBlock) {
      const startBlock = endBlock > MAX_LOG_RANGE ? endBlock - MAX_LOG_RANGE : 0n
      const boundedStart = startBlock < minBlock ? minBlock : startBlock
      const [memoChunk, transferChunk, mintLogs] = await Promise.all([
        Promise.all([
          client.getLogs({
            address: ALPHA_USD,
            event: transferWithMemoEvent,
            args: { to: address },
            fromBlock: boundedStart,
            toBlock: endBlock,
          }),
          client.getLogs({
            address: ALPHA_USD,
            event: transferWithMemoEvent,
            args: { from: address },
            fromBlock: boundedStart,
            toBlock: endBlock,
          }),
        ]),
        Promise.all([
          client.getLogs({
            address: ALPHA_USD,
            event: transferEvent,
            args: { to: address },
            fromBlock: boundedStart,
            toBlock: endBlock,
          }),
          client.getLogs({
            address: ALPHA_USD,
            event: transferEvent,
            args: { from: address },
            fromBlock: boundedStart,
            toBlock: endBlock,
          }),
        ]),
        client.getLogs({
          address: ALPHA_USD,
          event: mintEvent,
          args: { to: address },
          fromBlock: boundedStart,
          toBlock: endBlock,
        }),
      ])

      const memoLogs = memoChunk.flat()
      const transferLogs = transferChunk.flat()

      for (const log of memoLogs) {
        const from = log.args?.from as `0x${string}` | undefined
        const to = log.args?.to as `0x${string}` | undefined
        const amount = (log.args?.amount ?? log.args?.value) as bigint | undefined
        const memo = log.args?.memo as `0x${string}` | undefined
        if (!from || !to || amount === undefined) continue
        const key = `${log.transactionHash}:${log.logIndex ?? 0n}`
        if (memoKeySet.has(key)) continue
        memoKeySet.add(key)
        const txHash = String(log.transactionHash)
        if (!memoLogByTx.has(txHash)) {
          memoLogByTx.set(txHash, {
            from,
            to,
            memo: memo ?? null,
            value: amount.toString(),
            txHash: log.transactionHash as `0x${string}`,
            logIndex: String(log.logIndex ?? 0n),
            blockNumber: log.blockNumber ?? 0n,
          })
        }
      }

      for (const log of transferLogs) {
        const from = log.args?.from as `0x${string}` | undefined
        const to = log.args?.to as `0x${string}` | undefined
        const amount = (log.args?.amount ?? log.args?.value) as bigint | undefined
        if (!from || !to || amount === undefined) continue
        if (from.toLowerCase() === ZERO_ADDRESS) continue
        const key = `${log.transactionHash}:${log.logIndex ?? 0n}`
        if (memoKeySet.has(key)) continue
        memoKeySet.add(key)
        const txHash = String(log.transactionHash)
        if (!transferLogByTx.has(txHash)) {
          transferLogByTx.set(txHash, {
            from,
            to,
            memo: null,
            value: amount.toString(),
            txHash: log.transactionHash as `0x${string}`,
            logIndex: String(log.logIndex ?? 0n),
            blockNumber: log.blockNumber ?? 0n,
          })
        }
      }

      for (const log of mintLogs) {
        const to = log.args?.to as `0x${string}` | undefined
        const amount = (log.args?.amount ?? log.args?.value) as bigint | undefined
        if (!to || amount === undefined) continue
        const key = `${log.transactionHash}:${log.logIndex ?? 0n}`
        if (memoKeySet.has(key)) continue
        memoKeySet.add(key)
        const txHash = String(log.transactionHash)
        if (!mintLogByTx.has(txHash)) {
          mintLogByTx.set(txHash, {
          from: ZERO_ADDRESS as `0x${string}`,
          to,
          memo: null,
          value: amount.toString(),
          txHash: log.transactionHash as `0x${string}`,
          logIndex: String(log.logIndex ?? 0n),
          blockNumber: log.blockNumber ?? 0n,
          })
        }
      }

      if (boundedStart === 0n || boundedStart === minBlock) break
      endBlock = boundedStart - 1n
    }

    const byTx = new Map<string, {
      from: `0x${string}`
      to: `0x${string}`
      memo: `0x${string}` | null
      value: string
      txHash: `0x${string}`
      logIndex: string
      blockNumber: bigint
    }>()

    for (const [txHash, transferLog] of transferLogByTx.entries()) {
      const memoLog = memoLogByTx.get(txHash)
      byTx.set(txHash, {
        ...transferLog,
        memo: memoLog?.memo ?? transferLog.memo,
      })
    }

    for (const [txHash, memoLog] of memoLogByTx.entries()) {
      if (byTx.has(txHash)) {
        const existing = byTx.get(txHash)
        if (existing) {
          const transferValue = BigInt(existing.value)
          const memoValue = BigInt(memoLog.value)
          if (transferValue < 10000n && memoValue >= 10000n) {
            byTx.set(txHash, memoLog)
          }
        }
        continue
      }
      byTx.set(txHash, memoLog)
    }

    for (const [txHash, mintLog] of mintLogByTx.entries()) {
      if (!byTx.has(txHash)) {
        byTx.set(txHash, mintLog)
      }
    }

    const sortedTransfers = Array.from(byTx.values())
      .sort((a, b) => Number(b.blockNumber - a.blockNumber))
      .map(({ blockNumber, ...rest }) => rest)

    res.json({ transfers: sortedTransfers })
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

// Health check for Railway
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' })
})

// SPA fallback (Express 5 + path-to-regexp v8 prefers regex over bare '*')
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'))
})

app.listen(port, () => {
  console.log(`http://localhost:${port}`)
  console.log(`Merchant receive address: ${merchantAddress}`)
})
