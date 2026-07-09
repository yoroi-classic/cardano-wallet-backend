import { loadConfig } from './config.js'
import { deriveWallet } from './wallet.js'
import { createV1Client } from './v1.js'
import { buildSelfPayment } from './buildTx.js'

const ada = (lovelace: string): string => (Number(lovelace) / 1_000_000).toFixed(6)
const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

const FEE_BUFFER_LOVELACE = 300_000n
const MAX_POLLS = 60

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
      // The tx is in a block, so it should now show up in history via /v1.
      const history = await client.getTxHistory(wallet.stakeAddress)
      const present = history.some((t) => t.txHash === tx.txHash)
      console.log(`history:      ${history.length} tx(s), this one present: ${present}`)
      if (!present) {
        throw new Error('submitted transaction did not appear in /v1 history')
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
