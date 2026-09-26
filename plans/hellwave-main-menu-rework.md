# Hellwave main menu rework (Phase 3 of menu-rework)

**Status:** Done through Phase 4 (Phases 3 and 4 are dated 2026-07-20 below). Phase 5 became
[hellwave-lobby-cards.md](hellwave-lobby-cards.md) and
[session-ping-latency.md](session-ping-latency.md), both done. Paths below are as of writing:
`source/game/hellwave/client/Menu.ts` was later split into `source/game/hellwave/client/menu/`
([hellwave-menu-decomposition.md](hellwave-menu-decomposition.md)), and
`hellwave-client.test.mjs` into `source/game/hellwave/test/client/` (with the menu tests under
`test/client/menu/`).

## Context

This is the concrete design for **Phase 3 ("hellwave layout") of [`menu-rework.md`](menu-rework.md)**,
which that plan left unstarted and only lightly sketched under "Design G". Phases 1-2 of that
plan are done: the engine owns menu *machinery only* (`MenuStack`/`MenuPage`/`MenuItem`/layouts,
drawing primitives, mouse/back-button mechanics), and every built-in page (`main`,
`singleplayer`, `load`, `save`, `multiplayer`, `launch_server`, `options`, `keys`, `help`,
`quit`, `alert`) lives in `source/game/id1/client/Menu.ts`, registered by `Id1Menu.Init()`. Today
hellwave's `ClientGameAPI.Init()` ([ClientAPI.ts:130-131](../source/game/hellwave/client/ClientAPI.ts#L130-L131))
just calls `super.Init(engineAPI)` and stops — it inherits id1's entire page tree verbatim,
including the classic image-based main menu (`ImageBasedLayout` + `mainmenu` background), just
with its title graphic already swapped for a hellwave-specific `ttl_main.lmp`
([data/hellwave/gfx/ttl_main.lmp](../data/hellwave/gfx/ttl_main.lmp)). No hellwave-specific
`client/Menu.ts` exists yet.

The user sketched a hand-drawn wireframe for the new main menu, reproduced here as the scope
(everything inside the red box):

- Top-left: Hellwave logo.
- Top-right: the player's profile — v1 is just their name.
- Left sidebar: the main menu (New Game / Profile / Configure / Quit).
- Main area: a live list of active sessions, joinable with one click (map, player count,
  ping, a Join button per row).

A second sketch (a "select a map" screen with a map picture/name/customize/Start button) sits
just outside the red box — that's the map-selection screen "New Game" will eventually open, but
per discussion below it's explicitly the *next* plan, not part of this one.

### What already exists to build on

- **`ClientEngineAPI.Multiplayer.ListSessions()`** ([GameAPIs.ts:1518-1528](../source/engine/common/GameAPIs.ts#L1518-L1528))
  wraps `SessionDiscovery.listSessions()` ([SessionDiscovery.ts](../source/engine/client/menu/SessionDiscovery.ts)),
  returning `DiscoveredSession[]` (`sessionId`, `map`, `currentPlayers`, `maxPlayers`, `colo`,
  `country`). id1's `launch_server` page ([id1/client/Menu.ts:366-466](../source/game/id1/client/Menu.ts#L366-L466))
  is today's only consumer — a plain vertical `Action` list, one row of text per session, a
  "Refresh Sessions" button to re-fetch. This is the closest existing precedent for the
  wireframe's session list, just visually much plainer (no cards, no per-row Join button
  distinct from the row itself, no auto-refresh).
- **`GetMapList()`** ([hellwave/GameAPI.ts:181-186](../source/game/hellwave/GameAPI.ts#L181-L186))
  already curates two named hellwave maps (`hw_doom`, `hw_e1m2`) out of the many `.bsp` files
  under `data/hellwave/maps/`, each with a `pictures: string[]` field
  ([GameInterfaces.ts:169-173](../source/shared/GameInterfaces.ts#L169-L173)) that's always empty
  today and rendered nowhere — infrastructure clearly anticipating a map-thumbnail UI that was
  never built. This is what the "select a map" follow-on screen will need to populate.
- **`StartGameHandler.startSingleplayerGame()`** ([hellwave/client/ClientAPI.ts:34-52](../source/game/hellwave/client/ClientAPI.ts#L34-L52))
  already picks a random map from `GetMapList()` and starts it immediately — this is what "New
  Game" keeps doing for this pass (see Decisions).
- **`_cl_name` cvar defaults to the literal string `'player'`** ([ClientLifecycle.ts:80](../source/engine/client/ClientLifecycle.ts#L80)),
  archived across sessions but never randomized — every first-time player shows up as literally
  "player" until they visit the (currently id1-only) multiplayer setup screen and type a name.
- **The name/color editing UI already exists**, just bundled inside id1's `multiplayer` setup
  page rather than its own page ([id1/client/Menu.ts:268-364](../source/game/id1/client/Menu.ts#L268-L364)):
  a `Textbox` bound to `_cl_name` and two `ColorPicker`s bound to `_cl_color`'s nibbles. This is
  the reusable core of hellwave's new "Profile" page.
- **`plans/profile-and-gamification.md`** is a separate, much larger plan (durable cross-server
  identity, a master-server D1-backed profile/stats/achievement API, XP/levels) that is **not**
  built yet — no backend exists behind it. It references a `// - player profile` TODO slot in
  `Multiplayer.ts:38,43` that no longer exists: that file was deleted in menu-rework Phase 2 (its
  logic absorbed into `id1/client/Menu.ts`), so that cross-reference is stale. The "Level 3" /
  saved-profiles box in the wireframe is exactly what that plan's Phase 4/5 would eventually fill
  — not something this pass builds toward, beyond leaving the top-right corner open for it later.
- **`plans/hellwave-buy-menu-mouse.md`** is the closest precedent for "promote something to a
  real page, fully mod-local, zero engine changes" — same discipline applies here: everything in
  this plan is `source/game/hellwave/` only.

### Decisions made with the user (2026-07-19)

1. **"New Game" keeps its current instant-random-map behavior** for this pass — no map-select
   screen yet. That screen (map picture/name/customize/Start, the sketch's right-hand panel) is
   confirmed as the deliberate **next** plan once this one ships, not bundled in here.
2. **No ping/latency column in v1.** Nothing in the codebase measures pre-connect latency today
   — building that is a non-trivial, separate infra piece (a signaling-server ping endpoint or
   ICE RTT reading), not something to improvise as a side effect of a menu layout change.
3. **"Help" is dropped from hellwave's sidebar**, matching the sketch exactly. The `'help'` page
   stays registered (inherited from `Id1Menu.Init()` via `super.Init()`) — nothing is deleted,
   it's just not linked from hellwave's sidebar. (Still reachable later via
   `RegisterCommand`/`Menu.Open('help')` if hellwave ever wants a bind for it.)
4. **No "Level"/saved-profiles box next to the player name.** v1 shows only the name, per the
   original ask. Revisit once `profile-and-gamification.md` has real backend data to show.

### The fuller funnel (from additional wireframe pages, 2026-07-19)

Four more sketched screens fill in the flow around this plan's core piece:

- **"Select a map"**: map cards (map pic + name) side by side, `[Customize]` + `[Start!]` per
  card; green annotations show Left/Right moving between cards, Down moving into `Customize`.
- **A per-map "New game: &lt;name&gt;" settings screen**: one map pic, a difficulty radio
  (easy/normal/hard — "normal" pre-checked), a "goodies" checkbox (pre-checked), a "private game"
  checkbox (unchecked), `[Start]`, `<< back`. A note underneath — **"load/save kicked out: always
  online"** — signals local save/load games may be dropped for hellwave in favor of everything
  being a live (hosted-or-joined) session; flagged in Open questions rather than acted on here.
- **The "Profile" screen in full**: a player-model preview next to `name`/`vest`/`pants` fields
  (confirms this is exactly id1's existing name/`ColorPicker` pattern, just with an added avatar
  preview), `[accept changes] -> next`, `<< back`. A blue annotation reading **"different
  CTAs"** next to the accept button — the same page's confirm action means something different
  depending on how it was reached (just save, vs. save-and-continue into a game).

And the funnel tying it together, in the user's words: **"Launch the game → either start a new
game or select an existing session → setup a profile, if needed → go."** This means the Profile
page from §3 below isn't only a sidebar destination — it's also a **gate** that can be inserted
between "the player chose to start/join something" and "actually starting/joining it," skipped
entirely once a profile already exists. See §6.

A second explicit requirement: **mouse support should make the menu easier, not required** —
keyboard nav must keep working end-to-end, and default focus/values at every step should be
sensible enough that repeatedly pressing Enter from the main menu ("Enter, Enter, Enter...") gets
a player into a live game with no other input. This is a cross-cutting goal, not specific to any
one screen — see Goals below.

## Goals

- Replace hellwave's inherited `'main'` page with a bespoke layout matching the sketch: logo
  top-left, player name top-right, a left-side vertical sidebar, and a live, auto-refreshing
  session list filling the main area with one-click Join per row.
- Add a "Profile" destination (new page) carrying the name/color editing fields that exist today
  only inside id1's `multiplayer` setup page, so the sidebar's "Profile" entry has real content
  and the top-right name display has somewhere to point players who want to change it.
- Give new players a non-generic default name instead of the literal string `"player"` shared by
  everyone who's never opened a settings screen.
- Do all of this mod-local (`source/game/hellwave/` only), reusing existing
  `ClientEngineAPI.Menu`/`ClientEngineAPI.Multiplayer` surface — no engine changes expected.
- Keyboard-only play stays fully supported end-to-end, and default focus/values at every step
  this plan touches (sidebar, session list, profile gate) are sane enough that mashing Enter
  alone from the main menu gets a new player into a live game.

## Non-goals (this pass)

- No map-selection or per-map settings screen (difficulty/goodies/private-game) for "New Game" —
  confirmed as the next, separate plan (Decisions §1), now with the fuller detail from the
  additional sketches captured in Context above so that plan doesn't need to be resketched from
  scratch.
- No decision here on dropping hellwave's `'load'`/`'save'` pages entirely — the "load/save
  kicked out: always online" note is new information surfaced by the sketch, not an instruction
  executed in this pass; see Open questions.
- No ping/latency display in the session list.
- No "Level"/saved-profiles display next to the player name.
- No map thumbnails in the session list (`DiscoveredSession` carries no picture today, and a
  session's map thumbnail would need either a client-side lookup against `GetMapList()`'s
  `pictures` or the master server relaying one — out of scope here, noted as a Phase 5 idea).
- No changes to `options`/`keys`/`load`/`save`/`quit`/`alert`/`multiplayer`/`launch_server` page
  *content* — hellwave keeps inheriting all of them via `super.Init()`, just doesn't link
  `multiplayer`/`launch_server`/`help` from its own sidebar anymore (the live session list on
  `'main'` replaces what `launch_server` was for, for hellwave specifically).
- No engine (`source/engine/`) changes anticipated. If implementation finds a genuine gap (the
  same way menu-rework Phase 2 discovered several), that's an amendment to this plan, not a
  silent scope change.
- No changes to `plans/profile-and-gamification.md`'s scope — this pass doesn't build identity,
  stats, or achievements, just a name/color settings page and a display slot future phases of
  that plan can build into.

## Design

### 1. New `source/game/hellwave/client/Menu.ts`

A `HellwaveMenu` class mirroring `Id1Menu`'s shape (a static `Init(engineAPI)` plus private
per-page builders), called from `ClientGameAPI.Init()`
([ClientAPI.ts:130-131](../source/game/hellwave/client/ClientAPI.ts#L130-L131)) right after
`super.Init(engineAPI)`, following the documented "Replacing a built-in page" pattern
(`docs/menu-system.md#replacing-a-built-in-page`): re-register `'main'` under the same name; the
root stays `'main'` automatically since `SetRootPage` resolves by name, not instance.

### 2. The new `'main'` page shape

The sketch's four-region layout (logo / player name / sidebar / session cards) doesn't fit any
single stock `MenuLayout` (`VerticalLayout`, `ImageBasedLayout`, `ListLayout`, `GridLayout` are
all single-region). Two real options, both zero-engine-change:

- **(a) Fully custom draw/input** — `items: []`, everything hand-drawn via `customDraw`
  (`Menu.DrawPic`/`Print`/`PrintWhite`) and hand-hit-tested via `customHandleInput`, the same way
  `#buildQuitPage`/`#buildAlertPage`/`#buildKeysPage` already do for screens that don't fit the
  item/layout model at all.
- **(b) Two independent `VerticalLayout`s, coordinated by one page** — a sidebar `VerticalLayout`
  pinned to a left column (`labelX`/`startY` config only, no new layout class needed) and a
  second `VerticalLayout` for the session cards pinned to the main area, both driven from inside
  one `customDraw`/`customHandleInput` pair. This keeps the existing `Action` focus/hover/click
  machinery for both regions (free keyboard nav, free mouse hit-testing per region) instead of
  reimplementing it by hand.

**(b) is the recommended approach** — it reuses more existing machinery and keeps the new code
closer to what `#buildLaunchServerPage`'s dynamic-rebuild pattern already proves out, rather than
hand-rolling every hit-test. The genuinely new bit is **routing focus between the two regions**
(which one does Up/Down/Enter/mouse-click currently apply to) — there's no existing precedent for
two co-located focusable regions on one page, so this needs its own small design note when
implementation starts (likely: track "active region" as a page-local variable, switch on
Left/Right or an edge-of-list Down/Up, and let mouse hover set it implicitly the same way
`updateHover()` already sets `cursor` today).

Concretely:

- **Logo** (top-left): reuse the existing `ttl_main.lmp` pic (already hellwave-branded), drawn at
  a fixed top-left position instead of id1's centered-top placement.
- **Player name** (top-right): `Menu.PrintWhite(x, y, engineAPI.GetCvar('_cl_name')?.string ?? '')`
  — no new widget, refreshed every frame like any other `customDraw` content.
- **Sidebar** (left column): a `VerticalLayout` with four `Action`s — New Game, Profile,
  Configure, Quit — wired to `Menu.StartSingleplayerGame()` (unchanged current behavior, see
  Non-goals), `Menu.Push('hellwave_profile')` (new, see §3), `Menu.Push('options')` (inherited
  from id1, unchanged), `Menu.Push('quit')` (inherited, unchanged).
- **Session list** (main area): see §4.

### 3. New `'hellwave_profile'` page

A small standalone page — not a hellwave-specific reimplementation, just the existing
`Textbox`/`ColorPicker` pattern from id1's `multiplayer` setup page
([id1/client/Menu.ts:277-342](../source/game/id1/client/Menu.ts#L277-L342)) lifted onto its own
page, since hellwave's sidebar has no separate "multiplayer setup" concept anymore (joining is
one click from the main-area session list, not a name/color/join wizard). Same
`onEnter`-loads-from-cvar / action-commits-to-cvar shape id1 already uses:

```typescript
onEnter: () => {
  nameTextbox.value = engineAPI.GetCvar('_cl_name')?.string ?? '';
  const color = engineAPI.GetCvar('_cl_color')?.value ?? 0;
  top = oldTop = color >> 4;
  bottom = oldBottom = color & 15;
},
```

committing via `AppendConsoleText('name "..."\n')` / `'color T B\n'` exactly like id1 does today,
on a "Done"/`Action` row or on `onEscape`. This page is what "Profile" in the sidebar opens, and
incidentally is also where a new player would go to change the randomized name §5 gives them.

The fuller sketch adds a player-model preview next to the fields (reusing the same
`DrawPicTranslate`/`bigbox`/`menuplyr` preview id1's `multiplayer` page already draws at
[id1/client/Menu.ts:335-340](../source/game/id1/client/Menu.ts#L335-L340) — no new asset/rendering
work, just relocated) and, per the "different CTAs" annotation, needs its confirm action and
label to be **configurable per invocation** rather than hardcoded to "Accept Changes" — see §6,
since this same page doubles as the funnel's profile-setup gate.

### 4. Live session list, main area

Reuses `engineAPI.Multiplayer.ListSessions()` — no new client-server or master-server surface.
Differences from id1's `launch_server` precedent:

- **Card-style rows, not a "Refresh Sessions" button.** The wireframe implies the list is always
  current, not something the player manually refreshes. Poll on an interval while `'main'` is the
  current page (e.g. every few seconds, cleared on `onExit`/page switch — mirroring how
  `HellwaveHUD`'s per-frame buy-menu refresh already re-derives its rows from live state rather
  than waiting for a manual trigger) plus an immediate fetch on `onEnter`.
- **Each row is map + player count + a Join `Action`**, no ping column (Decisions §2). Content is
  otherwise a straight port of `#buildLaunchServerPage`'s per-session `Action`
  ([id1/client/Menu.ts:403-413](../source/game/id1/client/Menu.ts#L403-L413)):
  `${session.map} [${session.currentPlayers}/${session.maxPlayers}]`, action sends
  `connect webrtc://${session.sessionId}` and closes the menu.
- **Empty/loading/error states** carry over from the existing pattern (`'Finding sessions...'`,
  `'No sessions found.'`, `'Unable to fetch sessions'` — [id1/client/Menu.ts:385-424](../source/game/id1/client/Menu.ts#L385-L424))
  rather than inventing new copy.
- Rebuilding the row list on every poll tick should reuse the same "slice back to a static count,
  then re-push" pattern `#buildLaunchServerPage` already uses (`staticItemCount`), applied to
  whichever `VerticalLayout`/item array backs the session region from §2.

### 5. Randomized default player name

A small, mod-local name generator (e.g. `adjective + noun` combos, or `adjective + number`) run
once from `ClientGameAPI.Init()` — next to the existing bloom-cvar tweaks
([ClientAPI.ts:141-146](../source/game/hellwave/client/ClientAPI.ts#L141-L146)) is a natural spot
— that checks whether `_cl_name` is still at its literal default (`'player'`) and, if so, sets it
to a freshly generated name via `SetCvar`. Runs once per client (the cvar is `ARCHIVE`-flagged, so
once set it persists and this check becomes a no-op on subsequent boots — same "first run only"
shape as `ClientIdentity`'s planned private-ID generation in `profile-and-gamification.md`, just
far simpler since there's no persistence format to design, only a cvar write). Word lists live in
a small hellwave-local data file/array — no engine change, no dependency on the (unbuilt) identity
system from the other plan.

### 6. The profile gate (funnel-wide — spans this plan and the next)

Both funnel entry points the user described — clicking a session row's Join action (§4) and
"New Game" (whatever it does at the time: today's instant random map, or the future map-select
screen) — should check "does this client already have a profile" before proceeding, pushing the
Profile page (§3) only when that's unset, per "setup a profile, if needed":

- The Profile page's config gains an optional `onAccept: () => void` (defaulting to `Menu.Pop()`)
  and an optional confirm-button label, so the *same* page definition works both as a standalone
  sidebar destination (accept just pops back to `'main'`) and as a gate step (accept performs
  whatever action was gated — connect to the session, start the game — and then pops). This is
  what "different CTAs" in the sketch is pointing at: the button's label/behavior varies by why
  the page was pushed, rather than needing a second near-duplicate page.
- **What "no profile yet" means** needs a real flag. §5's auto-generated random name means
  `_cl_name` is never literally back at the shared `'player'` default after first boot, so it
  can't double as this signal the way it might have before §5 existed. Recommended: a small new
  persisted marker (e.g. an `ARCHIVE` cvar like `hw_profile_confirmed`, or a hellwave-local
  storage key) set once the player ever confirms the Profile page, standalone or via the gate —
  same "a cvar is enough, no new persistence format" reasoning `profile-and-gamification.md` used
  for its own Phase 1 identity work. This is a recommendation, not settled — see Open questions.
- The gate applies to **both** stated entry points. Wiring it into the session list's Join action
  (§4) is squarely this plan's Phase 3 scope below. Wiring it into "New Game" is also in scope
  here even though the richer map-select screen isn't (Non-goals) — today's instant-random-map
  action just gets the same gate check in front of it.

## Phasing

1. **Static shell — done.** `HellwaveMenu.Init()` (`source/game/hellwave/client/Menu.ts`), called
   from `ClientGameAPI.Init()` right after `super.Init(engineAPI)`. Registers a new `'main'` page
   with logo/name/sidebar wired to existing destinations (`Menu.StartSingleplayerGame()`,
   `Push('options')`, `Push('quit')`) plus a placeholder ("Live sessions coming soon.") where the
   session list lands in Phase 3. "Profile" is a visible-but-disabled sidebar entry (dimmed, not
   focusable) until Phase 2 builds `'hellwave_profile'`. See "What actually shipped in Phase 1"
   below for two implementation-time deviations from the original §2 design sketch.
2. **Profile page + randomized name + the gate flag — done.** `'hellwave_profile'` (name
   `Textbox` + vest/pants `ColorPicker`s + player preview, matching id1's `multiplayer` page) is
   registered in `Menu.ts` alongside `'main'`; "Profile" in the sidebar is now enabled. A new
   `hw_profile_confirmed` `ARCHIVE` cvar is the gate flag (§6), registered once in
   `HellwaveMenu.Init()`. "New Game" checks it first: confirmed → starts immediately (unchanged
   behavior); not confirmed → opens the profile page with `onAccept` wired to `startNewGame` and
   the label swapped to "Continue" (the "different CTAs" from the sketch). A random name
   (`source/game/hellwave/client/NameGenerator.ts`) replaces the shared `'player'` cvar default
   once, from `ClientGameAPI.Init()`.
3. **Live session list — done.** §4's polling session list is wired into the main area,
   replacing the placeholder; see "Phase 3 shipped" below for specifics.
4. **Map-selection screen for "New Game" — the picker half is done, ahead of schedule.** Once real
   map screenshots existed, the user asked to build just the card picker now (confirmed via a
   scoping check) rather than the full original sketch — see "Phase 4, first slice" below. The
   **per-map settings screen** (difficulty/goodies/private-game, before Start) is still the
   deferred remainder, and can build on the picker + profile-gate plumbing already in place.
5. **(Separate plan, future) Ping/latency + map thumbnails in the session list.** Needs its own
   infra design (pre-connect latency probing; thumbnail sourcing/relaying) — noted as a natural
   follow-on to Phase 3 here, not scoped further in this document. See
   [`hellwave-lobby-cards.md`](hellwave-lobby-cards.md) for the concrete design (2026-07-22),
   scoped out once real map screenshots and the wider viewport made map thumbnails and a richer
   row genuinely cheap.

Land and manually verify each phase (per this repo's usual practice for menu/UI changes) before
starting the next, same discipline `menu-rework.md` used between its own phases.

### What actually shipped in Phase 1 (revised after a real playtest)

§2 sketched "two independent `VerticalLayout`s, coordinated by one page" as the recommended
approach for the sidebar/session split. The first cut instead used one flat, hand-rolled
entry list with a static (non-blinking) cursor glyph, to avoid needing `Host.realtime` (not
exposed to game code) for a blinking indicator. **That first cut had a real bug**, found during
manual verification: mouse *hover* never moved the focus cursor (only clicking worked), because
the hand-rolled page had no real `layout`/`items` for the engine's own `MenuPage.updateHover()`
to resolve against — it only special-cased `K.MOUSE1` in a custom `customHandleInput`, which
`updateHover()` never calls.

**Fixed by switching to the design actually recommended in §2's intent** (real focusable items,
not a hand-rolled model), but via a single custom `MenuLayout` rather than two `VerticalLayout`s:
sidebar rows are real `Action` instances in one flat `page.items` array (`#sidebarCount` marks
where Phase 3's session rows get appended), positioned into two columns by one small custom
layout object (`draw`/`hitTest`, contextually typed against `MenuItem`, no engine changes). This
means keyboard nav, mouse click, *and* mouse hover now all come from the same `MenuPage`/`Action`
machinery every other page already relies on — the hover bug is gone by construction, not
special-cased around. The cursor indicator is a plain printable `>` (`Menu.PrintWhite`), not
`VerticalLayout`'s special glyph codes (12/13) — a second real bug found in the same playtest:
those codes render whatever a font's low-range "graphics" cells happen to contain, which isn't
guaranteed to look like a cursor at all (confirmed independently for the buy menu's identical
symptom, fixed the same way in `HellwaveHUD`'s `customDraw`).

Also fixed in the same pass, found via the same playtest (both are engine-level, not
hellwave-specific, so id1 benefits too):

- `SCR.DrawNet()` drew the "bad connection" indicator permanently while fully disconnected
  (`last_received_message` defaults to `0`, so `Host.realtime - 0` blows past the lag threshold
  within a fraction of a second of boot) — now gated on `CL.cls.state === connected`.
- Nothing ever pushed the root menu on a cold boot (`client.disconnected` only fires from a prior
  connection) — a new `client.game-initialized` event, published once `ClientGameAPI.Init()`
  finishes, gives `Menu.ts` a hook to open the root menu on first boot too.

**Verified live**, not just unit-tested: connected a headless browser session to the user's own
running dev server (`data/hellwave/gfx/conback.lmp` etc. are served via `Sys.ts`'s `/qfs/*`
Express route from `npm run dedicated:start`, not a CDN — the "no local asset pipeline" note in
an earlier draft of this section was based on an incomplete picture). Confirmed: hover moves the
`>` marker across every row, the disabled state (when Profile was still disabled) stayed
landable-but-dimmed, and the "HELLWAVE" text fallback for the still-blank `ttl_main.lmp` renders
correctly (that blank lump is deliberate — a stopgap to hide the LibreQuake logo on prod, not a
bug, per the user).

### What actually shipped in Phase 2

Built as designed in §3/§5/§6 — see the Phasing entry above for the shape.

**Live verification** (revised): the first attempt at an isolated hellwave client+dedicated-server
pair hit a real snag — the dedicated build's worker bundling (`dedicatedWorkerBundlePlugin`, see
`workers.instructions.md`) assumes the standard project-root-relative `dist/dedicated/` layout,
and building into a custom `--outDir` broke the `NavigationWorker.mjs` path, which crashed the
server once `+exec server.cfg`'s `map hw_e1m2` spawned monsters needing it. Worked around by
booting the scratch dedicated server **without** loading a map at all (no `+exec server.cfg`) —
`/qfs/*` asset serving and the disconnected-menu flow this phase actually needed don't depend on
a map being loaded, only on `COM`'s search paths being set up, which happens during `Host.Init()`
regardless. Confirmed live end to end: Profile opens from the sidebar (name/color load correctly,
player-model preview renders), and clicking "New Game" with no confirmed profile correctly opens
the gate with the button relabeled "Continue" instead of "Accept Changes" — the exact "different
CTAs" behavior from the original sketch.

Unit test coverage: 35 tests across the profile page, the gate, and the name generator.
`eslint`/`tsc` clean, full suite green (1137 tests, including the `GetMapList` test added
alongside the map-picture wiring below).

### Real logo + map screenshots landed (2026-07-20)

The user supplied real art: `gfx/logo.png` (896x119 hi-res PNG) and per-map screenshots
(`maps/hw_doom.jpg`, `maps/hw_e1m2.jpg`, both 768x768). Landed immediately, ahead of Phase 4:

- `HellwaveMenu` now loads `gfx/logo.png` via `LoadPicFromFile` and draws it through the
  resolution-aware top-level `engineAPI.DrawPic(x, y, pic, scale)` — **not**
  `engineAPI.Menu.DrawPic`, which always draws at native-pixel size with no scale parameter and
  would have rendered the hi-res logo almost 3x the entire virtual canvas width. The blank
  `ttl_main.lmp` + "HELLWAVE" text fallback from Phase 1 is gone now that real art exists; the
  text fallback still covers the brief async-load window (and outright load failure).
- `ServerGameAPI.GetMapList()`'s `pictures` field (always empty before this) now points at the
  two screenshots, unblocking Phase 4's map-select screen — the field existed but nothing had
  ever populated it.
- Confirmed live in the same verification pass above: the logo renders at a legible size,
  correctly clear of the top-right player name.

### Phase 4, first slice: the map picker (2026-07-20)

With real map screenshots in hand, the user asked for "just the map picker" now rather than the
full Phase 4 sketch (map cards *and* a per-map round-settings screen with difficulty/goodies/
private-game) — confirmed via a scoping check rather than assumed. Landed:

- A new `'hellwave_newgame'` page: one card per `ServerGameAPI.GetMapList()` entry (screenshot +
  label), built on `Menu.ListPage` specifically so Left/Right (not just Up/Down) move between the
  side-by-side cards — matching the original sketch's own annotation for that, and free (no new
  code) since `ListPage` already remaps Left/Right to Up/Down for exactly this shape of layout.
  Picking a card starts that map immediately (disconnect-if-active, force-close, `map <name>`) —
  no difficulty/goodies/private-game screen; that's the deliberately-deferred remainder of
  Phase 4.
- "New Game" in the sidebar now opens this picker (still behind the profile gate from Phase 2)
  instead of calling `Menu.StartSingleplayerGame()`'s random pick directly. That random-pick path
  itself is untouched and still exists for whatever else calls it.
- **A real bug found live, not by the unit tests**: map labels (`'Doomed computer station'`,
  `'Castle of the damned'`) are longer than one card is wide and were overflowing across the gap
  into the neighboring card's label, rendered as one illegible run-together line. Fixed with a
  small greedy word-wrap (`#wrapLabel`, up to two lines, each independently clamped to the card's
  own width) — the hit-test region grows to match however many lines a given label actually
  wrapped to, rather than assuming a fixed one-line height. This is exactly the kind of thing the
  unit tests structurally couldn't catch (they never render text), which is why every phase in
  this plan has included a real headless-browser pass rather than stopping at green tests.
- Verified live: both cards render correctly scaled, both labels wrap cleanly onto two lines with
  no overlap, clicking either starts that map.

### Phase 3 shipped: the live session list (2026-07-20)

Built as designed in §4/§6, replacing the "Live sessions coming soon." placeholder entirely
(removed — with the polling in place, `mainPage.items` always has at least one row past
`#sidebarCount` by the time anything ever draws, since `onEnter` pushes synchronously before the
first frame; the placeholder branch was dead code once this landed).

- `'main'` gained `onEnter`/`onExit`: an immediate fetch plus a `setInterval` poll
  (`SESSION_POLL_INTERVAL_MS = 5000`, resolving the plan's open question — 5s balances staying
  current against hammering the signaling server), cleared on `onExit` so navigating away (even
  just pushing Profile/Options on top) stops polling until the player comes back. A
  `sessionRefreshInFlight` guard skips a poll tick if the previous fetch hasn't resolved yet,
  rather than letting two fetches race to rebuild `mainPage.items` concurrently.
  *(Superseded: `MainMenu.ts` no longer polls. It subscribes through
  `engineAPI.Multiplayer.SubscribeSessions`, a push from the master server's `/browser` channel,
  and `SESSION_POLL_INTERVAL_MS` no longer exists. Checked 2026-09-21; the ping plan already
  describes the list as push-driven on 2026-07-23.)*
- Each row is `${map} [${current}/${max}]`; picking one runs the same profile-gate check as "New
  Game" (confirmed → connect immediately; not confirmed → profile page, "Continue" label, accept
  connects) — the gate is now genuinely shared across both funnel entry points the plan called
  for, not just New Game.
- `'Finding sessions...'`/`'No sessions found.'`/`'Unable to fetch sessions'` carried over
  unchanged from id1's `launch_server` precedent, per the plan.
- **A real bug found writing the tests, not live this time**: an existing test
  (`'registers the hellwave main menu page...'`) pushed `'main'` and never popped it, which
  (now that `onEnter` starts a real `setInterval`) left it running forever and hung the whole
  test file. Fixed by popping at the end of that test; a reminder that `onEnter`/`onExit`
  symmetry matters even in tests once a page owns a live resource.
- Verified live against the actual signaling server (already running locally, not a mock):
  cold boot correctly shows "No sessions found." (accurate — no hellwave sessions were up), and
  network capture confirmed exactly 3 fetches over ~13 seconds (1 immediate + 2 poll ticks),
  matching the 5s interval precisely. Joining a real session wasn't exercised live (would need a
  second hosted instance and real WebRTC negotiation, a bigger and separately-riskier setup for
  what the unit tests already cover precisely) — the join/gate logic itself is unit-tested in
  full, only the "does a real session actually show up and connect" end-to-end path is unverified
  beyond that.

### Phase 4, second slice: per-map settings screen + guaranteed multiplayer start (2026-07-20)

Picking a map card no longer starts it directly — it now opens a new `hellwave_newgame_settings`
page first, and "New Game" (and every other path that starts a map) now always hosts a
multiplayer/coop game, never a bare singleplayer `map` command.

- **Scope decision, made with the user rather than guessed**: the original sketch's "difficulty"
  and "goodies" settings don't map to anything real in hellwave today — there's no `skill`
  concept anywhere in the codebase, and "goodies" (health/armor drops) is an always-on internal
  budget with no toggle. Asked the user directly; confirmed the settings screen should configure
  **Rounds** (`hw_rounds`) and **Private Game** (`sv_public`) instead, both real, already-wired
  cvars.
- New `#buildNewGameSettingsPage` in `Menu.ts`: shows the selected map's preview thumbnail and
  label (reusing `#mapPictures`/`#selectedMapName`/`#selectedMapLabel`, now promoted to shared
  static fields so both the picker and this page can read them), a `Rounds` `ColorPicker`
  (2–12, default 10) and a `Private Game` `Toggle`, then `Start!`.
- **Load-then-commit, not live cvar-binding**: `onEnter` reads `hw_rounds`/`sv_public` via
  `engineAPI.GetCvar` into local closure state; `Start` only calls `engineAPI.SetCvar` for a
  value that actually changed. Deliberately *not* a cvar-bound `Slider`/`Toggle` (id1's
  `launch_server` precedent) — those read/write the real `Cvar` registry directly rather than
  through `engineAPI`, which would be untestable here (this file's tests mock `engineAPI.GetCvar`/
  `SetCvar`, not the real registry) and, for `Slider` specifically, requires a mandatory `cvar`
  field with no override. Same `getValue`/`setValue`-closure pattern already proven on the
  Profile page's color pickers.
- Verified via source inspection (not just assumed) that both `hw_rounds` (`ServerGameAPI.Init()`)
  and `sv_public` (`SV.Init()`) are registered unconditionally during `Host.Init()`, well before
  the main menu ever shows — so the `onEnter` read is never racing an unregistered cvar.
- **New engine API**: `ClientEngineAPI.Menu.StartMultiplayerGame(mapname)`, added to
  `source/engine/client/Menu.ts` (`M.StartMultiplayerGame`), `GameAPIs.ts`, and
  `docs/menu-system.md`, mirroring the existing `StartSingleplayerGame` exactly — routes to the
  active mod's `StartGameInterface.startMultiplayerGame()` (hellwave's already sends
  `deathmatch 0 / coop 1 / samelevel 1 / maxplayers 4 / map "..."`). Added so "New Game" never
  needs to duplicate hellwave's multiplayer-start console text inline in `Menu.ts` (which also
  would have risked a circular import, since `ClientAPI.ts` already imports `HellwaveMenu`).
- 7 new tests in a `'Hellwave new game settings'` describe block cover: loading rounds/private
  state from cvars on enter, defaulting to 10/public when cvars were never registered (mocked via
  a `GetCvar: () => null` override, matching the real engine's `Cvar.FindVar` contract — the
  shared test-engine mock auto-vivifies cvars instead, which doesn't reflect production), Start
  always calling `StartMultiplayerGame` and never a bare singleplayer map, disconnecting first
  when a server is already active, committing only changed cvars, leaving unchanged cvars alone,
  and Escape popping back to the map picker.
- Verified live end-to-end against the real dev server (already running, not a scratch build,
  since no source outside the working tree was touched): New Game → profile gate (fresh
  browser session, "Continue" label) → map picker → new settings screen renders the correct
  preview/label for the picked map → bumped Rounds 10→12 and toggled Private Game on → Start
  actually booted a real coop game. Confirmed via the client console after connecting:
  `hw_rounds` is `"12"`, `sv_public` is `"0"`, `deathmatch` is `"0"`, `coop` is `"1"` — and the
  in-game HUD round counter itself read "1 / 12", so the setting doesn't just persist as a cvar,
  it visibly drives the actual round count in gameplay.

### New engine widget: `NumberInput` (2026-07-20)

The Rounds field above shipped on a repurposed `ColorPicker` (a wrapping, closure-based numeric
stepper actually meant for shirt/pants colors) — it worked, but wrapped past the ends (Right at
12 rounds cycled back to 2) and only supported Left/Right, baking the value into the label string
since `ColorPicker.draw()` never draws one itself. Since more numeric settings are planned for
this screen later, added a proper `NumberInput` widget to the engine's `MenuItem.ts` instead of
letting the misuse spread further:

- Left/Right/Enter nudge by `step`, clamped to `[min, max]` (no wrapping); digits can also be
  typed directly, with Backspace editing from the currently committed value, like a native
  `<input type="number">`. Typed input is capped to the digit width of `max` (2 digits for a
  2–12 range) rather than rolling over.
- Same `getValue`/`setValue`-closure shape as `ColorPicker`/`Toggle` (not a mandatory `cvar`), so
  it's usable — and testable — without touching the real `Cvar` registry.
- Draws label + value as two columns (`M.Print`/`M.PrintWhite` at `valueX`), matching how
  `Toggle`/`Slider` already draw, instead of the label-baking workaround. There's no per-item
  blur hook in this menu system (`MenuPage._moveCursor` never calls anything on the item losing
  focus), so `draw()` itself resets any in-progress typed digits the moment it's called with
  `focused === false` — the committed value was already live-updated on every keystroke, so
  nothing but the raw display text is lost.
- 7 new tests in `test/client/menu-item.test.mjs` (clamping vs. `ColorPicker`'s wrap, Right/Enter/
  Left stepping, typing digits, ignoring digits past the field width, Backspace-from-committed,
  draw reverting after a focus change, disabled no-ops), plus the hellwave settings-screen tests
  updated to read the Rounds value via `getValue()` instead of parsing it back out of the label.
- Verified live: typed "8" directly into the field, arrow-nudged to 9 (which correctly abandoned
  the typed buffer first), backspaced and retyped "12" from scratch, then moved focus away and
  back — the field cleanly showed the committed value with no leftover typed text.
- **Unrelated but worth recording**: live verification here also turned up two concurrent
  `vite build --watch` processes writing into the same `dist/browser` output (one an orphaned
  leftover from earlier phases in this session, one the user's own `npm run dev`), which produced
  a stale hellwave chunk and a `roundsPicker is not defined` runtime error that had nothing to do
  with the actual code change. Resolved by killing the orphaned process; a reminder to check for
  stray watch processes if a live-verification browser pass throws an error that doesn't match
  the diff at hand.

### Menu no longer sits on top of a share-link connect (2026-07-20)

Reported bug: opening a share link (`?connect=webrtc://...`) issued a `connect` command directly
from boot argv, bypassing every menu code path — the cold-boot main menu (opened by
`client.game-initialized`) stayed on screen through the whole connecting/loading sequence instead
of getting out of the way, since nothing had ever told it to close.

- Traced the full chain: `InviteCommand` (share-link generation) → `Sys.Init()`'s
  `location.search` → argv parsing → `Host.Connect_f`/`Host.Map_f` → `CL.Connect()` →
  `ClientConnection.connect()`, which already publishes `client.connecting` for *every* connection
  attempt (menu-driven, share-link/boot-argv, or a typed console command) uniformly.
- Fix: `source/engine/client/Menu.ts` now subscribes to `client.connecting` and force-closes
  whatever menu is open, right alongside the existing `client.disconnected`/`client.game-initialized`
  subscriptions. One generic engine-level hook instead of patching every trigger site; hellwave's
  own explicit `Menu.ForceClose()` calls (New Game/Join actions) are untouched and still fire first
  for instant same-frame feedback — this is just the safety net for paths that skip menu code
  entirely.
- 3 new tests in `test/client/menu.test.mjs`. Live-verified end-to-end: hosted a real session,
  extracted its actual `webrtc://` listen address, cold-booted a fresh page straight into that
  share-link URL — no menu ever appeared over the connecting/loading screen.
- `docs/events.md`'s `client.connecting` row updated to document the new subscriber.

### Sidebar main-menu items get LibreQuake's header font (2026-07-20)

The four sidebar items (New Game/Profile/Configure/Quit) now render with LibreQuake's
`gfx/header-font.png` — a chunky uppercase-only bitmap font (26 letters, no digits/punctuation)
laid out as a 26-column grid with two stacked color rows (a "normal" row and a "highlight" row) —
instead of the standard 8×8 conchars font.

- New engine primitive: `source/engine/client/BitmapFont.ts`. `BitmapFont` describes a fixed-grid
  glyph atlas (`charset`, `glyphWidth`/`glyphHeight`, `cellWidth`/`cellHeight` stride, `variants`
  row count) and draws a string glyph-by-glyph, uppercasing input and skipping (but still
  advancing past) any character outside the charset — so unsupported punctuation/digits/spaces
  still read as a gap instead of breaking the string. `getGlyphRect()` (pure UV-rect math) is
  split out from `draw()` (the actual GL calls) specifically so the atlas math is unit-testable
  without a WebGL context — mirrors the existing `resampleTexture8` pattern in `GL.ts`.
  `BitmapFont.FromImageFile()` loads and locks the atlas to nearest-neighbor filtering (no
  mip/bilinear blur between glyph cells).
- Exposed through the public API: `ClientEngineAPI.LoadBitmapFont(filename, config)` and
  `Menu.DrawBitmapString`/`M.DrawBitmapString` (same 320×200 virtual coordinate space and 2x
  doubling as `Print`/`PrintWhite`). `BitmapFont` re-exported from `GameInterfaces.ts` alongside a
  new `Action` type export (needed so hellwave can type the array of sidebar actions it hands the
  loaded font to once loading resolves).
- `Action` (the engine widget, not hellwave-specific) gained an optional `font: BitmapFont` config
  field: when set, `draw()` routes through `DrawBitmapString` instead of `Print`/`PrintWhite`,
  using variant 0 while focused and variant 1 otherwise (disabled items always use variant 1) — so
  the font's own two color rows double as the hover/selection highlight, no separate tint/overlay
  needed. This is a generic, optional capability on the shared widget, not a hellwave-only fork.
- hellwave's `Menu.ts`: `Init()` kicks off `LoadBitmapFont('gfx/header-font.png', {...})`
  concurrently with page construction (`#buildMainPage` now returns its four `Action` instances so
  the font can be attached once loading resolves, since the promise settles after the page is
  already built and registered).
- **Live feedback round** (real playtest at `?game=hellwave`, not just unit tests): the '>' cursor
  marker next to the focused sidebar row became redundant now that focus is conveyed by the font's
  own color switch, the "hover" color was the wrong way round (wanted swapped), and rows needed
  more vertical padding. Addressed all three: `#buildMainPage`'s custom layout only draws
  `CURSOR_MARKER` for rows *without* their own color-based focus feedback (i.e. still shown for
  the plain-text session list, which has no font since its labels contain digits/brackets the
  atlas doesn't have); swapped the focused/idle variant mapping in `Action.draw()`; bumped
  `ROW_SPACING` from 16 to 24 (the font's own glyph height already exactly filled the old 16-unit
  row slot, leaving zero breathing room between rows).
- 8 new tests (`test/client/bitmap-font.test.mjs`: atlas grid math, charset lookup, unsupported
  characters; `test/client/menu-item.test.mjs`: `Action`'s font-vs-no-font draw paths and variant
  selection), plus fixture support (`source/game/id1/test/client/fixtures.ts` gained a mock
  `LoadBitmapFont`/`DrawBitmapString` and a real `hellwave-client.test.mjs` test asserting the font
  actually gets attached to all four sidebar items once the mocked load resolves).

## Testing

- `source/game/hellwave/test/hellwave-client.test.mjs` (existing file, already covers the buy
  menu) gains a new `'main menu'` sub-describe: `HellwaveMenu.Init()` registers `'main'` and
  `'hellwave_profile'`, root stays `'main'`, sidebar actions call the expected
  `Menu.StartSingleplayerGame()`/`Push('options')`/`Push('hellwave_profile')`/`Push('quit')`.
  Follows the existing `createMockMenuAPI()` rig used by the buy-menu tests.
- Session list: unit test with a mocked `Multiplayer.ListSessions()`, covering populated/empty/
  error states and that activating a row's action sends the right `connect webrtc://...` text and
  closes the menu — mirroring the assertions already planned for the buy menu's row actions.
- Focus routing between sidebar and session regions: unit test that Down/Up stays within a region
  until an edge, and that Left/Right (or whatever key ends up chosen) switches the active region —
  this is the one genuinely new interaction pattern, so it needs deliberate coverage rather than
  relying on the two `VerticalLayout`s' own existing tests (those only cover single-region
  behavior).
- Profile page: `onEnter` loads `_cl_name`/`_cl_color` correctly, committing sends the expected
  `name "..."`/`color T B` console text — same shape as id1's existing `multiplayer` page test.
  Plus: invoking it with a custom `onAccept`/label calls that callback instead of the default pop,
  and confirming sets the gate flag (§6).
- Randomized name: unit test that a fresh `_cl_name === 'player'` gets replaced with a generated
  name exactly once, and that a non-default `_cl_name` (a returning player) is left untouched.
- Profile gate: a session row's Join action pushes the Profile page (not connecting yet) when the
  gate flag is unset, and connects immediately when it's already set; confirming from a
  gate-triggered Profile page both sets the flag and performs the deferred connect. Same shape
  for "New Game" once its gate check lands in Phase 2.
- Manual/browser verification (per this repo's standard practice for UI changes, and per the
  lessons in `hellwave-buy-menu-mouse.md` — the pointer-lock race there was only ever found by a
  real playtest, not Playwright): boot the dev server, join hellwave, confirm the new main menu
  renders all four regions, mouse and keyboard both navigate sidebar and session list correctly,
  a live session (e.g. a second local instance hosting) shows up and is joinable with one click,
  Profile opens/saves a name+color change that's reflected in the top-right corner and survives a
  reload.

## Open questions

- **Exact focus-routing keys between sidebar and session regions** — Left/Right is the obvious
  choice (Up/Down stays "within a region," matching how the sketch visually separates the two
  columns), but not locked in; decide during Phase 1 implementation and adjust this doc if it
  lands differently.
  **Resolved (Phase 1):** it landed differently. There is no Left/Right region routing: both
  regions are one flat `page.items` array under a custom two-column `MenuLayout`, so the stock
  `MenuPage` keys (Up/Down, Enter, mouse hover and click) walk the sidebar rows and then the
  session rows in order. `MainMenu.ts` has no `customHandleInput`. (Checked 2026-09-21.)
- **Session poll interval** — "every few seconds" is a placeholder; needs a real default (and
  possibly a cap on concurrent in-flight fetches if a poll fires while a previous one is still
  pending) decided during Phase 3 implementation.
  **Resolved (Phase 3), then superseded:** 5 s with an in-flight guard. The polling was later
  replaced by a push subscription (see the note under "Phase 3 shipped"), so there is no
  interval left to tune.
- **Random name word lists** — content/tone (Quake-flavored? generic?) not decided; a small
  implementation-time detail, not a design fork.
  **Resolved (Phase 2):** Quake-flavored. `source/game/hellwave/client/NameGenerator.ts` builds
  `<Adjective><Noun><0-99>` names (e.g. "CursedSlayer73") from two ten-word lists.
- **Whether hellwave should keep `multiplayer`/`launch_server` reachable at all** (e.g. via a
  console command for muscle memory) now that the main-area session list replaces their purpose
  for hellwave — leaning "no, not needed" since nothing links to them from the new sidebar and
  nothing in the sketch implies they should stay reachable, but flagging rather than silently
  deciding.
  **Resolved: no.** [hellwave-menu-asset-cleanup.md](hellwave-menu-asset-cleanup.md) made id1
  skip building `multiplayer` and `launch_server` (plus `main`, `singleplayer`, `load`, `save`
  and `help`) for hellwave, via `classicFrontend: false`.
- **What exactly determines "profile needed"** (§6) — a dedicated persisted confirm-flag
  (recommended above), vs. "always gate once per cold boot until dismissed," vs. never automatic
  and only sidebar-reachable (which would mean *not* implementing the "if needed" auto-insertion
  at all). The dedicated-flag version is recommended but not locked in.
  **Resolved (Phase 2):** the dedicated flag, an `ARCHIVE` cvar named `hw_profile_confirmed`.
- **Whether hellwave drops `'load'`/`'save'` entirely**, per the "load/save kicked out: always
  online" note on the per-map settings sketch — not decided; today's plan makes no change to
  those pages either way.
  **Resolved: yes, effectively.** The same `classicFrontend: false` option means id1's `load`
  and `save` pages are never built for hellwave (see the multiplayer/`launch_server` answer
  above).
- **Default focus per screen for the "Enter-mashing fast path"** — which sidebar item is
  pre-focused on `'main'`, whether the first/top session row is pre-focused once the list is
  populated, and what the Profile gate's default focus is when it's pushed involuntarily (not
  the player's own choice to open it) — each needs a concrete answer during Phase 1/2/3
  implementation, not just a general intention.
  **Partly settled:** `MenuPage.activate()` puts the cursor on the first focusable item, so
  `'main'` opens on its first focusable sidebar entry. Still unchecked (2026-09-21): whether a
  later session-list update moves focus, and the Profile gate's default focus when it is pushed
  involuntarily.
