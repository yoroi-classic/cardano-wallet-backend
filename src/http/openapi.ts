/**
 * The API contract, as OpenAPI 3.1, served at `/v1/openapi.json`.
 *
 * This exists because two clients (the browser extension and the mobile app) are being written
 * against this surface right now, and until this file existed the only way to learn the response
 * shapes was to read TypeScript interfaces across seven files in a repository the client authors
 * do not work in. A contract nobody outside the team can read is not a contract.
 *
 * ## It cannot silently drift
 *
 * A hand-written spec normally rots: the code changes, the document does not, and it quietly
 * becomes a lie that is worse than no document at all, because people trust it. Two tests stop
 * that (see test/http/openapi.test.ts):
 *
 *   - every route the server registers appears here, and every path here is a route the server
 *     registers. Add an endpoint without documenting it and the suite fails.
 *   - real responses, produced by the real handlers, are validated against the schemas below.
 *     Change a field name and the suite fails.
 *
 * So this is checked against the implementation rather than merely describing it.
 *
 * ## Money is a string
 *
 * Every lovelace amount, every token quantity, and every voting-power figure is a **decimal
 * string**, not a number. This is not fussiness. A lovelace value can exceed 2^53, at which point
 * JSON.parse silently rounds it: 7682048683977123456 becomes 7682048683977124000, and that is a
 * wrong-but-plausible balance shown to a user. Clients must parse these with BigInt, never
 * Number.
 */

const LOVELACE = {
  type: 'string',
  pattern: '^\\d+$',
  description:
    'A lovelace amount as a decimal string. Parse with BigInt, never Number: values can exceed 2^53.',
} as const

const HEX = (bytes: number, description: string) =>
  ({
    type: 'string',
    pattern: `^[0-9a-fA-F]{${bytes * 2}}$`,
    description,
  }) as const

const ERROR_RESPONSE = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'UPSTREAM_ERROR',
            'UPSTREAM_TIMEOUT',
            'UPSTREAM_MALFORMED',
            'BAD_REQUEST',
            'RATE_LIMITED',
            'NOT_FOUND',
            // Two different kinds of "not right now", and a client should act on them
            // differently. NOT_IMPLEMENTED (501): the endpoint is reserved but unbuilt, and no
            // configuration will change that. FEATURE_UNAVAILABLE (503): it is built, but this
            // deployment was not given an optional credential for it (see /v1/assets/media).
            'NOT_IMPLEMENTED',
            'FEATURE_UNAVAILABLE',
            'CONFIG_ERROR',
            'INTERNAL',
          ],
        },
        message: { type: 'string' },
      },
    },
  },
} as const

/** The error responses every endpoint can return, so they are not repeated on each one. */
const COMMON_ERRORS = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '502': { $ref: '#/components/responses/UpstreamError' },
  '504': { $ref: '#/components/responses/UpstreamTimeout' },
} as const

/**
 * Every price endpoint carries this warning: what it returns, and what it refuses to.
 */
const PRICE_DESCRIPTION =
  'Sourced from CoinGecko (ADA fiat price and history) and GeckoTerminal (native-token price and ' +
  'history, in ADA). Price is the one domain in this API with no on-chain source, so a real ' +
  'market-data provider sits behind it rather than Koios or Blockfrost.\n\n' +
  '**It never returns a price of zero, null, or a placeholder, and it never will.** A wallet ' +
  'handed a `0` renders a portfolio worth $0.00, and the user cannot tell "the market crashed" ' +
  'from "the data didn\'t arrive". One of those is a reason to panic-sell. If the upstream ' +
  'provider fails, this answers `502`/`504`, never a guessed number.\n\n' +
  'A deployment with no price provider wired (a bare test harness; never a real deployment, since ' +
  'neither upstream needs a credential to work) answers `501` instead, with the same guarantee: ' +
  'still never a fake price.'

const jsonBody = (schema: object) => ({ content: { 'application/json': { schema } } })

const jsonResponse = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
})

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'cardano-wallet-backend',
    version: '1',
    description:
      'A provider-agnostic data backend for a Cardano wallet. One stable HTTP surface, served ' +
      'from any configured data source, so the wallet never has to know where the data came from.\n\n' +
      '**Every lovelace amount and token quantity is a decimal string, not a number.** Values can ' +
      'exceed 2^53, where JSON numbers silently lose precision and produce a wrong-but-plausible ' +
      'balance. Parse them with BigInt.\n\n' +
      'Errors are always `{ "error": { "code", "message" } }`.',
    license: { name: 'Apache-2.0' },
  },
  servers: [{ url: '/', description: 'This instance' }],

  tags: [
    { name: 'service', description: 'Liveness and status' },
    { name: 'chain', description: 'Tip and protocol parameters' },
    { name: 'account', description: 'Stake-account state, UTxOs, and history' },
    {
      name: 'addresses',
      description:
        'Address discovery, and reads keyed by an address set for wallets with no ' +
        'resolvable stake credential (Byron, enterprise, pointer).',
    },
    { name: 'assets', description: 'Native token and NFT metadata' },
    { name: 'pools', description: 'Stake pools' },
    { name: 'governance', description: 'DReps and governance actions' },
    { name: 'price', description: 'Price and market data, from CoinGecko and GeckoTerminal.' },
    { name: 'tx', description: 'Submit, status, and output lookups' },
  ],

  paths: {
    '/health': {
      get: {
        tags: ['service'],
        operationId: 'health',
        summary: 'Liveness',
        description:
          'For an orchestrator, not a wallet. Makes no upstream call and answers instantly: a ' +
          'load balancer asking whether the process is alive must not be told no merely because ' +
          'the chain data source is slow. Use /v1/status to learn whether the data is any good.',
        responses: {
          '200': jsonResponse('Alive', {
            type: 'object',
            required: ['status', 'service'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              service: { type: 'string' },
            },
          }),
        },
      },
    },

    '/v1/chain/tip': {
      get: {
        tags: ['chain'],
        operationId: 'getTip',
        summary: 'Current chain tip',
        responses: {
          '200': jsonResponse('The tip', { $ref: '#/components/schemas/Tip' }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/chain/protocol-params': {
      get: {
        tags: ['chain'],
        operationId: 'getProtocolParams',
        summary: 'Protocol parameters for the current epoch',
        description:
          'What a transaction builder needs to compute a fee and a minimum UTxO value. Cached ' +
          'on the epoch number, so it is one upstream read per epoch rather than per request.',
        responses: {
          '200': jsonResponse('Normalized protocol parameters', {
            $ref: '#/components/schemas/ProtocolParams',
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/account/{stakeAddress}/state': {
      get: {
        tags: ['account'],
        operationId: 'getAccountState',
        summary: 'Balance, rewards, and current delegations',
        description:
          'The stake key is the whole wallet: one call covers every address derived under it. ' +
          '`delegatedDrep` is the account voting state, so no separate governance call is needed.\n\n' +
          'Never cached. A stale balance handed to a wallet that is about to build a transaction ' +
          'produces a failed submission.',
        parameters: [{ $ref: '#/components/parameters/StakeAddress' }],
        responses: {
          '200': jsonResponse('Account state', { $ref: '#/components/schemas/AccountState' }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/account/{stakeAddress}/utxos': {
      get: {
        tags: ['account'],
        operationId: 'getAccountUtxos',
        summary: 'Every UTxO the account controls, in one call',
        description:
          'The whole wallet, not one address. Includes native assets and inline datums, which ' +
          'the Midnight escrow path depends on.\n\n' +
          'Provider-specific limit: when served by the Blockfrost provider, an account holding ' +
          'more than 5,000 UTxOs (far outside any real wallet) answers `502 UPSTREAM_ERROR` ' +
          'rather than a silently truncated set; exactly 5,000 is returned in full. Other ' +
          'providers, including Koios, do not impose this bound.\n\nNever cached.',
        parameters: [{ $ref: '#/components/parameters/StakeAddress' }],
        responses: {
          '200': jsonResponse('UTxOs', {
            type: 'array',
            items: { $ref: '#/components/schemas/Utxo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/account/{stakeAddress}/txs': {
      get: {
        tags: ['account'],
        operationId: 'getTxHistory',
        summary: 'Transaction history, oldest first',
        description:
          'Page forward with `after`, set to the `block` of the last transaction you saw. A page ' +
          'is never cut through the middle of a block: if a block holds more transactions than ' +
          'fit, the page is extended to the block boundary rather than truncated, so paging on ' +
          '`block` cannot skip one.\n\nNever cached.',
        parameters: [
          { $ref: '#/components/parameters/StakeAddress' },
          {
            name: 'after',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0 },
            description: 'Return transactions in blocks after this height.',
          },
        ],
        responses: {
          '200': jsonResponse('Transactions, oldest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/WalletTransaction' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/addresses/filter-used': {
      post: {
        tags: ['addresses'],
        operationId: 'filterUsedAddresses',
        summary: 'Which of these addresses have been seen on chain',
        description:
          'Drives address discovery (the gap-limit scan). Returns the used subset, in the order ' +
          'you sent them.\n\n' +
          'Accepts bech32 payment addresses (base, pointer, enterprise), Byron base58 addresses, ' +
          'and bech32 `addr_vkh` payment-key hashes, mixed freely in one call. Payment-key hashes ' +
          'are queried as credentials, not interpreted as full addresses. Each entry is validated ' +
          'independently, so a mixed batch is only rejected if one entry is malformed.',
        requestBody: jsonBody({
          type: 'object',
          required: ['addresses'],
          properties: {
            addresses: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 1000,
            },
          },
        }),
        responses: {
          '200': jsonResponse('The used subset, in input order', {
            type: 'array',
            items: { type: 'string' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/addresses/utxos': {
      post: {
        tags: ['addresses'],
        operationId: 'getUtxosByAddresses',
        summary: 'Every UTxO controlled by a set of addresses, in one call',
        description:
          'The address-keyed sibling of /v1/account/{stakeAddress}/utxos, for wallets whose ' +
          'addresses carry no resolvable stake credential: Byron, enterprise, and pointer ' +
          'addresses are all on that side of the line. A base Shelley wallet, which can derive ' +
          'a stake key from any of its addresses, should prefer the account endpoint instead: ' +
          'it reads the whole wallet in one call rather than needing every address enumerated.' +
          '\n\n' +
          'Accepts the same address formats as filter-used, mixed freely.\n\nNever cached.',
        requestBody: jsonBody({
          type: 'object',
          required: ['addresses'],
          properties: {
            addresses: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 1000,
            },
          },
        }),
        responses: {
          '200': jsonResponse('UTxOs across the given addresses', {
            type: 'array',
            items: { $ref: '#/components/schemas/Utxo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/addresses/txs': {
      post: {
        tags: ['addresses'],
        operationId: 'getTxHistoryByAddresses',
        summary: 'Transaction history for a set of addresses, oldest first',
        description:
          'The address-keyed sibling of /v1/account/{stakeAddress}/txs, for the same wallets ' +
          '/v1/addresses/utxos serves. A transaction touching more than one of the given ' +
          'addresses (a self-transfer within the same wallet, most commonly) appears exactly ' +
          'once, not once per matching address.\n\n' +
          'Page forward with `after`, set to the `block` of the last transaction you saw, the ' +
          'same cursor the account endpoint uses. A page is never cut through the middle of a ' +
          'block.\n\nAccepts the same address formats as filter-used, mixed freely.\n\n' +
          'Never cached.',
        requestBody: jsonBody({
          type: 'object',
          required: ['addresses'],
          properties: {
            addresses: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 1000,
            },
            after: {
              type: 'integer',
              minimum: 0,
              description: 'Return transactions in blocks after this height.',
            },
          },
        }),
        responses: {
          '200': jsonResponse('Transactions across the given addresses, oldest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/WalletTransaction' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/assets/info': {
      post: {
        tags: ['assets'],
        operationId: 'getTokenMetadata',
        summary: 'Token and NFT metadata for a batch of subjects',
        description:
          "A `subject` is `policyId + assetNameHex` (the asset name may be empty: a policy's " +
          'unnamed asset is a real token).\n\n' +
          'Metadata is resolved from the first source that has it, and `source` says which one ' +
          'won: the CIP-26 off-chain registry, then CIP-25 mint metadata, then a CIP-68 datum, ' +
          'then `none`. Order matters, because the registry is curated and a datum is written by ' +
          'whoever minted the token.\n\n' +
          'Unknown subjects are simply absent from the response, so it may be shorter than the ' +
          'request. Results come back in the order you asked.\n\n' +
          'No image bytes: `image` is a URI (often `ipfs://`). Media is a separate surface.',
        requestBody: jsonBody({
          type: 'object',
          required: ['subjects'],
          properties: {
            subjects: {
              type: 'array',
              items: { type: 'string', description: 'policyId + assetNameHex, hex' },
              minItems: 1,
              maxItems: 100,
            },
          },
        }),
        responses: {
          '200': jsonResponse('Metadata, in input order, unknown subjects omitted', {
            type: 'array',
            items: { $ref: '#/components/schemas/TokenMetadata' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/pools': {
      get: {
        tags: ['pools'],
        operationId: 'getPoolList',
        summary: 'Stake pools, by active stake, largest first',
        description:
          'Neutral and unranked by us: the order is active stake and nothing else. No promoted ' +
          'pool, no house pool, no undisclosed ranking.\n\n' +
          '`activeStake` is the epoch snapshot the ranking was computed from, so a page is ' +
          'internally consistent. `liveStake`, `saturation` and `liveDelegators` drift ' +
          'continuously and are fetched fresh.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 250, default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          },
          {
            name: 'ticker',
            in: 'query',
            schema: { type: 'string', pattern: '^[A-Za-z0-9]{1,15}$' },
            description: 'Case-insensitive substring match on the pool ticker.',
          },
        ],
        responses: {
          '200': jsonResponse('Pools, largest active stake first', {
            type: 'array',
            items: { $ref: '#/components/schemas/PoolInfo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/pools/info': {
      post: {
        tags: ['pools'],
        operationId: 'getPoolInfo',
        summary: 'Pool info for a batch of pool ids',
        description:
          'Ids are bech32 (`pool1…`) and are checksum-verified. Unknown pools are absent from ' +
          'the response; results come back in input order.',
        requestBody: jsonBody({
          type: 'object',
          required: ['poolIds'],
          properties: {
            poolIds: {
              type: 'array',
              items: { type: 'string', pattern: '^pool1[0-9a-z]+$' },
              minItems: 1,
              maxItems: 100,
            },
          },
        }),
        responses: {
          '200': jsonResponse('Pools, in input order, unknown ids omitted', {
            type: 'array',
            items: { $ref: '#/components/schemas/PoolInfo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/governance/dreps': {
      get: {
        tags: ['governance'],
        operationId: 'getDrepList',
        summary: 'Registered DReps, ordered by id',
        description:
          'Unbiased, and deliberately so. The order is the DRep id and nothing else: no ranking ' +
          'by voting power, no promoted DRep, and no house DRep. A client is free to pin the ' +
          "user's own DRep to the top; the list itself does not.\n\n" +
          'Only registered DReps appear here. Use /v1/governance/dreps/info to look one up by id, ' +
          'including one that has deregistered or never existed.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 250, default: 50 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', minimum: 0, maximum: 19750, default: 0 },
          },
        ],
        responses: {
          '200': jsonResponse('Registered DReps, ordered by id', {
            type: 'array',
            items: { $ref: '#/components/schemas/DrepInfo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/governance/dreps/info': {
      post: {
        tags: ['governance'],
        operationId: 'getDrepInfo',
        summary: 'DRep info for a batch of ids',
        description:
          'Accepts both the current CIP-129 id (`drep1…` with a header byte) and the deprecated ' +
          'CIP-105 form. The response always uses CIP-129.\n\n' +
          'A DRep the chain has never heard of comes back with `status: "not_registered"` rather ' +
          'than being dropped, so a caller can tell an unknown DRep apart from a failed lookup. ' +
          'That matters when validating a DRep id a user has pasted in.',
        requestBody: jsonBody({
          type: 'object',
          required: ['drepIds'],
          properties: {
            drepIds: {
              type: 'array',
              items: { type: 'string', description: 'bech32 DRep id, CIP-129 or CIP-105' },
              minItems: 1,
              maxItems: 100,
            },
          },
        }),
        responses: {
          '200': jsonResponse('DReps, in input order', {
            type: 'array',
            items: { $ref: '#/components/schemas/DrepInfo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/tx/submit': {
      post: {
        tags: ['tx'],
        operationId: 'submitTx',
        summary: 'Submit a signed transaction',
        description:
          'The body is the full signed transaction as CBOR hex.\n\n' +
          '**Never retried, at any layer.** A transaction that actually landed but whose response ' +
          'was garbled would, if resent, be a double-spend. A failed submit means it may or may ' +
          'not have reached the chain: poll /v1/tx/{txHash}/status rather than resubmitting.',
        requestBody: jsonBody({
          type: 'object',
          required: ['cbor'],
          properties: {
            cbor: { type: 'string', pattern: '^([0-9a-fA-F]{2})+$', description: 'CBOR hex' },
          },
        }),
        responses: {
          '200': jsonResponse('Accepted by the node', {
            type: 'object',
            required: ['txHash'],
            properties: { txHash: HEX(32, 'The transaction id') },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/tx/{txHash}/status': {
      get: {
        tags: ['tx'],
        operationId: 'getTxStatus',
        summary: 'Provider-neutral transaction lifecycle',
        description:
          '`pending` is a positive mempool observation. `unknown` means the provider cannot ' +
          'distinguish propagation, eviction, rejection, or expiry; absence is never treated as ' +
          'terminal evidence. Clients **must retain their pending overlay** for both states. ' +
          '`confirmed` tells a client to refresh authoritative UTxOs and reconcile the overlay. ' +
          'Only `rejected` or `expired`, each with a stable sanitized terminal code, permits a ' +
          'rollback.\n\n' +
          'Provider limits: Koios exposes only on-chain confirmation depth, so an unconfirmed ' +
          'hash is `unknown`. Hosted Blockfrost can positively report transactions submitted ' +
          'through its own mempool as `pending`; a mempool miss is still `unknown`. Neither ' +
          'provider currently exposes durable proof of rejection or enough signed validity data ' +
          'after mempool eviction to prove expiry, so neither invents those terminal states.\n\n' +
          'Never cached.',
        parameters: [
          {
            name: 'txHash',
            in: 'path',
            required: true,
            schema: HEX(32, 'Transaction id'),
          },
        ],
        responses: {
          '200': jsonResponse('Status', { $ref: '#/components/schemas/TxStatus' }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/status': {
      get: {
        tags: ['service'],
        operationId: 'getStatus',
        summary: 'Service status, and whether the chain data can be trusted',
        description:
          'For the wallet, where /health is for the orchestrator. This one *does* reach upstream.\n\n' +
          'It answers `200` even when the chain source is unreachable, reporting `chain: "down"`. ' +
          'That is deliberate: a client must be able to tell "the backend is unreachable" (show a ' +
          'network error) apart from "the backend is up but its data source is not" (show a ' +
          'maintenance notice), and a 5xx here would collapse those into one. The tip read is ' +
          'cached, so polling this costs nothing upstream.',
        responses: {
          '200': jsonResponse('Status', { $ref: '#/components/schemas/Status' }),
        },
      },
    },

    '/v1/account/{stakeAddress}/rewards': {
      get: {
        tags: ['account'],
        operationId: 'getRewardHistory',
        summary: 'Every reward the account has earned, oldest first',
        description:
          'The rewards graph. The whole history rather than a total, because the total is already ' +
          '`rewardsSum` on /v1/account/{stake}/state, and a total cannot reconstruct a shape.\n\n' +
          '**`after` pages on `earnedEpoch`, not `spendableEpoch`.** Cardano pays rewards two ' +
          'epochs in arrears, so the two differ by about ten days. Paging on the wrong one shifts ' +
          'every point on the graph by that much and still looks entirely plausible.\n\n' +
          'Never cached.',
        parameters: [
          { $ref: '#/components/parameters/StakeAddress' },
          {
            name: 'after',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0 },
            description: 'Return rewards earned in epochs after this one.',
          },
        ],
        responses: {
          '200': jsonResponse('Rewards, oldest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/AccountReward' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/tx/utxos': {
      post: {
        tags: ['tx'],
        operationId: 'getUtxosByRef',
        summary: 'Resolve transaction outputs by reference',
        description:
          'A different question from /v1/account/{stake}/utxos, which asks "what does this wallet ' +
          'control" and so only ever answers with **unspent** outputs. This asks "what is at this ' +
          'reference", and the answer says whether it is still there.\n\n' +
          '**That `spent` flag is the point of the endpoint.** Collateral must be an unspent ' +
          'output: a wallet that reuses one it set aside earlier, without re-checking, builds a ' +
          'transaction the node rejects and the user sees an unexplained failure. A dApp connector ' +
          "resolving a transaction's inputs needs to see them whether or not they survive.\n\n" +
          'References that are not on chain are simply absent from the result, so it can be ' +
          'shorter than the request. Order follows the input. Never cached.',
        requestBody: jsonBody({
          type: 'object',
          required: ['refs'],
          properties: {
            refs: {
              type: 'array',
              items: {
                type: 'string',
                pattern:
                  '^[0-9a-fA-F]{64}#(?:[0-9]{1,4}|0[0-9]{4}|[12][0-9]{4}|3[01][0-9]{3}|32[0-6][0-9]{2}|327[0-5][0-9]|3276[0-7])$',
                description:
                  'An output reference: `<txHash>#<outputIndex>`, where outputIndex is 0..32767 (leading zeros are accepted).',
              },
              minItems: 1,
              maxItems: 100,
            },
          },
        }),
        responses: {
          '200': jsonResponse('Resolved outputs, in input order, unknown refs omitted', {
            type: 'array',
            items: { $ref: '#/components/schemas/ResolvedUtxo' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/assets/media': {
      post: {
        tags: ['assets'],
        operationId: 'getAssetMedia',
        summary: 'Signed, resized media URLs for a batch of assets',
        description:
          '**Use this for a gallery, not the redirect below.** One call covers up to 100 assets. ' +
          'A redirect per tile would mean one request to us for every thumbnail on the screen, ' +
          'which at the default anonymous rate limit means a single scroll very nearly exhausts a ' +
          "user's whole budget, and it puts us in the path of every image for no purpose.\n\n" +
          'The signing key never leaves the backend: a key shipped inside an app or extension ' +
          'would be extracted within the hour, and whoever pulled it could serve their own ' +
          'bandwidth on our account.\n\n' +
          'The provider serves **powers of two only** (32 to 1024). A requested `size` is rounded ' +
          '**up** to one that exists (so 720, which the wallets ask for, becomes 1024), and the ' +
          'response reports the size *actually served* so a client can lay out against real ' +
          'dimensions. Rounding down would hand you an image to upscale, and the user would see a ' +
          'blurry tile and conclude the wallet is broken.\n\n' +
          'Answers `503 FEATURE_UNAVAILABLE` when the deployment has no media credential. The raw ' +
          'on-chain image URI is still on /v1/assets/info, and a client may resolve it through a ' +
          'gateway of its own.',
        requestBody: jsonBody({
          type: 'object',
          required: ['fingerprints'],
          properties: {
            fingerprints: {
              type: 'array',
              items: { type: 'string', pattern: '^asset1[0-9a-z]+$' },
              minItems: 1,
              maxItems: 100,
              description: 'CIP-14 asset fingerprints.',
            },
            size: {
              type: 'integer',
              minimum: 1,
              maximum: 4096,
              description: 'Omit for the original, which may be large, animated, or an SVG.',
            },
          },
        }),
        responses: {
          '200': jsonResponse('Signed media URLs, in input order', {
            type: 'array',
            items: { $ref: '#/components/schemas/AssetMedia' },
          }),
          '503': { $ref: '#/components/responses/FeatureUnavailable' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/assets/{fingerprint}/image': {
      get: {
        tags: ['assets'],
        operationId: 'getAssetImage',
        summary: 'Redirect to a signed, resized image',
        description:
          'A convenience for a **single** asset (a detail screen, a link preview), where being ' +
          'able to drop a stable URL into an `<img src>` is worth one extra hop.\n\n' +
          '**Do not use this for a gallery.** Use POST /v1/assets/media, which signs a hundred at ' +
          'once. See the note there.\n\n' +
          'A `302`, never a `301`: the signature is temporary and dies with the key, and a client ' +
          'that cached a permanent redirect would show a broken image long after a key rotation.',
        parameters: [
          {
            name: 'fingerprint',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^asset1[0-9a-z]+$' },
          },
          {
            name: 'size',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 4096 },
            description: 'Rounded up to a size the provider serves. See POST /v1/assets/media.',
          },
        ],
        responses: {
          '302': { description: 'Redirect to the signed media URL' },
          '503': { $ref: '#/components/responses/FeatureUnavailable' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/price/ada': {
      get: {
        tags: ['price'],
        operationId: 'getAdaPrice',
        summary: 'ADA price, in each requested currency',
        description: PRICE_DESCRIPTION,
        parameters: [
          {
            name: 'currencies',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Comma-separated currency codes, e.g. `USD,EUR,JPY`. 1 to 20.',
          },
        ],
        responses: {
          '200': jsonResponse('The quote', { $ref: '#/components/schemas/AdaPrice' }),
          '501': { $ref: '#/components/responses/NotImplemented' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/price/ada/history': {
      get: {
        tags: ['price'],
        operationId: 'getAdaPriceHistory',
        summary: 'ADA price history, as candles',
        description: PRICE_DESCRIPTION,
        parameters: [
          {
            name: 'range',
            in: 'query',
            schema: { type: 'string', enum: ['1d', '1w', '1m', '6m', '1y', 'all'], default: '1m' },
          },
          { name: 'currency', in: 'query', schema: { type: 'string', default: 'USD' } },
        ],
        responses: {
          '200': jsonResponse('Candles, oldest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/Ohlc' },
          }),
          '501': { $ref: '#/components/responses/NotImplemented' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/price/tokens': {
      post: {
        tags: ['price'],
        operationId: 'getTokenActivity',
        summary: 'Price and activity for a batch of native tokens',
        description: PRICE_DESCRIPTION,
        requestBody: jsonBody({
          type: 'object',
          required: ['subjects'],
          properties: {
            subjects: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
            window: { type: 'string', enum: ['24h', '7d', '30d'], default: '24h' },
          },
        }),
        responses: {
          '200': jsonResponse('Activity, in input order', {
            type: 'array',
            items: { $ref: '#/components/schemas/TokenActivity' },
          }),
          '501': { $ref: '#/components/responses/NotImplemented' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/price/tokens/history': {
      post: {
        tags: ['price'],
        operationId: 'getTokenPriceHistory',
        summary: 'Price history for one native token, as candles',
        description: PRICE_DESCRIPTION,
        requestBody: jsonBody({
          type: 'object',
          required: ['subject'],
          properties: {
            subject: { type: 'string', description: 'policyId + assetNameHex' },
            range: {
              type: 'string',
              enum: ['1d', '1w', '1m', '6m', '1y', 'all'],
              default: '1m',
            },
          },
        }),
        responses: {
          '200': jsonResponse('Candles, oldest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/Ohlc' },
          }),
          '501': { $ref: '#/components/responses/NotImplemented' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/governance/proposals': {
      get: {
        tags: ['governance'],
        operationId: 'getProposals',
        summary: 'Conway governance actions, newest first',
        description:
          'With the vote tallies as they stand, because a proposal without them is not something ' +
          'a user can act on: "should I vote on this?" is answered by where the vote currently ' +
          'sits, not by the text alone.\n\n' +
          "`status` is **derived for you**. Upstream expresses a proposal's fate as four separate " +
          'nullable epoch fields, and every client reimplementing the same precedence rules is ' +
          'every client getting them subtly differently. Note that `enacted` outranks `ratified`: ' +
          'a proposal is ratified first and enacted afterwards.\n\n' +
          '**Check `metadataValid` before showing `title` or `abstract` to a user.** Those are ' +
          'attacker-supplied text that someone reads immediately before voting. `false` means the ' +
          'off-chain document did not match the hash anchored on chain; **absent means we do not ' +
          'know**, which is not the same as `false`.\n\n' +
          'A proposal whose tally could not be fetched still appears, without one. A missing ' +
          'progress bar is a nuisance; a governance screen that will not load is not.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
          },
        ],
        responses: {
          '200': jsonResponse('Proposals, newest first', {
            type: 'array',
            items: { $ref: '#/components/schemas/Proposal' },
          }),
          ...COMMON_ERRORS,
        },
      },
    },
    '/v1/config': {
      get: {
        tags: ['service'],
        operationId: 'getConfig',
        summary: 'Client remote configuration',
        description:
          'Feature flags, the dApp list, and whatever else the clients read at launch. Replaces ' +
          'the clients fetching a JSON file straight from a git host.\n\n' +
          'The document is served **as published**, with no transformation, so its shape is the ' +
          "config repository's business and not this API's. Treat it as opaque JSON.\n\n" +
          'Two things this endpoint is actually for. It means the config comes from **our** fork ' +
          'rather than a repository we do not control, where whoever owns the file owns what your ' +
          'users see. And it means a wallet does not hand its IP to a third-party git host on ' +
          'every single launch.\n\n' +
          'Cached hard, and served stale for up to a day if a refresh fails: a wallet that cannot ' +
          'finish starting because a CDN is having a bad morning is a bad wallet.',
        responses: {
          '200': jsonResponse('The published config document, verbatim', {
            type: 'object',
            additionalProperties: true,
          }),
          '503': { $ref: '#/components/responses/FeatureUnavailable' },
          ...COMMON_ERRORS,
        },
      },
    },

    '/v1/openapi.json': {
      get: {
        tags: ['service'],
        operationId: 'getOpenapi',
        summary: 'This document',
        responses: {
          '200': jsonResponse('The OpenAPI document', { type: 'object' }),
        },
      },
    },
  },

  components: {
    parameters: {
      StakeAddress: {
        name: 'stakeAddress',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^stake(_test)?1[0-9a-z]+$' },
        description: 'Bech32 stake address. Identifies the whole wallet.',
      },
    },

    responses: {
      BadRequest: jsonResponse('The request was malformed', ERROR_RESPONSE),
      RateLimited: jsonResponse('Too many requests', ERROR_RESPONSE),
      UpstreamError: jsonResponse(
        'The chain data source failed or answered with something we could not parse',
        ERROR_RESPONSE,
      ),
      UpstreamTimeout: jsonResponse('The chain data source did not answer in time', ERROR_RESPONSE),
      NotImplemented: jsonResponse(
        'No price provider is configured for this deployment. The price routes are live and their ' +
          'contract is final; this is the answer only when the deployment has wired no market-data ' +
          'provider. Never a fake value: render the field as unavailable.',
        ERROR_RESPONSE,
      ),
      FeatureUnavailable: jsonResponse(
        'Built, but this deployment has no credential for the optional upstream it needs. ' +
          'Degrade (a placeholder image) rather than retrying or abandoning the endpoint.',
        ERROR_RESPONSE,
      ),
    },

    schemas: {
      Error: ERROR_RESPONSE,

      Status: {
        type: 'object',
        required: ['version', 'network', 'provider', 'serverTime', 'chain'],
        properties: {
          version: { type: 'string', description: 'Which build you are talking to.' },
          network: {
            type: 'string',
            enum: ['mainnet', 'preprod', 'preview', 'unknown'],
            description: 'A wallet pointed at the wrong network must be able to find out.',
          },
          provider: { type: 'string', description: 'The upstream chain-data source.' },
          serverTime: {
            type: 'integer',
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            example: 1_784_674_800_123,
            description:
              'Unix time in milliseconds when this response was constructed. Present for `ok`, ' +
              '`stale`, and `down`; safe to pass directly to JavaScript `Date` without a seconds-' +
              'to-milliseconds conversion.',
          },
          chain: {
            type: 'string',
            enum: ['ok', 'stale', 'down'],
            description:
              '`ok`: fresh enough to build a transaction against. `stale`: reachable but lagging. ' +
              '`down`: unreachable. A `down` still comes back as HTTP 200, so a client can tell ' +
              'this apart from the backend itself being unreachable.',
          },
          behindSeconds: {
            type: 'integer',
            description: 'How far behind the tip is, from the block time. Absent when chain: down.',
          },
          tip: {
            description: 'Null when the chain source is unreachable.',
            oneOf: [{ $ref: '#/components/schemas/Tip' }, { type: 'null' }],
          },
        },
      },

      AccountReward: {
        type: 'object',
        required: ['earnedEpoch', 'spendableEpoch', 'amount', 'kind'],
        properties: {
          earnedEpoch: {
            type: 'integer',
            description:
              'The epoch the reward was earned *for*. This is the axis to plot a graph against, ' +
              'and the cursor `?after=` pages on.',
          },
          spendableEpoch: {
            type: 'integer',
            description:
              'The epoch it became withdrawable: `earnedEpoch + 2` on the current protocol. ' +
              'Both are here because a graph wants the first and a balance projection wants the ' +
              'second, and they are ten days apart.',
          },
          amount: LOVELACE,
          kind: {
            type: 'string',
            enum: ['member', 'leader', 'treasury', 'reserves', 'refund'],
            description:
              "`member` is a delegator share; `leader` is the pool operator's cut. An operator " +
              'can receive both in the same epoch from the same pool, which is why this is a list ' +
              'rather than a map keyed by epoch.',
          },
          poolId: {
            type: 'string',
            description:
              'The pool that paid it. Absent for treasury, reserves and refunds, which no pool ' +
              'paid.',
          },
        },
      },

      ResolvedUtxo: {
        type: 'object',
        required: ['txHash', 'outputIndex', 'address', 'value', 'assets', 'spent'],
        properties: {
          txHash: HEX(32, 'The transaction that created this output'),
          outputIndex: { type: 'integer', minimum: 0 },
          address: { type: 'string' },
          value: LOVELACE,
          assets: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
          datumHash: { type: 'string' },
          inlineDatum: { type: 'string', description: 'CBOR hex, when the output carries one.' },
          referenceScriptHash: { type: 'string' },
          spent: {
            type: 'boolean',
            description:
              'Whether the output has since been consumed. **Check this before using an output as ' +
              'collateral.** A spent one builds a transaction the node rejects, and the user sees ' +
              'an unexplained failure.',
          },
        },
      },

      AssetMedia: {
        type: 'object',
        required: ['fingerprint', 'image', 'metadata'],
        properties: {
          fingerprint: { type: 'string', pattern: '^asset1[0-9a-z]+$' },
          size: {
            type: 'integer',
            enum: [32, 64, 128, 256, 512, 1024],
            description:
              'The size **actually served**, which is not always the size asked for: the provider ' +
              'serves powers of two, and a request is rounded up. Absent when no size was asked ' +
              'for (the original). Lay out against this, not against what you requested.',
          },
          image: { type: 'string', description: 'A signed, time-limited URL. Do not cache it.' },
          metadata: { type: 'string', description: 'A signed URL for the resolved metadata.' },
        },
      },

      AdaPrice: {
        type: 'object',
        required: ['prices', 'changePercent24h', 'asOf'],
        properties: {
          prices: {
            type: 'object',
            additionalProperties: { type: 'number' },
            description:
              'Price per ADA, keyed by currency code. A JSON number, unlike every ledger amount ' +
              'in this API: a price is not a lovelace quantity and does not need BigInt.',
          },
          changePercent24h: { type: 'object', additionalProperties: { type: 'number' } },
          asOf: {
            type: 'integer',
            description: 'When the quote was taken, unix seconds. A stale price must look stale.',
          },
        },
      },

      Ohlc: {
        type: 'object',
        required: ['time', 'open', 'high', 'low', 'close'],
        properties: {
          time: { type: 'integer', description: 'Start of the candle, unix seconds.' },
          open: { type: 'number' },
          high: { type: 'number' },
          low: { type: 'number' },
          close: { type: 'number' },
        },
      },

      TokenActivity: {
        type: 'object',
        required: ['subject', 'priceAda', 'changePercent', 'volumeAda'],
        properties: {
          subject: { type: 'string', description: 'policyId + assetNameHex.' },
          priceAda: {
            type: 'string',
            description:
              'Price in ADA, as a decimal **string** — unlike the fiat prices above. A long-tail ' +
              'token trades at 1e-9 ADA, and a float would quietly round that away.',
          },
          changePercent: { type: 'number' },
          volumeAda: { type: 'string', description: 'Volume over the window, in ADA.' },
        },
      },

      Tip: {
        type: 'object',
        required: ['block', 'slot', 'epoch', 'hash', 'blockTime'],
        properties: {
          block: { type: 'integer', description: 'Block height' },
          slot: { type: 'integer', description: 'Absolute slot. NOT a unix timestamp.' },
          epoch: { type: 'integer' },
          hash: HEX(32, 'Block hash'),
          blockTime: {
            type: 'integer',
            description:
              'When the tip block was minted, unix seconds. Carried because an absolute slot is ' +
              'NOT a timestamp: converting one needs the era boundaries of whichever network you ' +
              'are on, and getting that wrong yields a plausible number rather than an error.',
          },
        },
      },

      ProtocolParams: {
        type: 'object',
        required: [
          'epoch',
          'minFeeA',
          'minFeeB',
          'maxTxSize',
          'maxBlockBodySize',
          'keyDeposit',
          'poolDeposit',
          'minPoolCost',
          'coinsPerUtxoByte',
          'maxValueSize',
          'collateralPercent',
          'maxCollateralInputs',
          'priceMem',
          'priceStep',
          'maxTxExMem',
          'maxTxExSteps',
          'protocolVersion',
          'costModels',
        ],
        properties: {
          epoch: { type: 'integer' },
          minFeeA: { type: 'integer', description: 'Fee per byte' },
          minFeeB: { type: 'integer', description: 'Fee constant' },
          maxTxSize: { type: 'integer' },
          maxBlockBodySize: { type: 'integer' },
          keyDeposit: LOVELACE,
          poolDeposit: LOVELACE,
          minPoolCost: LOVELACE,
          coinsPerUtxoByte: LOVELACE,
          maxValueSize: { type: 'integer' },
          collateralPercent: { type: 'integer' },
          maxCollateralInputs: { type: 'integer' },
          priceMem: { type: 'number' },
          priceStep: { type: 'number' },
          maxTxExMem: { type: 'string', pattern: '^\\d+$' },
          maxTxExSteps: { type: 'string', pattern: '^\\d+$' },
          protocolVersion: {
            type: 'object',
            required: ['major', 'minor'],
            properties: { major: { type: 'integer' }, minor: { type: 'integer' } },
          },
          costModels: {
            type: 'object',
            description: 'Plutus cost models, keyed by language version. Passed through as-is.',
            additionalProperties: true,
          },
        },
      },

      AccountState: {
        type: 'object',
        required: [
          'stakeAddress',
          'registered',
          'balance',
          'rewardsAvailable',
          'rewardsSum',
          'withdrawalsSum',
        ],
        properties: {
          stakeAddress: { type: 'string' },
          registered: {
            type: 'boolean',
            description:
              'False for a stake key never seen on chain; the account is then all zeros.',
          },
          balance: {
            ...LOVELACE,
            description: 'Controlled lovelace: UTxO plus withdrawable rewards.',
          },
          rewardsAvailable: { ...LOVELACE, description: 'Withdrawable right now.' },
          rewardsSum: { ...LOVELACE, description: 'Lifetime rewards earned.' },
          withdrawalsSum: { ...LOVELACE, description: 'Lifetime rewards withdrawn.' },
          delegatedPool: {
            type: 'string',
            description: 'Bech32 pool id, absent if not delegating.',
          },
          delegatedDrep: {
            type: 'string',
            description:
              'The account voting state: a bech32 DRep id, or `abstain` / `no_confidence`. Absent ' +
              'if the account has not delegated its vote.',
          },
        },
      },

      Asset: {
        type: 'object',
        required: ['policyId', 'assetName', 'quantity'],
        properties: {
          policyId: HEX(28, 'Minting policy id'),
          assetName: {
            type: 'string',
            pattern: '^(?:[0-9a-fA-F]{2}){0,32}$',
            description: 'Hex byte string. May be empty.',
          },
          quantity: { type: 'string', pattern: '^\\d+$', description: 'Parse with BigInt.' },
        },
      },

      Utxo: {
        type: 'object',
        required: ['txHash', 'outputIndex', 'address', 'value', 'assets'],
        properties: {
          txHash: HEX(32, 'The transaction that created this output'),
          outputIndex: { type: 'integer', minimum: 0 },
          address: { type: 'string' },
          value: { ...LOVELACE, description: 'Lovelace held by this output.' },
          assets: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
          datumHash: { type: 'string' },
          inlineDatum: { type: 'string', description: 'CBOR hex, when the output carries one.' },
          referenceScriptHash: { type: 'string' },
        },
      },

      TxIo: {
        type: 'object',
        required: ['value', 'assets'],
        properties: {
          address: { type: 'string' },
          value: LOVELACE,
          assets: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
        },
      },

      Withdrawal: {
        type: 'object',
        required: ['stakeAddress', 'amount'],
        properties: { stakeAddress: { type: 'string' }, amount: LOVELACE },
      },

      TxCertificate: {
        type: 'object',
        required: ['kind', 'index'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'stake_registration',
              'stake_deregistration',
              'stake_delegation',
              'pool_registration',
              'pool_retirement',
              'vote_delegation',
              'drep_registration',
              'drep_update',
              'drep_deregistration',
              'committee_hot_auth',
              'committee_cold_resign',
              'move_instantaneous_rewards',
              'genesis_key_delegation',
              'other',
            ],
            description:
              'Normalized certificate kind, including the full Conway governance set. `other` is ' +
              'a certificate we do not model rather than an error.',
          },
          index: { type: 'integer', description: 'Position within the transaction.' },
        },
      },

      WalletTransaction: {
        type: 'object',
        required: [
          'txHash',
          'block',
          'blockHash',
          'slot',
          'epoch',
          'blockTime',
          'fee',
          'inputs',
          'outputs',
          'withdrawals',
          'certificates',
        ],
        properties: {
          txHash: HEX(32, 'Transaction id'),
          block: { type: 'integer', description: 'Block height. This is the paging cursor.' },
          blockHash: HEX(32, 'Containing block'),
          slot: { type: 'integer' },
          epoch: { type: 'integer' },
          blockTime: { type: 'integer', description: 'Unix seconds.' },
          fee: LOVELACE,
          ttl: { type: 'integer' },
          inputs: { type: 'array', items: { $ref: '#/components/schemas/TxIo' } },
          outputs: { type: 'array', items: { $ref: '#/components/schemas/TxIo' } },
          withdrawals: { type: 'array', items: { $ref: '#/components/schemas/Withdrawal' } },
          certificates: { type: 'array', items: { $ref: '#/components/schemas/TxCertificate' } },
          metadata: {
            description: 'Transaction metadata, passed through as-is. Attacker-controlled.',
          },
        },
      },

      TxStatus: {
        description:
          'Transaction lifecycle plus the safe action for a wallet pending-UTxO overlay. `seen` ' +
          'and `confirmations` remain for backwards compatibility.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'seen', 'confirmations', 'overlayAction'],
            properties: {
              status: { type: 'string', enum: ['unknown', 'pending'] },
              seen: { type: 'boolean', const: false },
              confirmations: { type: 'integer', const: 0 },
              overlayAction: {
                type: 'string',
                const: 'retain',
                description: 'Keep spent inputs hidden and pending change available.',
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'seen', 'confirmations', 'overlayAction'],
            properties: {
              status: { type: 'string', const: 'confirmed' },
              seen: { type: 'boolean', const: true },
              confirmations: {
                type: 'integer',
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                description: 'Blocks on top; zero when included in the current tip block.',
              },
              overlayAction: {
                type: 'string',
                const: 'reconcile',
                description:
                  'Refresh authoritative current-state UTxOs, then remove the incorporated overlay.',
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'seen', 'confirmations', 'overlayAction', 'terminal'],
            properties: {
              status: { type: 'string', const: 'rejected' },
              seen: { type: 'boolean', const: false },
              confirmations: { type: 'integer', const: 0 },
              overlayAction: {
                type: 'string',
                const: 'rollback',
                description: 'Discard the overlay and refresh authoritative current-state UTxOs.',
              },
              terminal: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'reason'],
                properties: {
                  code: { type: 'string', const: 'TX_REJECTED' },
                  reason: {
                    type: 'string',
                    const: 'The transaction was definitively rejected.',
                    description: 'Stable sanitized text, never a raw provider response.',
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'seen', 'confirmations', 'overlayAction', 'terminal'],
            properties: {
              status: { type: 'string', const: 'expired' },
              seen: { type: 'boolean', const: false },
              confirmations: { type: 'integer', const: 0 },
              overlayAction: {
                type: 'string',
                const: 'rollback',
                description: 'Discard the overlay and refresh authoritative current-state UTxOs.',
              },
              terminal: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'reason'],
                properties: {
                  code: { type: 'string', const: 'TX_EXPIRED' },
                  reason: {
                    type: 'string',
                    const: 'The transaction validity interval expired before confirmation.',
                    description: 'Stable sanitized text, never a raw provider response.',
                  },
                },
              },
            },
          },
        ],
      },

      TokenMetadata: {
        type: 'object',
        required: ['subject', 'policyId', 'assetName', 'fingerprint', 'supply', 'source'],
        properties: {
          subject: { type: 'string', description: 'policyId + assetNameHex, lowercase.' },
          policyId: HEX(28, 'Minting policy id'),
          assetName: {
            type: 'string',
            pattern: '^(?:[0-9a-fA-F]{2}){0,32}$',
            description: 'Hex byte string. May be empty.',
          },
          assetNameAscii: {
            type: 'string',
            description: 'Only when the name decodes to text. Absent, never an empty string.',
          },
          fingerprint: { type: 'string', description: 'CIP-14 fingerprint (asset1…).' },
          supply: {
            type: 'string',
            pattern: '^\\d+$',
            description: 'Total supply. Parse with BigInt.',
          },
          source: {
            type: 'string',
            enum: ['registry', 'cip25', 'cip68', 'none'],
            description:
              'Which source the metadata below came from. `none` means the token exists but ' +
              'carries no metadata anywhere: show the fingerprint, not a blank.',
          },
          name: { type: 'string' },
          ticker: { type: 'string' },
          description: { type: 'string' },
          decimals: {
            type: 'integer',
            minimum: 0,
            description: 'Absent means 0 was not asserted.',
          },
          url: { type: 'string' },
          image: {
            type: 'string',
            description: 'A URI, often ipfs://. Never image bytes.',
          },
          traits: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'NFT traits: the collection-specific attributes the minter attached, e.g. ' +
              '`{"background": "Seafoam Green", "accessories": "Spider"}`.\n\n' +
              'An open map, because there is no standard for these. CIP-25 reserves a handful of ' +
              'field names and says nothing about the rest, so the traits *are* whatever is left ' +
              'over. Any schema we invented would be one the minters never agreed to.\n\n' +
              '**No rarity.** "2% of the collection has Spider" cannot be computed from one asset; ' +
              'it needs every asset in the policy, which is an indexing job rather than a request. ' +
              'Absent for a token with no traits, which is most of them.',
          },
        },
      },

      PoolMetadata: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ticker: { type: 'string' },
          homepage: { type: 'string' },
          description: { type: 'string' },
        },
      },

      PoolInfo: {
        type: 'object',
        required: [
          'poolId',
          'poolIdHex',
          'status',
          'margin',
          'fixedCost',
          'pledge',
          'livePledge',
          'activeStake',
          'liveStake',
          'saturation',
          'liveDelegators',
          'blocksMinted',
        ],
        properties: {
          poolId: { type: 'string', pattern: '^pool1[0-9a-z]+$' },
          poolIdHex: HEX(28, 'The same pool id, as hex'),
          status: { type: 'string', enum: ['registered', 'retiring', 'retired'] },
          retiringEpoch: { type: 'integer' },
          margin: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'A fraction, not a percent.',
          },
          fixedCost: LOVELACE,
          pledge: LOVELACE,
          livePledge: LOVELACE,
          activeStake: {
            ...LOVELACE,
            description:
              'The epoch snapshot the ranking is computed from, so a page of /v1/pools is ' +
              'consistent with its own order.',
          },
          liveStake: { ...LOVELACE, description: 'Drifts continuously. Fetched fresh.' },
          saturation: {
            type: 'number',
            minimum: 0,
            description: 'A fraction: 1.0 is saturated. NOT a percentage.',
          },
          liveDelegators: { type: 'integer', minimum: 0 },
          blocksMinted: { type: 'integer', minimum: 0 },
          metadata: { $ref: '#/components/schemas/PoolMetadata' },
        },
      },

      VoteTally: {
        type: 'object',
        required: ['yes', 'no', 'abstain', 'yesPower', 'noPower', 'abstainPower'],
        properties: {
          yes: { type: 'integer', description: 'Votes cast, by count.' },
          no: { type: 'integer' },
          abstain: { type: 'integer' },
          yesPower: {
            ...LOVELACE,
            description:
              'Voting power behind the yes votes, in lovelace. **This, not the count, is what ' +
              'decides the outcome.** Parse with BigInt.',
          },
          noPower: LOVELACE,
          abstainPower: LOVELACE,
        },
      },

      Proposal: {
        type: 'object',
        required: ['proposalId', 'txHash', 'index', 'type', 'status', 'deposit', 'returnAddress'],
        properties: {
          proposalId: { type: 'string', pattern: '^gov_action1[0-9a-z]+$' },
          txHash: HEX(32, 'The transaction that submitted the action'),
          index: { type: 'integer', description: "The action's index within that transaction." },
          type: {
            type: 'string',
            enum: [
              'ParameterChange',
              'HardForkInitiation',
              'TreasuryWithdrawals',
              'NoConfidence',
              'NewCommittee',
              'NewConstitution',
              'InfoAction',
            ],
          },
          status: {
            type: 'string',
            enum: ['open', 'ratified', 'enacted', 'dropped', 'expired'],
            description:
              'Derived from the on-chain epoch fields so that every client does not re-derive it ' +
              'differently. `enacted` outranks `ratified`, because a proposal is ratified first ' +
              'and enacted afterwards.',
          },
          proposedEpoch: {
            type: 'integer',
            description:
              'The epoch the action was proposed in. Absent when the provider cannot source it ' +
              '(Blockfrost exposes no proposed epoch); present on Koios-backed responses.',
          },
          expiryEpoch: {
            type: 'integer',
            description: 'When it lapses if nothing happens.',
          },
          decidedEpoch: {
            type: 'integer',
            description: 'The epoch of whatever actually happened. Absent while `open`.',
          },
          deposit: LOVELACE,
          returnAddress: { type: 'string', description: 'Where the deposit is returned to.' },
          title: { type: 'string', description: 'CIP-108. See metadataValid before showing it.' },
          abstract: {
            type: 'string',
            description: 'CIP-108. See metadataValid before showing it.',
          },
          metadataUrl: { type: 'string' },
          metadataHash: { type: 'string' },
          metadataValid: {
            type: 'boolean',
            description:
              'Whether the off-chain document matched the hash anchored on chain. **Absent means ' +
              'unknown, which is not the same as false.** Check it before showing `title` or ' +
              '`abstract`: those are attacker-supplied text a user reads right before voting.',
          },
          drepVotes: { $ref: '#/components/schemas/VoteTally' },
          poolVotes: { $ref: '#/components/schemas/VoteTally' },
          committeeVotes: { $ref: '#/components/schemas/VoteTally' },
        },
      },

      DrepInfo: {
        type: 'object',
        required: ['drepId', 'hex', 'hasScript', 'status', 'active', 'deposit', 'votingPower'],
        properties: {
          drepId: { type: 'string', description: 'Bech32, always the CIP-129 form.' },
          hex: HEX(28, 'The DRep credential. Identical across both id encodings.'),
          hasScript: { type: 'boolean' },
          status: {
            type: 'string',
            enum: ['registered', 'deregistered', 'not_registered'],
            description:
              '`not_registered` means the chain has never heard of this id. Only returned by ' +
              '/v1/governance/dreps/info; the list contains registered DReps only.',
          },
          active: { type: 'boolean', description: 'Whether the registration has lapsed.' },
          deposit: LOVELACE,
          votingPower: { ...LOVELACE, description: 'Total lovelace delegated to this DRep.' },
          expiresEpoch: { type: 'integer' },
          metadataUrl: { type: 'string', description: 'CIP-119 off-chain metadata.' },
          metadataHash: { type: 'string' },
          name: {
            type: 'string',
            description: 'From CIP-119 metadata, resolved best-effort. Absent is normal.',
          },
          image: { type: 'string', description: 'A URI. Never image bytes.' },
        },
      },
    },
  },
} as const
