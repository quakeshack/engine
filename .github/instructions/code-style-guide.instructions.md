Code style for the QuakeShack Engine. TypeScript specifics (types, modifiers, null handling, JSDoc) are in `typescript-port.instructions.md`.

## Reaching Other Modules

A module gets what it needs in one of these ways, in this order of preference:

- **Import it.** `Con`, `Mod`, `Host`, `Cmd`, `Cvar`, `CL`, `M`, `R`, `GL`, `Draw`, `IN`, `Key`, `S`, `Sys` and the client state (`clientRuntimeState`, `clientStaticState`) are imported directly. A cycle between client modules is fine as long as no module builds anything of another module while it is being evaluated; when one has to, move that code into an `Init()` or a lazy getter instead of reordering imports.
- **Page services.** What only the composition root can build (the page's `COM`, `NET`, the client engine API, `urls`, `buildConfig`) is installed once into `source/engine/client/PageServices.ts` by `bootstrap/createBrowserClient.ts` and imported from there as live bindings (`import { com, net } from './PageServices.ts'`).
- **Injection.** Anything that exists per realm or per server (`Server`, `ServerEngineAPI`, `ServerHost`, `Navigation`, the network layer, ...) is a class that receives its collaborators through its constructor, built by the composition root of its realm (`createBrowserClient`, `createDedicatedServer`, `createServerWorker`). Do not carry singletons around in context objects.
- **Hooks.** A shared singleton that must reach into a realm-specific part gets an interface and an assignable member (`Cmd.files`, `Cmd.forwardToServer`, `Cvar.serverState`, `Host.files`, ...) that the composition root fills in.

Code under `network/` and `server/` must not import `client/`, and the import closure of the server worker may contain only the few client data classes that model loading needs (`test/common/engine-boundaries.test.ts` enforces both).

## Respect boundaries of abstraction

- **Do not reach into another class's private or protected members**, and do not do its work from outside. If it lacks a method you need, add one.
- **A public field is not an invitation to reach in.** An internal `Map` or array that is public only so the owning class's tests can drive it is still not part of another class's contract. Callers use a method that states the behavior (`M.menuStack.unregister(name)`, `M.menuStack.getPreviousPage()`), not `M.menuStack.pages.delete(name)` or `M.menuStack.stack[...]`.

## Conventions

- **Global GL context**: use the global `gl` (`GL.gl` after `'gl.ready'`) instead of passing it as a parameter.
- **Event bus**: use `eventBus` for business logic events and lifecycle hooks (`'gl.ready'`, `'game.start'`, `'player.spawn'`), not for direct calls, return values, tight coupling or hot paths. Rules and documentation duty: `event-bus.instructions.md`.
- **No `index.ts` barrel files.** Import directly (`./renderer/models/BrushModelRenderer.ts`, not `./renderer`).
- **Files**: PascalCase for classes (`BrushModelRenderer.ts`), camelCase for utilities (`modelUtils.ts`), always `.ts`.
- **Names**: descriptive camelCase, PascalCase classes, UPPER_CASE constants, no abbreviations (`model` or `clmodel`, not `m`; `entity`, not `ent` or `e`). Prefix an intentionally unused parameter with `_`.
- **Language**: American English.

## General Style

- `const` and `let`, never `var`. Prefer function declarations for helpers unless arrow-function semantics are needed; `const foo = () => ...` only then.
- Keep functions small and single-purpose. Use early returns, avoid deep nesting, never mutate parameters.
- Always put blocks in braces. The opening brace stays on the statement's line and the body goes on the following lines; the `quakeshack/block-on-own-lines` ESLint rule enforces it for `if`/`else`, the loops and `try`/`catch`/`finally`, and `eslint --fix` rewrites a violation. A one-line arrow function or getter is not a control statement.
- Skip needless boolean comparisons (`if (isReady)`, not `if (isReady === true)`). Do not be clever with syntax.
- **Prefer `switch` over an `if`/`else if` chain** when branching on one discriminant (a literal union, an enum, a type tag). The discriminant appears once and the set of branches is visible; end with `default: break;`. Short-circuit guards, early returns and branches that test different conditions stay as `if`.
- Avoid standalone functions: group more than three into a class with static methods.
- Use `for...of` over `forEach`; use `{}` over `Map` for a few string keys that are never added or removed.

### Clean up global objects

Old-style global objects (`const GL = {...}; GL.BindProgram = function ...`) are not to be replicated. Use a class with static members for the state and the methods:

```typescript
class GL {
  static programs = [];
  static currentProgram = null;

  static BindProgram(program) {
    GL.currentProgram = program;
    gl.useProgram(program);
  }
}
```

- **No indirection through a function** for a simple operation (a `GL_BindProgram()` that the static method merely calls), and not the other way around either.
- **In a static facade class refer to yourself as `ClassName.foo`, not `this.foo`** (`Camera.ts` and `ScreenFrame.ts` do; `CL.ts` and `ClientHost.ts` still mix both because they were once one monolithic file). When tidying such a class, standardize on `ClassName.foo`; `grep -c "this\.[a-zA-Z]"` against `grep -c "ClassName\.[a-zA-Z]"` shows how mixed it is.

### Console commands and variables

- **A command that does not use its context** is a static method declared `this: void` (`static Quit_f(this: void): void`), so `Cmd.AddCommand('quit', ClientHost.Quit_f)` does not trip `@typescript-eslint/unbound-method`.
- **A command that does** (`this.client`, `this.forward()`, `this.command`) is a `ConsoleCommand` subclass, the way `Cmd.Exec_f` and `ClientHost.Savegame_f` are: `static Foo_f = class FooConsoleCommand extends ConsoleCommand { override run(...) {} }`. A `this: ConsoleCommand` method is flagged at every registration. A test runs the class with `runConsoleCommand` (`test/support/consoleCommands.ts`) or through `Cmd.ExecuteString`.
- **Variables live with the class that reads them.** A group of variables with several readers is a `<Group>Cvars` class (`ClientCvars`, `ViewCvars`, `RendererCvars`) with a `register()` method that creates them in the order `cvarlist` shows them; its owner calls `register()` once at startup. Such a file imports `Cvar` and nothing that could import it back.

## Design

- **Abstract base classes** throw `NotImplementedError` from abstract methods (add an unreachable `return` if needed for type inference).
- **Strategy pattern** for polymorphic behavior (abstract base, concrete implementations, registry lookup); composition over inheritance, shallow hierarchies; inheritance for real polymorphism and shared base behavior.

## Comments

Use comments for the *why* of a complex algorithm, for TODO/FIXME with context, and for workarounds. Not for obvious code, not for property descriptions (JSDoc), never for commented-out code.

## Performance and resources

- Batch similar operations, minimize state changes, use streaming buffers for dynamic geometry, cache expensive calculations, avoid copying arrays (modify in place).
- In very hot paths, use scrap variables for temporaries instead of allocating objects.
- Clean up WebGL resources (buffers, textures, shaders) when they are no longer needed.
- Truncate a reused array with `a.length = 0`, so no memory leaks and any other reference sees it empty.
- Validate array indices. Prefer `Math.hypot(x, y)` over `Math.sqrt(x*x + y*y)` outside hot paths where range is not critical.
