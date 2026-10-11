# Track C: lifetime scopes, a typed event map, events that stop being wiring

Track C of `plans/engine-architecture-modernization.md`. Status: **plan drafted 2026-10-11, the four forks
are settled (same day, see "Decisions"). Phase 0 (the bugs the survey found) is done and browser-verified, Phases 1 (the typed
event map), 2 (scopes) and 3 (de-wiring) are done, and so is the per-game typed view of a game's own events (see
"What actually shipped for a game's own events"), all 2026-10-11. Phase 4 is parked: the design below is the plan for when Track C is picked up
again, and each phase still stops for a go-ahead.** Written after a survey of the code (numbers below are as of that date,
branch `engine-architecture-modernization`; "What actually shipped" says what the code looks like now).

## Context

### How the buses work today

There are four kinds of event bus, spread over two realms (the page and the server worker each have their own
module-level `eventBus`):

| Bus | Where | Lives | Who feeds it |
| :--- | :--- | :--- | :--- |
| `eventBus` | `common/EventBus.ts`, one per realm | the realm | everything, directly |
| client "connection" bus | `ClientRuntimeState.eventBus`, game sees it as `ClientEngineAPI.eventBus` | wiped by `ClientRuntimeState.clear()`, which `CL.ClearState()` calls at **every** `svc.serverdata` (connect and each changelevel) | a hand-kept whitelist, `clientGameEvents` (15 names at the survey, 18 after Phase 0, now derived from `engineEventTable`), re-subscribed on the global bus in `clear()` |
| client module bus | `moduleEventBus` in `ClientState.ts`, `ClientEngineAPI.moduleEventBus` | whole game module lifetime, never wiped | the same whitelist, forwarded once at load |
| server game bus | `Server.server.eventBus`, game sees it as `ServerEngineAPI.eventBus` | `unsubscribeAll()` at spawn (before `gameAPI.init`) and at `ShutdownServer` | **nothing from the engine.** Only the game's own `game.*` events go through it |

Numbers: about 113 files reference the bus, 123 `subscribe` and 84 `publish` sites in `source/engine` and `source/shared`,
42 and 27 in the games. 61 distinct literal event names are published or subscribed by the engine, 62 are listed in
`docs/events.md`. Three lists describe "which events cross a boundary" and are kept by hand: `clientGameEvents`,
`forwardedServerEvents` (`ServerWorkerProtocol.ts`, server to page), and `docs/events.md`. Nothing ties them together.

### What the survey found

1. **The lifetimes in the docs are not the lifetimes in the code.** The architecture notes speak of "per-connection" and
   Track C's first sketch says `engine > module > connection > map`. In code the client bus is wiped on every serverdata, so
   it is a **map** scope; there is no separate connection scope on the client. The server bus is a map scope as well, and the
   server has no module-lifetime bus at all (so a subscription made in the static `ServerGameAPI.Init` is wiped at the first
   spawn; nothing does that today, but it is a trap).
2. **Games listen for events that never arrive.** Verified by running the real `ClientState` (probe in the scratchpad):
   `client.center-print`, `client.disconnected` and `server.spawning` are published on the global bus and are not in
   `clientGameEvents`, so neither client bus receives them. Consequences today:
   - `id1`'s HUD subscribes `client.center-print`. Until `59e0bd2` (2026-10-11, "the game draws the center print") the
     engine drew center prints itself, so that subscription was dead and nobody noticed. **Since that commit center prints
     do not show at all in `id1`.** Regression on this branch, not covered by a test because the game tests use a mock bus.
   - `id1`'s HUD subscribes `client.disconnected` and `server.spawning` (also dead). `client.disconnected` is published
     *after* `clearState()`, so even a whitelisted map-scope listener would already be gone.
   - `id1`'s `ServerGameAPI` subscribes `cvar.changed.sv_nextmap` on the server game bus (`GameAPI.ts:490`): never fires,
     so changing `sv_nextmap` after the map started has no effect there. Game code, so raised here, not touched.
3. **Docs drift.** `vid.resize` is documented as three arguments and is published as one object
   (`{ width, height, pixelRatio }`). Ten literal names the engine uses are undocumented (`nav.build`, `nav.path.response`,
   `worker.*`, `cvar.changed.gl_clear`, `cvar.changed.nav_debug_*`, `cvar.changed.sv_maplist`). Both games' `docs/events.md`
   point at "the event bus mechanism (buses, lifetimes, subscribe/unsubscribe rules)" in the engine doc, which has no such section.
4. **`EventBus` is untyped**: `subscribe(eventName: string, listener)` with arguments checked only against whatever the
   caller annotates, which is how finding 2 and the `vid.resize` payload went unseen.
5. **No hot reload exists.** No `import.meta.hot`; dev is `vite build --watch` for the page and `dedicated:dev` for Node.
   Game modules load through `import.meta.glob` dynamic imports in `GameModule.ts` ("NEVER EVER TOUCH").

### Decisions already made (in the umbrella plan)

- `unsubscribeAll()` has no exceptions by design, and that must stay observable at scope end: a game never has to unsubscribe
  by hand, and removing the wipe would leak every earlier connection's listeners.
- Typed events are an enforcement tool: a test asserts `docs/events.md` equals the map's keys (`event-bus-docs-sync` says
  nothing enforces it today).
- Capability scoping and sandboxing of `ServerEngineAPI` is out of scope until untrusted community mods are a goal.

## Goals

- One mechanism for lifetimes (`Scope`) replacing the per-connection proxy list, the `moduleEventBus` forwarding loop and the
  server's `unsubscribeAll()` calls, with the same observable behavior.
- A typed event map in `source/shared/`, so `publish` and `subscribe` are checked against it and a typo or a wrong payload is a
  `tsc` error, with zero run-time cost.
- A single place that says, per event, whether a game may see it, whether it crosses the worker boundary and what its
  arguments are, replacing the three hand-kept lists.
- Engine events that only exist to avoid an import cycle are classified and replaced by direct calls where a return value or a
  hot path is involved; the lifecycle and cross-realm ones stay.
- Dev-only hot reload of the server side (respawn the worker).

## Non-goals (this pass)

- Changing what game code observes, except where finding 2 is a bug. A game that works today keeps working unchanged.
- Capability narrowing of the engine API (umbrella plan, Track C, last bullet).
- Cross-realm typed RPC. Events that cross the worker boundary stay a closed list; they only get typed.
- Rewriting how a game publishes its own events beyond giving it the option of types.
- Client-side hot reload of the game module (decision 3).

## Design

### A. Scopes

```ts
interface Scope {
  readonly name: 'engine' | 'module' | 'map';
  readonly parent: Scope | null;
  readonly events: ScopedEventBus;   // what a game receives as `eventBus`
  onDispose(callback: () => void): void;
  dispose(): void;                    // releases every listener made through `events`, then the children
}
```

- **A scope is a bus of its own plus the forwarding of what its game is given, not a view over the realm's bus.** The
  first draft of this plan said "view"; Phase 2 found that wrong. A game may publish a name the engine also uses (id1
  republishes `client.clientdata.field-changed` for its own HUD) and expects only its own listeners to hear it, and a
  `game.*` event published on the map bus never reached the module bus and never touched the realm bus (so it can never
  collide with a name in `forwardedServerEvents`). A view that registers game listeners on the realm bus would break
  all three. So a scope owns a `GameEventBus`, and `scope.begin()` forwards the engine events the game is given into
  it (`EventBus.forward`/`forwardFamily`), `end()` stops that. What the scope replaces is the per-owner forwarding
  code and the wipes, and the "which bus carries which event" question the docs apologize for. The old `EventBus`
  class stays as the realm bus.
- **A game's own events do not go to the realm bus**, and not to the other scopes. Phase 2 pinned these facts with tests
  before it changed the owners (`client-game-events.test.ts`, `server-game-events.test.ts`, `scope.test.ts`).
- **Lifetimes, as the code really has them:**
  - `engine`: the realm. Engine-internal subscribers (one-time `Init` wiring) live here and are never disposed before
    shutdown.
  - `module`: the loaded game module. Today this is the client `moduleEventBus`; the server gains the same so a subscription in
    `ServerGameAPI.Init` survives the first spawn. Disposed when the module is unloaded (nothing does that yet; hot reload
    would).
  - `map`: from `svc.serverdata` / `Server.SpawnServer` until the next one, or a disconnect/shutdown. This is the client
    "connection" bus and the server game bus of today.
  - There is no separate `connection` scope (decision 1).
- **Ordering rule that fixes `client.disconnected`:** the engine publishes a lifecycle end event *before* it disposes the
  scope it closes, so the listeners of that scope hear it. The whole sequence in `disconnect()` is
  `gameAPI.shutdown()`, then `client.disconnected`, then `clearState()` (the scope's dispose). `shutdown()` runs first and
  clears `state.gameAPI`, so a game that unsubscribes inside its own `shutdown()` misses `client.disconnected`: id1's HUD
  only hears it because `HUD.shutdown()` is empty. Decided in Phase 2: the order stays, and `ClientGameInterface.shutdown`'s
  JSDoc, `docs/events.md` and a test in `client-connection.test.mjs` state it.
- **Games cannot publish engine-owned names they were not given.** Phase 1 enforces this at compile time (`GameEventBus`,
  see "What actually shipped in Phase 1"); Phase 2 adds a `console.assert` for untyped `.mjs` games. A game may publish an
  engine name it *is* given (id1 does), which stays on its own scope, so "no engine names at all" was too strict a rule.
- **Visibility filter at subscribe time**, replacing the whitelist. The rule is *"refuse an engine-owned name the table does
  not mark visible to this game; any other name is the game's own"*, not "refuse what the table does not list": the latter
  would refuse `game.*` and `hud.showscores`. At compile time this is `GameOwnedEventName`; at run time it asserts in dev
  and ignores in production. The residue is a typo of an engine name in an untyped game (`client.center_print`), which looks
  like a game event: the typed per-game view (decision 2) is what catches it, and only for TypeScript games.

### B. Typed event map

- `source/shared/EngineEvents.ts`: `interface EngineEventMap { 'client.damage': [event: ClientDamageEvent]; ... }`, one entry
  per documented engine event, argument tuple as the value. Per-event metadata that the three lists carry today lives next to
  it in a `const` table keyed by the same names (`gameVisible`, `crossesWorker`), and `forwardedServerEvents` and
  `clientGameEvents` become derived values of that table.
- `EventBus` gets a generic over the map. Parameterized names (`cvar.changed.<name>`) are a template-literal key
  (`` `cvar.changed.${string}` ``: `[cvar: Cvar]`).
- Game events: each game declares its own `GameEvents` interface and gets a typed view of the scoped bus (decision 2);
  engine-owned names stay strictly typed and a game view rejects publishing them. **Phase 1 stops short of this**: it
  types the engine names a game receives and leaves a game's own names loosely typed (any name, the game's argument
  tuple); the per-game map needed changes in the game repos and was done afterwards, see "What actually shipped for a
game's own events".
- **Enforcement tests:** (1) the documented names in `docs/events.md` equal the map keys, (2) every `crossesWorker` event is in
  `ServerWorkerProtocol`'s list and the arguments are structured-cloneable by type, (3) a game's `docs/events.md` equals that
  game's own event map (same test helper, run from the game's test folder).
- Existing untyped call sites are migrated in the same phase that introduces the type; there is no loose-typed escape hatch for
  engine events.

### C. Events that stop being wiring

Classify the 61 names into three groups and only touch the first:

1. *Wiring*: published so that module A can tell module B "I am ready" without importing it, where B could simply be called
   (candidates by name: `com.ready`, `com.argv.ready`, `com.registered`, `wad.palette.loaded`, `vid.ready`,
   `renderer.shaders.initialized`, `renderer.textures.initialized`, `host.config.loaded`). Replace by a direct call from the
   composition root or the owner, keep the event only if a *game* or another realm uses it.
2. *Lifecycle and notification*: stays an event, gets typed and documented (`client.*`, `server.*`, `host.*`, `cvar.*`, `menu.*`).
3. *Cross-realm transport*: `nav.*` and `worker.*`, which are the worker message protocol in disguise. They stay on the realm
   bus, are typed and documented as such, and are not game-visible.

The classification and the call-site list is the first deliverable of that phase, and the developer approves it before any
event is removed: a published event may have subscribers in a game that grep over `source/engine` does not see.

### D. Hot reload (dev only, server side)

Terminating the server worker and spawning a new one is already a clean operation (`WorkerServerController.stop()` then
`start()`, which re-imports the game module's server code in a fresh realm). A dev-only command and a watcher for the rebuilt
worker bundle can respawn it and re-issue the current `map`. No scope work is required for the server (the realm dies).
Client side needs scope teardown plus a re-import of the game module with a cache-busting URL, and the module's
`ClientGameAPI.Init`-registered menu pages, cvars and commands have no unregister path today; that is the real cost and why it
is out of this pass.

## Phasing

Each phase ends with `npm test`, `npm run typecheck` and `npx eslint source/engine` green, stops for a go-ahead, and records
"what shipped" here.

- **Phase 0: stop the bleeding. Done 2026-10-11, see "What actually shipped in Phase 0".** Add `client.center-print`, `client.disconnected` and `server.spawning`
  to the game-visible set and publish `client.disconnected` before `clearState()`. A regression test runs the real
  `ClientRuntimeState` (not a mock bus) and asserts each documented game-visible name reaches `engineAPI.eventBus` and
  `moduleEventBus`. Browser check: a center print shows in `id1` (pickup message, secret, finale text).
- **Phase 1: the typed map, no behavior change. Done 2026-10-11, see "What actually shipped in Phase 1".** `EngineEvents.ts`,
  the generic `EventBus`, every engine call site migrated, `docs/events.md` brought in line, the docs-equals-map test. The
  hand-kept lists derive from the table.
- **Phase 2: scopes. Done 2026-10-11, see "What actually shipped in Phase 2".** Start with the three isolation tests of Design A. `Scope`, the client map and module scopes replacing `ClientRuntimeState`'s proxy list and
  `moduleEventBus`, the server map scope replacing the `unsubscribeAll()` calls, a server module scope. The public members of
  `ClientEngineAPI`/`ServerEngineAPI` keep their names and behavior; `moduleEventBus` stays as an alias of the module scope's
  bus. Tests: scope end releases every listener (including ones made by engine code through the scope), nested disposal order,
  a listener added during a publish, no listener leak across 100 changelevels (count of the realm bus's listeners).
- **Phase 3: classify and de-wire** (Design C). **Done 2026-10-11**, see "Phase 3 classification" and "What actually shipped in Phase 3".
- **Phase 4 (parked): server hot reload** (Design D, decision 3). Own browser pass.

## Testing

- Phase 0's regression test is the missing coverage: today no test exercises the engine to game bus with the real proxy, the game
  tests mock the bus, which is how this went unnoticed.
- `.test.ts` for everything new (type-checked). `test/common/event-map-docs.test.ts` for the docs-equals-map check.
- Game-side: each game's tests construct the game against the real scoped bus (`createScope`) rather than a hand-rolled mock where
  it is cheap, so subscription mistakes show up; the mocks in `source/game/id1/test/client/fixtures.ts` stay for the rest.
- Real browser (`browser-ui-verification`): Phase 0 and Phase 2 (changelevel and disconnect still tear down HUD and menu
  subscriptions, menu `host.alert` still works after a rejected connection, no doubled HUD messages after three changelevels).
  Pointer lock is untouched.

## What actually shipped in Phase 0 (2026-10-11)

Engine fixes, each with a test that fails against the old code (checked by stashing the fix):

- **`clientGameEvents`** (`ClientState.ts`) carries `client.center-print`, `client.disconnected` and `server.spawning`. id1's
  HUD gets center prints again, and with it Hellwave's, which inherits the subscription through `Q1HUD`. Both client buses
  receive them.
- **`client.disconnected` is published before `clearState()`** (`ClientConnection.disconnect`). Before, the per-map bus had
  been wiped when the event went out, so a game's disconnect handler could never run (id1's takes the post-process tints off,
  and the post-process stack outlives the game instance, so a lava tint could stay on the main menu). The engine's own
  listeners (`R.ClearAll`, `CDAudio.Stop`, the menu) do not read client state, so the order does not matter to them.
- **The server game bus receives `cvar.changed` and `cvar.changed.<name>`** (`Server.ts`, from the existing global listener).
  This is what id1's `GameAPI` has been waiting for with `cvar.changed.sv_nextmap`; no game code changed. The server bus gets
  nothing else from the engine, which `docs/events.md` now says.
- **`docs/events.md`**: the `vid.resize` and `server.spawning`/`server.spawned` payloads, `nav.path.response`, `nav.build` and
  the `worker.*` messages, and the new "Event buses and lifetimes" section that both games' event docs have been pointing at.
- **Tests**: `test/client/client-game-events.test.ts` (the real `ClientRuntimeState` and engine bus, not a mock, which is the
  gap that hid this), a disconnect-ordering case in `client-connection.test.mjs`, `test/server/server-game-events.test.ts`.

Not done, and why:

- **The client bus still does not get `cvar.changed.<name>`**, only `cvar.changed`. No game listens for the per-name form on the
  client today; the curated table of Phase 1 is where that gets decided.
- **The lava tint after disconnect was not exercised** (the post-process stack is only observable through a render). The
  ordering it depends on was: see the browser pass below.

### Browser pass for Phase 0 (2026-10-11)

Headless Chromium (software GL) against the dev dedicated server's watch build, game `hellwave` (which inherits the id1 HUD
through `Q1HUD`), driven by a throwaway Playwright script (`docs/browser-verification.md`):

- **Center print**: `sv_cheats 1`, face a wall, `impulse 66`. `client.center-print` reached the module bus and the per-map
  bus, `HUD.centerPrint.message` was `worldspawn (edict 0)` and the screenshot shows the text drawn mid-screen. This is the
  regression of `59e0bd2`, fixed.
- **Disconnect**: with a listener on each bus, `disconnect` delivered `client.disconnected` to both, the per-map one before
  its wipe. The main menu came up.
- **No listener leak**: the per-map bus held the same 24 topics after three changelevels as after the first map, and the
  module bus saw `server.spawning` once per map (4 for 4).
- **Console**: no errors beyond 404s for optional assets (`.nav` files, `music/*.opus`, a few sounds, `beam.mdl`).
- **Not covered**: pointer lock, mouse look, hover (not possible in headless Chromium).

## What actually shipped in Phase 1 (2026-10-11)

No behavior change: 2302 tests, `npm run typecheck` and ESLint on every touched file are clean, and the browser pass above
ran on this code (it exercises the reworked forwarding).

- **`source/shared/EngineEvents.ts`**: `EngineEventMap` (name to labeled argument tuple, 67 names plus the
  `` `cvar.changed.${string}` `` family) and `engineEventTable`, keyed by the documented name (`cvar.changed.<cvar-name>`),
  with three flags per event: `clientGame`, `serverGame`, `crossesWorker`. `satisfies Record<EngineEventDocName, ...>` makes
  the compiler keep the table's keys equal to the map's. `clientGameEventNames`, `forwardedServerEventNames` and
  `documentedEngineEventNames` are derived from it.
- **`EventBus<TMap>`** (`common/EventBus.ts`) is generic over a map and defaults to `EngineEventMap`, so `eventBus.publish` and
  `.subscribe` are checked at every one of the 208 call sites; nothing changes at run time. New members:
  `publishUntyped(name, ...args)` for transport code that only has a name at run time (the worker bridges,
  `WorkerServerController`'s forwarded events, the `eb_publish` console command) and `forward(names, target)`, which replaces
  the two hand-written forwarding loops in `ClientState.ts` (`#proxyEventListeners` is one stop function now).
- **`GameEventBus<TMap>`** is what a game receives (`ClientEngineAPI.eventBus`/`moduleEventBus`,
  `ServerEngineAPI.eventBus`). The engine events the game is given are typed as on the engine bus; any other name is the
  game's own and takes the game's argument tuple; an engine name the game was *not* given is `never`, a compile error
  instead of a listener that never fires. `ClientGameEventMap` and `ServerGameEventMap` say what each side is given.
- **The three hand-kept lists** are gone: `clientGameEvents` (`ClientState.ts`) and `forwardedServerEvents`
  (`ServerWorkerProtocol.ts`) derive from the table, and the lists in `docs/events.md` are compared with it by a test.
- **Enforcement**: `test/common/event-map-docs.test.ts` fails when `docs/events.md` documents other names than the table, when
  the "Events across a server worker" list or the client game bus row differ from the flags (checked by deleting rows), and
  when a derived list is not what the flags say. `test/common/event-bus.test.ts` covers `forward`, `publishUntyped`, the game
  bus and, with `@ts-expect-error`, that a typo or wrong payload does not compile. The Dockerfile `test` stage copies
  `docs/events.md` (and `.dockerignore` lets it through) for that test; **not run under Docker here**.
- **Documentation**: `docs/events.md` says where the map lives and that game buses are typed, and its `gl.texturemode`,
  `client.connected` and `host.crash` rows now match what is published. `event-bus.instructions.md` and the
  `event-bus-docs-sync` skill name the table as the first stop for an engine event.

What the types found (each fixed where it was, none changes behavior):

- `gl.texturemode` was documented as `name, min, max` and is published as `name, { min, max }`.
- `client.connected` can carry `null` (a socket without an address): the map says `string | null`.
- Hellwave's `HUD` listened to `client.clientdata.field-changed` with a `value` narrower than the payload
  (`ClientSerializableType` includes `Vector` and arrays): widened to the payload type, its `switch` was already narrowing.
- id1's `ClientAPI._emitClientdataFieldChanges` published `field` as `keyof Id1Clientdata` (string, number or symbol): cast to
  `string`, which `Object.keys` always yields.
- `Navigation.ts` and `NavigationDebug.ts` each kept a private vector type for the same payload; they use `EventPosition` and
  `EventPath` from the map now. `host.alert`'s `publish<[HostAlertEvent]>` generics are gone.

Decided, not done:

- **`cvar.changed.<cvar-name>` stays server-game only.** The client whitelist forwards fixed names, no client game listens for
  the per-name form. Phase 2's `forwardFamily` makes it a one-flag change in `engineEventTable` (`clientGame: true`) the day a
  client game needs it.
- **A game's own events are not typed yet** (see Design B). `docs/events.md` of a game is therefore still checked by the
  `event-bus-docs-sync` skill and by hand; Test (3) of the enforcement list came with the per-game typed view (see "What actually shipped for a game's own
events").
- **The game repos were edited** (id1 `client/ClientAPI.ts`, hellwave `client/HUD.ts`, one line each), which
  `typescript-port.instructions.md` asks to be raised first. They are type fixes the compiler required. **Neither is
  committed**: id1 is a submodule and hellwave its own repo, see the `submodule-aware-commit` skill.

## Phase 3 classification (survey and decisions, 2026-10-11)

Every event of `engineEventTable` (68 names), with the publishers and subscribers found by grep over `source/engine`,
`source/shared`, both games (source and tests) and `test/`. A game never subscribes to an event that is not in its
whitelist (`clientGame`/`serverGame`), and none of the events in A or B is, so changing them cannot reach a game or a mod.

**Decisions of the developer (2026-10-11):** group A is **kept** (the eight stay as documented notifications, not removed),
group B is **done** (all three become direct calls), group C is **kept**, group E is not pursued. The proposals below are
the original wording; "What actually shipped in Phase 3" says what was done.

### A. Wiring leftovers with no subscriber anywhere (8): proposed for removal, kept by decision

Nobody listens: not the engine, not a test, not a game. Each was published so that a module could say "I am ready", and the
module that needed it was later given a direct call, or never needed it. `docs/events.md` rows, `EngineEventMap` and
`engineEventTable` entries go with them.

| Event | Published by | Note |
| - | - | - |
| `com.argv.ready` | `Com.ts:310` | `COM.argv` is usable after `Init`, which is a call, not an event |
| `com.registered` | `Com.ts:281`, `:292` | the answer is `COM.registered` (a cvar) |
| `com.ready` | `Com.ts:335` | only subscriber is a commented-out block in `WorkerManager.ts` |
| `wad.palette.loaded` | `W.ts:165` | |
| `renderer.shaders.initialized` | `ShaderPrograms.ts:207` | JSDoc at `:20` mentions it |
| `renderer.textures.initialized` | `DefaultTextures.ts:101` | JSDoc at `:39` mentions it |
| `host.config.loaded` | `Host.ts:177` | |
| `gl.texture.ready` | `GL.ts:939` | published for every texture upload, for nobody |

### B. Wiring with one same-realm subscriber: direct call (3), done

| Event | Publisher, subscriber | Replacement |
| - | - | - |
| `vid.ready` | `VID.Init` publishes, `GL.ts:1193` calls the module function `GL_Init` | `ClientHost` calls `GL.Init()` right after `VID.Init()`, `GL_Init` becomes a static method; the module-level subscription in `GL.ts` goes away |
| `vid.shutdown` | `VID.Shutdown` publishes, `GL.ts:1194` calls `GL_Shutdown` | `ClientHost` calls `GL.Shutdown()` right after `VID.Shutdown()` (same order as today) |
| `gl.texturemode` | `TextureModeCommand` in `GL.ts:985` publishes, every `GLTexture` subscribes in its constructor (`GL.ts:721`) and keeps an unsubscribe function (`:841`, `:945`) | the command loops over `textureCache` (every texture is in it, the constructor asserts so) and calls `_setTextureMode`; the per-texture listener, its field and its two cleanups go |

### C. Lifecycle and notification: keep, typed and documented (the other 47)

These stay events: the observer is a different layer than the publisher (UI or renderer observing the core), another realm,
or a game. Replacing them with calls would point dependencies the wrong way.

- **Observed by the engine, core to UI/renderer/audio**: `client.paused`, `client.unpaused`, `client.cdtrack` (Sound,
  CDAudio), `client.disconnected` (Menu, R, CDAudio, and games), `client.connecting`, `client.signon`,
  `client.game-initialized` (Menu, ClientHost), `vid.resize` (GL, Draw, Viewport, and games), `areaportals.changed`
  (`common/model` to the renderer's Visibility), `com.fs.being`/`com.fs.end` (Com to Draw's disc icon),
  `console.print-line` and `host.crash` (common to each realm's `Sys`), `cvar.registered`, `cvar.changed`,
  `cvar.changed.<cvar-name>`, `gl.ready`/`gl.shutdown` (29 subscribers each: the GL context lifecycle).
- **Server lifecycle, partly across the worker**: `server.spawning`, `server.spawned`, `server.shutting-down`,
  `server.shutdown`, `server.client.connected`, `server.client.disconnected`, `net.connection.accepted`.
- **Seen by games**: `client.damage`, `client.center-print`, `client.chat.message`, `client.clientdata.field-changed`,
  `client.server-info.ready`/`.updated`, `client.players.name-changed`/`.frags-updated`/`.colors-updated`, `host.alert`,
  `host.quit-requested`.
- **Notifications nobody subscribes to today** (14): `client.players.*` (3), `client.connected`, `menu.page-registered`,
  `menu.opened`, `menu.closed`, `host.ready`, `host.shutting-down`, `host.shutdown`, `net.connection.close`,
  `net.connection.error`, `server.edict.assigned`, `server.edict.freed`. Proposed to keep: they are the documented lifecycle
  of a subsystem, the menu ones are described in `docs/menu-system.md`, the `client.players.*` ones are part of what a game
  is given, and the replay recorder (Track G) is the intended observer of the server ones. A listener-less publish is a
  `Map.get`. The two `server.edict.*` ones run per entity and are the only ones where that is measurable; tests subscribe to
  `server.edict.assigned` (`test/server/edict.test.mjs`).

### D. Cross-realm transport: keep, never visible to a game (10)

`nav.load`, `nav.path.request`, `nav.path.response`, `nav.build`, `nav.debug.emit-dot.temporarily`/`.permanently`
(the last two cross to the page and are in `forwardedServerEvents`), and `worker.framework.init`, `worker.test`,
`worker.busy`, `worker.error` (the worker message protocol in disguise). `nav.path.request`/`.response` are an RPC with a
correlation id over events; a typed request/response channel would be the honest form, which is Track B's control-plane
territory and not this phase.

### E. Events with a hook alternative: not proposed

`host.crash`, `console.print-line`, `areaportals.changed`, `com.fs.*` could be assignable hooks (`Host.onCrash = ...`, the
pattern of `Cmd.files`) instead of events. Each has exactly one realm-specific consumer, so a hook would work, and it would
remove a name from the map. Nothing is gained that the typed map does not already give, and the events are cross-realm in
the worker case (`console.print-line` is subscribed in both realms), so they stay events.

## What actually shipped in Phase 3 (2026-10-11)

Group B of the classification, and nothing else: 2329 tests, `npm run typecheck` and ESLint on every touched file are clean.

- **`vid.ready` and `vid.shutdown` are gone.** `GL_Init` and `GL_Shutdown` are `GL.Init()` and `GL.Shutdown()` now, static
  methods of the class (the code style asks for that over module functions), and `ClientHost` calls them right after
  `VID.Init()` and `VID.Shutdown()`, which is the order the events produced. The two module-level subscriptions in `GL.ts`
  are gone, so importing `GL.ts` no longer wires anything up as a side effect.
- **`gl.texturemode` is gone.** `gl_texturemode` loops over `textureCache` and calls the new `GLTexture.followTextureMode`,
  which skips a texture that was locked with `lockTextureMode`. The per-texture listener, its field and its two cleanups in
  `lockTextureMode` and `free` are replaced by a `#textureModeLocked` flag; `free()` already takes the texture out of the
  cache, so a freed texture is not visited.
- **Map, table and docs**: three entries fewer in `EngineEventMap` and `engineEventTable` (65 names now), three rows fewer in
  `docs/events.md`, the unused `TextureModeEvent` type is gone. The docs-equals-map test passed without a change.
- **Tests**: `test/client/gl-texture-mode.test.ts` (4: every following texture changes, a locked one does not, a freed one
  is not touched, a texture allocated afterwards gets the chosen mode), built on a recording fake WebGL context and
  `GL.Init()` itself.
- **Browser**: the page boots (so `GL.Init()` runs where `vid.ready` used to), a map loads, and `gl_texturemode GL_NEAREST`
  turns the wall textures blocky while `GL_LINEAR_MIPMAP_LINEAR` brings them back, with no console errors.
- **Not exercised in a browser**: `GL.Shutdown()` (it runs when the host shuts down, which ends the page). The unit test
  runs it after the tests; the order in `ClientHost.Shutdown` is the one the events had.

Not done, by decision: removing the eight listener-less events of group A and the fourteen notifications of group C, and
turning `host.crash`, `console.print-line`, `areaportals.changed` and `com.fs.*` into hooks (group E). The eight of group A
are the first candidates the day something makes a listener-less event a cost.

## What actually shipped for a game's own events (2026-10-11)

The per-game typed view of Design B and decision 2, done after Phase 3 with three decisions of the developer: a type-only
export plus one helper per game (not a method on the engine's bus, not a generic engine API), honest publisher types with
`instanceof` at the listener, and id1 and hellwave in one go. 2335 engine tests (477 of them the game suites),
`npm run typecheck` and ESLint are clean.

- **Engine**: `TypedEventBus<TMap>` (`common/EventBus.ts`), a strict-only view of a bus, a type and nothing else.
  `shared/GameInterfaces.ts` exports it with `ClientGameEventMap` and `ServerGameEventMap`, which is all a game needs from
  the engine, so the games still import no engine code and the mock buses of the game tests keep working.
- **id1** (`Events.ts`): `Id1ServerEvents` (the six `game.*` events), `Id1ClientEventArguments` (the arguments of every
  `clientEvent` opcode), `ClientEventTopics<Arguments>` (an opcode map to its `client.event-received.<opcode>` topics),
  `Id1ClientEvents` (with `hud.showscores`), and `serverEvents(engine)`/`clientEvents(engine)`, which cast the engine's bus
  once. `clientEventName` returns the topic as a literal type for a literal opcode. A compile-time check keeps every
  opcode of `clientEvent` in the arguments map. All 44 publish/subscribe sites of id1 go through the helpers; the one
  dynamic publish (`handleClientEvent`, an opcode off the wire) stays on the loose overload and says so.
- **Hellwave** (`Events.ts`): `HellwaveServerEvents extends Id1ServerEvents` (its three `game.*` events), the same for the
  client opcodes 200 to 204, and its own helpers. All 27 sites go through them.
- **Documents and tests**: id1's `docs/events.md` lists the client events (14 rows, they were not documented before) and
  hellwave's its five; `test/core/events-docs.test.mjs` (id1) and `test/hellwave-events-docs.test.mjs` compare each with the
  names of the game's `Events.ts` and its `clientEvent` opcodes. The engine's `docs/events.md` says how a game declares its
  events ("Declaring a game's events"), the instructions and the `event-bus-docs-sync` skill name the pieces.

What the types found (each fixed where it was):

- **A latent crash in id1's boss death**: `BossMonster` published `game.monster.killed` with `this.enemy`, which can be
  `null` (the code right below checks for it), and the stats listener reads `attackerEntity.edict`. It publishes
  `this.enemy ?? this` now, a boss with nobody to blame is its own killer, as for a self-inflicted player death. This is a
  change of game behavior (a count and no `TypeError`), documented in id1's `docs/events.md`.
- `ITEM_PICKED` can carry `null` as its entity; the HUD's listener said `object`.
- Hellwave listened to `game.player.died` as a `HellwavePlayer` and `game.monster.killed` as a `BaseMonster`, which id1
  does not guarantee. The first only compares identity, so it takes a `PlayerEntity`; the second skips an entity that is not
  a `BaseMonster` (all id1 monsters are).
- The frozen `clientEvent` object of Hellwave spreads id1's enum and so carries its reverse mapping (`clientEvent[1] ===
  'BONUS_FLASH'`). Harmless, but it is why the Hellwave docs test filters for numbers.

Browser (same script): the center print, the disconnect order and the leak counts are as before, and the client event
`BONUS_FLASH` (opcode 1) from `impulse 9` reached its topic through the typed helpers. The other opcodes were not
triggered; they need an item pickup, a kill or a round of Hellwave.

Not done: typing the server side of a client event (`BroadcastClientEvent`/`DispatchClientEvent` take
`...args`), which could use the same `Id1ClientEventArguments` (with a `ServerEdict` where the client gets an edict
reference); and giving the game tests a real `Scope` instead of the hand-made bus.

## What actually shipped in Phase 2 (2026-10-11)

Decisions taken with the developer first: the server game gets `ServerEngineAPI.moduleEventBus` (additive contract change),
the order on a disconnect stays `shutdown()`, `client.disconnected`, release (documented, not changed), and no `map-ended`
event yet. 2325 tests, `npm run typecheck` and ESLint on every touched file are clean.

- **`common/Scope.ts`**: `Scope<TMap>` with `events` (a `GameEventBus`), `begin()`, `end()`, `restart()`, `onDispose(cb)`
  and `adopt(child)`. `end()` ends the scopes inside it first, runs the callbacks last registered first, releases every
  listener of `events` and stops forwarding; a throwing callback does not leave listeners behind, the first error is thrown
  after everything is released. The map scope uses `restart()` so the bus object a game holds is valid for every map.
- **Client** (`ClientState.ts`): a module scope (its `events` is `moduleEventBus`, an alias as planned) and a map scope inside
  it, which `ClientRuntimeState.clear()` restarts. `#proxyEventListeners`, `#configureProxyEvents` and the module forwarding
  loop are gone. `clientRuntimeState.eventBus` is a getter on the map scope and `mapScope` is exposed for engine code that
  holds something per map (`onDispose`); nothing uses it yet.
- **Server** (`Server.ts`): `moduleScope` and `mapScope`. The two `unsubscribeAll()` calls became `mapScope.restart()` at spawn
  and `mapScope.end()` at shutdown, and the hand-written `cvar.changed`/`cvar.changed.<name>` bridge of Phase 0 is the scope's
  forwarding now. `ServerEngineAPI.moduleEventBus` is the module scope's bus.
- **`EventBus`**: `forwardFamily(prefixes, target)` carries a parameterized event by prefix (the realm bus dispatches to
  family listeners only when there are any), `listenerCount` for diagnostics and leak tests. `engineEventTable` derives
  `serverGameEventNames`, `serverGameEventFamilies`, `clientGameEventFamilies` and `isEngineEventName`.
- **`GameEventBus` checks at run time too**: `console.assert` (stripped from production builds) on subscribing to or
  publishing an engine name the bus is not given, which is what catches a typo in an untyped game.
- **Tests**: `scope.test.ts` (17: forwarding by name and prefix, release, callback order, nested end, a throwing callback,
  restart identity, no residue on the realm bus over 100 maps, a listener added and a scope ended during delivery, the
  isolation facts, the assertions), the disconnect order in `client-connection.test.mjs`, the server game bus row of
  `docs/events.md` in `event-map-docs.test.ts`.
- **Browser** (same script as Phase 0, on this code): center print drawn, `client.disconnected` heard on both buses before the
  wipe, the map bus held 27 listeners and the module bus 6 after each of three changelevels, `server.spawning` once per map,
  no console errors beyond optional-asset 404s. The server scopes ran in the worker for all four maps.

Not done:

- **A game's own events are typed** (done after Phase 3, see "What actually shipped for a game's own events").
- **The game tests still use hand-made buses** (`source/game/id1/test/client/fixtures.ts`); building the game against a real
  `Scope` needs changes in the game repos.
- **No game uses `ServerEngineAPI.moduleEventBus` yet**, and the engine registers nothing through `onDispose`. Candidates for
  the next change that touches them: `Navigation`'s hand-kept unsubscribe functions (`#pathResponseEventListener`, the two
  debug-cvar ones) belong to the map scope.
- **The module scopes never end** (no module unload exists); `end()` is tested, not used.

## Decisions (2026-10-11, with the developer)

1. **Three scopes**: `engine`, `module`, `map`. No `connection` scope; add it the day something needs "survives changelevel,
   dies on disconnect". (The umbrella plan's four-level sketch is superseded, see its Track C.)
2. **Per-game typed view.** The engine map is strict; each game declares its own `GameEvents` interface and gets a typed view of
   the scoped bus. Reason: two games in one typecheck program would share a namespace under declaration merging
   (`game.monster.killed` is published by one and consumed by the other today), and game events are game-owned facts.
3. **Hot reload: server side only, last phase** (Phase 4). The client reloads with the page.
4. **Curated game-visible set**, declared per event in the typed table instead of the hand-kept `clientGameEvents` array.

## Open questions

- **When Track C is picked up again**, start at Phase 4 (server hot reload), which needs its own browser pass. The survey numbers above are as of 2026-10-11; re-count before using them.
- **There is no "map ended" event on the client.** `clearState()` runs at every `svc.serverdata` and publishes nothing, so a
  game cannot hear a changelevel; `server.spawning` is the nearest and, as far as the code says, only reaches the page when the
  server runs in the page's own worker (`forwardedServerEvents` is worker to page), so a client connected to a remote server
  never gets it. id1's HUD resets its intermission on it. Not checked against a remote server. Decided in Phase 2: no new event
  for now. If a game needs to hear a changelevel, it is `client.map-ended`, published at the start of `clearState()` before
  the map scope restarts (a new event: map, table, docs row, test).
- ~~Does `ServerEngineAPI` need a `moduleEventBus`?~~ Decided in Phase 2: yes, same name as the client's.

## Dependencies on other tracks

- Track G's replay recorder subscribes to the control plane and server events; the typed map and the scope view are what it
  records through, so this lands first.
- Track E and F do not depend on it.
