---
name: writing-engine-tests
description: Use when writing or changing a test under test/ or a test helper in test/support/. Lists the shared fixture factories, the mock-installing helpers (withMockEngine, withEngineMocks, engineMocks, use*Of) and how to mock a singleton the engine imports.
---

# Writing engine tests

The always-loaded rules (runner, layout, naming, `describe` structure) are in `.github/instructions/unit-tests.instructions.md`. This is the detail you need while writing the test itself.

## Fixture factories

Most factories are in `test/support/fixtures.ts`:

- `createMockEntity({ origin, mins, maxs, velocity, ... })` returns a `MockEntity`; `createMockEdict(entity)` wraps it in a `MockEdict` with sensible defaults.
- `defaultMockEngine(sv = {})` gives silent `Con` and `Host.frametime: 0.1`. Pass SV overrides only.
- `withMockEngine(mockedEngine, callback)` installs the mocks (client state, host, cheat rule, page `COM`) for the callback and restores them afterwards.
- `withMockServerPhysics(callback)` sets up a complete pusher/rider scenario for `pushMove` tests.
- Geometry: `createAxisPlane`, `createBoxBrushModel`, `createBrushWorldModel`, `createRoomHullFromBounds`, `createLegacyWorldModel`, `createPmoveBoxEntity`, `createBoundsModel`, `createPmoveTrace`.
- `createGameModuleStub`.

Elsewhere in `test/support/`:

- `assertNear(actual, expected, epsilon = 1e-6)` is in `assertions.ts`. It is the only one, and strict by default: pass a looser `epsilon` explicitly when the computation is approximate, and use it for every floating-point comparison.
- `createCvarStub(value)` is in `cvarStub.ts`, `installGlobals(stubs)` in `globals.ts` (it returns the function that undoes it).
- **For a game's tests** (`source/game/<mod>/test/`, which use the same kit): `entityMocks.ts` has the inert stand-ins an entity is built with (`createInertEdict`, `createInertEngineApi`, `createMutableEngineApi`, `createInertGameApi`, and `createInertModGameApi<Game>` for a mod's game API), `createSubStub`/`finishMove` for the movement helper, `createEntityStub`/`createAiStub` for an enemy or an AI that is only read, `createGameTrace`, `recordSpawns` and `createBroadcastRecorder`. `entityStates.ts` (`statesOf(EntityClass)`) reads a monster's state table and `serialization.ts` (`serializableFieldsOf`) the saved field names; `cvarStub.ts` also has `createMutableCvarStub`. A protected member of an entity is reached by a test subclass with a one-method wrapper (`class TestButton extends ButtonEntity { useSub(sub) { this._sub = sub; } }`); name the wrapper so that it does not collide with a real member. The client mock (`createMockClientEngine`, `asClientEngineAPI`) is id1's `test/client/fixtures.ts`.
- `installPageServices` is not a test helper: it is exported by `source/engine/client/PageServices.ts`.
- **Define interfaces** for mock shapes (`MockEntity`, `MockEdict`, `MockEngineConfig`) in `fixtures.ts`. A factory never returns a bare `object`; annotate its parameters when the shape is not obvious.

## Mock pattern

The engine's parts import their collaborators (`Con`, `Host`, `CL`'s state, `M`, `R`, `Key`, ...), so a test cannot hand them a fake through a lookup table. It patches the real singleton and puts it back:

- `withMockEngine(defaultMockEngine({ ... }), () => { ... })` for server-side tests.
- `engineMocks.Key = { destination: 0 }` (and the other facades `Draw`, `IN`, `S`) patches the members the mock has onto the real facade; assigning back what you read before undoes it. The facade reads as the real one, so state the engine changes is read from `engineMocks.Key`, not from your mock object.
- `engineMocks.SCR` is what the screen was before it was dissolved: `UpdateScreen`, `BeginLoadingPlaque`, `EndLoadingPlaque`, `con_current`, `recalc_refdef`, `viewsize`, `fov` and `screenshotClean` are sorted onto `ScreenFrame`, `ConsoleOverlay`, `Viewport`, `ViewCvars` and `Screenshots` (`test/support/screen.ts`). A new test patches those classes directly.
- `engineMocks.COM`, `NET`, `urls` and `buildConfig` install the page services (`client/PageServices.ts`); `installPageServices({ engineApi })` (from `client/PageServices.ts`) installs several at once.
- `withEngineMocks({ Con, Host, CL, ... }, () => { ... })` (`test/support/withEngineMocks.ts`) installs several of these for a callback and puts every one back, whether the callback returns, throws or (when asynchronous) settles; `CL`, `Host`, `M` and `R` are also patched onto the real client state, host, menu and renderer. `installEngineMocks({ ... })` does the same without a callback and returns the function that undoes it. A test helper that saves and restores `engineMocks.X` by hand is a copy of this.
- `useClientStateOf`, `useHostOf`, `useMenuOf` and `useRendererOf` (`test/support/`) patch the real client state, host, menu and renderer and return a restore function.
- `runConsoleCommand` (`test/support/consoleCommands.ts`) runs a `ConsoleCommand` class with the context a test gives it (`{ client: null }`). `test/support/consoleBridge.ts` makes the engine's shared console print to a mocked `engineMocks.Con`. `cvarStub.ts` is for a variable a test only reads.
- Prefer constructing the class under test with fakes (`new Server(fakeDeps)`, `new Mod()`): per-realm classes take their collaborators through the constructor.
- A stand-in for a whole subsystem that has no factory is cast once with `as unknown as T` and a comment saying which members it needs. No `any`, no `@ts-ignore`.

To capture output (e.g. `Con.Print`), spread the default and override `Con`:

```typescript
withMockEngine({
  ...defaultMockEngine(sv),
  Con: { Print(msg) { prints.push(msg); }, DPrint() {} },
}, () => { ... });
```

## Writing a new test

1. **One file per production module**: `ServerPhysics` is `test/physics/server-physics.test.ts`, `Mod` is `test/common/model-cache.test.ts`. A game's tests live with its repo (`source/game/<mod>/test/...`).
2. **Regression tests go in the relevant subsystem file**, not a catch-all file.
3. **Document magic numbers** with a comment explaining the derivation, e.g. `// checkStuck tries: 1 (current pos) + 1 (oldorigin) + 18 z × 3 x × 3 y = 164`.
4. **Precise assertions** (`assert.deepEqual`, `assert.equal`) over loose ones.
5. **`Math.random` in production paths**: save and restore it in the test (`try { ... } finally { Math.random = original; }`).
6. A new test file in a subdirectory deeper than the existing ones is caught by `test/common/test-globs.test.ts` if the npm globs do not reach it; fix the patterns in `package.json`, not the test.
7. A new fixture under `data/` needs a `COPY` line in the Dockerfile's `test` stage (`dockerfile-fixture-sync`).

## Running

```bash
npm test                 # everything
npm run test:game        # repo-local game/mod tests
npm run test:common      # also test:physics, test:renderer
node --import tsx --test test/physics/server-physics.test.ts   # one file
```
