# Engine changes for the editor: W, COM, GL, the qsmat parser and the model loaders usable from a second app

## Status

🚧 In progress on `feature/editor-engine-reuse` (branched from `main`). Phase 0 (groundwork) and E2
(the search path, the first part of Phase 1) have shipped, see "What actually shipped". E3 and E6
complete Phase 1.

### Decisions made with the developer (2026-10-24)

1. **One Quake search order**: `NodeCOM` moves onto the shared code too ("clean up the COM situation
   first, the engine will only benefit"). E2 comes first.
2. **`GameFolder` hands out `Blob`s**, so a pak is read in ranges.
3. **Engine work goes on its own branch from `main`**, `feature/editor-engine-reuse`. The sprites
   branch is a separate topic.

## Context

The QuakeShack editor is a separate repo that uses engine code instead of reimplementing it
(editor decision 2: "reuse engine code as much as possible, and change the engine where that makes
reuse easier"). It sees the engine as `vendor/engine` (a symlink to this checkout for now, a git
submodule later) and imports it only through `src/engine.ts`, whose import closure a test holds to
an allowlist.

### The spike

Phase 0 measured each candidate two ways:

- **What it loads**: the import closure from an esbuild metafile (a real bundle, so type-only
  imports are erased as they are in the build).
- **Whether it evaluates**: `node --import tsx -e "await import('<file>')"`. Every candidate below
  evaluates in Node without errors, so no module touches `window`, `document` or a GL context at
  import time. The coupling that is there shows at run time, listed in the last column.

| Candidate | Files | Bundle | Pulls in | Run-time coupling |
|---|---|---|---|---|
| `shared/Vector.ts` | 1 | 19 KiB | nothing | none |
| `client/renderer/models/Materials.ts` | 1 | 5 KiB | nothing | none (`MaterialFlags`, `PBRMaterial`, `QuakeMaterial`) |
| `common/model/ModelLoaderRegistry.ts` | 3 | 2 KiB | `Errors`, `ModelLoader`, `ModelLoadContext` | none |
| `common/W.ts` | 7 | 47 KiB | `EventBus`, `Errors`, `Q`, `Vector`, `Defs`, `EngineEvents` | reads through the `W.files` hook; the palette is static state (`W.d_8to24table_u8`), and `Wad2File` takes it in its constructor, so the palette must be loaded before a WAD is opened |
| `common/model/WalTextureLoader.ts` | 8 | 48 KiB | `W` closure | palette from `W` |
| `common/Com.ts` | 16 | 96 KiB | `W`, `Cmd`, `Cvar`, `Console`, `Def`, `CRC`, `AssetSource`, `UserStore`, `IndexedDbBackend` | see "COM" below |
| `client/GL.ts` | 20 | 134 KiB | `COM` closure + `PageServices` + `VID` | see "GL" below |
| `common/model/QSMatLoader.ts` | 22 | 137 KiB | `GL` closure + `Materials` | see "qsmat" below |
| `common/model/loaders/WavefrontOBJLoader.ts` | 25 | 148 KiB | `GL` closure + `MeshModel` | images through `GLTexture.FromImageFile` (page `com`) |
| `common/model/loaders/SpriteSPRLoader.ts` | 27 | 160 KiB | `GL` closure + sprite classes | palette from `W` |
| `common/model/loaders/ImageSpriteLoader.ts` | 35 | 194 KiB | `GL` closure + sprite parsers | `context.spriteImages` decodes pixels |
| `common/model/loaders/AliasMDLLoader.ts` | **58** | **440 KiB** | **`Mod`, `Host`, every loader, `BSP`, collision** | palette from `W` |

**Conclusion of the spike:** the common core (`Cmd` → `COM` → `W`, `Cvar`, `Console`) loads as one
unit. It is 16 files, it evaluates anywhere, and splitting it is not worth it. `GL` adds only
`PageServices` and `VID` to it. Nothing reaches `CL`, `R`, the server or the network layer. The
editor can take `GL`, `W`, `COM`, the materials and every loader except the MDL loader as they are
*loaded*; what needs changing is how they are *run*.

### COM

- **The browser `COM` has no `.pak` reading and no search path layering.** `#readFile` reads
  `<topmost game directory>/<file>` from `COM.assetSource`, nothing else. The layering exists only in
  `NodeCOM` (`server/Com.ts`), written against `fs` with a fixed `data/` prefix, and the browser gets
  its files already merged from `/qfs/` (served by `NodeCOM`, `server/Sys.ts`) or from the CDN.
- **`COM` itself runs on any `AssetSource`.** The editor can construct it with `ComDependencies`
  (`con`, `sys`, and two getters that return `undefined`), push one search path for the game, and
  assign `com.assetSource` without calling `InitStorage()`: `#storageReady` is already settled and a
  `null` user store is skipped. Installing it with `installPageServices({ com })` makes
  `GLTexture.FromImageFile` read through it too. That is the documented hook for a composition root,
  and the editor is one.
- **One trap:** after a successful read `#readFile` prints `GetNetpath(...)`, which reads
  `location` when no CDN pattern is set. That throws in Node, so a test of `COM` on an in-memory
  source fails on the log line.
- **Precedence, from `NodeCOM` and id's `COM_AddGameDirectory`:** later game directories win over
  earlier ones (mod over base game), and *within* one game directory the paks win over loose files,
  the highest-numbered pak first. The editor plan's "loose files over paks" is wrong and is
  corrected there.

### GL

- `GL.Init()` takes its canvas from `VID.mainwindow` (one caller, `ClientHost.ts:197`) with fixed
  context attributes (`alpha: false`, `preserveDrawingBuffer: true`).
- It registers `gl_picmip`, `gl_clear`, `gl_texturemode` and `gl_texturelist`. `Cvar` and `Cmd` work
  without a host, so this is harmless in the editor.
- `GL.Set2D()` sizes the viewport from `VID` (one caller, `ScreenFrame.ts:160`), and a `vid.resize`
  subscription keeps its ortho matrix. The editor never calls `Set2D`; it sets a viewport per pane
  itself. Nothing to change.
- **Shaders need no change.** `ShaderLibrary`'s constructor takes the program and chunk sources as
  maps, so the editor builds `new ShaderLibrary(editorPrograms, { ...engineChunks, ...editorChunks })`
  and installs it as `GL.shaderLibrary`. The "second include directory" the editor plan expected as
  part of E1 is not needed.

### qsmat

`QSMatLoader.load` parses each `.qsmat.json`, matches its entries against `loadmodel.textures`,
loads the images with `GLTexture.FromImageFile` and replaces the matched textures with
`PBRMaterial`s, all in one loop. `MaterialDefinition` and `MaterialFile` are not exported, and the
flags are resolved only while applying.

### WAD2 texture WADs (not in the editor plan's table)

`Wad2File.getLumpMipmap` decodes only `qpic` lumps (`gfx.wad`). A Quake texture WAD holds `miptex`
lumps (type `0x44`), and nothing in `W.ts` decodes them for WAD2: `BSP29Loader` decodes the miptex of
a BSP's texture lump inline, and `readWad3Texture` handles WAD3's variant with its own palette. The
editor's texture browser needs exactly this. It is E6 below.

### Model loaders

`ModelLoadContext` is already injected (`files`, `con`, `loadRenderData`, `spriteImages`); the client's
sprite image decoder is `client/renderer/sprite/SpriteImageDecoding.ts`. The only structural problem
is the MDL loader's closure: it imports the `ModelType` enum from `Mod.ts`, and `Mod.ts` imports every
loader, `Host` and the collision code.

## Goals

- E1: `GL` initializes on a canvas the caller hands it.
- E2: The Quake search order (game directories, paks over loose files) exists once, in `common/`,
  on top of a byte source, and a `COM` on an in-memory source works in Node.
- E3: qsmat files parse into exported definitions without a `BrushModel` or GL.
- E4: The MDL loader no longer loads `Mod`, `Host`, the other loaders or the collision code.
- E6: `W` decodes WAD2 miptex lumps, with one miptex decoder shared with `BSP29Loader`.

## Non-goals (this pass)

- Splitting the common core (`Cmd`/`COM`/`Cvar`/`Console`) apart. The spike shows it is small and
  evaluates anywhere.
- E5 (decoded pixels without a GL upload). The editor decides it in its Phase 7 (editor decision 14).
- Moving `GLTexture.FromImageFile` off the page `com` onto `ModelLoadContext.files`. It would be
  cleaner, but `installPageServices({ com })` already serves the editor.
- Anything the browser client or the dedicated server would notice, apart from the `COM.LoadFile` log
  line (E2).

## Design

### A. E1: `GL.Init(canvas, attributes?)`

- `static Init(canvas: HTMLCanvasElement, attributes: WebGLContextAttributes = GL.defaultContextAttributes): void`.
  `ClientHost` passes `VID.mainwindow`; the editor passes its own canvas and attributes (it wants
  `antialias: true` and no `preserveDrawingBuffer`).
- `GL.ts` keeps importing `VID` for `Set2D` and the ortho matrix. Both are engine-only paths and
  harmless in the editor's closure.
- Test: `GL.Init` with a fake canvas whose `getContext` records the attributes (the fake context
  helpers in `test/support/glEvents.ts` are the starting point).

### B. E2: `PakFile` and `SearchPathAssetSource` in `common/`

- **`common/PakFile.ts`**: the PACK format, no I/O. `PakFile.parseHeader(view)` (magic, directory
  offset and length) and `PakFile.parseDirectory(bytes)` (→ `PackFileEntry[]`, names lower case).
  `NodeCOM.LoadPackFile` uses it, so the format lives once. The shareware checks (`numpackfiles !==
  339`, the directory CRC) stay in `NodeCOM`, which owns `modified`.
- **`common/SearchPathAssetSource.ts`** `implements AssetSource`: game directories in order, each
  with its paks (opened lazily, `pak0.pak`, `pak1.pak`, ... until one is missing) and loose files, read
  in the precedence above. It reads through a small interface that a backend implements:

  ```typescript
  /** Raw files of a game folder: a directory picked in the browser, a folder on disk, a map in a test. */
  export interface GameFolder {
    /** @returns the file as a blob (ranged reads through `slice`), `null` when it does not exist */
    open(path: string): Promise<Blob | null>;
  }
  ```

  A `Blob` gives ranged reads for free: a `File` from the File System Access API is one, Node 24 has
  `fs.openAsBlob`, and a test wraps bytes in `new Blob([...])`. A 30 MB pak is never read whole, only
  its directory and the entries asked for. `list(directory)` (texture and model browsers) is added
  when the editor's Phase 2 needs it, with the same precedence.
- **`COM.#readFile`** logs the virtual path (`COM.LoadFile: id1/maps/e1m1.bsp`) instead of
  `GetNetpath(...)`. The URL was only informational, and `GetNetpath` reads `location`, which does not
  exist in Node.
- `NodeCOM.LoadFile` moves onto `SearchPathAssetSource` as well (decision 1).

### C. E3: `QSMatParser`

- **`common/model/QSMatParser.ts`**, no GL import: exports `MaterialDefinition` and
  `MaterialFileDefinition`, and `QSMatParser.parse(text, filename)`, which validates `version`, keeps
  the entry order, resolves `flags` to a `MaterialFlags` bitmask and returns the names it does not
  know (today `console.assert`).
- `QSMatLoader.load` becomes: read the files, `QSMatParser.parse`, then apply to the `BrushModel` as
  today. Behavior stays the same, and the existing qsmat tests keep passing.
- `docs/qsmat-format.md` names the parser as the one place that defines what a file means.

### D. E4: `ModelType` out of `Mod.ts`

- Move the enum to `common/model/ModelType.ts`. `Mod.ts` re-exports it, so no other importer has to
  change. `AliasMDLLoader` imports it from the new file. Its closure drops from 58 files to the `GL`
  closure plus its own (about 25).
- `engine-boundaries.test.ts` gets a closure check for the loaders, so `Mod.ts` cannot come back
  unnoticed.
- The editor builds its own `ModelLoadContext` (`files: com`, its console, `loadRenderData: true`,
  the client's `SpriteImageDecoding`). Whether `SpriteImageDecoding` needs anything beyond
  `createImageBitmap` is checked when the editor reaches Phase 7.

### E. E6: WAD2 miptex lumps

- `export function readMiptex(data: ArrayBuffer, offset: number, palette: Uint8Array, name: string, mipmapLevel = 0): WadLumpTexture`
  in `W.ts`, with the transparency rule (`{` → index 255) and the fullbright handling `BSP29Loader`
  uses today.
- `Wad2File.getLumpMipmap` switches on the lump type like `Wad3File` does: `0x44` miptex → `readMiptex`,
  `0x42` qpic and the `CONCHARS` special case as today.
- `BSP29Loader` calls `readMiptex` for the 8-bit path instead of its inline decode (the GL upload and
  the luminance texture stay in the loader).

## Phasing

Each phase is an ordinary engine change: typecheck, lint, tests green, docs with the phase. Each one
ships before the editor phase that needs it.

- **Phase 0 (shipped with editor Phase 0):** groundwork, see below.
- **Phase 1, assets (before editor Phase 2):** E2, E3, E6.
- **Phase 2, GL (before editor Phase 3):** E1.
- **Phase 3, models (before editor Phase 7):** E4; E5 decided there.

## Documentation

| Doc | Change | Phase |
|---|---|---|
| `docs/asset-layer.md` | `SearchPathAssetSource`, `GameFolder`, the precedence rule, `PakFile` | 1 |
| `docs/qsmat-format.md` | `QSMatParser` as the definition of a file's meaning | 1 |
| JSDoc on `W.ts` | `readMiptex`, the lump types `Wad2File` decodes | 1 |
| JSDoc on `GL.Init` | canvas and attributes parameters | 2 |
| `docs/shader-chunks.md` | one paragraph: a second app installs its own `ShaderLibrary` with merged chunk maps | 2 |
| `README.md` | nothing until the editor is hosted (editor Phase 5) | — |

## Testing

- Phase 1: `test/common/pak-file.test.ts` (header, directory, a bad magic), `test/common/search-path-asset-source.test.ts`
  (mod over base, pak over loose, `pak1` over `pak0`, a missing file, lazy pak opening), `COM` on a
  `SearchPathAssetSource` in Node, `QSMatParser` (flags, unknown flags, version), WAD2 miptex decoding
  from an in-memory WAD, and the existing BSP29 tests unchanged.
- Phase 2: `GL.Init` with a fake canvas; the browser pass of the client (`browser-ui-verification`) to
  show the game still starts.
- Phase 3: the loader closure check in `engine-boundaries.test.ts`.

## Open questions

None at the moment; the three from Phase 0 are answered (decisions above).

## What actually shipped in Phase 0

- `test/support/importClosure.ts`: `readCode` and `importClosure` moved out of
  `test/common/engine-boundaries.test.ts`, so the editor's boundary test imports them instead of
  copying them. `importClosure` takes an optional alias map (`{ '@engine/': '<path>/source/' }`) for
  the editor's specifiers, and follows any `.ts` specifier it can resolve instead of relative ones
  only. Covered by `test/common/import-closure.test.ts`.
- `eslint.config.mjs` exports `commonRules` and `tsStrictRules`. The editor's config spreads them
  into its own entries with its own plugin instances, so the two repos lint by one rule set. No
  behavior change for the engine.
- This plan.

## What actually shipped in Phase 1 (E2)

- **`common/PakFile.ts`**: the PACK format on a `Blob` (`readDirectory`, `parseDirectory`,
  `readEntry`), with bounds checks the old code lacked (a directory or an entry past the end of the
  file is a `CorruptedResourceError`, it used to be a short read). `PackFileEntry` moved here from
  `Com.ts`.
- **`common/SearchPathAssetSource.ts`** with the `GameFolder` interface, and
  **`server/NodeGameFolder.ts`** (`fs.openAsBlob`) for `data/`.
- **`NodeCOM`** lost its `LoadFile` override and `LoadPackFile`. It installs the source as its
  `assetSource`, so the dedicated server, its workers and `/qfs/` read through the base
  `COM.LoadFile`, like the browser. `AddGameDirectory` keeps id's shareware check (`modified`) and the
  "Added packfile" line.
- **Deviations from Design B, and why:**
  - *The source reads `COM.searchpaths` through a getter instead of owning the paks.* The spike missed
    that `searchpaths`, pak directories included, is structured-cloned into workers
    (`WorkerManager`, `WorkerFramework`, the server worker's init), and a worker's `NodeCOM` reads with
    it. So the cloneable array stays the only state, and a pak is opened per read as before (only the
    entry is read). Pak directories get a name index on first use (a `WeakMap`), where the old code
    scanned the whole directory for every read.
  - *Paks are opened when the game directory is added, not lazily.* `NodeCOM` needs their directories
    then for the shareware check, and only the header and the directory are read.
  - *No `locate` and no `list` yet.* `list` comes when the editor's texture and model browsers need it.
- **Behavior changes:** the dedicated server now publishes `com.fs.being`/`com.fs.end` (page-only
  events; no listener outside the page, and the browser's server worker already did). Its console
  prints `COM.LoadFile: id1/maps/start.bsp` instead of `PackFile: data/id1/pak0.pak : maps/start.bsp`
  or `FindFile: id1/...`. The browser prints the virtual path instead of the download URL as well,
  which also removes the read of `location` that threw in Node. `NodeGameFolder` refuses paths that
  would leave `data/` (`..`, absolute); `/qfs/` used to hand request paths to `fs` as they came.
- **Also cleaned up:** `COM`'s class JSDoc sat on `ComDependencies` and is back on the class; the
  comments that said the dedicated server does not use `assetSource` and that paks are "pre-extracted
  at build time".
- **Verified:** a script recorded what `NodeCOM` served for all 1444 names of the real `data/id1`
  (`pak0`, `pak1`, loose files) plus `data/hellwave` before the change: the result after is
  identical, byte for byte, together with `modified` and the `searchpaths` handed to workers. The
  dedicated build (`npm run dedicated:build`) starts, loads `start` and serves `/qfs/` with the same
  bytes, 404 for a missing file and for `..` paths. Tests: `test/common/pak-file.test.ts`,
  `test/common/search-path-asset-source.test.ts`, `test/server/node-game-folder.test.ts`, a Node test
  in `com-storage.test.ts`; `test/support/gameFolder.ts` (`MemoryGameFolder`, `createPak`) is shared.
- **Docs:** `docs/asset-layer.md` (new section on the search path, intro and testing updated), its
  entry in `docs/README.md`.
