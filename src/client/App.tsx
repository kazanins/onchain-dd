import React from 'react'
import { useConnection, useConnect, useConnectors, useDisconnect, usePublicClient, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWalletClient } from 'wagmi'
import { Hooks } from 'tempo.ts/wagmi'
import { Abis, Actions, Account, WebCryptoP256 } from 'tempo.ts/viem'
import { formatUnits, getAddress, hexToString, parseUnits, pad, stringToHex, createWalletClient, http } from 'viem'
import { tempo } from 'tempo.ts/chains'
import { Address } from 'ox'
import { createStore, del, get, set } from 'idb-keyval'
import { getConfig } from './api'
import { invoiceRegistryAbi } from './invoiceRegistryAbi'

function TouchIdIcon() {
  return (
    <img className="touchid-image" src="/assets/touchid.svg" alt="Touch ID" />
  )
}

type OnchainInvoice = {
  number: bigint
  invoiceId: `0x${string}`
  payee: `0x${string}`
  currency: `0x${string}`
  amount: bigint
  dueDate: bigint
  status: number
  paidTxHash: `0x${string}`
}

type TransferItem = {
  direction: 'incoming' | 'outgoing'
  memo: string
  amount: string
  txHash: `0x${string}`
  logIndex: string
}

type StoredAccessKey = {
  keyPair: Awaited<ReturnType<typeof WebCryptoP256.createKeyPair>>
  keyId: `0x${string}`
  expiry: bigint
}

const accessKeyStore = createStore('tempo-invoices', 'access-keys')
const accountKeychainAddress = getAddress('0xAAAAAAAA00000000000000000000000000000000')
const accessKeySignatureType = 1

export const autopayDebugRef: {
  current: null | ((enabled: boolean) => void)
} = { current: null }

function decodeInvoiceId(invoiceId?: `0x${string}` | null) {
  if (!invoiceId || invoiceId === '0x') return ''
  return hexToString(invoiceId).replace(/\u0000/g, '')
}

function formatInvoiceAmount(amount: bigint) {
  const value = Number(formatUnits(amount, 6))
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function formatDueDate(dueDate: bigint) {
  return new Date(Number(dueDate) * 1000).toLocaleDateString()
}

export function App() {
  const [merchantAddress, setMerchantAddress] = React.useState<`0x${string}` | undefined>()
  const [invoiceRegistryAddress, setInvoiceRegistryAddress] = React.useState<`0x${string}` | undefined>()
  const account = useConnection()
  const connect = useConnect()
  const [connector] = useConnectors()
  const disconnect = useDisconnect()
  const walletClient = useWalletClient()
  const publicClient = usePublicClient()
  const [paymentNotice, setPaymentNotice] = React.useState<string | null>(null)
  const paymentTimerRef = React.useRef<number | null>(null)
  const [fundingNotice, setFundingNotice] = React.useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const fundingTimerRef = React.useRef<number | null>(null)
  const [autopayNotice, setAutopayNotice] = React.useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const autopayNoticeTimerRef = React.useRef<number | null>(null)
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const copyTimerRef = React.useRef<number | null>(null)
  const alphaUsdToken = '0x20c0000000000000000000000000000000000001' as const
  const explorerBaseUrl = 'https://explorer.tempo.xyz'
  const balanceQuery = Hooks.token.useGetBalance({
    account: account.address,
    token: alphaUsdToken,
  })
  const balancePollRef = React.useRef<number | null>(null)
  const sendPayment = Hooks.token.useTransferSync()
  const lastTxRef = React.useRef<string | null>(null)
  const [createTxHash, setCreateTxHash] = React.useState<`0x${string}` | null>(null)
  const [isCreatingInvoice, setIsCreatingInvoice] = React.useState(false)
  const [isRefreshingMobile, setIsRefreshingMobile] = React.useState(false)
  const [isRefreshingMerchant, setIsRefreshingMerchant] = React.useState(false)
  const [isAutopayEnabled, setIsAutopayEnabled] = React.useState(false)
  const [isAutopayBusy, setIsAutopayBusy] = React.useState(false)
  const [transactions, setTransactions] = React.useState<TransferItem[]>([])
  const signupRequestedRef = React.useRef(false)
  const autopayInFlightRef = React.useRef<Set<string>>(new Set())
  const autopayScheduleTimerRef = React.useRef<number | null>(null)
  const nextInvoiceNumberRef = React.useRef<bigint | null>(null)
  const [isAwaitingInvoice, setIsAwaitingInvoice] = React.useState(false)
  const [processingInvoices, setProcessingInvoices] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    return () => {
      if (balancePollRef.current) {
        window.clearTimeout(balancePollRef.current)
        balancePollRef.current = null
      }
      if (fundingTimerRef.current) {
        window.clearTimeout(fundingTimerRef.current)
        fundingTimerRef.current = null
      }
      if (autopayNoticeTimerRef.current) {
        window.clearTimeout(autopayNoticeTimerRef.current)
        autopayNoticeTimerRef.current = null
      }
      if (autopayScheduleTimerRef.current) {
        window.clearTimeout(autopayScheduleTimerRef.current)
        autopayScheduleTimerRef.current = null
      }
    }
  }, [])

  const handleCopyId = React.useCallback((id: string) => {
    navigator.clipboard?.writeText(id)
    setCopiedId(id)
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId(null)
      copyTimerRef.current = null
    }, 1400)
  }, [])

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
      if (paymentTimerRef.current) window.clearTimeout(paymentTimerRef.current)
    }
  }, [])

  const handlePaymentSuccess = React.useCallback((txHash: string) => {
    setPaymentNotice(txHash)
    balanceQuery.refetch()
    if (paymentTimerRef.current) window.clearTimeout(paymentTimerRef.current)
    paymentTimerRef.current = window.setTimeout(() => {
      setPaymentNotice(null)
      paymentTimerRef.current = null
    }, 6000)
  }, [balanceQuery])

  const handlePayInvoice = React.useCallback((inv: OnchainInvoice) => {
    if (!merchantAddress) return
    setProcessingInvoices((prev) => {
      const next = new Set(prev)
      next.add(String(inv.number))
      return next
    })
    sendPayment.mutate({
      amount: inv.amount,
      to: merchantAddress,
      token: alphaUsdToken,
      feeToken: alphaUsdToken,
      memo: inv.invoiceId,
    })
  }, [alphaUsdToken, merchantAddress, sendPayment])

  const handleAutopayToggle = React.useCallback(async (enabled: boolean) => {
    if (!account.address || !walletClient.data || !publicClient) {
      setAutopayNotice({
        kind: 'error',
        message: 'Wallet not ready. Please sign in again.',
      })
      return
    }
    setIsAutopayBusy(true)
    setIsAutopayEnabled(enabled)
    setAutopayNotice({ kind: 'success', message: 'Requesting passkey…' })
    try {
      const keyStorageKey = `autopay:${account.address.toLowerCase()}`
      if (enabled) {
        const keyPair = await WebCryptoP256.createKeyPair()
        const keyId = Address.fromPublicKey(keyPair.publicKey)
        const expirySeconds = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60)

        const txHash = await walletClient.data.writeContract({
          address: accountKeychainAddress,
          abi: Abis.accountKeychain,
          functionName: 'authorizeKey',
          args: [keyId, accessKeySignatureType, expirySeconds, false, []],
          feeToken: alphaUsdToken,
        } as never)
        await publicClient.waitForTransactionReceipt({ hash: txHash })

        const stored: StoredAccessKey = {
          keyPair,
          keyId,
          expiry: expirySeconds,
        }
        await set(keyStorageKey, stored, accessKeyStore)
        setAutopayNotice({ kind: 'success', message: 'Autopay enabled.' })
      } else {
        const stored = await get<StoredAccessKey>(keyStorageKey, accessKeyStore)
        if (stored?.keyId) {
          const txHash = await walletClient.data.writeContract({
            address: accountKeychainAddress,
            abi: Abis.accountKeychain,
            functionName: 'revokeKey',
            args: [stored.keyId],
            feeToken: alphaUsdToken,
          } as never)
          await publicClient.waitForTransactionReceipt({ hash: txHash })
          await del(keyStorageKey, accessKeyStore)
        }
        setAutopayNotice({ kind: 'success', message: 'Autopay disabled.' })
      }
    } catch (error) {
      console.error('Autopay toggle failed', error)
      setIsAutopayEnabled(!enabled)
      setAutopayNotice({
        kind: 'error',
        message: 'Autopay action failed. Check the console for details.',
      })
    } finally {
      setIsAutopayBusy(false)
      if (autopayNoticeTimerRef.current) window.clearTimeout(autopayNoticeTimerRef.current)
      autopayNoticeTimerRef.current = window.setTimeout(() => {
        setAutopayNotice(null)
        autopayNoticeTimerRef.current = null
      }, 3000)
    }
  }, [account.address, alphaUsdToken, publicClient, walletClient.data])

  const invoiceNumbersQuery = useReadContract({
    address: invoiceRegistryAddress,
    abi: invoiceRegistryAbi,
    functionName: 'getInvoicesByPayee',
    args: account.address ? [account.address] : undefined,
    query: { enabled: Boolean(invoiceRegistryAddress && account.address) },
  })

  const invoiceNumbers = (invoiceNumbersQuery.data ?? []) as bigint[]
  const invoiceContracts = invoiceRegistryAddress
    ? invoiceNumbers.map((number) => ({
        address: invoiceRegistryAddress,
        abi: invoiceRegistryAbi,
        functionName: 'getInvoice' as const,
        args: [number] as const,
      }))
    : []

  const invoicesQuery = useReadContracts({
    contracts: invoiceContracts,
    query: { enabled: invoiceContracts.length > 0 },
  })

  const refreshTransactions = React.useCallback(async () => {
    if (!account.address) return
    const response = await fetch(`/api/transactions?address=${account.address}&lookback=5000`)
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data?.error ?? 'Failed to load transactions')
    }
    const next = (data.transfers ?? []).flatMap((tx: {
      from: `0x${string}`
      to: `0x${string}`
      memo: `0x${string}` | null
      value: string
      txHash: `0x${string}`
      logIndex?: string
    }) => {
      const rawValue = BigInt(tx.value)
      const isIncoming = tx.to?.toLowerCase() === account.address?.toLowerCase()
      const amountValue = Number(formatUnits(rawValue, 6))
      if (!Number.isFinite(amountValue) || amountValue <= 0) return []
      const isFee = !isIncoming && amountValue < 0.01
      if (amountValue < 0.01 && !isFee) return []
      const amount = isFee
        ? '<0.01'
        : amountValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
      const memo = isFee ? 'Fees' : decodeInvoiceId(tx.memo)
      return [{
        direction: isIncoming ? 'incoming' : 'outgoing',
        memo: memo || (isIncoming ? 'Incoming payment' : 'Outgoing payment'),
        amount,
        txHash: tx.txHash,
        logIndex: tx.logIndex ?? '0',
      }]
    })
    setTransactions(next)
  }, [account.address])

  const refreshBalanceAfterFaucet = React.useCallback(() => {
    const startingBalance = balanceQuery.data ?? 0n
    const maxAttempts = 20
    const delayMs = 2000
    let attempts = 0

    if (balancePollRef.current) {
      window.clearTimeout(balancePollRef.current)
      balancePollRef.current = null
    }

    const poll = async () => {
      attempts += 1
      const result = await balanceQuery.refetch()
      const nextBalance = result.data ?? startingBalance
      if (nextBalance > startingBalance || attempts >= maxAttempts) {
        if (nextBalance > startingBalance) {
          refreshTransactions().catch(() => undefined)
        }
        balancePollRef.current = null
        return
      }
      balancePollRef.current = window.setTimeout(poll, delayMs)
    }

    void poll()
  }, [balanceQuery, refreshTransactions])

  const refreshMobileInvoices = React.useCallback(async () => {
    if (!account.address) return
    setIsRefreshingMobile(true)
    try {
      await Promise.allSettled([
        invoiceNumbersQuery.refetch(),
        invoicesQuery.refetch(),
        refreshTransactions(),
      ])
    } finally {
      window.setTimeout(() => setIsRefreshingMobile(false), 400)
    }
  }, [account.address, invoiceNumbersQuery, invoicesQuery, refreshTransactions])

  const refreshMerchantInvoices = React.useCallback(async () => {
    setIsRefreshingMerchant(true)
    try {
      await fetch('/api/invoices/refresh-status?lookback=5000')
    } finally {
      window.setTimeout(() => setIsRefreshingMerchant(false), 400)
    }
    await refreshMobileInvoices()
  }, [refreshMobileInvoices])

  const runAutopay = React.useCallback(async (inv: OnchainInvoice) => {
    if (!account.address || !merchantAddress) return
    setProcessingInvoices((prev) => {
      const next = new Set(prev)
      next.add(String(inv.number))
      return next
    })
    const keyStorageKey = `autopay:${account.address.toLowerCase()}`
    const stored = await get<StoredAccessKey>(keyStorageKey, accessKeyStore)
    if (!stored) {
      setAutopayNotice({
        kind: 'error',
        message: 'Autopay key missing. Toggle Autopay again.',
      })
      setIsAutopayEnabled(false)
      setProcessingInvoices((prev) => {
        const next = new Set(prev)
        next.delete(String(inv.number))
        return next
      })
      return
    }

    const accessAccount = Account.fromWebCryptoP256(stored.keyPair, { access: account.address })
    const client = createWalletClient({
      chain: tempo({ feeToken: alphaUsdToken }),
      transport: http(),
      account: accessAccount,
    })

    const result = await Actions.token.transferSync(client, {
      amount: inv.amount,
      to: merchantAddress,
      token: alphaUsdToken,
      memo: inv.invoiceId,
      feeToken: alphaUsdToken,
    })

    handlePaymentSuccess(result.receipt.transactionHash)
    await refreshMerchantInvoices()
    await refreshMobileInvoices()
  }, [account.address, alphaUsdToken, handlePaymentSuccess, merchantAddress, refreshMerchantInvoices, refreshMobileInvoices])

  React.useEffect(() => {
    if (!account.address) {
      setTransactions([])
      return
    }
    refreshTransactions()
  }, [account.address, refreshTransactions])

  React.useEffect(() => {
    const tx = sendPayment.data?.receipt?.transactionHash
    if (tx && tx !== lastTxRef.current) {
      lastTxRef.current = tx
      handlePaymentSuccess(String(tx))
      void (async () => {
        await refreshMerchantInvoices()
        window.setTimeout(() => {
          refreshMerchantInvoices()
        }, 1200)
      })()
    }
  }, [
    handlePaymentSuccess,
    refreshMerchantInvoices,
    sendPayment.data?.receipt?.transactionHash,
  ])

  const onchainInvoices = React.useMemo(() => {
    return (invoicesQuery.data ?? [])
      .flatMap((entry) => {
        if (entry.status !== 'success' || !entry.result) return []
        const result = entry.result as unknown as {
          number: bigint
          invoiceId: `0x${string}`
          payee: `0x${string}`
          currency: `0x${string}`
          amount: bigint
          dueDate: bigint
          status: number
          paidTxHash: `0x${string}`
        }
        const { number, invoiceId, payee, currency, amount, dueDate, status, paidTxHash } = result
        return [{ number, invoiceId, payee, currency, amount, dueDate, status, paidTxHash }]
      })
      .sort((a, b) => Number(a.number - b.number))
  }, [invoicesQuery.data])

  const openInvoices = React.useMemo(() => {
    return onchainInvoices.filter((inv) => inv.status === 0)
  }, [onchainInvoices])

  React.useEffect(() => {
    setProcessingInvoices((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(prev)
      onchainInvoices.forEach((inv) => {
        if (inv.status !== 0) next.delete(String(inv.number))
      })
      return next
    })
  }, [onchainInvoices])

  React.useEffect(() => {
    if (!isAutopayEnabled && autopayScheduleTimerRef.current) {
      window.clearTimeout(autopayScheduleTimerRef.current)
      autopayScheduleTimerRef.current = null
    }
  }, [isAutopayEnabled])

  React.useEffect(() => {
    if (!isAutopayEnabled || isAutopayBusy) return
    if (!account.address || !merchantAddress) return
    const pending = openInvoices.find((inv) => !autopayInFlightRef.current.has(String(inv.number)))
    if (!pending) return

    autopayInFlightRef.current.add(String(pending.number))
    setAutopayNotice({ kind: 'success', message: 'Autopay scheduled…' })
    if (autopayNoticeTimerRef.current) window.clearTimeout(autopayNoticeTimerRef.current)
    autopayNoticeTimerRef.current = window.setTimeout(() => {
      setAutopayNotice(null)
      autopayNoticeTimerRef.current = null
    }, 3000)

    if (autopayScheduleTimerRef.current) window.clearTimeout(autopayScheduleTimerRef.current)
    autopayScheduleTimerRef.current = window.setTimeout(() => {
      runAutopay(pending)
        .catch((error) => {
          console.error('Autopay failed', error)
          setAutopayNotice({ kind: 'error', message: 'Autopay failed.' })
          setProcessingInvoices((prev) => {
            const next = new Set(prev)
            next.delete(String(pending.number))
            return next
          })
        })
        .finally(() => {
          autopayInFlightRef.current.delete(String(pending.number))
          autopayScheduleTimerRef.current = null
        })
    }, 3500)
  }, [account.address, isAutopayBusy, isAutopayEnabled, merchantAddress, openInvoices, runAutopay])

  const createReceipt = useWaitForTransactionReceipt({
    hash: createTxHash ?? undefined,
    query: { enabled: Boolean(createTxHash) },
  })

  React.useEffect(() => {
    if (createReceipt.isSuccess) {
      window.setTimeout(() => {
        refreshMerchantInvoices()
        refreshMobileInvoices()
      }, 600)
    }
  }, [createReceipt.isSuccess, refreshMerchantInvoices, refreshMobileInvoices])

  React.useEffect(() => {
    if (createReceipt.isSuccess) {
      setCreateTxHash(null)
    }
  }, [createReceipt.isSuccess])

  React.useEffect(() => {
    if (!createReceipt.isSuccess) return
    setIsAwaitingInvoice(true)
  }, [createReceipt.isSuccess])

  React.useEffect(() => {
    if (!isAwaitingInvoice) return
    const target = nextInvoiceNumberRef.current
    if (target === null) return
    const created = onchainInvoices.some((inv) => inv.number === target)
    if (created) {
      setIsAwaitingInvoice(false)
      nextInvoiceNumberRef.current = null
    }
  }, [isAwaitingInvoice, onchainInvoices])


  const handleGenerateInvoice = React.useCallback(async () => {
    if (!account.address) return
    setIsCreatingInvoice(true)
    setIsAwaitingInvoice(true)
    try {
      const r = await fetch('/api/invoices/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: account.address }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error ?? 'Failed to create invoice')
      setCreateTxHash(data.hash as `0x${string}`)
      if (data?.number) {
        nextInvoiceNumberRef.current = BigInt(data.number)
      }
    } catch (err) {
      console.error(err)
      setIsAwaitingInvoice(false)
      nextInvoiceNumberRef.current = null
    } finally {
      setIsCreatingInvoice(false)
    }
  }, [account.address])

  React.useEffect(() => {
    getConfig()
      .then((c) => {
        setMerchantAddress(c.merchantAddress)
        setInvoiceRegistryAddress(c.invoiceRegistryAddress)
      })
      .catch(console.error)
  }, [])

  React.useEffect(() => {
    if (!account.address) {
      setIsAutopayEnabled(false)
      return
    }
    get<StoredAccessKey>(`autopay:${account.address.toLowerCase()}`, accessKeyStore)
      .then((stored: StoredAccessKey | null) => setIsAutopayEnabled(Boolean(stored)))
      .catch(() => setIsAutopayEnabled(false))
  }, [account.address])
  React.useEffect(() => {
    autopayDebugRef.current = handleAutopayToggle
    return () => {
      autopayDebugRef.current = null
    }
  }, [handleAutopayToggle])

  React.useEffect(() => {
    if (!account.address || !signupRequestedRef.current) return
    signupRequestedRef.current = false
    fetch('/api/faucet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account.address }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error?.message ?? 'Faucet request failed')
        refreshBalanceAfterFaucet()
        setFundingNotice({ kind: 'success', message: 'Requesting faucet funding…' })
        if (fundingTimerRef.current) window.clearTimeout(fundingTimerRef.current)
        fundingTimerRef.current = window.setTimeout(() => {
          setFundingNotice(null)
          fundingTimerRef.current = null
        }, 3000)
      })
      .catch((err) => {
        console.error('Auto-fund failed', err)
        setFundingNotice({ kind: 'error', message: 'Funding failed. Please try again later.' })
        if (fundingTimerRef.current) window.clearTimeout(fundingTimerRef.current)
        fundingTimerRef.current = window.setTimeout(() => {
          setFundingNotice(null)
          fundingTimerRef.current = null
        }, 3000)
      })
  }, [account.address, refreshBalanceAfterFaucet])

  const formattedBalance = React.useMemo(() => {
    const raw = Number(formatUnits(balanceQuery.data ?? 0n, 6))
    return Number.isFinite(raw)
      ? Math.round(raw).toLocaleString('en-US')
      : '0'
  }, [balanceQuery.data])

  return (
    <div className="wrap">
      {/* LEFT */}
      <div className="pane">
        <div className="phone-shell">
          <div className="phone-screen">
            {paymentNotice || fundingNotice || autopayNotice ? (
              <div className="notice-stack">
                {paymentNotice ? (
                  <div className="notice">
                    Payment sent:{' '}
                    <a
                      href={`https://explorer.tempo.xyz/tx/${paymentNotice}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {paymentNotice.slice(0, 10)}…
                    </a>
                  </div>
                ) : null}
                {fundingNotice ? (
                  <div className={fundingNotice.kind === 'error' ? 'notice notice-error' : 'notice'}>
                    {fundingNotice.message}
                  </div>
                ) : null}
                {autopayNotice ? (
                  <div className={autopayNotice.kind === 'error' ? 'notice notice-error' : 'notice'}>
                    {autopayNotice.message}
                  </div>
                ) : null}
              </div>
            ) : null}
            {!account.address ? (
              <div className="auth-screen">
                <TouchIdIcon />
                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setIsAutopayEnabled(false)
                      signupRequestedRef.current = false
                      connect.connect({ connector })
                    }}
                  >
                    Sign in
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() =>
                    {
                      signupRequestedRef.current = true
                      connect.connect({
                        connector,
                        capabilities: { type: 'sign-up' },
                      } as never)
                    }
                    }
                  >
                    Sign up
                  </button>
                </div>
                {connect.isPending ? <div className="muted">Check prompt…</div> : null}
                {connect.error ? <div className="muted" style={{ color: 'crimson' }}>Error: {connect.error.message}</div> : null}
              </div>
            ) : (
              <>
                <div className="balance-card">
                  <div className="balance-row">
                    <div className="balance-amount">
                      {balanceQuery.isLoading ? '—' : `$${formattedBalance}`}
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => disconnect.disconnect()}
                      aria-label="Sign out"
                      title="Sign out"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <path d="M16 17l5-5-5-5" />
                        <path d="M21 12H9" />
                      </svg>
                    </button>
                  </div>
                <div className="balance-token">AlphaUSD</div>
                <div className="balance-address">{account.address}</div>
              </div>
              <div className="phone-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <b>Invoices</b>
                  </div>
                  <div className="invoice-header-actions">
                    <label className="toggle">
                      <span>Autopay</span>
                      <input
                        type="checkbox"
                        checked={isAutopayEnabled}
                        disabled={isAutopayBusy}
                        onChange={(event) => {
                          if (isAutopayBusy) return
                          handleAutopayToggle(event.target.checked)
                        }}
                      />
                      <span className="toggle-slider" aria-hidden="true"></span>
                    </label>
                    {sendPayment.isPending ? <span className="muted">Paying…</span> : null}
                  </div>
                </div>
                <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
                  {openInvoices.length === 0 ? (
                    <div className="muted">No open invoices.</div>
                  ) : (
                    openInvoices.map((inv) => {
                      const isProcessing = processingInvoices.has(String(inv.number))
                      return (
                      <div key={String(inv.number)} className="invoice-item">
                        <div>
                          <div className="invoice-title">
                            <span>Invoice {inv.number.toString()}</span>
                            <span className="muted">${formatInvoiceAmount(inv.amount)}</span>
                          </div>
                          <div className="muted">ID: <code>{decodeInvoiceId(inv.invoiceId)}</code></div>
                        </div>
                        {isProcessing ? (
                          <div className="processing-spinner spin" aria-label="Processing payment">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M21 12a9 9 0 1 1-3-6.7" />
                              <path d="M21 3v6h-6" />
                            </svg>
                          </div>
                        ) : isAutopayEnabled ? (
                          <div className="scheduled-pill" aria-label="Scheduled">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <circle cx="12" cy="12" r="9"></circle>
                              <path d="M12 7v5l3 3"></path>
                            </svg>
                          </div>
                        ) : (
                          <button
                            className="btn btn-primary"
                            disabled={sendPayment.isPending || isProcessing}
                            onClick={() => handlePayInvoice(inv)}
                          >
                            Pay
                          </button>
                        )}
                      </div>
                    )})
                  )}
                </div>
              </div>
              <div className="phone-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>Transactions</b>
                </div>
                <div className="transactions-list">
                  {transactions.length === 0 ? (
                    <div className="muted">No recent transfers.</div>
                  ) : (
                    transactions.map((tx) => (
                      <div key={`${tx.txHash}-${tx.logIndex}`} className="transaction-row">
                        <div className={`transaction-icon ${tx.direction}`}>
                          {tx.direction === 'incoming' ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 5v14" />
                              <path d="m19 12-7 7-7-7" />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 19V5" />
                              <path d="m5 12 7-7 7 7" />
                            </svg>
                          )}
                        </div>
                        <div className="transaction-meta">
                          <a
                            href={`${explorerBaseUrl}/tx/${tx.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="transaction-memo"
                          >
                            {tx.memo || 'Memo'}
                          </a>
                        </div>
                        <div className="transaction-amount">
                          {tx.direction === 'incoming' ? '+' : '-'}${tx.amount}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* RIGHT */}
      <div className="pane">
        <div className="merchant-header">
          <h2>Merchant</h2>
          {merchantAddress ? (
            <div className="merchant-header-address">
              <span>Merchant&#39;s address:</span>
              <a
                href={`${explorerBaseUrl}/address/${merchantAddress}`}
                target="_blank"
                rel="noreferrer"
                className="address-link"
              >
                <code>{merchantAddress}</code>
              </a>
            </div>
          ) : null}
          {invoiceRegistryAddress ? (
            <div className="merchant-contract-link">
              <a
                href={`${explorerBaseUrl}/address/${invoiceRegistryAddress}`}
                target="_blank"
                rel="noreferrer"
                className="address-link"
              >
                Invoice contract: <code>{invoiceRegistryAddress}</code>
              </a>
            </div>
          ) : null}
        </div>

        <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <b>Invoices</b>
              </div>
              <button
                className="btn btn-outline"
                disabled={!account.address || isCreatingInvoice || isAwaitingInvoice || !invoiceRegistryAddress}
              onClick={handleGenerateInvoice}
            >
              {isCreatingInvoice || isAwaitingInvoice ? 'Generating…' : 'Generate invoice'}
            </button>
          </div>

        </div>

        {onchainInvoices.map((inv) => {
          const invoiceId = decodeInvoiceId(inv.invoiceId)
          const amountLabel = formatInvoiceAmount(inv.amount)
          return (
          <div key={String(inv.number)} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="row" style={{ gap: 10 }}>
                  <b>Invoice {inv.number.toString()}</b>
                  <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Amount: <code>${amountLabel}</code></span>
                    <button
                      type="button"
                      onClick={() => handleCopyId(amountLabel)}
                      title="Copy invoice amount"
                      aria-label="Copy invoice amount"
                      className={copiedId === amountLabel ? 'copy-button copied' : 'copy-button'}
                      style={{
                        padding: 4,
                        borderRadius: 6,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                    {copiedId === amountLabel ? (
                      <svg
                        width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5"></path>
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      )}
                    </button>
                    <span className={copiedId === amountLabel ? 'copy-badge show' : 'copy-badge'}>
                      Copied
                    </span>
                  </span>
                </div>
                <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>ID: <code>{invoiceId}</code></span>
                  <button
                    type="button"
                    onClick={() => handleCopyId(invoiceId)}
                    title="Copy invoice ID"
                    aria-label="Copy invoice ID"
                    className={copiedId === invoiceId ? 'copy-button copied' : 'copy-button'}
                    style={{
                      padding: 4,
                      borderRadius: 6,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedId === invoiceId ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6L9 17l-5-5"></path>
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    )}
                    </button>
                  <span className={copiedId === invoiceId ? 'copy-badge show' : 'copy-badge'}>
                    Copied
                  </span>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>
                  Due: {formatDueDate(inv.dueDate)}
                </div>
              </div>
              <div className={inv.status === 1 ? 'paid' : 'unpaid'}>
                {inv.status === 1 ? 'Paid' : 'Open'}
              </div>
            </div>
            {inv.status === 1 && inv.paidTxHash !== '0x0000000000000000000000000000000000000000000000000000000000000000' ? (
              <div className="muted" style={{ marginTop: 8 }}>
                Receipt:{' '}
                <a
                  href={`https://explorer.tempo.xyz/tx/${inv.paidTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{inv.paidTxHash.slice(0, 10)}…</code>
                </a>
              </div>
            ) : null}
          </div>
        )
        })}

      </div>
    </div>
  )
}
