# Events

## Engine Events

The engine has an event bus. Each name, its arguments, whether a game sees it and whether it crosses the worker boundary
are declared in `source/shared/EngineEvents.ts`: `EngineEventMap` types the arguments, `engineEventTable` carries the two
flags. The bus is typed by that map, so a typo in a name or a wrong argument is a `tsc` error, and
`test/common/event-map-docs.test.ts` fails when this file and the table disagree. A new event is added to the map, to the
table and to a table below, in that order.

### Common

| Event | Arguments | Description |
| - | - | - |
| com.argv.ready | | `COM.argv`, `COM.rogue`, `COM.hipnotic`, `COM.standard_quake` is now usable. |
| com.registered | 1. `true` when non-shareware | Original Quake 1 game passed the shareware/registered check. |
| com.ready | | `COM` initialized. |
| com.fs.being | 1. filename | Started working on given filename. |
| com.fs.end | 1. filename | Finished working on given filename. |

### Client

| Event | Arguments | Description |
| - | - | - |
| client.paused | | Game has been paused. |
| client.unpaused | | Game has been unpaused. |
| client.cdtrack | 1. track number | CD track for background music requested. |
| client.players.name-changed | 1. num, 2. old name, 3. new name | Emitted whenever someone’s name has changed. |
| client.players.frags-updated | 1. num 2. frags | Emitted whenever someone’s frags have been updated. |
| client.players.colors-updated | 1. num 2. colors | Emitted whenever someone’s colors have changed. |
| client.server-info.ready | 1. map<string,string> | Initial update of server info. |
| client.server-info.updated | 1. name, 2. value | A server info has been updated. |
| client.damage | 1. ClientDamageEvent | Damage event. Sent when the player received damage. |
| client.center-print | 1. message | The server printed text in the middle of the screen, or started a finale or cutscene text. The engine draws nothing of it: the game does, for as long as it wants. |
| client.chat.message | 1. name, 2. message, 3. whether is a direct message or not. | Chat message received. |
| client.clientdata.field-changed | 1. field, 2. value, 3. previousValue | A sparse clientdata field changed in the latest server snapshot. |
| client.disconnected | - | Essentially the game stopped. |
| client.connecting | 1. address | Trying to connect to a server. `M` uses this to force-close any open menu, so a `+connect`/`+map` share link or a console `connect`/`map` command doesn't leave the menu sitting on top of the connecting/loading screen. |
| client.connected | 1. address, or `null` when the socket has none | Successfully connected to a server. |
| client.signon | 1. signon number | Triggered on each signon reply step. |
| client.game-initialized | - | The active game module has finished `ClientGameAPI.Init()` (pages registered, including the root). `M` uses this to show the root menu on cold boot, since `client.disconnected` never fires without a prior connection. |

### Menu

| Event | Arguments | Description |
| - | - | - |
| menu.page-registered | 1. page name | A menu page was registered with the menu stack (`MenuStack.register`). |
| menu.opened | 1. page name, or `null` if the page isn’t registered | A page became the current/visible menu page. |
| menu.closed | 1. page name, or `null` if the page isn’t registered | A page stopped being the current menu page (popped, replaced, or the menu was cleared). |

### Console

| Event | Arguments | Description |
| - | - | - |
| console.print-line | 1. line | When a full line has been written to the console. |

### Cvars

| Event | Arguments | Description |
| - | - | - |
| cvar.registered | 1. Cvar name | When a Cvar has been created. A server in a worker reports it to the page's console, see [server-worker.md](server-worker.md). |
| cvar.changed | 1. Cvar name | When a Cvar has been changed. |
| cvar.changed.<cvar-name> | 1. Cvar | When a specific Cvar has been changed. |

### Frontend

| Event | Arguments | Description |
| - | - | - |
| gl.ready | 1. gl | WebGL rendering context is available now. |
| gl.shutdown |  | WebGL rendering context is no longer available now. |
| gl.texture.ready | 1. identifier | Texture has been uploaded and is ready to be used. |
| renderer.shaders.initialized | | Default shaders have been initialized and can be referenced. |
| renderer.textures.initialized | | Default textures have been initialized and can be referenced. |
| vid.resize | 1. `{ width, height, pixelRatio }` | Dimensions of the rendering canvas have changed. |

### Host

| Event | Arguments | Description |
| - | - | - |
| host.crash | 1. Error, string, or `null`/`undefined` | Emitted when there was an uncaught exception during the main loop. |
| host.ready | - | The engine is initialized and ready to roll. |
| host.shutting-down | - | Shutting down. Start of `ClientHost.Shutdown`/`DedicatedHost.Shutdown`. |
| host.shutdown | - | Shut down. End of `ClientHost.Shutdown`/`DedicatedHost.Shutdown`. |
| host.config.loaded | - | A saved config has been consumed. |
| host.alert | 1. `HostAlertEvent` (`title`, `message`, `severity`: `'info' \| 'error'`) | `ClientHost.EndGame`/`Host.Error` reporting a fault or an expected end-of-game condition. `Con.PrintError`/`PrintSuccess` already ran unconditionally before this publishes, so it's safe for nothing to be subscribed (e.g. a dedicated server, or before any game module has registered a handler) -- this is purely an opt-in richer presentation, not the only place the message is surfaced. |
| host.quit-requested | - | The `quit` command wants confirmation before actually quitting (skipped when typed directly into an already-open console). The engine has no opinion on what a quit confirmation looks like, or whether one exists at all -- if nothing is subscribed, `quit` simply does nothing until a game module registers a handler. |

### Network

Those events are only fired by the server code.

| Event | Arguments | Description |
| - | - | - |
| net.connection.accepted | 1. QSocket | When a new connection has been accepted. |
| net.connection.close | 1. QSocket | Connection closed. |
| net.connection.error | 1. QSocket | Connection received an error. |

### Server

| Event | Arguments | Description |
| - | - | - |
| server.spawning | 1. `{ mapname }` | Emitted when spawning a server. |
| server.spawned | 1. `{ mapname }` | Emitted when spawning a server succeeded. |
| server.edict.assigned | 1. edict id | Emitted when a server edict slot is assigned to a new entity. |
| server.edict.freed | 1. edict id | Emitted when a server edict slot is freed and can be reused. |
| server.shutting-down | | Emitted when shutting a server down. The server is already marked inactive and all clients are still connected. A local client listens for it to disconnect together with its server. |
| server.shutdown | | Emitted when the server is shut down and after cleaning up everything. |
| server.client.connected | 1. client num, 2. client name | Emitted when a client has fully connected and joined the server. |
| server.client.disconnected | 1. client num, 2. client name | Emitted when a client has disconnected from the server. |

### Navigation

Those events are only fired by the server-side navigation subsystem (`Navigation.ts`).

| Event | Arguments | Description |
| - | - | - |
| nav.load | 1. map name, 2. worldmodel checksum | Navigation finished initializing for the current map. |
| nav.path.request | 1. request id, 2. start position (Vector), 3. goal position (Vector) | A pathfinding request was dispatched to the navigation worker; the worker resolves the matching promise via `id`. |
| nav.debug.emit-dot.temporarily | 1. position (Vector), 2. color, 3. ttl (seconds) | Navigation debug visualization requested a debug dot that should be cleared after `ttl` seconds. |
| nav.debug.emit-dot.permanently | 1. position (Vector), 2. color | Same as `nav.debug.emit-dot.temporarily`, but the dot should persist indefinitely. |
| nav.path.response | 1. request id, 2. path (array of points, or `null` when there is none) | The navigation worker answered a `nav.path.request`. |
| nav.build | | The navigation mesh is probably out of date and should be rebuilt. `Navigation` listens for it; nothing publishes it at the moment (the worker's publish is commented out). |

### Workers

Messages between the main thread and a worker (see [workers](workers.md)) travel as
events over the worker's own bus bridge. Not visible to games.

| Event | Arguments | Description |
| - | - | - |
| worker.framework.init | 1. `WorkerFrameworkInitPayload`, 2. URLs | The main thread booted a worker. `WorkerFramework` sets the worker's realm up from it. |
| worker.test | 1. message or `null` | `DummyWorker` prints the message it received. For trying the worker plumbing out. |
| worker.busy | 1. duration in milliseconds | `DummyWorker` busy-waits that long. For trying the worker plumbing out. |
| worker.error | | `DummyWorker` throws. For trying the worker plumbing out. |

### WAD files

| Event | Arguments | Description |
| - | - | - |
| wad.palette.loaded | | When a palette has been loaded. |

### Map dynamics

| Event | Arguments | Description |
| - | - | - |
| areaportals.changed | | Whenever a portal has changed. |

## Events across a server worker

When the server runs in a worker (see [server-worker.md](server-worker.md)) it has an event bus of its own.
Only these events are forwarded to the page's bus, with their arguments, because the page reacts to them:
`server.spawning`, `server.spawned`, `server.shutting-down`, `server.shutdown`, `server.client.connected`,
`server.client.disconnected`, `nav.debug.emit-dot.temporarily` and `nav.debug.emit-dot.permanently`. The list is
`forwardedServerEvents` in `source/engine/common/ServerWorkerProtocol.ts`, derived from the `crossesWorker` flag of
`engineEventTable`. Arguments must survive structured cloning. Any other event stays in the realm that published it.

## Event buses and lifetimes

A game never talks to the engine's own bus. It gets one of these through its engine API, and a game never has to
unsubscribe by hand: the bus is cleared when its lifetime ends (`unsubscribeAll()` has no exceptions).

| Bus | Reached as | Lives | What it receives from the engine |
| - | - | - | - |
| Engine bus | `eventBus` (`common/EventBus.ts`), one per realm (the page, each worker) | the realm | Everything above. Engine code only. Typed by `EngineEventMap`. |
| Client game bus | `ClientEngineAPI.eventBus` | One map: cleared at every `svc.serverdata`, so on connecting and on every changelevel, before the game instance of the next map is built. | The events with the `clientGame` flag in `engineEventTable`, which is what `clientGameEvents` (`ClientState.ts`) is made from: `vid.resize`, `cvar.changed`, `client.paused`, `client.unpaused`, `client.cdtrack`, `client.players.name-changed`, `client.players.frags-updated`, `client.players.colors-updated`, `client.server-info.ready`, `client.server-info.updated`, `client.damage`, `client.chat.message`, `client.clientdata.field-changed`, `client.center-print`, `client.disconnected`, `server.spawning`, `host.alert`, `host.quit-requested`. |
| Client module bus | `ClientEngineAPI.moduleEventBus` | The game module: never cleared. | The same names. Use it for a listener that is set up once (in `ClientGameAPI.Init`) and has to survive reconnects. A listener made on the client game bus in `Init` is dropped at the first map. |
| Server game bus | `ServerEngineAPI.eventBus` | One map: cleared when a map spawns (before the game instance is created) and at shutdown. | The events with the `serverGame` flag in `engineEventTable`: `cvar.changed` (1. cvar name) and `cvar.changed.<cvar-name>` (1. the cvar), in the shapes `Cvar` publishes them. Nothing else: a server game learns about its own lifecycle from `init()` and `shutdown()`. |
| Server module bus | `ServerEngineAPI.moduleEventBus` | The game module, for as long as the server exists: not cleared by a map. | The same events as the server game bus. Use it for a listener that is set up once (in the static `ServerGameAPI.Init`) and has to outlive a map. A listener made on the server game bus in `Init` is dropped at the first spawn. |

Game buses are typed too (`GameEventBus`): the engine events a game is given have their arguments checked, a name the
game publishes itself takes whatever arguments the game gives it, and an engine event name the game was *not* given is a
compile error instead of a listener that is never called. A parameterized name is typed by its family, so
`cvar.changed.sv_nextmap` is checked as `cvar.changed.<cvar-name>`.

Each lifetime is a `Scope` (`common/Scope.ts`): a bus of its own, the forwarding of the engine events its game is given
(by name and, for `cvar.changed.<cvar-name>`, by prefix) and callbacks for what engine code holds as long as the lifetime.
The module scope contains the map scope, and ending the module ends the map first. A scope is not a view over the engine's
bus: what a game publishes stays on the bus of the scope it was published through, even when it uses a name the engine
also publishes (`client.clientdata.field-changed`).

Two more rules:

- **An event that ends a lifetime is published before the listeners of that lifetime are dropped.** `client.disconnected` goes out
  before the client state, and with it the client game bus, is cleared, so a game can take down what it put up (the engine's
  post-process stack outlives the game instance). On a disconnect the order is `ClientGameInterface.shutdown()`, then
  `client.disconnected`, then the release: a game that unsubscribes in `shutdown()` does not hear the event.
- **What a game publishes stays on the bus it was published on.** Client game events do not reach the server game and the
  reverse; the engine bus does not see either. Game events that need to cross do so as game messages, not bus events.

## Game Events

Game modules publish their own events (a `game.*`/`hud.*` family, by convention) rather than
engine code, through the same event bus (`ClientEngineAPI.eventBus`/`ServerEngineAPI.eventBus`)
engine events use, so engine and game code can subscribe to either's events. These are
game-owned facts, not engine facts, so each game documents its own list rather than having it
live here:

- [`id1` events](../source/game/id1/docs/events.md)
- [`hellwave` events](../source/game/hellwave/docs/events.md)

A new game module should add its own `docs/events.md` (mirroring the two above) and a link here,
rather than growing a new per-game section in this file.

### Declaring a game's events

A game declares what it publishes the way the engine does, so that a typo in a name or a wrong payload is a compile
error for its own events as well:

- An interface of event name to argument tuple (`Id1ServerEvents`, `Id1ClientEvents` in `source/game/id1/Events.ts`). A
  module built on another extends that game's interface (`HellwaveServerEvents extends Id1ServerEvents`).
- A client event the server sends by opcode (`BroadcastClientEvent`, `DispatchClientEvent`) arrives as
  `client.event-received.<opcode>`; a map of opcode to arguments gives the topics their types.
- A helper per realm that casts the engine's bus to the typed view once (`serverEvents(engine)`,
  `clientEvents(engine)`). It uses only `TypedEventBus` and the event maps that `shared/GameInterfaces.ts` exports, so
  nothing is imported from the engine and a test that hands the game a hand-made bus keeps working.
- The types say what is *published*. A listener that wants a subtype narrows with `instanceof`.
- A test in the game's own test folder compares the names with the game's `docs/events.md`
  (`test/core/events-docs.test.ts` in id1).
