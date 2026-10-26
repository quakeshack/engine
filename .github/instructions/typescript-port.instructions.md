## TypeScript Conventions

For the engine, `source/shared/` and the games. Types come from the compiler, not JSDoc. Files end with an empty line.

- `interface` for object shapes, `type` only for unions, intersections, tuples, mapped types. `readonly` / `static readonly` for everything assigned once.
- Native annotations and `as` casts, never `/** @type {X} */`. Never `any`, `unknown`, `*` or bare `object`.
- Every class method has explicit parameter and return types; local arrows need parameter types.
- `enum` for constants; `const enum` only when every consumer is TypeScript and no runtime object is needed.
- File-level type imports, never inline `import('...').Type` (except casting a dynamic `await import()` once).
- Template literals, not concatenation. No constructors that only call `super()`.
- Overridable: `protected _name`; internal: `#name`; overriding: `override`.
- JSDoc carries descriptions, not types: no `@param {Type}`, no `@returns {void}`, no empty blocks; sentences end with a period. Properties get a JSDoc description, not an inline comment.
- `null` for missing values (`undefined` only where `null` means something else); `let x: T | null = null;`, `const list: T[] = [];`. Use `!` when non-null is guaranteed, `console.assert` next to it when in doubt; no redundant null checks.
- No `typeof x.fn === 'function'` probing: `instanceof`, optional chaining or a capability marker (abstract class with `Symbol.hasInstance` for JS callers).
- **Hot paths** (render loops, BSP recursion, movement, input): no tiny helpers just to quiet the type checker; narrow at the use site (`!`, or `as` after a `console.assert`). No `Reflect.get`/dynamic property access. Don't make a required parameter optional to silence the compiler; fix the callers.
- Keep comments when moving code; never delete a TODO/FIXME unless resolved.
- Don't change game logic for an engine change without asking. Change both sides of a shared contract in one step and let `npm run typecheck` find drift.
- Done means: ESLint clean, `npm run typecheck` at zero, tests passing, signatures preserved unless intended, tests for risky untested logic.
