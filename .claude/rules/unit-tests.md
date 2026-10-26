---
paths:
  - "test/**"
  - "source/game/*/test/**"
  - "**/*.test.ts"
---

## Unit Tests

Load the `writing-engine-tests` skill before writing a test (fixture factories, mock helpers, patching singletons).

- `node:test` with `node:assert/strict` through `tsx`, ESM, no third-party framework. Run one file with `node --import tsx --test <file>`.
- Engine tests under `test/<area>/`, a game's under `source/game/<repo>/test/` mirroring its source; one `<subsystem>.test.ts` per class or module.
- npm runs the globs through `dash` (`**` reaches one level); `test/common/test-globs.test.ts` fails when a file is skipped.
- `describe()` per method or scenario, `test()` inside, one focus each, named after observable behavior.
- Tests are type-checked: typed factories from `test/support/`, no `any`, no `@ts-ignore`. Floats with `assertNear` (`test/support/assertions.ts`); prefer `assert.deepEqual`/`assert.equal`.
