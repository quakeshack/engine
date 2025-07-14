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

### WAD files

| Event | Arguments | Description |
| - | - | - |
| wad.palette.loaded | | When a palette has been loaded. |
