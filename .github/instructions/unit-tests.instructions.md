## Unit Tests

### Runner and File Layout

- **Test runner**: Node.js built-in (`node:test`). No third-party frameworks.
- **Primary engine glob**: `node --test test/**/*.test.mjs` (see `package.json` scripts).
- **Repo-local game globs**: `node --test source/game/**/test/*.test.mjs source/game/**/test/**/*.test.mjs`.
- **Folder ownership**: Keep engine-owned tests under `test/`. Keep game/mod-owned tests in repo-local folders under `source/game/<repo>/test/`.
- **Repo-local organization**: Within game repos, prefer mirroring the source layout with folders such as `client/`, `entity/`, `helper/`, `monster/`, `props/`, and `core/` when that keeps related tests easier to find.
- **Category globs**: Keep engine tests grouped by top-level area such as `test/common/`, `test/physics/`, and `test/renderer/`.
- **Nested test directories**: `npm test`'s glob patterns only reach as many directory levels as `package.json` spells out explicitly (dash has no recursive `**`) — see the `.claude/skills/test-glob-coverage/SKILL.md` skill and verify coverage whenever a new subdirectory level is added under `test/`.
- **File naming**: `<subsystem>.test.mjs` or `<subsystem>.test.ts`. One file per production class/module.
- **Shared helpers**: `test/physics/fixtures.mjs` and the typed ones in `test/support/` (no `.test.` — never auto-run). `test/support/engineMocks.ts` is where a test puts the mocks it wants the engine's parts to see (see "Mock Pattern" below), and `test/support/consoleBridge.ts` makes the engine's shared console print to a mocked `engineMocks.Con`.
- **All files are ESM**. Use `import`/`export` exclusively. New tests and tests of a module that is being converted are written in TypeScript (`<subsystem>.test.ts`, run by `tsx` like the `.mjs` ones, included by the same globs); the rest are `.mjs` until their module's turn.
- **Only `.test.ts` tests are type-checked.** `npm run typecheck` covers `test/**/*.test.ts` and `test/support/**` (shared typed helpers such as `modelContext.ts`); `.mjs` tests and `source/game/**/test/` are outside `tsconfig.json`, so a test that calls a `.ts` method with a stale signature, or mocks an outdated shape, keeps passing when the code changes. After changing a signature or a game/engine contract member, search the tests for it by hand. This once hid a wrong override signature in a game mod behind a green test.

### Test Structure

- **Always use `describe()` blocks** to group tests by method or logical concern.
- Nest `describe()` when a method has multiple distinct scenarios (e.g., `describe('pushMove', () => { ... })`).
- Use plain `test()` inside each `describe`. One assertion focus per test.
- **Test names should describe the observable behavior**, not the implementation detail.
  - Good: `'clears NaNs and clamps to maxvelocity'`
  - Bad: `'calls checkVelocity correctly'`

### Fixture Conventions

Import shared factories from `test/physics/fixtures.mjs`:

- `createMockEntity({ origin, mins, maxs, velocity, ... })` — returns a `MockEntity`.
- `createMockEdict(entity)` — wraps a `MockEntity` in a `MockEdict` with sensible defaults.
- `defaultMockEngine(sv = {})` — provides silent `Con` and `Host.frametime: 0.1`. Pass SV overrides only.
- `withMockEngine(mockedEngine, callback)` — temporarily installs the mocks (client state, host, cheat rule, page `COM`) and restores them afterwards.
- `withMockServerPhysics(callback)` — sets up a complete pusher/rider scenario for `pushMove` tests.
- `assertNear(actual, expected, epsilon)` — floating-point equality within tolerance.
- Geometry helpers: `createAxisPlane`, `createBoxBrushModel`, `createBrushWorldModel`, `createRoomHullFromBounds`, `createLegacyWorldModel`, `createPmoveBoxEntity`.

### Mock Pattern

The engine's parts import their collaborators (`Con`, `Host`, `CL`'s state, `M`, `R`, `Key`, ...), so a test cannot hand them a fake through a lookup table. It patches the real singleton instead and puts it back:

- `withMockEngine(defaultMockEngine({ ... }), () => { ... })` for server-side tests: `Host`, the client state, the cheat rule and the page's `COM` are mocked for the duration of the callback.
- `engineMocks.Key = { destination: 0 }` (and the other facades `Draw`, `IN`, `S`, `SCR`, `V`) patches the members the mock has onto the real facade; assigning back what you read before undoes it. The facade reads as the real one, so state the engine changes is read from `engineMocks.Key`, not from your mock object.
- `engineMocks.COM`, `NET`, `urls` and `buildConfig` install the page services (`client/PageServices.ts`); `installPageServices({ engineApi })` does the same for tests that need to install several.
- `useClientStateOf`, `useHostOf`, `useMenuOf` and `useRendererOf` (`test/support/`) patch the real client state, host, menu and renderer and return a restore function.
- Prefer constructing the class under test with fakes (`new Server(fakeDeps)`, `new Mod()`): per-realm classes take their collaborators through the constructor.

When a test needs to capture output (e.g., `Con.Print`), spread the default and override `Con`:

```javascript
withMockEngine({
  ...defaultMockEngine(sv),
  Con: { Print(msg) { prints.push(msg); }, DPrint() {} },
}, () => { ... });
```

### JSDoc in Tests

- **Define typedefs** for mock shapes (`MockEntity`, `MockEdict`, `MockEngineConfig`) in `fixtures.mjs`.
- **Never use `@returns {object}`** — always use a specific typedef.
- Annotate factory parameters with `@param` when the shape is non-obvious.

### Writing New Tests

1. **One file per production module**: `ServerPhysics` → `test/physics/server-physics.test.mjs`, `Mod` → `test/common/model-cache.test.mjs`.
2. **Game/mod tests live with their repo**: `source/game/id1/test/entity/items.test.mjs`, `source/game/id1/test/monster/ogre.test.mjs`, `source/game/hellwave/test/hellwave-game-api.test.mjs`.
3. **Regression tests go in the relevant subsystem file**, not a catch-all file.
4. **Document magic numbers** with a comment explaining the derivation. Example:
  ```javascript
  // checkStuck tries: 1 (current pos) + 1 (oldorigin) + 18 z × 3 x × 3 y = 164
  assert.equal(testCallCount, 164);
  ```
5. **Prefer precise assertions** (`assert.deepEqual`, `assert.equal`) over loose checks.
6. **Use `assertNear`** for any floating-point comparison.
7. **Avoid `Math.random` in production paths** — if production uses it, save and restore in tests:
  ```javascript
  const originalRandom = Math.random;
  Math.random = () => 0.0;
  try { ... } finally { Math.random = originalRandom; }
  ```

### Running Tests

```bash
npm test               # all tests
npm run test:game      # repo-local game/mod tests
npm run test:common    # common engine tests
npm run test:physics       # all physics tests
npm run test:renderer      # renderer tests
node --test test/physics/server-physics.test.mjs  # single file
```
