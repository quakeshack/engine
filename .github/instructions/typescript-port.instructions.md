## TypeScript Conventions

Conventions for all TypeScript in the engine, `source/shared/` and the game sources. Rely on the compiler, not on JSDoc, for type information. Files end with an empty line.

### Types

- **Prefer `interface`** for object shapes; `type` only for unions, intersections, tuples and mapped types. Mark every field `readonly` unless it is mutated after construction.
- **Native annotations and `as` casts**, never `/** @type {X} */`: `const materials: Record<string, QuakeMaterial> = {};`, `new Map<number, number[]>()`, `stack.pop()!`.
- **Never `any`, `unknown`, `*` or a bare `object`.** Declare the shape (`Record<string, string>`, an interface).
- **Every class method has explicit parameter and return types.** Local arrow functions need parameter types; the return type may be inferred.
- **Enums**: `enum` for enumeration-like constants; `const enum` only when every consumer is TypeScript and no runtime object is needed.
- **`readonly` / `static readonly`** for anything assigned once.
- **Imports**: file-level imports for types, never inline `import('...').Type`. Exception: a dynamic `await import(...)` whose module type is cast once (`comModule.COM as typeof import('../common/COM.ts')`).
- Use template literals instead of string concatenation. Omit constructors that only call `super()`.

### Access modifiers and overriding

| Intent | Use |
|---|---|
| Overridden by subclasses | `protected _name(...)` (keep the `_` prefix) |
| Internal to the class | `#name(...)` |
| Overrides a base method | `override` (catches signature mismatches) |

### JSDoc

JSDoc carries descriptions, not types. Document class properties with a JSDoc description instead of an inline comment. No `@param {Type}` / `@returns {Type}`, no `@returns {void}`, no empty block; a description is a sentence that ends with a period.

### Null and undefined

- Prefer `null` for a missing value; `undefined` only where `null` already means something else.
- A variable that is assigned later is typed `let model: BaseModel | null = null;`. An empty array is `const vertices: number[] = [];`.
- When non-null is guaranteed, use `!`; when in doubt, add `console.assert(x !== null, 'x required')` next to it (stripped in production). In absolutely guaranteed cases, skip the assert too. Do not add redundant null checks.
- Do not probe for members with `typeof x.fn === 'function'`; use `instanceof`, optional chaining or a runtime capability marker. For capabilities shared with JS callers, a small abstract class with `Symbol.hasInstance` lets engine code use `instanceof`.

### Hot paths (render loops, BSP recursion, movement, input dispatch)

Do not add tiny helpers (`isFoo`, `requireBar`, `getNodeChild`) whose only purpose is to quiet the type checker.

- Narrow at the use site: `const worldmodel = clientRuntimeState.worldmodel!;`, or an `as` cast right after a `console.assert` that proves the invariant.
- Preserve runtime contracts. Do not make a required parameter optional to silence the compiler; fix every caller.
- No `Reflect.get`/`Reflect.set` or other dynamic property access. If a property is part of the contract, put it on an interface or class and read it directly.

```typescript
const frontChild = node.children[0] as Node;
console.assert(frontChild instanceof Node, 'linked child required');
BrushTrace._recursiveHullCheck(ctx, frontChild, p1f, p2f, p1, p2, depth + 1);
```

### Comments

- Keep existing comments when moving or rewriting code, especially those explaining complex logic. **Never delete a TODO or FIXME** unless the issue is fully resolved; update it instead.
- Do not write comments that only describe a type; the type says it. Add a JSDoc description if one is needed.

### Changes that reach into game code

Do not change a game's logic or mechanics for the sake of an engine change. Raise it with the developer first; if the change is needed, add tests for it and keep the existing ones passing. Where the engine and a game share a contract, change both sides in one step and let `npm run typecheck` find the drift.

### Review before finishing a file

ESLint clean (`npx eslint <file>`), `npm run typecheck` at zero, tests passing, signatures preserved unless the API change is intended, tests added for risky logic that had none.
