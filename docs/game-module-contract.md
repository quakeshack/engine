# Game Module Contract

A game module is a directory under `source/game/<name>/` whose `main.ts` hands the engine three things: an `identification`, a `ServerGameAPI` class and a `ClientGameAPI` class. This page describes what the engine calls on them, in which order, and how the compiler keeps a game and the engine in agreement.

Game modules never import engine files. Everything they need from the engine arrives through the API objects below, and the shared types live in [`source/shared/GameInterfaces.ts`](../source/shared/GameInterfaces.ts). That file is the source of truth: every member there documents who calls or writes it and when.

## Two directions

| Types | Direction | What it is |
| :--- | :--- | :--- |
| `ServerEngineAPI`, `ClientEngineAPI` | game → engine | Objects the engine passes to a game's constructor and `Init`. Everything a game may use from the engine hangs off them. Derived from the real classes in `source/engine/common/GameAPIs.ts`. |
| `ServerGameInterface`, `ClientGameInterface` | engine → game | What the engine calls, reads and writes on a running game instance. |
| `ServerGameConstructor`, `ClientGameConstructor` | engine → game | The class itself: the constructor plus the static hooks (`Init`, ...). |
| `GameModuleInterface` | engine → game | The whole module: `identification` plus both constructors. This is what `main.ts` exports. |

## Making the compiler check a module

A game declares that its classes implement the instance interfaces, and its `main.ts` asserts the whole module against the engine's contract:

```typescript
// source/game/<name>/main.ts
import type { GameModuleIdentification, GameModuleInterface } from '../../shared/GameInterfaces.ts';

import { ServerGameAPI } from './GameAPI.ts';
import { ClientGameAPI } from './client/ClientAPI.ts';

export const identification = {
  name: 'My Game',
  author: 'me',
  version: [1, 0, 0],
  capabilities: [],
} satisfies GameModuleIdentification;

export {
  ClientGameAPI,
  ServerGameAPI,
};

// Compile-time check only: fails the typecheck when this module drifts from the engine's contract.
({ identification, ServerGameAPI, ClientGameAPI }) satisfies GameModuleInterface;
```

```typescript
export class ServerGameAPI implements ServerGameInterface { /* ... */ }
export class ClientGameAPI implements ClientGameInterface { /* ... */ }
```

- `implements` reports instance-side drift on the class member. The `satisfies` line covers what `implements` cannot: the constructor signature, the static hooks and the identification.
- A game that extends another game's API class inherits the `implements` but still asserts `satisfies` in its own `main.ts`, because its statics and constructor can differ.
- `npm run typecheck` runs these checks. It gates the Cloudflare build (`npm run build:wrangler`) and the Docker `test` stage, because Vite and esbuild strip types without checking them.
- Unit tests are `.mjs` files and are not type-checked. A test double that mirrors an outdated signature keeps passing, so grep the tests when you change a member.

## Identification and capabilities

- `name` and `author` must be identical on client and server. The server announces them, and the client refuses to connect on a mismatch.
- `version` is `[major, minor, patch]`. The client hands the server's version to `ClientGameAPI.IsServerCompatible`.
- `capabilities` lists optional engine behaviors the game opts into, from the `gameCapabilities` enum in `source/shared/Defs.ts`. Unknown values are rejected when the module loads.

## Lifecycle

### Loading, once per process

1. `Host.Init` calls `GameModule.Init()`. It picks the game directory (`-game <dir>`, `?game=<dir>` in the browser, or the build-time default), loads its `main.ts`, and checks the runtime shape: identification, supported capabilities, both classes present.
2. `ServerGameAPI.Init(ServerEngineAPI)` runs. It is static, and the place to register cvars.
3. On a client, `ClientGameAPI.Init(ClientEngineAPI)` runs next (for example to register menu pages), followed by `ClientGameAPI.GetStartGameInterface(ClientEngineAPI)`. Return `null` to keep the engine's default way of starting a game.

### Server, per map

`SV.SpawnServer` runs for `map`, `restart`, `changelevel` and loading a savegame:

1. `new ServerGameAPI(ServerEngineAPI)` creates a fresh instance. Nothing carries over except `serverflags` and the players' spawn parameters (see below).
2. The engine calls `prepareEntity(edict, 'player')` for every player slot and asks `getClientEntityFields()`.
3. `init(mapname, serverflags)` runs.
4. The worldspawn entity is created with `prepareEntity` followed by `spawnPreparedEntity`.
5. Every entity in the map's entity lump gets the same two calls. `prepareEntity` returns `false` to skip an entity. `ServerEngineAPI.SpawnEntity` uses the same pair when the game spawns entities at runtime.

### Server, every frame

- `frametime` is written once per frame. `time` is written right before every call into the game.
- `startFrame()` runs first. Then, for each entity, the engine runs physics and calls the entity's own methods (`think`, `touch`, ...), and for each connected client it calls `PlayerPreThink`, runs the movement physics, then calls `PlayerPostThink`.
- While `force_retouch` is non-zero the engine re-links every entity so stationary triggers re-check their contacts, and decrements it once per frame.

### Server, per player

1. When a client asks to spawn, the engine calls `prepareEntity(edict, 'player', { netname, colormap, team })`, then the player entity's `restoreSpawnParameters(data)`, then `ClientConnect(edict)` and `PutClientInServer(edict)`. While a savegame is being restored, the last two are skipped.
2. When the client reports that it finished loading, the optional `ClientBegin(edict)` runs.
3. The `kill` command calls `ClientKill(edict)`.
4. When a spawned client leaves and the engine can still talk to it (it disconnected, was kicked, or the server shut down), `ClientDisconnect(edict)` runs. It is not called for a client dropped because its connection failed.

### Changing level and shutting down

- On `changelevel` the engine first reads `serverflags` and asks every connected player entity for `saveSpawnParameters()`, then runs the per-map steps above. The old game instance is replaced, and `shutdown` is **not** called on it.
- `shutdown(isCrashShutdown)` runs when the server is shut down: quitting, `map` and `restart`, a local player leaving their own listen server (loading a savegame during a local game does this too), or a failed map load.

### Savegames

`serialize()` and `deserialize(data)` carry game-wide state. Entities are saved separately through their own `serialize()`/`deserialize()`. On the client, `saveGame()` and `loadGame(data)` do the same for client state.

### Client, per map

Every `serverdata` message starts this sequence, on connect and after every `changelevel`:

1. The server announces its game `name`, `author` and `version`. The client rejects a different name or author, then asks `ClientGameAPI.IsServerCompatible(version)`.
2. `new ClientGameAPI(ClientEngineAPI)` creates a new instance. The previous one is replaced without `shutdown()`.
3. The client loads the map's models and sounds, then calls `init()`, followed by `loadGame(data)` when a savegame is being restored.
4. While connected, the engine writes the server's `clientdata` updates into `clientdata` and forwards client events to `handleClientEvent(code, ...args)`.
5. Every frame: `startFrame()`; after the view is calculated, `updateRefDef(refdef)`; `draw()` for the HUD; `drawLoading()` while connecting or changing level. The engine reads `viewmodel` to draw the first-person weapon.
6. `GetClientEdictHandler(classname)` is asked when a client entity is assigned a classname.
7. When the client disconnects, `shutdown()` runs.

## Who writes what

| Member | Written by | Read by | Notes |
| :--- | :--- | :--- | :--- |
| `ServerGameInterface.time` | engine | game | Right before every call into the game. |
| `ServerGameInterface.frametime` | engine | game | Once per frame. |
| `ServerGameInterface.force_retouch` | game sets, engine decrements | engine | While non-zero, every entity is re-linked each frame. |
| `ServerGameInterface.serverflags` | game | engine | Game-defined bits that survive a changelevel (for example Quake's episode runes). Passed to `init`. |
| `ClientGameInterface.clientdata` | engine writes its contents | game | Must be non-null before the first server update arrives. |
| `ClientGameInterface.viewmodel` | game | engine | A `null` model draws nothing. |

## What is not part of the contract

- **Static helpers a game adds for its own use**, such as lists of maps or start-server entries for its menus. The engine never calls them, so they can be named and shaped freely.
- **The static `Shutdown` hooks.** Both constructors declare them, but the engine has no module-unload path yet and never calls them.
- **The entity side.** The engine also calls methods on the entity objects attached to edicts (`think`, `touch`, `use`, ...). That boundary is a hand-written interface in `source/engine/server/Edict.ts` and is not yet checked against a game's entity classes. See [`plans/game-entity-contract.md`](../plans/game-entity-contract.md).

## Current behavior worth knowing

- A changelevel replaces the game instance on both sides without calling `shutdown`. Do not rely on `shutdown` for per-map cleanup.
- `isCrashShutdown` is never `true` today: no engine path raises it.
- `ClientDisconnect` is skipped for clients whose connection failed, so a game cannot rely on it to clean up after every departing player.

## Changing the contract

1. Add, change or remove the member in `GameInterfaces.ts`, with a JSDoc that says who calls or writes it and when. Check that statement against the call sites: the compiler cannot verify lifecycle claims.
2. Run `npm run typecheck`. It lists every game that needs updating.
3. Update this page if the call order or the ownership changed.
4. Search the tests (`.mjs`) for the member: they are not type-checked.
