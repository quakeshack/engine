---
name: dockerfile-fixture-sync
description: Use when adding a test fixture (data/ path read via import.meta.url or readFileSync) or a new top-level source/config file or directory the build or typecheck needs. The Dockerfile only sees what it COPYs, so this fails only in CI.
---

# Dockerfile / test-fixture sync

The `Dockerfile`'s `test` and `builder` stages only have access to files they explicitly
`COPY` (plus what `.dockerignore` lets through); they do not run against the full working
tree. Adding a fixture or a
new top-level file locally passes every local `npm test`/`npm run build:production` run —
the drift only surfaces later, in CI, as a Docker-only failure that's confusing to debug
without already knowing this rule.

## Fast path

1. Notice the trigger: did this change add a `data/` subdirectory or new asset under an
   existing one, referenced from a `.test.ts` file via `import.meta.url` or
   `readFileSync`? Or add a new top-level source/config file (not inside an already-copied
   directory like `source/`) that a build script needs?
2. Check the current `Dockerfile` `COPY` lines:
   ```bash
   grep -n "^COPY" Dockerfile
   ```
3. **New test fixture:** add a matching `COPY` line to the `test` stage (the stage that
   runs after `FROM builder AS test`).
4. **New top-level source/config file the build needs:** add it to the `builder` stage's
   `COPY` list (the stage that runs `npm run build:production` / `dedicated:build:production`).
   The `test` stage also runs `npm run typecheck`, so a file that a type-checked source file
   imports must be copied too; otherwise `tsc` fails in Docker while it passes locally.
5. Check `.dockerignore` doesn't silently exclude the new path:
   ```bash
   cat .dockerignore
   ```
6. If practical, sanity-check with a local Docker build of the affected stage rather than
   trusting the diff alone — `docker build --target test .` (only if Docker is available
   and the user hasn't indicated otherwise; this is a local, reversible check, not a
   push/deploy action).

## What this skill does NOT do

- Does not touch files already under directories the Dockerfile copies wholesale (e.g. a
  new file inside `source/` or `test/` needs no Dockerfile change — only new *top-level*
  entries or new `data/` fixture paths do).
- Does not run or trigger an actual CI/deploy — this is a local consistency check between
  the working tree and the Dockerfile, nothing more.
