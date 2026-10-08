# Engine architecture modernization: no registry, server in its own worker, explicit lifetimes

**Status:** Approved in outline 2026-10-03 (see "Decisions already made"). **Phase 0, Phase 1, Phase 2a (the
file layer), Phase 2b (the server runtime and the realm services it uses without the registry) and Phase 3
(the server in a worker, in three steps: 3a, 3b, 3c) are done (2026-10-05)**; the worker is the default in the
browser, `?serverthread` opts out. See "Phase 1: what shipped" to "Phase 3c: what shipped" below. Phase 4 (the
client side of the registry, deleting it) is done as well (2026-10-08): 4a, 4b and 4c, see "Phase 4a: what shipped" to "Phase 4c: what shipped"; `registry.ts` is gone. `client-entity-architecture` was squash-merged to `main` as `9abb71b` (all phases, including
the old phase 6), so the Phase 1 blocker is gone. The Phase 0 spikes were run on 2026-10-03; results
are in "Phase 0 findings" and have been folded into the design. Written 2026-10-03 after a code survey
(numbers in "Context" are as of that date, branch `client-entity-architecture`; the registry importer
count was 86 then and is 91 files after Phase 1 added four of its own). This is an umbrella plan: Tracks A and
B are designed in detail because they come first and everything else leans on them. Tracks C to G
are scoped here and each gets its own `plans/<topic>.md` when its turn comes.

## Context

QuakeShack's runtime layout is still the WinQuake one, ported file by file. The pieces that hurt
most:

**The registry is duct tape over mutual coupling.** [registry.ts](../source/engine/registry.ts)
says so itself: "the engine components are too tightly coupled, that's why we need a registry for
the time being." 86 source files import it. The prolog (`let { Con } = getCommonRegistry();` plus a
`registry.frozen` subscriber) appears with these frequencies: `Con` 41, `Host` 31, `CL` 27,
`COM` 23, `SV` 18, `R` 18, `NET` 13, `S` 10, `M` 9. Two launchers
([main-browser.ts](../source/engine/main-browser.ts),
[main-dedicated.ts](../source/engine/main-dedicated.ts)) fill a sealed object by hand, and
[WorkerFramework.ts](../source/engine/common/WorkerFramework.ts) builds a third, "lean" registry
(`WorkerConsole`, `WorkerSys`, a `WorkerCOM` that is still a TODO) to get a worker going. Every
module is a static facade class (`CL`, `SV`, `Host`, `R`, `NET`, `COM`, ...) whose state is
process-global. `isDedicatedServer` branches 61 times, 31 of them inside `Host`. 72 of 158 test
files install a mock registry.

**`Host` is two programs in one file.** [Host.ts](../source/engine/common/Host.ts) (2085 lines)
owns the client frame, the server frame, the classic console commands and the shutdown sequencing.
`Host._Frame` has a dedicated branch (`Cmd.Execute()`, `Host.ServerFrame()`) and a client branch
(read from server, `ClientFrame`, `SendCmd`, then `Host.ServerFrame()` in the same call stack, then
prediction, then draw). The client branch gates the simulation on the menu
(`!registry.isDedicatedServer && M.AllowsSimulation()` in `ServerFrame`). `Host.ServerFrame`
already carries `// TODO: move to SV.ServerFrame`, and `ShutdownServer` has `// TODO: SV duties`.
`Host` references `CL` 58 times and `SV` well over 100 times.

**The server only runs in-thread, but the seam is smaller than it looks.** The client already talks
to the server through the `LoopDriver` QSocket pair
([NetworkDrivers.ts:405](../source/engine/network/NetworkDrivers.ts#L405)), the same protocol a
remote player uses. Direct client-to-`SV` reads are rare: `R.ts` (5, particle/dlight collision via
`SV.collision.traceStaticWorldLine/pointContents`), `Chase.ts` (3), `MenuPage.ts` (1) and
`ClientConnection.ts` (1: `SV.svs.maxclients`, `SV.server.active`). The collision ones already go
through [CollisionModelSource](../source/engine/common/CollisionModelSource.ts), which falls back
to the client's own world model; `ModelScope` (`shared`/`client`/`server`) already gives the two
sides separate model caches; and the loaders already special-case `isDedicatedServer` (no GL data).
`Pmove` imports no registry at all. The game module contract
([game-module-contract.md](game-module-contract.md)) already hands the game an engine API *object*
(`ServerGameAPI.Init(ServerEngineAPI)`). So most of the groundwork exists; what is missing is
cutting the remaining cross-references and giving the server its own thread.

**A worker framework exists but is only used for navigation.**
[PlatformWorker.ts](../source/engine/common/PlatformWorker.ts),
[WorkerManager.ts](../source/engine/common/WorkerManager.ts) and `WorkerFactories.ts` already
abstract Node `worker_threads` and Web Workers behind one eventBus bridge, with the dedicated build
auto-bundling `*Worker.ts` files. The navigation worker does not load the map at all: it gets the map
name and checksum and reads its own `.nav` file, so it never needed shared loading (see B7).

### Decisions already made with the developer

1. **Get rid of the registry.** It exists only to paper over the inherited WinQuake layout.
2. **Run the server in a separate worker, including for single player.** The simulation leaves the
   render thread entirely.
3. **Network protocol and entity model are out of scope.** They exist to make mod authoring
   pleasant, and the developer is unsure whether to touch them much. This plan therefore only
   touches the network at the *transport* seam (a new local channel driver) and never changes
   `Protocol.ts`, `MSG.ts` or the message formats. See "Non-goals".
4. **Server management from the client keeps working transparently (decided 2026-10-03).** When
   the player hosts in the browser or plays single player, changing a server cvar on the console
   (`set sv_gravity 400`, `deathmatch 1`, a game-registered cvar) or running a server-side command
   (`god`, `give`, `kick`, `status`) works exactly as before, with no new syntax and no
   "send to server" prefix. The two realms keep their own `Cvar`/`Cmd` tables (see Design A1) and a sync layer makes that invisible. This is a requirement on Design B5, not an
   optional nicety.
5. **Worker is the default for single player and listen servers from Phase 3 on (decided
   2026-10-03).** No staged opt-in. A latency measurement is still run (Design B4) to quantify the
   cost and decide mitigations, but it informs tuning; it does not gate shipping.
6. **Ordering: the `client-entity-architecture` rework is finished first (decided 2026-10-03).**
   Phase 1 here starts only after its phase 6 has landed.
7. **A main-thread relay is acceptable for WebRTC** if `RTCPeerConnection` is unavailable inside
   workers (Design B2).
8. **Loaded files are shared between the client and the server (decided 2026-10-03).** There is
   always an overlap in what both sides load (the map, models, sounds' file bytes). Today that
   sharing is implicit and in-thread (the `shared` `ModelScope`, one `COM`). Once the server has its
   own thread the implicit sharing is gone, so it becomes an explicit part of the plan: Design B7
   and Track F, with the file layer delivered in Phase 2, before the worker.
9. **The shared cache is invalidated by engine and game version (decided 2026-10-03).** The cache
   namespace is built from the running engine and game, see Design B7. Content hashing stays a
   Track F follow-up.
10. **User files move from `localStorage` to IndexedDB (decided 2026-10-03).** `localStorage` limits
    have already been hit in practice, so this is also an improvement and not only a requirement of
    the worker. See Design B7 and Phase 2.
11. **Non-Chromium browser checks are run by the developer in Firefox (decided 2026-10-03)** with
    `scripts/worker-compat-check/` (see Phase 0 findings, finding 6).
12. **Supported browsers for this work are Firefox and Chrome/Chromium (decided 2026-10-03).**
    Safari is out of scope for now: nothing in this plan is designed, built or tested for it, and
    nothing is blocked on it. If that changes later, `scripts/worker-compat-check/` is the first thing
    to run there.
13. **The map-list helpers stay where they are until after Phase 4 (decided 2026-10-03).**
    `GetMapList()`/`GetStartServerList()` remain static helpers on `ServerGameAPI`, called from client
    game code; moving them is a separate, game-side change raised with the developer after Phase 4.
14. **Deterministic replay is in scope (decided 2026-10-03)**, as a tool for building repros of hard
    bugs. It gets its own plan after Phase 3 (Track G); Phase 1 and 3 carry the few design
    requirements that keep it cheap, listed in Track G.
15. **Agreed in principle:** typed/scoped events, explicit lifetimes for game modules, a renderer
   with composable shaders and a frame graph, a pure `Pmove`, an async asset pipeline, type-checked
   tests, built-in profiling/replay (Tracks C to G).

### Coordination with work in flight

`client-entity-architecture` (this branch, phase 6 outstanding) touches `ClientEntities.ts`,
`ClientState.ts`, `ClientLifecycle.ts`, `Host.ts` and savegame serialization
(`SerializedClientEntity`, `SerializedParticle`). Phase 1 of this plan edits the same `Host.ts`
regions, so per decision 6 that plan is finished and merged first. Only the read-only parts of
Phase 0 (dependency inventory, spikes, baseline measurements) may run before then, because they
edit no shared file. The ESLint ratchet touches `eslint.config.mjs`, which has uncommitted changes
on this branch, so it waits for the merge too.

## Goals

- No `registry.ts`, no `getCommonRegistry()`, no `registry.frozen` listeners, no `isDedicatedServer`
  flag branches. Dependencies are constructor-injected into instances created by a small number of
  composition roots.
- `Host` is split into a client runtime and a server runtime. The server runtime has no knowledge
  of `CL`, `R`, `S`, `M`, `SCR`, `IN`, `Key`, `Draw`.
- The server runs in a Worker in the browser for both single player and a hosted listen server,
  with the existing protocol over a `MessagePort`. In Node the same server runtime runs on the main
  thread (dedicated) and, for tests, in-thread over the existing `LoopDriver`.
- Game modules get explicit lifetime scopes and instance engine APIs with the same member surface
  they have today.
- Files both sides need are loaded and cached once per browser, not once per realm, through one
  shared file layer (Design B7), and user-written files (saves, config) are visible to both realms.
- Every phase leaves `npm test`, `npm run typecheck` and `npx eslint` green and the game playable.

## Non-goals (this pass)

- Rewriting the network protocol, schema-generating serializers, or delta compression (developer
  decision 3). The wire format stays byte-compatible so remote play, demos and savegame-embedded
  client state keep working.
- Making entities data-oriented / typed-array components. `client-entity-architecture` continues
  independently. This plan only requires that the entity code stops reaching into `SV`/`registry`.
- Safari support (decision 12). Features are verified in Firefox and Chrome only; Safari-specific
  fallbacks are not built.
- A from-scratch rewrite. Every phase is a refactor of the running engine.
- Multi-threading the client (renderer in an OffscreenCanvas worker). Possible later; not planned.
- SharedArrayBuffer between client and server (needs cross-origin isolation headers on the hosting
  setup and would constrain embedding). Message passing only.
- Changing the game's entity/gameplay code (`source/game/*`), except where a contract change forces
  it (flagged where it happens).

## Design

### A. Instances and composition roots instead of the registry (Track A)

**A1. Layers.** Three levels, each constructed explicitly and handed to the next:

| Level | Contents | Lifetime |
| :--- | :--- | :--- |
| Realm services | `Sys` (platform), `Console` (output sink), `Cvar`/`Cmd` tables, file access (`COM`), model cache (`Mod`), event bus | One per JS realm (main thread, each worker) |
| Server runtime | `Server` (today's `SV`), its physics/messages/area/collision parts, `NetworkServer` (listening, client sockets), game module server side | One per running server |
| Client runtime | `Client` (`CL`), renderer (`R`, `GL`, `PostProcess`), sound, input, keys, menu stack, screen, `V`, local server controller | One per browser tab |

Rules:

- **Constructor injection of a narrow dependency interface**, not one big context object. A class
  lists what it needs (`{ console, cvars, files }`); it never receives "the engine".
- **State moves from `static` to instance fields.** Static members stay only for pure helpers and
  constants. Instance field access is not slower than static in V8, so hot paths do not pay.
- **`Cvar` and `Cmd` stay realm singletons in this plan.** They are already outside the registry,
  each realm (thread) has exactly one, and the worker needs its own table anyway. Revisit only if a
  second use case (two servers in one realm) shows up. This avoids touching every `new Cvar(...)`
  call. Because the tables are per realm, the client-to-server sync layer of Design B5 is a hard
  requirement (decision 4), not an extra. *(Decided, see decision 4.)*
- **Platform differences are injected, not flagged.** `Sys`, `Console`, file access and the
  `WebSocket` implementation are interfaces with browser, Node and worker implementations. This is
  what deletes `isDedicatedServer` and `isInsideWorker`: the loaders that skip GL data take a
  `loadRenderData` option from the caller (the server runtime passes `false`).
- **Game-facing API objects become instances with the same members.** `ServerEngineAPI` and
  `ClientEngineAPI` are static classes today, but the game already receives them as a value
  (`ServerGameAPI.Init(serverEngineAPI)`, `new ServerGameAPI(engineAPI)`), and game code references
  them as types (53 and 71 mentions). Passing an instance with the same members is
  source-compatible for games that only reach the engine through that parameter. A grep for
  `ServerEngineAPI.`/`ClientEngineAPI.` used as a value outside a parameter (none found in the
  quick scan of `id1`/`hellwave`, confirmed by the Phase 0 audit, finding 7).

**A2. Composition roots.** Replace the two `EngineLauncher` classes and the worker's lean registry
with factories under a new `source/engine/bootstrap/` directory (file names illustrative):

- `createBrowserClient(urls, buildConfig)`: realm services, client runtime, a
  `LocalServerController` (Design B) and the transport glue.
- `createDedicatedServer(buildConfig)`: realm services (Node `Sys`, Node `COM`, `ws`), server
  runtime, listening transports.
- `serverWorkerMain()`: the worker entry, realm services (worker `Sys`/`Console`/`COM`), server
  runtime, a `MessagePort` control channel. Replaces `WorkerFramework#InitRegistry`.
- Test factories that build the same graph from fakes. These replace `withMockRegistry`.

**A3. Migration mechanics (strangler, not big bang).** The registry keeps working until the last
consumer is gone.

1. **Ratchet first.** Add an ESLint `no-restricted-imports` rule for `registry.ts` with an allowlist
   of the files that still use it. The list may only shrink; a new file importing the registry fails
   lint. This turns "get rid of the registry" into a countable number that every phase lowers.
2. **Leaf-first order within a phase.** Convert modules that depend on little before their
   dependents: `Sys`, `Console`, file access, `Mod`, then `NET`, then the server parts, then the
   client parts, `Host` last (it is split, not converted).
3. **Per module:** turn the static facade into a class with injected deps, update callers, delete the
   prolog, convert that module's tests from `withMockRegistry` to constructing the instance with
   fakes, remove the file from the allowlist. `withMockRegistry` stays until the allowlist is empty.
4. **Cycles get fixed by moving code, not by moving imports.** The type-only cycles graphify reports
   do not matter; the runtime ones (`Host` <-> `CL` <-> `SV`) go away in Phase 1 because the client
   and server stop referencing each other.

### B. Server runtime in its own worker (Track B)

**B1. What crosses the boundary.** Exactly two channels, both over one `MessageChannel`/worker
port:

- **Data plane.** The existing protocol packets, as `ArrayBuffer`s (transferred, not copied), with
  the reliable/unreliable split of `LoopDriver`. A new `ChannelDriver` (or a generalized
  `LoopDriver`) yields a `QSocket` whose peer is the other thread. `Protocol.ts`/`MSG.ts` are
  untouched; `ServerClient` and `CL` neither know nor care whether the peer is in-thread or in a
  worker. This is how the wire format stays out of scope.
- **Control plane.** A small typed request/response and event API between a main-thread
  `LocalServerController` and the worker's `ServerHost`. It replaces every place where client or
  `Host` code currently reads `SV.*`:
  - lifecycle: `start({ map | savegame, maxclients, gamedir, cvars })`, `stop`, `crashed`
  - state mirror (read-only on the main thread): `{ active, maxclients, mapname, paused }`, the
    only server facts the client side reads today (`MenuPage`, `ClientConnection`, status UI)
  - simulation gate: `setSimulationAllowed(bool)` carries `M.AllowsSimulation()` (see Design B4)
  - console: forwarded server-side commands in, `Con.Print*` out
  - cvars: replication (Design B5)
  - savegame: `saveState()` and `restore(state)` (Design B6)
  - `Host.alert` / `host.crash` style events out, so a dying worker raises the same menu alert a
    server error raises today

**B2. Where transports terminate.** The server core only ever sees `QSocket`s. WebSocket (Node) and
`LoopDriver` already fit. For a browser-hosted listen server the spike (Phase 0 finding 1) showed
`RTCPeerConnection` does **not** exist inside a dedicated worker, so the main thread keeps the
peer connections and signaling (the existing `WebRTCDriver`, unchanged). Two ways to get its
packets to the server worker:

- **Relay (first implementation).** Each peer's `QSocket` on the main thread is bridged to a
  worker-side `QSocket` over the same `ChannelDriver` message format the local client uses. No change
  to `WebRTCDriver`, works in every browser, one extra `postMessage` hop per remote packet (remote
  players only; the local client never goes through it).
- **Transfer (later optimization, optional).** An `RTCDataChannel` can be transferred to a worker,
  verified working in both directions in Chromium 151, which removes the main-thread hop. Constraints
  found: it must be transferred before it opens (the answerer side from inside `ondatachannel`, the
  offerer side right after `createDataChannel`), and the driver's separate `reliable` and
  `unreliable` channels each transfer on their own. Reported browser support is Chrome/Edge yes,
  confirmed in Firefox 155 and Chrome 154 by the developer (Phase 0 finding 6). Safari is out of
  scope (decision 12).
Not needed for correctness, so not on the critical path.

Either way the server core is unchanged. Decision 7 (relay is acceptable) is therefore satisfied
with the simpler of the two options.

**B3. Server runtime and loop.** Extract `Host.ServerFrame`/`ShutdownServer`/server-client
bookkeeping into a `ServerHost` (frame loop, scheduling, crash handling), the thing the TODOs in
`Host.ts` already ask for. The same class drives three places: the Node dedicated process, the
browser worker, and in-thread tests. It owns its own timer (the dedicated `Sys` already does:
`Host.Frame` in a loop). No client code runs in it.

**B4. Frame timing and input latency (the main risk of the worker split).** Today a `usercmd`
sent by `CL.SendCmd` is consumed by `Host.ServerFrame` in the same `_Frame` call, and the client
reads the result at the start of the next iteration. With a worker the question is when the server
frame runs. Per decision 5 the worker ships as the default, so latency is a measurement and tuning
input, not a shipping gate.

*Measured so far (Phase 0 finding 4, synthetic):* a worker whose frame runs **when a command
arrives** reproduces today's one-iteration behavior exactly (0 extra frames, p95 0; the message hop
itself is not measurable against frame cost). A worker on its **own fixed timer** adds latency:
about 0.1 to 1.1 extra frames on average at 72 Hz and 1.4 to 3.3 at 20 Hz (`sys_ticrate` 0.05). So
the tick policy is decided by the data: **the server frame for the local client is driven by command
arrival** (one server frame per client frame, as today), with a timer only as a fallback so remote
clients, an idle or paused local client and a backgrounded tab keep the world moving. Phase 3
repeats the measurement in the real engine and records the numbers here; if the added delay is
noticeable there, the remaining knobs are the fallback tick rate for single player and `ticrate`.

The menu gate (`M.AllowsSimulation()` pausing the world while a menu is open) becomes the
`setSimulationAllowed` control message, and hiding the tab should send it as `false` so a
backgrounded single-player game pauses instead of running on a throttled timer.

**B5. Cvars and console commands across the boundary.** The two realms have separate `Cvar`/`Cmd`
tables, and per decision 4 the player must still manage the local server from the console exactly
as before: typing `sv_gravity 400`, `set deathmatch 1` or `god` while hosting in the browser or
playing single player changes the running server, with no new syntax. The design that matches how
Quake already thinks about it (`Cmd_ForwardToServer`):

- The main thread owns the console and the config files. Commands it does not know are forwarded to
  the local server when one is running (server-side commands such as `god`, `give`, `kick`, game
  commands registered by `ServerGameAPI.Init`). The worker runs them with the same
  `ServerClient`/source semantics they have today, and its output comes back through the
  `Con.Print*` channel into the same console.
- **Ownership by registration.** Each realm registers the cvars its own code creates, so ownership
  needs no new flag: a cvar registered only by the worker is *server-owned* (`sv_*`, `nav_*`,
  `sv_rcon_password`, `sv_maplist`, and every cvar a game registers through
  `ServerEngineAPI.RegisterCvar`, which always adds `GAME | SERVER`); one registered only on the main
  thread is *client-owned* (`cl_*`, `volume`, renderer cvars, the client game's cvars) and never
  leaves it; one that both realms register from common init code is *shared*
  (`developer`, `pm_debug`, the `net_*` debug cvars, `host_framerate`, `sys_ticrate`). Host-registered
  `pausable`, `teamplay` and `NET`'s `hostname` are `SERVER`-flagged today but created by common code;
  after the Phase 1 split they are registered by the server runtime only.
- **Handshake.** The worker publishes `name, flags, value, description` for every cvar it registers.
  The main thread creates a proxy `Cvar` for each name it does not already own, so tab completion,
  `cvarlist`, `set`/`seta`, `toggle`, `WriteVariables` (archive) and `GetCvar()` from client game code
  keep working. For shared cvars the main thread's value wins and is pushed to the worker. User writes
  on the main thread go to the worker, which applies them and echoes the applied value back (the
  worker is authoritative for server-owned cvars); game-side changes flow back without a user action.
  The hooks already exist: `Cvar.set` publishes `cvar.changed` and `cvar.changed.<name>` on the event
  bus, which `Server.ts`, `Host.ts` and the network driver already subscribe to.
- **The worker starts eagerly, at engine startup, not at the first `map`.** `GameModule.Init()` (which
  runs `ServerGameAPI.Init`, where games register their cvars) runs in `Host.Init` before
  `exec better-quake.rc`, and client code reads server-owned cvars before any server exists (the
  hellwave lobby reads `hw_maxplayers` in `ClientAPI.ts` and `NewGameSettingsMenu.ts` documents that
  reading them before `ServerGameAPI.Init()` has registered them is "moot"). So `Host.Init` awaits
  the worker's handshake at the same point it awaits `GameModule.Init()` today, and the worker
  idles with no server active until a `map`/`load`. Startup cost is one worker boot, in parallel with
  the rest of init.
- Sync guarantees that the tests in Phase 3 pin down: (1) a write on the main thread is visible to
  server code before the next server frame; (2) a write by the game appears on the console without
  a user action; (3) server cvars exist on the main thread before the first console command after
  the worker starts, and are gone or marked inactive when it stops; (4) archived server cvars still
  land in the config file; (5) cheat and read-only flags are enforced by the worker, not only by the
  proxy.
- A proxy write must not feed back as a game-side change (no echo loop); the sync carries an origin
  tag for that.
- `map`, `load`, `connect` become requests to `LocalServerController`, which spawns or reuses the
  worker. This is also the natural place for `Host.Map_f`'s current inline `SV.SpawnServer`.

Precedents found in the code (Phase 0 finding 3): remote clients already get a read-only mirror of
`SERVER`-flagged cvars through `svc.cvar` (the full list at signon in `ServerMessages.ts`, one at a
time on change via `SV.messages.cvarChanged`), stored in `CL.cls.serverInfo`, a plain map rather
than `Cvar` objects. The local client in single player gets the same mirror over the loopback
today, and keeps getting it unchanged over the channel driver. That mirror is not enough for local
management (no tab completion, no `cvarlist`, no archive writes, no `GetCvar()` for client game code,
not even for cvars that are not `SERVER`-flagged), which is why the proxy model above is used on top
of it. Remote clients change server state only through rcon (`SV.HandleRconRequest`: password check,
then `Con.StartCapturing()` / `Cmd.ExecuteString()` / `Con.StopCapturing()` and the captured text is
sent back as `svc.print`). The local console forwarding in this design is the same mechanism with the
password check replaced by "the local console is always allowed", and the capture replaced by the
`Con.Print*` channel.

Two code paths need adjusting when this lands: `Cvar.Command_f` reads `SV.server.active` and
`CL.cls.serverInfo.sv_cheats` for the cheat check (the first becomes the control-plane state mirror),
and the worker re-checks `CHEAT`/`READONLY` on every forwarded write.

**B6. Savegames.** `Host.Savegame_f` (single player only: it refuses when `SV.svs.maxclients !== 1`
or during intermission, which is client state) builds one `SavegameState` from both sides: server
edicts, `gameAPI.serialize()` globals, spawn parameters, time, lightstyles and the `SERVER | GAME`
cvars from the server, plus `clientdata` (`CL.state.gameAPI.saveGame()`), `particles` and
`clientEntities` from the client, and writes it as JSON with `COM.WriteTextFile` (localStorage in the
browser). Split it into `ServerSaveState` (worker) and `ClientSaveState` (main), composed into the file
on the main thread, through the writable store of B7 since localStorage is unreachable from workers.
The cvar list needs no special handling: the main-thread table already holds every server-owned cvar
as a proxy (B5). Load reverses it: the main thread parses the file, sends the server part with the
`restore` request, and keeps the client part until signon completes. The file format does not change.
This must be designed together with the in-flight client-entity savegame work. Not yet audited:
`Loadgame_f`'s ordering against signon, which Phase 1 reads when it edits `Host.ts`.

**B7. Models, files and the game module inside the worker.**

*Shared file loading (decision 8).* Findings from the code (Phase 0 finding 5):

- Browser `COM.LoadFile` checks `localStorage` first (not available in workers; it is guarded by
  `registry.isInsideWorker`), then does a plain `fetch` of the CDN or `/qfs/` URL. There is no
  application cache, only whatever the HTTP cache does. PAKs are pre-extracted at build time, so the
  browser fetches individual files. Node's `COM.LoadFile` reads PAK entries from disk per call.
  `COM.WriteFile` is explicitly unsupported inside workers, and `WorkerCOM` is a TODO.
- Within one realm, client and server already share parsed models through the `shared`
  `ModelScope` (`Mod.RegisterScopedSubmodels` gives each side its own submodel copies of the shared
  world). That implicit sharing disappears with the thread boundary.
- The navigation worker avoids loading the map by not needing it: it receives only `mapname` and the
  BSP `checksum` (`nav.load`) and reads its own precomputed `maps/<name>.nav` through its own
  `COM.LoadFile`. That is the right answer for nav, which needs a different artifact, but it is not
  sharing. The server worker needs the very same BSP and model files the client loads.

Design, three layers:

1. **Shared byte layer behind one `AssetSource` interface** (the Track F first step, pulled forward
   to Phase 2). Browser: `fetch` fronted by **Cache Storage**, keyed by the file URL (later by
   content hash). Cache Storage is origin-wide, so every realm sees it: a file one realm fetched is
   a local read for the other, independent of HTTP cache headers, and it survives reloads. Node:
   the existing `fs`/PAK path. Rejected alternative: the main thread brokering file bytes to the
   worker over the control channel, which costs a round trip per file and keeps the busy thread in
   the loop. **Invalidation (decision 9):** the cache is named
   `quakeshack/<engine version>/<game dir>/<game version>`, where the engine version is the same
   string `Host` already builds for the `version` cvar (`Def.productVersion`, plus `+<commit hash>`
   when the build has one) and the game version is `identification.version` of the loaded game
   module. On boot the asset layer opens the cache of its own name and deletes every other cache whose
   name starts with `quakeshack/`. A dev build without a commit hash falls back to
   `Def.productVersion` plus `__BUILD_TIMESTAMP__`, so local rebuilds never serve stale files.
   Cost to be aware of: raw content bytes do not depend on the engine, so keying on the engine
   version re-downloads everything on every deploy. Accepted for now because it is simple and safe;
   Track F's content hashing removes the cost (cache by file hash, keep across deploys).
2. **In-flight de-duplication with Web Locks.** The client and the server precache nearly the same
   list at the same moment, so a plain cache would still let both miss and fetch. Wrap
   check-cache, fetch, put in `navigator.locks.request('asset:<path>')`, so the second realm waits and
   then hits the cache. Without Web Locks the failure mode is only a duplicate fetch.
3. **Parsed data stays per realm, but only as deep as the realm needs.** The server realm loads with
   `loadRenderData: false` (no textures, no lightmaps, nothing GL), reusing the loaders' existing
   dedicated-server branches as an explicit option. What really is duplicated is geometry (planes,
   nodes, clip nodes, leafs, visibility): the server needs it for collision and PVS, the client for
   rendering and for prediction hulls. Sharing parsed structures across threads needs
   `SharedArrayBuffer`, which is a non-goal, so this duplication is accepted and measured in Phase 3.
   Loaders should keep putting bulk data in typed arrays rather than object graphs, so that moving
   to shared memory stays possible if cross-origin isolation ever becomes acceptable.

*Writable storage.* The same interface fronts a **user store** for what the engine writes (saves,
`config.cfg`, generated `.nav` files). Browser: IndexedDB (async, present in workers), replacing
`localStorage`. Search order stays Quake's: the user store overrides read-only content. Existing
`Quake.<gamedir>/<file>` localStorage entries are copied to IndexedDB once on first boot.
`COM.WriteFile`/`WriteTextFile` become async, so every caller is audited (`Host.Savegame_f`,
`Host.WriteConfiguration`, `Navigation`, anything exposed through the engine APIs; none audited yet).

*Worker world loading and the game module.*

- The worker loads its own world through `ModelScope.server`, as today, through the layers above.
- The game module's `main.ts` is imported in both realms: `ServerGameAPI` runs in the worker,
  `ClientGameAPI` in the main thread. Two points:
  1. `import.meta.glob('../../game/**/main.ts')` in `GameModule.ts` (marked "NEVER EVER TOUCH") works
     inside the Vite worker bundle: verified by building a worker that uses the identical code with
     Vite 8 and running it in Chromium 151 (Phase 0 finding 2). The browser Vite config already has a
     `worker` block and already emits `worker-NavigationWorker-*.js`.
  2. Client game code calls static helpers on `ServerGameAPI`: `GetMapList()` (`id1/client/Menu.ts`,
     `hellwave/client/ClientAPI.ts`, `NewGameMenu.ts`, `MainMenu.ts`) and `GetStartServerList()`.
     Phase 0 read them: they return constant data (`GetStartServerList` entries carry a callback
     that only calls `engineAPI.AppendConsoleText`, i.e. the main console), so they are safe on the
     main thread as long as they stay stateless. Moving them to `source/shared/` or `ClientGameAPI`
     is a game-side change and per `typescript-port.instructions.md` is raised with the developer first.

**B8. Failure handling and debugging.** A worker that dies maps to the existing alert path
(`host.alert`) and returns to the menu. Source maps and DevTools already work for the dedicated
worker bundle; the browser build must keep them. A `Host.Error` inside the server realm is reported
to the main thread, which decides what to show.

**B9. What this buys beyond the thread.** Server hitches (navigation, AI, big physics steps) and
server GC no longer block rendering. A hot reload of server game code becomes "terminate and respawn
the worker" (Track C). Single player and a hosted listen server finally exercise the same code path
a remote client does, so there is one path to test.

### C. Game module lifetimes, typed events, hot reload (Track C)

- **Lifetime scopes** `engine > module > connection > map`, each a disposable owner. Anything a game
  or the engine subscribes in a scope is released when the scope ends. This replaces both "wipe the
  per-connection bus on disconnect" and the separate `ClientEngineAPI.moduleEventBus`; today's two
  buses become two scopes of one mechanism with the same observable behavior. `unsubscribeAll()`
  has no exceptions, by design, and that stays true at scope end.
- **Typed event map**: one `interface EngineEvents` in `source/shared/` mapping event name to
  payload tuple (games augment their own), so `publish`/`subscribe` are checked. A test asserts the
  documented events in `docs/events.md` equal the keys of the map, which is the enforcement the
  `event-bus-docs-sync` skill says is currently missing.
- **Events stop being wiring.** After Track A the bus no longer breaks circular dependencies; what
  remains are lifecycle and cross-realm notifications. Direct calls replace event use where a return
  value or hot path is involved.
- **Hot reload (dev only):** server side = respawn the worker (cheap after Track B); client side
  needs the same scope teardown plus a fresh module import. Scope the work in the Track C plan.
- **Capability scoping and sandboxing:** the worker is already a realm without DOM access. Narrowing
  `ServerEngineAPI` to the capabilities a module declares (`identification.capabilities` exists) is
  the next step if untrusted community server mods become a goal. Out of scope until then; the
  design only needs to not preclude it.

### D. Renderer (Track D)

Ordered cheapest and most valuable first; each is its own plan:

1. **Shader chunks.** A build-time `#include` (Vite plugin or raw-import composition) so shared
   routines (shadow sampling, lighting, fog, tonemapping) live once. Retires the manual duplication
   across `alias.frag`/`mesh.frag`/`player.frag` and the `shader-duplication-propagation` skill's
   checklist.
2. **Split `R.ts`** (3561 lines) into passes and per-feature collaborators, in line with the
   existing `BrushModelRenderer`/`PostProcess`/`ShadowMap` split.
3. **Frame graph** with declared resource reads/writes per pass. The depth-sampling feedback-loop
   trap (`PostProcess.beginDepthSampling`/`endDepthSampling`) becomes a graph validation error
   instead of a JSDoc contract.
4. **GPU abstraction + WebGPU evaluation spike**, ending in a go/no-go decision. Not committed to
   here: the abstraction is worth having on WebGL2 alone, and the WebGPU backend is a separate
   decision.

### E. Collision and movement (Track E)

- `Pmove` is already registry-free. Keep it that way and add determinism tests asserting client and
  server produce bit-identical results over recorded and randomized `usercmd` sequences.
- Formalize `CollisionModelSource` as a `CollisionWorld` interface. Each realm gets its own instance
  (today a module-level `sharedCollisionModelSource` is shared by `SV.area` and `SV.collision`), which
  falls out of Track A.

### F. Asset pipeline (Track F)

The first step, the shared `AssetSource` with Cache Storage, Web Locks de-duplication and the
IndexedDB user store, is designed in B7 and delivered in Phase 2 because the server worker cannot
start without it. The rest is its own plan and can follow later: content-hash addressing (key the
cache by hash instead of URL, so a changed file never serves stale), an optional service worker for
offline and pre-warming, streaming and priority for large files, and an audit that no synchronous
file path remains (`COM.LoadFile` is already async).

### G. Quality infrastructure (Track G)

- **Type-checked tests.** `tsconfig.json` is `strict` but excludes `source/game/**/test/**` and does
  not include `test/`, and `.mjs` tests slipping past the checker is already a recorded hazard
  (`unit-tests.instructions.md`). Convert tests to `.ts` (run by `tsx` as today) and include them in
  `npm run typecheck`, in the same sweep as the Track A test migration so each test is touched once.
- **Deterministic replay (decision 14).** A recording is the starting state (map, or a savegame,
  plus the cvars) and a log of every input the server consumed; replaying feeds the log into a
  headless server runtime (Track B makes that a plain class with no client attached) and reproduces
  the session, so a bug found once can be rerun on demand, bisected across commits and kept as a
  regression test. It doubles as a bug-report attachment.

  The nondeterminism that has to be pinned, found in the code (not yet verified by a replay run):

  | Source | Today | What replay needs |
  | :--- | :--- | :--- |
  | Frame time | `Host.frametime`, a realm global derived from the wall clock, read by `ServerPhysics` and others | The server frame takes the time step as an **explicit argument**, and the recording stores it. Phase 1 introduces `ServerHost` anyway, so this is done there at no extra cost |
  | Client input | `usercmd`s read from sockets as they arrive | Record per server frame: which commands each client contributed. With the command-driven tick policy (B4) a frame is naturally "one command batch" |
  | Console and cvar changes | `Cmd` text and `Cvar.set` at arbitrary times | Record forwarded commands and cvar writes with the server frame they were applied in (B5's control plane already carries them) |
  | Randomness | `Math.random` is called directly all over game code (`Player.ts` 16 sites, monsters 5 to 11 each, `GameManager` 9, and more) | Install a **seeded PRNG as `Math.random` inside the server realm** at startup and record the seed. No game code changes. Only possible because the server has its own realm after Track B; in the current shared thread it would also change client behavior |
  | Navigation answers | Path requests go to the navigation worker, and responses arrive whenever it finishes | Record responses with the frame they were delivered in and replay them from the log, or resolve them synchronously in replay mode |
  | Connect, disconnect, spawn | Network and signon timing | Record as events in the log |
  | Asset loading | Async, but the result is the same files | Nothing, as long as the log names the same content version (decision 9's cache namespace is exactly that identity) |

  Out of scope for the first version: replaying the client (rendering, prediction); only the server
  simulation is reproduced, and a client-side repro still needs a demo. Verification: record a
  session, replay it twice, compare a hash of the entity state each frame; any divergence points at
  a missed nondeterminism source from the table.
- **Frame profiler** replacing the ad-hoc `console.profile` calls gated on `Host.speeds`, covering
  both realms.

## Phasing

Tracks A and B are interleaved because Host cannot be split without removing the registry from the
parts, and the worker needs a registry-free server. Each phase ends with tests, lint and typecheck
green and the game playable, and stops for a go-ahead before the next one.

### Phase 0: Groundwork (no behavior change)

Status 2026-10-03: the spikes and read-only audits are done, see "Phase 0 findings". Still open and
deliberately waiting: the ESLint registry ratchet (waits for the `client-entity-architecture` merge,
see Coordination), and the in-engine latency and memory baselines (need a full browser run of the
real engine, which Phase 3 does anyway; the design question they would have answered is already
settled by finding 4).

- [x] Spikes: (a) `RTCPeerConnection` in a worker, (b) `import.meta.glob` game loading in a Vite worker
  bundle, (c) how server cvars replicate today.
- [x] Check the game-API usage claim in A1, audit client calls into `ServerGameAPI` statics, read the
  savegame path.
- [x] Check that the primitives the file-sharing design needs exist in a worker.
- [x] Browser coverage: Firefox 155 and Chrome 154 pass the worker checks (finding 6). Safari is out of scope
  (decision 12).
- [x] Dependency inventory for `Host`, `SV`, `CL`: done with grep at the start of Phase 1 (graphify was
  not needed for a boundary this narrow); it found one client-to-`SV` read the plan had missed
  (`ClientEntityPhysics`, added by the merged client-entity work) and two server-to-client leaks
  (`Navigation`, `ServerEdict`), see Phase 1.
- [x] ESLint registry ratchet: `registryImporters` in `eslint.config.mjs`, 91 files at 2026-10-05
  (28 `client`, 13 `client/renderer`, 13 `common`, 11 `server`, 6 `server/physics`, 5 `client/menu`,
  5 `common/model/loaders`, 4 `network`, 4 `common/model`, 2 in `engine/`). A file off the list that
  imports `registry.ts` fails lint.
- [x] Baseline on the merge commit: 1396 tests passing, `npm run typecheck` clean, `eslint source/engine`
  0 errors (54 `unbound-method` warnings).

### Phase 1: Split Host into client and server runtimes, in-thread

Starts after `client-entity-architecture` phase 6 has landed (decision 6).

- Introduce `ServerHost` (frame, scheduling, shutdown, server console commands) and
  `ClientHost`. `Host` shrinks to the shared lifecycle glue and then disappears.
- Cut the direct reads: `R.ts`/`Chase.ts` use the client's own collision source
  (`CollisionModelSource.configureClient`), `MenuPage`/`ClientConnection` read the control-plane
  state mirror, `M.AllowsSimulation()` becomes an explicit simulation-gate call instead of a
  `Host.ServerFrame` condition.
- Define the control-plane interface and a `LocalServerController` that is still in-thread.
- Make the server frame take its time step as an explicit argument instead of reading the
  `Host.frametime` global (needed anyway to detach the server from `Host`, and the first
  requirement of deterministic replay, Track G).
- Registry still exists. Allowlist shrinks wherever a file is touched.
- Done when: no file under `source/engine/server/` imports from `client/`, no file under
  `source/engine/client/` references `SV` (a lint rule enforces both, ratcheted like the registry),
  single player and listen play exactly as before.

#### Phase 1: what shipped (2026-10-05)

Both done-conditions hold, enforced by `test/common/engine-boundaries.test.mjs` (runs in `npm test`, so
it gates the deploy) and by lint blocks in `eslint.config.mjs`. 1455 tests pass, `npm run typecheck` is
clean, `eslint source/engine` has 0 errors. Verified in a real Chromium (see below).

- **`ServerHost`** (`server/ServerHost.ts`): `ServerFrame(frametime, realtime)`, `Frame`, `ShutdownServer`,
  `DropClient`, the client message helpers, `StartMap`/`AnnounceChangelevel`/`Changelevel`, the dedicated
  session commands (`map`, `changelevel`, `restart`, `disconnect`, stand-ins for `connect`/`bind`), and the
  server-side console commands (`status`, `god`, `notarget`, `fly`, `noclip`, `say*`, `tell`, `kill`,
  `pause`, `spawn`, `begin`, `prespawn`, `kick`, `ping`, `give`, and the server halves of `name` and
  `color`). It owns `pausable` and `teamplay`, as B5 asked. It imports nothing from the client.
- **`ClientHost`** (`client/ClientHost.ts`): `Frame` (the whole client branch of the old `_Frame`) and the
  player-side session commands (`map`, `changelevel`, `restart`, `connect`, `reconnect`, and the local
  halves of `name`/`color`). It reaches the local server only through `CL.serverController`.
- **`Host`** shrank from 2085 to 922 lines. It keeps init/shutdown, frame timing and scheduling, config
  writing, crash handling, `Error`/`EndGame`/`quit`, and three things that are deliberately not split yet:
  `Savegame_f`/`Loadgame_f` (B6 designs the split), the `view*` development commands, and a small router
  for `name`/`color`, which exist on both sides while both still share one `Cmd` table. The router goes
  away with the table split in Phase 3.
- **Control plane**: `common/ServerController.ts` (the `ServerController` interface and the
  `ServerStateMirror` of `active`, `maxclients`, `mapname`, `paused`) and
  `server/InThreadServerController.ts`, installed as `CL.serverController` by `main-browser.ts`. The
  interface is `state`, `setSimulationAllowed`, `runLocalFrame`, `start`, `announceChangelevel`,
  `changelevel`, `stop`. `ClientConnection` and `ClientHost` use only it. Not part of the interface yet:
  savegames and console forwarding (Phase 3).
- **Explicit time step**: `SV.server.frametime` and `SV.svs.realtime`, set by `ServerHost.ServerFrame`.
  No code under `server/` reads `Host.frametime` or `Host.realtime` any more.
- **Simulation gate**: `ServerHost.simulationAllowed`, set from `M.AllowsSimulation()` through the
  controller before every local server turn, replaces the `registry.isDedicatedServer && M.AllowsSimulation()`
  condition inside `ServerFrame`. A dedicated server never opens it, so it behaves as before.
- **Client-to-`SV` reads cut**: `CL.collision` (`client/ClientCollision.ts`) answers `pointContents` and
  `traceStaticWorldLine` from the client's own world model. `R.ts` (4 reads), `Chase.ts` (3) and
  `ClientEntityPhysics.ts` (1, new since the plan was written) use it. `ClientConnection` uses the
  controller. `MenuPage`'s `SV` was only a comment.
- **Server-to-client leaks cut**: the navigation debug dots moved to `client/NavigationDebug.ts`
  (the server only publishes the existing `nav.debug.emit-dot.*` events), and `ServerEdict`'s client-side
  reader moved out of `Edict.ts` through the new `registerClientDeserializer()` in `MSG.ts`, so the
  type id on the wire is unchanged.
- **Shutdown order**: `ServerHost.ShutdownServer` now marks the server inactive before it publishes
  `server.shutting-down`, and a local client disconnects by listening to that event instead of
  `Host.ShutdownServer` calling `CL.Disconnect()`. Nothing else listened to the event.
- **Behavior changes, all deliberate**: a remote client typing a bare `name` no longer makes the host print
  its own name; the dedicated `connect` prints only its "cannot connect" line, without the usage text first.

Browser verification (Chromium 1234 headless against a scratch dedicated server on port 3001, per
`docs/browser-verification.md`): menu to new game, server time advancing, menu open freezes the world and
closing resumes it, `status` and `god` through the console (server commands, `god` correctly refused
without cheats), `changelevel e1m2`, `save`, `map e1m3`, `load` back to e1m2 with a correct render,
`disconnect` shutting the local server down, and a second client over WebSocket (`connect self`) doing
`name`, `color`, `say` and `status` against the dedicated server. Not verifiable here: pointer lock and
mouse look (untouched by this phase), and Firefox.

Found while doing it, carried into later phases:

- `Host.noclip_anglehack` is written by the server `noclip` command and read by `IN.ts` and `V.ts`, a
  server-to-client global. Phase 3 must have the client derive it from the player's move type instead.
- `ClientHost.Init` sets `ServerHost.getLocalOperatorName` so that a local `kick` says who kicked. That is
  a client-to-server import and a callback across what becomes a thread boundary. Phase 3 turns it into a
  value the client pushes through the control plane.
- The `view*` commands read `SV.server.edicts` and write `CL.state.model_precache`, so they only work
  in-thread. Phase 3 needs to decide whether they become server commands plus a client-side model load, or
  go away.
- `ClientServerCommandHandlers` still feeds `sharedCollisionModelSource.configureClient`, so the server's
  collision falls back to the client's world when no server world exists. Phase 2 removes that coupling
  when `ServerCollision` gets its own model source instance.
- Several client files import server classes as type or token only (`CollisionTrace`, the `ServerEdict`
  constructor, the legacy hull helpers in `ClientCollision`). That is allowed by the done-condition and
  harmless in-thread, but it pulls server code into the client bundle; revisit with the worker build.
- `registry.isDedicatedServer` still branches 61 times. Phase 2 and 4 remove them.

### Phase 2: Registry removal for the server side and shared services

- Realm services (`Sys`, `Console`, file access, `Mod`) as injected instances. *(2b; the file layer part of
  this bullet is 2a and done.)*
- **The shared file layer of B7**: `AssetSource` with the browser (fetch + Cache Storage + Web Locks),
  Node (fs/PAK) and worker implementations, plus the IndexedDB user store and the one-time
  localStorage migration, with the async `COM.WriteFile`/`WriteTextFile` caller audit. This replaces
  `WorkerCOM` and lands here, before the worker, so the worker boots on a finished file layer. It
  also lets the navigation worker read `.nav` files through the same interface.
- Server runtime and `NetworkServer` as instances; `ServerEngineAPI` as an instance. *(2b)*
- `createDedicatedServer` composition root; Node dedicated server runs from it.
- `WorkerFramework`'s lean registry replaced by a worker composition root skeleton (unused by the
  browser yet).
- Done when: the server runtime and everything under `source/engine/server/` and
  `source/engine/network/` import no registry, and the dedicated server boots from the new root.

#### Phase 2: forks settled before starting (2026-10-05)

Phase 2 as written is two jobs with different risk, and a first look at the tree shows where the size is:
11 `server` + 6 `server/physics` + 4 `network` files import the registry (21 of the 91), but they pull
`Con`, `COM`, `Sys`, `NET`, `SV`, `Host` and `Mod`, which are shared with the other 70 files (`client`,
`common`, the launchers), so converting a realm service means touching its client callers too, in the same change.

1. **Split the phase?** Decided with the developer on 2026-10-05: split, 2a first. Proposal as put: **2a** the shared file layer (`AssetSource`, Cache Storage, Web Locks,
   IndexedDB user store, the one-time `localStorage` migration, async `WriteFile`/`WriteTextFile` and
   its callers `Host.WriteConfiguration`, `Host.Savegame_f`, `ClientDemos`, `Navigation`). It does not
   depend on removing the registry, it has its own real-browser checks (a second tab, a reload, the
   migration), and it can land first. **2b** the registry removal for the realm services and the server
   runtime, then `createDedicatedServer`. Each with its own go-ahead.
2. **File API seen by games.** (One exception found while doing 2a: `ClientEngineAPI.SaveSlots`, see below.) `COM` is not part of `ServerEngineAPI`/`ClientEngineAPI` today (games read
   `COM.registered`-style flags only through the engine), so the file layer can change freely. Nothing to
   decide unless a game wants file access later.
3. **How a converted service coexists with the registry** (A3 says strangler): proposal is that the
   registry slot holds the *instance* from the moment a service is converted (`registry.Con = new
   Console(...)`), so files that still destructure `Con` keep working unchanged and come off the
   allowlist one by one as they receive the instance by constructor. The static facade disappears when its
   last registry reader does.

#### Phase 2a: what shipped (2026-10-05)

The shared file layer of B7, as designed, in the browser; the dedicated server keeps reading the file
system directly. Reference doc: `docs/asset-layer.md`. 1507 tests pass, `npm run typecheck` clean.

- **`AssetSource` + `CachedFetchAssetSource`** (`common/AssetSource.ts`): content through Cache Storage,
  one Web Lock per file (`asset:<url>`) so two realms download once, `AssetCaches.name/prune` for the cache
  names `quakeshack/<engine>/<game dir>/<game version>` and the cleanup of every other `quakeshack/` cache.
- **`UserStore` + `BackendUserStore`** (`common/UserStore.ts`) on a three-method `KeyValueBackend`;
  `IndexedDbBackend` is the real one, `MemoryBackend` the fallback when IndexedDB is unavailable. The
  store never throws. `migrateFromLocalStorage` moves `Quake.<game dir>/<file>` once, interruption-safe.
- **`COM`** (`common/Com.ts`): `LoadFile` asks the user store first, then the asset source;
  `WriteFile`/`WriteTextFile` write the user store and are **async now** (callers awaited:
  `Host.WriteConfiguration`, `Host.Savegame_f`; `ClientDemos` and `Navigation` already awaited).
  `InitStorage()` sets it up (a no-op in `NodeCOM`, which also got an async `WriteTextFile`), and a browser
  worker calls it from `worker.framework.init`. `SetGameVersion()` (called by `GameModule.Init`) switches the
  cache to the game version and prunes. `registry.isInsideWorker` had no readers left and is deleted.
- **`SaveSlots`**: `ClientEngineAPI.SaveSlots.List()/Delete()` are synchronous and used by game menus while
  they draw, so they stay synchronous and answer from a metadata snapshot (`SaveSlots.refresh()` at startup
  and after every `save`). The game contract is unchanged.
- **Deviations from B7 as written**: (1) files needed before the game module loads (palette, `pop.lmp`) are
  cached in a `boot` namespace that follows the engine version only; (2) **development builds revalidate**
  cached files with conditional requests, because the build time baked into a `vite build --watch` session
  does not change and a map edited on disk would otherwise be served stale until site data is cleared; an
  unchanged file costs a `304`; (3) the user store has no `list()`, nothing needs it.
- **Verified in Chromium** (scratch dedicated server, `docs/browser-verification.md`): legacy
  `localStorage` files seeded before boot were moved to IndexedDB and removed, other keys untouched; a stale
  `quakeshack/...` cache was deleted and a foreign cache kept; `save`, `writeconfig`, reload, and `load`
  after the reload work; the user store survives the reload; a second tab and a reload in a production-like
  build download almost nothing (3 requests against 67 with revalidation off, 68 conditional requests with it
  on); a file changed on disk is picked up on the next load in development mode; the browser nav worker still
  loads its `.nav` file. Not verifiable here: Firefox, Safari (out of scope), quota exhaustion.
- **Known limits**: a configuration write started while the page closes may not finish (archived cvar
  changes are written 5 s after they happen, so only the last moments are at risk); every deploy downloads
  everything again until content hashing (Track F) replaces the engine version in the cache name.

#### Phase 2b: what shipped (2026-10-05)

Done-condition met: nothing under `source/engine/server/` or `source/engine/network/` imports
`registry.ts` any more (`test/common/engine-boundaries.test.mjs` fails the build if one does, and the
ratchet in `eslint.config.mjs` went from 91 to 63 files). 1528 tests pass, `npm run typecheck` is clean,
`eslint source/engine` has 0 errors. `registry.isDedicatedServer` branches went from 61 to 39.

- **`EventBus` is its own module** (`common/EventBus.ts`): about 150 files imported `eventBus` from
  `registry.ts`; they now import it from there, which is what lets a file stop importing the registry.
- **`Server`** (`server/Server.ts`, the old `SV`) is an instance built from `ServerDependencies`
  (`con`, `sys`, `net`, `mod`, `view`, `files`, `engineVersion`, `dedicated`, the collision model source).
  Its parts (`ServerPhysics`, `ServerClientPhysics`, `ServerMessages`, `ServerMovement`, `ServerArea`,
  `ServerCollision`) and `ED` take the server by constructor; `ServerEdict` and `ServerClient` carry a
  reference to theirs (`ServerEdict` under a symbol key so the game-facing `Readonly<ServerEdict>` type does
  not turn nominal). `dropClient`, `clientPrint`, `broadcastPrint` and `sendChatMessageToClient` moved
  from `ServerHost` onto `Server`, where `ServerMessages` needs them without a cycle.
- **`ServerHost`** is an instance too (`ServerHostDependencies`: the server, `dedicated`,
  `scheduleForNextFrame`, `profiling`, `setNoclipAnglehack`). Its console commands are methods that get
  the running command as a parameter and are registered through one small helper, so no command class
  needs `this` to be anything but the command. `maxplayers` and the "listen when the server is for more
  than one player" automation moved here from `Network`, where they reached into `SV`.
- **`Navigation`** takes its services (`con`, `files`, and the server or `null` inside the path-finding
  worker) instead of reading three registry members. The navigation debug dots were already client code.
- **Realm services as instances**: `COM` (and `NodeCOM`), the dedicated `Sys` (`DedicatedSys`) and `NET`
  (and its four drivers) are instances with constructor dependencies. The three pure text helpers of
  `COM` (`Parse`, `ParseEntityLump`, `DefaultExtension`) stay static and are also reachable on the
  instance, so code that holds `COM` through the registry did not change.
- **`Network` no longer knows the client**: `NET.Connect` leaves the client's connection state to
  `ClientConnection`, and the `invite` command and the "press X to invite others" hints are client code
  (`client/InviteCommand.ts`, `ClientHost`).
- **Composition roots**: `bootstrap/createDedicatedServer.ts` (what `main-dedicated.ts` now delegates to)
  and `bootstrap/createServerRuntime.ts`, which the browser launcher uses as well. Both still fill the
  registry that the rest of the engine reads. `WorkerFramework.Init()` now returns the services a worker
  script is built from (`con`, `com`) instead of the scripts looking them up.
- **Tests**: server classes are built with a real `Server` over silent stand-ins (`createTestServer`,
  `createTestServerHost`, `createTestNetwork` in `test/physics/fixtures.mjs`) where a test needs one, and
  with `registrySV()`, a proxy that forwards to whatever `registry.SV` the test installs, where a test only
  swapped a mock registry before. New files: `create-server-runtime`, `server-host`,
  `server-drop-client`, `server-host-shutdown`, `in-thread-server-controller`.
- **Verified in Chromium** against a rebuilt scratch dedicated server: single player (new game, pause by
  menu, `status`, `god`, `changelevel`, `save`, `load`, `disconnect`), a remote client over WebSocket
  (`name`, `color`, `say`, `status`), the file layer (migration, reload, second tab), the browser nav
  worker, and `maxplayers 4` followed by a map (the network starts listening) and back to `maxplayers 1`
  (it stops).
- **Behavior changes, all small**: `SzBuffer`'s overflow message and the legacy hull "backup past 0"
  diagnostic go to `console.warn`/`console.debug` instead of the in-game console (those two files had no
  other reason to know the console); `Host.Error` always asks the server host to shut down, which is a
  no-op without a running server; an edict reference is never read from a client on the server, so the
  unused server-side reader of that type was dropped from its serializer registration.

Not done, and why (each is a reason Phase 3 cannot start blind):

- **`ServerEngineAPI` as an instance.** `common/GameAPIs.ts` (about 1700 lines) still reaches `SV`, `COM`,
  `Host` and `CL` through the registry, and `Server` still imports it as the class handed to the game
  module. Making it an instance changes what `ServerGameAPI.Init` receives, which is the game contract in
  `docs/game-module-contract.md`, so it needs the developer's call and a game-module pass, not a refactor
  slipped into this one. It also ties to Track C (lifetimes).
- **`Console`, `Mod`, `V` and `Host` are still static facades**, passed to the server runtime as the narrow
  interfaces it needs (`ConsoleOutput`, `ModelCache`, `PlayerView`, ...). They are per-realm singletons
  and most of their registry users are client code, so their conversion belongs with Phase 4. The cost is
  that a second `Server` in one realm would share them, which nothing needs.
- **`WorkerFramework` still fills a lean registry** because `Mod` reads it. The worker composition root
  proper replaces it when `Mod` is converted.

### Phase 3: Server in a Web Worker (browser)

- `ChannelDriver` over `MessagePort`; `LocalServerController` spawns the worker **at engine startup**
  and `Host.Init` awaits its cvar handshake (B5).
- Worker bundling for the browser build (the `worker` block and `GameModule.ts` glob are verified
  to work, finding 2), cvar/command routing (B5), savegame split (B6), `setSimulationAllowed`,
  crash alert.
- Keep the control plane and the per-frame input path loggable (every command, cvar write and
  connection event passes through one place), so the later replay recorder is a subscriber and not a
  refactor.
- Tick policy per B4: the server frame for the local client runs on command arrival, with a timer
  fallback for remote clients, an idle client and a hidden tab.
- Listen-server transport: the main thread keeps `WebRTCDriver` and relays each peer's packets to the
  worker (B2). Channel transfer is a later optimization, not part of this phase.
- Latency and memory measurement in the real engine (command-send to first frame that reflects it,
  and heap with the world loaded in both realms, before and after `loadRenderData: false`); results
  are recorded in this plan. The worker is the default for single player and listen servers from the
  start (decision 5). The in-thread server path stays for Node tests and the dedicated server, and
  can be selected by a runtime switch for debugging.
- Cvar/command sync per B5, including the five sync guarantees as tests.
- Real-browser verification of: new game, map change, save/load, changing server cvars and running
  server commands from the console in single player and while hosting, menu pause, tab hide/show,
  killing the worker, a second client joining over WebRTC, and a second browser tab loading a map
  already cached by the first (`browser-ui-verification` skill).

#### Phase 3: forks settled before starting (2026-10-05)

Decided with the developer:

1. **Split into 3a / 3b / 3c, stopping after each.**
   - **3a, the worker exists and plays:** `ServerEngineAPI` as an instance, `ChannelDriver`, the server worker
     entry, `WorkerServerController` (start / changelevel / stop / state mirror / simulation gate /
     command-driven tick / crash alert). Selected by a runtime switch; **in-thread stays the default
     through 3a**, because flipping it before cvar sync and savegames work would break the console.
   - **3b, the worker is complete:** cvar proxies and console forwarding (B5) with the five sync guarantees as
     tests, savegame split (B6), the three Phase 1 leftovers (`noclip_anglehack`, the operator name,
     `view*`), then **flip the default to the worker** (decision 5).
   - **3c, the worker is verified:** WebRTC relay (B2), hidden-tab pause, latency and memory measurements
     recorded here, the full real-browser checklist.
2. **`ServerEngineAPI` becomes an instance in 3a**, not later. This is the 2b leftover that changes what
   `ServerGameAPI.Init` receives. The member surface stays identical, so a game that only uses it through
   the parameter compiles and runs unchanged; the contract type in `shared/GameInterfaces.ts` changes from
   `Readonly<typeof ServerEngineAPI>` to `Readonly<ServerEngineAPI>`. It moves out of `common/GameAPIs.ts`
   into `server/ServerEngineAPI.ts`, because that file imports the menu, renderer and input code and a
   worker bundle must not. `ClientEngineAPI` stays static until Phase 4.
3. **The `view*` commands stay**, via a small server query for the edict's model name over the control plane,
   with the client loading the model itself (3b).

Design notes found while reading the code for 3a:

- `ChannelDriver` is a sibling of `WebSocketDriver`, not of `LoopDriver`: the same 3-byte framing, a
  per-socket receive queue drained by `GetMessage`, no reliable-ack flow control (`MessagePort` is ordered
  and reliable). One `MessageChannel` carries every socket, multiplexed by a connection id, with the
  buffers transferred. It also carries the 3c relay for WebRTC peers unchanged.
- The worker is one server per realm, so its realm services (`Con`, `Sys`, `COM`, `Mod`, `NET`, `SV`, a
  host stand-in) still go through the registry *inside the worker*, filled by the worker composition root.
  That is what keeps 3a from converting `Mod`/`Console`/`Cvar`/`Cmd` (Phase 4). Code that runs in the worker
  must not touch `CL`: `Cvar.Command_f` and `Cmd` do through `getClientRegistry()` and need to tolerate its
  absence, and `Mod` reads `CL.state` only for a client-only listing.
- `ServerRuntimeServices.host` is `typeof Host`, which drags the client into the worker. It becomes a narrow
  interface (`version`, `speeds`, `ScheduleForNextFrame`, `noclip_anglehack`).
- `PlayerView.CalcRoll` is pure math that lives in `client/V.ts`; the worker cannot import that file, so
  the function moves to `shared/` and `V` re-exports it.
- The worker is a *non-dedicated* server for gating purposes (the simulation gate and the local player's
  `kick` wording) but has no `listen` of its own; `ServerHost`'s `dedicated` option is split in two
  questions if the code needs it (read `ServerHost` when starting step 4).

#### Phase 3a: steps

Each step leaves `npm test`, `npm run typecheck` and eslint green.

1. `ServerEngineAPI` instance in `server/ServerEngineAPI.ts`, the pieces it shares with the client in
   `common/GameApiSupport.ts`, contract type, `GameModule.Init`, callers and tests updated.
2. Make the shared server-side code worker-safe: the host stand-in interface, `CalcRoll` to `shared/`, `Cvar`
   and `Cmd` without a client, a boundary test that nothing in the worker's import closure reaches the client.
3. `ChannelDriver` with tests mirroring the `LoopDriver` ones.
4. Worker composition root and `ServerWorker.ts` entry, registered in `WorkerFactories.ts`; the control
   protocol (a typed request/response plus events).
5. `WorkerServerController` and the runtime switch; command-driven tick with a timer fallback.
6. Real-browser run in worker mode: new game, move, map change, stop, kill the worker.

#### Phase 3a: what shipped (2026-10-05)

The server of a browser game runs in a Web Worker when the page is opened with `?serverworker`; a server in the
page's thread is still the default. Reference doc: `docs/server-worker.md`. 1626 tests pass, `npm run typecheck`
is clean, `eslint source/engine` has 0 errors. Verified in Chromium 1234 headless (below).

- **`ServerEngineAPI` is an instance** (`server/ServerEngineAPI.ts`), owned by its `Server` (`sv.engineAPI`),
  built from `ServerDependencies.gameEdition`. The member surface is unchanged and `npm run typecheck` is clean for
  both games without touching them; the contract type is `Readonly<ServerEngineAPI>` of the instance.
  `GameModule.Init(serverEngineAPI | null)` takes it as a parameter (`null` on a page whose server is elsewhere: it
  only loads the module for the client). `GameFlavors`, `GameTrace` and `internalTraceToGameTrace` moved to
  `common/GameApiSupport.ts`, so the worker's import closure no longer contains `GameAPIs.ts` (menu, renderer,
  input). `ClientEngineAPI` stays static; its `SV.active` now reads `CL.serverController` and its world trace uses
  `CL.collision`. Behavior change: `gameFlavors` lists `shareware` when the data is not registered (the old
  `!COM.registered` test was on the cvar object and never true), and is computed when read instead of pushed once.
- **`ChannelDriver`** (`network/ChannelDriver.ts`) as designed, a sibling of the WebSocket driver. `NET` takes the
  list of drivers as a dependency (`createDrivers`), the page builds `[channel, websocket, webrtc]` for a worker.
- **Control plane**: `common/ServerWorkerProtocol.ts` (messages, `ControlLink`, the forwarded events),
  `server/ServerWorkerRuntime.ts` (requests in order, state mirror published before the answer, frame
  coalescing, fallback timer on `sys_ticrate`, host error versus crash), `client/WorkerServerController.ts` (page
  side; `stop()` shows the server as inactive at once). `ServerController` gained `init()`. Control messages and
  packets share one port by envelope, so the page transfers a single `MessagePort`.
- **Worker realm**: `bootstrap/createServerWorker.ts` (composition root, on the registry allowlist because it fills the
  registry of the worker's realm), `server/ServerRealm.ts` (the worker's `Host`: timing, scheduling, cvars),
  `server/ServerWorkerConsole.ts` (with capture), `server/PlayerRollView.ts` (+ `shared/PlayerRoll.ts`, `V.CalcRoll`
  delegates to it), `server/ServerWorker.ts` (entry, registered in `WorkerFactories.ts`, starts the navigation worker
  from its own factory list). `Host` works with `serverHost === null` and `registry.SV === undefined`; `Cvar`'s cheat
  check asks the controller. `PlatformWorker.postMessage` takes a transfer list.
- **Boundary test**: `engine-boundaries.test.mjs` pins the import closure of `ServerWorker.ts`: client code only through
  the four data classes the model loaders import (`GL`, `VID`, `Materials`, `Sky`).
- **Tests added** (about 100): channel driver, engine API, worker runtime, realm, console, controller, an end-to-end
  control plane over a real `MessageChannel`, cheat variables, identity commands.
- **Verified in Chromium** against the existing dev server (static host) with the rebuilt client: `?serverworker` boots,
  a worker is started, `map start` connects with signon 4 and 128 entities, walking moves the player, `map e1m2` changes
  level, `disconnect` stops the server, server time freezes with the menu open and resumes on close (identical to
  the in-thread mode, measured on `clientMessages.mtime`), `name`/`color` of signon reach the worker, ending the worker
  leaves the page alive, and the set of failed requests is the same as in in-thread mode. The Node dedicated build builds
  and boots a map. Not verified: Firefox, pointer lock and mouse look (untouched), a crash of the worker in a real
  browser (covered by unit tests only), WebRTC.

Decisions taken while doing it, for the developer to veto: control and data share one port; the flag is `?serverworker`
(a flag with a value would run as a console command); `init()` was added to the controller interface rather than
booting the worker from the launcher, so `Host.Init` awaits it at the point it awaits the game module.

Carried into 3b, in the order they bite:

- **Cvars and commands** (B5): nothing crosses yet. Server cvars are unknown on the page, archived values in the config
  (`sv_rcon_password`, `nav_*`, game cvars) are not applied in the worker, `status`/`god`/`give`/`kick` cannot be typed.
  The Phase 3 checklist item "changing server cvars from the console" stays open until this is done.
- **Savegames** (B6) and the **`view*`** commands: they say "not available yet" in worker mode.
- **Phase 1 leftovers**: `Host.noclip_anglehack` (the worker's `ServerRealm` sets it, the page reads it) and
  `getLocalOperatorName`.
- **`ClientEngineAPI.Traceline` with `includeEntities`** falls back to the static world without an in-thread server;
  the client needs its own `clipMoveToEntity` (ServerCollision's entity code needs `sv.area`).
- **Console colors** are dropped on the way from the worker (`ConsoleOutput.Print` takes a color, the worker console
  does not send it).
- **Roll cvars**: `PlayerRollView` registers `cl_rollspeed`/`cl_rollangle` in the worker with their defaults; they become
  shared cvars with the page's value winning when B5 lands.
- `registry.isDedicatedServer` is `true` inside the worker because the model loaders read it as "skip GL data"; it becomes
  a `loadRenderData` option in Phase 4.
- Flipping the default needs `?serverthread` (or the inverse flag) as the way back for debugging.

#### Phase 3b: what shipped (2026-10-05)

Single player with the server in a worker (`?serverworker`) now behaves like the in-thread server in everything
except hosting for others. 1700 tests pass, `npm run typecheck` is clean, `eslint source/engine` has 0 errors.
Reference: `docs/server-worker.md`.

- **Cvars (B5)**: `server/ServerCvarSync.ts` (worker end) and `client/ServerCvarMirror.ts` (page end), driven by
  `ServerController.attachConsole()`, which `Host.Init` calls once every page cvar exists, right before the
  configuration runs. Server-owned cvars are ordinary `Cvar`s on the page, shared ones keep the page's value, a
  change from the other side is never sent back, a refused change is put right by the worker's answer. `Cvar` publishes
  `cvar.registered` (documented in `docs/events.md`) and `Cvar.GetChangeBlock()` is the one place that decides
  read-only and cheat rules, used by the console and by the worker. The five sync guarantees are tests, run against a
  genuine second realm in a `worker_threads` worker (`test/server/server-cvar-realms.test.mjs`).
- **Commands**: the page registers stand-ins for the worker's commands (list in the `ready` message) that send the line
  over with the player's name. `ServerLocalConsole` runs it in the worker, and a command that asks to forward itself as
  the player (`ConsoleCommand.forward()`, hooked through `Cmd.forwardLocal`) runs for the local player, which is what
  forwarding does on a shared console. This replaced the plan's "forward unknown commands": stand-ins keep tab
  completion and `Cmd.HasCommand` honest.
- **Savegames (B6)**: `server/ServerSavegame.ts` holds the server's half (capture and restore, moved out of `Host`),
  `ServerController` got `saveState()`/`restoreState()`, `Host.Savegame_f`/`Loadgame_f` compose the file from both halves.
  The file format is unchanged; the old save/load tests, including the real id1 round trip, run through the in-thread
  controller.
- **Phase 1 leftovers**: `Host.noclip_anglehack` travels as a `noclip-anglehack` message (`ServerRealm` notifies);
  the operator name for kicks rides along with each forwarded command; `view*` commands use `getViewthing()` and
  `setViewthingFrame()` and are registered only with a client.
- **Also done**: `ClientEngineAPI.Traceline` with `includeEntities` works without an in-thread server
  (`ClientCollision.clipMoveToEntity`, the server's narrow phase over a stand-in); console colors cross the boundary;
  the roll cvars are shared cvars now.
- **Bug found by the browser check, fixed with a regression test**: `ServerHost.status` took `this.sv.con.Print` as a
  bare function, which crashed the worker as soon as the console is a real object.
- **Verified in Chromium** (worker mode and, as regression, in-thread mode, same script, same results): no "Unknown
  variable" for server cvars at boot, `sv_gravity 111` reaches the running server, `status`, `god` refused without and
  accepted with `sv_cheats 1`, `noclip` sets the view hack on the page, `save` then walking then `load` puts the player
  back, a read-only cvar stays read-only. Not verified: Firefox, `viewmodel` in a browser (needs a map with a viewthing;
  unit-tested), pointer lock.

**Deviation: the worker is not the default yet.** The plan flips it in 3b, but a page whose server is in the worker
cannot host for other players until 3c relays the WebRTC peers, so flipping now would remove a feature that works
today. 3c makes the flip right after the relay, with `?serverthread` as the way back.

Found, for 3c: with the page rendering in software GL the local player's ping reads about 300 ms with the worker
against 75 ms in-thread (it is measured over the protocol's ping messages, which now cross a thread boundary and are
read once per page frame). The latency measurement of 3c has to separate frame time from the hop before deciding on tuning.

#### Phase 3c: what shipped (2026-10-05)

The worker is the default for single player and for hosting. `?serverthread` keeps the server in the page's thread
for debugging; it is also what a browser without `Worker` gets. 1718 tests pass, `npm run typecheck` is clean,
`eslint source/engine` has 0 errors. Reference: `docs/server-worker.md`.

- **WebRTC relay (B2, first implementation)**: `client/PeerRelay.ts`. The page's network layer accepts the peers as
  before, each gets a socket on the channel to the worker, packets are carried every 8 ms with reliable and unreliable
  kept apart, and a drop on either side drops the other. It also starts and stops `listen` with the server's state, as
  the server host does in the page's thread. Channel transfer (the optimization) was not built, as planned.
- **Hidden tab**: `ClientHost.Frame` holds the simulation gate closed while `document.hidden`. A game for several players
  is not affected (the gate only matters below multiplayer capacity). This applies to the server in the page's thread too.
- **Default flipped** in `main-browser.ts`; the advertised server info for the master server now comes from the controller
  (it read `sv.svs`, which a page with a worker does not have, so no session was registered).
- **Found by the real-browser run and fixed**: that `serverInfo`, `ClientEngineAPI.DetermineStaticWorldContents` (read `SV`,
  crashed the host page when a client game's code asked after a player left; it uses `CL.collision` now, and
  `engine-boundaries.test.mjs` fails if `GameAPIs.ts` reaches for `SV` again), and a worker crash lost its stack (the
  stack of the worker now travels with the crash message).
- **Measured** (Chromium 1234 headless, software GL, E1M1, idle player): command sent to reply seen 33.1 ms mean in the page's
  thread, 38.4 ms with the worker, p95 37.4 against 67.3 ms (one extra frame in about one in ten); heap after a collection
  95.0 MB in the page's thread, 117.7 MB with the worker (page 43.9 plus worker 73.0 plus navigation worker 0.9). Per B4 these
  inform tuning and do not gate; with the frame at 33 ms there is nothing to tune, a GPU makes the frame a third of that and
  the extra frame a smaller absolute cost. The "before and after `loadRenderData: false`" comparison was not made: the worker
  has never had render data, there is nothing to switch.
- **Verified in Chromium**: a guest in a second browser context joins a game hosted from the worker over a real WebRTC
  connection through a local master server (`wrangler dev`): both see the same server time, the guest walks, the host sees
  the guest's entity move, the guest leaves and the host drops to one player; server time freezes while the page is hidden
  and resumes; the second tab starts the map it finds in the shared cache (conditional requests only, no downloads);
  ending the worker leaves the page alive; the earlier checklist (new game, level change, save and load, console
  variables and commands, menu pause) runs unchanged by default. Not verified: Firefox, pointer lock and mouse look (live
  test by a human is still needed), a worker killed from outside.

Found by the developer's live test after 3c (2026-10-06): human playtest in Chromium and Firefox worked, a local player
sees about 22 ms of latency, which is good enough. `changelevel` and `restart` were unknown commands in worker mode, because
a game's `ChangeLevel()` and a dead single player append them to the *worker's* command buffer, where the session commands
(page-only) did not exist. Fixed with a `session-request` control message: the worker registers the two commands, they hand
the request to the page, and `ClientHost.HandleSessionRequest` runs the page's own commands (see "Level changes and
restarts" in `docs/server-worker.md`). No game code changed. Checked: the only server-side game code that appends
console text is that `restart` (and `ChangeLevel()`); every other `AppendConsoleText` caller in `id1` and `hellwave` is client
or menu code that runs on the page's console.

Left for Phase 4: the registry inside the worker's realm, `registry.isDedicatedServer` as the loaders' "no GL" flag,
`Host` and the other static facades on the page.

### Phase 4: Registry removal for the client side; delete the registry

- Client runtime parts as instances: `CL`, `R`/`GL`/`PostProcess`, `S`, `IN`, `Key`, `M`, `SCR`,
  `V`, `Draw`; `ClientEngineAPI` as an instance.
- `createBrowserClient` composition root replaces `main-browser.ts`'s launcher.
- Delete `registry.ts`, `getCommonRegistry`/`getClientRegistry`, `isDedicatedServer`,
  `isInsideWorker`, `withMockRegistry` and the ESLint allowlist.
- Update `docs/` and the instruction files (`code-style-guide.instructions.md` "Registry and Global
  Variables", `typescript-port.instructions.md` "Initialize the registry properly",
  `unit-tests.instructions.md` mock registry pattern, `CLAUDE.md`) in the same phase, game-agnostic
  per `source-directories.instructions.md`.

#### Phase 4: forks settled before starting (2026-10-06)

Decided with the developer:

1. **Hybrid scope.** Instances for the coupling hubs and what tests have to replace: `Con`, `Mod`, `Host` (dissolved,
   not converted), `CL` and `M`. `R`, `GL`, `S`, `IN`, `Key`, `Draw`, `SCR` and `V` wrap one-per-tab device resources
   (one GL context, one audio context, one input source) and stay static classes imported directly. A second
   renderer has no use case and `R` alone is 158 static members over 3.5k lines of hot paths. This deviates from A1's
   "state moves to instance fields" for those classes only; the registry still goes away completely.
2. **`ClientEngineAPI` becomes an instance** like `ServerEngineAPI` did in 3a: the same member surface, so a game that
   reaches it only through the `Init`/constructor parameter compiles unchanged (Phase 0 finding 7: none uses it as a
   value). The contract type in `shared/GameInterfaces.ts` changes to `Readonly<ClientEngineAPI>` of the instance.
3. **Tests are converted to `.ts` as the module they cover is converted**, and `tsconfig.json` starts type-checking
   them (Track G's first half). `unit-tests.instructions.md` says "all files are ESM `.mjs`"; it is updated when the first
   `.ts` test lands. Only `.test.ts` files are included, so the conversion is incremental and the `.mjs` tests keep
   running unchanged until their module's turn.

Survey for the plan (2026-10-06, after Phase 3): 64 files import `registry.ts` (27 `client`, 11 `common`, 10
`client/renderer`, 5 `common/model/loaders`, 5 `client/menu`, 2 `common/model`, 2 `bootstrap`, 2 in `engine/`); prolog
members by frequency `Con` 31, `CL` 29, `Host` 26, `R` 19, `COM` 19, `S` 11, `M` 10, `NET` 9, `SCR` 8, `Key` 8, `V` 7,
`Draw` 7. `registry.isDedicatedServer` has 36 reads, 15 in `Host`, 12 in the model loaders, 4 in `Console`/`Cmd`/`Mod`/`R`.
Test files that touch the registry: about 80 of 130.

**The real work is the common-to-client edges, not the facades.** `common/` is shared by the page, the dedicated server and
the server worker, and the worker bundle must not contain client code (`engine-boundaries.test.mjs`). Five `common/` files
still reach the client through the registry: `Console` (`CL`, `Draw`, `IN`, `Key`, `SCR`: it draws itself and
captures keys), `Cmd` (`CL`, for forwarding), `Cvar` (`CL.serverController` and `CL.cls.serverInfo` for the cheat check),
`Mod` (`CL`, for a client-only listing) and `Host` (everything). Deleting the registry means inverting those edges: the
common service owns a narrow interface and the client installs an implementation of it, as `Cmd.forwardLocal` already does.
That makes the rule "nothing under `common/` imports `client/` or the registry" enforceable by the boundary test, which
is what keeps a worker bundle clean from now on.

##### Open question for 4b: how a static facade reaches an instance

`R`, `Key`, `SCR` and the other facades that stay static still need `Con`, `CL`, `Mod` and `M` once those are instances.
A constructor cannot hand them over (a static class has none), and passing "the engine" around is the registry again.
Recommended: each converted service is a class whose **default export is the one instance of its realm**
(`export default new Console()`), constructed without dependencies and given what it needs through `init(deps)` from the
composition root. Importers use it by plain ES import, so there is no lookup table and no `registry.frozen`; tests either
construct a fresh instance with fakes (`new Console()` + `init(fakes)`) or call `init` on the shared one in a
`beforeEach`. The cost is a module-level singleton for those five, which is what `Cvar` and `Cmd` already are in this plan
(A1: realm singletons). The alternatives are (b) making every facade an instance too (the "Full instances" option, rejected
above) or (c) leaving the five static (the "direct imports" option, rejected above). Resolved in 4b step 5: `client/PageServices.ts`, see "Phase 4b, steps 5 to 8".

#### Phase 4 steps

Each step leaves `npm test`, `npm run typecheck` and eslint green and the game playable, and stops for a go-ahead.

**4a, `common/` free of the registry and of the client (the worker's realm becomes registry-free), done, see "Phase 4a: what shipped"**

1. Test groundwork: `test/physics/fixtures.mjs` to `fixtures.ts` with typed factories, `tsconfig` includes
   `test/**/*.test.ts`, `package.json` test globs and the Dockerfile `test` stage check (`test-glob-coverage`,
   `dockerfile-fixture-sync`), `unit-tests.instructions.md` updated.
2. `isDedicatedServer` out of the model loaders: `Mod` takes a `loadRenderData` option from its composition root and
   hands a `ModelLoadContext` to the loaders (12 sites: BSP29/38, AliasMDL, SpriteSPR, WavefrontOBJ, `QSMatLoader`).
3. `Console`: an interface for what it needs from the client (`ConsoleView`: draw, key destination, screen update, the
   in-game flag) that the client installs; `Cmd`, `Cvar` and `Mod` the same for their one client edge each
   (`ServerController` for the cheat check, a client model listing hook).
4. `Host` is not touched yet. `WorkerFramework`'s lean registry goes (the navigation worker gets its services the way
   `createServerWorker` hands them over), `GameModule` and `Com` lose their prologs.
5. Done when: no file under `source/engine/common/` (except `Host.ts`, which 4b removes), `network/`, `server/`,
   `bootstrap/createServerWorker.ts` or `createDedicatedServer.ts` imports `registry.ts`, and a boundary test says so.

**4b, the client runtime and `Host` (the allowlist shrinks to the facades that stay static), done, see "Phase 4b: what shipped"**

1. `Host` dissolves: frame timing and the scheduler into one small clock/scheduler class shared by `ClientHost`,
   `ServerRealm` and the dedicated server; config writing and the savegame commands to `ClientHost`; the dedicated server
   uses `ServerRealm`. The 77 reads of `Host.realtime`/`Host.frametime` become reads of that clock.
2. `CL` and `M` as instances (default-export pattern above, if confirmed), then `ClientEngineAPI` as an instance in
   `client/ClientEngineAPI.ts` (it currently lives in `common/GameAPIs.ts`, which imports the menu, renderer and input).
3. `createBrowserClient` composition root replaces the launcher in `main-browser.ts`.
4. Done when: only the static facades (`R`, `GL`, `S`, `IN`, `Key`, `Draw`, `SCR`, `V` and their helpers) read the registry.

**4c, delete the registry**

1. The remaining facades import each other directly. Cycles that matter at module evaluation time are broken by moving
   code, not by moving imports (A3.4).
2. Delete `registry.ts`, `getCommonRegistry`/`getClientRegistry`, `registry.frozen`, `isDedicatedServer`, `isInsideWorker`,
   `withMockRegistry` and the ESLint allowlist; update `code-style-guide`, `typescript-port`, `unit-tests` instructions,
   `CLAUDE.md` and `docs/` (game-agnostic).
3. Real-browser verification (the full 3c checklist) and the live pointer-lock / mouse-look test, which headless
   Chromium cannot do.

Risks: `Console` and `Host` are on the critical path of every frame and of boot order (config runs after cvars exist, the
worker handshake is awaited at a specific point), so each of them gets a browser run before the next one starts;
module-evaluation order changes when imports replace registry lookups, which is the failure mode that shows up only at
boot, so 4c ends with a cold-start run of both builds.


#### Phase 4a: what shipped (2026-10-07, not committed: waiting for the developer's test and review)

Done-condition met: nothing under `source/engine/common/` (except `Host.ts` and `GameAPIs.ts`, which 4b removes),
`network/`, `server/` or `bootstrap/createServerWorker.ts` imports `registry.ts`, pinned by
`test/common/engine-boundaries.test.mjs`. The server worker no longer fills a registry at all, and the import
closure of its entry only reads the registry in the client data classes model loading drags in. The ESLint ratchet went from
63 to 47 files, `registry.isDedicatedServer` reads from 39 to 26 (19 of them in `Host`, 2 in `R`, the rest in launchers),
1752 tests pass (was 1727), `npm run typecheck` is clean, `eslint source/engine` has 0 errors.

- **Models**: `ModelLoadContext` (`files`, `con`, `loadRenderData`) is handed to every loader through its constructor,
  and to `QSMatLoader`/`BSPXLoader` as an argument. `isDedicatedServer` is gone from all of them. `Mod` is an instance
  (`export class Mod`, default export `new Mod()`), initialized with `Mod.Init({ files, con, loadRenderData, keptClientModels })`
  by the composition root of the realm.
- **Console split**: `common/Console.ts` is the output side only (text buffer, `Print*`, capture, `ClearNotify`, the
  `con_notifytime` variable), an instance with `Init({ clock, developer })` and `useDelegate()`. A server worker
  routes it to its `ServerWorkerConsole`, so everything shared code prints there reaches the page. `client/ConsoleOverlay.ts`
  (static) is what draws it: `isOpen`, `forcedup`, `vislines`, the toggle and message-mode commands, `DrawConsole`,
  `DrawNotify`, `DrawInput`. Consumers were moved over (`SCR`, `Key`, `IN`, `V`, `Sys`, `ClientConnection`, `Host`, `GameAPIs`).
  `Con` and `Mod` are imported directly everywhere now, 23 prologs were deleted.
- **Hooks instead of registry reads in shared singletons** (`Cmd`, `Cvar`, `W`, `GameModule`, `WorkerManager`,
  `PlatformWorker` stay realm singletons, as A1 says; the composition root of the realm sets what they need):
  `Cmd.files` (`exec`, `stuffcmds`), `Cmd.forwardToServer` (installed by `ClientHost.Init`, the old `cmd`/forwarding body
  moved to `ClientHost.ForwardToServer`; a realm without it swallows forwards, which is what the dedicated flag did),
  `Cvar.serverState` (the cheat rule; client reads its controller, a server reads itself), `W.files` (set by `COM.Init`
  and the worker roots), `GameModule.com`, `WorkerManager.services`, `PlatformWorker.onCrash`.
- **`WorkerFramework`** (the navigation worker's realm) has no registry any more: local `urls`, `W.files`, console
  delegate, `Mod.Init` with `loadRenderData: false`. `Materials.ts` creates its headless renderer stand-in at module
  load instead of waiting for `registry.frozen`.
- **Tests**: `tsconfig.json` includes `test/**/*.test.ts` and `test/support/**`. Converted to TypeScript: `bsp29-loader`,
  `bsp38-loader`, `bspx-loader`, `model-cache` (a `Mod` instance per test, no global state to restore), `console` (new,
  per-instance), `console-overlay` (new). New: `cmd-forward`, `cvar-change-block`, plus tests for the console delegate and
  `ClientHost.ForwardToServer`. New typed helpers in `test/support/` (`modelContext.ts`; `consoleBridge.ts`, which makes the
  shared console print to a mocked `registry.Con` for the tests that still mock one, and goes with the registry).
  **Deviation from decision 3**: tests whose only change was plumbing (the physics, savegame, workers, key, in, scr and
  client-host tests) stayed `.mjs` and were edited in place; converting them would have added casts and no checking.
  They convert when their own module does (4b/4c).
- **Behavior changes, all small**: `con_notifytime` exists in every realm as before; the dedicated server keeps it.
  `ConsoleCommand.forward()` in a realm with neither a local server nor a client returns `true` without doing anything, as
  before for the dedicated flag. `cmd <command>` still sends the whole line (`cmd status` reaches the server as `cmd status`,
  which the server ignores): that was already so and is untouched; worth a look when `ClientHost` is split further.
- **Verified in Chromium** (scratch builds, no commit): page with the server in a worker and with `?serverthread`: new
  game, `status`, `god` refused without cheats, `sv_gravity` set and read back, `con_notifytime` read back, an unknown
  command, `echo`, `changelevel e1m2` and `restart` (both land on the right map with signon 4), the drop-down console and
  its colors render (screenshot); a page connected to the scratch dedicated server over WebSocket: `status` is forwarded
  and answered, `say` works; the dedicated server boots and spawns a map from a fresh build; both production builds
  compile. The only failed requests are the three missing assets that were already missing (`conback.png`,
  `concharslarge.png`, `beam.mdl`). Not verified: pointer lock and mouse look (no change expected, but a live test is
  still wanted), Firefox, the navigation worker with a real path request on the new `WorkerFramework`.

#### Memory check after 4a (2026-10-07)

The developer saw about 1.2 GB where it used to be about 300 MB on E1M1. Measured against the commit before this
work (`9abb71b`, development builds of both, same data) in headless Chromium and in the system Chrome with a real GPU
(`/usr/bin/google-chrome`, headed), process tree summed by proportional set size, JS heaps from CDP after a forced GC:

| E1M1, idle | page heap | worker heap | tab renderer | all Chrome processes (PSS) |
| :--- | :--- | :--- | :--- | :--- |
| before (server in the page) | 60 MB | none | 214 MB | about 655 MB |
| now (server in a worker) | 60 MB | 73 MB | 308 MB | about 780 MB |

So the worker costs about 94 MB of renderer memory, which is the second copy of world and models that Phase 3 expected
(it was 22 MB of JS heap in the Phase 3c measurement; the rest is typed-array backing stores). No growth: flat over 10 minutes
of walking, over three `changelevel`s and over four `map` loads; warm caches, an attached DevTools session (scripts, network,
console) and a running audio context change nothing. A heap snapshot of the worker (78 MB) is mostly world geometry kept as
objects: `Vector` instances and their buffers about 30 MB, `ClipNode` 8 MB, `Plane` 4 MB, element arrays 16 MB.

The 1.2 GB did not reproduce here, so it is something outside these runs (how it was measured, a long session, a mod, other
tabs or the dev tooling: the running `vite build --watch` alone holds 2 GB). Open: which number it was (Chrome task manager
"memory footprint" of the tab, or the renderer, or the whole browser) and in which session. If the worker's share needs to
shrink, the lever is the world geometry: store vertexes, clip nodes and planes in typed arrays instead of object graphs, which
B7 asked of the loaders anyway.

#### Phase 4b, step 1a: the client state is imported, not looked up (2026-10-07, not committed)

First slice of "`CL` without the registry", chosen after measuring the import graph: 535 of the roughly 700 reads of `CL` were
`CL.state` (434) and `CL.cls` (101), and those two are plain module singletons (`clientRuntimeState`, `clientStaticState` in
`ClientState.ts`). Reading them through `registry.CL` was two lookups where one import binding does, in the per-frame code of
`R`, `SCR`, `V`, `IN`, `Key`, `ClientEntities`, `ClientInput`, the server message handlers and the renderers.

- 21 client files and `GameAPIs.ts` now read `clientRuntimeState`/`clientStaticState` directly. `Host.ts` and `Materials.ts`
  stay on the registry on purpose: `Host` is shared with the dedicated server, `Materials` is in the server worker's import
  closure, and neither may import client state. `CL.state`/`CL.cls` still exist on the facade, they are the same objects.
- Importing the state closes a cycle (`ClientState` constructs `ClientEntities` and `ClientMessages`, which read the state).
  `ClientRuntimeState` therefore creates them on first use through getters (with setters, so a test can install its own),
  and no module builds anything of another module while it is being evaluated.
- Tests that mocked `registry.CL.state`/`.cls` now set the members on the real objects through `test/support/clientState.ts`
  (`useClientStateOf(mock)`, restores afterwards, understands getter-only members and live getters); `withMockRegistry` does it
  for every test that passes a `CL`. 17 test files were adapted, 2 of them in id1 (`gib-edict-handler`, `bubble-edict-handler`,
  uncommitted changes inside the submodule).
- 1752 tests pass, typecheck and lint clean, and the page was run again in Chromium (worker server: new game, status, god,
  cvar sync, `changelevel`, `restart`, rendering of E1M2 with HUD and entities).

What is left of `CL` after this is its own API: `serverController` (29 reads), `pmove` (18), `collision` (12), the client cvars
(about 60) and the methods (`SetConnectingStep`, `Disconnect`, `Connect`, `SendCmd`, ...). Importing `CL` itself still makes a
36-file cycle, because `CL.ts` builds a `Pmove`, a `ClientCollision` and the connection collaborators while it is being
evaluated, and those reach the server collision code. The next slices, each its own step: move `serverController`, `pmove` and
`collision` onto the state objects, the cvars into a leaf module, make `ClientConnection`/`ClientLifecycle` call each other
instead of going back through `CL`, then `CL` becomes importable.

#### Phase 4b, step 1b: `CL` is imported (2026-10-07, not committed)

`CL` has no registry readers left in the client and `GameAPIs.ts`; only `Host.ts` (shared with the dedicated server) and
`Materials.ts` (in the server worker's import closure) still look it up, through `CL`'s compatibility accessors. It stays a
static class: moving it to an instance would not have changed a single lookup, and the point was fewer of them in the
per-frame code, not a different shape.

- **Moved out of `CL`** into modules that import nothing of the client above them: the console variables (`ClientCvars.ts`,
  `clientCvars.sensitivity`), the predicted `Pmove` and the client's static-world collision (`ClientPhysics.ts`,
  `clientPmove`, `clientCollision`), and the control plane to the local server (`clientStaticState.serverController`,
  installed by the launcher). `CL.serverController` stays as an accessor for `Host`.
- **`CL.ts` builds nothing while it loads.** The demo player and the connection are created by `CL.Init()` (or on the first
  `CL.connection` read), and `CL.cls`/`CL.state`/`CL.moduleEventBus` are accessors, because this module is part of a cycle
  with the one that creates the state. `ClientLifecycle` resets the movement variables instead of replacing the `Pmove`.
- **Import graph**: the cycle that importing `CL` creates is the 17 files of the client core (`CL`, the `Client*` modules,
  `Chase`, `Key`, `ConsoleOverlay`, `Sound`, `ClientPhysics`, `GameAPIs`). The 58-file cycle through `R`, `Host` and `M`
  from the survey did not materialize because `Host` and `Materials` still go through the registry. Everything in the cycle is
  safe to load in any order: nothing in it constructs anything of another module while it is being evaluated.
- **Tests**: `useClientStateOf(mock)` also applies a mocked `pmove`, `collision`, `serverController`, cvars and the methods of
  `CL` (it patches the real objects and restores them); `withMockRegistry` calls it for every test that passes a `CL`.
- **Verified**: 1752 tests, typecheck and lint clean; in Chromium the development build (server in a worker and `?serverthread`)
  and a production build both run the whole sequence (new game, status, god, cvar sync, changelevel, restart); the dedicated
  server builds and spawns a map.

What reads `CL` now is its API: `SetConnectingStep`, `Disconnect`, `Connect`, `SendCmd`, `ParseServerMessage`, ... and
`Host.ts`/`Materials.ts`. Next in 4b: `R` (the other big hub, 19 readers), `M`, then `Host` itself.

#### Phase 4b, step 2: `R` is imported (2026-10-07, not committed)

The renderers, `SCR`, `V`, `Chase`, `ClientEntities`, `ClientLegacy`, `ClientHost`, `ClientServerCommandHandlers`,
`NavigationDebug` and `GameAPIs.ts` import `R` instead of looking it up. Still on the registry on purpose: `Materials.ts` and
`Sky.ts` (in the server worker's import closure, they keep their headless stand-in) and `Host.ts`.

- One load-order hazard surfaced and was fixed: `R` builds a lightmap array from `LIGHTMAP_BLOCK_SIZE` while its class is
  being set up, and that constant lived in `BrushModelRenderer`, which imports `R`. The lightmap constants are in
  `renderer/LightmapAtlas.ts` now, which imports nothing.
- The client core cycle grows from 17 to 30 files (the renderers, `Draw`, `ClientHost`, `NavigationDebug`, `Host`), all of them
  load-order safe for the same reason as before: nothing builds anything of another module while it is being evaluated.
- Tests: `useRendererOf(mock)` (`test/support/renderer.ts`) sets a mocked renderer's members on the real `R` and restores them;
  applied where a test installed `registry.R`, and in the `client-host` and `client-server-command-handlers` helpers.
- 1752 tests, typecheck and lint clean; the page runs the whole sequence in the development build (worker and `?serverthread`)
  and in a production build, and E1M2 renders as before (screenshot).

Registry importers in the engine: 38 files on the allowlist now (from 47). Left in 4b: `M`, `Host`, then the realm services (`COM`, `NET`).

#### Phase 4b, steps 3 and 4: `M` is imported, `Host` is split (2026-10-07, not committed)

**`M`** (the menu): `ClientHost`, `IN`, `Key`, `SCR`, `Sys`, `MenuItem`, `MenuPage` and `GameAPIs.ts` import it. Two load-order
hazards were removed instead of worked around: `MenuStack` needed the menu only to set `entersound`, so it takes a callback now
(`new MenuStack(onNavigate)`, the menu passes `() => { M.entersound = true; }`) and no longer imports the menu, which lets the
menu build its stack at load again; and `ClientEngineAPI.Menu` listed the menu item and page classes while its class was being
set up, so those are getters now (read on use, game code is unchanged).

**`Host`** no longer coordinates anything; what it did moved to where it belongs:

- `common/Host.ts` is the shared state of the main loop and nothing else: clock (`realtime`, `frametime`, `framecount`), the
  scheduler, the loop's cvars (`InitLocal(commitHash, dedicated)`), writing the configuration (the files and the client's key
  bindings come in through `Host.files` and `Host.configExtras`), `Error`/`HandleCrash` (the process-specific part is
  `Host.recoverFromError`/`Host.quit`), `BeginFrame(now)` and the commands every process has. It imports neither the client nor
  the server runtime (a boundary test says so) and is imported directly by everything that reads the clock.
- `client/ClientHost.ts` is the page's boot (`Boot`), `Shutdown`, `RunFrame`, `InitLocal`, `RecoverFromError`, `EndGame`,
  `Quit_f`/`ForceQuit`, save and load (`Savegame_f`/`Loadgame_f`), the `view*` commands and the `name`/`color` router
  (`NameCommand`/`ColorCommand`). The local server is found through `Host.serverHost`, the page no longer takes `SV` out of
  the registry anywhere.
- `bootstrap/DedicatedHost.ts` is the same for a dedicated server (`Init`, `Frame`, `Shutdown`, `ForceQuit`, commands), built
  by `createDedicatedServer` with everything it needs; `DedicatedSys` drives it through a small `DedicatedHostControls`.
  Fixes a latent crash: an error on a dedicated server used to call `CL.Disconnect()` on a client that does not exist.
- 24 client files import `Host` now. `Sky.ts` stays on the registry (server worker import closure).

Tests: `useMenuOf(mock)` and `useHostOf(mock)` (`test/support/menu.ts`, `host.ts`) do for `M` and `Host` what the other helpers do for the
state; `withMockRegistry` applies the mocked `Host`; the tests of `EndGame`, `Savegame_f`, `Loadgame_f` and the identity commands call
`ClientHost`; the host alert test installs the page's recovery hook the way `Boot` does.

Verified: 1753 tests, typecheck and lint clean; the page in the development build (worker and `?serverthread`) and in a
production build; save then load (`hosttest`) and `writeconfig` (the stored `config.cfg` has the 57 bind lines and `configready`);
a fresh dedicated server build boots through `DedicatedHost`, spawns a map and a page connected to it can `name`, `color`, `say` and `status`.

Registry importers in the engine: 31 (from 38). `registry.isDedicatedServer` has 7 mentions left (`R`, the launchers and the registry itself).
What reads the registry now is the static client facades (`S`, `SCR`, `V`, `Key`, `IN`, `Draw`), the realm services `COM`, `NET`, `Sys`,
`ClientEngineAPI`, the two launchers and the worker-closure files (`Materials`, `Sky`).

#### Phase 4b, steps 5 to 8: the facades, the page's services, `ClientEngineAPI` and the composition root (2026-10-07, not committed)

4b's done-condition is met and a little more: no client module reads the registry any more. What still imports it is
`bootstrap/createBrowserClient.ts` and `createDedicatedServer.ts` (they fill it), `main-dedicated.ts` (a type) and the two data
classes the server worker loads, `Materials.ts` and `Sky.ts`, which keep looking up the renderer, the client state and `Host`
for their headless stand-in. The ESLint ratchet is at 5 files (from 31), `registry.isDedicatedServer` is read nowhere.

- **Static facades** (`Draw`, `IN`, `Key`, `S`, `SCR`, `V`): imported directly by every client module, 28 prologs gone. They stay
  static classes, as decided in fork 1. The client core import cycle grew accordingly; it stays safe to load in any order
  because nothing builds anything of another module while it is being evaluated (the browser runs below confirm the cold start).
- **The page's services** are the answer to the open question for 4b ("how a static facade reaches an instance"):
  `client/PageServices.ts`, a leaf module with `import type` only, exports live bindings `com`, `net`, `engineApi`, `urls` and
  `buildConfig` and an `installPageServices()` that the composition root calls once. Importers use them by plain ES import
  (`com.LoadFile(...)`, `net.message`), tests install fakes with the same function and get a restore function back. This is the
  default-export pattern of `Con`/`Mod` for services that cannot be built without the launcher's inputs (`COM` and `NET` are
  constructed per realm: the page, the dedicated server and the server worker each have their own, so the classes stay
  constructor-injected). `GL.ts` is in the server worker's closure and now loads `PageServices.ts` (no runtime imports there);
  the boundary test lists it.
- **`Sys`** is the static client class, imported directly; `R` imports it too. Its `window.registry` debug hook moved to the
  composition root, see below.
- **`ClientEngineAPI` is an instance** (`client/ClientEngineAPI.ts`), built on `CommonEngineAPI` (`common/CommonEngineAPI.ts`, takes
  `edition: () => GameEdition` like `ServerEngineAPI`, so `registered` and `gameFlavors` are read on use instead of being
  pushed by a `com.ready` listener). `common/GameAPIs.ts` is gone. Same member surface: a game that reaches it through the
  `Init`/constructor parameter compiled unchanged (`npm run typecheck` over `id1` and `hellwave` is clean); the contract
  types in `shared/GameInterfaces.ts` and `shared/ClientEdict.ts` are `Readonly<ClientEngineAPI>` / `ClientEngineAPI` of the
  instance. The engine hands it on through `PageServices.engineApi` (`ClientLifecycle`, `ClientServerCommandHandlers`,
  `ClientEntities`). `Draw` no longer asks the game API for a palette color: `W.IndexToRGB`.
- **Composition root**: `bootstrap/createBrowserClient.ts` builds `COM`, `NET`, the server (worker or `?serverthread`), the
  engine API, installs them, fills the three registry members `Materials`/`Sky` still look up, and starts `Sys.Init()`.
  `main-browser.ts` is a thin launcher like `main-dedicated.ts` (`index.html` is unchanged).
- **Dead code removed on the way**: the `isDedicatedServer` guards in `R.Init`/`R.InitTextures` (the dedicated server never
  calls them).
- **Debug handle renamed**: `window.registry` is now `window.engine` (`CL`, `COM`, `Con`, `ConsoleOverlay`, `Host`, `Mod`, `NET`,
  `Sys`, `V`, `Key`, `S`, `Draw`, `R`, `M`, `SCR`, `IN`, `SV` which is `null` unless `?serverthread`). `docs/browser-verification.md`
  and the `browser-ui-verification` skill are updated; plans and personal notes that mention `window.registry` are history.
- **Tests**: `test/support/facades.ts` (`facades.Key = mock` patches the real facade, assigning the real one back restores),
  `pageServices.ts` (the same for `COM`/`NET`/`urls`/`buildConfig`) and `clientEngineApi.ts` keep the existing tests' shape while
  the registry still exists; 14 tests moved from `registry.<facade>` to `facades.<facade>`, 19 from `registry.COM/NET/urls`
  to `pageServices`. Mocks are patched onto the real facade, so state a facade changes is read back from the facade, not from the
  mock (three tests needed that). New: `page-services.test.ts`, and the boundary test now pins "the client reads the registry
  only in `Materials` and `Sky`" and "`common/` does not import it". 1757 tests plus 8 new, typecheck and lint clean.
  The flaky `MessagePortEndpoint` ordering test failed once in a full run and passed in 5 reruns; it is unrelated.
- **Verified in Chromium** (headless, software GL): the development build with the server in a worker, with `?serverthread`, and
  a production build served next to the game data: main menu, new game, E1M1 renders with HUD (screenshot), `status`, `god`
  refused without cheats, menu open holds the world and closing it resumes, `changelevel`, `map`, `save`/`load`, `disconnect`.
  The only failed requests are the three assets that were already missing. A fresh dedicated build boots and spawns E1M1. Not
  verified: pointer lock and mouse look, Firefox, multiplayer (WebRTC and WebSocket) after this step, sound output.

Left for 4c: `Materials` and `Sky` (they need a way to get the renderer and the client state without importing the client, or a
split of the data class from the render hooks), the registry itself, `createDedicatedServer`'s fill of it, `isDedicatedServer`,
`withMockRegistry` and the tests that still mock a registry, and the instruction files that describe the registry pattern.

#### Phase 4c: what shipped (2026-10-08, not committed)

`source/engine/registry.ts` is deleted, together with `getCommonRegistry`/`getClientRegistry`, the `registry.frozen` event,
`isDedicatedServer`, `withMockRegistry` and the ESLint allowlist. Nothing under `source/` imports it, and a boundary test says
so (`registry.ts`, `registry.frozen` and the getters may not appear anywhere under `source/engine/`).

- **`Materials` and `Sky`** (the data classes the model loaders drag into the server worker) read the renderer and the client
  state from `client/renderer/RenderContext.ts`, a leaf module without run-time imports: live bindings `renderer` (a headless
  stand-in until the page installs `R`) and `clientState`, and `installRenderContext()`. `Sky` imports `Host` directly.
  The worker's closure gained that one file and lost its registry readers.
- **Composition roots** no longer fill anything: `createDedicatedServer` and `main-dedicated` return nothing, `createBrowserClient`
  installs the page services and the render context and then runs the loop. The dedicated server's `urls` and the page's
  `WebSocket` are plain arguments of `NET`/`COM`.
- `CL.serverController` (an accessor for `Host`, no reader left) is gone; the page reads `CL.cls.serverController`.
- **Tests**: one helper, `test/support/engineMocks.ts`, replaces `registry` in 48 test files (and the `facades.ts`/`pageServices.ts`
  of 4b): assigning to a facade patches the real one, the page services are installed as they are assigned, the render context
  gets the mocked renderer, and `CL`/`Host`/`M`/`R`/`Con`/`SV` are held for the `use...Of` helpers and `consoleBridge`.
  `withMockRegistry`/`defaultMockRegistry` are `withMockEngine`/`defaultMockEngine`, the `registry*` fixtures `mocked*`. 1757 tests.
- **Docs and instructions** (game-agnostic): `code-style-guide` ("Reaching Other Modules" replaces the registry rules, in
  `.github/instructions/` and `docs/`), `typescript-port`, `unit-tests` ("Mock Pattern"), `copilot-instructions`, `workers`,
  `graphify` caveats, `docs/events.md` (no `registry.frozen`), `docs/server-worker.md`, `docs/menu-system.md`.
- **Verified in Chromium** with the development build (worker, `?serverthread`) and a production build: the full 4b sequence
  again, plus E1M5 with its sky (screenshot: sky and materials draw through the render context) and E2M1 and E4M1 loads without
  errors. A fresh dedicated build boots and spawns E1M1.
  Not verified: pointer lock and mouse look (needs a live test, as for all of Phase 3 and Phase 4), Firefox, multiplayer over
  WebRTC/WebSocket, sound output, the navigation worker with a real path request.

Phase 4 done-condition met: no registry, the worker bundle contains no client code beyond the model data classes
(`PageServices`, `RenderContext`, `GL`, `VID`, `Materials`, `Sky`), the instance conversions the plan promised for `Con`, `Mod`,
`Host` (dissolved), `ClientEngineAPI` and the composition roots are done, and `CL`/`M`/`R`/`GL`/`S`/`IN`/`Key`/`Draw`/`SCR`/`V`
stay static classes imported directly (fork 1).

### Later tracks (own plans, order flexible after Phase 3)

C (lifetimes and typed events) can start after Phase 2. The replay recorder (Track G) starts after
Phase 3, as `plans/server-replay.md`. D1 (shader chunks) is independent of A/B
and can run at any time as a quick win. E, F and G start where noted in their sections; G's test
conversion rides along with Phases 2 to 4.

## Testing

- **Per phase:** `npm test`, `npm run typecheck`, `npx eslint --fix` on touched files. Test files
  are not type-checked today, so every signature change is also grepped through `test/` and
  `source/game/**/test/` by hand until Track G lands.
- **Phase 1:** a boundary test that fails when a server module imports a client module or the
  reverse; unit tests for the control-plane state mirror and the simulation gate.
- **Phase 2:** each converted module's test constructs the instance with fakes; a smoke test boots
  `createDedicatedServer` against a fixture map.
- **Phase 2:** `AssetSource` tests with a fake fetch/cache/locks: a concurrent second request for the same
  path results in one fetch; a cache hit never touches the network; the user store overrides content;
  the localStorage migration is idempotent; a changed engine or game version opens a new cache and
  removes the old `quakeshack/` caches while leaving unrelated caches alone.
- **Phase 3:** `ChannelDriver` ordering/backpressure/overflow tests (mirroring the existing
  `LoopDriver` tests in `test/common/network-drivers.test.mjs`); control-plane contract tests with
  an in-process port pair; savegame split round-trip against the existing fixtures in
  `test/common/savegame.test.mjs`. New fixtures or new top-level files mean a Dockerfile `COPY`
  update (`dockerfile-fixture-sync`), and any test in a new nesting level needs the
  `test-glob-coverage` check.
- **Real browser (required, per `CLAUDE.md`):** every phase that changes client/UI behavior, and
  Phase 3 above all. Headless Chromium here never grants real Pointer Lock, so mouse-look and
  click-to-relock cannot be confirmed by the automated pass; after Phase 3 and Phase 4 they need a
  live play test by a human.
- **Measurements:** input latency and memory in Phase 3 (B4, B7), recorded as numbers in this plan,
  not pass/fail gates; frame time unchanged in Phase 4.

## Open questions

Resolved on 2026-10-03, see "Decisions already made" and "Phase 0 findings":

- `Cvar`/`Cmd` stay realm singletons, with transparent client-to-server sync (decision 4); the
  replication model is proxy cvars on the main thread plus an eager worker start (B5, finding 3).
- Worker is the default for single player and listen servers (decision 5); the tick policy is
  command-driven with a timer fallback (B4, finding 4).
- Phase 1 starts after `client-entity-architecture` phase 6 (decision 6).
- A main-thread WebRTC relay is acceptable (decision 7), and is the first implementation (B2).
- Loaded files are shared through a common byte layer (decision 8, B7), invalidated by engine and
  game version (decision 9).
- User files move from `localStorage` to IndexedDB (decision 10).
- Browser coverage: Firefox and Chrome pass every worker check (finding 6); Safari is out of scope
  (decision 12).

Nothing is open at the moment. The map-list helpers stay until after Phase 4 (decision 13) and
replay is in scope (decision 14). New questions get added here as phases surface them, for example
the replay plan's open details (storage format, whether the recorder ships in production builds).

## Phase 0 findings

Run on 2026-10-03 with throwaway code kept outside the repo (a scratch Vite 8 project mirroring
`source/engine/{common,server}`, `source/game/*/main.ts` and the repo's `worker` build options, driven
by the cached Chromium 151 through Playwright, per `docs/browser-verification.md`). Each check is
roughly 50 lines and the method is stated so it can be rebuilt. Findings 1 to 5 and 7 are Chromium
only; finding 6 was also run in Firefox and a second Chrome (see there).

1. **WebRTC and workers.** `typeof RTCPeerConnection` inside a dedicated worker is `undefined`;
   `RTCDataChannel` exists. Transferring an `RTCDataChannel` to the worker works if it is transferred
   before it opens: on the answerer side from inside `ondatachannel`, on the offerer side right after
   `createDataChannel`. A channel that is already open throws `DataCloneError`. Data flowed both ways
   in both cases (worker to far peer and far peer to worker). Consequence: B2, relay first.
2. **Game module glob in a worker.** The exact `import.meta.glob('../../game/**/main.ts')` plus
   `try/catch` code from `GameModule.ts` is rewritten by Vite 8 inside the worker bundle into a table
   of dynamic imports with one chunk per game module, and both modules (and the "not found" error
   path) behave correctly when loaded inside the worker. The repo's `manualChunks` for
   `source/shared` applies to the main bundle only and did not interfere. Only the production build
   was tried, not the Vite dev server. Consequence: B7, risk closed for the build.
3. **Cvar replication today.** See B5: `svc.cvar` mirrors `SERVER` cvars into `CL.cls.serverInfo` (a
   plain map), remote clients write only through rcon with output capture, all game server cvars are
   `GAME | SERVER`, several engine server cvars are not `SERVER`-flagged (`sv_rcon_password`,
   `sv_maplist`, `nav_*`), `cvar.changed` events already exist, and `ServerGameAPI.Init` registers
   game cvars before the config runs. Consequence: proxy cvars and an eager worker start.
4. **Tick policy latency (synthetic).** A main loop shaped like the real one (busy work for the
   frame, send a command, `await setTimeout(0)` like `Q.yield`, optionally sleeping to a 16.7 ms
   cap) against a worker that takes 1 ms per server frame. Latency here is "command sent until the
   first loop iteration that can see the reply"; "extra frames" is measured against the in-thread
   behavior of seeing it one iteration later. 300 frames per row.

   | Client frame | Cap | Server frame on command arrival | Fixed 72 Hz timer | Fixed 20 Hz timer |
   | :--- | :--- | :--- | :--- | :--- |
   | 4 ms | none | p50 4 ms, 0.02 extra | p50 12, p95 20 ms, 1.1 extra | p50 28, p95 52 ms, 3.3 extra |
   | 8 ms | none | p50 4 ms, 0.02 extra | p50 16, p95 16 ms, 0.8 extra | p50 28, p95 52 ms, 2.4 extra |
   | 14 ms | none | p50 4 ms, 0.02 extra | p50 22, p95 22 ms, 0.8 extra | p50 40, p95 58 ms, 1.7 extra |
   | 4 ms | 16.7 ms | p50 12 ms, 0 extra | p50 12, p95 28 ms, 0.14 extra | p50 28, p95 60 ms, 1.4 extra |
   | 8 ms | 16.7 ms | p50 8 ms, 0 extra | p50 8, p95 24 ms, 0.45 extra | p50 40, p95 56 ms, 1.7 extra |

   Caveats: synthetic work instead of the real engine, headless Chromium without GL, one machine.
   The shape is what matters (arrival-driven equals the in-thread behavior, a fixed timer costs up
   to a few frames); the absolute numbers do not transfer. A first run leaked late replies between
   configurations and produced bad rows, was fixed and re-run, and only the second run is reported.
   Phase 3 repeats the measurement in the real engine.
5. **File loading facts.** Browser `COM.LoadFile` is `localStorage` then plain `fetch`, with no
   application cache; Node reads PAK entries via `fs`; the nav worker avoids the map by loading its
   own `.nav` file; client and server currently share parsed models through the `shared`
   `ModelScope`. Consequence: B7's three-layer design.
6. **Worker primitives, in three browsers.** Reproduce in any browser with
   `scripts/worker-compat-check/`: serve the directory over `http://localhost` (for example
   `python3 -m http.server 8099` inside it), open the page and wait for "done". It runs the checks of
   findings 1 and 2 and the primitives below, and also checks that Cache Storage, Web Locks and
   IndexedDB are shared *between* a worker and the main thread, which is what the file sharing design
   needs. The files are new and not committed.

   Results: Chromium 151 (headless, my run) and, from the developer on 2026-10-03, **Firefox 155.0
   and Chrome 154, both on Linux, pass every row.** Inside a worker: `caches`, `navigator.locks` and
   `indexedDB` are objects; `localStorage` is `undefined`; `SharedArrayBuffer` is `undefined` with
   `crossOriginIsolated` false (no cross-origin isolation, so it is not available to this design);
   `RTCPeerConnection` is `undefined` and `RTCDataChannel` exists. A worker's Cache Storage `put` is
   readable from the main thread. A lock held by the main thread for 300 ms made the worker's request
   wait about 250 ms in all three browsers (strict serialization across realms). A worker's IndexedDB
   write is readable from the main thread. Module workers start, and `import()` of a chunk inside one
   works. `RTCDataChannel` transfer works from both the offerer and the answerer side, with data
   flowing both ways. One difference to handle: in Firefox the answerer-side channel was already
   `open` when the worker adopted it, in Chrome it was still `connecting`, so worker code checks
   `readyState` and either sends at once or waits for `onopen` (as the check page's worker does).
   Safari is out of scope (decision 12). Consequence: B7 and B2.
7. **Game API and static helper audit.** No value use of `ServerEngineAPI.`/`ClientEngineAPI.` as a
   static in `id1` or `hellwave` (only type positions and comments), so the static-to-instance
   change needs no game code change; the engine's own tests do use `ClientEngineAPI.SaveSlots` and
   `.Multiplayer` as static namespaces and are converted with Track A. The client game's calls into
   `ServerGameAPI` are the two pure helpers (decision 13 leaves them in place until after Phase 4).
8. **Not done:** the in-engine latency and memory baselines (Phase 3), the dependency inventory
   (Phase 1) and the registry ratchet (after the merge).
