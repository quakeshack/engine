# Track E: collision and movement, one source per realm and a determinism test

Track E of `plans/engine-architecture-modernization.md`. Status: **plan drafted 2026-10-16, forks settled the same day (see Open questions). Phase 0 is done (2026-10-16) and so are the two fixes it led to (the msec split and the movement variables), see "Phase 0: what shipped" and "Phase 0 follow-ups". Phase 1 is committed (`f825831`); Phase 2 is implemented (2026-10-16) and waits for review, see "Phase 2: what shipped".**
Written for the maintainers. Numbers and claims are from a read of the tree on that date (branch
`engine-architecture-modernization`); where something was only read and not run, it says so.

## Context

The umbrella plan sketches Track E in two bullets: keep `Pmove` registry-free and prove with tests that client and server
produce bit-identical results, and turn `CollisionModelSource` into an interface with one instance per realm (the umbrella calls it `CollisionWorld`; the name stays `CollisionModelSource`, decided 2026-10-16).
Track A and B changed the ground under both bullets, so this plan starts from what the tree looks like now.

### What is already true

- `Pmove` has no registry and no server or client imports (the `client/` and `server/` imports in `Pmove.ts` are `import type`).
  Per-realm state is on the instance (`physents`, `movevars`, `configuration`, `boxHull`, the hull cache). What is left global:
  `Pmove.debug` (one cvar, created in `Pmove.Init()`), `Hull._midPool` (a 64-vector scratch pool used by the recursive hull
  check) and `Pmove.PLAYER_MINS/MAXS`.
- `PlayerCollisionWorld` and `PlayerCollisionEntity` already exist in `common/collision/CollisionContracts.ts`; `Pmove` and
  `PhysEnt` implement them. They are the contract *player movement* has with its world. They are not the model source the
  umbrella plan wants an interface for (and the umbrella's name `CollisionWorld` for it is not used, see Design E2).
- The client already has its own model source: `ClientPhysics.ts` builds `clientCollisionModelSource` for `clientCollision`.

### What is not

1. **`sharedCollisionModelSource` is still one module-level instance** (`CollisionModelSource.ts:103`). Two places use it:
   `createServerRuntime` passes it to every `Server` (all three realms), and `ClientServerCommandHandlers.ts:37` runs
   `configureClient` on it as a module-load side effect.
   - In a server worker and in the dedicated server it is a different object per realm already, because each realm loads
     its own copy of the module, and the boundary test keeps `ClientServerCommandHandlers` out of the server closure.
   - It is genuinely shared only in the browser's in-thread path (`createBrowserClient.ts`, `channel === null`, loopback
     driver). There the one instance carries both accessor sets, and `CollisionModelSource` resolves across them:
     `getWorldModel()` falls back to the client's world when the server has none, and `getModelByIndex()` is
     `serverModels?.[i] ?? clientModels?.[i]`. A server slot that is `null` (a model still loading, mapped to `null` in
     `Server.ts`) can therefore answer with the *client's* model of the same index. **Not reproduced**, read from the code only.
   - The client side of that sharing has no reader any more (`clientCollision` has its own source), so the
     `configureClient` call on the shared instance serves only the in-thread server fallback, which is the hazard above.
2. **There is no interface.** `CollisionModelSource` is a class with two `configure*` methods and a fallback policy baked in.
   Its consumers (`ServerArea`, `ServerCollision`, `ClientCollision`) depend on the class.
3. **`ClientCollision` stands in for a `Server`.** To reuse the entity narrow phase it builds a `ServerArea` and a
   `ServerCollision` around a fake `{ server: { edicts: [], time: 0 }, con: { DPrint } } as unknown as CollisionOwner`.
   `ServerCollision` uses `sv.server` (edicts, time), `sv.area.tree`, `sv.area.hullForEntity` and `sv.con`; `ServerArea` uses
   six more members (`gameAPI`, `worldmodel`, `time`, `navigation`, `gameCapabilities`, `edicts`). The client only needs the
   box-hull part of the area. This is the cost of reusing server classes from the client, and it is why the cast is needed.
4. **No determinism test exists.** `test/physics/pmove.test.mjs` and `collision-regressions.test.mjs` exercise one `Pmove`
   at a time. Nothing runs two worlds side by side the way the client and a server worker do.
5. **The two callers of `PmovePlayer.move()` do not obviously agree.** Read, not yet run:

   | | Server `_runSharedPmove` | Client `CL.PredictUsercmd` |
   | :-- | :-- | :-- |
   | msec | clamped to 1 to 200 first | not clamped |
   | `msec > 50` | **one** split into two halves | **recursive** split until each piece is 50 or less |
   | 200 ms command | 2 moves of 100 ms | 4 moves of 50 ms |
   | `impulse` on the second half | zeroed | kept (`Pmove` does not read it, so no effect today) |

   The comment in `ServerClientPhysics.ts` says the two "compute identical time steps". For commands up to 100 ms they do.
   Above that they split differently, and movement is not linear in the time step (friction, gravity, collision). Whether it
   is reachable in play: a client running below about 10 fps sends such commands. The determinism test in Phase 0 settles it.

### Cross-engine arithmetic

`Vector` is a `Float32Array`, so every stored component is rounded to float32, which hides most last-bit differences. The
intermediate math is not: `Math.sin/cos/atan2/hypot` (used in `Vector.ts` and `Pmove.ts`) are implementation-defined. A
Node server (V8) with a Firefox client (SpiderMonkey) may disagree in a bit that a same-engine test cannot see. This plan
proves *same engine, separate worlds*; the cross-engine question is handled in Phase 0b.

## Goals

1. A test that runs a server-side and a client-side movement path over the same worlds and the same `usercmd` sequences and
   asserts identical output, for recorded-style scripted sequences and for seeded random ones.
2. One collision model source per realm, owned by the thing that owns the models: the `Server` for the server, the client
   runtime for the client. No module-level singleton, no cross-realm fallback.
3. A small interface (`CollisionModelSource`, which stops being a class) that `ServerArea`, `ServerCollision` and
   `ClientCollision` depend on, instead of the class.
4. The msec-split disagreement (finding 5) either confirmed and resolved, or refuted with a test that says so.

## Non-goals

- No new collision features and no change to `BrushTrace` or hull logic.
- No typed-array BSP layout (parked with SharedArrayBuffer in the umbrella plan, `plans/server-model-memory.md`).
- No client replay or recorded-demo comparison (Track G, postponed past 1.3.0). The sequences here are generated by the
  test, not recorded from a session.
- No Quake II movement (`PmoveQuake2Configuration` stays as it is).
- Not touching game code. Games reach collision through `ServerEngineAPI`, which keeps its signatures.

## Design

### E1. Determinism test

New `test/physics/pmove-determinism.test.ts` (TypeScript, so `npm run typecheck` covers it). Procedural worlds only, built
with the helpers already in `test/physics/fixtures.mjs` (`createBrushWorldModel`, `createRoomHullFromBounds`,
`createBoxBrushModel`), so there is no new fixture file and no Dockerfile change. A test that needs a real map reads one
the way `map-pmove-harness.mjs` does and skips when the data is not there.

**Two worlds, not one.** Each side gets its own world model object built from the same inputs, its own `Pmove`, its own
movevars and its own physent list, which is what a client and a server worker have. Sharing one `Pmove` would test nothing.

**Layer 1, the core.** Two `Pmove`s, `newPlayerMove()` on each, same `PmoveConfiguration`, same start state, same command
sequence, `move()` on both, compare after every step: `origin`, `velocity`, `angles`, `onground`, `pmFlags`, `pmTime`,
`oldbuttons`, `waterlevel`, `watertype`, `waterjumptime`, `touchindices`. Vectors are compared as the bytes of their
`Float32Array` (so `-0` and `NaN` are not hidden by `==`).

**Layer 2, the wrappers.** The server through `ServerClientPhysics._runSharedPmove` (a real `Server` from
`createTestServer`, edicts for the player and for the other solids), the client through `CL.PredictUsercmd`. This is where
finding 5 shows up if it is real. The wrappers differ in how they feed state, so the test starts both from the same logical
state and compares the logical state afterwards.

**Scenarios** (each a short script plus a seeded random run per scenario):

- flat floor, accelerate, strafe, stop (friction);
- jump and land, air control;
- stairs (step up and down) and a slope steeper and shallower than `MIN_STEP_NORMAL`;
- wall slide, corner, two walls at an acute angle (the clip-plane code, `MAX_CLIP_PLANES`);
- water entry and exit, water jump;
- a moving brush entity (door position fixed per step) and a box entity as the other physents;
- noclip, dead, and the `msec` range: 1, 8, 16, 50, 51, 100, 101, 200.

**Randomness.** A small seeded PRNG inside the test (mulberry32-style). Never `Math.random`. The seed is in the failure
message, so a failure reruns exactly.

**Hidden shared state.** Run each scenario three ways: server first then client in each step, client first, and the two
interleaved per step. A difference between orderings means `Hull._midPool` or another static leaked state between the
worlds. Also run it with both sides built before either moves, and with `Pmove.debug` set on one only.

### E2. One collision source per realm

```text
Server (server realm)         ServerCollisionModelSource      reads server.worldmodel, server.models, server.edicts[0]
Client runtime (page realm)   ClientCollisionModelSource      reads clientRuntimeState.worldmodel, model_precache; entity: null
                 both implement   CollisionModelSource    getWorldModel(), getModelByIndex(i), getWorldEntity()
```

- `CollisionModelSource` becomes an interface and goes into `common/collision/CollisionContracts.ts` next to the player contracts.
- The server's implementation is built in the `Server` constructor from the `Server`'s own state. `ServerDependencies.collisionModelSource`
  and `sharedCollisionModelSource` are deleted, as are `configureServer` and `configureClient`. The cross-realm fallbacks go
  with them: a server asks the server, a client asks the client.
- `ClientPhysics.ts` builds the client implementation; `ClientServerCommandHandlers.ts` loses its `configureClient` side effect.
- `getWorldEntity()` on the client returns `null` by construction (it already does, nobody configures a client world entity).
- Behavior change to state plainly: in the in-thread browser path the server stops seeing client models. That is the intended
  fix for the hazard above, not a regression to avoid. Nothing the server needs lives only in the client.
- Tests keep a `mockedCollisionModelSource()` helper in `fixtures.mjs` that returns a `CollisionModelSource`, so the roughly 60
  call sites in four `.mjs` files do not change. `.mjs` tests are not type-checked: grep them by hand for
  `collisionModelSource`, `configureServer` and `configureClient`.

### E3. `ClientCollision` without a stand-in server (optional)

The stand-in cast exists because `ServerArea` and `ServerCollision` are written against `Server`. Two ways out, see Open
questions. The one I would take: move the box hull (`initBoxHull`, `hullForEntity`, the entity-to-hull rules) out of
`ServerArea` into its own small class that needs only a `CollisionModelSource`, and give `ServerCollision` a narrow constructor
parameter (`edicts`, `time`, the hull provider, a console) instead of `Server`. `ClientCollision` then passes real values
instead of a cast. I have not checked that `hullForEntity` separates cleanly from the area tree; Phase 2 starts by
checking that and stops if it does not.

## Phasing

Each phase ends with `npm test`, `npm run typecheck` and `npx eslint --fix` on touched files green, then stops for a go-ahead.

### Phase 0: determinism test and the msec question (no engine change)

1. Layer 1 test with the scenarios above. Expected to pass; if it does not, the failure is the finding.
2. Layer 2 test. Expected to fail for `msec` above 100 if finding 5 is right. If it fails, the test is committed with that
   case marked as a known failure (`todo`), not deleted, and the fix is decided under Open questions before Phase 1 touches
   anything else.
3. **Phase 0b, cross-engine, optional but cheap:** the test's core is plain JS, so run the same seeded sequences in headless
   Chromium and Firefox with the recipe in `docs/browser-verification.md` and compare a hash of the per-step state with
   the Node run. Record the result in this plan. Divergence here is information, not necessarily a bug to fix: client
   prediction is corrected by the server's acknowledged state, so the question is how large the error gets, not whether it
   exists.

#### Phase 0: what shipped (2026-10-16)

Files: `test/physics/pmove-determinism.test.ts` (typed, so `npm run typecheck` covers it) and the worlds, scenarios, seeded
generator and state hash in `test/support/pmoveDeterminism.ts`. The world is built from brushes in code (floor, six steps and a
platform, a 30 and a 60 degree ramp, a wall, two slabs at 60 degrees, a pool with a low wall) plus a box entity and a moving door,
so there is no fixture file and no Dockerfile change. The test does not import `fixtures.mjs`: importing an untyped `.mjs` into a
typed test pulls its 45 implicit-`any` errors into `npm run typecheck`.

Ten scenarios (flat floor, jump, stairs, slopes, wall slide, acute corner, water, moving door and box, noclip, dead). Each
runs scripted at 8, 16, 33 and 50 ms and with three seeded random runs of 120 commands (8 to 200 ms), in three orders (first
side first, second first, alternating). Guard tests assert that the scenarios reach what their names say (the player climbs the
steps, leaves the ground, gets into water, stops at the wall).

- **Layer 1, two `Pmove`s each over a world of its own: identical, bit for bit, in every scenario and order.** Origin, velocity,
  ground, flags, timers, water state compared with `Object.is`. The run order changes nothing, so `Hull._midPool` and the other
  statics do not leak state between worlds.
- **Layer 2, the real `ServerClientPhysics._runSharedPmove` against the real `CL.PredictUsercmd`: identical for commands up to
  100 ms**, scripted and random, in every scenario. Two things are compared with care and not hidden: noclip does not recompute
  the water state, so each side echoes its own starting value and those two fields are skipped there; the water-jump timer is a
  difference of absolute times on the server and a countdown on the client, so it is compared to 1e-9.
- **Finding 5 is confirmed and the cause is the split.** Above 100 ms the two sides diverge on the first command (101 ms from
  standing still: x = 22.75 on the server, 18.375 in prediction). With the recursive split in `_runSharedPmove` applied
  temporarily, all ten scenarios, scripted and random, agree for 101, 150 and 200 ms; the change was reverted, so Phase 0 changes
  no engine code. The 20 cases are `todo` tests in the file and flip to plain tests with the fix.
- **Phase 0b, cross-engine: identical.** 40 runs (the ten scenarios at 16 and 50 ms scripted plus two seeded random runs each)
  hashed over every value of every step (FNV-1a over the bytes of the doubles): Node 24.14 (V8), Google Chrome 155 (V8) and
  Firefox 157 (SpiderMonkey) produce the same 40 hashes. The method, to be rebuilt in a few lines: bundle an entry that runs the
  scenarios with esbuild (`--format=iife --platform=browser --define:__DEV__=false`), serve it from a tiny local server that
  accepts the result by POST, open the page with each browser headless. The system Firefox is a snap and needs a profile under
  `~/snap/firefox/common/`; a headless snap Firefox does not die to `kill` from outside the snap, so it has to be stopped by
  hand. This says nothing about the other engines' `Math.sin/cos` in general, only that none of the paths these scenarios take
  differ.

**New finding 6, not in the plan before: the server does not use its movement cvars, and the client is not sent them.** Two
defects that hide each other:

1. `PlayerMoveCvars` (in `Server.ts`) overrides the `MoveVars` fields with getters that read `sv_gravity`, `sv_friction`,
   `sv_maxspeed`, `sv_accelerate`, `sv_airaccelerate`, `sv_wateraccelerate`, `sv_waterfriction`, `sv_edgefriction`,
   `sv_stopspeed` and `sv_spectatormaxspeed`. `MoveVars` declares those as fields, and with `useDefineForClassFields` (true in
   `tsconfig.json`) a declared field is an own property that hides a getter on the subclass's prototype. Result, run: with
   `sv_gravity` set to 300 and `sv_friction` to 9, `sv.pmove.movevars.gravity` is 800 and `.friction` is 6, and 6 is not even
   the cvar's default (4): the server moves players with the `MoveVars` defaults whatever the cvars say. Checked under `tsx`.
   **Not checked in a built bundle**; Vite and esbuild read the same tsconfig, so I expect the same, but that is an expectation.
2. The server never writes `svc.pmovevars`: the call in `ServerMessages.ts` is commented out, and nothing else writes it. The
   client's `parsePmovevars` is wired but never fed, so the client predicts with the same `MoveVars` defaults.

Why nobody saw it: the two defaults are the same object shape, so server and client agree, by accident. What it means today:
`sv_gravity`, `sv_friction` and the other cvars have no effect on player movement, and `ClientEngineAPI`'s gravity ("synced from
the server via `parsePmovevars()`") is always 800. Fixing either half alone breaks the other: making the getters work makes the
server disagree with the client's defaults, and sending the message without the getters sends the defaults. Games that change
these cvars (or expect to) are affected; I have not searched the games for it. It is pinned by one `todo` test.

#### Phase 0 follow-ups: what shipped (2026-10-16)

Both fixes the determinism tests asked for, done after the go-ahead. Test state: `npm test` 2534 pass, 0 fail, 0 todo (the 21
`todo` tests of Phase 0 are plain tests now); `npm run typecheck` 0 errors.

**The msec split.** `ServerClientPhysics._runSharedPmove` runs a command through `#moveSplit`: halves until no piece is longer
than 50 ms, the same recursion as `CL.PredictUsercmd`, so 200 ms is four moves of 50 ms on both sides and 101 ms is four of 25.25.
The impulse stays on the first piece only (as before; `Pmove` does not read it). Unit tests in `server-client-physics.test.mjs`
pin 16, 50, 51, 100, 101, 200 ms and the clamp to 1 to 200 ms. Effect on play: a client running below about 10 fps now gets the
time steps it predicted instead of two coarse ones.

**The movement variables (finding 6).** Done differently from what the plan said, because the connection already carries them:

- Every movement cvar is a `SERVER` cvar, and the server already sends all of those to a client at signon and again on each
  change (`svc.cvar`). So no new message: `svc.pmovevars` is not used (the constant stays in `Protocol.ts`, marked reserved), and
  the dead `parsePmovevars`, its handler and `PlayerMoveCvars.sendToClient` are gone.
- `MoveVars` is a plain object on both sides. `MOVEVAR_CVARS` (in `Pmove.ts`) names the cvar behind each variable and
  `MoveVars.setFromCvar(name, text)` sets it, reading the text as `Cvar.value` does. The server calls it for every movement cvar
  when it creates its `Pmove` and on each `cvar.changed`; the client calls it for every cvar in `parseServerCvars`. One table, no
  getters, so the shadowing trap cannot come back. `PlayerMoveCvars` is deleted.
- The defaults. `sv_friction` was `4` and `sv_waterfriction` `4` while the players had always moved with `MoveVars`' `6` and
  `1`. To change nothing about how the game feels, the cvars now default to `6` and `1` (also in `docs/dedicated.md`); a test
  compares every movement cvar's default with `MoveVars`' and fails if they drift. Vanilla Quake's values are `4` and `1`; if you
  want those it is a one-line change of two defaults, and it would change how every player moves.
- What changes for real: a game that sets these cvars now has an effect on players. `id1` sets `sv_gravity` to `100` on `e1m8`
  (the finale's low gravity) and `800` elsewhere, which until now only moved the server-side entities, not the player. Hellwave sets
  none of them. Client-side physics that reads `ClientEngineAPI.gravity` (gibs) follows the same value now.
- Demos: a demo records the `svc.cvar` messages, so new ones carry the values; an old demo has no movement values and plays with
  the defaults, which is what it did before.

**Live check (2026-10-16, developer):** played `e1m8`, the low gravity applies to the player and feels right, and changing
`sv_gravity` during a game takes effect at once. Covered by that run: the in-browser game with its server (the default worker).
Then a multiplayer game (developer, same day): Chrome hosted a listen server (`maxplayers 2`, `listen 1`, server in its worker), Firefox joined by invite link, so the game traffic went over WebRTC through the main-thread relay with the handshake over the signaling WebSocket; movement looks right and there is no snapping back, cross-browser. Not covered: a dedicated server over a real WebSocket connection (same `svc.cvar` path, so no difference expected), whether prediction visibly corrects itself on `e1m8` in single player, and a client below 10 fps (the changed split of long commands; the determinism and unit tests cover it). Unit tests
cover the message path (`MoveVars` tests, a `svc.cvar` through `parseServerMessage`, a server cvar change reaching
`sv.pmove.movevars`).

### Phase 1: one source per realm

Steps E2 in this order: the `CollisionModelSource` interface, then the client implementation and removal of the shared
`configureClient`, then the server implementation and removal of `sharedCollisionModelSource` and the dependency, then the
test helper. A unit test per implementation (world model, model by index, null before a map loads) and one that builds a
`Server` with a client-only world present and asserts the server never returns it.
Verify in a real browser on both server paths: the worker path (the default) and the in-thread path. Check how
`createBrowserClient` picks `channel === null` first; if there is no switch to force it, say so and rely on the unit test for
that path. Particles, dynamic-light occlusion and the chase camera are the visible `clientCollision` consumers.

#### Phase 1: what shipped (2026-10-16)

`CollisionModelSource` is an interface now (`common/CollisionModelSource.ts`, in place of the class, not in
`CollisionContracts.ts` as the Design said: the file already carried the name and every importer takes it from there).
Implementations: `ServerCollisionModelSource` (`server/physics/`, built by the `Server` from its own state and handed to
`ServerArea` and `ServerCollision`) and `ClientCollisionModelSource` (`client/`, built in `ClientPhysics.ts`).

- Gone: the class with its two `configure*` methods, `sharedCollisionModelSource`, `ServerDependencies.collisionModelSource`, the
  `configureClient` side effect in `ClientServerCommandHandlers.ts`, and the cross-realm fallback (a server asking for a model it
  does not have no longer gets the client's, and a server without a world no longer traces against the client's).
- The client implementation takes a getter for the client state, not the state: `ClientPhysics.ts` builds it while `ClientState`
  is still being evaluated (an import closes a cycle, the value itself does not exist yet).
- A side effect worth having: the server's accessor used to build a new array of all models on every `getModels()` call, once
  per model lookup in a trace; it reads the one slot now.
- Tests: one file per implementation (`test/server/server-collision-model-source.test.ts`, `test/client/client-collision-model-source.test.ts`),
  and a test with a real `Server` and a world in the real client state, asserting the server does not see it. Two existing tests
  asserted the fallback itself (a `ServerCollision` that "uses the client worldmodel", a `ServerArea` that "resolves hulls from the
  client model precache"); they now assert the opposite and the model table of the server. `mockedCollisionModelSource()` in
  `fixtures.mjs` is a server-only double. `npm test` 2541 pass, `npm run typecheck` 0 errors.
- Live, in headless Chromium against the running dedicated server (`start` map, software GL): the default worker path and
  `?serverthread` both load the map and walk the player about 380 to 400 units; on `?serverthread` the server's `collision` sees
  its own world (empty at the player, the floor 24 units below, the world entity returned). The three 404s both runs log are
  `gfx/concharslarge.png`, `gfx/conback.png` and `progs/beam.mdl` (optional console art, a model this data directory does not
  have), nothing to do with collision. Not compared against a build from before the change.
  Not covered live: a pure remote client (no server in the page at all), and the visible consumers of `clientCollision` (particles,
  dynamic-light occlusion, the chase camera) beyond "no error".

### Phase 2: `ClientCollision` without a stand-in (optional, own go-ahead)

E3. Only if the answer under Open questions is "yes", and only after the separability check.

#### Phase 2: what shipped (2026-10-16, not committed yet, waits for review)

The separability check came back clean: `hullForEntity` and `initBoxHull` of `ServerArea` read nothing but the model source, so
the box hull moved out of the area unchanged.

- **`EntityHulls`** (`common/collision/EntityHulls.ts`): the box hull and `forEntity(ent, mins, maxs, outOffset)`, built from a
  model source. Each realm has its own, so the shared box hull of vanilla's `SV_HullForBox` is no longer one object for both.
  `ServerArea.hulls` holds the server's; `initBoxHull()` and `hullForEntity()` are gone from the area (the constructor builds the
  hull, `Server.Init()` no longer calls it).
- **`CollisionHost`** (in `ServerCollision.ts`): what `ServerCollision` needs from its owner, `server.edicts`, `server.time`, a console
  with `DPrint` and `PrintWarning`, and `area.tree` and `area.hulls`. A `Server` is one without any change.
- **`ClientCollision`** passes a real host: no server entities, time 0, the page's `Con`, no tree, and `EntityHulls` over the
  client's model source. The `as unknown as CollisionOwner` stand-in and the client's import of `ServerArea` are gone. One cast
  is left, `target as unknown as ServerEdict` in `clipMoveToEntity`: the narrow phase is typed on server edicts throughout and
  narrowing that is a larger change than this track.
- **A latent crash gone with it:** the stand-in console had only `DPrint`, and the narrow phase calls `PrintWarning` for a
  `SOLID_MESH` entity precached without `meshCollision`, so a client tracing against one would have thrown.
- Tests: `test/common/entity-hulls.test.ts` (box hull values, the in-place update, the three hull sizes and their offsets, one
  box per instance); a client trace against a BSP entity with the model from the client's own models; the mocks in
  `server-collision`, `collision-regressions`, `game-apis` and `server-physics` tests take `area.hulls.forEntity` where they had
  `area.hullForEntity`. `npm test` 2551 pass, `npm run typecheck` 0 errors.
- Live, headless Chromium against the running dedicated server, with the watch build that contains the change: the default worker
  path and `?serverthread` both load `start` and walk the player (343 and 310 units); on `?serverthread` the server's collision still
  sees its own world (empty at the player, the same floor 24 units below, the world entity) and `sv.area.hulls.forEntity` returns
  the box hull (6 planes) for the player. The same three unrelated 404s as before. Not covered live: a client trace against a
  moving BSP entity (`ClientEngineAPI`'s entity trace), only by the unit test.

### Phase 3: close out

Update the umbrella plan (Track E section, the "Later tracks" state line, the 1.3.0 "what it still waits for" note), JSDoc on
`Pmove`, `CollisionModelSource`, and the comment in `ServerClientPhysics.ts` about the
identical time steps so that it says what is actually true. Record what shipped here, with the test counts.

## Testing

- **New:** `test/physics/pmove-determinism.test.ts` (E1), tests for the two `CollisionModelSource` implementations, the
  no-fallback test on `Server`.
- **Kept passing:** the existing `pmove`, `server-collision`, `collision-regressions`, `client-collision` and
  `collision-model-source` tests; the last one is rewritten for the interface rather than deleted.
- **Globs and Docker:** all new files sit in `test/physics/`, `test/common/` or `test/client/`, which exist, so no new nesting
  level (`test-glob-coverage`); no new fixture files (`dockerfile-fixture-sync`).
- **Real browser:** Phase 1 only, as described there. Pointer-lock-dependent behavior is not touched by this track.

## Open questions

Settled with the developer on 2026-10-16:

1. **Msec split:** if Phase 0 confirms the mismatch, the **server splits recursively like the client** (a 200 ms command is
   four 50 ms moves on both sides). It changes server-side movement for low-frame-rate players; Phase 0 must say so in its
   write-up and the change lands as its own commit.
2. **Interface name:** it stays `CollisionModelSource`, now an interface; the implementations are
   `ServerCollisionModelSource` and `ClientCollisionModelSource`. `PlayerCollisionWorld` is unchanged.
3. **Phase 2 (E3)** is in this track, still behind the separability check at its start.
4. **Phase 0b** (cross-engine run in Chromium and Firefox) is in.
5. **The in-thread browser path stays.** The server runs in a worker by default; the in-thread server is reached with
   `?serverthread` or when the browser has no `Worker` (`wantsServerWorker()` in `createBrowserClient.ts`). It stays for
   single-thread debugging (breakpoints across both sides, `window.engine.SV`) and as a regression comparison for worker bugs.
   Phase 1 makes it safe by removing the cross-realm fallback; whether to drop it is a separate decision after 1.3.0.

Settled after Phase 0 (2026-10-16):

6. **The movement variables:** fixed in this track, see "Phase 0 follow-ups". Open from it: the two friction defaults (above).
7. **The msec fix:** applied, see "Phase 0 follow-ups".

Nothing else is open. Phase 1 starts on the developer's go-ahead.
