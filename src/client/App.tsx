import React from 'react'
import { useConnection, useConnect, useConnectors, useDisconnect, useReadContract, useReadContracts, useWaitForTransactionReceipt } from 'wagmi'
import { Hooks } from 'tempo.ts/wagmi'
import { formatUnits, hexToString, parseUnits, pad, stringToHex } from 'viem'
import { getConfig } from './api'
import { invoiceRegistryAbi } from './invoiceRegistryAbi'

function TouchIdIcon() {
  return (
    <img className="touchid-image" src="/assets/touchid.svg" alt="Touch ID" />
  )
}

function FaucetCard(props: {
  address?: `0x${string}`
  onSuccess?: () => void
  isRefreshing?: boolean
}) {
  const [isSending, setIsSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)

  async function requestFunds() {
    if (!props.address) return
    setIsSending(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('https://rpc.testnet.tempo.xyz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tempo_fundAddress',
          params: [props.address],
        }),
      })
      const data = await res.json()
      if (!res.ok || data?.error) {
        throw new Error(data?.error?.message ?? `Faucet request failed (${res.status})`)
      }
      setSuccess('Faucet request sent. Funds should arrive shortly.')
      props.onSuccess?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Faucet request failed')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="phone-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Testnet Faucet</b>
        <button className="btn btn-outline" disabled={!props.address || isSending} onClick={requestFunds}>
          {isSending ? 'Requesting…' : 'Add test funds'}
        </button>
      </div>
      {error ? (
        <div className="muted" style={{ color: 'crimson', marginTop: 8 }}>{error}</div>
      ) : null}
      {success ? (
        <div className="muted" style={{ color: 'green', marginTop: 8 }}>{success}</div>
      ) : null}
      {props.isRefreshing ? (
        <div className="muted" style={{ color: '#5b6b8f', marginTop: 6 }}>Checking balance…</div>
      ) : null}
    </div>
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

function decodeInvoiceId(invoiceId: `0x${string}`) {
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
  const [paymentNotice, setPaymentNotice] = React.useState<string | null>(null)
  const paymentTimerRef = React.useRef<number | null>(null)
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const copyTimerRef = React.useRef<number | null>(null)
  const alphaUsdToken = '0x20c0000000000000000000000000000000000001' as const
  const explorerBaseUrl = 'https://explorer.tempo.xyz'
  const balanceQuery = Hooks.token.useGetBalance({
    account: account.address,
    token: alphaUsdToken,
  })
  const balancePollRef = React.useRef<number | null>(null)
  const [isBalanceRefreshing, setIsBalanceRefreshing] = React.useState(false)
  const sendPayment = Hooks.token.useTransferSync()
  const lastTxRef = React.useRef<string | null>(null)
  const [createTxHash, setCreateTxHash] = React.useState<`0x${string}` | null>(null)
  const [isCreatingInvoice, setIsCreatingInvoice] = React.useState(false)
  const [isRefreshingMobile, setIsRefreshingMobile] = React.useState(false)
  const [isRefreshingMerchant, setIsRefreshingMerchant] = React.useState(false)

  const refreshBalanceAfterFaucet = React.useCallback(() => {
    const startingBalance = balanceQuery.data ?? 0n
    const maxAttempts = 20
    const delayMs = 2000
    let attempts = 0

    if (balancePollRef.current) {
      window.clearTimeout(balancePollRef.current)
      balancePollRef.current = null
    }
    setIsBalanceRefreshing(true)

    const poll = async () => {
      attempts += 1
      const result = await balanceQuery.refetch()
      const nextBalance = result.data ?? startingBalance
      if (nextBalance > startingBalance || attempts >= maxAttempts) {
        balancePollRef.current = null
        setIsBalanceRefreshing(false)
        return
      }
      balancePollRef.current = window.setTimeout(poll, delayMs)
    }

    void poll()
  }, [balanceQuery])

  React.useEffect(() => {
    return () => {
      if (balancePollRef.current) {
        window.clearTimeout(balancePollRef.current)
        balancePollRef.current = null
      }
      setIsBalanceRefreshing(false)
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
    sendPayment.mutate({
      amount: inv.amount,
      to: merchantAddress,
      token: alphaUsdToken,
      feeToken: alphaUsdToken,
      memo: inv.invoiceId,
    })
  }, [alphaUsdToken, merchantAddress, sendPayment])

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

  const refreshMobileInvoices = React.useCallback(async () => {
    if (!account.address) return
    setIsRefreshingMobile(true)
    try {
      await Promise.all([invoiceNumbersQuery.refetch(), invoicesQuery.refetch()])
    } finally {
      window.setTimeout(() => setIsRefreshingMobile(false), 400)
    }
  }, [account.address, invoiceNumbersQuery, invoicesQuery])

  const refreshMerchantInvoices = React.useCallback(async () => {
    setIsRefreshingMerchant(true)
    try {
      await fetch('/api/invoices/refresh-status')
    } finally {
      window.setTimeout(() => setIsRefreshingMerchant(false), 400)
    }
    await refreshMobileInvoices()
  }, [refreshMobileInvoices])

  React.useEffect(() => {
    const tx = sendPayment.data?.receipt?.transactionHash
    if (tx && tx !== lastTxRef.current) {
      lastTxRef.current = tx
      handlePaymentSuccess(String(tx))
      window.setTimeout(() => {
        refreshMerchantInvoices()
        refreshMobileInvoices()
      }, 800)
    }
  }, [
    handlePaymentSuccess,
    refreshMerchantInvoices,
    refreshMobileInvoices,
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


  const handleGenerateInvoice = React.useCallback(async () => {
    if (!account.address) return
    setIsCreatingInvoice(true)
    try {
      const r = await fetch('/api/invoices/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: account.address }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error ?? 'Failed to create invoice')
      setCreateTxHash(data.hash as `0x${string}`)
    } catch (err) {
      console.error(err)
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
            {!account.address ? (
              <div className="auth-screen">
                <TouchIdIcon />
                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={() => connect.connect({ connector })}
                  >
                    Sign in
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() =>
                    connect.connect({
                      connector,
                      capabilities: { type: 'sign-up' },
                    } as never)
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
              <FaucetCard
                address={account.address}
                onSuccess={refreshBalanceAfterFaucet}
                isRefreshing={isBalanceRefreshing}
              />
              <div className="phone-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row">
                    <b>Invoices</b>
                    <button
                      className={`refresh-button ${isRefreshingMobile ? 'spin' : ''}`}
                      onClick={refreshMobileInvoices}
                      aria-label="Refresh invoices"
                      title="Refresh invoices"
                    >
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
                        <path d="M21 12a9 9 0 1 1-3-6.7" />
                        <path d="M21 3v6h-6" />
                      </svg>
                    </button>
                  </div>
                  {sendPayment.isPending ? <span className="muted">Paying…</span> : null}
                </div>
                <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
                  {openInvoices.length === 0 ? (
                    <div className="muted">No open invoices.</div>
                  ) : (
                    openInvoices.map((inv) => (
                      <div key={String(inv.number)} className="invoice-item">
                        <div>
                          <div className="invoice-title">
                            <span>Invoice {inv.number.toString()}</span>
                            <span className="muted">${formatInvoiceAmount(inv.amount)}</span>
                          </div>
                          <div className="muted">ID: <code>{decodeInvoiceId(inv.invoiceId)}</code></div>
                        </div>
                        <button
                          className="btn btn-primary"
                          disabled={sendPayment.isPending}
                          onClick={() => handlePayInvoice(inv)}
                        >
                          Pay
                        </button>
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
              <button
                className={`refresh-button ${isRefreshingMerchant ? 'spin' : ''}`}
                onClick={refreshMerchantInvoices}
                aria-label="Refresh invoice status"
                title="Refresh invoice status"
              >
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
                  <path d="M21 12a9 9 0 1 1-3-6.7" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
            </div>
            <button
              className="btn btn-outline"
              disabled={!account.address || isCreatingInvoice || !invoiceRegistryAddress}
              onClick={handleGenerateInvoice}
            >
              {isCreatingInvoice ? 'Generating…' : 'Generate invoice'}
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
