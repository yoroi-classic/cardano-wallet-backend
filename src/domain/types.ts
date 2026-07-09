/**
 * Normalized domain types. These are the shapes the backend exposes over its
 * public API, independent of whichever provider (Koios, Blockfrost, Dingo) served
 * the data. Providers map their own responses onto these.
 */

/** Current chain tip. */
export interface Tip {
  /** Block height (block number). */
  block: number
  /** Absolute slot. */
  slot: number
  /** Epoch number. */
  epoch: number
  /** Block hash (hex). */
  hash: string
}

/** Protocol version tuple. */
export interface ProtocolVersion {
  major: number
  minor: number
}

/**
 * Protocol parameters the wallet needs to build and evaluate transactions.
 * Lovelace-denominated values are strings to avoid precision loss.
 */
export interface ProtocolParams {
  epoch: number
  minFeeA: number
  minFeeB: number
  maxTxSize: number
  maxBlockBodySize: number
  keyDeposit: string
  poolDeposit: string
  minPoolCost: string
  coinsPerUtxoByte: string
  maxValueSize: number
  collateralPercent: number
  maxCollateralInputs: number
  priceMem: number
  priceStep: number
  maxTxExMem: string
  maxTxExSteps: string
  protocolVersion: ProtocolVersion
  /**
   * Plutus cost models keyed by language version. Kept as an opaque record because
   * the shape varies by era and provider, and the wallet passes it straight through
   * to the serialization library. Some providers (notably a bare Dingo node) omit
   * these, in which case they must be supplemented from another provider.
   */
  costModels: Record<string, unknown>
}

/** A native (non-ADA) asset held in a UTxO. */
export interface Asset {
  /** Policy id (hex). */
  policyId: string
  /** Asset name (hex). */
  assetName: string
  /** Quantity, as a string to avoid precision loss. */
  quantity: string
}

/** An unspent transaction output belonging to a wallet. */
export interface Utxo {
  /** Transaction hash (hex). */
  txHash: string
  /** Output index within that transaction. */
  outputIndex: number
  /** Bech32 address that controls the output. */
  address: string
  /** Lovelace value, as a string. */
  value: string
  /** Native assets in the output. */
  assets: Asset[]
  /** Datum hash (hex), if the output carries one. */
  datumHash?: string
  /** Inline datum (hex), if present. Needed by script-spending flows. */
  inlineDatum?: string
  /** Reference script hash (hex), if the output carries a reference script. */
  referenceScriptHash?: string
}

/** One side (input or output) of a transaction. */
export interface TxIo {
  /** Bech32 address. Omitted when the provider can't express it (e.g. some Byron outputs). */
  address?: string
  /** Lovelace value, as a string. */
  value: string
  /** Native assets carried on this input/output. */
  assets: Asset[]
}

/** A reward withdrawal within a transaction. */
export interface Withdrawal {
  stakeAddress: string
  amount: string
}

/**
 * Normalized, provider-agnostic certificate kind. Providers map their own labels onto
 * this stable set so the API shape doesn't leak Koios (or Blockfrost) terminology.
 */
export type CertificateKind =
  | 'stake_registration'
  | 'stake_deregistration'
  | 'stake_delegation'
  | 'pool_registration'
  | 'pool_retirement'
  | 'vote_delegation'
  | 'drep_registration'
  | 'drep_update'
  | 'drep_deregistration'
  | 'committee_hot_auth'
  | 'committee_cold_resign'
  | 'move_instantaneous_rewards'
  | 'genesis_key_delegation'
  | 'other'

/**
 * A certificate within a transaction. Only the normalized kind and position are exposed
 * for now, so the contract stays provider-agnostic. Per-kind normalized detail (pool id,
 * stake address, etc.) is a planned addition once we normalize it across providers.
 */
export interface TxCertificate {
  /** Normalized certificate kind. */
  kind: CertificateKind
  /** Position of the certificate within the transaction. */
  index: number
}

/** A historical transaction that touched the account, normalized for display. */
export interface WalletTransaction {
  txHash: string
  block: number
  blockHash: string
  slot: number
  epoch: number
  /** Unix timestamp (seconds) of the containing block. */
  blockTime: number
  fee: string
  /** Time-to-live (invalid-after slot), if the transaction set one. */
  ttl?: number
  inputs: TxIo[]
  outputs: TxIo[]
  withdrawals: Withdrawal[]
  certificates: TxCertificate[]
  /** Transaction metadata, opaque here. */
  metadata?: unknown
}

/** Off-chain pool metadata, as registered on chain (SMASH-style). All fields optional
 * because a pool may register without metadata, or omit individual fields. */
export interface PoolMetadata {
  name?: string
  ticker?: string
  homepage?: string
  description?: string
}

/** Registration lifecycle of a stake pool. */
export type PoolStatus = 'registered' | 'retiring' | 'retired'

/**
 * Normalized stake-pool information: registration parameters, off-chain metadata, and
 * current stake/saturation stats. Lovelace values are strings to avoid precision loss.
 */
export interface PoolInfo {
  /** Bech32 pool id (pool1...). */
  poolId: string
  /** Pool id as a hex key-hash. */
  poolIdHex: string
  status: PoolStatus
  /** Epoch the pool is set to retire in, when `status` is `retiring`. */
  retiringEpoch?: number
  /** Operator margin, as a fraction in [0, 1]. */
  margin: number
  /** Fixed operator cost per epoch, in lovelace. */
  fixedCost: string
  /** Declared pledge, in lovelace. */
  pledge: string
  /** Pledge actually met by owner stake right now, in lovelace. */
  livePledge: string
  /** Active (epoch-snapshot) stake, in lovelace. */
  activeStake: string
  /** Live stake, in lovelace. */
  liveStake: string
  /** Fraction of the saturation cap, where 1.0 is fully saturated. */
  saturation: number
  /** Number of live delegators. */
  liveDelegators: number
  /** Lifetime blocks minted. */
  blocksMinted: number
  /** Off-chain metadata, when the pool registered any. */
  metadata?: PoolMetadata
}

/**
 * Where a token's display metadata was resolved from, in preference order.
 *
 * The type is derived from the array so the two cannot drift: anything that needs the set
 * at runtime (a test asserting a live asset resolved from a known source, for instance)
 * reads this rather than restating the members.
 */
export const TOKEN_SOURCES = ['registry', 'cip25', 'cip68', 'none'] as const

export type TokenMetadataSource = (typeof TOKEN_SOURCES)[number]

/**
 * Normalized metadata for a native token. On-chain basics (fingerprint, supply, names)
 * always apply. Display fields (name, ticker, description, decimals, url, image) are
 * resolved with the CIP-26 off-chain token registry preferred, then CIP-25 on-chain mint
 * metadata (the usual NFT case), then a CIP-68 reference-token datum; `source` says which
 * supplied them.
 *
 * Editorial curation the closed backend layered on top (scam/verified status, an
 * "application" category, a display symbol) is not chain data and is intentionally not
 * produced here. `image` is a pointer (e.g. an ipfs:// or https URL), not image bytes: the
 * bytes are served from a separate media surface, and the registry's base64 logo is not
 * inlined.
 */
export interface TokenMetadata {
  /** CIP-26 subject: policy id concatenated with the hex asset name. */
  subject: string
  /** Policy id (hex). */
  policyId: string
  /** Asset name (hex). */
  assetName: string
  /** Asset name decoded as ASCII, when it is printable. */
  assetNameAscii?: string
  /** CIP-14 asset fingerprint (asset1...). */
  fingerprint: string
  /** Total supply across all mints/burns, as a string. */
  supply: string
  /** Which metadata source supplied the display fields below. */
  source: TokenMetadataSource
  /** Human-readable name. */
  name?: string
  /** Ticker (registry or CIP-68). */
  ticker?: string
  /** Description. */
  description?: string
  /** Decimal places (registry or CIP-68). */
  decimals?: number
  /** Project URL (registry or CIP-68). */
  url?: string
  /** Image pointer (URL/URI), from CIP-25 or CIP-68 metadata. Not image bytes. */
  image?: string
}

/**
 * Registration lifecycle of a DRep. Normalized like `PoolStatus`, so the contract does not
 * hand clients a provider's own vocabulary.
 */
export type DrepStatus = 'registered' | 'deregistered' | 'not_registered'

/**
 * Normalized info for a delegate representative (DRep). Off-chain metadata (the DRep's
 * name/bio, CIP-119) is not resolved here; `metadataUrl`/`metadataHash` point at it so a
 * client or a later hydration step can fetch it. Lovelace values are strings.
 */
export interface DrepInfo {
  /**
   * Bech32 DRep id, always in the CIP-129 form (`drep1...`, a 1-byte header plus the
   * credential), which is the current standard. The deprecated CIP-105 form is still
   * accepted on requests, but it is not what gets emitted here.
   */
  drepId: string
  /** The DRep's 28-byte credential, as hex. Identical across both id encodings. */
  hex: string
  /** Whether the DRep credential is a script. */
  hasScript: boolean
  /** Registration lifecycle. */
  status: DrepStatus
  /** Whether the DRep is currently active (not expired). */
  active: boolean
  /** Registration deposit, in lovelace. */
  deposit: string
  /** Voting power: total lovelace delegated to this DRep. */
  votingPower: string
  /** Epoch the DRep's registration expires in, if set. */
  expiresEpoch?: number
  /** URL of the DRep's off-chain (CIP-119) metadata, if any. */
  metadataUrl?: string
  /** Hash of the DRep's off-chain metadata, if any. */
  metadataHash?: string
}

/** Query for a page of the DRep list. */
export interface DrepListParams {
  /** Maximum DReps to return. */
  limit: number
  /** How many DReps to skip, for paging. */
  offset: number
}

/** Query for a page of the stake-pool list. */
export interface PoolListParams {
  /** Maximum pools to return. */
  limit: number
  /** How many pools to skip, for paging. */
  offset: number
  /** Case-insensitive ticker substring filter, when present. */
  ticker?: string
}

/** Confirmation status for a submitted transaction. */
export interface TxStatus {
  /** Whether the transaction has been seen on chain. */
  seen: boolean
  /** Number of confirmations (blocks on top), 0 if seen but not yet confirmed. */
  confirmations: number
}

/** Stake-account level state: balance, rewards, and current delegations. */
export interface AccountState {
  /** Bech32 stake address. */
  stakeAddress: string
  /** Whether the stake key is registered on chain. */
  registered: boolean
  /** Total controlled lovelace (UTxO plus withdrawable rewards), as a string. */
  balance: string
  /** Rewards available to withdraw right now, as a string. */
  rewardsAvailable: string
  /** Lifetime rewards ever earned by the account (withdrawn plus available), as a string. */
  rewardsSum: string
  /** Lifetime rewards ever withdrawn from the account, as a string. */
  withdrawalsSum: string
  /** Pool the account currently delegates to (bech32), if any. */
  delegatedPool?: string
  /** DRep the account currently delegates its vote to, if any. */
  delegatedDrep?: string
}
