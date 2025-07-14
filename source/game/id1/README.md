# QuakeJS Game Code

In general the game code is completely object-oriented and it has *no global state*, therefore we need to carry around both engine interface as well as game interface. This allows the dedicated server to handle multiple servers at the same time enabling dynamic game lobbies etc. The most global state must be the variables on the `ServerGameAPI` object or on the `WorldspawnEntity`.

This repository should give you a good framework to build Quake mods in absolute no time.

## Game

Right now QuakeJS is a clean reimplementation of the Quake game logic.
It might not be perfect though, some idiosyncrasis will be sorted out as part of the code restructuring. Some idiosyncrasis will remain due to compatibility.

During the reimplementation I noticed some bugs/issues within the original Quake game logic that I sorted out. Always trying to keep the actual game play unaffected.

## Core concepts

### Conventions

RFC 2119 applies.

* Every entity must have a unique classname.
* Every entity class should end with “Entity” in their name.
* Every entity class must not change their `classname` during their lifetime.
* Every entity class must have a `QUAKED` jsdoc.
* The game code must not spawn “naked” entities using `spawn()` and simply setting fields during runtime.
* The game code must not assume internal structures of the engine.
* The game code must not use global variables.
* The game code should not hardcode `classname` when used for spawning entities, the game code should use `ExampleEntity.classname` instead of `'misc_example'`.
* Entity properties starting with `_` are considered protected and must and will not be set by the map loading code. If you intend to modify these properties outside of the class defining it, you must mark with with jsdoc’s `@public` annotation.
* Entity properties intended to be read-only must be annotated with jsdoc’s `@readonly` annotation and should be declared throw a getter without a setter.
* Entities must declare properties in the `_declareFields()` method only.
* Entities must declare assets to be precached in the `_precache()` method only.
* Entities must declare states in the `_initStates()` method only.
* Assets required during run-time must be precached by the `WorldspawnEntity`.
* Numbers related to map units should be formated like this: `1234.5`.

#### Related Quake Game Porting

* When porting over QuakeC almost verbatim, comments must be copied over as well in order to give context.
* Settings and/or properties that are considered extensions to the original should be prefixed with `qs_`.

### Edict

The server keeps a list of things in the world in a structure called an Edict.

Edicts will hold information such as baseline of position, orientation, velocity etc. Also keeps track of what part of the map it’s located.

### Entities

An Entity is sitting on top of an Edict. The Entity class will provide logic and keeps track of states. There are also client entities which are not related to these Entity structures.

Entities have a `classname` apart from the JavaScript class name. This classname will be used by the editor to place entities into the world.

However, the engine reads from a set of must be defined properties. `BaseEntity` is defining all of them.

### Core Classes

| Class | Purpose |
|-|-|
| `ServerGameAPI` | Holds the whole server game state. It will be instantiated by the engine’s spawn server code and only lasts exactly one level. The class holds information such as the skill level and exposes methods for engine game updates. Also the engine asks the `ServerGameAPI` to spawn map objects. |
| `ClientGameAPI` | _Not designed yet._ It is supposed to handle anything supposed to run on the client side such as HUD, temporary entities, etc. |
| `BaseEntity` |  Every entity derives from this class. It provides all necessary information for the engine to place objects in the world. Also the engine will write back certain information directly into an entity. This class provides _lots_ of helpers such as the state machine, thinking scheduler and also provides core concepts of for instance damage handling. |
| `PlayerEntity` | The player entity not just represents a player in the world, but it also handles impulse commands, weapon interaction, jumping, partially swimming, effects of having certain items. Some logic is outsourced to helper classes such as the `PlayerWeapons` class. |
| `WorldspawnEntity` | Defines the world, but is mainly used to precache resources that can be used from anywhere. |

### Helper Classes

| Class | Purpose |
|-|-|
| `EntityWrapper` | Wraps a `BaseEntity`, will also add shortcuts for engine API and the current game API instances. |
| `Sub` | This class brings all the `target`/`killtarget`/`targetname` handling to an entity. Also provides movement related helpers. The name is based on the `SUB_CalcMove`, `SUB_UseTargets` etc. prefix. |
| `DamageHandler` | This class brings all logic related to dealing with receiving damage to an entity. |
| `DamageInflictor` | This class brings all more complex logic related to giving out damage. This is optional, every entity will expose `damage` to inflict basic damage to another entity. |
| `Explosions` | A streamlined way on how to turn any entity into an explosion. |

### Base Classes

| Class | Purpose |
|-|-|
| `BaseItemEntity` | Allows easily creating entities containing an item, ammo. This base class provides all logic connected to target handling, respawning (multiplayer games), sound effects etc. |
| `BaseKeyEntity` | Base keys. Main difference are sounds, regeneration, missing removal after picking a key up. |
| `BaseWeaponEntity` | Weapons are based on items, only the sound is different. |
| `BaseProjectile` | A moving object that will cause something upon impact. Used for spikes, rockets, grenades. |
| `BaseTriggerEntity` | Convenient base class to make any kind of triggers. |
| `BaseLightEntity` | Handles anything related to light entities. |
| `BasePropEntity` | Base class to support platforms, doors etc. |
| `BaseDoorEntity` | Base class to handle doors and secret doors. |

### Engine <-> Game

* Access through properties
  * Engine may write to things like `groundentity`, `effects` etc.
  * Engine will read from things like `origin`, `angles` etc.
* Access through methods
  * Engine will communicate with the game through `ServerGameAPI` calling methods like `ClientConnect` and `ClientDisconnect`, but also with entities directly through methods such as `touch` and `think`.
  * Game will communicate mainly through the `ServerEngineAPI` object which is augmented by lots of methods declared on `BaseEntity`.

### Loading QuakeJS

`PR.Init` will try to import the server game code. During that, `ServerGameAPI.Init` will be invoked. This gives you the opportunity to register console variables before the game will actually start. Allowing you to define variables. Later when the server is spawned, `ServerGameAPI.init` will be called on a fresh instance of `ServerGameAPI`.

`CL.Init` will do the similar thing, but on `ClientGameAPI.Init` and `ClientGameAPI.init` while connecting to a game session.

### Game Lifecycle

A game is limited by a map. Every map starts a new game. The engine may prepare the game state by filling `parm0` to `parm15` and calling `SetSpawnParms`.

### Frame Lifecyle

The server has to run every edict and it will run every edict, when certain conditions are met (e.g. `nextthink` is due).

#### General Think

#### Player Think

#### Client Connect/Disconnect

### Example Entity

For full reference, see `entity/Example.mjs`.

Spawn an entity:

```js
const exampleEntity = this.engine.SpawnEntity(ExampleEntity.classname, {
  origin: this.origin,
  owner: this,
  message: 'Hello World!',
});

exampleEntity.greet();
```

