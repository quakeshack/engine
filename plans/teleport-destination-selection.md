# Vacancy-aware, randomized teleport destinations (telefrag as a last resort)

**Status:** Not started (checked 2026-09-21). There is no `ServerEngineAPI.FindInBox` and no
feature flag in `featureFlags.ts`, and `TeleportTriggerEntity.touch` is not split yet. The only
related change in the tree is id1 commit `16a2b22` ("teleport code cleanup, preparing for new
features"), a small tidy-up of `Triggers.ts`. No open question blocks it (see "Open questions";
two assumptions there were never confirmed), so Phase 1 can start with a go-ahead.

## Context

NPCs that funnel through a `trigger_teleport` (Hellwave's `hw_doom` has a nav-linked one that
leads to a secret area) telefrag each other on arrival. Reading the code, three things add up
to that:

1. **Only one destination is ever used.** `TeleportTriggerEntity.touch`
   ([Triggers.ts:376](../source/game/id1/entity/Triggers.ts#L376)) resolves the target with
   `findFirstEntityByFieldAndValue('targetname', this.target)`. A second
   `info_teleport_destination` with the same `targetname` is silently ignored, so "a teleporter
   that reaches multiple destinations" is not a thing yet. This plan adds it.
2. **The telefrag is unconditional.** Right after picking the destination, `touch` spawns a
   `TelefragTriggerEntity` (`misc_teledeath`) at the destination, owned by the traveler
   ([Triggers.ts:391](../source/game/id1/entity/Triggers.ts#L391)). It lives 0.2 s, sets
   `force_retouch = 2`, and kills every damageable entity overlapping the traveler's hull
   plus one unit on each side ([Player.ts:2092-2124](../source/game/id1/entity/Player.ts#L2092-L2124)).
   One special rule: when a *monster* lands on a *player*, the monster dies instead
   ([Player.ts:2100-2105](../source/game/id1/entity/Player.ts#L2100-L2105)).
3. **Arrivals stack on one spot.** With a single destination, the second NPC arriving before
   the first has walked off kills it. With players standing in the secret area, arriving NPCs
   also kill *themselves* (rule above).

Same-frame arrivals are not a separate problem: `Edict.setOrigin` relinks immediately
([Edict.ts:597](../source/engine/server/Edict.ts#L597)), so a later traveler in the same frame
already sees the earlier one at its destination.

### Data check: is randomizing safe for shipped maps?

Scanned the entity lumps of the 38 maps in `data/id1/pak0.pak` and `pak1.pak` that contain a
`trigger_teleport`. Exactly one map has two destinations with the same `targetname`: `e2m2`
(`t1`, at `-448 264 -56` and `-360 888 24`). They are mutually exclusive by spawnflags
(`1792` = not on any skill = deathmatch-only, `2048` = not in deathmatch), so at most one
survives the spawn filter. No shipped map relies on "first destination wins" with two live
destinations. The scan script and the `hw_doom` structure were deliberately not used further:
`hw_doom` has no multiple destinations yet.

### Decisions already made with the developer

- The randomized multi-destination behavior is **behind a feature flag** (id1's existing
  `featureFlags` mechanism, [featureFlags.ts](../source/game/id1/featureFlags.ts)).
- Selection rule: prefer vacant destinations; only when **all** are blocked, telefrag a random
  one and put the traveler there.
- Spatial query: a **new `ServerEngineAPI.FindInBox`** (see E), not a hand-rolled box test in game
  code and not `FindInRadius`.
- All-occupied fallback: a non-player traveler **prefers destinations without a player on them**
  (see D); a plain random pick only when every destination has a player.
- Map authoring for a live test is the developer's job; ask when Phase 3 needs it.

## Goals

- A `trigger_teleport` whose `target` matches several destinations picks a random **vacant**
  one; a destination is vacant when the telefrag it would spawn has nothing to kill.
- Telefrag happens only when every candidate is occupied; the traveler then goes to a random
  candidate and the existing telefrag machinery runs unchanged.
- Flag off (the id1 default) is bit-for-bit today's behavior: first destination, telefrag
  trigger always spawned.
- Enabled in Hellwave. Applies to every traveler, players and NPCs alike.

## Non-goals (this pass)

- **Navigation.** `Navigation.#buildTeleporterLinks` links a teleporter to the first
  destination only ([Navigation.ts:1553](../source/engine/server/Navigation.ts#L1553)). That is
  fine while a teleporter's destinations sit in the same area (the secret-area case); paths
  through spread-out destinations would be mispredicted until the NPC re-paths after arrival.
  The engine cannot see the game's flag, so linking all destinations needs its own design.
- Waiting or queueing instead of telefragging when everything is blocked.
- Changing who a telefrag kills, or the lifetime of `misc_teledeath`.
- World geometry: a destination inside a wall for a large-hull monster stays as it is today.
- The lingering-trigger window: a fast traveler (a player) can leave a spot before its
  `misc_teledeath` expires (0.2 s), and a second traveler landing there in that window is still
  killed. NPCs stay overlapping the spot for the whole window, so they are not affected.
- Reusing the occupancy query for deathmatch spawn selection
  ([Player.ts:706](../source/game/id1/entity/Player.ts#L706) uses `FindInRadius(spot.origin, 32)`).
  A natural follow-up once the query exists.

### Adjacent finding (not part of this work)

`ServerGameAPI._isPreparingEntityAllowed` ([GameAPI.ts:548](../source/game/id1/GameAPI.ts#L548))
applies the skill bits (256/512/1024) in deathmatch too. FTE filters `NOT_DEATHMATCH` in
deathmatch and the skill bits only outside it
([pr_cmds.c:1889-1902](/home/cr/Work/private/fteqw/engine/server/pr_cmds.c)). Ran the function
with e2m2's two `t1` spawnflags: in deathmatch **both** destinations are dropped at every skill
level, so that teleporter has no target there. Probably affects every deathmatch-only entity
(`1792`) in the shipped maps. Not touched here; wants its own look.

## Design

### A. Feature flag

Add `'randomized-teleport-destinations'` to `FeatureFlag` in `featureFlags.ts`, off in the id1
defaults (vanilla parity, same as the other non-vanilla flags except `improved-gib-physics`),
pushed on in [hellwave/GameAPI.ts:30](../source/game/hellwave/GameAPI.ts#L30). Checked with
`this.game.hasFeature(...)` (mockable, unlike a module-level `featureFlags.includes`). Document
it in the id1 README's flag list and its `FeatureFlag` snippet.

One flag covers both halves: vacancy avoidance without multiple destinations is a no-op (the
single candidate is chosen and telefragged, exactly as today).

### B. Split `TeleportTriggerEntity.touch`

`touch` is ~65 lines doing guards, effects, lookup, telefrag and delivery. Split it into small
private methods; no behavior change with the flag off:

- `#collectDestinations()`: flag off returns `[findFirstEntityByFieldAndValue(...)]` filtered as
  today (keeps the existing unit test valid unmodified, which stubs exactly that call); flag on
  returns every `findAllEntitiesByFieldAndValue('targetname', target)` hit that is an
  `InfoTeleportDestination` or `TeleportTrainEntity`.
- `#pickDestination(traveler, candidates)`: see D.
- `#deliver(traveler, destination)`: today's tail of `touch` (tfog in front, telefrag trigger,
  `setOrigin`, angles, player lock-down, `FL_ONGROUND`), moved verbatim.

### C. `TelefragTriggerEntity` owns the definition of "occupied"

The vacancy test must match what the telefrag would really kill, or a "vacant" pick could still
kill someone. So the rule lives next to the trigger, not in the teleporter:

- `static bounds(traveler)`: the hull plus/minus one unit, extracted from `spawn()` so both the
  trigger and the query use one source.
- `static findVictims(engine, traveler, origin)`: entities other than the traveler that overlap
  those bounds at `origin`, are solid (`SOLID_SLIDEBOX`/`SOLID_BBOX`) and have
  `takedamage !== DAMAGE_NO`. `DamageHandler._killed` already sets `takedamage = DAMAGE_NO` on
  death, and non-solid corpses are not in the area tree, so this excludes items, triggers,
  doors and corpses the same way `touch` effectively does. (`canReceiveDamage` is *not* the
  right predicate: it is a line-of-sight check for explosions.)

Traveler-side helper, also on the trigger: a candidate is **lethal for the traveler** when the
traveler is not a player and a player is among the victims (the `touch` rule above).

### D. Choosing

```
candidates = collect()
if flag off or candidates.length <= 1  -> candidates[0]
vacant = candidates with no victims
if vacant is not empty                 -> random(vacant)
pool = candidates that are not lethal for the traveler   (if any, else all)
                                       -> random(pool), telefrag machinery runs as today
```

The telefrag trigger is still spawned unconditionally in `#deliver`, even for a vacant pick.
The query only *chooses where to go*; the trigger stays the single authority on killing, which
keeps the change small and makes "flag on, one destination" identical to today. Skipping the
spawn on a vacant pick would save a `force_retouch` pass per teleport; possible later, not now.

### E. Spatial query: `ServerEngineAPI.FindInBox`

The query needs "linked entities overlapping this box". `Octree.queryAABB` already does an exact
inclusive `absmin/absmax` overlap ([Octree.ts:251](../source/shared/Octree.ts#L251)), which is the
rule the trigger touch uses, and `FindInRadius`
([GameAPIs.ts:591](../source/engine/common/GameAPIs.ts#L591)) is a thin layer over it. Add
`FindInBox(mins: Vector, maxs: Vector, filterFn: ServerEntityFilter = null): ServerEdict[]` next to
it with the same shape (skip edict 0 and free edicts, then apply the filter, return an array
because the linked lists can change while iterating). Game-agnostic JSDoc; no other contract
file lists engine methods, so nothing else to update.

### F. Docs

Update the QUAKED comments on `info_teleport_destination` and `trigger_teleport`
([Triggers.ts:308-337](../source/game/id1/entity/Triggers.ts#L308-L337)): with the flag on,
several destinations may share a `targetname`. README flag entry. JSDoc on any new public API.

## Phasing

Each phase ends with `npx eslint --fix` on touched files, `npm run typecheck`, and the relevant
tests green. Stop for a go-ahead at each boundary.

1. **Engine query API**: `ServerEngineAPI.FindInBox` plus a `describe` in
   [test/common/game-apis.test.mjs](../test/common/game-apis.test.mjs). Outer-repo commit.
2. **id1 game logic**: flag, `TelefragTriggerEntity` bounds/victims refactor, `TeleportTriggerEntity`
   split and selection, README and QUAKED docs, tests. Commit inside the `source/game/id1`
   submodule first, then bump the pointer (`submodule-aware-commit`).
3. **Hellwave + live check**: push the flag in `hellwave/GameAPI.ts`, then a real play-through on
   a map with at least two destinations sharing a `targetname`. That map is needed from the
   developer at this point. `hellwave` is a plain directory, committed normally.
4. **Follow-ups, not started without a go-ahead**: nav links to all destinations; reuse of the
   victim query for deathmatch spawn selection; the lingering-trigger window.

## Testing

Game tests in [triggers.test.mjs](../source/game/id1/test/entity/triggers.test.mjs) (existing
directory, so no glob or Dockerfile changes). The mock game API gets `hasFeature` (default
`() => false`); pin `Math.random` and restore it in `finally`, per the unit-test guide.

- Flag off, two same-named destinations: always the first, telefrag trigger spawned
  (regression; the existing teleport test must pass unmodified).
- Flag on, one destination, occupied or not: same as flag off.
- Flag on, first destination occupied: goes to the second, and nothing is killed.
- Flag on, several vacant: the random pick only ever lands on a vacant one (pin `Math.random`
  to both ends of its range).
- Two travelers in one frame with a stateful `setOrigin` mock: they take different spots.
- All occupied by monsters: random pick, telefrag trigger spawned at it.
- All occupied, one by a player: a monster traveler avoids it; a player traveler may take any.
  All occupied by players: a monster traveler falls back to a plain random pick.
- `TelefragTriggerEntity.findVictims`: excludes the traveler, triggers, `DAMAGE_NO` entities and
  non-solid ones; includes monsters and players; the one-unit margin (touching at distance 1 is
  in, distance 2 is out).
- Candidate filtering: `TeleportTrainEntity` accepted, wrong classes ignored.
- Hellwave: a small assertion that its flag list contains the new flag.
- Engine (phase 1): `FindInBox` returns overlapping edicts, skips free ones and edict 0, applies
  the filter.

Unit tests cannot show it feels right: the live check in phase 3 is the only real evidence that
NPCs stop killing each other. Not UI-facing, so no browser pass.

## Open questions

None blocking. Resolved with the developer:

1. **Spatial query**: new `ServerEngineAPI.FindInBox`. Rejected: `FindAllByFilter` plus a box test
   in game code (hand-rolls an AABB check in game code, against the spirit of
   `architecture.instructions.md`), and `FindInRadius` with a generous radius (has precedent at
   [Player.ts:706](../source/game/id1/entity/Player.ts#L706), but the radius has to cover the largest
   possible hull pair, which the game cannot know).
2. **All-occupied fallback**: a non-player traveler prefers destinations without a player on them,
   because landing on a player kills the NPC. In the secret-area case players are likely standing
   there, so a plain random pick would sometimes kill the arriving NPC instead of the NPC it lands on.

Assumed, not asked. Say so if wrong:

- The flag is off in id1's defaults and on only in Hellwave.
- Player travelers get the same vacancy-first selection. It only matters where a mapper has given
  one `targetname` to several destinations *and* the flag is on.
