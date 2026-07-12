import type { AccountCapability } from './capabilities/account.js'
import type { AddressCapability } from './capabilities/addresses.js'
import type { AssetCapability } from './capabilities/assets.js'
import type { ChainCapability } from './capabilities/chain.js'
import type { PoolCapability } from './capabilities/pools.js'
import type { TxCapability } from './capabilities/tx.js'

/**
 * The provider contract. Every data source (Koios, Blockfrost, a bring-your-own
 * Dingo node) implements this so the HTTP layer never has to know which one is
 * serving a request.
 *
 * The contract is assembled from one capability interface per area rather than spelled
 * out flat, so a new area of the API arrives as a new file under `capabilities/` plus a
 * single name here. Concurrent feature branches then stop rewriting the same interface,
 * which is the reason the split exists.
 */
export interface ChainProvider
  extends
    ChainCapability,
    AccountCapability,
    AddressCapability,
    AssetCapability,
    PoolCapability,
    TxCapability {
  /** A short name for logs and diagnostics, e.g. "koios". */
  readonly name: string
}
