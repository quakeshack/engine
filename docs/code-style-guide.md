# Code Style Guide - QuakeShack Engine

This document outlines the coding conventions and style rules for the QuakeShack Engine codebase.

## JSDoc Documentation

### General Rules

1. **Always use JSDoc** for class properties instead of inline comments
   ```javascript
   // ❌ BAD
   this.boundingradius = 0; // Bounding radius for culling

   // ✅ GOOD
   /** @type {number} Bounding radius for culling */
   this.boundingradius = 0;
   ```

2. **No `@returns {void}` annotations** - It's implied
   ```javascript
   // ❌ BAD
   /**
    * Reset the model
    * @returns {void}
    */
   reset() { }

   // ✅ GOOD
   /**
    * Reset the model
    */
   reset() { }
   ```

3. **Avoid vague types** - Never use `unknown`, `*`, or `any`
   ```javascript
   // ❌ BAD
   /** @type {any} */
   let data;

   // ✅ GOOD
   /** @type {ArrayBuffer} */
   let data;
   ```

4. **No generic `object` type** - Create proper typedefs instead
   ```javascript
   // ❌ BAD
   /** @type {object} */
   this.worldspawnInfo = {};

   // ✅ GOOD
   /**
    * @typedef {Record<string, string>} WorldspawnInfo
    * Parsed worldspawn entity key-value pairs
    */
   /** @type {WorldspawnInfo} */
   this.worldspawnInfo = {};
   ```

5. **Use specific types from imports**
   ```javascript
   // ✅ GOOD
   /** @type {import('./ClientEntities.ts').ClientEdict} */

   // ✅ GOOD for model types
   /** @type {import('../../common/model/BSP.ts').BrushModel} */
   ```

## Reaching Other Modules

There is no registry. A module gets what it needs in one of these ways, in this order of preference:

- **Import it.** `Con`, `Mod`, `Host`, `Cmd`, `Cvar`, `CL`, `M`, `R`, `GL`, `Draw`, `IN`, `Key`, `S`, `SCR`, `V`, `Sys` and the client state (`clientRuntimeState`, `clientStaticState`) are imported directly. Plain ES imports, no destructuring prolog. A cycle between client modules is fine as long as no module builds anything of another module while it is being evaluated; when one has to, move that code into an `Init()` or a lazy getter instead of reordering imports.
- **Page services.** What only the composition root can build (the page's `COM`, `NET`, the client engine API, `urls`, `buildConfig`) is installed once into `source/engine/client/PageServices.ts` by `bootstrap/createBrowserClient.ts` and imported from there as live bindings (`import { com, net } from './PageServices.ts'`).
- **Injection.** Anything that exists per realm or per server (`Server`, `ServerEngineAPI`, `ServerHost`, `Navigation`, the network layer, ...) is a class that receives its collaborators through its constructor, built by the composition root of its realm (`createBrowserClient`, `createDedicatedServer`, `createServerWorker`). Do not carry singletons around in context objects.
- **Hooks.** A shared singleton that must reach into a realm-specific part gets an interface and an assignable member (`Cmd.files`, `Cmd.forwardToServer`, `Cvar.serverState`, `Host.files`, ...) that the composition root fills in.

Code under `network/` and `server/` must not import `client/`, and the import closure of the server worker may contain only the few client data classes that model loading needs (`test/common/engine-boundaries.test.mjs` enforces both).

### Event Bus Usage

Use `eventBus` for **business logic events and lifecycle hooks**, not just initialization:

**Good candidates for eventBus:**
- ✅ System lifecycle: `'gl.ready'`, `'gl.shutdown'`
- ✅ Game state changes: `'game.start'`, `'game.end'`, `'map.loaded'`
- ✅ Resource loading: `'model.loaded'`, `'texture.uploaded'`
- ✅ Cross-module notifications: `'player.spawn'`, `'entity.remove'`
- ✅ Performance events: `'frame.start'`, `'frame.end'`

**Poor candidates for eventBus:**
- ❌ Direct function calls (just call the function)
- ❌ Return values needed (use direct calls or promises)
- ❌ Tight coupling within same module (use methods)
- ❌ Hot paths (performance critical loops)

Example:
```javascript
// ✅ GOOD - Decouple renderer from model loading
eventBus.subscribe('model.loaded', (model) => {
  const renderer = modelRendererRegistry.getRenderer(model.type);
  if (renderer) {
    renderer.prepareModel(model);
  }
});

// In loader
eventBus.publish('model.loaded', loadedModel);
```

### Global GL Context

Use the global `gl` (accessible via `GL.gl` after `'gl.ready'`) instead of passing it as a parameter:

```javascript
// ❌ BAD
render(gl, model, entity) {
  gl.bindBuffer(gl.ARRAY_BUFFER, model.cmds);
}

// ✅ GOOD
render(model, entity) {
  gl.bindBuffer(gl.ARRAY_BUFFER, model.cmds);
}
```

Initialize via event bus:
```javascript
eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});
```

## File Organization

### No index.ts Files

Avoid barrel exports - use direct imports instead:

```javascript
// ❌ BAD (using index.ts)
import { BrushModelRenderer } from './renderer';

// ✅ GOOD (direct import)
import { BrushModelRenderer } from './renderer/BrushModelRenderer.ts';
```

**Rationale:**
- Clearer imports
- Better IDE navigation ("Go to definition" goes to actual file)
- Simpler file structure
- Matches existing codebase patterns

## Method Parameters

### Use `_` Prefix for Unused Parameters

When implementing interfaces or abstract methods where parameters aren't used:

```javascript
// ✅ GOOD - Clear that parameters are intentionally unused
setupRenderState(_pass = 0) {
  // No shared setup needed
}

cleanupModel(_model) {
  // Default implementation: do nothing
}
```

## Type Safety

### Import Paths Must Be Accurate

Always verify import paths are correct:

```javascript
// ❌ BAD - Wrong relative path
/** @param {import('../../../common/model/BSP.ts').BrushModel} model */

// ✅ GOOD - Correct relative path from current file
/** @param {import('../../common/model/BSP.ts').BrushModel} model */
```

### Return Types from Library Functions

Know what types library functions return:

```javascript
// Vector.toRotationMatrix() returns number[], not Float32Array
/** @type {number[]} */
const viewMatrix = entity.lerp.angles.toRotationMatrix();
```

## Class and Interface Design

### Abstract Base Classes

1. Throw `NotImplementedError` for abstract methods
2. Add unreachable return statement for type safety when needed:

```javascript
getModelType() {
  throw new NotImplementedError('ModelRenderer.getModelType must be implemented');
  // eslint-disable-next-line no-unreachable
  return -1; // For TypeScript type inference
}
```

### Protected and Private Methods

Use native TypeScript access modifiers in `.ts` files. Keep `_` prefixes for protected members that subclasses override, and use `#` for methods that are truly private:

```javascript
/**
 * Render opaque surfaces.
 */
protected _renderOpaqueSurfaces(clmodel) {
  // Implementation
}

class SignalingClient {
  #connectSignaling() {
    // Implementation
  }
}
```

Keep `@protected` and `@private` tags only when a mixed JS/TS boundary still needs them.

```javascript
/**
 * Render legacy compatibility state.
 * @private
 */
#renderCompatibilityState() {
  // Implementation
}
```

## Naming Conventions

### Variables
- Use descriptive names, not abbreviations
- Prefer `model` (or `clmodel` in client context) over `m` for model
- Prefer `entity` or `e` over `ent`

### Constants
- Use UPPER_CASE for true constants
- Use native enums like `ModelType.brush` for enum-like values

### Files
- Use PascalCase for class files: `BrushModelRenderer.ts`
- Use camelCase for utility files: `modelUtils.ts`
- Always use `.ts` extension for TypeScript source files

## Comments

### When to Use Comments

1. **Complex algorithms** - Explain the "why"
2. **TODOs and FIXMEs** - Always include context
   ```javascript
   // FIXME: private property access - should use public API
   R.c_alias_polys += clmodel._num_tris;
   ```

3. **Workarounds** - Explain why they're necessary
   ```javascript
   // Note: Uses global `gl` rather than passing as parameter
   ```

### When NOT to Use Comments

1. Don't comment obvious code
2. Don't use inline comments for property descriptions - use JSDoc
3. Don't leave commented-out code

## Architecture Patterns

### Strategy Pattern

When creating polymorphic behavior:
1. Create abstract base class with interface
2. Implement concrete classes for each variant
3. Look the implementation up in a table keyed by type

```javascript
// Base class
export class ModelRenderer { }

// Concrete implementations
export class BrushModelRenderer extends ModelRenderer { }
export class AliasModelRenderer extends ModelRenderer { }

// Registry
export const modelRendererRegistry = new ModelRendererRegistry();
```

### Prefer Composition Over Inheritance

- Use strategy pattern for behavior variations
- Keep inheritance hierarchies shallow
- Use mixins/helpers for shared functionality

## Performance Considerations

1. **Batch similar operations** - Group by type, then render
2. **Minimize state changes** - Setup once, render many
3. **Use streaming buffers** - For dynamic geometry (sprites)
4. **Cache expensive calculations** - Store in entity or model
5. **Language features over function calls** – e.g. always use `for (const i of list)` over `list.forEach(…)`

## Common Pitfalls to Avoid

1. ❌ Don't access private properties from outside the class
2. ❌ Don't mutate arrays/objects passed as parameters (unless that's the purpose)
3. ❌ Don't use `var` - always use `let` or `const`
4. ❌ Don't forget to clean up WebGL resources (buffers, textures)
5. ❌ Don't assume array indices are valid - always validate

## Testing Conventions

1. Test that entities render correctly
2. Verify textures load properly
3. Check animations work (frame interpolation)
4. Look for console errors or visual glitches
5. Test all three model types (brush, alias, sprite)

---

**Note:** This guide is a living document. Update it as new conventions are established.
