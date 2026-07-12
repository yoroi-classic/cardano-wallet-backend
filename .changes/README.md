# Changelog fragments

A PR that changes behavior drops **one new file** in this directory instead of editing
`CHANGELOG.md`. The release PR assembles them.

This exists for one reason: `CHANGELOG.md` has a single top section, so every concurrent
PR edited the same lines and conflicted with every other one. That is a merge conflict
manufactured by process, not by the code. A fragment is a new file per PR, so two PRs can
never collide on it.

## Writing one

Name the file after your branch, plus a few random characters:

```
.changes/feat-koios-pool-list-7f3a.md
```

The branch name is for the human reading the directory. The random suffix is what actually
keeps the name unique: two people (or two forks) can pick the same obvious branch name for
the same obvious fix, and then their "conflict-free" fragments would collide on the one
thing this directory exists to prevent. The assembler doesn't care what the file is called,
only that no two are called the same, so spend the four characters.

Write it as the Keep a Changelog sections your change belongs under. Nothing else:

```markdown
### Added

- `POST /v1/pools/list` returns the neutral stake pool list, sourced from Koios.

### Fixed

- `saturation` is now a fraction (1.0 == saturated) rather than a percentage.
```

Valid sections are `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, and
`Note`. Write for someone deciding whether the release affects them, so name the endpoint
or the behavior, not the refactor that carried it.

A PR with no behavior change (a pure refactor, a test-only change, a docs edit) needs no
fragment.

## Assembling at release

The release PR promoting `development` into `preview` carries the version bump, and:

```bash
npm version <patch|minor|major> --no-git-tag-version
npm run changelog:assemble
```

That folds every fragment into a new `CHANGELOG.md` section for the version in
`package.json`, then deletes the fragments. Add the one-line prose summary under the new
heading by hand: it describes the release as a whole, which no single fragment knows.

Do not bump the version in a feature PR. The `version-check` gate only runs from
`preview` onward, so `development` never needed it, and doing it anyway made every PR
conflict in `package.json` and `package-lock.json`.
