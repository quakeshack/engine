# Files: Content, User Files and Caches

Where the engine gets its files from and where it keeps what it writes. This is the layer under
`COM.LoadFile`, `COM.LoadTextFile`, `COM.WriteFile` and `COM.WriteTextFile`. It exists in the browser;
the dedicated server reads and writes the file system directly (`server/Com.ts`) and does not use it.

## Two kinds of files

| | Content | User files |
| :--- | :--- | :--- |
| What | Maps, models, textures, sounds, `.cfg` files that ship with the game | Saves, `config.cfg`, demos, generated `.nav` meshes |
| Read through | `AssetSource` (`common/AssetSource.ts`) | `UserStore` (`common/UserStore.ts`) |
| Browser storage | Cache Storage, downloaded through `fetch` | IndexedDB (`common/IndexedDbBackend.ts`) |
| Written by the engine | Never | Yes |

Both are addressed by the same path, `<game directory>/<file name>`, lower case. `COM.LoadFile` asks the
user store first, so a file the engine wrote overrides content of the same name, then the asset source.

Both storages exist inside workers as well (the old `localStorage` did not), so a server running in a
worker can read content and write saves like the main thread.

## Content: `CachedFetchAssetSource`

- **Cache Storage** belongs to the origin, so every realm (the main thread and each worker) sees the
  same files. What one realm downloaded is a local read for the other, independent of HTTP cache
  headers, and it survives a reload. Downloads are keyed by URL.
- **Web Locks** guard each file (`asset:<url>`). The client and the server precache nearly the same
  files at the same moment, so without the lock both would miss and download. The second reader waits,
  then finds the file in the cache. Where Web Locks do not exist the only cost is a duplicate download.
- **Failures never fail a load.** Unavailable Cache Storage means every read downloads; a full quota
  means the file is returned but not kept; a missing file is `null` and is not cached.
- **Development builds revalidate.** With `buildConfig.mode === 'development'` a cached file is checked
  with a conditional request (`If-None-Match`/`If-Modified-Since`) first, so a map you changed on disk is
  picked up without clearing site data; an unchanged file costs one `304`. Production never asks.

### Cache names and cleanup

A cache is named `quakeshack/<engine version>/<game directory>/<game version>` (`AssetCaches.name`):

- *Engine version* is `<productVersion>+<commit>`, and `<productVersion>@<build time>` for a build without
  a commit, so a local rebuild never serves old files.
- *Game version* is `identification.version` of the game module, set by `GameModule.Init` through
  `COM.SetGameVersion()`. Files that are needed before the game module loads (the palette, `pop.lmp`) are
  cached under `boot` instead, which follows the engine version only.
- Once the game version is known, `COM.SetGameVersion()` deletes every cache that starts with `quakeshack/`
  and is neither the running version nor its `boot` cache. Caches of other applications are never touched.

Keying on the engine version means every deploy downloads everything again. That is accepted for now
because it is simple and safe; addressing files by content hash would remove the cost (future work).

## User files: `BackendUserStore`

A user store sits on a small key-value backend (`get`, `put`, `delete`). `IndexedDbBackend` is the real
one (database `quakeshack`, object store `files`, a write settles when its transaction completes).
`MemoryBackend` is used by tests and as the fallback when IndexedDB is unavailable or blocked: the game
runs, but files are not kept after a reload, and the console says so.

The store never throws: a failing database makes `write` return `false` and `read` return `null`.

### Migration from `localStorage`

Older versions kept user files in `localStorage` under `Quake.<game directory>/<file name>`, which has
a small quota and does not exist in workers. On the main thread, `COM.InitStorage()` moves them over
once (`BackendUserStore.migrateFromLocalStorage`): each file is removed from `localStorage` only after it
was stored, and a marker is written last, so an interrupted run finishes on the next start. Other
`localStorage` keys are left alone.

## Writes are asynchronous

`COM.WriteFile` and `COM.WriteTextFile` return a promise (they used to write `localStorage`
synchronously). Callers `await` them: `Host.WriteConfiguration`, `ClientHost.Savegame_f`, `ClientDemos`,
`Navigation`. A write started while the page is being closed (the configuration is written once more at
shutdown) may not finish; archived cvar changes are written five seconds after they happen, so only the
last moments are at risk.

`SaveSlots` (`ClientEngineAPI.SaveSlots`, used by game menus while they draw) stays synchronous: it
answers from a snapshot of the slots' metadata that `SaveSlots.refresh()` takes at startup and after every
`save`. A save written by something else is not seen until the next refresh.

## Testing

`test/common/asset-source.test.mjs`, `user-store.test.mjs` and `com-storage.test.mjs` run the logic
against fakes for `fetch`, Cache Storage, Web Locks and the key-value backend. The real browser parts
(`IndexedDbBackend`, real Cache Storage and locks, the migration) need a browser: see
[browser-verification.md](browser-verification.md).
