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
    { name: 'addresses', description: 'Address discovery' },
    { name: 'assets', description: 'Native token and NFT metadata' },
    { name: 'pools', description: 'Stake pools' },
    { name: 'governance', description: 'DReps' },
    { name: 'tx', description: 'Submit and status' },
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
          'the Midnight escrow path depends on.\n\nNever cached.',
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
          'you sent them.',
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
        summary: 'Whether a transaction is on chain, and how deep',
        description:
          '`seen: false` means it is not on chain: still pending, or it never landed. The two are ' +
          'not distinguishable from here, which is why a client keeps its own pending overlay.\n\n' +
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
    },

    schemas: {
      Error: ERROR_RESPONSE,

      Tip: {
        type: 'object',
        required: ['block', 'slot', 'epoch', 'hash'],
        properties: {
          block: { type: 'integer', description: 'Block height' },
          slot: { type: 'integer', description: 'Absolute slot. NOT a unix timestamp.' },
          epoch: { type: 'integer' },
          hash: HEX(32, 'Block hash'),
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
            pattern: '^[0-9a-fA-F]{0,64}$',
            description: 'Hex. May be empty.',
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
        type: 'object',
        required: ['seen', 'confirmations'],
        properties: {
          seen: { type: 'boolean', description: 'Whether the transaction is on chain at all.' },
          confirmations: {
            type: 'integer',
            minimum: 0,
            description: 'Blocks on top. 0 when unseen.',
          },
        },
      },

      TokenMetadata: {
        type: 'object',
        required: ['subject', 'policyId', 'assetName', 'fingerprint', 'supply', 'source'],
        properties: {
          subject: { type: 'string', description: 'policyId + assetNameHex, lowercase.' },
          policyId: HEX(28, 'Minting policy id'),
          assetName: {
            type: 'string',
            pattern: '^[0-9a-fA-F]{0,64}$',
            description: 'Hex. May be empty.',
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
