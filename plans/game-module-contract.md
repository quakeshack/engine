# One compiler-checked contract between the engine and game modules

Status: complete (2026-09-19). All four phases shipped and verified (see "What actually
shipped"). Follow-ups: the entity contract ([game-entity-contract.md](game-entity-contract.md),
a stub) and the lifecycle gaps listed under Phase 4.

## Context

`ServerGameInterface`, `ServerGameConstructor`, `ClientGameInterface` and
`ClientGameConstructor` in [GameInterfaces.ts](../source/shared/GameInterfaces.ts) are meant to
be the boundary between the engine and a game module. In practice they are documentation:
nothing checks a game against them, and the engine compensates with a private widened type
([Server.ts:57-79](../source/engine/server/Server.ts#L57-L79)) plus casts. The widened type
carries QuakeC-VM globals that no code has touched since the VM was removed.

### Decisions made with the user

1. **Scope: server + client + module**, in phases. The entity contract is a separate
   follow-up plan, not part of this one.
2. **Shape: instance `interface` + constructor `interface`**, games write `implements` and
   `main.ts` asserts `satisfies`. No runtime abstract base class in `shared/`.
3. **Engine-driven fields stay plain fields** on the contract (`time`, `frametime`,
   `force_retouch`, `serverflags`). A method-based API is out of scope.
4. **Statics the engine never calls leave the contract**: `GetServerInfoFields`,
   `GetMapList`, `GetStartServerList`. The games keep them and their menus keep calling them.
   This corrects the description of them as engine override points in
   [menu-rework.md](menu-rework.md).
5. **id1 and hellwave may be edited where this work needs it.** The approval covers the
   contract work (`implements`, `satisfies`, import moves) and what a green `tsc` forces; it
   is not a license for unrelated game changes.
6. **`tsc` enforcement is in scope**: it gates the Cloudflare build and the Docker `test`
   stage (Design F). From then on a type error fails a deploy.
7. **Static `Shutdown` hooks stay in the contract**, documented as reserved. Finishing that
   lifecycle (an engine module-unload path that calls them) is a later piece of work.

### What the contract claims vs. what actually runs (researched 2026-09-19)

Method: grep across `source/engine`, `source/shared`, `source/game/id1` and
`source/game/hellwave` for every member, then a scratch `tsc` probe (outside the repo) that
assigns each game class to the contract types.

**`ServerRuntimeGameAPI`** (the engine-local widening of `ServerGameInterface`):

| Member | Engine access | Games | Verdict |
|---|---|---|---|
| `time` | written before every game callback: [ServerPhysics.ts:146,160,516,751](../source/engine/server/physics/ServerPhysics.ts#L146), [ServerClientPhysics.ts:339,376](../source/engine/server/physics/ServerClientPhysics.ts#L339), [ServerArea.ts:285](../source/engine/server/physics/ServerArea.ts#L285), [Edict.ts:439](../source/engine/server/Edict.ts#L439), [Host.ts:1535,1629,1631,1702](../source/engine/common/Host.ts#L1535) | both (`@serializable`) | **Live.** Engine-written. |
| `frametime` | written at [Host.ts:463](../source/engine/common/Host.ts#L463) | both | **Live.** Engine-written. |
| `force_retouch?` | read and decremented at [ServerPhysics.ts:761,792-793](../source/engine/server/physics/ServerPhysics.ts#L761); games set it ([id1 Player.ts:2122](../source/game/id1/entity/Player.ts#L2122), [Triggers.ts:347](../source/game/id1/entity/Triggers.ts#L347)) | both | **Live.** Typed optional, always present in practice: make required. |
| `serverflags?` | read at changelevel behind an `in` guard, [Server.ts:404-405](../source/engine/server/Server.ts#L404); passed in via `init()` | both; id1 mutates it ([Items.ts:776](../source/game/id1/entity/Items.ts#L776)) | **Live.** Make required; engine only reads it. |
| `mapname?`, `coop?`, `deathmatch?` | none (engine hands the map name to `init()`; `coop`/`deathmatch` are game-owned cvars) | game-internal | **Not contract.** Drop from the engine's view. |
| `self?` | only [Host.ts:316-322](../source/engine/common/Host.ts#L316) saves/restores it around `ClientDisconnect`; neither game defines `self`, so `savedSelf` is always `undefined` and the restore never runs | none | **Dead (QuakeC).** Delete, including that block. |
| `msg_entity?`, 9 × `trace_*`, `v_forward/right/up` | zero references in engine, shared, id1, hellwave | none | **Dead (QuakeC).** Delete (13 members). |

**Rest of `ServerGameInterface`:**

- `SetNewParms?`, `SetSpawnParms?`, `SetChangeParms?`: never called, never implemented. Spawn
  parameters now travel through the player entity's `saveSpawnParameters()` /
  `restoreSpawnParameters()` ([Client.ts:203](../source/engine/server/Client.ts#L203),
  [Host.ts:1627](../source/engine/common/Host.ts#L1627),
  [Server.ts:347](../source/engine/server/Server.ts#L347)). **Dead.** Delete. (The id1 README
  still describes them, [README.md:436](../source/game/id1/README.md#L436).)
- `ClientBegin?`: called if present ([Host.ts:1701](../source/engine/common/Host.ts#L1701)),
  hellwave implements it, id1 does not. **Live, optional.** Keep.
- `PlayerPreThink/PostThink`, `ClientConnect/Disconnect/Kill`, `PutClientInServer`,
  `init/shutdown/startFrame`, `getClientEntityFields`, `prepareEntity/spawnPreparedEntity`,
  `serialize/deserialize`: **live**, and both games satisfy them today.
- Statics `GetServerInfoFields`, `GetMapList`, `GetStartServerList`: the engine never calls
  them. `GetMapList`/`GetStartServerList` are called only by the games' own menu code
  ([id1 client/Menu.ts:459](../source/game/id1/client/Menu.ts#L459),
  [hellwave ClientAPI.ts:38](../source/game/hellwave/client/ClientAPI.ts#L38),
  [NewGameMenu.ts:55](../source/game/hellwave/client/menu/NewGameMenu.ts#L55),
  [MainMenu.ts:206](../source/game/hellwave/client/menu/MainMenu.ts#L206)); nobody calls
  `GetServerInfoFields`. **Not engine contract** (Decision 4).
- Statics `Shutdown` (server and client): declared and implemented, never called by the
  engine ([ClientState.ts:66](../source/engine/client/ClientState.ts#L66) calls it
  "hypothetical"). Kept per Decision 7. `Init` is called
  ([GameModule.ts:135](../source/engine/common/GameModule.ts#L135)).

**Client contract**, found wrong by the probe:

- `ViewmodelConfig.model: BaseModel` is non-null, but both games hold `BaseModel | null` and
  the engine already handles null ([V.ts:481](../source/engine/client/V.ts#L481),
  [R.ts:1636](../source/engine/client/R.ts#L1636)). The contract is wrong, not the games.
- `static Shutdown(): void` vs. both games' `Shutdown(engineAPI)`.

### Why nothing catches drift

The probe (`tsc` over a scratch file, repo untouched):

| Check | id1 | hellwave |
|---|---|---|
| server instance vs `ServerGameInterface` | passes | passes |
| server class vs `ServerGameConstructor` | **fails**: constructor takes `(engineAPI)`, the contract's is zero-arg | **fails**, same |
| client instance vs `ClientGameInterface` | **fails**: `viewmodel.model` nullability | **fails**, same |
| client class vs `ClientGameConstructor` | **fails**: `static Shutdown(engineAPI)` | **fails**, same |

So the server instance contract is accurate but incomplete (it omits `time`, `frametime`,
`force_retouch`, `serverflags`), and everything else is wrong or unchecked. No game class says
`implements`, and every place that would carry types across the boundary is a cast:
`import(...) as GameModuleInterface` ([GameModule.ts:58](../source/engine/common/GameModule.ts#L58)),
`Reflect.construct(...) as ServerRuntimeGameAPI` ([Server.ts:688](../source/engine/server/Server.ts#L688)),
`Reflect.construct(...) as ClientGameInterface`
([ClientServerCommandHandlers.ts:104](../source/engine/client/ClientServerCommandHandlers.ts#L104)),
plus redundant `& { time: number }` casts at
[ServerClientPhysics.ts:333](../source/engine/server/physics/ServerClientPhysics.ts#L333) and
[ServerArea.ts:260](../source/engine/server/physics/ServerArea.ts#L260). `Reflect.construct`
exists because an abstract zero-arg class cannot be `new`ed with an argument.

### Boundary leaks found on the way (type-only imports, both directions)

- id1 → engine: [id1 main.ts:1](../source/game/id1/main.ts#L1) imports
  `GameModuleIdentification` from `engine/common/GameModule.ts` (fixed here);
  [id1 BaseEntity.ts:4](../source/game/id1/entity/BaseEntity.ts#L4) imports `ServerEdict` from
  `engine/server/Edict.ts` (entity contract, out of scope).
- engine → id1: [Edict.ts:2](../source/engine/server/Edict.ts#L2) imports `WorldspawnEntity`
  from `game/id1/`. The engine names a concrete game (entity contract, out of scope).

### Baseline: one `tsc` error, and it is a real bug

`npm run typecheck` has exactly one error today: `hellwave/entity/Items.ts(18,34)` TS2554,
"Expected 2 arguments, but got 1". It is not noise.
[hellwave Items.ts:17](../source/game/hellwave/entity/Items.ts#L17) overrides id1's
`_collectItems(playerEntity, priorItems)`
([id1 Items.ts:135](../source/game/id1/entity/Items.ts#L135)) but drops the second parameter
and calls `super` with one argument. At runtime `priorItems` is `undefined`, which switches
off the "only mention items the player didn't already own" check, so a backpack with
`items > 0` always announces its item. The hellwave test
([hellwave-items-zones.test.mjs:84,87](../source/game/hellwave/test/hellwave-items-zones.test.mjs#L84))
mirrors the one-argument call and passes only because its backpack has `items === 0`.

Nothing ran `tsc` to notice: [wrangler.toml:9](../wrangler.toml#L9) builds with
`npm run build:wrangler` (`test` then `build:production`), and the Dockerfile builds with
Vite/esbuild, which strip types without checking them. `tsc` only ran when someone ran
`npm run typecheck` by hand. Mirroring the Dockerfile `builder` stage's exact `COPY` list into
a scratch directory, `tsc` runs there in about 2.4 s and reports the same single error, so
gating on it needs no new `COPY` lines. (`source/game/hellwave/` is untracked in the outer
repo, so a CI checkout does not contain it yet; the gate matters as soon as it is committed.)

## Goals

1. The contract lists exactly what the engine calls, reads and writes. No QuakeC leftovers.
2. `tsc` checks every game module against it: instance side, constructor, statics and
   identification.
3. The engine holds `SV.server.gameAPI` / `CL.state.gameAPI` as the shared interface type: no
   private widening, no `Reflect.construct`, no ad-hoc `& { time: number }` casts.
4. Game code no longer imports engine files for the module contract.
5. `tsc` is green and part of the Cloudflare build and the Docker `test` stage, so drift fails
   a deploy instead of waiting for someone to notice.
6. No runtime behavior change, except the one hellwave bug fix Phase 1 forces.

## Non-goals (this pass)

- **The entity contract**: the hand-written engine `BaseEntity` interface in
  [Edict.ts](../source/engine/server/Edict.ts) vs. the game's `BaseEntity` class, the
  `as unknown as` casts in [id1 GameAPI.ts:593,598](../source/game/id1/GameAPI.ts#L593), and the
  two leaks above. It is the other half of "no gap" and bigger than this one. It gets its own
  plan, `plans/game-entity-contract.md`, once this lands.
- Replacing engine-written `time`/`frametime` with methods (Decision 3).
- Removing id1's `parm1`-`parm16` (no readers, but `@serializable`, so it changes the savegame
  format).
- The engine → game direction (`ServerEngineAPI`/`ClientEngineAPI`): already typed from the
  real class via `typeof`.
- Type-checking `.mjs` tests (which is how the hellwave bug hid).
- A lint gate: `npm run lint` runs `eslint --fix` and mutates the tree, so it is not gate-able
  as written.
- Wiring the engine's module-unload path to the static `Shutdown` hooks (Decision 7).

## Design

### A. Split each contract into an instance interface and a constructor interface

TypeScript cannot `implements` static members, which is why the contract was a
`declare abstract class`. Split it instead, with zero runtime code in `source/shared/`:

```typescript
export interface ServerGameInterface {
  /** Written by the engine before every game callback; game code treats it as read-only. */
  time: number;
  frametime: number;
  /** Set by the game; the engine re-links all entities while it is non-zero and decrements it. */
  force_retouch: number;
  /** Round-trips through changelevel. The game owns it; the engine only reads it. */
  readonly serverflags: number;

  init(mapname: string, serverflags: number): void;
  shutdown(isCrashShutdown: boolean): void;
  startFrame(): void;

  PlayerPreThink(clientEdict: ServerEdict): void;
  // ... PostThink, ClientConnect/Disconnect/Kill, PutClientInServer, optional ClientBegin ...

  getClientEntityFields(): Record<string, string[]>;
  prepareEntity(edict: ServerEdict, classname: string, initialData?: EdictData): boolean;
  spawnPreparedEntity(edict: ServerEdict): boolean;
  serialize(): SerializedData;
  deserialize(data: SerializedData): void;
}

export interface ServerGameConstructor {
  new (engineAPI: ServerEngineAPI): ServerGameInterface;
  Init(serverEngineAPI: ServerEngineAPI): void;
  Shutdown(): void; // reserved: the engine has no module-unload path yet, JSDoc says so
}
```

`ClientGameInterface`/`ClientGameConstructor` get the same treatment in Phase 3. Every field is
documented with who writes it and when: that is the lifecycle doc the members never had.

### B. The engine consumes the shared type

- Delete `ServerRuntimeGameAPI`. `ServerState.gameAPI` becomes `ServerGameInterface | null`.
- `new activeGameModule.ServerGameAPI(ServerEngineAPI)` replaces `Reflect.construct` plus cast.
  Same for the client.
- Delete the `& { time: number }` casts (narrow with `SV.server.gameAPI!` plus
  `console.assert`, per the hot-path guidance in `typescript-port.instructions.md`).
- Delete the dead `self` save/restore block in `Host.DropClient`; the `serverflags` `in` guard
  in `SV.SaveSpawnparms` becomes a plain read. `ClientBegin` keeps its existing conditional.

### C. Conformance is asserted at the game module boundary

1. Move `GameModuleIdentification` and `GameModuleInterface` from
   [GameModule.ts](../source/engine/common/GameModule.ts) into `shared/GameInterfaces.ts`;
   `GameModule.ts` re-exports them so engine imports don't churn. This also removes the
   id1 → engine import in `main.ts`.
2. Each game's `main.ts` asserts `satisfies GameModuleInterface` over its
   `{ identification, ServerGameAPI, ClientGameAPI }` (Phase 2: only the server half, via
   `Pick`). That single check covers constructor signature, statics and identification.
   Exact spelling (extra exported const vs. a bare expression) gets settled against ESLint in
   Phase 2; the requirement is no runtime change.
3. id1's `ServerGameAPI` gets `implements ServerGameInterface`, so instance-side drift is
   reported on the class member, not at the module. Hellwave inherits it.

### D. Client side (Phase 3)

Same split. Fix `ViewmodelConfig.model` to `BaseModel | null`. Declare
`static Shutdown(engineAPI: ClientEngineAPI)` (both games already agree; the engine doesn't call
it yet). Replace `Reflect.construct` in `ClientServerCommandHandlers.ts`. Widen the `main.ts`
assertion to the full `GameModuleInterface`.

### E. Docs (Phase 4)

JSDoc is the source of truth (per CLAUDE.md "Where new knowledge goes"). Add a short
`docs/game-module-contract.md` with the call order (`Init` → construct → `init` → frame loop →
`shutdown`) and who writes which field, linked from `docs/README.md`. Keep it game-agnostic:
id1/hellwave appear only as labeled examples. Fix the SetSpawnParms paragraph in the id1
README.

### F. Make `tsc` green and enforced (Phase 1)

1. **Fix the bug behind the baseline error.** `HellwaveBackpackEntity._collectItems` accepts
   `priorItems: number` and forwards it to `super`. The two one-argument calls in the hellwave
   test get the second argument, and a regression test uses a backpack with non-zero `items`,
   modeled on id1's existing
   [items.test.mjs:190](../source/game/id1/test/entity/items.test.mjs#L190). This is a
   behavior fix, not only a type fix: hellwave backpacks will stop announcing items the player
   already owns.
2. **Gate the Cloudflare build.** `build:wrangler` becomes
   `npm run typecheck && npm run test && npm run build:production`. Typecheck goes first: it
   takes about 2.5 s and fails fastest.
3. **Gate the Docker `test` stage** with `RUN npm run typecheck`. The `builder` stage already
   copies `tsconfig.json`, `dedicated.ts` and `source/` and installs devDependencies
   (`typescript`, `@types/node`), so no new `COPY` lines are needed. The
   `dockerfile-fixture-sync` skill still applies as the check, and the exact placement
   (`RUN` in the `test` stage vs. changing its `CMD`) is settled during Phase 1.
4. **Consequence, stated plainly:** from this phase on, any type error fails the Cloudflare
   build and the Docker test target.

## Phasing

1. **Green baseline and enforcement.** Design F. Touches hellwave `entity/Items.ts` and its
   test (untracked directory, so no git safety net: minimal edits, all listed under "What
   actually shipped"), `package.json` and `Dockerfile`. No engine or id1 changes. Lands first
   so every later phase is enforced from the moment it merges.
2. **Server contract and module-contract move.** Design A, B, C (server half). Touches
   `source/shared/`, engine (`Server.ts`, `Host.ts`, `GameModule.ts`, two physics files), and
   **id1** (`GameAPI.ts` `implements`, `main.ts` import + `satisfies`), which needs the
   `submodule-aware-commit` flow: commit in the submodule first, then bump the pointer. The
   submodule already has unrelated uncommitted edits of yours (a comment in `GameAPI.ts`, a
   staged `Triggers.ts`); they stay out of my commits. Plus hellwave `main.ts`.
3. **Client contract.** Design D. Touches shared, `ClientServerCommandHandlers.ts`,
   `ClientState.ts` typing, and id1's `client/ClientAPI.ts` (submodule again). Widens the
   `main.ts` assertion to the full `GameModuleInterface`.
4. **Docs and follow-up.** Design E, plus writing the stub for `plans/game-entity-contract.md`.

Each phase is independently shippable. Stop at each boundary for a go-ahead, then append
"What actually shipped in Phase N" here.

### What actually shipped in Phase 1

Design F as planned, no deviations in scope. Files touched:

- `source/game/hellwave/entity/Items.ts`: `HellwaveBackpackEntity._collectItems` now takes
  `priorItems: number` and forwards it to `super`; JSDoc gained a description and `@param`s.
- `source/game/hellwave/test/hellwave-items-zones.test.mjs`: the two existing calls pass `0`
  as `priorItems`; new test "forwards the pre-pickup item flags so an already owned weapon is
  not announced again". Run against the unfixed code it failed as predicted
  (`actual: ['Shotgun', 'Q250']`, `expected: ['Q250']`), and passes after the fix. The file
  is at 11/11.
- `package.json`: `build:wrangler` is `npm run typecheck && npm run test && npm run build:production`.
- `Dockerfile`: `RUN npm run typecheck` in the `test` stage, before `CMD`. No new `COPY` lines.

Placement decision (the open question): a `RUN` rather than a change to `CMD`, because a `RUN`
fails `docker build --target test` itself, which any CI has to run whether or not it also
starts the container.

Verification:

- `npm run typecheck` exits 0 (it had one error). ESLint is clean on both touched files and
  `--fix` changed nothing beyond my edits.
- **Negative gate check:** with the original buggy `Items.ts` put back, `npm run build:wrangler`
  exits 2 at the typecheck step (`TS2554`) and `npm run test` never starts. The fixed file was
  restored and byte-compared afterwards.
- **Full run:** `npm run build:wrangler` end to end: typecheck clean, 1288 of 1288 tests pass,
  production build succeeds, about 18 s in total.
- **Docker:** `docker build --target test .` succeeded from a cold cache (about 30 s). The new
  `[test 5/5] RUN npm run typecheck` step ran `tsc` with no errors in 3.0 s, so the `builder`
  stage's existing `COPY` list is sufficient, as the file-set mirror predicted. The temporary
  image was removed afterwards. I did not run the negative case in Docker itself (a failing
  `RUN` failing the build is standard Docker behavior); the negative check above was done
  through `npm run build:wrangler`.

Worth knowing: `source/game/hellwave/` is untracked, so none of the hellwave edits are in git
yet. Committing that directory stays your call. Until it is committed, a CI checkout does not
contain it and the gate has nothing to catch there. Any type error in tracked code, including
Phases 2-3 below, does fail the Cloudflare build and the Docker test target from now on.

### What actually shipped in Phase 2

Design A, B and C (server half) as planned. Files touched:

- `source/shared/GameInterfaces.ts`: `ServerGameInterface` is now an `interface` (`time`,
  `frametime`, `force_retouch`, `readonly serverflags`, plus the hooks), every member with a
  JSDoc saying who calls or writes it and when. `ServerGameConstructor` is an interface with
  `new (engineAPI)`, `Init` and the reserved `Shutdown`. Removed from the contract:
  `SetNewParms/SetSpawnParms/SetChangeParms` and the three statics (Decision 4). The types
  `ServerInfoField`, `MapDetails` and `StartServerListEntry` stay exported, now documented as
  game-side helper shapes. `GameModuleIdentification` and `GameModuleInterface` moved in.
- `source/engine/common/GameModule.ts`: re-exports those two types from shared.
- `source/engine/server/Server.ts`: `ServerRuntimeGameAPI` deleted (with its unused imports),
  `gameAPI: ServerGameInterface | null`, `new activeGameModule.ServerGameAPI(ServerEngineAPI)`
  instead of `Reflect.construct` plus cast, `SaveSpawnparms` reads `serverflags` directly.
- `source/engine/common/Host.ts`: the dead `self` save/restore in `DropClient` is gone.
- `ServerClientPhysics.ts`, `ServerArea.ts`: the `& { time: number }` casts became
  `SV.server.gameAPI!` behind a `console.assert`. The `PlayerPreThink/PostThink` calls still
  read `SV.server.gameAPI!` fresh, so the edge case of the game API disappearing mid-frame
  behaves exactly as before.
- id1 (`GameAPI.ts`, `main.ts`) and hellwave (`main.ts`): `implements ServerGameInterface` on
  id1's class (hellwave inherits it) and a `satisfies` assertion in each `main.ts`. Hellwave's
  `identification` had no type check at all before; its `version` was a plain `number[]`.
- `plans/menu-rework.md`: two correction notes for Decision 4.

Deviation, the `satisfies` spelling: a bare expression statement,
`({ identification, ServerGameAPI }) satisfies Pick<GameModuleInterface, ...>;`. ESLint accepts
it, so there is no extra export and no runtime footprint beyond a discarded object. Until
Phase 3 fixes `ClientGameConstructor` it covers the server half only, via `Pick`.

Tests: `game-module.test.mjs` gained the missing-`ServerGameAPI` case;
`test/server/server.test.mjs` (new) covers `SV.SaveSpawnparms`;
`test/common/host-drop-client.test.mjs` (new) covers `Host.DropClient`, with a strict game API
that throws on any member other than `ClientDisconnect`. Run against the old `Host.ts` that
test fails (`unexpected read of game API member self`); the other two DropClient tests pass on
both versions, confirming the rest of the behavior is unchanged. Suite: 1294 of 1294 (was 1288).

Verification:

- `tsc` clean. ESLint: zero warnings on every touched file except 29 `unbound-method`
  warnings in `Host.ts`, identical when linting the `HEAD` version, so none are new.
- **Negative checks**, all reverted and byte-compared afterwards: renaming `startFrame` in
  id1 errors on the class itself (TS2420 "incorrectly implements") and at `main.ts`; changing
  hellwave's constructor parameter type errors at hellwave's `main.ts`; dropping id1's static
  `Init` errors at id1's `main.ts`. The constructor mismatch is exactly the one the original
  probe found and nothing used to report.
- **Dedicated server smoke, both games:** id1 (`+exec server.cfg`, coop e1m1) and hellwave
  (`-basedir librequake -game hellwave +map hw_e1m2`) both load the module, construct the game
  through the new path, run `init`, spawn the map ("Server spawned.") and stay up through the
  frame loop for 20 to 30 s with no errors or assertion failures. Hellwave needs LibreQuake as
  its base: with the default `id1` base it dies on a missing `progs/g_shot1.mdl`, a content
  dependency noted in [Weapons.ts:70](../source/game/hellwave/entity/Weapons.ts#L70), unrelated
  to the contract.
- **Not exercised:** client connect (`ClientConnect`, `PutClientInServer`, `ClientBegin`,
  `PlayerPre/PostThink`), `changelevel` and savegames. A headless dedicated server has no
  console input and no client, and startup arguments cannot sequence a `changelevel` after the
  deferred `map` spawn. `SV.SaveSpawnparms` and `Host.DropClient` are covered by the new unit
  tests only, not by a live run. *(Update: the Phase 3 browser pass later exercised client
  connect, `PlayerPre/PostThink` and the `DropClient` path live on both games. `changelevel`
  and savegames are still untested live.)*
- `npm run build:wrangler` end to end: typecheck clean, 1294 of 1294 tests, production build
  succeeds, about 15 s. Docker was not re-run: the Dockerfile is unchanged since Phase 1 and the
  only new files are tests under `test/`, which the `builder` stage copies wholesale.

The id1 changes sit uncommitted in the submodule working tree (`GameAPI.ts`, `main.ts`). When
committing, follow `submodule-aware-commit`: commit inside `source/game/id1` first, then bump
the pointer in the outer repo.

### What actually shipped in Phase 3

Design D as planned. Files touched:

- `source/shared/GameInterfaces.ts`: `ClientGameInterface` is now an `interface`, every member
  documented with who calls or writes it and when. `ClientGameConstructor` is an interface with
  `new (engineAPI)`, `Init`, the reserved `Shutdown(engineAPI)`, `GetStartGameInterface`,
  `GetClientEdictHandler` and `IsServerCompatible`. `ViewmodelConfig.model` is now
  `BaseModel | null` (the engine already handled null), and since nothing else used
  `ViewmodelConfig` it became a `readonly` interface. `clientdata` and `viewmodel` are
  `readonly` on the contract: the engine never reassigns them, it writes *into* `clientdata`'s
  contents.
- `source/engine/client/ClientServerCommandHandlers.ts`: `new activeGameModule.ClientGameAPI(ClientEngineAPI)`
  replaces `Reflect.construct` plus cast, and the now-unused type import is gone. The plan
  expected a typing change in `ClientState.ts`; none was needed, it already held
  `ClientGameInterface | null`.
- id1 `client/ClientAPI.ts`: `implements ClientGameInterface` (hellwave inherits it). Both
  `main.ts` files now assert the full `satisfies GameModuleInterface`; the server-only `Pick`
  from Phase 2 is gone.

Tests: three cases added to `test/client/client-server-command-handlers.test.mjs`, driving the
real `parseServerMessage` with a serverdata payload: the client game is constructed with
`ClientEngineAPI` after `IsServerCompatible` accepted the server, an incompatible server is
rejected before construction, and a server running a different game is rejected before either.
Because `new X(a)` behaves exactly like `Reflect.construct(X, [a])`, these lock the behavior in
rather than fail on the old code. To check they can fail, I mutated the engine twice (wrong
constructor argument; constructing before the compatibility check) and each mutation was
caught by exactly the intended test, then restored byte-identical. Suite: 1297 of 1297.

Verification:

- `tsc` clean, ESLint zero warnings on every touched file. **The original scratch probe, which
  reported 6 errors before this plan, now reports none** (server and client, instance and
  constructor sides).
- **Negative checks**, all reverted and byte-compared: renaming `startFrame` errors on the id1
  class and at both `main.ts` files; dropping `IsServerCompatible` errors at id1's `main.ts`;
  giving `Shutdown` an extra required parameter errors at `main.ts` with the same "too few
  arguments" message the original probe found (the bug class nothing used to report); a
  wrongly typed `viewmodel` errors at hellwave's `main.ts`.
- `npm run build:wrangler`: typecheck clean, 1297 of 1297 tests, production build succeeds.
- **Real browser** (`browser-ui-verification` recipe: cached Chromium with software GL,
  Playwright symlinked into a scratch directory, my own scratch dedicated servers on ports
  3001 and 3002 built from this tree; nothing already running was touched):
  - *Remote client, id1:* `connect self` over WebSocket reached signon 4, the client game was
    constructed, the engine wrote the server's `clientdata` into it (health 100), the viewmodel
    had a visible model, and screenshots show the status bar and shotgun drawn in E1M1. After
    holding forward and firing, the view had moved and ammo went from 25 to 24, so the
    server-to-client `clientdata` round trip works live. `disconnect` cleared the client game
    and returned to the main menu. The server log shows `Client player removed` (the
    `DropClient` path from Phase 2) and no errors.
  - *In-browser listen server, id1:* `map e1m1` constructed the server-side `ServerGameAPI`
    inside the browser bundle (its `time` advanced from 5.3 to 8.7 as the engine wrote it each
    frame), plus the client game over loopback. Disconnect cleared both.
  - *Hellwave* (`?game=hellwave` against a `-basedir librequake -game hellwave` server): its own
    client subclass was constructed (a different class than id1's), and its own HUD drew (round
    timer, money, round counter, status bar). Disconnect cleared it.
  - Zero console errors and zero uncaught exceptions in every run. The only failed requests
    were optional-asset 404s (`gfx/conback.png`, `gfx/concharslarge.png`, `progs/beam.mdl`, and
    for hellwave a few boss and slime sounds plus `music/*.opus`). They look unrelated to this
    change but I did not compare against a pre-change build.
- **Not verified:** pointer lock, mouse look and hover (headless Chromium never grants Pointer
  Lock; this phase touches no input code, but it stays a live-test item if you want that
  confirmed). No menu item was clicked. Client-side `saveGame`/`loadGame` and `changelevel`
  were not exercised, and `handleClientEvent` only saw whatever normal movement and firing
  produced.
- **Side effect of running the servers:** the engine rewrote `data/id1/config.cfg` and
  `data/hellwave/config.cfg`. Both are gitignored cvar archives that the engine re-serializes
  from the values it loaded at boot, so they are very likely equivalent, but I had no earlier
  copy to diff against.

The id1 changes (`GameAPI.ts`, `client/ClientAPI.ts`, `main.ts`) are still uncommitted in the
submodule working tree; see the note under Phase 2 for the commit order.

### What actually shipped in Phase 4

Design E, widened into a documentation sweep: every place that describes the boundary, the
build, or the tests was searched for stale statements. New and changed files:

- **New:** [docs/game-module-contract.md](../docs/game-module-contract.md) (the two directions,
  how a game asserts the contract, identification and capabilities, the server and client
  call order, who writes which field, what is not part of the contract, and a checklist for
  changing it), linked from `docs/README.md`. Game-agnostic: id1 appears only as an example.
- **New:** [game-entity-contract.md](game-entity-contract.md), the stub for the follow-up plan,
  recording what was found about the entity side and the open questions. Nothing decided.
- **id1 README** (submodule): the spawn-parameter paragraph no longer describes the removed
  `Set*Parms` hooks (and its broken backtick is fixed), and now says the calls go to the player
  entity. `ServerGameAPI.StartFrame` is `startFrame`. "Loading the GameModule" no longer says
  `CL.Init` imports the client code, and now says instances are created per map. The connect and
  disconnect lists gained the optional `ClientBegin`, the savegame-restore exception and the
  `ClientDisconnect` conditions. A new "The contract" bullet points at the interfaces.
- **Instruction files:** `build-and-deploy` (typecheck is a separate step and gates
  `build:wrangler` and the Docker test stage), `unit-tests` (tests are not type-checked),
  `source-directories` (where the contract lives). `CLAUDE.md` and `.github/copilot-instructions.md`
  got the `npm run typecheck` line, and the `dockerfile-fixture-sync` skill notes that the `test`
  stage now runs `tsc`.
- **JSDoc:** two `GameAPIs.ts` comments pointed `GetStartGameInterface` at the wrong type, and are
  fixed. The audit also **corrected several statements I had written in Phases 2 and 3**, which
  overclaimed against the code: `shutdown` is not called on a changelevel (server or client),
  `ClientDisconnect` is skipped for connection failures, the client game instance is created per
  map rather than per connection, and `time` is the scheduled time while an entity's think runs.
- **Plans:** a resolution note in `hellwave-lobby-cards.md`, which had called the hellwave `tsc`
  error unrelated (it was the real bug fixed in Phase 1).

Verification: `npm run build:wrangler` green (1297 of 1297 tests), ESLint and `tsc` clean on the
changed source files, and every relative link in the touched markdown files resolves. The only
broken links found are five in `plans/menu-rework.md` that point at `Multiplayer.ts`, which that
plan's own Phase 2 deleted; they pre-date this work and I left them. (Since unlinked: on
2026-09-21 the `Multiplayer.ts` references in `menu-rework.md` became plain code references.)

#### Lifecycle gaps found while documenting

These are facts about current behavior, now documented in `docs/game-module-contract.md`. Fixing
them is the "finish the lifecycle later" work from Open question C, not part of this plan:

- `shutdown` is not called when a changelevel replaces the game instance, on the server
  (`SV.SpawnServer` swaps it in `#loadGameProgs`) or on the client (`parseServerData` swaps it).
  Nothing in id1 or hellwave relies on it today: id1's `_shutdownHooks` are never pushed to.
- The static `Shutdown` hooks are never called, as already recorded.
- `isCrashShutdown` is never `true`: no engine path raises it.
- `ClientDisconnect` is skipped for a client dropped because its connection failed, so a game
  cannot use it as its only cleanup for a departing player.

## Testing

- **Type level (the actual test):** from Phase 1 on `npm run typecheck` must exit 0. Per
  contract phase, run one manual negative check: rename a member in id1's `ServerGameAPI`,
  confirm `tsc` fails at `implements`/`satisfies`, revert. Record the result under "What
  actually shipped".
- **Phase 1:** a hellwave regression test that fails before the fix and passes after
  (backpack with non-zero `items`; owned item is not listed, new item is). Gate check:
  introduce a deliberate type error, confirm `npm run build:wrangler` fails at the typecheck
  step before `test` starts, revert. Docker is installed here, so `docker build --target test .`
  is possible if `data/id1/pak0.pak` (copied by the `test` stage) is present; if not, I'll say
  so and lean on the file-set mirror already run for this plan.
- **New unit tests (Phase 2):** `SV.SaveSpawnparms` copies `gameAPI.serverflags` into
  `SV.svs.serverflags`. `Host.DropClient` calls `ClientDisconnect` exactly once for a spawned
  client, and not on the crash path (regression for the deleted `self` block).
  `validateGameModuleContract` rejects a module without `ServerGameAPI` (only the
  `ClientGameAPI` case is covered in
  [game-module.test.mjs](../test/common/game-module.test.mjs)). New files go under existing
  `test/` depth to avoid the `test-glob-coverage` trap.
- **Existing:** `npm test` and `npx eslint --fix` on every touched file, green at each boundary.
  Physics tests mock `gameAPI: { time: 0 }` in `.mjs`, so they are unaffected.
- **Smoke, Phase 2 (server-only, no UI):** boot the dedicated server with id1, load a map,
  changelevel (exercises construct, `init`, frame loop, `serverflags` round-trip). If game data
  isn't available in this environment, I'll say so instead of claiming it passed.
- **Real browser, Phase 3:** the client construction path changes. Run the
  `browser-ui-verification` recipe: load id1, start a map, confirm the HUD draws and the
  viewmodel shows. No input code changes, so the pointer-lock caveat doesn't apply. The
  connect-handler construction path has thin unit coverage, so the browser pass carries most of
  the weight there.

## Open questions

None. The design forks and the earlier open questions are all settled (see Context).
Implementation-time checks that were open are resolved: Docker gate placement (a `RUN` in the
`test` stage) and the local `docker build --target test .` in Phase 1, and the `satisfies`
spelling (a bare expression, which ESLint accepts) in Phase 2.
