import React from 'react'
import { useConnection, useConnect, useConnectors, useDisconnect } from 'wagmi'
import { Hooks } from 'tempo.ts/wagmi'
import { formatUnits, parseUnits, pad, stringToHex } from 'viem'
import { generate5Invoices, getConfig, type Invoice } from './api'

function TouchIdIcon() {
  return (
    <img className="touchid-image" src="/assets/touchid.svg" alt="Touch ID" />
  )
}

function FaucetCard(props: { address?: `0x${string}` }) {
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
    </div>
  )
}

export function App() {
  const [merchantAddress, setMerchantAddress] = React.useState<`0x${string}` | undefined>()
  const [invoices, setInvoices] = React.useState<Invoice[]>([])
  const account = useConnection()
  const connect = useConnect()
  const [connector] = useConnectors()
  const disconnect = useDisconnect()
  const [paymentNotice, setPaymentNotice] = React.useState<string | null>(null)
  const paymentTimerRef = React.useRef<number | null>(null)
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const copyTimerRef = React.useRef<number | null>(null)
  const alphaUsdToken = '0x20c0000000000000000000000000000000000001' as const
  const isLoggedInRef = React.useRef(false)
  const balanceQuery = Hooks.token.useGetBalance({
    account: account.address,
    token: alphaUsdToken,
  })
  const sendPayment = Hooks.token.useTransferSync()
  const lastTxRef = React.useRef<string | null>(null)

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

  React.useEffect(() => {
    isLoggedInRef.current = Boolean(account.address)
    if (!account.address) setInvoices([])
  }, [account.address])

  const handlePaymentSuccess = React.useCallback((txHash: string) => {
    setPaymentNotice(txHash)
    balanceQuery.refetch()
    if (paymentTimerRef.current) window.clearTimeout(paymentTimerRef.current)
    paymentTimerRef.current = window.setTimeout(() => {
      setPaymentNotice(null)
      paymentTimerRef.current = null
    }, 6000)
  }, [balanceQuery])

  React.useEffect(() => {
    const tx = sendPayment.data?.receipt?.transactionHash
    if (tx && tx !== lastTxRef.current) {
      lastTxRef.current = tx
      handlePaymentSuccess(String(tx))
    }
  }, [handlePaymentSuccess, sendPayment.data?.receipt?.transactionHash])

  const handlePayInvoice = React.useCallback((inv: Invoice) => {
    if (!merchantAddress) return
    sendPayment.mutate({
      amount: parseUnits(inv.amountUsd, 6),
      to: merchantAddress,
      token: alphaUsdToken,
      memo: pad(stringToHex(inv.id), { size: 32 }),
    })
  }, [alphaUsdToken, merchantAddress, sendPayment])

  React.useEffect(() => {
    getConfig().then((c) => setMerchantAddress(c.merchantAddress)).catch(console.error)

    const es = new EventSource('/api/events')
    es.addEventListener('invoices', (e) => {
      if (!isLoggedInRef.current) return
      const data = JSON.parse((e as MessageEvent).data) as { invoices: Invoice[] }
      setInvoices(data.invoices)
    })
    es.addEventListener('invoicePaid', (e) => {
      if (!isLoggedInRef.current) return
      const data = JSON.parse((e as MessageEvent).data) as { invoice: Invoice }
      // optimistic merge
      setInvoices((prev) => prev.map((x) => (x.id === data.invoice.id ? data.invoice : x)))
    })
    return () => es.close()
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
                      })
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
                      onClick={() => {
                        setInvoices([])
                        setMerchantAddress(undefined)
                        disconnect.disconnect()
                      }}
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
              <FaucetCard address={account.address} />
              <div className="phone-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>Invoices</b>
                  {sendPayment.isPending ? <span className="muted">Paying…</span> : null}
                </div>
                <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
                  {invoices.length === 0 ? (
                    <div className="muted">No invoices yet.</div>
                  ) : (
                    invoices.map((inv) => (
                      <div key={inv.id} className="invoice-item">
                        <div>
                          <div className="invoice-title">
                            <span>Invoice {inv.number}</span>
                            <span className="muted">${inv.amountUsd}</span>
                          </div>
                          <div className="muted">ID: <code>{inv.id}</code></div>
                        </div>
                        <button
                          className="btn btn-primary"
                          disabled={!merchantAddress || sendPayment.isPending || inv.status === 'Paid'}
                          onClick={() => handlePayInvoice(inv)}
                        >
                          {inv.status === 'Paid' ? 'Paid' : 'Pay'}
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
              <code>{merchantAddress}</code>
              <button
                type="button"
                onClick={() => handleCopyId(merchantAddress)}
                title="Copy merchant address"
                aria-label="Copy merchant address"
                className={copiedId === merchantAddress ? 'copy-button copied' : 'copy-button'}
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
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
              <span className={copiedId === merchantAddress ? 'copy-badge show' : 'copy-badge'}>
                Copied
              </span>
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Invoices</b>
            <button
              className="btn btn-outline"
              disabled={!account.address}
              onClick={async () => {
                if (!account.address) return
                const r = await generate5Invoices()
                setMerchantAddress(r.merchantAddress)
                setInvoices(r.invoices)
              }}
            >
              Generate 5 invoices
            </button>
          </div>

        </div>

        {invoices.map((inv) => (
          <div key={inv.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="row" style={{ gap: 10 }}>
                  <b>Invoice {inv.number}</b>
                  <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Amount: <code>${inv.amountUsd}</code></span>
                    <button
                      type="button"
                      onClick={() => handleCopyId(inv.amountUsd)}
                      title="Copy invoice amount"
                      aria-label="Copy invoice amount"
                      className={copiedId === inv.amountUsd ? 'copy-button copied' : 'copy-button'}
                      style={{
                        padding: 4,
                        borderRadius: 6,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      {copiedId === inv.amountUsd ? (
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
                    <span className={copiedId === inv.amountUsd ? 'copy-badge show' : 'copy-badge'}>
                      Copied
                    </span>
                  </span>
                </div>
                <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>ID: <code>{inv.id}</code></span>
                  <button
                    type="button"
                    onClick={() => handleCopyId(inv.id)}
                    title="Copy invoice ID"
                    aria-label="Copy invoice ID"
                    className={copiedId === inv.id ? 'copy-button copied' : 'copy-button'}
                    style={{
                      padding: 4,
                      borderRadius: 6,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    {copiedId === inv.id ? (
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
                  <span className={copiedId === inv.id ? 'copy-badge show' : 'copy-badge'}>
                    Copied
                  </span>
                </div>
              </div>
              <div className={inv.status === 'Paid' ? 'paid' : 'unpaid'}>
                {inv.status}
              </div>
            </div>

            {inv.status === 'Paid' ? (
              <div className="muted" style={{ marginTop: 8 }}>
                Tx:{' '}
                <a
                  href={`https://explorer.tempo.xyz/tx/${inv.paidTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{inv.paidTxHash}</code>
                </a>
              </div>
            ) : null}
          </div>
        ))}

      </div>
    </div>
  )
}
