# Hellwave lobby cards: map art and round display

**Status:** Done. All three phases shipped (Phases 1 and 2 on 2026-07-22, Phase 3 on 2026-07-23),
plus the 2026-07-23 refinements at the end. Ping, which this plan left out, became
[session-ping-latency.md](session-ping-latency.md) (also done). Checked in code on 2026-09-21:
`DiscoveredSession.settings` exists, `hw_rounds` and `hw_round_current` carry `Cvar.FLAG.SERVER`,
and `MainMenu.ts` draws the thumbnail, the hostname/map/round lines and the hover border.

## Context

[`hellwave-main-menu-rework.md`](hellwave-main-menu-rework.md) built the live session list on
`'main'` (Phase 3, shipped 2026-07-20), but deliberately kept each row to one line of plain text —
`${map} [${current}/${max}]` — and explicitly deferred richer content to later:

> **(Separate plan, future) Ping/latency + map thumbnails in the session list.** Needs its own
> infra design... noted as a natural follow-on to Phase 3 here, not scoped further in this
> document. (Phasing item 5)

and, in Non-goals at the time: "No ping/latency display", "No map thumbnails in the session list
(`DiscoveredSession` carries no picture today...)".

The user sketched a richer lobby row on paper: a map picture, the existing player-count fraction
(e.g. `2/4`), a round indicator, a ping figure, and a per-row join button. After reviewing what's
actually feasible (see below) and discussing scope with the user (2026-07-22), **this plan covers
map thumbnails and round display only.** Ping and skill/difficulty are explicitly out of scope —
see Decisions below.

Two things landed since the original plan that make map thumbnails and round display cheap now,
where they weren't when the original plan deferred them:

- **[`menu-virtual-resolution.md`](menu-virtual-resolution.md)** gave hellwave its own
  640×360 `'contain'`-fit viewport (`MenuCommon.VIEWPORT_WIDTH`/`HEIGHT`,
  [MenuCommon.ts:27-28](../source/game/hellwave/client/menu/MenuCommon.ts#L27-L28)) instead of the
  fixed 320×200 id1 space — real room for a taller row, which didn't exist when the original plan
  called map thumbnails out of scope.
- **Real map screenshots landed** (`gfx/hw_doom.jpg`/`hw_e1m2.jpg`), and `NewGameMenu.ts` already
  has the exact recipe for loading and drawing them at a chosen virtual-space size/position
  ([NewGameMenu.ts:73-116](../source/game/hellwave/client/menu/NewGameMenu.ts#L73-L116)) — directly
  reusable for lobby rows, just matching `session.map` against `ServerGameAPI.GetMapList()` instead
  of iterating the full map list.

### What the current session list looks like today

`MainMenu.ts`'s session rows are built in `refreshSessions()`
([MainMenu.ts:212-218](../source/game/hellwave/client/menu/MainMenu.ts#L212-L218)): one `Action`
per `DiscoveredSession`, label-only, positioned by the shared two-column `#rowPosition`/`layout`
(sidebar column vs. session column, [MainMenu.ts:77-166](../source/game/hellwave/client/menu/MainMenu.ts#L77-L166)),
with a fixed `ROW_SPACING = 28` virtual units per row today.

`DiscoveredSession` ([SessionDiscovery.ts:9-16](../source/engine/client/menu/SessionDiscovery.ts#L9-L16))
currently exposes: `sessionId`, `map`, `currentPlayers`, `maxPlayers`, `colo`, `country`. Nothing
about round.

### What's actually available server-side already (researched, not assumed)

- **`WebRTCDriver.#GatherServerInfo()`** ([NetworkDrivers.ts:1187-1202](../source/engine/network/NetworkDrivers.ts#L1187-L1202))
  already sweeps *every* cvar flagged `Cvar.FLAG.SERVER` into a `settings: Record<string,
  string|number|boolean>` blob and re-sends it on `server.spawned`/connect/disconnect/`cvar.changed`.
  This is pushed to the master server via `update-server-info`, and the master server's
  `sanitizeSettings`/`mergeServerInfo` (`master-server/src/protocol.ts:115-145,410-431`) already
  passes that blob through untouched to the public `/list-servers` JSON (capped at 16 entries, 32-char
  keys, 64-char string values — plenty for what this plan needs). **This means round data can ride
  the existing pipe with zero master-server changes and zero new wire-protocol work** — just
  registering the right cvars server-side with `Cvar.FLAG.SERVER`.
- **`hw_rounds`** (the configured round *limit*, `ServerGameAPI.Init()`,
  [hellwave/GameAPI.ts:161](../source/game/hellwave/GameAPI.ts#L161)) is registered with flags `0`
  today — not swept. Needs `Cvar.FLAG.SERVER` added.
- **The live *current* round** (`GameManager.round_number`,
  [GameManager.ts:181](../source/game/hellwave/GameManager.ts#L181), incremented in
  `startNextRound()` at [GameManager.ts:~738](../source/game/hellwave/GameManager.ts#L738) alongside
  `eventBus.publish('game.round.started', this.round_number, this.round_number_limit, ...)`) is
  entity state, not a cvar — nothing sweeps it today. Needs a small new read-only mirror cvar,
  updated at the same point `game.round.started` already fires.
- Skill/difficulty and ping were both investigated and are explicitly **not** part of this plan —
  see Decisions below for why.

## Goals

- Turn each session row into a small multi-line row: map thumbnail, map label, player count, and
  round (current/limit) — reusing the existing `joinSession`/profile-gate flow untouched, just
  richer row content and a taller row height.
- Extend the engine's `DiscoveredSession`/`SessionDiscovery.ts` with a generic `settings`
  passthrough field (not hellwave-specific), so hellwave (and any future mod's lobby UI) can read
  round data without the engine needing to know hellwave's cvar names.
- Wire hellwave's server side to actually populate that data: `hw_rounds` gains
  `Cvar.FLAG.SERVER`; a new read-only round-mirror cvar tracks the *current* round.
- Resolve each row's map thumbnail client-side, matching `session.map` against the already-real
  `ServerGameAPI.GetMapList()` pictures — no server or master-server change needed for this piece.
- Everything mod-local in `source/game/hellwave/`, except the one genuinely generic addition to
  `SessionDiscovery.ts`/`DiscoveredSession` (engine-owned, since any mod's session list could use a
  settings passthrough, same reasoning `menu-virtual-resolution.md` used for `MenuViewport` living
  in the engine).

## Non-goals

- **No ping/latency display in this pass.** Confirmed with the user: real pre-connect RTT
  measurement needs its own infra design (a speculative WebRTC probe, or properly wiring up the
  signaling keepalive's currently-discarded `pong` timestamp — either way, a separately-sized
  follow-on plan), and a cheap colo/country-based proxy risks showing a number that reads as
  authoritative but isn't. Tracked as a separate future task, not part of this plan.
- **No skill/difficulty display or setting.** The engine-level `skill` cvar (0-3,
  easy/normal/hard/nightmare) exists and drives id1's monster AI, but hellwave never registers,
  reads, or exposes it anywhere — confirmed by grep, zero hits in `source/game/hellwave/`. Since
  it isn't even configurable when starting a hellwave game today (no control on
  `NewGameSettingsMenu`), showing it in the lobby would display a value nobody chose. Confirmed
  with the user: ignore skill entirely for this plan.
- No change to actual gameplay difficulty scaling, monster spawn rates, or `GameManager`'s
  round/monster-scaling math.
- No master-server or wire-protocol changes. Everything rides the existing `settings` sweep.
- No change to the join flow, profile gate, or polling cadence (`SESSION_POLL_INTERVAL_MS = 5000`)
  — only row content and row height change. *(That constant no longer exists: the list is
  push-driven through `SubscribeSessions` now, see the note under "Phase 3 shipped" in
  [hellwave-main-menu-rework.md](hellwave-main-menu-rework.md).)*
- No redesign of the sidebar/session two-column layout itself, or the engine's `MenuViewport`/
  `MenuPage` machinery — this plan only touches session-row content and the two small server-side
  cvar additions.

## Design

### 1. `DiscoveredSession`/`SessionDiscovery.ts` — new field

Add to `DiscoveredSession` ([SessionDiscovery.ts:9-16](../source/engine/client/menu/SessionDiscovery.ts#L9-L16)):

```typescript
export interface DiscoveredSession {
  readonly sessionId: string;
  readonly map: string;
  readonly currentPlayers: number;
  readonly maxPlayers: number;
  readonly colo: string | null;
  readonly country: string | null;
  readonly settings: Readonly<Record<string, string | number | boolean>>;
}
```

Passing the whole sanitized `settings` blob through generically (rather than naming
`round`/`roundLimit` explicitly on the engine-level type) keeps `DiscoveredSession` mod-agnostic —
mirroring how `ServerInfoSummary` already carries `settings` end to end today without interpreting
it. hellwave's `MainMenu.ts` reads `session.settings.hw_rounds` /
`session.settings.hw_round_current` itself, with sane fallbacks when a field is missing (an
older/non-hellwave server, or a session still mid-`GatherServerInfo` before the first sweep lands).

`ServerInfoSummary`'s local type ([SessionDiscovery.ts:18-26](../source/engine/client/menu/SessionDiscovery.ts#L18-L26))
gains `settings?: Record<string, string | number | boolean> | null`, and `listSessions()`'s mapping
passes it through (`settings: info.settings ?? {}`).

### 2. hellwave server-side cvar registrations

In `ServerGameAPI.Init()` ([hellwave/GameAPI.ts](../source/game/hellwave/GameAPI.ts)):

- `hw_rounds`: add `Cvar.FLAG.SERVER` to its existing registration (currently flags `0` at
  [GameAPI.ts:161](../source/game/hellwave/GameAPI.ts#L161)) — no other change, it's already the
  configured round limit.
- A new read-only mirror, `hw_round_current`, registered
  `Cvar.FLAG.SERVER | Cvar.FLAG.READONLY` (matches the "readonly, only through the API" contract
  `cvarFlags.READONLY`'s own doc comment describes,
  [Defs.ts:253-254](../source/shared/Defs.ts#L253-L254)), default `'0'`.

In `GameManager.startNextRound()` ([GameManager.ts:~738](../source/game/hellwave/GameManager.ts#L738)),
right alongside the existing `eventBus.publish('game.round.started', ...)` call:

```typescript
this.game.engine.SetCvar('hw_round_current', String(this.round_number));
```

`SetCvar` is already available on `ServerEngineAPI` — no new engine API needed, this is exactly the
"register once, update on the real event" pattern `#GatherServerInfo`'s sweep is designed around.
Setting a cvar already publishes `cvar.changed`, which `#GatherServerInfo`'s subscription already
re-triggers a push on — so this one line is the entire server-side plumbing for "current round"
appearing in the lobby, no polling, no new event.

### 3. Map thumbnail resolution in `MainMenu.ts`

`refreshSessions()` currently builds one `Action` per session with only a text label
([MainMenu.ts:212-218](../source/game/hellwave/client/menu/MainMenu.ts#L212-L218)). Resolve a
thumbnail the same way `NewGameMenu.ts` does — load once per known map name, cache in a
`Map<string, GLTexture>`, keyed by `ServerGameAPI.GetMapList()`'s `.name` (which is exactly what
`SV.server.mapname`/`session.map` already carries verbatim — confirmed via
[Server.ts:744](../source/engine/server/Server.ts#L744), no `maps/`/`.bsp` prefix to strip).
Sessions running an unrecognized map (future map added server-side before the client's curated
list catches up) fall back to the existing "Loading..." placeholder or a blank swatch, not an
error.

```typescript
// MainMenu.ts, alongside the existing session-refresh state
static #mapPictures = new Map<string, GLTexture>();

// Called once from build(), same pattern as NewGameMenu's up-front load loop.
for (const map of ServerGameAPI.GetMapList() ?? []) {
  const picturePath = map.pictures[0];
  if (picturePath === undefined) { continue; }
  engineAPI.LoadPicFromFile(picturePath).then((texture) => {
    texture.lockTextureMode('GL_LINEAR');
    MainMenu.#mapPictures.set(map.name, texture);
  }).catch(() => { /* leave unset, row falls back to text-only */ });
}
```

### 4. Row layout — taller multi-line row (confirmed, not a bordered card grid)

The session list is an unbounded-length vertical list (unlike `NewGameMenu`'s fixed 2-3 map cards
side by side), so a horizontal card grid doesn't fit. Confirmed with the user: keep the existing
single-column vertical list and single `Action` per row (join still works exactly as today,
[MainMenu.ts:168-182](../source/game/hellwave/client/menu/MainMenu.ts#L168-L182)), but make each
row visually richer and taller:

```
[thumb] hw_doom - Doomed computer station         2/4
        round 3/12                                       [Join]
```

- Thumbnail: small (e.g. 32×32 virtual units), drawn at the row's left edge via
  `MenuCommon.toScreenPosition` + scale, same recipe as `#drawLogo`
  ([MainMenu.ts:61-71](../source/game/hellwave/client/menu/MainMenu.ts#L61-L71)).
- Line 1: map label (falls back to the raw `session.map` if not in the curated list) + player
  count, right-aligned within the row.
- Line 2: `round ${current}/${limit}` — omit this line entirely if `hw_rounds`/`hw_round_current`
  are absent from `settings` (an older/non-hellwave server), so the row degrades to today's
  single-line-plus-thumbnail shape rather than showing "round undefined/undefined".
- `ROW_SPACING` grows from `28` to roughly `28 + thumbnail height + line 2 height` (concrete number
  decided during implementation against the real font metrics) — session rows and sidebar rows
  already use independent Y-stepping through `#rowPosition`'s `rowIndex` math
  ([MainMenu.ts:77-82](../source/game/hellwave/client/menu/MainMenu.ts#L77-L82)), so growing only
  the session column's row height is a one-line change to that function (branch `ROW_SPACING` by
  `isSidebar`), not a structural layout change.
- Hit-test (`layout.hitTest`, [MainMenu.ts:150-165](../source/game/hellwave/client/menu/MainMenu.ts#L150-L165))
  grows its per-row height bound to match, same as today's `py < y + ROW_SPACING` just against the
  new taller row height.

## Phasing

1. **Plumbing, no visible change — done (2026-07-22).** `DiscoveredSession.settings` (engine),
   `hw_rounds` gains `Cvar.FLAG.SERVER`, new `hw_round_current` read-only mirror cvar + the
   one-line `SetCvar` call in `startNextRound()`. See "What actually shipped in Phase 1" below.
2. **Map thumbnails, done (2026-07-22).** `MainMenu.ts` session rows now draw a small thumbnail
   next to the existing single-line label, within the current `ROW_SPACING` (row height itself
   doesn't grow until Phase 3). See "What actually shipped in Phase 2" below.
3. **Row layout upgrade, done (2026-07-23).** Taller multi-line rows showing map label, thumbnail,
   and round — everything from steps 1-2 becomes visible here. See "What actually shipped in Phase
   3" below.

Land and manually verify each phase before starting the next, per this repo's established practice
for menu/UI changes (`hellwave-main-menu-rework.md` did this between every one of its own phases).

### What actually shipped in Phase 1

Built as designed in §1/§2:

- `DiscoveredSession` and `SessionDiscovery.ts`'s internal `ServerInfoSummary` both gained a
  `settings: Readonly<Record<string, ServerSettingValue>>` field (new exported
  `ServerSettingValue = string | number | boolean` type alias), passed through unchanged from
  `serverInfo.settings ?? {}`.
- `hw_rounds` now registers with `cvarFlags.SERVER` (was `0`). New `hw_round_current` cvar
  (`cvarFlags.SERVER | cvarFlags.READONLY`, default `'0'`, description notes it's
  `GameManager`-owned and not user-settable) added to `HellwaveCvarMap`/`ServerGameAPI._cvars`.
- `GameManager.startNextRound()` now calls `this.engine.SetCvar('hw_round_current',
  String(this.round_number))` immediately after the existing `eventBus.publish('game.round.started',
  ...)` call — this alone is the entire server-side plumbing, since `SetCvar` already triggers
  `cvar.changed`, which `WebRTCDriver`'s existing subscription already re-sweeps into the next
  `update-server-info` push.
- **Deviation from the plan's Testing section**: driving hellwave's real static `ServerGameAPI.Init()`
  end-to-end (to assert the two `RegisterCvar` calls carry the right flag bitmask) was tried and
  abandoned — it recurses into `EntityRegistry.initializeAll()`, which calls every registered
  entity class's `_parseModelData()`, which calls `engineAPI.ParseQC()` (real QC parsing via
  `Mod.ParseQC`), which has no existing lightweight mock anywhere in the test suite and would need
  one built from scratch just for this. No test in the repo drives `Init()` end-to-end today for
  either id1 or hellwave. Coverage for this phase instead comes from the two places that actually
  matter behaviorally: `GameManager`'s test asserting `hw_round_current` gets set on every round
  transition (via a `SetCvar` spy added to the existing mock engine), and `SessionDiscovery`'s test
  asserting the `settings` blob survives the fetch/filter/map pipeline. The two `RegisterCvar` flag
  arguments themselves were verified by direct code review rather than a driven test.
- Test updates needed in two other places that had a fixed `DiscoveredSession` shape baked into
  `assert.deepEqual` fixtures and needed a `settings: {}` field added:
  `test/client/session-discovery.test.mjs` (existing cases) and
  `test/common/client-engine-api-multiplayer.test.mjs`. Neither `MainMenu.ts`'s own tests nor id1's
  `launch_server` page tests needed changes — their `ListSessions` mocks return session literals
  directly (bypassing `SessionDiscovery`), and nothing reads `.settings` yet (that's Phase 2/3).
- 3 new tests (`SessionDiscovery`: settings passthrough; `GameManager`: mirror-cvar set on first
  round and across three consecutive rounds), 1 existing test extended with a `setCvars` assertion.
  Full suite green: 1217 engine tests, 383 game tests. `eslint --fix` clean on every touched file
  (pre-existing `require-atomic-updates` warnings in two session-discovery test files are
  unrelated boilerplate, not introduced by this change).
- **Known unrelated issue found via `tsc --noEmit`**: `source/game/hellwave/entity/Items.ts:18` has
  a pre-existing `TS2554: Expected 2 arguments, but got 1` error, untouched by this phase (confirmed
  via `git diff` showing zero changes to that file) — likely fallout from other in-progress work on
  this branch (`source/game/id1` shows as a dirty submodule in `git status`). Left alone as out of
  scope; flagging here since it means `tsc --noEmit` currently fails repo-wide for a reason
  unconnected to this plan. *(Resolved later, in [game-module-contract.md](game-module-contract.md)
  Phase 1: it was not fallout from other work but a real bug. Hellwave's `_collectItems` override
  dropped id1's `priorItems` parameter, so a backpack announced items the player already owned.
  Fixed with a regression test, and `tsc` now gates the Cloudflare build.)*

### What actually shipped in Phase 2

Built roughly as designed in §3, plus the thumbnail is now actually drawn (§3's own code block only
covered loading/caching; drawing was originally slated for §4, but landed early since it was a small
addition once the cache existed):

- `MainMenu.ts` imports `ServerGameAPI` from `../../GameAPI.ts` (same import hellwave's
  `NewGameMenu.ts` already uses) and loads every curated map's `pictures[0]` into a new
  `#mapPictures: Map<string, GLTexture>` cache from `build()`, identical recipe to
  `NewGameMenu`'s own up-front load loop.
- A new `#sessionMapNames: string[]` static field, index-aligned with the session `Action` rows
  (not `mainPage.items` as a whole — the `'Finding games...'`/`'No active games.'`/error `Label`
  rows never populate it), rebuilt every `refreshSessions()` call alongside the `Action`s
  themselves.
- The row `layout.draw()` now draws a `THUMBNAIL_SIZE = 20` (virtual units) picture at each
  session row's left edge when the cache has one for that row's map name, then shifts that row's
  label/cursor-marker draw position right by `THUMBNAIL_SIZE + THUMBNAIL_GAP (6)`. Sidebar rows and
  a still-loading/unrecognized-map session row are both unaffected — falls back to exactly today's
  text-only position. `hitTest` needed no change: its existing `px >= x - 8` lower bound already
  covers the thumbnail region, confirmed live (see below).
- **Deviation from the plan's Testing section**: a unit test calling `page.draw()` to assert
  `engine.drawPics` contains the resolved thumbnail was attempted and abandoned — `Action.draw()`
  (`source/engine/client/menu/MenuItem.ts:195`) calls the *real* `M.DrawBitmapString`, not the
  mocked `engineAPI.Menu`, and `M` isn't wired up to anything in this unit-test harness (confirmed:
  `NewGameMenu`'s identical map-picture code has zero draw-level test coverage either, for the same
  reason). Replaced with a narrower unit test confirming a session on an uncurated map still gets a
  correctly-labeled row (the thing a non-null-safe cache lookup could actually break); the real
  thumbnail-draws-correctly behavior was instead verified live.
- **Live verification** (real headless Chromium via the cached Playwright install, not just unit
  tests — per this repo's standing practice for anything touching menu draw code): built a fresh
  `dist/dedicated/`, hosted a second hellwave dedicated server on a spare port serving both the game
  socket and the already-current `dist/browser/` build. Discovered along the way that a plain
  dedicated Node server never registers itself with the master server at all (`main-dedicated.ts`'s
  `EngineLauncher.Launch()` never sets `registry.urls`/`signalingURL` — that machinery is
  browser-listen-server-only), so a real end-to-end hosted session wasn't reachable this way; used
  Playwright's request interception on `/list-servers` instead, feeding the real client code a
  realistic fake payload (two sessions, `hw_e1m2` and `hw_doom`, with the settings blob from Phase
  1) — this exercises the actual production code path (fetch → filter → thumbnail lookup → draw),
  just swapping the network layer, the same substitution the unit tests already make. Confirmed: both
  thumbnails render at the correct rows with no console errors, and hovering the mouse directly over
  a thumbnail (not the shifted text) still moves focus correctly, proving the hit-test region change
  (or rather, lack of one needed) was correct.
- Full suite green: 1218 tests (1 net new test in `main-menu.test.mjs`, two attempted/reverted as
  described above). `eslint --fix` and `tsc --noEmit` clean (modulo the pre-existing unrelated
  `Items.ts` error noted above).

### What actually shipped in Phase 3

Built as designed in §4, with concrete numbers picked and confirmed live rather than left as
placeholders:

- Sidebar and session rows now step independently: `SIDEBAR_ROW_SPACING = 28` (renamed from
  the old shared `ROW_SPACING`, value unchanged) and a new `SESSION_ROW_SPACING = 40`. `#rowPosition`
  branches on which column `index` falls in rather than multiplying a single shared constant, and
  `hitTest`'s per-row height bound follows the same branch.
- Session rows now carry a `SessionRowInfo { map, roundLabel }` per row (a typed interface, not an
  inline object shape, per the code-style guide's typedef preference), index-aligned with the
  session `Action`s the same way Phase 2's `#sessionMapNames` was — renamed/expanded to
  `#sessionRows` and now also feeding the round line, not just the thumbnail lookup.
- The label format changed from the raw `${session.map} [...]` to `${label} [...]`, where `label`
  comes from a new `#mapLabels: Map<string, string>` (populated synchronously alongside
  `#mapPictures` in the same `GetMapList()` loop) and falls back to the raw map name for an
  uncurated map, exactly as designed.
- The round line (`round ${current}/${limit}`) is built once per session in `refreshSessions()`
  from `session.settings.hw_round_current`/`hw_rounds` (Phase 1's plumbing), `null` when either is
  absent, and drawn via a plain `Menu.Print` call (dim, not the focus-colored `PrintWhite`) at
  `y + ROUND_LINE_OFFSET` (`LABEL_LINE_HEIGHT + 4`, reusing `MenuCommon`'s existing shared text-line
  constant rather than a new magic number) — entirely omitted when `roundLabel` is `null`, so an
  older/non-hellwave server's row degrades to exactly Phase 2's shape.
- **Existing tests needed real fixture updates, not just additions**: five of the six
  `Multiplayer.ListSessions` mocks across `main-menu.test.mjs` predated Phase 1's `settings` field
  and had none — `session.settings.hw_round_current` threw on `undefined`, which the `try`/`catch`
  in `refreshSessions()` correctly turned into "Game lobby error." (a real bug in the *test
  fixtures*, not the production code — they no longer matched `DiscoveredSession`'s real contract).
  Fixed by adding `settings: {}` (or real round data) to every mock session object, and updating
  the expected `.label` assertions to the new curated-label format. One fixture (in "onEnter
  fetches sessions...") deliberately keeps one session with round settings and one without, so both
  branches of the round-line presence check are exercised through the existing label-array
  assertion path (labels themselves are unaffected either way — the round line is a separate
  `Print` call `.label` can't see).
- One new unit test (`layout.hitTest resolves session rows using the taller row spacing, including
  over the thumbnail`) — genuinely testable without touching the real `M` singleton, since
  `hitTest` is pure coordinate math. Confirms a session row's hit region now extends into the grown
  40-unit band (a y that would have missed the old 28-unit sidebar spacing) and still covers the
  thumbnail's x-range, not just the shifted label text.
- **Live verification** (same technique as Phase 2 — real headless Chromium, `/list-servers`
  request interception since dedicated Node servers still don't self-register with the master
  server): three fake sessions, two with round settings (different maps, different rounds) and one
  without. Confirmed live: both curated labels render correctly, both round lines show the right
  numbers, the third row's round line is correctly omitted entirely (not "round undefined/undefined"),
  and hovering near the *bottom* of each row's new 40-unit band (not just the top, which the old
  28-unit band would already have satisfied) still resolves to the correct row — proving the taller
  hit region is actually in effect, not just the taller visual spacing. `SESSION_ROW_SPACING = 40`
  and `ROUND_LINE_OFFSET` were kept at their first-guess values; the live screenshot read cleanly
  with no cramping or excess whitespace, so no iteration was needed.
- Full suite green: 1219 tests (1 net new test). `eslint --fix` and `tsc --noEmit` clean (modulo the
  same pre-existing, unrelated `Items.ts` error).

## Testing

- `SessionDiscovery.listSessions()`: unit test that a `serverInfo.settings` blob (including missing
  keys, and a session with no `settings` at all) maps correctly into `DiscoveredSession.settings`.
- `GameManager`: unit test that `startNextRound()` sets `hw_round_current` to the new
  `round_number`, alongside the existing `game.round.started` event assertion.
- hellwave `ServerGameAPI.Init()`: unit test that `hw_rounds` is registered with `Cvar.FLAG.SERVER`
  set (a simple flag-bitmask assertion), and that `hw_round_current` is registered
  read-only/server-flagged with a sane default.
- `MainMenu.ts`: unit test that a session row resolves its thumbnail via a mocked
  `ServerGameAPI.GetMapList()` match, and falls back sensibly when `session.map` isn't in the
  curated list. Unit test that the round line is omitted when `settings` lacks
  `hw_rounds`/`hw_round_current` (graceful degradation for a non-hellwave or older-server
  session).
- Manual/browser verification (per this repo's standard practice for menu/UI changes): host two
  real local sessions at different rounds, confirm the lobby shows correct thumbnails, live
  current/max player counts, and the right round number per session — then confirm Join still
  works exactly as before from the richer row.

### Refinement: hover border instead of the cursor arrow (2026-07-23)

Feedback after the first live look at Phase 3: the `>` cursor arrow read as an inconsistent focus
cue next to the map picker's own bordered-card highlight. Replaced it with the same hover border
for session rows.

- `NewGameMenu.ts`'s `#drawHoverBorder` (private, single-consumer until now) moved to
  `MenuCommon.drawHoverBorder(engineAPI, x, y, width, height)`, alongside its
  `HOVER_BORDER_COLOR`/`HOVER_BORDER_THICKNESS` constants (renamed from the `CARD_`-prefixed
  originals now that a second consumer exists) — exactly the "everything genuinely shared by 2+
  pages" criterion `hellwave-menu-decomposition.md` used to decide `MenuCommon.ts`'s contents.
  `NewGameMenu.ts` now calls the shared method instead of its own copy; zero behavior change there,
  confirmed live (screenshot below).
- `MainMenu.ts`'s session rows now call `MenuCommon.drawHoverBorder(engineAPI, x, y, contentWidth,
  SESSION_ROW_CONTENT_HEIGHT)` when focused, sized to the row's actual content (`THUMBNAIL_SIZE +
  THUMBNAIL_GAP + item.label.length * 8` wide, a fixed `24`-unit height tall enough for the
  thumbnail and both text lines). The `>` `CURSOR_MARKER` now only ever appears for a sidebar row
  in the brief window before the header bitmap font finishes loading — comment at its declaration
  updated to reflect the flip (previously the reverse: only session rows used it, sidebar had
  color-based focus feedback).
- **A structural limitation found while attempting a unit test**: `NewGameMenu`'s existing
  `'draws a hover border around only the focused card'` test works because its card layout never
  calls `item.draw()` at all — it renders everything itself through the mocked `engineAPI.Menu`.
  `MainMenu`'s row layout, by contrast, *does* call `item.draw()` for every row (sidebar and
  session alike) so real keyboard/mouse-hover machinery keeps working — confirmed via a throwaway
  script that even with only session rows focused, the loop still reaches a sidebar `Action.draw()`
  call, which reaches for the real `M.DrawBitmapString` once the header font has attached (which it
  reliably has by the time a session row's data has also loaded, in this mock environment). No
  border-drawing unit test was added for `MainMenu` for this reason — same conclusion as the
  thumbnail and round-line features in Phases 2-3, verified live instead.
- **Live verification**: same fake-session technique as Phases 2-3. Confirmed: focusing each of two
  session rows in turn draws exactly one border around that row (thumbnail + both text lines, no
  bleed into the neighboring row), no `>` arrow anywhere in the session list, sidebar focus
  (color-based) is unaffected, and the map picker's own border still renders identically after the
  `MenuCommon` extraction.
- Full suite still green: 1219 tests (no count change — this was a refactor + behavior change, not
  new coverage, matching the "no unit test possible" finding above). `eslint --fix`/`tsc --noEmit`
  clean (modulo the same pre-existing unrelated `Items.ts` error).

### Refinement: border padding (2026-07-23)

Feedback after seeing the border live: it read as "offset by a few pixels."

- **Investigated as a possible real coordinate bug first, not assumed.** Instrumented the actual
  `Draw.Pic`/`Draw.Fill`/`Draw.String`/`Draw.StringWhite` calls live (monkey-patching them for one
  frame via `window.registry.Draw`, since it's exposed there) to get ground-truth screen-space
  coordinates rather than eyeballing screenshots. Confirmed mathematically: the thumbnail, both
  text lines, and the border all resolve from the exact same virtual `(x, y)` and the exact same
  `viewport.toScreen()` transform — no cache staleness, no scale mismatch between `M`'s internal
  projection and `engineAPI.Menu`'s exposed one. Tried three different browser window sizes
  (800×500, 960×600, 1440×900 — deliberately including non-integer `contain`-fit scales like 1.25×)
  and two different rows; the geometry was correct in every case.
- **Conclusion: not a bug, a padding gap.** `MenuCommon.drawHoverBorder`'s own inset
  (`HOVER_BORDER_THICKNESS = 1`) only clears the border *line* itself from the content — the
  thumbnail and text otherwise sit flush against the border's inner edge with zero breathing room,
  which reads as "the border is touching/offset from the content" even though the coordinates are
  exact. Fixed by adding an explicit `SESSION_ROW_BORDER_PADDING = 4` (virtual units) margin between
  the row's content box and where the border itself is drawn — `NewGameMenu`'s card border wasn't
  touched (it wraps a picture only, no adjacent text, so the same tight fit reads as intentional
  there, not cramped).
- Verified the padded border doesn't collide with the next row: `SESSION_ROW_CONTENT_HEIGHT (24) +
  2 * SESSION_ROW_BORDER_PADDING (8) = 32`, comfortably under `SESSION_ROW_SPACING (40)`.
- **Live verification**: re-captured the same 800×500 case that first showed the tight fit clearly,
  before and after. Confirmed a clean, symmetric margin around thumbnail + both text lines on all
  sides, and confirmed the second row's (now larger) border still doesn't overlap the first row's.
- Full suite still green: 1219 tests (no count change, same "not draw-testable" reasoning as the
  border feature itself — this is a padding-only change to the same code path).

### Refinement: vertical centering + uniform row width (2026-07-23)

Real screenshots from the user after testing the padding fix (not another investigation round —
this time the feedback pinpointed two concrete, distinct issues):

1. **Content wasn't vertically centered in the border** — it looked pulled to the top, with a
   visible gap only at the bottom. Root cause, found by re-deriving the numbers rather than
   guessing: `SESSION_ROW_CONTENT_HEIGHT` was `24`, but the *actual* content (thumbnail height 20;
   round line bottom at `ROUND_LINE_OFFSET (12) + LABEL_LINE_HEIGHT (8) = 20`) only fills the first
   `20` units — the extra `4` units of "slop" baked into the constant, combined with the new
   uniform `SESSION_ROW_BORDER_PADDING` added on *top* of that slop, is exactly what produced the
   asymmetry (4 units of gap above the content, 8 below). Fixed by shrinking
   `SESSION_ROW_CONTENT_HEIGHT` to `20` (the real content height) so `SESSION_ROW_BORDER_PADDING`
   is now the *only* source of padding, applied symmetrically on all four sides.
2. **Each row's border was sized to its own label**, so a shorter map name produced a visibly
   narrower border than a longer one when focused — inconsistent from row to row. Fixed with a new
   `#maxSessionLabelLength` static field, recomputed during `refreshSessions()` (reset alongside
   `#sessionRows`/`#maxSessionLabelLength` at all three reset points, same pattern as everything
   else session-list-related) as the max `fullLabel.length` across the current session list. Every
   session row's border now uses this shared width instead of `item.label.length`, so all rows'
   borders line up to the width of the longest one.
- **Side effect, aligned with feedback**: shrinking `SESSION_ROW_CONTENT_HEIGHT` from 24→20 (with
  padding unchanged at 4) also grew the visual gap *between* row borders (border height dropped
  from 32→28, so the gap within the fixed 40-unit `SESSION_ROW_SPACING` grew from 8→12 units) — the
  user had said "I like the margin between the items," so more of it (as a side effect of fixing
  the real problem) reads as compatible with that preference, not a regression of it.
- **Live verification**: re-tested at the same 800×500 case. Confirmed content is now vertically
  centered with equal top/bottom gaps, and that focusing the shorter-labeled row ("Castle of the
  damned") produces a border reaching exactly as far right as the longer-labeled row's own border,
  not shrunk to its own text.
- Full suite still green: 1219 tests (no count change, same reasoning as the prior two border
  refinements — a geometry-only change to the same non-draw-testable code path).

### Refinement: center the map label on the New Game settings screen too (2026-07-23)

Not a lobby-card issue, but found while polishing the same visual family: the New Game settings
screen (`NewGameSettingsMenu.ts`, reached by picking a map on `hellwave_newgame`) drew its selected
map's label left-aligned under the preview picture, while the map picker itself
(`NewGameMenu.ts`'s cards) centers each wrapped label line — inconsistent between the two screens
in the same flow.

- Extracted the map picker's inline centering formula (`x + Math.max(0, (CARD_WIDTH - line.length *
  8) / 2)`) into `MenuCommon.centerX(containerX, containerWidth, contentWidth)` — small and pure,
  but now used identically by both pages, matching the same "2+ consumers belongs in `MenuCommon`"
  reasoning already applied to `drawHoverBorder`. `NewGameMenu.ts` calls the shared helper instead
  of its own inline math (zero behavior change there); `NewGameSettingsMenu.ts` now calls it too,
  which is the actual fix.
- `centerX` is a pure function with no engine dependency, so — unlike the border/thumbnail/round-line
  features — it's directly unit-testable with zero mocking. Added a 3-case test (`new-game-menu.test.mjs`,
  alongside the existing `wrapLabel` test): normal centering, exact-fit (no inset), and content wider
  than the container (clamped to the container's left edge, never negative).
- **Live verification**: opened the map picker → picked `hw_doom` → landed on the settings screen.
  Confirmed "Doomed computer station" (which wraps onto two lines at this preview width, same as it
  does on the picker) renders with both lines centered under the preview image, matching the
  picker's own card labels.
- Full suite green: 1220 tests (1 new test for `centerX`). `eslint --fix`/`tsc --noEmit` clean
  (modulo the same pre-existing unrelated `Items.ts` error).

### Refinement: hostname as a third row (2026-07-23)

Requested addition, not part of the original scope: each row gains a hostname line above the
existing two, `<hostname>` / `<map name> <player count>` / `<round count>`, with the hostname
truncated so a long player-chosen name can't blow out the row.

- **Found a pre-existing latent gap while implementing this**: `SessionDiscovery.ts`'s
  `ServerInfoSummary` already declared `hostname?: string` (present since before this whole plan
  started), but `listSessions()`'s mapping never actually copied it into the returned
  `DiscoveredSession` — the field existed on the wire and in the type, but no caller could ever see
  it. Fixed by adding `hostname: string` to `DiscoveredSession` and mapping it
  (`info.hostname ?? 'UNNAMED'`, matching `WebRTCDriver#GatherServerInfo`'s own server-side
  default) — a small, generically useful engine-level fix, not hellwave-specific.
- `SESSION_ROW_SPACING` grew from 40→52 and a new `SESSION_LINE_GAP` constant (`LABEL_LINE_HEIGHT +
  4`, the same "line height + a little air" shape already used for `ROUND_LINE_OFFSET`) now derives
  both the hostname→content and content→round offsets, so all three lines use one consistent
  vertical rhythm instead of two independently-tuned numbers. `SESSION_ROW_CONTENT_HEIGHT` is now
  derived (`ROUND_LINE_OFFSET + LABEL_LINE_HEIGHT`) rather than a separate hand-picked constant, so
  it can't drift out of sync with the actual content again the way it did in the first border
  refinement.
- New `MainMenu.#truncateHostname()` (private -- single, internal consumer) clips to
  `HOSTNAME_MAX_CHARS = 32` with a trailing `"..."`, computed once per session during
  `refreshSessions()` and stored in `SessionRowInfo` (not recomputed per draw).
- `#maxSessionLabelLength` (a character count) became `#maxSessionContentWidth` (a virtual-unit
  width, computed once per row as `Math.max(hostnameWidth, thumbnail+gap+labelWidth)`) so the
  shared hover-border width (Design/refinement above) accounts for whichever line is actually
  widest — previously only the map+count line was considered, which would have under-sized the
  border once a long hostname could be wider than that line.
- **Live verification**: two fake sessions, one with a short hostname and one deliberately much
  longer than `HOSTNAME_MAX_CHARS`. Confirmed: the short one renders unchanged, the long one
  truncates to exactly 32 characters ending in `"..."`, both rows show all three lines in the
  requested order, and the hover border (focused on either row in turn) fully wraps all three lines
  with consistent padding — including sizing to the truncated-but-still-widest hostname on the
  second row, not just its own map+count line.
- Full suite green: 1221 tests (2 new: fixture-shape safety net for an extreme-length hostname, and
  the `hitTest` row-spacing test's coordinates updated for the new 52-unit spacing). `eslint --fix`/
  `tsc --noEmit` clean (modulo the same pre-existing unrelated `Items.ts` error).

## Follow-ups explicitly out of scope here

- **Ping/latency** — a separate task, per the user. Needs its own infra design (see Non-goals).
- **Skill/difficulty** — ignored per the user, since hellwave has no real, configurable difficulty
  concept today. Worth revisiting only once/if hellwave gains an actual difficulty setting on the
  New Game Settings screen — at that point exposing it in the lobby via the same `settings`
  passthrough this plan adds would be a small follow-up, not a redesign.
