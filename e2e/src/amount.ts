export function formatAda(lovelace: string): string {
  const amount = BigInt(lovelace)
  const sign = amount < 0n ? '-' : ''
  const absolute = amount < 0n ? -amount : amount
  const whole = absolute / 1_000_000n
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0')
  return `${sign}${whole}.${fraction}`
}
