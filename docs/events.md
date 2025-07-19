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

### Console

| Event | Arguments | Description |
| - | - | - |
| console.print-line | 1. line | When a full line has been written to the console. |

### Cvars

| Event | Arguments | Description |
| - | - | - |
| cvar.changed | 1. Cvar name | When a Cvar has been changed. |

### Frontend

| Event | Arguments | Description |
| - | - | - |
| gl.ready | 1. gl | WebGL rendering context is available now. |
| gl.shutdown |  | WebGL rendering context is no longer available now. |
| vid.resize | 1. width, 2. height, 3. pixelRatio | Dimensions of the rendering canvas have changed. |

### Host

| Event | Arguments | Description |
| - | - | - |
| host.crash | 1. Error | Emitted when there was an uncaught exception during the main loop. |

### Server

| Event | Arguments | Description |
| - | - | - |
| server.spawning | 1. map name | Emitted when spawning a server. |
| server.spawned | 1. map name | Emitted when spawning a server succeeded. |

### WAD files

| Event | Arguments | Description |
| - | - | - |
| wad.palette.loaded | | When a palette has been loaded. |
