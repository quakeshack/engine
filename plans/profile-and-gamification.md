# Player profiles, stats & gamification — base infrastructure

**Status:** Not started (checked 2026-09-21). `ServerClient.uniqueId` still returns `'N/A'`, there is
no client identity code, and the master-server has no D1 binding or Profile API. The design is
otherwise untouched, with one exception: the menu slot that Phase 4 was meant to fill no longer
exists, see "Context" and "Open questions". File and line references are as of writing
(2026-07-18).

## Context

Today there is no concept of a player that persists beyond a single connection. A client is
identified purely by two Cvars, `name` and `color`, sent as plaintext stringcmds during the
connect handshake (`ClientConnection.ts:283-285`, wired up by `CL.ConfigureConnectionIdentity`
at [CL.ts:132](../source/engine/client/CL.ts#L132)). There is no UUID, GUID, fingerprint, cookie,
or `localStorage`/`IndexedDB`-backed identity anywhere in the tree — the only existing
`localStorage` usage is COM's virtual filesystem for save games/configs, keyed as
`Quake.<gamedir>/<filename>` ([Com.ts:309,322,372-376](../source/engine/common/Com.ts#L309)), and
the dedicated server has an equivalent flat-file store under `data/<gamedir>/...`
([server/Com.ts:155-172](../source/engine/server/Com.ts#L155)). Neither is identity, both are assets.

Two things already exist as if waiting for this feature:

- **`ServerClient.uniqueId`** is a stub getter that always returns `'N/A'`
  ([Client.ts:194-196](../source/engine/server/Client.ts#L194)), with exactly one call site: the
  `status` command's per-client printout (`Host.Status_f`,
  [Host.ts:742-800](../source/engine/common/Host.ts#L742)). This is precisely the "public hash
  for display in `status`" the feature needs — it just has nothing behind it yet.
- **`ALLOWED_CLIENT_COMMANDS`** reserves a `'ban'` command
  ([Server.ts:147](../source/engine/server/Server.ts#L147)) with zero implementation anywhere —
  no ban list, no persisted store. A durable public ID is the missing prerequisite for ever
  banning someone by identity instead of by IP/name.

On the stats side, `GameStats` ([helper/GameStats.ts](../source/game/id1/helper/GameStats.ts))
already proves out the exact pattern this plan reuses: a class that subscribes to granular
server-side game events (`game.monster.killed`, `game.secret.found`, etc.) and mirrors state to
clients via `BroadcastClientEvent`/`DispatchClientEvent`. It is deliberately per-level and
ephemeral (reset on `reset()`), and `HellwaveStats` extends it the same way for round/squad state
([HellwaveStats.ts](../source/game/hellwave/helper/HellwaveStats.ts)). Per-player, the only
long-lived-ish field is `PlayerEntity.frags` (`Player.ts:353`), and even that resets every map.
Nothing persists across a disconnect today.

The event bus has most of the granularity a stats system needs, but two gaps matter here:

- `server.client.connected` fires in `SV.CheckForNewClients`
  ([Server.ts:352-379](../source/engine/server/Server.ts#L352)) *before* the `name` stringcmd
  arrives (`client.name` is still the literal `'unconnected'` at that point, line 340) — the same
  timing problem will apply to identity, so a new, later event is needed (see §C).
- `PlayerEntity.connected()`/`disconnected()` exist as methods
  ([Player.ts:2036,2049](../source/game/id1/entity/Player.ts#L2036)) but are never published on
  the event bus, and PvP frags are applied inline
  ([Player.ts:1989-2024](../source/game/id1/entity/Player.ts#L1989)) without a corresponding
  `game.player.*` publish the way `game.monster.killed`/`game.secret.found` do.

On the infrastructure side, `master-server` (Cloudflare Worker,
`/home/cr/Work/quakeshack/master-server`) is today a pure WebRTC signaling + server-browser
service: one global Durable Object (`SignalingSession`) with hibernation-safe KV-shaped storage
(`docs/STORAGE_PERSISTENCE.md`), plain `fetch`-based routing with no framework
(`src/index.ts:133-186`), and no D1/KV database configured at all (`wrangler.toml` only declares
the `SIGNALING_SESSION` Durable Object binding and a static-assets binding). There is no
account/profile concept there either. It is, however, the only Cloudflare-hosted, globally
reachable "official" service in the architecture (client-server-master, per
`architecture.instructions.md`), which makes it the natural home for anything that must outlive
any single dedicated/listen server.

Finally, the in-progress menu rework already has the intended UI slot: `MultiplayerMainMenu`
carries `// - player profile` as a TODO in both the disconnected and connected menu sketches
(`Multiplayer.ts:38,43`). Phase 4 below is meant to fill exactly that slot.

*(Update 2026-09-21: that slot is gone. [menu-rework.md](menu-rework.md) Phase 2 deleted
`Multiplayer.ts`, and the TODO comment did not move with the port. Two pages carry a player
identity today: id1's `multiplayer` page (name, colors, Join Game; `#buildMultiplayerPage` in
`source/game/id1/client/Menu.ts`) and hellwave's `hellwave_profile` page (name and colors;
`source/game/hellwave/client/menu/ProfileMenu.ts`). Phase 4 has to choose its host page again,
see "Open questions".)*

## Goals

- Every client gets one durable **private ID** and one derived **public ID** the first time it
  runs QuakeShack (or any official mod), surviving reconnects, map changes, and different
  servers.
- The public ID is safe to show in `status`, scoreboards, and (later) ban lists; the private ID
  never leaves the client except to authenticate to the profile service.
- A durable, cross-server home for stats/achievements that any official server (id1, hellwave,
  future mods) can contribute to and later read from.
- Reuse existing patterns wherever they fit (`GameStats`'s event-subscription model, the
  `name`/`color` handshake convention, `clientEvent` push-to-client pattern) rather than building
  a parallel mechanism.
- Ship in independently useful phases — stopping after any phase should leave something working.

## Non-goals (this pass)

- Cheat-proof stat integrity. V1 trusts servers that hold a shared key; this is fine for
  cosmetic stats/achievements and explicitly not fine for anything with real stakes.
- Account recovery or multi-device linking. Losing `localStorage` means a new identity in V1;
  flagged as a known limitation, not solved here.
- The actual achievement catalog. Phase 4 proves the pipeline with a small handful of example
  achievements, not full coverage of every monster/weapon/secret.
- XP/level formulas and gamification campaigns/reminders. Sketched in §I for direction only —
  they need their own plan once Phases 1-4 exist to build on.
- Anything involving the classic Quake UDP handshake (`CCREQ_CONNECT`/challenge) — irrelevant
  here, this engine only has WebSocket/WebRTC transports (`NetworkDrivers.ts`).
- GDPR/privacy/legal review beyond "stay pseudonymous by default." Called out as an open
  question, not resolved.

## Design

### A. Identity model — private ID + public ID

- **Private ID**: a `crypto.randomUUID()` generated once on first run and persisted locally.
  Never transmitted to a game server — only ever used to authenticate to the profile service
  (§E). Losing it (cleared storage, new device) means starting over as a new profile; that's an
  accepted V1 limitation, not a bug to work around.
- **Public ID**: a deterministic one-way derivation, e.g.
  `base32(sha256(privateId)).slice(0, 16)`. This is what's sent to game servers during connect
  (§B/§C), shown in `status`, and used as the primary key everywhere in the profile service
  (§D/§E). Because it's one-way, a server that observes it can't reconstruct the private ID and
  so can't authenticate as that player elsewhere — it only ever learns "this is the same
  pseudonymous player as before," which is exactly the "hash for public display / later banning"
  behavior asked for. No server-side secret/salt is needed for this derivation: a UUIDv4 already
  has 122 bits of entropy, so a plain hash of it isn't meaningfully "reversible" by an observer
  who doesn't already know the private ID.
- A privacy escape hatch: a client cvar (e.g. `cl_anonymous`) that, when set, sends a
  freshly-randomized public ID each connection instead of the persisted one, for players who
  don't want cross-session tracking. Cheap to add in Phase 1, worth doing up front rather than
  bolting on later.

### B. Client-side persistence & handshake wiring

- New small module, e.g. `source/engine/client/ClientIdentity.ts`, owning private-ID
  generation/persistence and public-ID derivation. It should **not** go through `COM`'s
  gamedir-scoped VFS (`Quake.<gamedir>/<filename>`) since identity is not a game asset and must
  outlive any single gamedir/mod — it needs its own storage key
  (`localStorage` in the browser; the dedicated/listen server's equivalent should reuse whatever
  non-gamedir-scoped mechanism `server/Com.ts` exposes, or a small parallel file if it doesn't).
  Exact API shape is a Phase 1 implementation detail — read `Com.ts:309-376` and
  `server/Com.ts:155-172` first to decide whether to extend or bypass them.
- Extend the connect handshake alongside the existing `name`/`color` stringcmds
  (`ClientConnection.ts:283-285`) with a new one, e.g. `identify <publicId>`.
- Shared DTOs (the public ID's type, any profile-summary shape used by both client menu code and
  server-side stats code) belong in `source/shared/`, per `source-directories.instructions.md` —
  re-exported from the engine's public API (`GameAPIs.ts`) the way other engine-declared types
  already are, so game code never reaches into engine internals directly.

### C. Server-side identity plumbing

- Turn `ServerClient.uniqueId` from a hardcoded-`'N/A'` getter
  ([Client.ts:194-196](../source/engine/server/Client.ts#L194)) into a real field, set by a new
  `Host.Identify_f` handler (mirroring `Host.Name_f`/`Host.Color_f`,
  [Host.ts:1306,1424](../source/engine/common/Host.ts#L1306)) when the `identify` stringcmd
  arrives. Keep the getter name and the `status` printout unchanged — this is "unstubbing" an
  existing hook, not adding a new one.
- Default to `'anonymous'`/`'N/A'` for clients that never send `identify` (old clients, bots,
  `cl_anonymous`-shielded players) — no breaking change for anyone.
- Publish a new event, `server.client.identified` (num, uniqueId), fired once identity is known.
  `server.client.connected` fires too early for this the same way it fires before `name` is
  known (`Server.ts:340,378`) — don't overload it. Document the new event in `docs/events.md`
  under "Server", next to `server.client.connected`/`disconnected`.

### D. Where profiles live: extend master-server with D1

Profiles are inherently cross-server — a player's stats/achievements should aggregate across
every officially-hosted server they play on, not fragment per dedicated-server process (which
have no persistent storage today anyway; dedicated servers are ephemeral/community-run).
`master-server` is the one piece of infrastructure that's globally reachable and "ours" already.

Recommend adding a **D1 database** (`env.PROFILE_DB` binding, new `[[d1_databases]]` block in
`wrangler.toml`) rather than reusing the existing `SignalingSession` Durable Object's KV storage
or adding a second DO class:

- Profiles/stats/achievements/leaderboards are naturally relational (players × stat-keys ×
  achievements, `ORDER BY`/`JOIN` for leaderboards). DO storage is a per-object key list, which
  fits signaling's small scoped session state well but is awkward for global aggregate queries.
- D1 is still serverless/edge-friendly and keeps the "no server to run" deployment story intact —
  same `wrangler deploy`, no new ops burden.
- Keeping it a separate binding avoids coupling profile/account concerns to WebRTC signaling
  session lifecycle; the `SignalingSession` DO stays exactly what it is today.

Rough schema sketch (not final DDL, just shape):

```
profiles            (public_id PK, created_at, last_seen_at, display_name NULL)
profile_stats       (public_id, mod_id, stat_key, value, updated_at)
achievements         (achievement_id PK, mod_id, name, description)
profile_achievements (public_id, achievement_id, unlocked_at)
```

`mod_id` namespaces stats/achievements per game (`id1`, `hellwave`, future mods) so they never
collide, while `profiles` itself stays mod-agnostic — one profile, many mods' worth of stats.

### E. Profile/achievement API surface (master-server)

New routes in `src/index.ts`, following the existing plain-`fetch`-routing style (no framework
introduced):

- `POST /profiles/:publicId/stats` — server-authenticated batch delta submission:
  `{ modId, deltas: { statKey: number, ... } }`.
- `GET /profiles/:publicId` — public summary (stats + unlocked achievements); this is what the
  Phase 4 in-menu profile page and any future web profile page read from.
- `POST /profiles/:publicId/achievements/:achievementId` — unlock, idempotent (re-unlocking is a
  no-op, not an error).
- `GET /achievements?modId=` — catalog for client-side display (names/descriptions/icons).

### F. Trust model for stat submission

Introduce a shared per-deployment key (cvar `sv_masterkey` or similar, conceptually parallel to
the `hostToken` reconnect-token pattern already used for session reclaim in the signaling
protocol) that a dedicated/listen server presents when POSTing stat deltas or achievement
unlocks. V1 is a single shared key for all officially-run servers — good enough to keep
random unauthenticated requests out, explicitly **not** cheat-proof (a server that holds the key
can report anything for any public ID it has seen). Per-server keys / a real trust tier for
community servers is a deliberate later refinement, not blocking V1.

### G. Engine-side stats aggregation

A new per-connected-player tracker, modeled directly on `GameStats`'s subscribe-and-accumulate
shape rather than inventing a different mechanism:

- Subscribes to the same granular events `GameStats` already proves out
  (`game.monster.killed`, `game.secret.found`, ...) plus two new ones this plan needs to add:
  - `game.player.fragged` — published alongside the existing `game.player.died`
    ([Player.ts:1990,2024](../source/game/id1/entity/Player.ts#L1990)) so PvP frags are
    distinguishable from monster kills, which today only adjust `this.frags` inline with no event.
  - `game.player.connected` / `game.player.disconnected` — published from the existing
    `PlayerEntity.connected()`/`disconnected()` methods
    ([Player.ts:2036,2049](../source/game/id1/entity/Player.ts#L2036)), which currently do the
    work but never tell the bus about it.
- Buffers deltas per `publicId` in memory; does **not** call out to the master server per event
  (no fetch-per-frag).
- Flushes batched deltas to the Profile API (§E) on player disconnect and on a periodic timer
  (e.g. every 60s) for long sessions.
- Respects a new server cvar, e.g. `sv_reportstats` (default off unless explicitly configured),
  so operators choose whether their server contributes to profiles at all.

### H. Achievements engine

- Catalog as static per-mod data, e.g. `source/game/id1/helper/Achievements.ts`, a typed list of
  criteria descriptors evaluated against the same stat-delta stream §G already collects (simple
  threshold checks like "secrets_found >= 50", or bespoke event-driven checks for one-off
  achievements).
- On unlock, the game server calls the Profile API's unlock endpoint (§E, idempotent) and pushes
  a client-visible notification using the exact push mechanism `GameStats`/`HellwaveStats`
  already use (`DispatchClientEvent` with a new `clientEvent.ACHIEVEMENT_UNLOCKED`), plus a small
  toast UI on the client.
- The in-menu profile page (originally meant to fill the `// - player profile` slots sketched
  in `Multiplayer.ts:38,43`, which no longer exist; the host page is an open question) reads
  from `GET /profiles/:publicId`.

### I. XP/levels & gamification campaigns (sketch only, not built here)

- XP/level is a read-side derived value (weighted sum over stats + achievement count), computed
  from data §D/§E already store — no new storage primitive needed beyond maybe a cached `level`
  column recomputed on write.
- Campaigns/reminders would need Cloudflare Cron Triggers on `master-server` plus *some*
  notification surface — there is no existing push/email channel in this codebase today, so the
  cheapest first step is an in-game MOTD/server-list badge, not a new external channel. This
  needs its own plan once there's real profile data to campaign against.

## Phasing

Each phase is independently shippable; stopping after any phase still leaves a working, useful
increment.

1. **Phase 1 — client + server identity plumbing.** §A, §B, §C. No master-server changes yet.
   Result: every player has a stable public ID visible in `status` and consistent across
   reconnects to the *same* server within a session. Useful on its own (e.g. recognizing a
   returning player, a real target for the long-reserved `ban` command later) even before any
   cross-server profile exists.
2. **Phase 2 — master-server Profile API + D1.** §D, §E, §F. Stands alone and is testable via
   the master-server's existing `node --test` harness without any engine changes yet.
3. **Phase 3 — stats aggregation & submission.** §G, including the two new game events. Wires
   Phase 1's identity and Phase 2's API together: servers now actually report stats.
4. **Phase 4 — achievements + in-menu profile page.** §H. Builds on Phase 3's stat stream and
   Phase 2's storage; the menu page still needs a host (the `Multiplayer.ts` TODO slots it was
   meant to fill were deleted, see "Context").
5. **Phase 5 — XP/levels + campaigns (future).** §I. Deliberately left low-detail; write a
   follow-up plan once Phases 1-4 are live and there's real usage data to design against.

## Testing

- **Phase 1**: unit tests for private/public ID generation and persistence (mock
  `localStorage`/fs), a handshake round-trip test via the mock registry (client sends
  `identify`, server sets `uniqueId` and publishes `server.client.identified`), and a `status`
  output test asserting the public ID appears where `'N/A'` used to.
- **Phase 2**: new test files in `master-server/test/`, mirroring the existing session tests —
  profile CRUD, stat submission rejected without a valid `sv_masterkey`-equivalent, idempotent
  achievement unlock (unlocking twice is a no-op, not a duplicate row/error).
- **Phase 3**: unit tests for the new tracker with a mock registry and a mocked fetch client,
  asserting deltas batch correctly, flush on disconnect and on the periodic timer, and that
  `sv_reportstats 0` suppresses all submission.
- **Phase 4**: achievement criteria evaluation tests (threshold and event-driven cases) and a
  client-side test for the `ACHIEVEMENT_UNLOCKED` toast event, following the same pattern as
  `game-stats.test.mjs`/`hellwave-stats.test.mjs`.
- Run `npm run test:game` and `npm run test:common` in the engine repo, and `npm test` in
  `master-server`, after each phase; `npx eslint --fix` on every touched file in both repos.

## Open questions

- Which page hosts the Phase 4 profile view: extend id1's `multiplayer` page and hellwave's
  `hellwave_profile` page separately (each game owns its menu, per menu-rework.md), or add a new
  page per game. Neither existing page has a stats or achievements area today.
- Exact public-ID encoding/length (base32 vs hex, 16 vs 20 chars) — cosmetic, decide during
  Phase 1 implementation.
- Where exactly to persist the private ID outside the gamedir-scoped VFS on both platforms —
  needs a closer read of `Com.ts`/`server/Com.ts`'s actual API before committing (flagged in
  §B); may turn out `COM` already has (or should grow) a non-gamedir-scoped file concept worth
  reusing instead of a parallel mechanism.
- Server-to-master auth for Phase 2/3: single shared key across all official servers is proposed
  for V1 — revisit if/when community (non-official) servers should be able to opt in to
  reporting stats.
- Whether hellwave-specific achievements ship in the same Phase 4 pass as id1's, or a release
  behind — depends on how much of `HellwaveStats`'s existing per-round fields map cleanly onto
  §G's persistent stat keys.
- Privacy/legal posture once anything beyond anonymous pseudonymous stats is stored (e.g. a
  `display_name` column already sketched in §D) — punt until it's actually needed; default to
  storing nothing identifying beyond the derived public ID.
