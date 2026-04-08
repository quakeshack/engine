## Unit Tests

### Runner and File Layout

- **Test runner**: Node.js built-in (`node:test`). No third-party frameworks.
- **Primary engine glob**: `node --test test/**/*.test.mjs` (see `package.json` scripts).
- **Repo-local game globs**: `node --test source/game/**/test/*.test.mjs source/game/**/test/**/*.test.mjs`.
- **Folder ownership**: Keep engine-owned tests under `test/`. Keep game/mod-owned tests in repo-local folders under `source/game/<repo>/test/`.
- **Repo-local organization**: Within game repos, prefer mirroring the source layout with folders such as `client/`, `entity/`, `helper/`, `monster/`, `props/`, and `core/` when that keeps related tests easier to find.
- **Category globs**: Keep engine tests grouped by top-level area such as `test/common/`, `test/physics/`, and `test/renderer/`.
- **File naming**: `<subsystem>.test.mjs`. One file per production class/module.
- **Shared helpers**: `test/physics/fixtures.mjs` (no `.test.` — never auto-run).
- **All files are ESM** (`.mjs`). Use `import`/`export` exclusively.

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
- `defaultMockRegistry(sv = {})` — provides silent `Con` and `Host.frametime: 0.1`. Pass SV overrides only.
- `withMockRegistry(mockedRegistry, callback)` — temporarily installs a mock registry and fires `registry.frozen`.
- `withMockServerPhysics(callback)` — sets up a complete pusher/rider scenario for `pushMove` tests.
- `assertNear(actual, expected, epsilon)` — floating-point equality within tolerance.
- Geometry helpers: `createAxisPlane`, `createBoxBrushModel`, `createBrushWorldModel`, `createRoomHullFromBounds`, `createLegacyWorldModel`, `createPmoveBoxEntity`.

### Mock Registry Pattern

Never access registry singletons directly in tests. Instead:

```javascript
withMockRegistry(defaultMockRegistry({
  collision: { move() { ... } },
  server: { ... },
}), () => {
  // registry.SV is now the mocked SV object
});
```

When a test needs to capture output (e.g., `Con.Print`), spread the default and override `Con`:

```javascript
withMockRegistry({
  ...defaultMockRegistry(sv),
  Con: { Print(msg) { prints.push(msg); }, DPrint() {} },
}, () => { ... });
```

### JSDoc in Tests

- **Define typedefs** for mock shapes (`MockEntity`, `MockEdict`, `MockRegistryConfig`) in `fixtures.mjs`.
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
