# Files: Content, User Files, Generated Files and Caches

Where the engine gets its files from and where it keeps what it writes. This is the layer under
`COM.LoadFile`, `COM.LoadTextFile`, `COM.WriteFile`, `COM.WriteTextFile` and `COM.WriteGeneratedFile`. It
exists in the browser; the dedicated server reads and writes the file system directly (`server/Com.ts`)
and does not use it.

## Three kinds of files

| | Content | User files | Generated files |
| :--- | :--- | :--- | :--- |
| What | Maps, models, textures, sounds, `.cfg` files that ship with the game | Saves, `config.cfg`, demos | Files the engine derives from content: `.nav` meshes |
| Read through | `AssetSource` (`common/AssetSource.ts`) | `UserStore` (`common/UserStore.ts`) | `GeneratedFileStore` (`common/GeneratedFileStore.ts`) |
| Browser storage | Cache Storage, downloaded through `fetch` | IndexedDB `quakeshack` (`common/IndexedDbBackend.ts`) | IndexedDB `quakeshack-generated` |
| Written by the engine | Never | `COM.WriteFile`, `COM.WriteTextFile` | `COM.WriteGeneratedFile` |
| Kept | For the running build and game version | Forever | For the running build and game version |

All are addressed by the same path, `<game directory>/<file name>`, lower case. `COM.LoadFile` asks the
user store first, then the generated files of the running build and game version, then the asset source.
A user file overrides everything of the same name. A generated file overrides content, because one only
exists when the content file was missing or out of date for this very build.

All storages exist inside workers as well (the old `localStorage` did not), so a server running in a
worker can read content and write saves like the main thread. A worker is told the build and game version
of the realm that spawned it (`worker.framework.init`), so it names the same asset cache and finds the same
generated files.

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

A user store sits on a small key-value backend (`get`, `put`, `delete`, `keys`). `IndexedDbBackend` is the
real one (database `quakeshack`, object store `files`, a write settles when its transaction completes).
`MemoryBackend` is used by tests and as the fallback when IndexedDB is unavailable or blocked: the game
runs, but files are not kept after a reload, and the console says so.

The store never throws: a failing database makes `write` return `false` and `read` return `null`.

Nothing in it is ever deleted by a deploy or a version change. Only what the player owns belongs here;
whatever the engine can rebuild from content is a generated file.

### Migration from `localStorage`

Older versions kept user files in `localStorage` under `Quake.<game directory>/<file name>`, which has
a small quota and does not exist in workers. On the main thread, `COM.InitStorage()` moves them over
once (`BackendUserStore.migrateFromLocalStorage`): each file is removed from `localStorage` only after it
was stored, and a marker is written last, so an interrupted run finishes on the next start. Other
`localStorage` keys are left alone.

### Navigation meshes of older versions

Older versions wrote `.nav` meshes into the user store, without a version, where they overrode the meshes
that ship with the game for good. `COM.InitStorage()` removes every key of the form
`<game directory>/maps/<map>.nav` once, in every realm before its first read
(`BackendUserStore.removeLegacyNavigationMeshes`, marker `meta/navigation-meshes-removed`). Everything
else is left alone.

## Generated files: `GeneratedFileStore`

The engine writes a file it derived from content with `COM.WriteGeneratedFile`. Today that is a
navigation mesh the server rebuilt because the map ships none, or ships one that is out of date
(`Navigation.rebuildOutdated`, see `nav.build` in [events.md](events.md)).

- **Its own database**, `quakeshack-generated`, so adding it needed no schema upgrade of the user files.
  Pages of an older build that are still open would have blocked that upgrade.
- **Namespaced like the asset cache.** Keys are `<asset cache name>/<file name>`, so a file belongs to one
  engine build, game directory and game version. Once the game version is known, `COM.SetGameVersion()`
  deletes the files of every other namespace, next to the asset caches. A new deploy therefore rebuilds a
  mesh rather than reading one an older generator made.
- **Never throws**, like the user store; `MemoryBackend` is the fallback, and then a mesh is rebuilt after
  every reload.

The dedicated server has no such store: `COM.WriteGeneratedFile` writes next to the content on disk and
replaces the outdated file there.

## Writes are asynchronous

`COM.WriteFile`, `COM.WriteTextFile` and `COM.WriteGeneratedFile` return a promise (the first two used to
write `localStorage` synchronously). Callers `await` them: `Host.WriteConfiguration`, `ClientHost.Savegame_f`,
`ClientDemos`, `Navigation`. A write started while the page is being closed (the configuration is written once more at
shutdown) may not finish; archived cvar changes are written five seconds after they happen, so only the
last moments are at risk.

`SaveSlots` (`ClientEngineAPI.SaveSlots`, used by game menus while they draw) stays synchronous: it
answers from a snapshot of the slots' metadata that `SaveSlots.refresh()` takes at startup and after every
`save`. A save written by something else is not seen until the next refresh.

## Testing

`test/common/asset-source.test.ts`, `user-store.test.ts`, `generated-file-store.test.ts` and
`com-storage.test.ts` run the logic against fakes for `fetch`, Cache Storage, Web Locks and the key-value
backend. The real browser parts (`IndexedDbBackend`, real Cache Storage and locks, the migration and the
removal of old meshes) need a browser: see
[browser-verification.md](browser-verification.md).
