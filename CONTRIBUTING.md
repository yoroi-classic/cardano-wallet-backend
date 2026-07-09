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

## Versioning

The project uses semantic versioning, starting now. Every PR that advances the code
bumps `package.json` and adds a `CHANGELOG.md` entry. The version-check gate enforces
this from `preview` onward. Rough guide: patch for fixes, minor for new capability
behind the existing contract, major for a breaking API change (still `0.x` for now, so
breaking changes bump the minor).

## Commits and PRs

- Conventional-commit style prefixes (`feat`, `fix`, `chore`, `docs`, `test`, `ci`,
  `refactor`) with a short, plain-language summary.
- Reference the issues a PR addresses. Use `Closes #N` only when the PR fully resolves
  an issue, otherwise `Part of #N` and leave a comment on the issue about what's done
  and what's left.
- No co-author trailers.
