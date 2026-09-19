---
name: dockerfile-fixture-sync
description: Use whenever a task adds or moves a test fixture (a new data/ subdirectory, a new map/texture/pak asset referenced via import.meta.url or readFileSync in a .test.mjs file) or adds a new top-level source file, config file, or directory that npm run build:production / dedicated:build:production needs. The Dockerfile's test/builder stages only see files they explicitly COPY — nothing else keeps them in sync with the working tree, so this drifts into a CI failure that only shows up in Docker, not locally.
---

# Dockerfile / test-fixture sync

`build-and-deploy.instructions.md` states the policy directly: the `Dockerfile`'s `test`
stage "only has access to files it explicitly `COPY`s (plus what `.dockerignore` allows
through) — it does not run `npm test` against the full working tree." Adding a fixture or a
new top-level file locally passes every local `npm test`/`npm run build:production` run —
the drift only surfaces later, in CI, as a Docker-only failure that's confusing to debug
without already knowing this rule.

## Fast path

1. Notice the trigger: did this change add a `data/` subdirectory or new asset under an
   existing one, referenced from a `.test.mjs` file via `import.meta.url` or
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
