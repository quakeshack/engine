# Keep generated files from shadowing shipped content in the browser's user store

**Status:** Implemented, both phases in one pass (2026-10-23). See "What actually shipped" at the end;
it deviates from the design below in four places.

## Context

In the browser, every file the engine writes goes into one IndexedDB object store
(`IndexedDbBackend`, database `quakeshack`, store `files`, schema version 1), keyed
`<game directory>/<file name>`. The store has no notion of version or age; an entry lives until the
user clears site data. `COM.LoadFile` asks this store **before** the content
(`Com.ts`, `LoadFile`: "Files the engine wrote ... come first"), so an entry there overrides the
shipped file of the same path forever.

What lands in the store today (engine and both games checked; the games write nothing directly):

| Key | Writer | Kind |
| :--- | :--- | :--- |
| `<game>/config.cfg` | `Host.WriteConfiguration` | user data |
| `<game>/s<N>.json`, `<game>/<name>.json` | `ClientHost.Savegame_f`, read by `SaveSlots` | user data |
| `<game>/<name>.dem` | `ClientDemos` | user data |
| `<game>/maps/<map>.nav` | `Navigation.save` (listen server, in the server worker) | **generated, derived from content** |
| `meta/localstorage-migrated` | `BackendUserStore.migrateFromLocalStorage` | bookkeeping |

The `.nav` meshes are the only derived data, and they are also shipped as content
(`data/id1/maps/*.nav`, `data/hellwave/maps/*.nav`). That causes the bug we saw: a client that
once generated a mesh keeps it, and a newer shipped mesh never reaches it. Content itself is fine,
because the Cache Storage caches are named after the engine and game version and pruned by
`COM.SetGameVersion()` (`docs/asset-layer.md`).

The only thing that rejects a stored mesh is the header check in `Navigation.load`: magic,
`NAV_FILE_VERSION` (3), map name, BSP checksum, `requiredHeight`/`requiredRadius`. A change to the
generator that leaves all of those alone (new link rules, different costs, the traversal drop limit)
passes the check. When the check does fail, `NavigationWorker` only prints a warning: the
`nav.build` publish is commented out and the stale entry stays in the store.

The dedicated server writes `.nav` to `data/<game>/maps/` on disk (`server/Com.ts`). It overwrites
the shipped file in place and is not affected by the precedence problem, only by the weak header
check.

## Goals

- A shipped `.nav` that is newer than a client's generated one wins, without anyone clearing site
  data.
- A change to the mesh generator invalidates every generated mesh, in the browser and on disk.
- A mesh that fails validation is thrown away and rebuilt, not just warned about.
- Clients that already have stale meshes stored get them removed once.
- Saves, `config.cfg` and demos keep surviving deploys exactly as today.

## Non-goals (this pass)

- Content-hash addressing of the asset cache (already listed as future work in
  `docs/asset-layer.md`).
- Changing how or when meshes are built (the generator itself, building in a worker).
- A general "user file versioning" scheme for saves (save compatibility is its own topic).

## Design

### A. A separate store for generated files

Generated files get their own IndexedDB object store, `generated`, next to `files`
(`IndexedDbBackend.open` moves to schema version 2; `onupgradeneeded` creates whichever store is
missing). Keys carry the version they were made by:
`<engine version>/<game directory>/<game version>/<file name>`, the same parts as
`AssetCaches.name`. `COM.SetGameVersion()` deletes every key in `generated` whose prefix is not the
running one, next to the Cache Storage pruning it already does.

`UserStore` stays the API for user data. Generated files get a small sibling interface
(`GeneratedStore`: `read`, `write`, `prune(keepPrefix)`), backed by the same `KeyValueBackend` idea
plus a key listing, with `MemoryBackend` as the fallback and in tests.

### B. Lookup order

`COM.LoadFile` becomes: user store → content → generated store. A shipped mesh therefore always wins
over a generated one, and a generated mesh is only used for maps that ship none. Only the browser
`COM` has the generated store; the dedicated server keeps writing to disk.

### C. Which writes are "generated"

`COM` gets `WriteGeneratedFile(filename, data)`; `NavigationServices.files` names that method
instead of `WriteFile`, so `Navigation.save` cannot write into the user store by accident. On the
dedicated server `WriteGeneratedFile` is `WriteFile` (disk).

### D. A generator revision in the `.nav` header

`NAV_FILE_VERSION` keeps meaning "binary layout". A new `NAV_GENERATOR_REVISION` is written after
the checksum and compared on load; it is bumped whenever the generator's output changes. Header
layout changes, so `NAV_FILE_VERSION` goes to 4 once, and the shipped meshes are rebuilt with
`nav_build_process 1` in the same change.

### E. Self-healing on a failed load

On `NavMeshOutOfDateException` the worker publishes `nav.build` again (uncomment and verify the
round trip; `nav.build` is `PAGE_ONLY` today, which needs checking against where the worker runs).
`Navigation.build` saves through `WriteGeneratedFile`, which replaces the stale entry. `docs/events.md`
loses the "nothing publishes it" note.

### F. One-time cleanup of old entries

On the first start with schema version 2, `onupgradeneeded` deletes every `files` key matching
`*/maps/*.nav`. Every one of them is generated and unversioned, so none can be trusted. The upgrade
runs once per browser profile, in whichever realm opens the database first.

## Phasing

1. **Header and self-healing (D, E).** Generator revision, `NAV_FILE_VERSION` 4, the rebuild on a
   failed load, rebuilt shipped meshes. This alone fixes "generator changed but nothing rebuilt", in
   the browser too, because the stale entry fails the check and is replaced.
2. **Generated store and lookup order (A, B, C, F).** Schema version 2, `generated` store with
   versioned keys and pruning, `WriteGeneratedFile`, content before generated files, the cleanup
   of old `.nav` entries. Docs: `docs/asset-layer.md` gets a third column ("Generated files").

## Testing

- `test/common/user-store.test.ts` / a new `generated-store.test.ts`: versioned keys, prune keeps
  only the running prefix, the memory fallback.
- The one-time cleanup (F) removes `*/maps/*.nav` from `files` and leaves `config.cfg`, saves, demos
  and the migration marker untouched; a version change prunes `generated` and never touches `files`.
- `test/common/com-storage.test.ts`: lookup order (user store over content over generated), a
  shipped file shadows a generated one, `WriteGeneratedFile` never touches the user store.
- Navigation: a mesh with the wrong generator revision throws `NavMeshOutOfDateException`; the
  worker path publishes `nav.build`.
- Real browser (`docs/browser-verification.md`): an old profile with a stale `.nav` in `files` is
  cleaned on upgrade; a listen server builds, stores and reloads a mesh; a second tab during the
  upgrade (`onblocked`) still falls back cleanly.

## Decisions

1. **Both phases**, in one pass (the developer asked for the whole plan).
2. **Generated files are version-keyed**: every deploy drops them, the same trade-off the asset cache
   makes.
3. **Lookup order**: generated files come *before* content, not after as first recommended (see below).
4. **User files are never pruned.** `config.cfg`, saves and demos survive every version change; only
   the generated files are pruned.

## What actually shipped

Phases 1 and 2 together. Deviations from the design, and why:

- **Separate database instead of a second object store (A, F).** Adding a store to `quakeshack` needs
  a schema upgrade. Tabs that still run the old build do not close their connection on
  `versionchange`, which blocks the upgrade, so the new tab would fall back to memory and lose that
  session's config and saves. Generated files therefore live in their own database,
  `quakeshack-generated` (`IndexedDbBackend.GENERATED_FILES`). Both databases now close themselves on
  `versionchange`, so a future upgrade is not blocked. The one-time cleanup is
  `BackendUserStore.removeLegacyNavigationMeshes()` with a marker, the same pattern as the
  `localStorage` migration, run by every realm in `COM.InitStorage()` before its first read. It is not
  an `onupgradeneeded` step.
- **Generated files before content (B).** This was the "after content" recommendation. Because the store
  is version-keyed, a generated file exists only when this exact build found the content file
  missing or out of date. With content first, the worker would load the stale shipped mesh again after
  every rebuild and request the next one. Order: user files → generated files → content.
- **No separate generator revision in the header (D).** `NAV_FILE_VERSION` now covers the layout *and*
  the generator output (JSDoc on the constant), and a version mismatch throws
  `NavMeshOutOfDateException` instead of `CorruptedResourceError`. So a mismatch rebuilds rather than
  leaving the map without navigation. A new header field would have changed the layout and invalidated
  the `test_e1m1.nav` fixture and every shipped mesh for no gain. The version stays at 3.
- **Namespace = asset cache name.** Generated keys are `<COM.GetAssetCacheName()>/<file>`, pruned in
  `COM.SetGameVersion()` next to the caches. The navigation worker used to boot without a build config
  or game version, so it named a different cache. `worker.framework.init` now carries both
  (`WorkerFrameworkInitPayload`), and the worker sets `gameVersion` directly without pruning.

Also shipped:

- `NavigationWorker` publishes `nav.build` on `NavMeshOutOfDateException`.
- `Navigation.rebuildOutdated()` rebuilds at most once per map, so a mesh that can't be stored does not
  loop.
- `Navigation.save()` writes through `WriteGeneratedFile` and fails, without publishing `nav.load`,
  when the write is refused.
- `NavigationServices.files` and `ServerDependencies.files` name `WriteGeneratedFile` instead of
  `WriteFile`.
- `NodeCOM.WriteGeneratedFile` writes next to the content on disk.

Docs: `docs/asset-layer.md` (three kinds of files, the generated store, the old-mesh cleanup),
`docs/events.md` (`nav.build`, `worker.framework.init`), `docs/README.md`.

Found along the way: every shipped id1 mesh in `data/id1/maps/` has header version 2, so the old code
rejected all of them as corrupt and those maps had no navigation. `hw_aitest.nav` is version 4. With
this change they are rebuilt at map load: on the dedicated server, in place on disk. They should be
rebuilt once with `nav_build_process 1` and committed, so players don't pay the build on every deploy.
