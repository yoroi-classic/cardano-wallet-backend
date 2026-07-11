# Contributing

## Code style

Read `STYLE_GUIDE.md` before writing code here. It covers the conventions the tooling
can't enforce: when to use a function versus a factory versus a class, when to break
long code into smaller pieces, types, validation, errors, and the testing policy.

## Branch flow

Work flows in one direction and the gates get stricter as it goes:

```
development  ->  preview  ->  preprod  ->  main
```

- Do feature work on a branch off `development` and open a PR into `development`.
- Promotions upward (`development` into `preview`, and so on) also go through PRs.
- PRs are never self-merged. A human reviews and merges.

## Splitting the work

**Never stack PRs.** Every PR branches off `development` and must be reviewable and
mergeable on its own, in any order relative to whatever else is open. A branch built on
another open branch shows the reviewer both changes at once and makes them guess where
one ends and the next begins, which is exactly the problem this rule exists to prevent.

Stacking is usually a symptom, not a choice: it happens when two features would collide
in the same shared file, so the second is built on the first to dodge the conflict. Fix
the collision instead. Sort each PR into one of three kinds, and the collisions go away:

- **Seam PRs** change a shared contract: the provider interface, the route table, shared
  domain types, the test harness. They are the _only_ PRs allowed to touch those files.
  They carry no behavior change, land on their own, and are quick to review precisely
  because there is nothing to verify beyond "same code, new shape".
- **Feature PRs** come after the seam exists and only _add_ files: a capability module
  under `providers/capabilities/`, its Koios implementation under `providers/koios/`, a
  route, a domain type module, tests, and one changelog fragment. They touch no shared
  file except a one-line addition to a barrel, so they never block each other.
- **Release PRs** promote `development` upward and are the only PRs that bump the version
  and assemble `CHANGELOG.md`.

If a seam you need doesn't exist yet, land the seam first, on its own. It is faster than
the rebase cascade a stack costs you.

Two habits that follow from this:

- **Don't split one evolving function across PRs.** If your second PR rewrites the
  function your first PR introduced (a fallback chain gaining another tier, say), those
  are one feature delivered in installments, not two features. Ship them as one PR. Split
  by user-visible capability, not by the order you happened to build it in.
- **Never bump the version or edit `CHANGELOG.md` in a feature PR.** See below.

## CI gates by branch

Every branch runs the baseline `ci` job (lint, format, typecheck, build, unit/API
contract tests with coverage, production dependency audit, and Docker build). On top of
that:

- `development` — baseline `ci` only. Live provider integration stays out of this gate
  so day-to-day work moves.
- `preview` — `ci` plus the semver bump check.
- `preprod` — `ci`, the semver check, the live-preprod integration suite, and a
  dependency audit.
- `main` — the same tighter set as `preprod`, plus code-owner review and a release
  tag cut from `package.json` once a version lands.

## Testing policy

Every feature ships with tests along three paths:

- Happy path, the feature does what it should with good input.
- Unhappy path, it fails safely on bad input, upstream errors, timeouts, and
  malformed responses, returning the right status and a stable error body.
- Regression, a shape or mapping assertion that fails loudly if the contract drifts.

Providers take an injectable `fetch` so their tests are deterministic and never touch
the network. API contract tests live under `test/http` and are included in the default
unit and coverage commands. Integration tests that hit real preprod live under
`test/integration` and run only in the preprod and main gates.

## Toolchain upgrades

Runtime and package-manager pins live in `.nvmrc`, `package.json` (`engines` and
`packageManager`), `package-lock.json`, the Dockerfile base image, and the GitHub
Actions Node setup. Keep those in sync when changing Node or npm.

For Node, package-manager, framework, compiler, linter, or test-runner major bumps:

- Update the pin, manifest, and lockfile together.
- Note the reason and any migration impact in `CHANGELOG.md`.
- Run `npm ci`, `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run build`, `npm run test:coverage`, `npm run audit:prod`, and
  `npm run docker:build` before opening the PR.
- Keep provider tests deterministic by using injected fetch fixtures. Live provider
  endpoints must remain configurable by environment variables, and defaults must stay on
  neutral network services rather than wallet-vendor hosted services.

## Versioning and the changelog

The project uses semantic versioning. Rough guide: patch for fixes, minor for new
capability behind the existing contract, major for a breaking API change (still `0.x` for
now, so breaking changes bump the minor).

**The version bump and the `CHANGELOG.md` edit belong to the release PR, not to your
feature PR.** The `version-check` gate only runs on PRs into `preview` and above, so a PR
into `development` never needed either. Doing it anyway gave every concurrent PR a
guaranteed conflict in `package.json`, `package-lock.json`, and the top of
`CHANGELOG.md`, which is what forced work to serialize.

Instead, a PR that changes behavior adds one uniquely-named fragment under `.changes/`,
named after its branch. New file per PR, so two PRs can never collide:

```markdown
<!-- .changes/feat-koios-pool-list.md -->

### Added

- `POST /v1/pools/list` returns the neutral stake pool list, sourced from Koios.
```

`npm run changelog:check` parses the fragments and prints what they would produce. A pure
refactor, a test-only change, or a docs edit needs no fragment.

The release PR promoting `development` into `preview` bumps the version and runs
`npm run changelog:assemble`, which folds every fragment into a new `CHANGELOG.md`
section and deletes them. See `.changes/README.md`.

## Commits and PRs

- Conventional-commit style prefixes (`feat`, `fix`, `chore`, `docs`, `test`, `ci`,
  `refactor`) with a short, plain-language summary.
- Reference the issues a PR addresses. Use `Closes #N` only when the PR fully resolves
  an issue, otherwise `Part of #N` and leave a comment on the issue about what's done
  and what's left.
- No co-author trailers.
