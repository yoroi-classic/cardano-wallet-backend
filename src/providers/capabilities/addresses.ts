/** Address-level reads. */
export interface AddressCapability {
  /**
   * Of the given addresses, which have appeared on chain (been used). Returns the used
   * subset preserving the input order; addresses never seen on chain are omitted. The
   * result is a filter of the input, so it is never longer than `addresses`.
   */
  filterUsedAddresses(addresses: string[]): Promise<string[]>

  /** Current unspent outputs at one payment address, including datums and reference scripts. */
  getAddressUtxos(address: string): Promise<import('../../domain/types/transactions.js').Utxo[]>
}
