## Unit Tests

Fixture factories, the mock helpers and how to patch a singleton are in the `writing-engine-tests` skill (`.claude/skills/writing-engine-tests/SKILL.md`). Load it before writing a test.

- **Runner**: Node's built-in `node:test` with `node:assert/strict`, loaded through `tsx`. No third-party framework. All files are ESM.
- **Where tests live**: engine tests under `test/`, grouped by area (`test/common/`, `test/physics/`, `test/renderer/`, ...). A game's tests live in its own repo under `source/game/<repo>/test/`, mirroring the source layout (`client/`, `entity/`, `monster/`, ...).
- **Naming**: `<subsystem>.test.ts` for the engine and for the games' tests. One file per production class or module.
- **Globs**: npm runs the test globs through `dash`, where `**` reaches one directory level. `test/common/test-globs.test.ts` fails when a `test*` script skips a test file, so a deeper directory does not go unnoticed.
- **Structure**: group tests with `describe()` (nest it when a method has several scenarios), plain `test()` inside, one assertion focus per test. Name the observable behavior (`'clears NaNs and clamps to maxvelocity'`), not the implementation (`'calls checkVelocity correctly'`).
- **Every test is type-checked, the games' as well.** `npm run typecheck` covers `test/**/*.test.ts`, `test/support/**` and the games' `source/game/<mod>/test/`, so a changed signature fails the build. A game's tests use the engine's `test/support/` as their shared kit (`entityMocks.ts` for entities, `cvarStub.ts`, `entityStates.ts`, `serialization.ts`) and their game's own fixtures (id1's `test/client/fixtures.ts` mocks the client engine API).
- **Type the mock, not the call.** Use the typed factories in `test/support/` (`fixtures.ts` and its neighbors). No `any`, no `@ts-ignore`.
- **Floating point** is compared with `assertNear` from `test/support/assertions.ts` (default tolerance 1e-6). Use `assert.deepEqual`/`assert.equal` over loose checks.
- Run a single file with `node --import tsx --test <file>`; `npm test` runs everything.
