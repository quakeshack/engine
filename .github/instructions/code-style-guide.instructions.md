## Code Style

TypeScript specifics are in `typescript-port.instructions.md`.

### Reaching other modules (in this order of preference)

- **Import it**: `Con`, `Mod`, `Host`, `Cmd`, `Cvar`, `CL`, `M`, `R`, `GL`, `Draw`, `IN`, `Key`, `S`, `Sys`, `clientRuntimeState`, `clientStaticState`. Client import cycles are fine unless a module builds something of another while being evaluated; then move that into `Init()` or a lazy getter, don't reorder imports.
- **Page services**: what only the composition root can build (`COM`, `NET`, client engine API, `urls`, `buildConfig`) is imported as live bindings from `source/engine/client/PageServices.ts`.
- **Injection**: per-realm or per-server things (`Server`, `ServerEngineAPI`, `ServerHost`, `Navigation`, network layer) are classes taking collaborators through the constructor, built by their realm's composition root. No singletons in context objects.
- **Hooks**: a shared singleton reaching into a realm gets an assignable interface member (`Cmd.files`, `Cvar.serverState`, `Host.files`) that the composition root fills in.

`network/` and `server/` must not import `client/`; the server worker's import closure holds only the client data classes model loading needs (`test/common/engine-boundaries.test.ts`).

### Boundaries

Never reach into another class's private, protected or merely-public-for-tests members (`M.menuStack.pages.delete(name)`), and don't do its work from outside: add a method that states the behavior (`M.menuStack.unregister(name)`).

### Conventions

- Use the global `gl` (`GL.gl` after `'gl.ready'`), don't pass it around.
- No `index.ts` barrels; import files directly. Files `.ts`, PascalCase for classes, camelCase for utilities.
- Descriptive names, no abbreviations (`entity`, not `ent`/`e`); UPPER_CASE constants; `_` prefix for unused parameters.
- `const`/`let`, never `var`. Function declarations for helpers; arrows only when their semantics are needed.
- Small single-purpose functions, early returns, no deep nesting, never mutate parameters.
- Braces on every block, body on its own lines (`quakeshack/block-on-own-lines`, fixed by `eslint --fix`).
- No needless boolean comparisons, nothing clever.
- `switch` over an `if`/`else if` chain on one discriminant, ending with `default: break;`.
- More than three standalone functions become a class with static methods. `for...of` over `forEach`; `{}` over `Map` for a few fixed string keys.
- **No old-style global objects** (`const GL = {}; GL.Foo = function`): a class with static members, no wrapper functions around simple operations. A static facade refers to itself as `ClassName.foo`, not `this.foo`; `CL.ts` and `ClientHost.ts` still mix both, standardize when tidying.
- Console commands and cvars: conventions in `docs/console.md`.
- Abstract methods throw `NotImplementedError`. Strategy pattern (abstract base, implementations, registry) for polymorphism; composition over inheritance, shallow hierarchies.

### Comments

For the *why* of complex code, TODO/FIXME with context, and workarounds. Not for obvious code or property descriptions (JSDoc), never commented-out code.

### Performance

Batch similar operations and minimize state changes, stream dynamic geometry, cache expensive results, modify arrays in place and truncate reused ones with `a.length = 0`. Scrap variables instead of allocations in very hot paths. Free WebGL resources when done. Validate array indices. `Math.hypot` outside hot paths.
