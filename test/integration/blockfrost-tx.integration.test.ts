import { describe, expect, it } from 'vitest'
import {
  BLOCKFROST_PROJECT_ID,
  discover,
  discoverRecentTxHash,
  integrationProvider,
} from './support/provider-blockfrost.js'

const skip = BLOCKFROST_PROJECT_ID === undefined

interface TxUtxos {
  inputs: { tx_hash: string; output_index: number; collateral: boolean; reference?: boolean }[]
  outputs: { output_index: number }[]
}

describe('blockfrost getUtxosByRef (integration)', () => {
  it.skipIf(skip)(
    'resolves a live output by reference, and reports a spent input as spent',
    async () => {
      // A transaction from a recent block, so the fixtures are live and cannot rot. The tip block
      // usually carries none on preprod, so this walks back until it finds one.
      const txHash = await discoverRecentTxHash()

      const utxos = await discover<TxUtxos>(`/txs/${txHash}/utxos`)
      const provider = integrationProvider()

      // An output of this transaction resolves and is not yet spent (it was just created).
      const outputIndex = utxos.outputs[0]!.output_index
      const resolved = await provider.getUtxosByRef([`${txHash}#${outputIndex}`])
      expect(resolved).toHaveLength(1)
      expect(resolved[0]!.txHash).toBe(txHash)
      expect(resolved[0]!.outputIndex).toBe(outputIndex)
      expect(BigInt(resolved[0]!.value)).toBeGreaterThan(0n)
      expect(resolved[0]!.spent).toBe(false)

      // A regular (non-collateral, non-reference) input of this transaction points at an output that
      // this very transaction consumed, so resolving it must report it spent.
      const spentInput = utxos.inputs.find((i) => !i.collateral && i.reference !== true)
      if (spentInput !== undefined) {
        const spent = await provider.getUtxosByRef([
          `${spentInput.tx_hash}#${spentInput.output_index}`,
        ])
        expect(spent).toHaveLength(1)
        expect(spent[0]!.spent).toBe(true)
      }
    },
  )

  it.skipIf(skip)('omits a reference to a transaction that is not on chain', async () => {
    const provider = integrationProvider()
    const notOnChain = `${'0'.repeat(64)}#0`

    await expect(provider.getUtxosByRef([notOnChain])).resolves.toEqual([])
  })
})
