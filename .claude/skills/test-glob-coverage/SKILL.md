---
name: test-glob-coverage
description: Use whenever adding a new test file in a nested subdirectory under any test/ folder in this repo — e.g. splitting a test file into test/client/menu/*.test.mjs, or mirroring a new source/ subdirectory per unit-tests.instructions.md's "mirror the source layout" guidance. npm's test scripts pass ** glob patterns to dash (this machine's /bin/sh, and the Docker test stage's ash), neither of which supports real recursive ** — patterns only reach exactly as many directory levels as are spelled out explicitly. A new nesting level one deeper than what's already spelled out is silently skipped — npm test reports a clean, plausible-looking pass count with zero indication anything was excluded.
---

# Test glob coverage

`package.json`'s `test`, `test:game`, `test:common`, `test:physics`, and `test:renderer`
scripts all pass `**` glob patterns directly to the shell for expansion, not to Node.
`/bin/sh` on this machine (and the Docker `test` stage's `ash`/busybox) is `dash`, and
dash's `**` behaves exactly like a single `*` — it matches one path segment and does not
recurse. There's no `shopt -s globstar` equivalent in dash. Each script therefore lists as
many explicit `**/**/…` segments as there are directory levels it needs to reach, and nothing
past that.

**Currently verified state (re-check if this becomes stale):** running the real patterns
through `sh -c` and diffing against every `*.test.mjs` file on disk shows zero gap right
now — but there is also zero headroom left:

- `test/**/*.test.mjs` (used by `test` and implicitly needed by `test:common`/
  `test:physics`/`test:renderer`'s own single-`**` patterns) reaches exactly one level under
  `test/` (e.g. `test/client/cl.test.mjs`). None of `test/client/`, `test/common/`,
  `test/physics/`, `test/renderer/` currently have any further nesting.
- `source/game/**/test/*.test.mjs`, `.../test/**/*.test.mjs`, `.../test/**/**/*.test.mjs`
  (used by `test` and `test:game`) together reach up to two levels under `test/`. The
  deepest currently-existing game test directory, `source/game/hellwave/test/client/menu/`,
  already sits at that exact depth.

One more nesting level added anywhere — a new subdirectory under `test/client/`, or a
`test/client/menu/widgets/` under hellwave, or similar — will be silently excluded from
every affected npm script, with a clean-looking pass count and no error.

## Fast path

After adding a test file in a subdirectory nesting level not already exercised by an
existing test file, verify it's actually picked up — don't trust a green `npm test` alone:

```bash
diff \
  <(sh -c 'ls -d test/**/*.test.mjs source/game/**/test/*.test.mjs source/game/**/test/**/*.test.mjs source/game/**/test/**/**/*.test.mjs 2>/dev/null' | sort -u) \
  <(find test source/game -name '*.test.mjs' -not -path '*/node_modules/*' | sort -u)
```

- **Empty diff:** covered, nothing to do.
- **Non-empty diff (files only in the `find` side):** the glob patterns need another
  explicit `**/**/…` segment. Add it to every affected script in `package.json` — likely
  more than one of `test`/`test:game`/`test:common`/`test:physics`/`test:renderer`, since
  they overlap on the same directories at different depths. Re-run the diff after editing
  to confirm it's now empty.

## What this skill does NOT do

- Does not attempt to fix dash's glob limitation at the shell level (e.g. switching
  `script-shell` to bash for `globstar`) — that's a real option but a separate, larger
  decision (it'd change behavior for every npm script, not just these), not something to
  do as a side effect of adding one test file.
- Does not run automatically on every `npm test` invocation — this is a manual check to run
  specifically when a new nesting level is introduced, not a standing CI gate.
