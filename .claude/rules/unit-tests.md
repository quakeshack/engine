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

### What earns a test

A test must be able to fail when the code breaks by accident: a regression, a wrong result, a broken invariant. If it can only fail when someone edits a value on purpose, it is a copy of the source and costs an edit with every change. Don't write:

- Copies of constants, enum values, class statics or data tables (`K.ENTER === 13`, `classname`, `_health`, `_size`, a monster's frame list), unless a change breaks compatibility (the protocol version) or the data is irregular and was once wrong.
- Existence checks: `typeof X === 'function'`, an export or re-export is there. The import and `npm run typecheck` already catch it.
- Checks that abstract methods throw, constructors store their arguments, no-op hooks return nothing, or a framework helper works, repeated in every user (test `_defineSequence` or `@serializable` once, where it is defined).
- Assertions on private storage (`worker['_listeners'].length`) instead of the effect it has.
- Regexes over source text that a general invariant test already covers.

The `writing-engine-tests` skill has the checklist.

