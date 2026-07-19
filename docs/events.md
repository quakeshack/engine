# Events

## Engine Events

The engine has an event bus.

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
| client.center-print | 1. message | Center print text was requested. |
| client.chat.message | 1. name, 2. message, 3. whether is a direct message or not. | Chat message received. |
| client.clientdata.field-changed | 1. field, 2. value, 3. previousValue | A sparse clientdata field changed in the latest server snapshot. |
| client.disconnected | - | Essentially the game stopped. |
| client.connecting | 1. address | Trying to connect to a server. |
| client.connected | 1. address | Successfully connected to a server. |
| client.signon | 1. signon number | Triggered on each signon reply step. |

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
| cvar.changed | 1. Cvar name | When a Cvar has been changed. |
| cvar.changed.<cvar-name> | 1. Cvar | When a specific Cvar has been changed. |

### Frontend

| Event | Arguments | Description |
| - | - | - |
| gl.ready | 1. gl | WebGL rendering context is available now. |
| gl.shutdown |  | WebGL rendering context is no longer available now. |
| gl.texturemode | 1. name, 2. min, 3. max | Texture mode has changed. |
| gl.texture.ready | 1. identifier | Texture has been uploaded and is ready to be used. |
| renderer.shaders.initialized | | Default shaders have been initialized and can be referenced. |
| renderer.textures.initialized | | Default textures have been initialized and can be referenced. |
| vid.resize | 1. width, 2. height, 3. pixelRatio | Dimensions of the rendering canvas have changed. |
| vid.ready | | Viewport is ready. |
| vid.shutdown | | Viewport is gone. |

### Host

| Event | Arguments | Description |
| - | - | - |
| host.crash | 1. Error | Emitted when there was an uncaught exception during the main loop. |
| host.ready | - | The engine is initialized and ready to roll. |
| host.shutting-down | - | Shutting down. Being of Host.Shutdown. |
| host.shutdown | - | Shut down. End of Host.Shutdown. |
| host.config.loaded | - | A saved config has been consumed. |
| host.alert | 1. `HostAlertEvent` (`title`, `message`, `severity`: `'info' \| 'error'`) | `Host.EndGame`/`Host.Error` reporting a fault or an expected end-of-game condition. `Con.PrintError`/`PrintSuccess` already ran unconditionally before this publishes, so it's safe for nothing to be subscribed (e.g. a dedicated server, or before any game module has registered a handler) -- this is purely an opt-in richer presentation, not the only place the message is surfaced. |
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
| server.spawning | 1. map name | Emitted when spawning a server. |
| server.spawned | 1. map name | Emitted when spawning a server succeeded. |
| server.edict.assigned | 1. edict id | Emitted when a server edict slot is assigned to a new entity. |
| server.edict.freed | 1. edict id | Emitted when a server edict slot is freed and can be reused. |
| server.shutting-down | | Emitted when shutting a server down. All clients are still connected. |
| server.shutdown | | Emitted when the server is shut down and after cleaning up everything. |
| server.client.connected | 1. client num, 2. client name | Emitted when a client has fully connected and joined the server. |
| server.client.disconnected | 1. client num, 2. client name | Emitted when a client has disconnected from the server. |

### WAD files

| Event | Arguments | Description |
| - | - | - |
| wad.palette.loaded | | When a palette has been loaded. |

### Map dynamics

| Event | Arguments | Description |
| - | - | - |
| areaportals.changed | | Whenever a portal has changed. |
