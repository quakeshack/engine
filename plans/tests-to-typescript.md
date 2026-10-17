# Track G, type-checked tests: the engine's `.mjs` tests become TypeScript

Track G of `plans/engine-architecture-modernization.md`, the "type-checked tests" bullet. Status: **plan drafted 2026-10-17,
forks settled the same day (see "Decisions"). Phase 0 is done and committed (`3537396`); Phase 1 (`test/physics/`) is done (2026-10-17) and waits for review.**
Written for the maintainers. Counts are from a read of the tree on that date (branch `engine-architecture-modernization`).

## Context

`npm run typecheck` covers `test/**/*.test.ts` and `test/support/**`, and nothing else under `test/`. A `.mjs` test is run by
`tsx` and never checked, so a test that calls a `.ts` method with a stale signature, or mocks an outdated shape, keeps passing
when the code changes. `unit-tests.instructions.md` records this as a hazard, and it once hid a wrong override signature in a
game mod behind a green test. The 2026-10-13 scope cut moved this track past 1.3.0; on 2026-10-17 the developer reversed that
for the engine's tests: **1.3.0 waits for them**.

Where it stands:

| Area | `.mjs` tests | `.ts` tests | `.mjs` lines |
| :-- | --: | --: | --: |
| `test/physics/` | 17 | 2 | 12 504 |
| `test/common/` | 51 | 14 | 8 218 |
| `test/client/` | 30 | 17 | 9 705 |
| `test/server/` | 10 | 3 | 1 818 |
| `test/renderer/` | 8 | 36 | (not counted) |
| `test/shared/` | 1 | 2 | 77 |
| `test/eslint/` | 1 | 0 | 69 |
| **Engine total** | **118** | **74** | |
| `source/game/id1/test/` | 40 | 0 | |
| `source/game/hellwave/test/` | 16 | 0 | |

All `.mjs` tests together are about 46 000 lines. Four non-test `.mjs` helpers sit under `test/`:
`physics/fixtures.mjs` (606 lines, imported by 38 test files), `physics/map-pmove-harness.mjs`, `physics/debug-test-clip-4.mjs`
(not imported by anything, apparently a one-off script) and `server/fixtures/cvar-realm.mjs`. No `.test.ts` imports any of them
today, which is also why the typed tests carry their own helpers in `test/support/` (20 files).

The 74 `.ts` tests contain 102 `as unknown as` casts in 40 files. That is the cost of mocking engine shapes by hand, and the
sweep will add more unless the mocks get typed factories. Keeping that number from growing is part of the work.

## Goals

- Every test under `test/` is `.test.ts` and is type-checked by `npm run typecheck`, so a changed signature fails the build
  instead of passing silently (the Cloudflare build and the Docker `test` stage both run the typecheck).
- Shared fixtures are typed modules in `test/support/` with real interfaces for the mocks they build.
- No test loses coverage or gets weaker: same cases, same assertions, same fixtures.
- `npm test`, `npm run typecheck` and `npx eslint` stay green at the end of every phase.

## Non-goals

- Changing what a test checks. A conversion is not the time to rewrite a test. A test that turns out to assert the wrong thing
  is flagged and fixed in its own commit, not folded into the rename.
- The game repos' tests (`source/game/id1/test/`, `source/game/hellwave/test/`). They live in repos of their own, sit outside
  `tsconfig.json`, and do not gate 1.3.0. They get a follow-up plan (see Open questions).
- Frameworks. The runner stays `node:test`; `tsx` stays the loader.
- Source changes. If a test only type-checks after a change to production code, that change is made for a reason and gets its
  own commit; a test is never "fixed" by loosening a production type.

## Design

**Conversion rules**, applied to every file:

1. `git mv foo.test.mjs foo.test.ts` first, in a commit of its own or at least a separate step, so history follows the file.
2. JSDoc types become TypeScript (`typescript-port.instructions.md`): `/** @type {X} */` casts become annotations or `as`,
   `@typedef` mock shapes become `interface`s, redundant `@param {Type}` is dropped and the description kept.
3. Imports spell the `.ts` extension, as the rest of the tree does.
4. A mock is built by a typed factory (`createMockEntity`, `defaultMockEngine`, the helpers in `test/support/`), not by an
   inline object cast with `as unknown as`. When a factory is missing, it is added to `test/support/` and used by the next
   file too. An `as unknown as` that stays has an adjacent comment saying why a typed mock was not possible.
5. No `any`, no `@ts-ignore`, no `@ts-expect-error` to get a file through. A real type error is either a real bug in the test
   (fix it, say so in the commit) or a real bug in the code (report it, do not hide it).
6. Comments, `describe` structure and test names are kept. Files end with an empty line.
7. A test that only runs under `.mjs` semantics (top-level `await`, CJS interop) is listed in Open questions as it turns up.

**Typecheck configuration.** `tsconfig.json` includes `test/**/*.test.ts` and `test/support/**/*.ts` only. Each phase widens
nothing; the include already covers every converted file. The last phase removes the comment about `.mjs` tests and, because
`allowJs`/`checkJs` are on, checks that no `.mjs` is left under `test/`.

**Globs.** `package.json` spells every test glob twice (`*.test.mjs` and `*.test.ts`). They stay until the last `.mjs` test is
gone, then the `.mjs` half is removed from all of them (`test`, `test:engine`, `test:common`, `test:physics`, `test:renderer`)
and `eslint.config.mjs` stops naming `.mjs` test paths. The `test-glob-coverage` skill applies to any new directory level: no
new nesting is planned, `test/server/fixtures/` already exists.

**Dockerfile.** The `test` stage does `COPY test ./test`, so moved files need no change. A new top-level file would; none is planned.

## Phasing

Each phase ends with `npm test` (count unchanged, apart from tests added on purpose), `npm run typecheck` at zero errors and
`npx eslint` clean on the touched files, then stops for a go-ahead. The test count before and after a phase is recorded here.
Baseline on 2026-10-17: **2602 tests pass, typecheck clean.**

### Phase 0: helpers and the conversion kit

- Convert `physics/fixtures.mjs` to `test/support/physicsFixtures.ts` with real interfaces for `MockEntity`, `MockEdict`,
  `MockEngineConfig` (today `@typedef`s) and typed return values. The 38 importing `.mjs` tests are updated to the new path in
  the same step; they are still `.mjs`, which is fine, `tsx` resolves it.
- Convert `map-pmove-harness.mjs` and `server/fixtures/cvar-realm.mjs` the same way. Decide about `debug-test-clip-4.mjs`:
  delete it if nothing uses it (confirm with the developer, it is not a test).
- Look through the 102 existing `as unknown as` casts for the repeated shapes and give those a typed factory in `test/support/`,
  so the sweep has something to use instead of adding casts.
- Done when: no `.mjs` that is not a `.test.mjs` is left under `test/`, and the first file of Phase 1 can be converted with only
  rule-following.

#### Phase 0: what shipped (2026-10-17)

`npm test` 2602 pass (the baseline), `npm run typecheck` 0 errors, the touched `.ts` files are ESLint clean.

- **`test/support/fixtures.ts`** is `test/physics/fixtures.mjs`, typed. The name differs from the plan's `physicsFixtures.ts`
  because the file was never only physics: it holds the engine mocks (`withMockEngine`, `defaultMockEngine`), the geometry and
  entity factories, and the server, host, network and channel stand-ins. The `@typedef`s are interfaces now (`MockEntity`,
  `MockEdict`, `MockEngineConfig`, `MockServer`, `MockClient`, and an options interface per factory). The 45 `.mjs` tests that
  import it were pointed at the new path; they stay `.mjs` until their area's phase. The mock shapes keep an index signature
  (`MockServer`, `MockClient`) because tests add whatever members their scenario needs; what the checker now catches is the
  signatures of the real classes the tests call, which is the point of the track.
- **First thing the checker found:** the fixtures built `new BrushModel()` and set `name` afterwards, but the constructor takes
  the name. It worked at run time and was wrong for the type. Fixed in the fixtures; `collision-regressions.test.mjs` and
  `server-collision.test.mjs` have the same call in eleven places (8 and 3) and will be corrected when they are converted (Phase 1).
- **`test/support/serverCvarRealm.ts`** (was `test/server/fixtures/cvar-realm.mjs`): the worker script of
  `server-cvar-realms.test.mjs`, typed; the worker loads it as `.ts` under `tsx` with no change to how the test starts it.
- **`test/support/mapPmoveHarness.ts`** (was `test/physics/map-pmove-harness.mjs`): not a test fixture but a command line tool for
  looking at player movement on a map. Typed, with its usage in a header comment, and it now fails with a clear error on an
  entity lump that ends inside an entity instead of a `TypeError`. Run once against a real map: loads and parses.
- **`test/support/cvarStub.ts`**: `createCvarStub(value)`, one documented cast for the 19 `{ value } as unknown as Cvar` sites; the
  plain ones (8 sites in 4 renderer tests) use it. The remaining repeated casts are `WebGL` (15), `ClientGameInterface` (12),
  `GLTexture` (7) and `GLRenderTexture` (6); they are renderer and client shapes inside tests that are already typed, and are
  looked at in Phase 4 together with the client tests.
- `unit-tests.instructions.md` names the new locations.
- `test/physics/debug-test-clip-4.mjs` is deleted (the developer's call: a one-off script nothing imported). No `.mjs` that is not a `.test.mjs` is left under `test/`.
- **Found on the way:** `npx eslint test` cannot lint `.mjs` tests (the project service stops at 8 default-project files and the
  loose `.mjs` are not in `tsconfig.json`), so it fails the same way before and after this phase. Lint is run on the `.ts` files
  that are touched; that gap closes with the conversion itself.

### Phase 1: `test/physics/` (17 files, the largest)

The area with the most lines and the most hand-built geometry; doing it first means the fixtures get shaped by their heaviest user.

#### Phase 1: what shipped (2026-10-17)

All 17 `.mjs` tests in `test/physics/` are `.test.ts`, type-checked and ESLint clean. `npm test` 2602 pass (the baseline),
`npm run typecheck` 0 errors. The deliberate-break check passed: adding a required parameter to `ServerMovement.checkBottom`
made `npm run typecheck` fail in `server-movement.test.ts` and `collision-regressions.test.ts` (four call sites), and
`.mjs` would have kept passing; reverted. Starting point was 1298 type errors.

What the checker found that the `.mjs` hid, all fixed in the tests (no production code changed):

- **`server-clientdata-sparse` mocked the `Server` class instead of a server.** It set `Server.server` as a static on the class
  and installed the class as the mock; it passed because `mockedSV()` forwards everything. It now builds a real `Server` with
  `createTestServer()`.
- **`new BrushModel()` without the name** in 11 more places (see Phase 0); `ServerClient.cmd` and `.pendingCmds` are `readonly` and
  tests reassigned them (now mutated in place); `entity.use(null)` where the signature takes an entity; `edict.num = n` on a
  `readonly` field (the factory takes the number now).
- **Mocks that were not what the API says:** `queryAABB` mocks returned arrays where the signature is an iterator (`.values()`),
  `collision.move` mocks returned partial plain objects (now `CollisionTrace`), `_traceBrushModel` mocks returned that shape too
  but the method returns the player-movement `Trace` (a different class, now `createPmoveTrace`), a `clients` array held `null`s
  though slots are never null, and a trace passed to `wallFriction` had no `dist`.
- **Missing declarations:** untyped `[]` recorders (152 sites), callbacks without parameter types, `@param {T}` JSDoc on a few
  hundred helper parameters.

Shared pieces added or changed:

- `test/support/fixtures.ts`: `MockServer` is `DeepPartial<Server>` plus an index signature, so mock methods get the real
  parameter types and a stale return shape fails; `MockEdict` is a `ServerEdict` (one documented cast in `createMockEdict`, which
  takes the edict number); `MockEntity` takes its optional members from the engine's `BaseEntity` interface; new
  `createPmoveTrace`, `mockedServer()` (replaces reading `engineMocks.SV.` untyped), `RecordedMove`, `BrushModelWithBrushes`.
- `test/support/entityMocks.ts`: inert edicts and engine/game APIs for tests that build a game's entities (`func_plat`,
  `func_door`, `func_train`, `func_rotating`), which each had a 60-line copy of them. Game entities are imported by class now,
  not looked up in `entityClasses`.
- `collision-regressions.test.ts` carried its own copy of nine fixtures (about 330 lines, left over from before they moved);
  it uses the shared ones now. `pmove.test.ts`'s local `createTrace` moved to the shared `createPmoveTrace`.
- `brushtrace.test.ts` swaps static methods with `t.mock.method` (the repo's convention since `7ee3236`) instead of assigning
  and restoring them.

Left as it is, on purpose:

- `pmove.test.ts` and `mapPmoveHarness.ts` still have a copy each of the map entity parsing; worth one shared module, not done
  here because the two differ in what they return.
- `Math.random` is still saved and replaced by hand in a few tests; `t.mock.method(Math, 'random')` would do.
- Casts that remain are `as unknown as X` with a comment, for stand-ins of whole subsystems (hulls, octrees, clients, world
  models, the pmove mover). 34 in the physics tests.

### Phase 2: `test/server/`, `test/shared/`, `test/eslint/` (12 files)

Small. `test/eslint/control-statement-blocks.test.mjs` loads `eslint.rules.mjs`, which is plain JS; it needs a declaration or a
typed import, decide when it turns up.

### Phase 3: `test/common/` (51 files)

Split in two commits' worth of review (network and cvar/command tests, then models and savegames) because of the file count.

### Phase 4: `test/client/` (30 files) and `test/renderer/` (8 files)

Needs the most mocking of DOM and GL shapes. `test/support/renderer.ts`, `clientState.ts` and `menu.ts` exist already.
Per the unit-test conventions the UI-facing tests stay unit tests; a browser pass is not needed for a type-only change, but
the conversion must not touch what a test checks.

### Phase 5: close-out

- Remove the `.mjs` half of every glob in `package.json` and the `.mjs` test paths from `eslint.config.mjs`.
- Update `unit-tests.instructions.md` (the "Only `.test.ts` tests are type-checked" paragraph and the "`.mjs` until their module's
  turn" sentence), `docs/` where it names `.mjs` tests, and `CLAUDE.md`'s typecheck note.
- Tick this bullet in `plans/engine-architecture-modernization.md` (Track G state, the 1.3.0 release section), and record what
  shipped here.
- Then the 1.3.0 bump from the release section, as its own commit.

## Testing

- The test suite is the thing being converted, so the check is that nothing changed: the pass count equals the baseline after
  every phase, and a spot check of three files per phase compares `git diff -M` for assertion lines that moved or vanished.
- A deliberate break: after Phase 1, change a signature a physics test calls and confirm `npm run typecheck` fails, then revert.
  That is the proof the conversion bought what it was for.
- `npm run typecheck` runtime is recorded before and after Phase 4; a large jump is a reason to look at the `test/` include.

## Decisions

- **1.3.0 waits for the engine's tests (2026-10-17).** The 2026-10-13 scope cut is reversed for this item only; Track F, D4 and
  the replay recorder stay postponed.
- **Engine first (2026-10-17).** Game repo tests follow later.
- **By area, helpers first (2026-10-17).** The order of the phases above.

## Open questions

- **The game repos' tests (56 files).** Do they get converted for 1.3.0, or after? They need a commit inside each repo
  (`submodule-aware-commit`), and `tsconfig.json` excludes `source/game/**/test/**` today. Proposed: after, as
  `plans/game-tests-to-typescript.md`.
- **The generic `node:test` mock typing.** `t.mock.method` is used by the existing typed tests (commit `7ee3236`); whether its
  typings hold for the static facades without casts is checked in Phase 0 on two files before the sweep commits to it.
- **Whether the stale-mock failures the typecheck turns up are many.** Unknown until Phase 0. If they run to dozens per area, the
  phases get split smaller, and the count goes here.
