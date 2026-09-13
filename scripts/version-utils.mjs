import { execFileSync } from 'node:child_process'

export function git(args, opts = {}) {
  return execFileSync('git', args, opts)
}

export function parseSemver(value) {
  const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
  const match = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
      `(?:-(${identifier}(?:\\.${identifier})*))?` +
      '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  ).exec(value)
  if (!match) return null
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ?? null,
  }
}

function comparePrerelease(a, b) {
  const left = a.split('.')
  const right = b.split('.')
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const xValue = BigInt(x)
      const yValue = BigInt(y)
      if (xValue !== yValue) return xValue < yValue ? -1 : 1
    } else if (xNumeric) {
      return -1
    } else if (yNumeric) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function compareSemver(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}
