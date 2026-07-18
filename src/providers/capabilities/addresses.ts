import type { Utxo, WalletTransaction } from '../../domain/types/transactions.js'

/** Address-level reads. */
export interface AddressCapability {
  /**
   * Of the given addresses, which have appeared on chain (been used). Returns the used
   * subset preserving the input order; addresses never seen on chain are omitted. The
   * result is a filter of the input, so it is never longer than `addresses`.
   */
  filterUsedAddresses(addresses: string[]): Promise<string[]>

  /**
   * Of the given 28-byte payment-key credentials (lowercase hex), which have appeared on
   * chain. Returns the used subset preserving input order.
   */
  filterUsedPaymentCredentials(paymentCredentials: string[]): Promise<string[]>

  /**
   * Every UTxO controlled by any of the given addresses, in one call.
   *
   * Keyed by address set rather than by stake key, for wallets whose addresses carry no
   * resolvable stake credential: Byron, enterprise, and pointer addresses are all on that
   * side of the line, so none of them can use `getAccountUtxos`. A base Shelley wallet, which
   * can derive a stake key from any of its addresses, should prefer that instead: it reads
   * the whole wallet in one call rather than needing every address enumerated.
   */
  getUtxosByAddresses(addresses: string[]): Promise<Utxo[]>

  /**
   * Transaction history for a set of addresses, oldest first. `afterBlock` pages forward:
   * pass the block height of the last transaction already seen to get the next page.
   *
   * A transaction touching more than one of the given addresses (a self-transfer within the
   * same wallet, most commonly) appears exactly once, not once per matching address.
   */
  getTxHistoryByAddresses(addresses: string[], afterBlock?: number): Promise<WalletTransaction[]>
}
