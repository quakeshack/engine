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

### No index.ts Files

- **Avoid barrel exports**. Use direct imports instead.
- Example: Import `BrushModelRenderer` from `./renderer/BrushModelRenderer.ts`, not `./renderer`.

## General Style Guidelines

- **Use `const` and `let`** instead of `var`.
- **Use camelCase** for variables and functions, PascalCase for classes.
- **Use descriptive names** for variables and functions.
- **Keep functions small** and focused on a single task or a single responsibility.
- **Prefer function declarations** for helper functions when arrow-function semantics are not needed.
- **Use early returns** to reduce nesting and improve readability.
- **Avoid deep nesting**; refactor into helper functions if necessary.
- **Never mutate function parameters**; create new variables instead.
- **Always put code blocks in braces** (`{}`), even for single statements.
- **Do not be too expressive with syntax**; prefer clarity and consistency over cleverness.
- **Use template literals** for string concatenation when it improves readability.
- **Avoid unnecessary boolean checks**, e.g. `if (isReady) { ... }` instead of `if (isReady === true) { ... }`.
- **Avoid standalone functions**, group them into classes when appropriate (i.e. more than three) and use static methods if they do not need to access instance state.

### Control Statement Formatting

When using control statements (`if`, `for`, `while`, etc.) with braces, always place the opening brace on the same line as the statement, but put the code block on the following line(s). This improves readability and follows standard formatting conventions.

### Prefer `switch` over `if`/`else if` chains

When branching on the same discriminant value (a string literal union, an enum, a `typeof`/`type` tag, etc.), use a `switch` statement instead of an `if`/`else if`/`else if` chain. A `switch` makes the shared discriminant and the exhaustive set of branches visually obvious at a glance, whereas an `if`/`else if` chain hides that structure and invites a mismatched condition on one of the branches.

```typescript
// ❌ Avoid this — repeats the discriminant on every branch, easy to typo one
if (status === 'connecting') {
  showMessage('Finding sessions...');
} else if (status === 'reconnecting') {
  showMessage('Unable to fetch sessions');
} else if (status === 'unavailable') {
  showMessage('Unable to fetch sessions');
  logUnavailable();
}

// ✅ Prefer this — the discriminant appears once, branches are exhaustive-checkable
switch (status) {
  case 'connecting':
    showMessage('Finding sessions...');
    break;
  case 'reconnecting':
    showMessage('Unable to fetch sessions');
    break;
  case 'unavailable':
    showMessage('Unable to fetch sessions');
    logUnavailable();
    break;
  default:
    break;
}
```

This does not apply to short-circuit guards, early returns, or branches that each test a genuinely different condition (not the same discriminant) — those stay as `if`/`else`.

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

- **Explicitly initialize variables to `null`** when they will later hold an object reference.
  - In `.ts` files: `let model: BaseModel | null = null;`
  - In `.mjs` files: `let model = /** @type {BaseModel} */ (null);`

### Empty Arrays

- **Initialize empty arrays with `[]`** instead of `new Array()`.
  - In `.ts` files: `const vertices: number[] = [];`
  - In `.mjs` files: `let vertices = /** @type {number[]} */ ([]);`

## Class and Interface Design

### Abstract Base Classes

- Throw `NotImplementedError` for abstract methods.
- Add unreachable return statements if needed for type inference.

### Protected and Private Methods

- **Use `_` prefix** for protected methods. Add `@protected` JSDoc tag.
- **Use `#` prefix** for private methods.
- In `.ts` files, prefer native `protected` / `private` keywords. See `typescript-port.instructions.md`.

### Respect boundaries of abstraction

- **Avoid accessing private or protected members** of other classes directly. Use public methods instead. If not available, consider refactoring.
- **Do not do work of classes outside of them**. If you find yourself needing to manipulate internal state of another class, consider adding a public method to that class instead. Refactoring may be needed to maintain proper encapsulation.
- **A public field is not an invitation to reach in.** Even when a field is technically public (e.g. an internal `Map`/array on a stack or registry class), other classes should still go through a dedicated method rather than reading/mutating the collection directly. Such a field being public often only exists so the *owning* class's own tests can drive it in isolation — that's not the same as it being part of another class's contract. Reaching in couples the caller to the internal representation (a `Map` vs an array, in-place mutation order, ...) instead of a stable behavior, and is exactly as much a boundary violation as reaching into a `private`/`protected` member.

  ```typescript
  // ❌ Reaches into MenuStack's internal Map/array directly from a different class
  class GameAPIs {
    static UnregisterPage(name: string): void {
      M.menuStack.pages.delete(name);
    }

    static GetPreviousPage(): MenuPage | null {
      const stack = M.menuStack.stack;
      return stack.length > 1 ? stack[stack.length - 2] : null;
    }
  }

  // ✅ MenuStack exposes the behavior it owns; callers never see the Map/array
  class MenuStack {
    unregister(name: string): void {
      this.pages.delete(name);
    }

    getPreviousPage(): MenuPage | null {
      return this.stack.length > 1 ? this.stack[this.stack.length - 2] : null;
    }
  }

  class GameAPIs {
    static UnregisterPage(name: string): void {
      M.menuStack.unregister(name);
    }

    static GetPreviousPage(): MenuPage | null {
      return M.menuStack.getPreviousPage();
    }
  }
  ```

## Naming Conventions

- **Variables:** Descriptive names, camelCase. Avoid abbreviations.
  - `model` (or `clmodel`) instead of `m`.
  - `entity` instead of `ent` or `e`.
- **Constants:** UPPER_CASE.
- **Files:** PascalCase for classes (`BrushModelRenderer.ts`), camelCase for utils (`modelUtils.ts`). Always `.ts` for TypeScript source files.

## Comments

- **Use for:** Complex algorithms ("why"), TODOs/FIXMEs (with context), workarounds.
- **Do NOT use for:** Obvious code, inline property descriptions (use JSDoc), commented-out code.
- **Do NOT have empty JSDoc comments**, always add a description.

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
- Avoid empty JSDoc comments, they add no value. If a comment is needed, make sure it provides useful information that is not obvious from the code itself.
