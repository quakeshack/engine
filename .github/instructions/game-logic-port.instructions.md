## Game Logic TypeScript Port Guide

This document covers porting the `source/game/` entity system from `.mjs` to `.ts`. It builds on the general [typescript-port.instructions.md](typescript-port.instructions.md) and addresses game-specific patterns: field serialization, the state machine, entity components, and Defs enums.

All rules from the general TS porting guide still apply. This document only adds game-logic-specific guidance.

---

### 1. Serializable Fields — Replace `startFields`/`endFields` with a Decorator

The current JS pattern snapshots `Object.keys()` before and after field assignment to discover which properties to serialize:

```javascript
// ❌ Current JS pattern
_declareFields() {
  super._declareFields();
  this._serializer.startFields();
  this.health = 100;
  this.enemy = null;
  this._serializer.endFields();
  this._damageHandler = new DamageHandler(this);
}
```

In TypeScript, use a **`@serializable` field decorator** that registers the property at class definition time. No runtime key diffing needed.

```typescript
// ✅ TypeScript pattern
class BaseMonster extends BaseEntity {
  @serializable health = 100;
  @serializable enemy: BaseEntity | null = null;

  // Components are regular fields — no decorator, not serialized.
  protected readonly _damageHandler = new DamageHandler(this);
}
```

#### Decorator implementation

Use [TC39 Stage 3 decorators](https://github.com/tc39/proposal-decorators) (native in TypeScript 5.0+, no `experimentalDecorators` flag). The decorator records metadata on the class:

```typescript
const serializableFieldsKey = Symbol('serializableFields');

type SerializableFieldsMap = Map<string, true>;

/**
 * Marks a class field for save/load serialization.
 */
function serializable<This, Value>(
  _target: undefined, context: ClassFieldDecoratorContext<This, Value>,
): void {
  const fieldName = String(context.name);

  context.metadata[serializableFieldsKey] ??= new Map<string, true>();
  (context.metadata[serializableFieldsKey] as SerializableFieldsMap).set(fieldName, true);
}
```

At serialization time, `Serializer` reads the metadata chain (walking the prototype chain to collect inherited decorated fields) instead of relying on an instance-level field list. This:

- Eliminates `startFields()` / `endFields()` entirely.
- Eliminates `_declareFields()` — fields are declared inline on the class body.
- Makes it impossible to forget wrapping a field or accidentally serializing a component.
- Works with `Object.seal(this)` because all fields are already declared as TS class fields.

#### Inheritance

Parent-class decorated fields are automatically included — `Symbol.metadata` propagates up the prototype chain. No `super._declareFields()` call needed.

#### Serializer changes

The `Serializer` constructor changes from taking a `(object, engine)` pair to reading from class metadata:

```typescript
class Serializer {
  getSerializableFields(instance: object): string[] {
    const fields: string[] = [];
    let proto = Object.getPrototypeOf(instance);
    while (proto) {
      const meta = proto.constructor[Symbol.metadata];
      const map = meta?.[serializableFieldsKey] as SerializableFieldsMap | undefined;
      if (map) {
        for (const key of map.keys()) {
          if (!fields.includes(key)) {
            fields.push(key);
          }
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    return fields;
  }
}
```

#### `_declareFields()` removal checklist

| Before (JS) | After (TS) |
|---|---|
| Override `_declareFields()`, call `super._declareFields()` | Delete the method entirely |
| `this._serializer.startFields()` / `endFields()` | Delete both calls |
| Field assignments inside the boundary | Move to class field declarations with `@serializable` |
| Component creation after `endFields()` | Regular class fields, no decorator |
| `this._serializer = new Serializer(this, this.engine)` in constructor | One shared `Serializer` per call, or construct it lazily; the serializer reads metadata, not per-instance lists |

---

### 2. `Object.seal(this)` — Replace with TypeScript Strictness

`BaseEntity` currently calls `Object.seal(this)` after `_declareFields()` to prevent accidental property additions at runtime. In TypeScript this is no longer necessary:

- `noUncheckedIndexedAccess` and strict property checking catch typos at compile time.
- TS class fields define the shape exhaustively.

**Remove `Object.seal(this)` from base entity constructors.** If runtime sealing is still wanted for defense-in-depth against map data injection in `assignInitialData`, do it inside `assignInitialData` after construction — not in the constructor (where it forces the `_declareFields` ceremony).

---

### 3. State Machine — Typed Animation Sequences

The current system defines ~200 states per monster as individual `_defineState()` calls with string keys, string frame names, string next-state references, and untyped `function()` callbacks. Problems:

- Typos in state names or frame names are silent.
- `function() { this._ai.stand(); }` callbacks lose `this` typing.
- Verbose: 8 identical calls for an 8-frame stand loop.

#### 3a. Typed state key union

Each entity class should declare a string literal union of its valid state names:

```typescript
type SoldierState =
  | 'army_stand1' | 'army_stand2' | 'army_stand3' | 'army_stand4'
  | 'army_stand5' | 'army_stand6' | 'army_stand7' | 'army_stand8'
  | 'army_run1'   | 'army_run2'   | 'army_run3'   | 'army_run4'
  // ...
  | 'army_die1'   | 'army_die2'   | 'army_die3';
```

The `_defineState` and `_runState` signatures become generic on the concrete state key:

```typescript
// On BaseEntity<S extends string = string>:
protected static _defineState<S extends string>(
  state: S, keyframe: string | number | null, nextState: S | null, handler?: (this: BaseEntity) => void,
): void;

protected _runState(state?: S | null): boolean;
```

This catches typos at compile time. Generating the union type is straightforward — it is the set of first-argument strings across all `_defineState` calls.

#### 3b. Animation sequence helper

Most state definitions are repetitive animation loops. Introduce a helper that generates a sequence:

```typescript
/**
 * Defines a looping sequence of animation frames.
 * @param prefix - State name prefix (e.g. `'army_stand'`).
 * @param frames - Ordered frame names from the model QC.
 * @param handler - Callback invoked on each frame.
 * @param loop - Whether the last frame loops back to the first. Default `true`.
 */
protected static _defineSequence(
  prefix: string,
  frames: string[],
  handler: (this: BaseEntity, frameIndex: number) => void,
  loop = true,
): void {
  for (let i = 0; i < frames.length; i++) {
    const state = `${prefix}${i + 1}`;
    const next = i < frames.length - 1
      ? `${prefix}${i + 2}`
      : (loop ? `${prefix}1` : null);
    this._defineState(state, frames[i], next, function () { handler.call(this, i); });
  }
}
```

This collapses 8 stand-state calls into one:

```typescript
// ❌ Before: 8 calls
this._defineState('army_stand1', 'stand1', 'army_stand2', function () { this._ai.stand(); });
this._defineState('army_stand2', 'stand2', 'army_stand3', function () { this._ai.stand(); });
// ... 6 more

// ✅ After: 1 call
this._defineSequence('army_stand', ['stand1','stand2','stand3','stand4','stand5','stand6','stand7','stand8'],
  function () { this._ai.stand(); });
```

For sequences where individual frames need different behavior (like walk speeds or firing on frame 4), use the `frameIndex` parameter or fall back to individual `_defineState` calls:

```typescript
const walkSpeeds = [1,1,1,1,2,3,4,4,2,2,2,1,0,1,1,1,3,3,3,3,2,1,1,1];
this._defineSequence('army_walk',
  Array.from({length: 24}, (_, i) => `prowl_${i + 1}`),
  function (frameIndex) {
    if (frameIndex === 0) { this.idleSound(); }
    this._ai.walk(walkSpeeds[frameIndex]);
  });
```

#### 3c. Model QC — Static parsing only

The `_modelQC` string and `_parseModelData` pattern can stay mostly as-is, but:

- Make `_modelData` typed: `static readonly _modelData: Readonly<ParsedQC> | null`.
- Consider moving the raw QC string into a separate `.qc` asset file loaded at build time (Vite raw import) so it doesn't bloat the TS source. Not mandatory, but cleaner for large QC definitions.

#### 3d. Callbacks should be arrow functions or method references

The current `function() { this._ai.stand(); }` pattern requires `call(this)` dispatch and loses TS `this` typing. Options:

1. **Arrow in `_defineState`**: Already works if `_defineState` stores it and `_runState` calls `handler.call(this)`. The `this` parameter annotation gives type safety:
   ```typescript
   this._defineState('army_stand1', 'stand1', 'army_stand2',
     function (this: ArmySoldierMonster) { this._ai.stand(); });
   ```

2. **Named method references**: For unique behaviors (firing, refire checks), define a private method and pass its reference. More readable for complex logic.

---

### 4. Defs Enums — Port to Native TypeScript Enums

Current `Defs.mjs` re-exports engine-side frozen objects and defines game-specific ones:

```javascript
// ❌ Current JS
export const dead = Object.freeze({ DEAD_NO: 0, DEAD_DYING: 1, DEAD_DEAD: 2, DEAD_RESPAWNABLE: 3 });
export const damage = Object.freeze({ DAMAGE_NO: 0, DAMAGE_YES: 1, DAMAGE_AIM: 2 });
```

Port to TS enums per the general TS guide:

```typescript
// ✅ TS enum
export enum Dead {
  NO = 0,
  DYING = 1,
  DEAD = 2,
  RESPAWNABLE = 3,
}

export enum Damage {
  NO = 0,
  YES = 1,
  AIM = 2,
}
```

#### Naming conventions

| JS name | TS name | Members |
|---|---|---|
| `dead.DEAD_NO` | `Dead.NO` | Drop the redundant prefix |
| `damage.DAMAGE_YES` | `Damage.YES` | |
| `moveType.MOVETYPE_PUSH` | `MoveType.PUSH` | |
| `solid.SOLID_TRIGGER` | `Solid.TRIGGER` | |
| `items.IT_SHOTGUN` | `Item.SHOTGUN` | |
| `effect.EF_MUZZLEFLASH` | `Effect.MUZZLEFLASH` | |
| `state.STATE_TOP` | `PropState.TOP` | Rename `state` export to avoid conflict with `_stateCurrent` |

#### Bit-flag enums

For `items`, `flags`, `effects`, and other bitfields, use `const enum` only if no runtime iteration is needed. Otherwise use a regular `enum`. Continue using bitwise operators (`|`, `&`, `~`) — TS enums support this.

```typescript
export enum Item {
  AXE = 4096,
  SHOTGUN = 1,
  SUPER_SHOTGUN = 2,
  // ...
}

// Usage stays the same:
this.items |= Item.QUAD;
this.items &= ~(Item.ARMOR1 | Item.ARMOR2 | Item.ARMOR3);
```

#### Engine re-exports

Values re-exported from `engine/Defs.ts` (`solid`, `moveType`, `flags`, etc.) should be imported directly from the engine module rather than re-exporting through `game/id1/Defs.ts`. If the game-side module needs to add game-specific values, extend via a new enum or union — don't shadow the engine enum.

---

### 5. Entity Components — Typed Composition

#### `EntityWrapper` base

Port `EntityWrapper` to a generic TypeScript class:

```typescript
abstract class EntityWrapper<T extends BaseEntity = BaseEntity> {
  readonly #entity: WeakRef<T>;

  constructor(entity: T) {
    this.#entity = new WeakRef(entity);
  }

  protected get _entity(): T {
    return this.#entity.deref()!;
  }

  protected get _game(): ServerGameAPI {
    return this._entity.game;
  }

  protected get _engine(): ServerEngineAPI {
    return this._entity.engine;
  }
}
```

#### `DamageHandler` and `DamageInflictor`

These already extend `EntityWrapper`. In TS, parameterize on the entity type so that `this._entity` resolves without casts:

```typescript
class DamageHandler extends EntityWrapper<BaseMonster | PlayerEntity> {
  // this._entity is typed — no casts needed for health, thinkPain, etc.
}
```

#### `Sub` (mover helper)

Port similarly. The nested `_moveData` / `_useData` plain objects should become typed interfaces:

```typescript
interface MoveData {
  finalOrigin: Vector | null;
  finalAngle: Vector | null;
  callback: (() => void) | null;
  active: boolean;
}

interface UseData {
  callback: ((activator: BaseEntity) => void) | null;
}
```

If `Sub` needs serialization, its fields should use `@serializable` like everything else.

#### `AI` component

Same pattern — `EntityWrapper<BaseMonster>`. The AI methods (`stand`, `walk`, `run`, `face`, etc.) get proper signatures.

---

### 6. Entity Base Class — Structural Cleanup

#### Constructor simplification

With `@serializable` decorators and TS class fields, the `BaseEntity` constructor shrinks significantly. Fields move to class-body declarations:

```typescript
export default class BaseEntity {
  static readonly classname: string | null = null;
  static readonly clientEdictHandler: typeof BaseClientEdictHandler | null = null;
  static readonly clientEntityFields: string[] = [];

  // Serialized core fields
  @serializable ltime = 0.0;
  @serializable origin = new Vector();
  @serializable oldorigin = new Vector();
  @serializable angles = new Vector();
  @serializable mins = new Vector();
  @serializable maxs = new Vector();
  @serializable absmin = new Vector();
  @serializable absmax = new Vector();
  @serializable size = new Vector();
  @serializable velocity = new Vector();
  @serializable avelocity = new Vector();
  @serializable movetype: MoveType = MoveType.NONE;
  @serializable solid: Solid = Solid.NOT;
  @serializable flags: number = 0;
  // ... remaining fields

  // Non-serialized
  readonly engine: ServerEngineAPI;
  readonly game: ServerGameAPI;

  protected _sub: Sub | null = null;
  protected _damageHandler: DamageHandler | null = null;

  constructor(edict: ServerEdict, gameAPI: ServerGameAPI) {
    this.#edict = edict ? new WeakRef(edict) : null;
    this.engine = gameAPI.engine;
    this.game = gameAPI;
    this._precache();
  }
}
```

This eliminates the ~120-line constructor body that currently assigns every field.

#### `clientEntityFields` — Type-safe with `keyof`

```typescript
static readonly clientEntityFields: readonly (keyof PlayerEntity)[] = [
  'items', 'armortype', 'armorvalue', 'health',
];
```

This catches typos and renames at compile time.

#### `assignInitialData` — Input validation

The current method uses `switch(true)` with `instanceof Vector` / `typeof === 'number'` to cast string values from map data. In TS, define:

```typescript
interface EdictInitialData {
  readonly [key: string]: string;
}
```

And use a type-guard or explicit parse map instead of the generic `instanceof` chain. Consider extracting a `parseFieldValue(currentValue: unknown, rawString: string): unknown` helper.

---

### 7. `ScheduledThink` — Lightweight Typed Class

```typescript
interface ScheduledThink {
  nextThink: number;
  callback: (this: BaseEntity) => void;
  identifier: string | null;
  isRequired: boolean;
}
```

There is no need for `ScheduledThink` to have its own `Serializer`. It should be a plain interface or a lightweight `class` that does not have its own serialization infrastructure. The parent entity's serializer already handles the `_scheduledThinks` array through `TYPE_ARRAY` → `TYPE_SERIALIZABLE` recursion.

However — **reconsider whether `ScheduledThink` needs serialization at all**. The callbacks are `function() {}` closures that get serialized via `toString()` and deserialized via `new Function()`. This is:

- A security concern (`new Function` is eval-adjacent).
- Fragile (arrow functions, closures over locals, minified code all break it).
- Unnecessary if schedule reconstruction happens on load (entities re-schedule their thinks in `spawn()` or state restoration).

If thinks can be reconstructed from entity state after deserialization, drop function serialization entirely and make `ScheduledThink` a simple runtime-only structure.

---

### 8. Entity Registration & Static Members

#### `static classname`

Use `static readonly override` in subclasses:

```typescript
class ArmySoldierMonster extends WalkMonster {
  static readonly classname = 'monster_army' as const;
  // ...
}
```

The `as const` ensures the type is the literal `'monster_army'`, not `string`.

#### Model statics

```typescript
class ArmySoldierMonster extends WalkMonster {
  static readonly classname = 'monster_army' as const;
  protected static readonly _health = 30;
  protected static readonly _size = [new Vector(-16, -16, -24), new Vector(16, 16, 40)] as const;
  protected static readonly _modelDefault = 'progs/soldier.mdl';
  protected static readonly _modelHead = 'progs/h_guard.mdl';
}
```

#### `static _states` typing

```typescript
interface StateDefinition {
  readonly keyframe: string | number | null;
  readonly nextState: string | null;
  readonly handler: ((this: BaseEntity) => void) | null;
}

// On the class:
protected static _states: Readonly<Record<string, StateDefinition>> | null = null;
```

---

### 9. Port Order

Port in dependency order, bottom-up:

1. **`Defs.mjs` → `Defs.ts`** — Enums first; everything depends on them.
2. **`helper/MiscHelpers.mjs` → `helper/MiscHelpers.ts`** — `Serializer`, `EntityWrapper`, decorator infrastructure.
3. **`BaseEntity.mjs` → `BaseEntity.ts`** — Core entity, decorators, state machine.
4. **`Subs.mjs` → `Subs.ts`** — `Sub`, `TriggerFieldEntity`, `DelayedThinkEntity`.
5. **`entity/Weapons.mjs` → `entity/Weapons.ts`** — `DamageHandler`, `DamageInflictor`, projectiles.
6. **`entity/Items.mjs` → `entity/Items.ts`** — Item hierarchy.
7. **`entity/props/` → `.ts`** — `BasePropEntity`, Doors, Platforms, Buttons.
8. **`entity/monster/BaseMonster.mjs` → `BaseMonster.ts`** — Monster base + Walk/Fly/Swim.
9. **Concrete monsters** — Soldier, Demon, Ogre, etc. (one at a time).
10. **`entity/Player.mjs` → `Player.ts`** — Largest entity, do last.
11. **`entity/Triggers.mjs`, `entity/Misc.mjs`, `entity/Worldspawn.mjs`**.
12. **`GameAPI.mjs` → `GameAPI.ts`**, `main.mjs → main.ts`.
13. **`hellwave/` game mod** — After `id1` is fully ported.

At each step: port, add/update unit tests, run `eslint --fix`, verify `tsc --noEmit`.

---

### 10. Unit Test Considerations

- Serialization behavior must be regression-tested: create an entity, serialize, deserialize, assert field equality. The decorator-based approach changes the collection mechanism, so existing serialization round-trip tests need to keep passing.
- State machine tests: verify that `_runState` advances through the expected sequence and invokes handlers. Test with a small synthetic entity, not a full monster.
- `assignInitialData`: test that string-to-type coercion works for Vectors, numbers, and strings. Test that private fields and functions are rejected.
- Mock pattern: use `withMockRegistry` as described in the unit test instructions. Entity construction needs a mock `ServerEngineAPI` and `ServerGameAPI`.

---

### 11. Migration Checklist Per File

For each `.mjs` → `.ts` entity file:

- [ ] Rename to `.ts`.
- [ ] Replace all JSDoc `@type`/`@param` type annotations with TS syntax. Keep description text.
- [ ] Replace `_declareFields()` + `startFields`/`endFields` with `@serializable` field decorators.
- [ ] Remove `Object.seal(this)` from constructors.
- [ ] Convert frozen-object enums to TS `enum`.
- [ ] Add access modifiers (`protected`, `readonly`, `#private`).
- [ ] Add `override` to all overridden methods.
- [ ] Type `_states` and state names.
- [ ] Collapse repetitive `_defineState` sequences with `_defineSequence` where appropriate.
- [ ] Replace `/** @typedef */` imports with `import type`.
- [ ] Verify all components (`DamageHandler`, `Sub`, `AI`) are typed via generic `EntityWrapper<T>`.
- [ ] Run `eslint --fix` and `tsc --noEmit`.
- [ ] Add or update unit tests for serialization round-trip and key behaviors.
- [ ] Delete the old `.mjs` file once all importers reference the `.ts` version.
