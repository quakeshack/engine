
## TypeScript Porting Guide

When porting `.mjs` files to `.ts` (or polishing an earlier verbatim JS→TS port), apply every applicable rule below. The goal is idiomatic, type-safe TypeScript that relies on the compiler rather than JSDoc for type information.

Files have to end with an empty line.

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

### Avoid typeof to check existence of functions

```typescript

// ❌ Avoid this pattern
…
if (typeof someModule.someFunction === 'function') {
…
const attachedClient = typeof ent.getClient === 'function' ? ent.getClient() : null;
…

// ✅ Instead, use optional chaining and nullish coalescing
if (sometype instanceof SomeClass) {
…
```

### Hot-Path Narrowing and API Contracts

When TypeScript complains in render loops, BSP recursion, movement code, input dispatch, or other hot paths, do **not** introduce tiny helper functions merely to placate the type checker.

- **Do not create helper functions whose only purpose is syntactic narrowing** such as `isFoo(...)`, `requireBar(...)`, `resolveBaz(...)`, or `getNodeChild(...)` when the call site already knows the invariant and is in a hot path.
- **Prefer local invariant checks** at the use site:
  - `const worldmodel = CL.state.worldmodel!;`
  - `console.assert(worldmodel !== null, 'worldmodel required');`
  - then use the narrowed local directly.
- **Use small local `as` casts only after an adjacent `console.assert(...)` or branch that already proves the invariant.** Keep the cast at the use site instead of hiding it in another function.
- **Preserve existing runtime contracts.** Do not make required parameters optional just to quiet the compiler; fix every caller instead.
- **Avoid `Reflect.get`, `Reflect.set`, and other dynamic property access in hot paths.** If a property is part of the runtime contract, teach the type system about it with an interface or class member and use direct property access.
- **Avoid structural capability probes based on repeated reflective checks** like `typeof Reflect.get(entity, 'serialize') === 'function'` in gameplay code. Prefer a real runtime capability marker when possible.

Example:

```typescript
// ❌ Avoid helper indirection for a known hot-path invariant.
function getNodeChild(node: Node, childIndex: 0 | 1): Node {
  const child = node.children[childIndex];
  console.assert(child instanceof Node, 'linked child required');
  return child as Node;
}

BrushTrace._recursiveHullCheck(ctx, getNodeChild(node, 0), p1f, p2f, p1, p2, depth + 1);

// ✅ Narrow locally where the value is consumed.
const frontChild = node.children[0] as Node;
console.assert(frontChild instanceof Node, 'linked child required');
BrushTrace._recursiveHullCheck(ctx, frontChild, p1f, p2f, p1, p2, depth + 1);
```

For runtime capabilities shared with still-JS game code, prefer a dedicated runtime marker over repeated structural probes. A good pattern is a small abstract class with `Symbol.hasInstance` so engine code can use `instanceof` while JS implementations remain compatible.

```typescript
abstract class SerializableEntity {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
      return false;
    }

    const candidate = value as {
      readonly classname?: unknown;
      readonly serialize?: unknown;
      readonly deserialize?: unknown;
    };

    return typeof candidate.classname === 'string'
      && typeof candidate.serialize === 'function'
      && typeof candidate.deserialize === 'function';
  }
}
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
14. [ ] All original comments preserved, especially TODOs and complex logic explanations.
15. [ ] File ends with an empty line.
16. [ ] If there is some important logic that is not covered by tests yet, add tests for it.
17. [ ] No helper functions were introduced solely for TypeScript narrowing in hot paths.
18. [ ] No hot-path reflective property access was introduced where a typed field or runtime capability marker would do.
19. [ ] Existing method signatures were preserved unless there was an intentional API change.

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

### Porting over comments

Make sure to **always** carry over comments from the original `.mjs` file, especially those that explain complex logic or important context.

However, **do not carry over comments that only describe types** (e.g., "Bounding radius for culling") since the TS types should be self-explanatory. Instead, add a JSDoc comment with a description if needed.

For example, consider this original code snippet with helpful comments:

```javascript
…

    // Calculate bounding box
    this._calculateBounds(loadmodel);

    // Generate tangents and bitangents for normal mapping
    if (loadmodel.normals && loadmodel.texcoords) {
      this._generateTangentSpace(loadmodel);
    }

    // Set texture name (convention: same as model name without .obj)
    const baseName = name.replace(/\.obj$/i, '.png').replace(/^models\//i, 'textures/');
    loadmodel.textureName = baseName;

…
```

❌ Omitting comments:

```typescript

    this.#calculateBounds(loadmodel);

    if (loadmodel.normals !== null && loadmodel.texcoords !== null) {
      this.#generateTangentSpace(loadmodel);
    }

    const baseName = name.replace(/\.obj$/i, '.png').replace(/^models\//i, 'textures/');
    loadmodel.textureName = baseName;

```

✅ With comments preserved and updated:

```typescript

    // Calculate bounding box for frustum culling
    this.#calculateBounds(loadmodel);

    // Generate tangents/bitangents needed for normal mapping
    if (loadmodel.normals !== null && loadmodel.texcoords !== null) {
      this.#generateTangentSpace(loadmodel);
    }

    // Derive texture name from model name (e.g. models/foo.obj → textures/foo.png)
    const baseName = name.replace(/\.obj$/i, '.png').replace(/^models\//i, 'textures/');
    loadmodel.textureName = baseName;

```

**Never ever delete TODO or FIXME unless the underlying issue has been fully resolved.** If the comment is no longer relevant, update it instead of deleting.

### Adding missing tests

If you encounter important logic that is not covered by tests, add new tests to cover it. This is especially critical for complex algorithms, edge cases, or any code that has caused bugs in the past.

If code looks risky or has had bugs before, but there are no tests for it, that's a strong signal that tests should be added. Don't skip this step just to get the TS port done faster — the goal is not just to convert to TypeScript, but to improve code quality and maintainability overall.

### Initialize the registry properly

```typescript

// ❌ This will cause static analysis regarding e.g. Con being undefined:

let { Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = registry);
});

// ✅ Instead, initialize with the helper function that has the correct typing and will be updated when the registry is frozen:

let { Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = getCommonRegistry());
});

```

### Potential null and undefined values

When porting, if you encounter a variable that is initialized to `null` or `undefined` and later assigned an object, make sure to update the type annotation to reflect this. For example:

```typescript

// ❌ Original JS with JSDoc cast
let model = /** @type {BaseModel} */ (null);

// ✅ TS with explicit nullability
let model: BaseModel | null = null;

```

There are cases where the variable is initialized to `null` but is guaranteed to be assigned a non-null value before it is used. In such cases, you can use the non-null assertion operator (`!`) when accessing the variable, or you can refactor the code to ensure that the variable is properly initialized before use.

```typescript
// Example of using non-null assertion
let model: BaseModel | null = null;

function initializeModel() {
  model = new BaseModel();
}

function useModel() {
  console.assert(model !== null, 'Model must be initialized before use');

  model!.doSomething(); // Using non-null assertion
}
```

**Note**: When in doubt, always combine a console.assert() check with the non-null assertion to ensure that the assumption holds true at runtime. This way, if there is a case where the variable is accessed before being initialized, it will throw an error with a clear message. Prefer console.assert() over if-checks that throw errors, as it is more concise and clearly indicates that this is an invariant assumption rather than normal control flow. It will also be stripped out in production builds, so it won't have any performance impact.

#### Avoiding unnecessary null checks together with indirections

Another important optimization while porting over code and in regards to nullability is to **avoid unnecessary null checks**. If you have a variable that is initialized to `null` but is guaranteed to be assigned a non-null value before it is used, you can safely use the non-null assertion operator (`!`) without adding redundant null checks throughout the code.

```typescript

// ❌ ent.entity is guaranteed to be non-null, so the null check would be redundant and add unnecessary complexity

for (const ent of SV.area.tree.queryAABB(mins, maxs)) {
  if (ent.num === 0 || ent.isFree()) {
    continue;
  }

  const eorg = origin.copy().subtract(ent.entity.origin.copy().add(ent.entity.mins.copy().add(ent.entity.maxs).multiply(0.5)));

  if (eorg.len() > radius) {
    continue;
  }

  if (!filterFn || filterFn(ent)) {
    edicts.push(ent);
  }
}

// ✅ Instead, use non-null assertion and add a console.assert to ensure the assumption holds

for (const ent of SV.area.tree.queryAABB(mins, maxs)) {
  if (ent.num === 0 || ent.isFree()) {
    continue;
  }

  const entity = ent.entity!; // Non-null assertion
  console.assert(entity !== null, 'Entity must be initialized before use');

  const eorg = origin.copy().subtract(entity.origin.copy().add(entity.mins.copy().add(entity.maxs).multiply(0.5)));

  if (eorg.len() > radius) {
    continue;
  }

  if (!filterFn || filterFn(ent)) {
    edicts.push(ent);
  }
}

```

In absolutely guaranteed non-null cases, avoid the console.assert as well.

### Do not touch game code unless necessary

When porting the engine code, try to avoid making changes to the core game logic or mechanics unless it is necessary for the TypeScript conversion. Before making any changes, raise a question or discussion to clarify whether the change is necessary and beneficial for the overall codebase. If a change is needed, make sure to add tests to cover the new behavior and ensure that all existing tests still pass.
