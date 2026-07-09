// A thin client for the backend's /v1 surface. Deliberately minimal: just the shapes
// this slice reads. It mirrors the fields the extension's tx builder needs, so exercising
// it here reinforces that our /v1 data is sufficient to drive real transaction building.

export interface V1Asset {
  policyId: string
  assetName: string
  quantity: string
}

export interface V1Utxo {
  txHash: string
  outputIndex: number
  address: string
  value: string
  assets: V1Asset[]
}

export interface V1ProtocolParams {
  minFeeA: number
  minFeeB: number
  keyDeposit: string
  poolDeposit: string
  coinsPerUtxoByte: string
  maxValueSize: number
  maxTxSize: number
}

export interface V1AccountState {
  registered: boolean
  balance: string
  rewardsAvailable: string
}

export interface V1Tip {
  block: number
  slot: number
  epoch: number
  hash: string
}

export interface V1TxStatus {
  seen: boolean
  confirmations: number
}

export interface V1Transaction {
  txHash: string
  block: number
  fee: string
}

export interface V1Client {
  getHealth(): Promise<{ status?: string; service?: string }>
  getTip(): Promise<V1Tip>
  getProtocolParams(): Promise<V1ProtocolParams>
  getAccountState(stake: string): Promise<V1AccountState>
  getAccountUtxos(stake: string): Promise<V1Utxo[]>
  getTxHistory(stake: string): Promise<V1Transaction[]>
  submitTx(cborHex: string): Promise<{ txHash: string }>
  getTxStatus(hash: string): Promise<V1TxStatus>
}

// Per-request timeout so a hung or unresponsive backend fails the harness with a clear
// error instead of blocking the process indefinitely.
const REQUEST_TIMEOUT_MS = 20_000

export function createV1Client(baseUrl: string): V1Client {
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => '')}`)
    }
    return (await res.json()) as T
  }

  return {
    getHealth: () => get<{ status?: string; service?: string }>('/health'),
    getTip: () => get<V1Tip>('/v1/chain/tip'),
    getProtocolParams: () => get<V1ProtocolParams>('/v1/chain/protocol-params'),
    getAccountState: (stake) => get<V1AccountState>(`/v1/account/${stake}/state`),
    getAccountUtxos: (stake) => get<V1Utxo[]>(`/v1/account/${stake}/utxos`),
    getTxHistory: (stake) => get<V1Transaction[]>(`/v1/account/${stake}/txs`),
    getTxStatus: (hash) => get<V1TxStatus>(`/v1/tx/${hash}/status`),
    submitTx: async (cborHex) => {
      const res = await fetch(`${baseUrl}/v1/tx/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cbor: cborHex }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw new Error(`POST /v1/tx/submit -> ${res.status} ${await res.text().catch(() => '')}`)
      }
      return (await res.json()) as { txHash: string }
    },
  }
}
