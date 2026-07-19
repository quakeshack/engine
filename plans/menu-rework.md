# Move all menu ownership into game code (Quake III Arena–style UI split)

## Context

Menu UI (`MenuStack`, `MenuPage`, `MenuItem`, layouts) lives in
`source/engine/client/menu/`, but the actual *page tree* — which pages exist, what they
contain, which art they use — is built inline and imperatively inside the ~1160-line
`source/engine/client/Menu.ts` (`main`, `singleplayer`, `multiplayer`, `load`, `save`,
`options`, `keys`, `help`, `quit`, `alert`, `launch_server`, all registered at
[Menu.ts:983-993](../source/engine/client/Menu.ts#L983-L993)). This is 100% id1-shaped
(Quake single-player episodes/skill, QuakeWorld-style name/color, classic deathmatch
lobby) with no per-mod override point beyond one already-working escape hatch.

That escape hatch already exists and is already used: `ClientEngineAPI.Menu`
([GameAPIs.ts:1228](../source/engine/common/GameAPIs.ts#L1228)) re-exports the widget/layout
classes plus `RegisterPage/Open/Push/Pop/Replace/AddItem/RemoveItem`, explicitly so game
code never imports engine internals. hellwave already builds a real `MenuPage` through it
for its buy menu ([HUD.ts:208](../source/game/hellwave/client/HUD.ts#L208)). `GetMapList()`
/ `GetStartServerList()` already exist as static methods on `ServerGameInterface`
([GameInterfaces.ts:221-223](../source/shared/GameInterfaces.ts#L221-L223)), implemented in
both `id1/GameAPI.ts` and overridden in
[hellwave/GameAPI.ts:181,188](../source/game/hellwave/GameAPI.ts#L181). And
`Multiplayer.ts` already has a half-built, commented-out map-list block
([Multiplayer.ts:61-80](../source/engine/client/menu/Multiplayer.ts#L61-L80)) plus a
`// FIXME: move the start server list to the ClientGameAPI` comment sitting right at
[Multiplayer.ts:95](../source/engine/client/menu/Multiplayer.ts#L95). This plan mostly
finishes work that was already flagged, rather than inventing a new subsystem.

### Decisions made with the user

1. **Full Quake III Arena–style split, not a partial one.** Earlier drafts of this plan kept
   "generic" pages (`options`, `keys`, `help`, `quit`, `alert`, `load`, `save`) engine-owned
   and only moved id1-specific pages (`main`, `singleplayer`, `multiplayer`,
   `launch_server`) to game code. That's out: **no page is engine-owned.** The engine's job
   shrinks to "the player wants UI/menu time" (own the stack/navigation/widget toolkit,
   own input routing into and out of the menu), exactly like Q3A's engine only knows to
   call into the `ui`/`cgame` VM for menu content, never what a screen contains.
2. **`SessionDiscovery` as a `ClientEngineAPI` service** — confirmed, see Design B.
3. **Remove the `menu_*` console commands** (`menu_main`, `menu_singleplayer`, `menu_load`,
   `menu_save`, `menu_multiplayer`, `menu_setup`, `menu_options`, `menu_keys`, `help`,
   `menu_quit`, `menu_server_launch` — all registered at
   [Menu.ts:1004-1014](../source/engine/client/Menu.ts#L1004-L1014)). They're id1-page-name
   trivia baked into the engine; once the engine has no opinion on what pages exist, it has
   no business registering commands named after them. See Design E for what (if anything)
   replaces them.

### Two things that don't fit neatly into "game code owns everything" — resolved below

**The cached-reference / hardcoded-`'main'` problem** (already identified in an earlier
pass): `MenuStack.register(name, page)` is just `this.pages.set(name, page)`
([MenuStack.ts:27-29](../source/engine/client/menu/MenuStack.ts#L27-L29)), so re-registering
a page name from game code already works structurally — except `M` caches page references
for "already showing, don't re-push" checks (`#mainPage`
[Menu.ts:462](../source/engine/client/Menu.ts#L462), `#multiplayerPage`
[Menu.ts:757](../source/engine/client/Menu.ts#L757), `#quitPage`
[Menu.ts:786](../source/engine/client/Menu.ts#L786), module-level `launchServerMenu`
[Menu.ts:793](../source/engine/client/Menu.ts#L793)), and hardcodes the literal string
`'main'` directly in `CloseMenu()`/`PopMenu()` control flow
([Menu.ts:678-692](../source/engine/client/Menu.ts#L678-L692)), not just the registration
table. Fixed by an explicit, name-resolved **root page** concept (Design A) — now more
important than before, since *every* page (not just `main`) is about to be registered from
game code instead of built inline.

**The `Host.Alert` problem** (newly discovered while planning full ownership): engine-common
code already calls into the menu system directly — `Host.EndGame` and `Host.Error`
([Host.ts:211,234](../source/engine/common/Host.ts#L211)) both call `M.Alert(...)` for
system-level faults (server crash, fatal error). `Host.ts` is shared client/server code
(`source/engine/common/`), and this call is unconditional — not guarded by
`registry.isDedicatedServer` the way the adjacent `SCR.EndLoadingPlaque()` call is
([Host.ts:221](../source/engine/common/Host.ts#L221)). If the `'alert'` page becomes
something only game code may or may not have registered (e.g. mid-`Init()`, or a future mod
that doesn't implement one), the engine's own fault-reporting path can't depend on it —
exactly the reason Q3A's `Com_Error` never routes through the `ui` VM. Resolved in Design D:
`Host.ts` stops calling `M.Alert` and instead publishes an event; `Con.PrintError`/
`Con.PrintSuccess` (already called immediately before `M.Alert` at both call sites) remains
the one guaranteed-to-work baseline regardless of whether any game code is listening, and
game code decides independently whether/how to render something richer.

## Goals

- The engine owns menu *machinery only*: `MenuStack`/`MenuPage`/`MenuItem`/layouts, the
  low-level drawing primitives widgets call into (`M.Print`, `M.DrawPic`, `M.DrawSlider`,
  ...), mouse/back-button mechanics, and the connection-state-aware open/close/toggle
  behavior (Escape, click-to-open-while-disconnected, involuntary-disconnect recovery).
  It has zero knowledge of what any page contains, including `options`/`keys`/`load`/`save`.
- id1 owns every built-in page (`main`, `singleplayer`, `multiplayer`, `launch_server`,
  `options`, `keys`, `help`, `quit`, `load`, `save`) via `ClientGameAPI.Init()`, using only
  `ClientEngineAPI.Menu` — no engine-internal imports from game code.
- hellwave overrides only what it needs (`main`, plus a new `newgame` page) and inherits
  everything else from id1 through normal subclassing (`super.Init()`), proving the
  ownership model actually composes instead of requiring every mod to reimplement settings
  screens from scratch.
- hellwave's main menu shows buttons plus a live list of joinable sessions on the same page
  (user idea 1).
- hellwave's "new game" entry shows available maps to host (user idea 2), finishing the
  commented-out block in `Multiplayer.ts`.
- hellwave's main menu can still reach the generic pages, e.g. "Controls" (user idea 3) —
  works via `Push('options')` / `Push('keys')` once id1 has registered them.
- The live-session fetch and the save-slot storage format both become reusable
  `ClientEngineAPI` services instead of being hand-rolled inline in whichever page needs
  them (today: duplicated fetch logic, and direct `localStorage`/`COM.searchpaths` access
  from inside `Menu.ts`).
- `Host.ts`'s fault-reporting no longer has a hard dependency on the menu/page-registry
  system.

## Non-goals (this pass)

- No redesign of the actual visual layout/art direction for hellwave's main menu — this
  plan covers the plumbing (what pages exist, what data/APIs they're built from), not pixel
  layout.
- No changes to the master-server `/list-servers` API shape.
- No change to the on-disk/in-`localStorage` save-game format itself — only to *who* is
  allowed to read/write it (Design C moves that access behind an API, it doesn't change the
  format).
- Not building a generic "any mod can theme the system alert" mechanism — Design D is
  intentionally minimal (an event + whatever game code chooses to do with it).
- Not building a secondary-stack / focus-arbitration mechanism for *modal* in-game panels
  (see the note at the end of Design F). *Non-modal* in-game panels already work today with
  no engine changes (hellwave's buy menu, Design G) — this only applies to a hypothetical
  future panel that needs to steal input focus without being the pause menu, and nothing
  currently planned needs that.

## Design

### A. `MenuStack` root page + `isShowing()` — kill the cached-reference pattern

Add to `MenuStack` ([MenuStack.ts](../source/engine/client/menu/MenuStack.ts)):

```typescript
#rootPageName: string | null = null;

isShowing(name: string): boolean {
  const page = this.pages.get(name);
  return page !== undefined && this.current() === page;
}

setRootPage(name: string): void {
  console.assert(this.pages.has(name), `MenuStack.setRootPage: unknown page "${name}"`);
  this.#rootPageName = name;
}

pushRoot(): void {
  console.assert(this.#rootPageName !== null, 'MenuStack.pushRoot: no root page set');
  this.push(this.#rootPageName!);
}

isShowingRoot(): boolean {
  return this.#rootPageName !== null && this.isShowing(this.#rootPageName);
}
```

`setRootPage` is name-based, not instance-based — the root is "whichever page is currently
registered under this name," resolved fresh every time. That means when hellwave later
re-registers `'main'` to a different `MenuPage` instance (Design G), the root stays correct
automatically: nothing needs to call `setRootPage` again, because the indirection is by
name, exactly the way `RegisterPage`/`Push`/`Replace` already work everywhere else in this
system.

Expose the setter to game code via `ClientEngineAPI.Menu.SetRootPage(name: string): void`,
alongside the existing `RegisterPage`/`Push`/etc.
([GameAPIs.ts:1228](../source/engine/common/GameAPIs.ts#L1228)).

While touching this namespace: `ClientEngineAPI.Menu` today only proxies a hand-picked
subset of `MenuStack`'s methods. `MenuStack` itself already has `clear()`, `depth()`,
`isEmpty()`, `popTo(depth)`, `popToRoot()`
([MenuStack.ts:111-159](../source/engine/client/menu/MenuStack.ts#L111-L159)) that
`ClientEngineAPI.Menu` never exposed — every time a mod needed one more stack primitive,
someone had to hand-write one more wrapper. Add the missing ones (`Clear`, `Depth`,
`IsEmpty`, `PopTo`, `PopToRoot`) alongside `SetRootPage` now, so the façade covers the
full `MenuStack` surface rather than staying perpetually one method behind whatever a mod
needs next. This is *not* the same thing as handing the stack itself off to game code (see
the note at the end of Design F) — it's closing the gap between what `MenuStack` can do and
what's actually reachable through the public API.

Replace every engine-internal place that currently hardcodes `'main'` or caches a page
reference with the root-page indirection:

| Before | After |
|---|---|
| `M.menuStack.push('main')` (`Menu_Main_f`, [Menu.ts:733](../source/engine/client/Menu.ts#L733)) | `M.menuStack.pushRoot()` |
| `M.menuStack.current() !== M.menuStack.pages.get('main')` (`CloseMenu`, [Menu.ts:678](../source/engine/client/Menu.ts#L678)) | `!M.menuStack.isShowingRoot()` |
| `M.menuStack.push('main')` (`PopMenu`, [Menu.ts:692](../source/engine/client/Menu.ts#L692)) | `M.menuStack.pushRoot()` |
| `M.menuStack.current() !== M.#mainPage` (`ToggleMenu_f`, [Menu.ts:711](../source/engine/client/Menu.ts#L711)) | `!M.menuStack.isShowingRoot()` |
| `M.menuStack.current() === M.#multiplayerPage` ([Menu.ts:757](../source/engine/client/Menu.ts#L757)) | dead — page + check both move to id1 (Design F) |
| `M.menuStack.current() === M.#quitPage` ([Menu.ts:786](../source/engine/client/Menu.ts#L786)) | dead — same |
| `M.menuStack.current() === launchServerMenu` ([Menu.ts:793](../source/engine/client/Menu.ts#L793)) | dead — same |

Only the root indirection survives in the engine; the other cached-reference checks don't
need an `isShowing()` replacement in `Menu.ts` at all, because the pages and the "don't
re-push" checks around them both move to id1 wholesale (Design F). `isShowing(name)` is
still worth keeping on `MenuStack` as a small reusable primitive — id1 will want the same
"already open" guard for its own multiplayer/quit pages, and it's cheap to expose.

### B. Extract session discovery into a reusable engine service

Pull the fetch + parse + mod-filter logic out of
`MultiplayerMainMenu.refreshSessions()` ([Multiplayer.ts:141-203](../source/engine/client/menu/Multiplayer.ts#L141-L203))
into a small class, e.g. `source/engine/client/menu/SessionDiscovery.ts`, exposing:

```typescript
interface DiscoveredSession {
  readonly sessionId: string;
  readonly map: string;
  readonly currentPlayers: number;
  readonly maxPlayers: number;
  readonly colo: string | null;
  readonly country: string | null;
}

class SessionDiscovery {
  static async listSessions(): Promise<DiscoveredSession[]>;
}
```

It keeps the existing `serverInfo?.mod === COM.game` filter internally (id1 and hellwave
sessions must never cross-list). Expose it as `ClientEngineAPI.Multiplayer.ListSessions()`
(new namespace, parallel to `Menu`) — this is data, not UI. Resolves the FIXME at
[Multiplayer.ts:95](../source/engine/client/menu/Multiplayer.ts#L95): id1's `launch_server`
page and hellwave's inline main-menu lobby both call the same service instead of one
re-implementing the fetch.

### C. Save-slot access becomes a service, not raw `localStorage`

`#scanSaves()` ([Menu.ts:809-832](../source/engine/client/Menu.ts#L809-L832)) reads
`localStorage.getItem('Quake.<gamedir>/s<i>.json')` directly, parses `SaveGameData` for a
label, and temporarily swaps `COM.searchpaths` to `COM.gamedir` while it does so; the load
and save pages themselves call `localStorage.removeItem('Quake.<gamedir>/s<index>.sav')`
directly for slot deletion ([Menu.ts:895,918](../source/engine/client/Menu.ts#L895)). None
of this should leak into game code as-is — the storage key format and the
`COM.searchpaths` dance are engine internals, and game code reaching into `localStorage`
directly would hardcode a format the engine should be free to change later (e.g. a move to
IndexedDB). Add a small `ClientEngineAPI.SaveSlots` service instead:

```typescript
interface SaveSlotInfo {
  readonly index: number;
  readonly label: string;
  readonly mapname: string | null;
  readonly hasData: boolean;
}

static readonly SaveSlots = {
  List(maxSlots: number): SaveSlotInfo[] { /* wraps #scanSaves's logic */ },
  Delete(index: number): void { /* wraps the localStorage.removeItem calls */ },
};
```

`mapname` is exposed as its own field rather than only folded into `label` (today
`label = gamestate.comment || gamestate.mapname || ''`,
[Menu.ts:821](../source/engine/client/Menu.ts#L821), discarding `mapname` once `comment`
wins). Keeping it separate lets a save/load screen cross-reference
`ServerGameInterface.GetMapList()`'s `pictures` field
([GameInterfaces.ts:145-150](../source/shared/GameInterfaces.ts#L145-L150)) to show a map
thumbnail next to each slot — not needed for id1's current text-only slot list, but there's
no reason to throw the data away at the API boundary when a future mod might want it.

id1's `load`/`save` pages call `List()`/`Delete()` for slot metadata and deletion, and
issue the actual load/save via `engineAPI.AppendConsoleText('load s0\n')` /
`'save s0\n'` — already an existing, working pattern (used today by
`StartGameHandler.startMultiplayerGame()` in
[hellwave/client/ClientAPI.ts:56](../source/game/hellwave/client/ClientAPI.ts#L56)), so no
new plumbing is needed for the load/save *action* itself, only for listing/deleting slots.

### D. `Host.Alert`/`Host.Error` go through the event bus, not `M.Alert`

Per the discussion above: replace both `M.Alert(...)` calls in `Host.ts`
([Host.ts:211,234](../source/engine/common/Host.ts#L211)) with an event-bus publish,
carrying a `severity` so game code can distinguish "the level ended" from "something
actually broke" without having to pattern-match the title string:

```typescript
type HostAlertSeverity = 'info' | 'error';

interface HostAlertEvent {
  readonly title: string;
  readonly message: string;
  readonly severity: HostAlertSeverity;
}

// Host.EndGame — expected, benign (level transition, demo end, etc.)
eventBus.publish('host.alert', { title: 'Host.EndGame', message, severity: 'info' });

// Host.Error — a genuine fault
eventBus.publish('host.alert', { title: 'Host Error', message: error, severity: 'error' });
```

This is a textbook case for the event bus per the project's own guidance (lifecycle event,
no return value needed, exactly the kind of thing `'game.start'`/`'player.spawn'` already
cover) — and it fully decouples `common/Host.ts` from the client-only menu system, which is
an existing, independent smell worth fixing regardless of this plan (`Host.ts` currently
imports `M` from `getClientRegistry()` unconditionally, even though `Host.ts` is shared
client/server code). `severity` gives id1's `host.alert` handler (Design F) a cheap way to
choose presentation later (e.g. a quiet toast for `'info'`, a blocking dialog for
`'error'`) without needing a second event or title-string sniffing.

No new engine-native fallback UI is needed: `Con.PrintError(...)`/`Con.PrintSuccess(...)`
already run immediately before both `M.Alert` calls today and remain unconditional — that's
the one guaranteed-to-work path regardless of whether any game module is loaded or has
subscribed to `host.alert`. id1's `ClientGameAPI.Init()` subscribes to `host.alert` and
pushes its own `'alert'`-style dialog page in response; if a future mod doesn't subscribe,
the player still sees the error in the console, same as a dedicated server or headless
context already behaves today. Document `host.alert` in `docs/events.md` alongside the
existing menu events.

### E. What's left of the command surface

Delete every `Cmd.AddCommand('menu_*', ...)` / `Cmd.AddCommand('help', ...)` registration
at [Menu.ts:1004-1014](../source/engine/client/Menu.ts#L1004-L1014) — all nine of them.
`Menu_SinglePlayer_f`, `Menu_Load_f`, `Menu_Save_f`, `Menu_MultiPlayer_f`,
`Menu_Options_f`, `Menu_Keys_f`, `Menu_Help_f`, `Menu_Quit_f`, `Menu_Launch_Server_f` are
each called from exactly two places today: their own command registration, and a button
`Action` inside one of the pages that's moving to id1
([Menu.ts:840-938](../source/engine/client/Menu.ts#L840-L938)). Once those buttons call
`engineAPI.Menu.Push('singleplayer')` etc. directly instead of routing through an
engine-owned wrapper, every one of these nine functions is dead code — delete them, not
just their commands.

`Menu_Main_f` (or whatever it's renamed to once it's just "push the root") is the one
survivor, because it's called from genuinely engine-internal, content-agnostic places that
have nothing to do with named pages:

- `Key.ts:569` — mouse click opens the menu while disconnected and the console is up (the
  mouse-only escape hatch documented in `docs/menu-system.md`).
- `Menu.ts:28-32` (module scope) — an involuntary disconnect (server shutdown/kick/timeout)
  with no menu currently open brings the root menu up rather than leaving a blank screen.
- `ToggleMenu_f` itself (Escape key, wired from `Key.ts:478,513,558`).

All three are "the player needs *some* menu, right now, and the engine doesn't know or care
what's in it" — exactly the one console command worth keeping is `togglemenu`
([Menu.ts:1003](../source/engine/client/Menu.ts#L1003)), already bound to Escape by
default, and it stays exactly as-is (it already routes through `ToggleMenu_f` → the root
indirection from Design A, no page-name knowledge required).

**Parked for later, not part of this pass:** the nine deleted commands are console/bind
muscle memory some players may still type or have bound. `ClientEngineAPI.RegisterCommand`/
`UnregisterCommand` already exist
([GameAPIs.ts:892-896](../source/engine/common/GameAPIs.ts#L892-L896)) for game code to
bring any of these back — id1 re-registering them, pointed at its own pages, would restore
the exact old behavior. Listed here so the mapping isn't lost, but deciding *whether* and
*when* id1 picks this up is deferred:

| Old command | Would become (id1, via `RegisterCommand`) |
|---|---|
| `menu_singleplayer` | `engineAPI.Menu.Open('singleplayer')` |
| `menu_load` | `engineAPI.Menu.Open('load')` |
| `menu_save` | `engineAPI.Menu.Open('save')` |
| `menu_multiplayer` | `engineAPI.Menu.Open('multiplayer')` |
| `menu_setup` | `engineAPI.Menu.Open('multiplayer')` (was a second alias for the same page, [Menu.ts:1009](../source/engine/client/Menu.ts#L1009)) |
| `menu_options` | `engineAPI.Menu.Open('options')` |
| `menu_keys` | `engineAPI.Menu.Open('keys')` |
| `help` | `engineAPI.Menu.Open('help')` |
| `menu_quit` | `engineAPI.Menu.Open('quit')` |
| `menu_server_launch` | `engineAPI.Menu.Open('launch_server')` |

(`menu_main` isn't in this table — `togglemenu` already covers it and stays engine-owned.)
Using `Menu.Open` rather than `Menu.Push` matches the original semantics
(`Key.destination = KeyDestination.menu; M.menuStack.push(...)`,
[Menu.ts:737-805](../source/engine/client/Menu.ts#L737-L805)): these were always callable
from outside an already-open menu (a bind pressed mid-game), which is exactly what `Open`
is for per `docs/menu-system.md`.

### F. id1 takes ownership of every built-in page

In `source/game/id1/client/ClientAPI.ts`, inside `Init(engineAPI)`
([ClientAPI.ts:301](../source/game/id1/client/ClientAPI.ts#L301)), port over and register
all of:

- `'main'` — buttons (SinglePlayer/MultiPlayer/Options/Help/Quit), id1 art
  (`ttl_main`/`mainmenu`), ported from
  [Menu.ts:835-858](../source/engine/client/Menu.ts#L835-L858). Pics load via the
  already-exposed `engineAPI.LoadPicFromWad`/`LoadPicFromLump`
  ([GameAPIs.ts:904-912](../source/engine/common/GameAPIs.ts#L904-L912)).
- `'singleplayer'` — New Game / Load / Save, ported from
  [Menu.ts:860-878](../source/engine/client/Menu.ts#L860-L878).
- `'load'` / `'save'` — slot lists, ported from
  [Menu.ts:880-929](../source/engine/client/Menu.ts#L880-L929), rebuilt on
  `engineAPI.SaveSlots.List()`/`.Delete()` (Design C) instead of raw `localStorage`.
- `'multiplayer'` — the `MultiplayerSetupPage` class (name/color/join,
  [Menu.ts:325](../source/engine/client/Menu.ts#L325)).
- `'launch_server'` — rebuilt on `SessionDiscovery.listSessions()` (Design B) instead of
  embedding its own fetch; replaces `Multiplayer.ts`'s `MultiplayerMainMenu` class.
- `'options'` / `'keys'` / `'help'` / `'quit'` — ported from
  [Menu.ts:900-993](../source/engine/client/Menu.ts#L900-L993). The `Slider`/`Toggle`
  widgets already bind directly to a cvar by name (e.g. `new Toggle({ cvar: 'sv_public' })`,
  already used in `Multiplayer.ts:86-93`), so porting `options` needs no new cvar-access
  API — it's just data (which cvars, labels, ranges) fed into widgets id1 already has
  access to via `ClientEngineAPI.Menu`. Likewise `KeyBindItem`
  ([MenuItem.ts:730](../source/engine/client/menu/MenuItem.ts#L730)) already owns all key
  binding read/write internally — `keys` is also just data (which commands, which labels).
- `'alert'` — a generic dialog page id1 registers for its own use (subscribing to
  `host.alert`, Design D, and for any in-game "are you sure"/"failed to X" UX it wants).

**Not everything here is a pure copy-paste.** Tracing every non-widget reference inside
the page bodies that move turns up two more small gaps beyond `SaveSlots`/
`SessionDiscovery`:

- `singlePlayerPage`'s "New Game" action checks `SV.server.active` and `CL.cls.state`/
  `clientConnectionState.connected` directly
  ([Menu.ts:867](../source/engine/client/Menu.ts#L867)) before deciding whether to
  disconnect first. Neither is exposed via `ClientEngineAPI` today — add two small
  read-only getters (e.g. `ClientEngineAPI.SV.active`, `ClientEngineAPI.CL.connected`) in
  the same shape as the existing `CL`/`VID`/`Key` namespaces
  ([GameAPIs.ts:1112-1178](../source/engine/common/GameAPIs.ts#L1112-L1178)).
  `Cmd.ExecuteString('disconnect')` isn't a gap — `engineAPI.AppendConsoleText('disconnect\n')`
  ([GameAPIs.ts:319](../source/engine/common/GameAPIs.ts#L319)) already covers it, already
  used the same way in `hellwave/client/ClientAPI.ts:56`.
- `mainPage`'s `onEscape` saves/restores the demo-loop cursor around opening the menu
  (`CL.cls.demonum = M.#saveDemonum`,
  [Menu.ts:846-856](../source/engine/client/Menu.ts#L846-L856)). Recommend **not** porting
  this to id1 at all — it's genuinely content-agnostic ("pause the demo loop while *any*
  menu is open, resume when it fully closes"), not specific to what's on the main page, so
  it belongs generalized into the engine's own root open/close path (Design A/E) instead of
  requiring id1 to know about `CL.cls.demonum`.

Neither of these blocks the port — they're the same shape of small, additive API surface
as `SetRootPage`/`SaveSlots`/`SessionDiscovery`, just discovered later. Flagging them here
so Phase 2 doesn't rediscover them mid-port.

**Visual freedom, while porting `main`/etc.:** the page tree above reuses the stock
widgets/layouts, matching id1's classic look, and that's the right default for a
byte-for-byte-behavior port. But nothing forces that — `MenuPage.customDraw`
([MenuPage.ts:16,134-135](../source/engine/client/menu/MenuPage.ts#L16)) lets any page
bypass the widget/layout system entirely while still participating in the stack
(push/pop/Escape/back button), and `ClientEngineAPI.DrawString`
([GameAPIs.ts:953](../source/engine/common/GameAPIs.ts#L953)) is a separate,
resolution-aware, arbitrary-scale/color text renderer already exposed to game code and
already used by hellwave's HUD ([HUD.ts:174](../source/game/hellwave/client/HUD.ts#L174))
— unrelated to `M.Print`'s classic bitmap-font/virtual-320-space renderer the stock widgets
draw with. A mod wanting a genuinely different visual language for its menus (not just a
different page tree) already can, today, with zero engine changes — `customDraw` +
`DrawString`/`DrawPic`, at the cost of also owning `handleInput()` for that page since
there's no item list left for the default dispatch to walk.

id1's `Init()` ends with:

```typescript
engineAPI.Menu.RegisterPage('main', mainPage);
// ... register singleplayer, load, save, multiplayer, launch_server, options, keys, help, quit, alert ...
engineAPI.Menu.SetRootPage('main');
engineAPI.eventBus.subscribe('host.alert', ({ title, message, severity }) => {
  // show the alert page (or a lighter-weight toast for severity === 'info'),
  // however id1 wants to present it
});
```

This is the concrete answer to "the game says: my root menu is the main menu" — nothing in
the engine assumes `'main'` is special, id1 declares it via the same registration mechanism
every other page uses.

`pushRoot()` already asserts `#rootPageName !== null` (Design A), so if `Init()` were ever
skipped or ran too late, it fails loudly in development instead of silently pushing
`undefined` — worth confirming during implementation that `Init()` genuinely always runs
before the first possible menu-open, but no longer a silent-failure risk either way.

`Menu.ts` shrinks to: the `M` drawing primitives, mouse/back-button handling,
`MenuStack`-adjacent open/close/toggle logic (Design A/E), and the `togglemenu` command.
Delete `source/engine/client/menu/Multiplayer.ts` entirely once its logic is absorbed into
`id1/client/ClientAPI.ts` + `SessionDiscovery`.

**Why the `MenuStack` instance itself stays engine-owned, not handed off to game code.**
Traced end-to-end: `SCR.ts:430` calls `M.Draw()` unconditionally every frame (a no-op
unless `Key.destination === KeyDestination.menu`,
[Menu.ts:1118-1120](../source/engine/client/Menu.ts#L1118-L1120)), and `Key.ts:601`
dispatches to `M.Keydown(key)` under the same condition. Both are single, hardwired calls
into one instance — not per-page, not per-mod. Handing the stack's *ownership* to game code
wouldn't remove that wiring, it would just mean the engine still needs to be told which
stack is "the" active one for these two call sites, and the content-agnostic behaviors in
Design A/E (`togglemenu`, disconnected click-to-open, involuntary-disconnect-reopen) would
all need reimplementing on the game side since they depend on querying *the* stack's
`current()`/`isEmpty()` generically, without knowing page names. What was a real gap — the
`ClientEngineAPI.Menu` façade only exposing a hand-picked subset of `MenuStack`'s methods —
is fixed above (Design A) by exposing the full surface, which gets the flexibility this
was actually about without breaking the one-stack assumption the render/input loop already
hardwires.

That one-stack assumption is specifically about the *pause* stack, though — it says nothing
about a second, independent stack for a bespoke modal in-game panel (something that isn't
the pause menu but still needs to steal input focus, e.g. a hypothetical team-select bound
to its own key). `MenuStack` isn't a hardcoded singleton internally — it only reaches out to
the shared `M.entersound`/`IN.ReleasePointerLock()` for consistent feedback
([MenuStack.ts:68,72](../source/engine/client/menu/MenuStack.ts#L68)) — so a second instance
is cheap to create. What's missing for that case isn't the stack, it's focus arbitration:
the only existing precedent for stealing input priority ahead of `Key.destination` is the
console (`Con.isOpen`, checked early in `Key.Event()`), and it's bespoke to the console, not
generalized. Non-modal in-game panels (hellwave's buy menu — see Design G) already work
today with zero engine changes, since `MenuPage`/`MenuItem` don't touch
`Key.destination`/`M.menuStack` at all. A generalized secondary-stack/focus-arbitration
mechanism is the natural next extension if a mod ever needs a *modal* in-game panel, but
nothing shipped needs it yet — treated as future work, not part of this plan (see Non-goals).

### G. hellwave's custom layout

In `source/game/hellwave/client/ClientAPI.ts`, inside the existing `Init(engineAPI)`
override ([ClientAPI.ts:130](../source/game/hellwave/client/ClientAPI.ts#L130)), after
`super.Init(engineAPI)` (which now does all of Design F):

- Re-register `'main'` with a page combining static buttons (New Game, Controls, Quit —
  wired to `Push('newgame')` / `Push('keys')` / `Push('quit')`) and the live lobby,
  populated from `engineAPI.Multiplayer.ListSessions()`, rendered inline on the same page
  rather than as a separate push (idea 1) — the same `Action`/`Label`/`VerticalLayout`
  construction hellwave's `HUD.ts` buy menu already uses, just pointed at session data
  instead of shop items. hellwave does **not** need to call `SetRootPage` itself — the root
  is still the name `'main'`, resolved fresh (Design A), so overwriting what `'main'` points
  to is enough.
- Register a new `'newgame'` page built from `ServerGameAPI.GetMapList()`
  ([hellwave/GameAPI.ts:181](../source/game/hellwave/GameAPI.ts#L181)) — one `Action` per
  map that starts a hosted session, finishing the pattern already stubbed at
  [Multiplayer.ts:61-80](../source/engine/client/menu/Multiplayer.ts#L61-L80). Not reusing
  `'singleplayer'`: hellwave's `startSingleplayerGame()` already just auto-picks a random
  map ([ClientAPI.ts:34-52](../source/game/hellwave/client/ClientAPI.ts#L34-L52)), so
  `'singleplayer'` isn't a meaningful concept here — the map picker is really a multiplayer
  host flow wearing a "New Game" label.
- Everything else — `'options'`, `'keys'`, `'load'`, `'save'`, `'help'`, `'quit'`,
  `'multiplayer'`, `'launch_server'`, `'alert'` — comes from `super.Init()` unchanged. Idea
  3 needs no new code, and this is the payoff of moving *all* pages to id1 rather than just
  the id1-specific ones: hellwave inherits a fully working settings/save/load/browse stack
  for free and only writes the two pages it actually wants to change.
- hellwave may also subscribe to `host.alert` itself (overriding id1's handler) if it wants
  its own alert presentation; not required for this plan's goals.

## Phasing

1. **Engine groundwork** — done. `MenuStack` root-page + `isShowing()` (Design A),
   `SessionDiscovery` + `ClientEngineAPI.Multiplayer.ListSessions()` (Design B),
   `ClientEngineAPI.SaveSlots` (Design C), `Host.ts` → `host.alert` event bus migration
   (Design D).
2. **id1 ownership** — done. Every page (`main` through `alert`) now lives in
   `source/game/id1/client/Menu.ts`, registered from `ClientGameAPI.Init()`. `Menu.ts`
   builds no pages at all anymore; `Multiplayer.ts` is deleted. See "What actually shipped
   in Phase 2" below for the handful of things that came up mid-port that the original
   design didn't anticipate.
3. **hellwave layout** — not started. New `'main'` override with inline lobby, new
   `'newgame'` page from `GetMapList()`.

Land and fully verify id1 after phase 2 before starting phase 3.

### What actually shipped in Phase 2

The page-by-page port needed more composition surface than Design A–E anticipated, since
several built-in pages (`quit`, `alert`, `help`, `keys`, `multiplayer`) subclassed
`MenuPage`/`Textbox` directly in the old engine code — not possible from game code, which
can only configure instances, never `extends` an engine base class. Added to close that
gap, all under `ClientEngineAPI.Menu` unless noted:

- **`MenuPage` composition hooks**: `customHandleInput(key, page, defaultHandleInput)` and
  `customGetBackButtonAnchor()`, alongside the pre-existing `customDraw`. Together these
  replace what subclassing `MenuPage`/`DialogPage` used to do (help's page-turning, the
  quit dialog's Y/N + backdrop + repositioned back button, options' "extra instructional
  text drawn after the normal layout").
- **`Textbox.customDraw(textbox, x, y, focused)`** plus a widened `getCursorGlyph()`
  (public, computes blink phase internally — was `protected _getCursorGlyph(blinkPhase)`,
  usable only by an engine-side subclass). Needed for the multiplayer setup screen's name
  field, which draws its input box in a fixed column rather than below the label.
- **`GetPreviousPage()`** — the page one level below the current one, for a dialog's
  `getBackdrop`. `MenuStack.stack` is already public; this just reads `stack.at(-2)`.
- **Drawing primitives re-exported on `ClientEngineAPI.Menu`**: `Print`, `PrintWhite`,
  `DrawCharacter`, `DrawPic`, `DrawPicTranslate`, `DrawTextBox`, `DrawSlider`, plus
  read-only `mouseX`/`mouseY`. Every `custom*` hook above needs these to draw anything.
- **`ForceClose()`** — clears the stack and returns to the game unconditionally, even
  while disconnected. `Close()`'s disconnected-collapses-to-root behavior is specifically
  wrong for "New Game," which is the one action that's itself about to make "disconnected"
  stop being true.
- **`ToggleConsole()`**, **`ForceQuit()`** — thin wrappers (`Con.ToggleConsole_f()`,
  `Host.ForceQuit()`) for the options page's "Go to console" and the quit dialog's "Yes".
- **`StartSingleplayerGame()`** — routes to `ClientLifecycle.startGame`. Lives on `M`
  (`M.StartSingleplayerGame()`) rather than being called directly from `GameAPIs.ts`,
  because `ClientLifecycle.ts` already imports `GameAPIs.ts` — importing it back would
  have been a circular import (caught by a full-suite test run: it manifested as an
  unrelated `ReferenceError: Cannot access 'ClientEntities' before initialization` in
  `ClientState.ts`, not an obvious error at the import site itself).
- **`LoadTranslatablePic(lumpName)`** — generalized from the `menuplyr`-specific inline
  LMP-palette-parsing block that used to live in `M.Init()`. Kept engine-side (raw asset
  format handling, not menu content); id1 calls it directly instead of the engine
  preloading `menuplyr` for a page that no longer exists in `Menu.ts`.
- **`SV.active` / `CL.connected` getters** — already anticipated in the original plan's
  open questions, now actually wired up and used by the singleplayer and multiplayer
  pages.
- **`StartServerListEntry.callback` typed as `CommonEngineAPI`** (in `GameInterfaces.ts`) —
  was typed as taking a full `ServerEngineAPI`, but every real implementation (id1's,
  hellwave's) only ever calls `.AppendConsoleText()` on it. Since the callback is now
  invoked from the *client*-side `launch_server` page (no `ServerEngineAPI` exists yet —
  there's no server until this action starts one), the type was narrowed to `CommonEngineAPI`
  — the real shared base class both `ClientEngineAPI` and `ServerEngineAPI` extend — letting
  the client pass its own engine reference directly. An earlier version of this fix used a
  standalone duck-typed `ConsoleTextEngineAPI` interface instead; that was replaced with
  `CommonEngineAPI` because a structurally-independent lookalike interface doesn't resolve
  via go-to-definition/find-references tooling the way a real shared base class does.
- **`host.quit-requested` event** (new, alongside `host.alert`) — `Host.Quit_f()` used to
  call `M.Menu_Quit_f()` directly; same fix as `host.alert`, for the same reason (the
  `quit` page it used to reach into no longer exists in the engine at all).
- **Dead code removed while touching adjacent lines**: `PlayerSkin` (a `MenuItem`
  subclass referencing `M.bigbox`/`M.menuplyr`, confirmed unused anywhere in the codebase
  before deleting).
- **Test fixture work**: `source/game/id1/test/client/fixtures.ts`'s `createMockClientEngine()`
  gained a `Menu`/`SaveSlots`/`Multiplayer`/`SV` mock (real widget/layout classes plus a
  from-scratch, registry-free stack implementation — deliberately not the real `MenuStack`,
  which touches `M.entersound`/`IN.ReleasePointerLock()` on every push/pop) so that
  `ClientGameAPI.Init()` — which now unconditionally builds the full menu tree — doesn't
  crash in tests that have nothing to do with menus.

## Testing

- `MenuStack.isShowing()` / `setRootPage()` / `pushRoot()` / `isShowingRoot()` — unit tests
  covering: a registered page matching/not matching `isShowing`; `pushRoot()` before any
  root is set (should assert); `setRootPage` re-pointed at a different page instance under
  the same name and `isShowingRoot()` still resolving correctly (the exact scenario Design G
  relies on for hellwave's override).
- `SessionDiscovery.listSessions()` — unit test with a mocked `fetch`, covering the
  mod-filter behavior (mixed id1/hellwave sessions in the response) and the error path.
- `ClientEngineAPI.SaveSlots.List()`/`.Delete()` — unit tests with mocked `localStorage`,
  covering empty/populated slots and deletion.
- `host.alert` — unit test that `Host.EndGame`/`Host.Error` publish the event with the
  expected payload, and that `Con.PrintError`/`PrintSuccess` still fire unconditionally
  regardless of whether anything is subscribed.
- id1 `ClientAPI.ts` menu construction — smoke-test that `Init()` registers all ten page
  names, sets the root to `'main'`, and that `'main'`'s items match the expected
  count/labels (regression coverage for the port, following the fixture patterns in
  `source/game/id1/test/`).
- hellwave `ClientAPI.ts` — test that `'main'` renders both static buttons and
  session-derived actions given a mocked `ListSessions()` result, that `'newgame'` produces
  one action per `GetMapList()` entry, and that pages not overridden by hellwave
  (`'options'`, `'load'`, ...) are still reachable after `Init()`.
- Manual: run the dev server, click through id1's full menu tree (main → singleplayer →
  load/save, main → multiplayer → launch_server → join, main → options/keys/help/quit) and
  hellwave's (main → newgame → host, main → live lobby → join, main → options/keys),
  confirm Escape/click-to-open/involuntary-disconnect behavior at every level.

## Open questions

All resolved:

- **`SaveSlotInfo` includes `mapname`** (Design C) — exposed as its own field (not just
  folded into `label`) so a future mod's save/load screen can show a map thumbnail via
  `GetMapList()`'s `pictures`.
- **`host.alert` carries a `severity: 'info' | 'error'`** (Design D) — `Host.EndGame` is
  `'info'`, `Host.Error` is `'error'`, one event covers both.
- **The nine legacy `menu_*` commands are parked, not ported** (Design E) — cataloged in a
  table with their `Menu.Open(...)` equivalents, but re-registering them via
  `RegisterCommand` is deferred to whenever id1 (or a mod) actually wants that console/bind
  compatibility back, not required for this plan's phases to be considered complete.

Remaining implementation-time check, not a design fork:

- Confirm no other `.mjs`/legacy callers depend on the `menu_*` commands being registered
  (default keybinds, other docs) before deleting them in Phase 2 — a quick repo-wide grep
  right before that phase starts, since this plan's grep only checked as of today.
