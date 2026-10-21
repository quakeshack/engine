# Track G, type-checked tests, second half: the games' `.mjs` tests become TypeScript

Follow-up to `plans/tests-to-typescript.md` (the engine's tests, done 2026-10-17). Status: **plan drafted 2026-10-21; forks 1, 2 and 4
settled the same day (see "Decisions"), fork 3 is decided per file while converting. Phases 0 to 5 are done (2026-10-21): every test of `id1` and `hellwave` is TypeScript, and both game repos are committed (`id1` `e9ce1a5`, `73be29f` and `38dfaf4`, `hellwave` `5a45681`, `efbb28e`, `5c2a28f` and `1e797dc`). The outer repo (`tsconfig.json`, `package.json`, `test/support/`, the docs and the plans) is committed separately, last. Phase 6, the close-out, is done too: the plan is complete.**
Written for the maintainers. Counts are from a read of the tree on that date (branch `engine-architecture-modernization`;
`source/game/id1` at `3acd2d3`, `source/game/hellwave` at `1e68877`).

## Context

`tsconfig.json` excludes `source/game/**/test/**`, so a game's test that calls a `.ts` method with a stale signature or mocks an
outdated shape keeps passing when the code changes (`unit-tests.instructions.md` records the hazard; it once hid a wrong override
signature in a game mod). The engine's tests are all `.test.ts` and type-checked since 2026-10-17. The games' are not.

| Repo | `.test.mjs` | `.mjs` fixtures | `.ts` | Lines |
| :-- | --: | --: | --: | --: |
| `source/game/id1/test/` | 40 | 0 | 1 (`client/fixtures.ts`, 906 lines, unchecked today) | 10 035 |
| `source/game/hellwave/test/` | 16 | 2 (`client/fixtures.mjs`, `client/menu/fixtures.mjs`) | 0 | 3 051 |

Baseline: `npm run test:game` runs **477 tests, 477 pass** (2026-10-21).

**A measured starting point.** A throwaway `tsconfig` that included the 56 `.mjs` tests as checked JS (`checkJs` is on) reported
**1887 errors in 51 files**, none in production code. Where they are:

| Area | Files | Errors |
| :-- | --: | --: |
| `id1/test/client/` | 5 | 365 (`client.test` 126, `menu.test` 121, `bubble-edict-handler.test` 58) |
| `id1/test/entity/` | 11 | 312 |
| `id1/test/monster/` | 13 | 300 |
| `id1/test/props/` | 4 | 188 (`buttons.test` 90) |
| `id1/test/helper/` and `core/` | 7 | 107 |
| `hellwave/test/client/` | 9 | 389 (`main-menu.test` 109, `new-game-settings-menu.test` 86) |
| `hellwave/test/` (top level) | 7 | 226 (`hellwave-items-zones.test` 76) |

The codes are the ones the engine sweep met: property access on untyped fixture objects (`TS2339`, 732), argument mismatches
(`TS2345`, 254), untyped parameters and recorder arrays (`TS7006`/`TS7005`/`TS7034`, about 510), and access to `private`/`protected`
members (`TS2445`/`TS2341`, 147, a test reaching into an entity's state, which needs a look each).
As JS the checker is more lenient than it will be on `.ts`, so expect more once the files are renamed, not fewer.

What the games' tests have that the engine's did not:

- **A fake engine per file.** Each entity test builds its own edict and engine API (`buttons.test.mjs` has a 60-line edict literal
  and the same lines are in `doors`, `platforms`, `subs`, ...). `test/support/entityMocks.ts` (`createInertEdict` and friends,
  from Track G Phase 1) was written for the physics tests and already imports `source/game/id1/GameAPI.ts` for a type; two game
  tests import `test/support/` today, the rest do not.
- **Top-level `await import(...)`** of the entity modules after `await import('../../GameAPI.ts')`, so that the entity classes
  register in a fixed order. Fine in an ES module `.ts` (`module: ESNext`), but the typed result of a dynamic import needs a
  named type where the file destructures it.
- **A cross-game dependency.** Five Hellwave test files import `../../id1/test/client/fixtures.ts`, the mock of the client engine
  API, menu and HUD. A repo that depends on a file in another game repo's `test/` cannot be checked out or committed alone.
- **Two repos with their own history.** `id1` is a submodule and `hellwave` is an embedded repo the outer repo leaves untracked
  (`submodule-aware-commit`). Anything in `tsconfig.json`, `package.json` or the docs is an outer-repo commit; the tests are
  commits in the game repos.

## Goals

- Every test under `source/game/*/test/` is `.test.ts` and checked by `npm run typecheck`, so the Cloudflare build and the Docker
  `test` stage catch a game test that no longer matches the code.
- Shared fixtures are typed factories, not a copy per file. The number of `as unknown as` casts in game tests is counted at the
  start and does not grow.
- No test loses coverage: 477 tests before, 477 after each phase (except tests added on purpose).
- `npm test`, `npm run typecheck`, `npx eslint` stay green at the end of every phase.

## Non-goals (this pass)

- Changing what a test checks. A test that turns out to assert the wrong thing is flagged and fixed in its own commit.
- Changing a game's logic for a test (`typescript-port.instructions.md`, "Changes that reach into game code"). If a test only
  type-checks after a production change, that change is raised with the developer first and gets its own commit.
- Reaching into private members. Where a test reads or writes a `private`/`protected` member today (147 errors), it either uses
  the public surface, or the member is made accessible on purpose in its own commit. Never a cast to `any`-shaped objects to get
  around it.
- Moving or rewriting the games' fakes beyond what the typed factories need.

## Design

**Conversion rules.** Those of the engine plan, unchanged: `git mv` first and in a step of its own; JSDoc types become TypeScript
(`@typedef` mocks become `interface`s, no `@param {Type}`); imports spell `.ts`; mocks come from typed factories; an `as unknown as`
that stays has a comment saying why; no `any`, `@ts-ignore`, `@ts-expect-error`; names, structure and comments are kept; files
end with an empty line.

**A. Checking the games' tests (outer repo).** `tsconfig.json` today excludes `source/game/**/test/**`. Replace it with an
exclude of `source/game/**/test/**/*.mjs`: the `.ts` files under `test/` are then checked (including the id1 `client/fixtures.ts`
that nothing checks now) and the `.mjs` ones, which `./source/game/**/*.mjs` would otherwise pull in as 1887 errors, stay out
until they are renamed. That is the same one-line widening the engine used, and it never needs a later widening. The last phase
removes the exclude.

**B. Globs.** `test` and `test:game` in `package.json` name `*.test.mjs` under `source/game/`. Each phase adds the `*.test.ts`
half (once, in Phase 0) and the last phase drops the `.mjs` half; the `test-glob-coverage` skill applies, and the games' test
directories are one to three levels deep (`hellwave/test/client/menu/`).

**C. Shared fixtures.** Typed modules for what several files rebuild by hand: the server-side edict and engine API for a game's
entities (extend `test/support/entityMocks.ts`, which `func_*` tests of the physics area already use), and the client engine
API/menu/HUD mock now in `id1/test/client/fixtures.ts` (see Decisions 1). A factory takes the members a test overrides as a
partial of the real interface, as `MockServer` does.

**D. Commits.** Per phase: the game repo gets the rename commit and the conversion commit (inside the repo, `git -C`), then the
outer repo bumps the `id1` pointer and carries any `tsconfig.json`/`package.json`/docs change. `hellwave` is committed inside its
own repo and never added from the outer one. No phase leaves the outer repo pointing at a game commit whose tests the outer
typecheck cannot pass.

## Phasing

Each phase ends with `npm run test:game` at 477, `npm run typecheck` at zero, `npx eslint` clean on the touched files, then stops
for a go-ahead.

### Phase 0: the kit

- `tsconfig.json` exclude (A) and the `*.test.ts` half of the `test`/`test:game` globs (B). Typecheck is green because only
  `id1/test/client/fixtures.ts` is new to it; fix what it reports there.
- The shared fixtures from C that the first phase needs; convert Hellwave's two `fixtures.mjs`.
- Count the `as unknown as` casts in `source/game/**/test` and record the number here.
- Done when: the first `.mjs` test can be converted by following the rules.

#### Phase 0: what shipped (2026-10-21)

`npm run test:game` 477 pass (the baseline), `npm run typecheck` 0 errors, `test/common/test-globs.test.ts` passes, ESLint clean on
`id1/test/client/fixtures.ts`.

- `tsconfig.json`: the exclude is `source/game/**/test/**/*.mjs` instead of `source/game/**/test/**`. The one `.ts` file under a
  game's `test/` (`id1/test/client/fixtures.ts`, 906 lines) is checked now and had no error.
- `package.json`: `test` and `test:game` name `*.test.ts` and `*.test.mjs` under `source/game/`, three nesting levels each.
- **Casts counted:** `as unknown as` appears nowhere in the games' tests (the `.mjs` files cannot carry a cast), so the number to
  keep from growing is 0 and every one added needs its comment.
- **Moved to Phase 5:** converting Hellwave's two `fixtures.mjs`. They are typed against `HellwaveMenu` and the Hellwave client
  game, which Phase 5 types anyway, and nothing before it imports them as `.ts`.
- **The shared edict/engine fixtures** are not written ahead of use: Phase 1 shapes them on `props/buttons.test.mjs`, the file whose
  literal the others repeat, and extends `test/support/entityMocks.ts`.

### Phase 1: `id1/test/core/`, `helper/`, `props/` (11 files, 295 errors)

The smallest files first, so the fixtures get shaped on code with little noise. `props/buttons.test.mjs` is the heaviest and
the one whose edict literal repeats.

#### Phase 1: what shipped (2026-10-21)

All 11 tests of `id1/test/core/`, `helper/` and `props/` are `.test.ts` (`git mv` first, in the id1 repo), type-checked and ESLint clean.
`npm run test:game` 477 pass (the baseline), `npm run typecheck` 0 errors. Starting point was 236 errors. The deliberate-break check
passed: a required parameter on `GameStats.sendToPlayer` made `npm run typecheck` fail in `helper/game-stats.test.ts` besides the three
production callers; reverted.

What the checker found, all fixed in the tests (no production code changed):

- **`ai.test` set `monster.items = 0`**, a member monsters do not have (only the player's reads `items`); the line is gone.
- **`ai.test` and `game-stats.test` mocked what a real class does**: `GameStats.subscribeToEvents` was driven by a hand-made bus; it is the
  engine's `EventBus<Id1ServerEvents>` now, so a wrong event name or payload fails the typecheck. `game-stats` passed `{}` as the game.
- **`misc-helpers.test` called the decorators by hand** ("decorator syntax is not available in .mjs files"). In `.ts` the real
  `@serializable`/`@serializableObject` syntax works under `tsx`, so the fixture classes use it, which is what production does.
- **Private members:** `props/` tests replaced `_sub` (protected) and `buttons.test` replaced `_buttonFire` (private). `_sub` goes through a
  one-method subclass of the entity under test (`TestButton`, `TestDoor`, `TestPlatform`, ...), which TypeScript allows without a cast.
  `_buttonFire` cannot be reached that way: *the touch test now observes the effect* (no `calcMove`, state unchanged) instead of a stub
  of the private method; its button starts in `STATE_BOTTOM` so a fire would be visible. `fog.test` reads `entity.serialize()` instead of
  `_serializer.serialize()`. No member needed a production change.
- **A `null`-vs-`undefined` robustness test** (`getNextBestClient` answering `undefined`) keeps its behavior through one commented cast.

Shared pieces added to the engine's `test/support/`: `createMutableCvarStub` (`cvarStub.ts`), `serializableFieldsOf` (`serialization.ts`),
and in `entityMocks.ts` `createGameTrace`, `createSubStub`, `CalcMoveCall` and `finishMove`. The game tests use `createInertEdict`,
`createInertEngineApi` and `createInertGameApi` from there instead of a 60-line copy of the edict and engine per file.
Casts in the id1 tests: 4 `as unknown as`, each with a comment (the registry stub, the bare `_precacheResources` receiver, the
`undefined` lookup, the entity stub that carries only an edict).

### Phase 2: `id1/test/entity/` (11 files, 312 errors)

#### Phase 2: what shipped (2026-10-21)

All 11 tests of `id1/test/entity/` are `.test.ts`, type-checked and ESLint clean. `npm run test:game` 477 pass (the baseline),
`npm run typecheck` 0 errors. Starting point was 294 errors. A per-file count of `assert.` and `test(` lines against `HEAD` differs in five
files, each by a type guard added (`assert.ok(fields)` so a `string[] | undefined` narrows, `assert.ok(edict.entity instanceof ...)`),
plus `ai.test`, which lost the two `entityClasses.find` guards that the direct imports made unnecessary. No assertion was removed.

Decided with the developer: **`BaseEntity._states` (private static, 58 reads across the tests of the next phases)** is read through
`statesOf(EntityClass)` in `test/support/entityStates.ts`, one commented `as unknown as`. No production change (the alternatives were a public
accessor and a `protected` member).

What the checker found, all fixed in the tests (no production code changed):

- **Protected members** are reached by a subclass of the entity under test with a one-line method (`TestBackpack.afterTouch`, `TestMultipleTrigger.trigger`,
  `TestKey.setInfo`, ...), as in Phase 1. `player-lifecycle.test` runs protected player methods on stand-in receivers through a static
  `PlayerMethods` subclass.
- **`BaseEntity` is abstract** and `base-entity.test` built it directly: it builds `PlainEntity extends BaseEntity` now.
- **`TriggerFieldEntity` keeps `TriggerFieldFlag` bits in `flags`**, whose type is the engine's `flags` enum: the test needs `as number as flags` to set it.
  Worth a production look sometime (a field of its own), not done here.
- **`moveTargetReached` mock returned nothing** while the base method returns `boolean`; the test monster returns `false` now (the caller ignores it).
- **Stand-in players** (`{ isFree: () => false }` as an edict, a bare `{ items, applyBackpack }` as a player) became an inert edict with `isFree` set,
  or one commented cast.
- `items.test`'s deathmatch case passed a `BaseEntity` as the activator of a backpack touch; it is a real player now, which the touch is typed for.

New in `test/support/`: `entityStates.ts` (`statesOf`), and in `entityMocks.ts` `createMutableEngineApi`/`MutableEngineApi` (a test that replaces an engine
member after the entity was built), `createBroadcastRecorder` and `RecordedClientEvent`. Casts in the id1 tests: 10 `as unknown as`, each with a comment.

### Phase 3: `id1/test/monster/` (13 files, 300 errors)

Mostly one shape repeated: a monster, the inert edict, a recorded `sound`/`spawn`. Should be quick once Phase 2's factory exists.

#### Phase 3: what shipped (2026-10-21)

All 13 tests of `id1/test/monster/` are `.test.ts`, type-checked and ESLint clean. `npm run test:game` 477 pass (the baseline),
`npm run typecheck` 0 errors. Starting point was 171 errors. Assertion and test counts against `HEAD` differ in three files (`knights`, `soldier`,
`tarbaby`) by type guards added. Most of the work was mechanical: a script moved the 58 `X._states` / `X['_states']` reads to `statesOf(X)` and the
`X.serializableFields` reads to `serializableFieldsOf(X)`, and the hand-written edict, engine and game API in each fixture became
`createInertEdict`, `createMutableEngineApi` and `createInertGameApi`.

Found while doing it:

- **The script lost a member of one fixture.** `shalrath.test`'s edict had an `isFree()` that the generic replacement dropped; its first run failed with
  `isFree is not a function`. The fixture sets `edict.isFree` again. Every other replaced literal was compared against the canonical inert edict
  (all equal) before moving on.
- **A test helper shadowed a production method.** The wizard test's wrapper for the protected `_attackFinished` was named `attackFinished`, which is a
  public method of `BaseEntity` that `_attackFinished` calls: infinite recursion (the types matched, so only the run showed it). It is `runAttackFinished`
  now, and the other wrapper names of Phases 1 to 3 were checked against the entity classes (none collided).
- **Private members reached through public paths**, which changes how four tests observe, not what they check: `_dieInAnExplosion` (tarbaby) runs as the
  handler of the `tbaby_die2` state; the soldier's `_fire` and the enforcer's `fire` run as the handlers of `army_atk4` and `enf_atk6`; the private
  `_damageInflictor` is no longer replaced. The soldier test spies on `DamageInflictor.prototype.fireBullets` with `t.mock.method` (restored by the
  runner), the shambler test counts the engine's `DispatchBeamEvent` (the inflictor's real `dispatchBeamEvent` reaches it), the tarbaby test uses the real
  `blastDamage` with an engine whose `FindInRadius` finds nothing. **One expectation moved:** the soldier's `face()` count is 2, not 1, because the attack
  frame turns to face the enemy before the shot does. No production change.
- **Stand-ins that the typed API refuses** (`enemy = { origin }`, `_ai = { foundTarget() {} }`, a trace of `{ point }`): `createEntityStub`,
  `createAiStub` (one commented cast each), `createGameTrace`; where the monster has a real AI, the test patches the one method (`_ai.foundTarget = ...`)
  instead of replacing the AI.

New in `test/support/entityMocks.ts`: `EntityConstructor`, `WithMutableEngine`, `createEntityStub`, `createAiStub`, `recordSpawns`/`SpawnRequest`; the inert engine
answers `FindInRadius` with nothing. Casts in the id1 tests: still 10, all commented.

### Phase 4: `id1/test/client/` (5 files, 365 errors)

The client mock is 906 lines of fixture and 912 + 388 + 515 of test. It stays in id1 (Decisions 1) and is already `.ts`; it is
checked from Phase 0 on.

#### Phase 4: what shipped (2026-10-21)

All 5 tests of `id1/test/client/` are `.test.ts` (and `fixtures.ts` was already), so no `.mjs` is left in the id1 repo: type-checked, ESLint clean. `npm run test:game`
477 pass (the baseline), `npm run typecheck` 0 errors. Starting point was 355 errors. Test and assertion counts against `HEAD` differ in four files by type guards added.

Found while doing it:

- **The client mock did not match what the API says.** `createMockClientEngine`'s post-process recording was typed `unknown[]` and `{ channel?: string }`; it uses the real
  `PostProcessStack`, `PostProcessStackOptions`, `PostProcessPulseDescriptor` and `PostProcessPulseOptions` now, so `color-shifts.test` reads a stack entry through
  `colorShiftOf()`, which asserts it is a color shift with color and alpha set. `MockPulse` was dropped (nothing else used it).
- **A stale session in `menu.test`:** the discovered session lacked `ping` and `pingUnreachable`, which the mock channel's type requires; added.
- **`ServerInfo.map` does not exist as a member.** The server-info fields are defined at run time for every server cvar the engine announces; the test reads it through
  `Object.fromEntries(Object.entries(serverInfo))` with a comment.
- **Protected HUD state** (`damage`, `intermission`, `stats`) is read through `HudInspector.damageOf(hud)` and so on: static methods of a subclass that downcast the HUD,
  which TypeScript allows and which changes nothing at run time. Same idea as the one-method subclasses of Phases 1 to 3.
- **Menu widgets:** `pageNamed`, `itemAt(page, index, Widget)` and `itemLabelled` assert the item is the widget the test uses (`Action`, `Toggle`, `SaveSlotItem`), which is
  stricter than the `.mjs` and fails with a message when a page changes shape. `item.action()` returns a promise the tests never awaited; they are marked `void` as before.
- **The alert page is not a `DialogPage`** (it is made by the page class the menu API hands out): an `instanceof` assertion I first added was wrong and is gone.

Shared: `asClientEngineAPI(engine: object)` in `id1/test/client/fixtures.ts` is the one commented cast from a mock or a smaller stand-in to the engine's `ClientEngineAPI`
class (a handler's constructor takes the class, the interface alias is `Readonly<>`). `MockSessionDiscoveryChannel.SubscribeSessions` is a property now, so passing it on
does not trip `unbound-method`. Casts in the id1 tests: 14 `as unknown as`, each commented.

### Phase 5: `hellwave/test/` (16 files plus 2 fixtures, 615 errors)

After Phase 4, so the client fixtures are settled. Committed inside the hellwave repo only.

#### Phase 5: what shipped (2026-10-21)

All 16 tests and both fixture modules of `hellwave/test/` are `.ts`, so no `.mjs` is left in either game repo: type-checked, ESLint clean. `npm run test:game` 477 pass (the
baseline), `npm run typecheck` 0 errors. Starting point was 277 errors once the `fixtures.mjs` imports pointed at `.ts`. Test and assertion counts against `HEAD` differ in one file
(`buy-menu.test`, +2 guards). Committed inside the hellwave repo in three commits: renames only, one production change, the conversion.

**The one production change (decided with the developer):** `HellwaveSuperspike._direction` and `_richochetsLeft` went from `private` to `protected` (`entity/Weapons.ts`), so a test
subclass reads and sets them like every other protected member. No behavior change. The alternatives offered were reading them through `serialize()` and one commented cast.

Found while doing it:

- **The Hellwave fixtures are typed against the real classes:** `HellwaveGameStub` (the client game with the sounds a test inspects), `HellwaveClientdata` (taken as
  `ClientGameAPI['clientdata']`, since it is not exported), and the menu rig, whose page getters assert the page was registered. They did return `null` for a page that was not;
  no test relied on that.
- **Menu pages are read through helpers** (`itemAt`, `pressItem`, `layoutOf` in `hellwave/test/client/menu/fixtures.ts`), in the same way as id1's `menu.test`: each item is asserted to be the
  widget the test uses (`Action`, `Textbox`, `ColorPicker`, `NumberInput`, `Toggle`).
- **The mock engine's overrides merge now.** `createMockClientEngine({ Multiplayer: { SubscribeSessions } })` and the same for `PostProcess` replaced the whole object, so the
  mock had a `Multiplayer` without `ListSessions`. They merge over the base, which is what the types say. `createMockSession` fills in the members of a discovered session a test does not
  care about (`ping`, `pingUnreachable`, `colo`, `country`).
- **`GameManager` and the Hellwave entities take Hellwave's game API**, not id1's: `createInertModGameApi<HellwaveGame>()` in `test/support/entityMocks.ts` is the same inert stand-in typed as the mod's.
- **Events on a real bus:** the stats and manager tests use `EventBus<ServerGameEventMap & HellwaveServerEvents>` (the manager's through a subclass that records what was published) instead of a hand-made bus.
- **An id1 enum meets Hellwave opcodes:** `hellwave-events-docs.test` checked Hellwave opcodes against a `Set` of id1's `clientEvent` values; it is a `Set<unknown>` now.

Casts in the Hellwave tests: 5 `as unknown as`, each commented.

### Phase 6: close-out

- Drop the exclude from `tsconfig.json` and the `.mjs` half of the game globs; `eslint.config.mjs` stops naming game `.mjs` test
  paths if it does.
- `unit-tests.instructions.md` ("The engine's tests are type-checked, the games' are not"), `CLAUDE.md`'s typecheck note,
  `.github/copilot-instructions.md`, `docs/game-module-contract.md` and the `test-glob-coverage` and `dockerfile-fixture-sync`
  skills say that every test is type-checked. Each game's own `CLAUDE.md` (id1 has one) gets the same sentence.
- Tick the open bullet in `plans/tests-to-typescript.md`, and record what shipped here.

## Testing

- The suite is the thing being converted: 477 pass after every phase; a spot check of three files per phase compares
  `git diff -M` for assertion lines that moved or vanished.
- A deliberate break after Phase 1: change a signature a game test calls (a required parameter on an entity method) and confirm
  `npm run typecheck` fails; revert. That is the proof the work bought what it was for.
- No browser pass: nothing in production code changes. If a phase does change production code, it says so and gets one.

## Decisions

Settled with the developer on 2026-10-21:

1. **The client engine API mock stays in `id1/test/client/fixtures.ts`.** Hellwave's tests keep importing it from there; the
   cross-repo dependency is accepted. (The engine's `test/support/` alternative was recommended and not chosen.)
2. **The engine's `test/support/` is the shared kit for the games' tests.** Typed factories go there; the game `CLAUDE.md` files
   say so in Phase 6.
4. **Order:** id1 (core, helper, props, entity, monster, client), then Hellwave.

Decided per file while converting:

3. **Private members that tests reach into (147 errors).** Use the public surface where there is one. A member that needs to
   become accessible is a game logic change: the file is listed here and raised with the developer before it is touched.

## Phase 6: what shipped (2026-10-21)

- `tsconfig.json`: no exclude for the games' tests any more, and the comment about `.mjs` tests is gone; `package.json`: `test` and `test:game` name `*.test.ts` only.
  `test/common/test-globs.test.ts` passes. `eslint.config.mjs` keeps its `{mjs,ts,mts,cts}` patterns, which are generic (they also name the lint rules and config files).
- Say that every test is type-checked, the games' too: `unit-tests.instructions.md` (naming, and the type-check paragraph, which now names the shared kit), `CLAUDE.md`,
  `docs/game-module-contract.md` (the "type-checked" note and the checklist step 4), and `id1`'s `game-logic-conventions.instructions.md` ("Tests"), which also says how a
  protected and a private member are reached. The `writing-engine-tests` skill lists the helpers a game's tests use and the naming trap of a wrapper that shadows a real member.
  The stale `events-docs.test.mjs` names are corrected in `docs/events.md`, the `event-bus-docs-sync` skill and the two games' `Events.ts`.
- `plans/tests-to-typescript.md`: the open bullet about the games is ticked.
- Final numbers: `npm test` 2615 tests, `npm run typecheck` 0 errors, ESLint clean on `source/game`, `test` and `eslint.config.mjs`. Two engine tests failed in the
  full runs and passed alone: `WorkerServerController` ("follows what the worker reports", the timing flake `plans/frame-graph.md` already records) and, once,
  `test/physics/navigation.test.ts` (63 s under load). Neither touches anything of this work.
