# Code style guide

How we write code in this repo, so it stays consistent in shape and quality as it
grows. This is the baseline for the Yoroi Classic TypeScript work generally, not just
this service. It is a living document. When a new pattern settles, write it down here.

The tooling enforces the mechanical parts (prettier for formatting, eslint and the
strict TypeScript compiler for the rest), so this guide focuses on the judgment calls
those can't make for you.

## Guiding idea

Optimize for the reader. Code is read far more often than it is written, so clarity
beats cleverness every time. Prefer the boring, obvious version. If a reviewer has to
ask "what does this do", the code isn't done yet.

## Language and tooling

- TypeScript in strict mode, ESM with NodeNext resolution, Node 22+.
- No `any`. Use `unknown` at the edges and narrow. The lint rule is an error, not a
  warning, so treat a needed exception as a design smell to justify in review.
- Formatting is prettier's job (no semicolons, single quotes, trailing commas, 100
  column width, two-space indent). Don't hand-format, don't argue with it, run it.
- Imports use the `.js` extension on relative paths (NodeNext), and `import type` for
  type-only imports so they erase cleanly.

## Files and modules

- One concern per file, and keep files small. If a file is doing two jobs, split it.
- File names are kebab-case. Types and functions inside keep their own casing.
- The layers depend inward: `http` calls `providers`, `providers` map onto `domain`.
  Never reach the other way. A provider should not import an HTTP type, and `domain`
  (types and errors) should import nothing of ours.
- Barrels (index files that re-export) are fine for a public surface but don't add one
  just to shorten an import. Direct imports are clearer.

## Functions, factories, and classes

Default to plain functions. Reach for the heavier tools only when they pay for
themselves.

- Pure functions for logic. Given the same input they return the same output and touch
  nothing else. These are the easiest things to read and test, so prefer them.
- Factory functions for anything stateful or with dependencies. A factory takes its
  collaborators as arguments and returns an object of methods. This is how we build
  providers and the server, and it is what makes them testable without mocks.

  ```ts
  export function createKoiosProvider(config: KoiosConfig): ChainProvider {
    const doFetch = config.fetchImpl ?? globalThis.fetch
    return {
      name: 'koios',
      async getTip() {
        /* ... */
      },
    }
  }
  ```

- Classes only where instance identity earns its place. Our error types are classes
  because `instanceof` is the cleanest way to branch on an error's kind. That is the
  bar: if you aren't using `instanceof` or genuine inheritance, a factory is simpler.

Inject dependencies, don't import singletons. Pass `fetch`, the provider, the logger,
and config in as parameters. A unit that reaches out to a module-level singleton is a
unit you can't test in isolation. The injectable `fetch` on the Koios provider is the
model: real code uses the global, tests pass a fake, no network and no mocking library.

## When to break code into smaller pieces

The question isn't line count, it's whether the reader can hold the function in their
head. Some heuristics:

- One function, one job, at one level of abstraction. If a function both decides
  something and does low-level string work, those are two levels, split them.
- Extract a helper when a block is reused, when it is independently testable, or when
  naming it replaces a comment. If you're about to write `// build the referral link`
  above a block, that block wants to be a function called `buildReferralLink`.
- Soft ceilings, not hard rules: aim to keep a function under roughly forty lines, four
  parameters (past that, take an options object), and three levels of nesting. Crossing
  one is a prompt to look for a seam, not an automatic failure.
- Flatten with guard clauses. Return early on the error and edge cases so the happy
  path stays at the left margin instead of nested inside `if` after `if`.

  ```ts
  if (!res.ok) {
    throw new ProviderError(`koios returned ${res.status}`, { upstreamStatus: res.status })
  }
  // happy path continues here, not indented inside an else
  ```

- Don't over-extract either. A trivial one-liner used in a single place is clearer
  inline than hidden behind a name. Extraction is for managing complexity, so if there
  is no complexity, leave it. The `request` and `parseFirst` helpers inside the Koios
  provider are a good size: each is doing one real thing that the two public methods
  share.

## Types

- Model the domain explicitly. Write the normalized shape you want (see `domain/types`)
  and map onto it, rather than passing provider-shaped blobs around.
- `interface` for object shapes, `type` for unions and aliases.
- Avoid `enum`. Use a `const` array plus a derived union, which stays a plain value at
  runtime and gives you the literal type for free.

  ```ts
  export const NETWORKS = ['mainnet', 'preprod', 'preview'] as const
  export type Network = (typeof NETWORKS)[number]
  ```

- Money and other big integers are strings, never `number`. Lovelace values overflow
  the safe integer range, so keep them as strings end to end and only convert at the
  point of arithmetic with `BigInt`.
- Respect `noUncheckedIndexedAccess`. Indexing an array or record gives you
  `T | undefined`, so handle the absence rather than asserting it away.
- Make illegal states hard to reach. Use `readonly` where a value shouldn't change, and
  a `never` assignment in the default case of a switch so adding a variant fails to
  compile until it's handled.

## Validation at the boundary

Everything crossing into our code from outside is untyped until we prove otherwise:
environment variables, upstream responses, request parameters. Validate it once, at the
edge, with zod, and work with trusted types after that. Parse, don't merely check, turn
the raw shape into the normalized domain type in the same step. Inside the trusted core,
don't re-validate what the boundary already guaranteed.

## Errors

- Throw typed errors from our taxonomy (`AppError` and its subclasses). Every one
  carries a stable code and status, so the HTTP layer can map it without a pile of
  conditionals.
- Providers throw `ProviderError`, `ProviderTimeoutError`, or `MalformedUpstreamError`.
  Routes stay thin and let those bubble to the central error handler.
- Never leak internal detail to a caller. The catch-all handler returns a generic 500
  and logs the real error. Client-facing messages are safe and boring.
- Preserve the cause. When you wrap an upstream failure, attach the original as `cause`
  so the logs still tell the whole story.
- Don't throw strings, and don't swallow errors. A bare `catch {}` that hides a failure
  is a bug waiting to happen, either handle it meaningfully or let it propagate.

## Async

- `async`/`await`, not raw `.then` chains.
- No floating promises. Await them, or if you deliberately don't care, mark it `void`.
- Every network call gets a timeout via `AbortSignal.timeout`. A hung upstream must not
  hang us.

## HTTP layer

- Route handlers are thin: read and validate input, call a provider or service, return
  the normalized result. No business logic in a handler.
- The server is a factory with no side effects at construction (`buildServer`). It
  doesn't listen, so tests drive it with `inject` and never open a socket. Starting the
  server is the entrypoint's job, not the builder's.
- One response envelope, consistent status codes. Success returns the domain shape;
  failure returns `{ error: { code, message } }`.

## Naming

- `camelCase` for variables and functions, `PascalCase` for types and classes,
  `UPPER_SNAKE_CASE` for module-level constants, kebab-case for files.
- Functions are verbs (`getTip`, `createProvider`), values are nouns, booleans read as a
  question (`isMainnet`, `hasToken`).
- Say what it is, not how big or how clever. Avoid `data`, `info`, `tmp`, `helper` as
  standalone names, and avoid abbreviations that aren't obvious.

## Comments

- Comments explain why, not what. The code already says what. A good comment captures a
  reason, a tradeoff, or a non-obvious constraint.
- Keep them accurate. A stale comment is worse than none, so update or delete them when
  the code moves.
- No commented-out code and no dead code. Git remembers, delete it.
- JSDoc on exported functions and public interfaces, short and to the point.
- A `TODO` needs an issue reference so it doesn't rot silently.

## Testing

Every feature ships tested along three paths, no exceptions:

- Happy path: correct behavior on good input.
- Unhappy path: safe failure on bad input, upstream errors, timeouts, and malformed
  responses, with the right status and error type.
- Regression: a shape or mapping assertion that fails loudly if the contract drifts. A
  full-object `toEqual` on a mapped result is the cheapest insurance against silent
  drift.

Other rules:

- Unit tests are deterministic and offline. Inject the fake collaborators (the fake
  `fetch`) rather than reaching for a network-mocking library.
- Integration tests that hit real preprod live under `test/integration` and run only in
  the tighter CI gates.
- Structure a test as arrange, act, assert, with a blank line between the phases so the
  shape is obvious.
- Name tests by behavior, grouped by unit and path, e.g. `describe('koios provider —
unhappy path')`.

## Configuration and secrets

- All configuration goes through the validated loader. Don't read `process.env` from
  deep inside a module, take config as a parameter.
- No secrets in code and none committed. They come from the environment, and the
  loader treats an empty value as absent.

## Recurring pitfalls to avoid

These are concrete mistakes we've hit and don't want to repeat. Check for them before
opening a PR.

- Validate every branch of a union to the same constraint. If a field can arrive as a
  number or a string, constrain both to the same domain (a non-negative integer, say),
  not just one. Tightening the string branch while leaving the number branch open lets
  malformed values through.
- Narrow a catch-and-fallback to the exact expected condition. A broad `catch` that
  turns any failure into a benign default hides real errors. Detect the specific case
  you mean to tolerate (the file is absent, the ref exists) and let everything else
  throw. Silent fallbacks that make a gate pass are worse than a loud failure.
- Docs must match real behavior. Don't document a status code, endpoint, or capability
  that no code path actually produces. Add the doc when the path exists, not before.
- Use `BigInt` for integers that can exceed the safe range, never `Number()`. This is
  the comparison-and-parsing companion to keeping money as strings.
- A fatal path must actually terminate. Setting `process.exitCode` while a listening
  server (or any open handle) keeps the event loop alive leaves a zombie that a health
  check might still call healthy. Close resources on failure so the process can drain
  and exit.
- Never build a shell command string from untrusted or external input (an env var, a
  branch name, a request field). Use `execFile`/`spawn` with an argument array so no
  shell parses it. On a fork PR even a branch name is attacker-influenced.

## Commits, PRs, and versioning

Those live in `CONTRIBUTING.md`. The short version: conventional-commit prefixes,
semver bump per advancing PR, reference the issues a PR addresses, and no self-merges.

CI hardening we standardize on: pin third-party GitHub Actions to a full commit SHA (a
tag is mutable), and have a self-validating gate run the trusted base-branch copy of its
own check script, so a PR can't weaken the gate by editing it in the same change.
