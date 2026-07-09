import { loadConfig } from './config.js'
import { deriveWallet } from './wallet.js'
import { createV1Client } from './v1.js'
import { buildSelfPayment } from './buildTx.js'

const ada = (lovelace: string): string => (Number(lovelace) / 1_000_000).toFixed(6)
const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

const FEE_BUFFER_LOVELACE = 300_000n
const MAX_POLLS = 60

// Only used to discover a currently-registered pool id to read back through our /v1
// surface (a testnet convenience, not part of what we're validating). KOIOS_URL overrides.
const KOIOS_BASE: Record<string, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const wallet = deriveWallet(cfg.mnemonic, cfg.networkId)

  console.log(`network:      ${cfg.network}`)
  console.log(`backend:      ${cfg.backendUrl}`)
  console.log(`payment addr: ${wallet.paymentAddress}`)
  console.log(`stake addr:   ${wallet.stakeAddress}`)

  const client = createV1Client(cfg.backendUrl)

  // Fail clearly if BACKEND_URL points at something that isn't this backend (a common
  // mix-up when another service, e.g. a local Dingo/Blockfrost, is on the expected port).
  const health = await client.getHealth().catch(() => null)
  if (!health || health.service !== 'cardano-wallet-backend') {
    throw new Error(
      `${cfg.backendUrl} does not look like a cardano-wallet-backend instance ` +
        `(GET /health did not return service "cardano-wallet-backend"). ` +
        `Check BACKEND_URL and that the backend is running on that port.`,
    )
  }

  const tip = await client.getTip()
  console.log(`tip:          block ${tip.block}, epoch ${tip.epoch}`)

  const state = await client.getAccountState(wallet.stakeAddress)
  console.log(`registered:   ${state.registered}`)
  console.log(`balance:      ${ada(state.balance)} ADA`)

  const utxos = await client.getAccountUtxos(wallet.stakeAddress)
  const adaOnly = utxos.filter((u) => u.assets.length === 0)
  const spendable = adaOnly.reduce((sum, u) => sum + BigInt(u.value), 0n)
  console.log(
    `utxos:        ${utxos.length} total, ${adaOnly.length} ADA-only (${ada(spendable.toString())} ADA spendable)`,
  )

  // Pool info: pick a currently-registered pool from the chain, then confirm our /v1
  // surface returns its normalized info correctly. Runs on the read path so it is
  // exercised even when the wallet is unfunded.
  const koiosBase = (process.env.KOIOS_URL ?? KOIOS_BASE[cfg.network] ?? '').replace(/\/+$/, '')
  const listRes = await fetch(`${koiosBase}/pool_list?pool_status=eq.registered&limit=1`, {
    signal: AbortSignal.timeout(20_000),
  })
  const poolList = (await listRes.json()) as Array<{ pool_id_bech32?: string }>
  const samplePoolId = poolList[0]?.pool_id_bech32
  if (!samplePoolId) {
    throw new Error('could not find a registered pool on-chain to exercise pool info')
  }
  const [pool] = await client.getPoolInfo([samplePoolId])
  if (!pool || pool.poolId !== samplePoolId || !/^[0-9a-f]{56}$/.test(pool.poolIdHex)) {
    throw new Error(`pool info did not come back correctly for ${samplePoolId}`)
  }
  const poolLabel = pool.metadata?.ticker ?? pool.metadata?.name ?? '(no metadata)'
  console.log(`pool info:    ${pool.poolId}`)
  console.log(
    `  ${poolLabel}  status=${pool.status}  margin=${pool.margin}  saturation=${pool.saturation}  liveStake=${ada(pool.liveStake)} ADA`,
  )

  const needed = BigInt(cfg.amountLovelace) + FEE_BUFFER_LOVELACE
  if (spendable < needed) {
    console.log('')
    console.log(
      'Not enough spendable ADA to send. Fund the payment address from the preprod faucet:',
    )
    console.log(`  https://docs.cardano.org/cardano-testnets/tools/faucet`)
    console.log(`  address: ${wallet.paymentAddress}`)
    console.log('Then re-run. Read path verified; skipping the send this time.')
    return
  }

  const params = await client.getProtocolParams()
  const tx = buildSelfPayment({
    utxos,
    params,
    address: wallet.paymentAddress,
    amountLovelace: cfg.amountLovelace,
    paymentKey: wallet.paymentKey,
  })
  console.log('')
  console.log(`built self-send of ${ada(cfg.amountLovelace)} ADA, fee ${ada(tx.feeLovelace)} ADA`)
  console.log(`tx hash:      ${tx.txHash}`)

  const submitted = await client.submitTx(tx.cborHex)
  console.log(`submitted:    ${submitted.txHash}`)
  if (submitted.txHash !== tx.txHash) {
    // A mismatch means the submitted bytes differ from what we hashed, a serialization
    // problem worth stopping on rather than polling a hash that will never confirm.
    throw new Error(
      `submit hash mismatch: built ${tx.txHash} but backend reported ${submitted.txHash}`,
    )
  }

  console.log(`waiting for ${cfg.confirmations} confirmation(s)...`)
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await sleep(cfg.pollSeconds)
    const status = await client.getTxStatus(tx.txHash)
    console.log(`  seen=${status.seen} confirmations=${status.confirmations}`)
    if (status.confirmations >= cfg.confirmations) {
      // The tx is in a block, so it should now show up in history via /v1. History is
      // capped and returned oldest-first, so page from the tip we saw before submitting:
      // our tx landed in a later block, so it is guaranteed to fall inside this window.
      const history = await client.getTxHistory(wallet.stakeAddress, tip.block)
      const present = history.some((t) => t.txHash === tx.txHash)
      console.log(
        `history:      ${history.length} tx(s) after block ${tip.block}, this one present: ${present}`,
      )
      if (!present) {
        throw new Error('submitted transaction did not appear in /v1 history')
      }

      // filter-used: the payment address just transacted, so it must come back as used;
      // a fresh derived address on the same account must be accepted as well-formed yet
      // reported as unused.
      const filtered = await client.filterUsedAddresses([
        wallet.paymentAddress,
        wallet.unusedAddress,
      ])
      const paymentUsed = filtered.includes(wallet.paymentAddress)
      const freshExcluded = !filtered.includes(wallet.unusedAddress)
      console.log('filter-used:')
      console.log(`  payment addr (expect used):     ${wallet.paymentAddress}`)
      console.log(`  fresh addr   (expect unused):   ${wallet.unusedAddress}`)
      console.log(
        `  returned used set:              ${filtered.length ? filtered.join(', ') : '(none)'}`,
      )
      console.log(`  payment used=${paymentUsed}, fresh addr excluded=${freshExcluded}`)
      if (!paymentUsed || !freshExcluded) {
        throw new Error('filter-used did not classify the payment and fresh addresses correctly')
      }

      console.log('confirmed and in history. vertical slice complete.')
      return
    }
  }
  throw new Error(`transaction not confirmed after ${MAX_POLLS} polls`)
}

main().catch((err) => {
  console.error('e2e failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
