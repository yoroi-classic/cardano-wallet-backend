// Fold .changes/*.md fragments into a new CHANGELOG.md section for the version currently
// in package.json, then delete the fragments.
//
// Feature PRs drop a uniquely-named fragment instead of editing CHANGELOG.md, so two
// concurrent PRs can never conflict on it. The release PR promoting development into
// preview runs this once, alongside the version bump. See .changes/README.md.
//
// `--check` parses the fragments and reports what would be written without touching
// anything, so CI (or you) can catch a malformed fragment before release day.
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const CHANGES_DIR = '.changes'
const CHANGELOG = 'CHANGELOG.md'

// Keep a Changelog's sections, in the order a release should present them.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Note']

const checkOnly = process.argv.includes('--check')

/** Read the fragment files, skipping the README that documents the format. */
function fragmentFiles() {
  return readdirSync(CHANGES_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
}

/**
 * Parse one fragment into { section: [entry, ...] }. A fragment is only `### Section`
 * headings and the lines under them, so anything before the first heading, or under an
 * unknown heading, is a mistake we fail on rather than silently drop from the release.
 */
function parseFragment(name, text) {
  const entries = new Map()
  let section = null

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue

    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      const title = heading[1].trim()
      if (!SECTIONS.includes(title)) {
        throw new Error(`${name}: unknown section "${title}". Use one of: ${SECTIONS.join(', ')}.`)
      }
      section = title
      continue
    }

    if (section === null) {
      throw new Error(`${name}: content before any "### Section" heading: ${line.trim()}`)
    }

    const existing = entries.get(section)
    if (existing) existing.push(line)
    else entries.set(section, [line])
  }

  if (entries.size === 0) throw new Error(`${name}: no entries found`)
  return entries
}

function main() {
  const files = fragmentFiles()
  if (files.length === 0) {
    console.log('no changelog fragments to assemble')
    return
  }

  // Merge every fragment's entries under their section, fragments in filename order.
  const merged = new Map()
  for (const file of files) {
    const entries = parseFragment(file, readFileSync(join(CHANGES_DIR, file), 'utf8'))
    for (const [section, lines] of entries) {
      const existing = merged.get(section)
      if (existing) existing.push(...lines)
      else merged.set(section, [...lines])
    }
  }

  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  const date = new Date().toISOString().slice(0, 10)

  const body = SECTIONS.filter((s) => merged.has(s))
    .map((s) => `### ${s}\n\n${merged.get(s).join('\n')}\n`)
    .join('\n')
  const section = `## [${version}] - ${date}\n\n${body}`

  if (checkOnly) {
    console.log(`${files.length} fragment(s) would assemble into:\n\n${section}`)
    return
  }

  // Insert above the newest release, so the preamble stays at the top of the file.
  const changelog = readFileSync(CHANGELOG, 'utf8')
  const firstRelease = changelog.indexOf('\n## [')
  if (firstRelease === -1) {
    throw new Error(`${CHANGELOG}: no existing "## [version]" section to insert above`)
  }
  const at = firstRelease + 1
  writeFileSync(CHANGELOG, `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`)

  for (const file of files) rmSync(join(CHANGES_DIR, file))

  console.log(`assembled ${files.length} fragment(s) into ${CHANGELOG} as ${version}`)
  console.log('add the one-line release summary under the new heading by hand')
}

main()
