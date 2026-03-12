Here is the code style guide for the QuakeShack Engine.
Please follow these rules when writing or modifying code.

## JSDoc Documentation

### General Rules

1.  **Always use JSDoc** for class properties instead of inline comments.
2.  **No `@returns {void}` annotations** - It's implied.
3.  **Avoid vague types** - Never use `unknown`, `*`, or `any`.
    - Example: Use `ArrayBuffer` instead of `any` for data.
4.  **No generic `object` type** - Create proper typedefs instead.
    - Example: Define `WorldspawnInfo` as `Record<string, string>` instead of just `object`.
    - In case an object is not really defined it, consider defining it.
5.  **Use specific types from imports**.
6.  **Use `@type` for variable declarations** when the type cannot be inferred

## Registry and Global Variables

### Registry Pattern

- **ALWAYS use destructuring** to get registry modules in EVERY file.
- **NEVER access registry modules directly** via properties (e.g., `registry.Con`).
- **Always include the destructuring prolog** at the top of the file, wrapped in a `registry.frozen` event listener if necessary.
- **Do not carry registry items in context objects**; they are singletons.

**Correct Pattern:**

```javascript
let { CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry;

eventBus.subscribe("registry.frozen", () => {
  ({ CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry);
});
```

### Registry Contents

- **In Registry:** `CL`, `COM`, `Con`, `Host`, `Mod`, `SCR`, `SV`, `Sys`, `V`.
- **NOT in Registry:** `GL` (import directly), `Cmd`, `Cvar`.

### Event Bus Usage

Use `eventBus` for **business logic events and lifecycle hooks**.

- **Good Candidates:** `'registry.frozen'`, `'gl.ready'`, `'game.start'`, `'model.loaded'`, `'player.spawn'`, `'frame.start'`.
- **Poor Candidates:** Direct function calls, return values needed, tight coupling, hot paths.
- All events are documented in `docs/events.md`.

### Global GL Context

- Use the global `gl` from the registry (accessible via `GL.gl` after `'gl.ready'`) instead of passing it as a parameter.

## File Organization

### No index.mjs Files

- **Avoid barrel exports**. Use direct imports instead.
- Example: Import `BrushModelRenderer` from `./renderer/BrushModelRenderer.mjs`, not `./renderer`.

## General Style Guidelines

- **Use `const` and `let`** instead of `var`.
- **Use camelCase** for variables and functions, PascalCase for classes.
- **Use descriptive names** for variables and functions.
- **Keep functions small** and focused on a single task or a single responsibility.
- **Use early returns** to reduce nesting and improve readability.
- **Avoid deep nesting**; refactor into helper functions if necessary.
- **Never mutate function parameters**; create new variables instead.
- **Always put code blocks in braces** (`{}`), even for single statements.

### Control Statement Formatting

When using control statements (`if`, `for`, `while`, etc.) with braces, always place the opening brace on the same line as the statement, but put the code block on the following line(s). This improves readability and follows standard formatting conventions.

### Clean up global objects

There are some old-style global objects, try to avoid them, do not replicate them. It’s better to create a class and move methods to it as static members, same applies to variables and properties.

Example:

```javascript

// Avoid this:

const GL = {
  programs: [],
  currentProgram: null,
};

GL.BindProgram = function (program) {
  GL.currentProgram = program;
  gl.useProgram(program);
};

// Better:

class GL {
  static programs = [];
  static currentProgram = null;

  static BindProgram(program) {
    GL.currentProgram = program;
    gl.useProgram(program);
  }
}

// Never this:

function GL_BindProgram(program) {
  GL.currentProgram = program;
  gl.useProgram(program);
}

class GL {
  static programs = [];
  static currentProgram = null;

  static BindProgram(program) {
    GL_BindProgram(program);
  }
}

```

- **Never do indirections through functions** for simple operations. It’s better to call the method directly, even if it’s a static method on a class, than to have an extra function that just calls it. Also not the other way around.
- **Avoid unnecessary global objects**. If you need a namespace, use a class with static members instead of a plain object. This allows for better organization and potential future expansion.

## Method Parameters

### Unused Parameters

- **Use `_` prefix** for parameters that are intentionally unused (e.g., in interface implementations).

## Type Safety

### Import Paths

- **Verify import paths are correct** and relative to the current file.

### Return Types

- **Know your types**. Example: `Vector.toRotationMatrix()` returns `number[]`, not `Float32Array`.

### Use of `null` and `undefined`

- **Prefer `null` over `undefined`** for missing values.
- Unless `null` already has a different meaning in the context, then use `undefined` for missing values.

### `null` initializations

- **Explicitly initialize variables to `null`** when they will later hold an object reference and provide JSDoc type annotations either as cast or an inline comment.
  - Example: `let model = /** @type {BaseModel} */ (null);`

### Empty Arrays

- **Initialize empty arrays with `[]`** instead of `new Array()` and provide JSDoc type annotations.
  - Example: `let vertices = /** @type {number[]} */ ([]);`

## Class and Interface Design

### Abstract Base Classes

- Throw `NotImplementedError` for abstract methods.
- Add unreachable return statements if needed for type inference.

### Protected and Private Methods

- **Use `_` prefix** for protected methods. Add `@protected` JSDoc tag.
- **Use `#` prefix** for private methods.

## Naming Conventions

- **Variables:** Descriptive names, camelCase. Avoid abbreviations.
  - `model` (or `clmodel`) instead of `m`.
  - `entity` instead of `ent` or `e`.
- **Constants:** UPPER_CASE.
- **Files:** PascalCase for classes (`BrushModelRenderer.mjs`), camelCase for utils (`modelUtils.mjs`). Always `.mjs`.

## Comments

- **Use for:** Complex algorithms ("why"), TODOs/FIXMEs (with context), workarounds.
- **Do NOT use for:** Obvious code, inline property descriptions (use JSDoc), commented-out code.

## Architecture Patterns

- **Strategy Pattern:** Use for polymorphic behavior (Abstract base -> Concrete impls -> Registry lookup).
- **Composition over Inheritance:** Shallow hierarchies, mixins/helpers.
- **Use Inheritance for:** Polymorphism, shared base functionality.

## Performance Considerations

- **Batch similar operations**.
- **Minimize state changes**.
- **Use streaming buffers** for dynamic geometry.
- **Cache expensive calculations**.
- **Use `for...of` loops** over `forEach`.
- **Avoid unnecessary array copying**; use in-place modifications when possible.
- **Use `{}` over `Map` for small key-value pairs** when keys are strings and not dynamically added/removed.
- **Consider using scrap variables** for temporary values in very hot paths instead of creating new objects.

## Dangling Resources

- **Always clean up WebGL resources** (buffers, textures, shaders) when no longer needed.
- **Always truncate arrays** (e.g. `a.length = 0`) when reusing them to both avoid memory leaks and in case some reference is kept elsewhere.

## Common Pitfalls

- Do not access private properties externally.
- Do not mutate parameters unexpectedly.
- **Use `let` or `const`**, never `var`.
- Clean up WebGL resources.
- Validate array indices.

## Random Tips

- **Prefer `Math.hypot(x, y)`** over `Math.sqrt(x*x + y*y)` in not so hot paths and when range is not critical.
