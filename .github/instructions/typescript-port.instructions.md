
## TypeScript Porting Guide

When porting `.mjs` files to `.ts` (or polishing an earlier verbatim JS→TS port), apply every applicable rule below. The goal is idiomatic, type-safe TypeScript that relies on the compiler rather than JSDoc for type information.

### Interfaces over Type Aliases

- **Prefer `interface`** for object shapes. Only use `type` for unions, intersections, tuples, or mapped types.
- **Mark every field `readonly`** unless the field is genuinely mutated after construction.

```typescript
// ✅ Good
interface Hull {
  readonly clipnodes: Clipnode[];
  readonly planes: Plane[];
  readonly clip_mins: Vector;
  readonly clip_maxs: Vector;
}

// ❌ Bad — type alias for a plain object shape
type Hull = {
  clipnodes: Clipnode[];
  planes: Plane[];
};
```

### Typed Declarations — No JSDoc Type Casts

Replace every `/** @type {X} */` cast with a native TS annotation or `as` cast.

```typescript
// ❌ JSDoc cast
const materials = /** @type {Record<string, QuakeMaterial>} */ ({});
loadmodel.version = /** @type {29|844124994} */ (dv.getUint32(0, true));
const node = /** @type {Node} */ (stack.pop());

// ✅ TS annotation or `as` cast
const materials: Record<string, QuakeMaterial> = {};
loadmodel.version = dv.getUint32(0, true) as 29 | 844124994;
const node = stack.pop()!;            // when non-null is guaranteed
const node = stack.pop() as Node;     // when a type narrowing is needed
```

Apply the same rule to local variables that used a JSDoc `@type` on the preceding line:

```typescript
// ❌ JSDoc-typed local
/** @type {Map<number, number[]>} */
const leafsByType = new Map();

// ✅ TS generic
const leafsByType = new Map<number, number[]>();
```

### Method and Function Signatures

- **Always provide explicit parameter types and return types** on every class method (public, protected, and private).
- For inner arrow / local functions, add parameter types; the return type may be inferred unless it improves clarity.

```typescript
// ❌ Untyped method — leftover from JS
_loadVertexes(loadmodel, buf) {

// ✅ Fully typed
_loadVertexes(loadmodel: BrushModel, buf: ArrayBuffer): void {
```

### JSDoc Cleanup

When a method has TS parameter/return types, remove the redundant JSDoc `@param {Type}` and `@returns {Type}` annotations. **Keep the description text.**

```typescript
// ❌ Redundant JSDoc types
/**
 * Load vertices from BSP lump.
 * @param {BrushModel} loadmodel - The model being loaded
 * @param {ArrayBuffer} buf - The BSP file buffer
 * @returns {void}
 */
_loadVertexes(loadmodel: BrushModel, buf: ArrayBuffer): void {

// ✅ Description only
/**
 * Load vertices from BSP lump.
 * @protected
 */
_loadVertexes(loadmodel: BrushModel, buf: ArrayBuffer): void {
```

- **Never leave an empty JSDoc block** — always add a description sentence.
- **End JSDoc description sentences with a period.**
- **Keep `@protected` and `@private` tags** only during the transition period while the codebase still has `.mjs` callers that rely on them. Once all callers are `.ts`, prefer TS native access modifiers (see below).

### Access Modifiers — `protected` / `private`

Convert JSDoc access annotations to native TS modifiers:

| JSDoc pattern | TS replacement |
|---|---|
| `@protected` + `_` prefix | `protected _methodName(…)` |
| `@private` + `_` prefix | `#methodName(…)` |
| `#methodName` (already private) | keep `#methodName(…)` |

- **Use `protected`** for methods overridden by subclasses (e.g., `_loadFaces` in BSP29Loader → BSP2Loader).
- **Use `#` (hard private)** for methods that are truly internal and never accessed outside the class.
- **Keep the `_` prefix** on protected members for visual consistency during the migration. Once the full codebase is TS, the prefix may be dropped.

### `override` Keyword

Add `override` to every method that overrides a base class method. This catches accidental signature mismatches at compile time.

```typescript
// ✅ Signals this overrides ModelLoader.getMagicNumbers()
override getMagicNumbers(): number[] {
  return [29];
}
```

### `readonly` and `static readonly`

- Mark class fields and static fields `readonly` when they are assigned once (at declaration or in the constructor) and never reassigned.
- Applies to `static` lookup tables, frozen objects, configuration sets, etc.

```typescript
static readonly #lump = Object.freeze({ entities: 0, planes: 1, /* … */ });
static readonly doorClassnames = new Set(['func_door', 'func_door_secret']);
```

### Enums

Port obvious enumeration-like patterns to native TS `enum` (or `const enum` for zero-runtime overhead when all consumers are TS):

```typescript
// ❌ JS-era frozen object enum
const materialFlags = Object.freeze({
  MF_SKY: 1,
  MF_TURBULENT: 2,
  MF_TRANSPARENT: 4,
});

// ✅ TS enum
export enum MaterialFlags {
  MF_SKY = 1,
  MF_TURBULENT = 2,
  MF_TRANSPARENT = 4,
}
```

**When to use `const enum`:** only when every consumer is TypeScript and no runtime object is needed (e.g., internal flags bitfields). Prefer a regular `enum` when the values may be iterated at runtime or exposed to `.mjs` callers.

### Redundant Constructor Removal

Remove empty constructors that only call `super()` with no additional logic — TypeScript (and JavaScript) does this implicitly.

```typescript
// ❌ Redundant
constructor() {
  super();
}

// ✅ Just omit it
```

### Template Literals

Replace string concatenation with template literals for readability.

```typescript
// ❌ Concatenation
throw new Error('Bad lump size in ' + loadmodel.name);

// ✅ Template literal
throw new Error(`Bad lump size in ${loadmodel.name}`);
```

### Null Initialization and Empty Arrays

When porting `null`-initialized or empty-array variables, use TS annotations directly instead of JSDoc casts:

```typescript
// ❌ JSDoc
let model = /** @type {BaseModel} */ (null);
let vertices = /** @type {number[]} */ ([]);

// ✅ TS
let model: BaseModel | null = null;
const vertices: number[] = [];
```

### Checklist (per file)

Use this checklist when polishing a ported `.ts` file:

1. [ ] All `/** @type {X} */` casts → TS annotations or `as` casts.
2. [ ] All method parameters and return types explicitly typed.
3. [ ] JSDoc `@param {Type}` / `@returns {Type}` removed (descriptions kept).
4. [ ] `interface` + `readonly` for all object shape types.
5. [ ] `override` on every overriding method.
6. [ ] `static readonly` on immutable class fields.
7. [ ] `protected` / `private` / `#` replacing JSDoc `@protected` / `@private`.
8. [ ] Obvious enums ported to TS `enum`.
9. [ ] Redundant empty constructors removed.
10. [ ] String concatenation → template literals.
11. [ ] No empty JSDoc blocks — every block has a description ending with a period.
12. [ ] ESLint clean (`npx eslint <file>`).
13. [ ] All tests pass (`npm run test`).

### Avoid inline import type annotations

When importing types, prefer file-level imports over inline `import('…').Type` annotations for better readability and maintainability.

```typescript

// ❌ Inline import type
static _brushMayAffectTrace(ctx: BrushTraceContext, brush: import('./model/BSP.ts').Brush): boolean {
…

// ✅ File-level import
import { Brush } from './model/BSP.ts';
…
static _brushMayAffectTrace(ctx: BrushTraceContext, brush: Brush): boolean {
…
```

Exception: When used in dynamically to load modules like so

```typescript
const comModule = await import(/* @vite-ignore */ serverComId);
const COM = comModule.COM as typeof import('../common/COM.ts');
```

But this is a special case and should not be used as a general pattern for type imports!
