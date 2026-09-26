# Add mouse support to the hellwave buy menu

**Status:** Done, and reworked after two playtests. What ships differs from the first-cut Design
and Testing sections below; the two playtest sections at the end supersede them. Opening and
closing are client-only (`b` runs the `hw_buymenu` command and nothing is sent to the server),
`buyzone` is `-1 | 0 | 1` with no menu-open state, purchases use impulses 111-119, and the
pointer-lock fix touched `IN.ts`, so the "no engine changes" non-goal did not survive. The buy
menu code now lives in `source/game/hellwave/client/menu/BuyMenu.ts` (it was in `HUD.ts`) and its
tests in `source/game/hellwave/test/client/menu/buy-menu.test.mjs` (they were in
`hellwave-client.test.mjs`). Line references are as of writing (2026-07-19).

## Context

The hellwave buy menu (opened with `b` inside a `func_buyzone`, keys `1`-`9` to purchase) is
currently keyboard-only. There is no dedicated "BuyMenu" class — it's a handful of methods on
`HellwaveHUD`:

- `HellwaveHUD#getBuyMenuPage()` ([HUD.ts:203-226](../source/game/hellwave/client/HUD.ts#L203-L226))
  lazily builds a real `MenuPage` (a `Label` header + one `Label` per catalog entry from
  `buyMenuItems`, [Player.ts:46-87](../source/game/hellwave/entity/Player.ts#L46-L87)), laid out
  with `VerticalLayout({ startY: 40, spacing: 4, labelX: 40, showCursor: false })`.
- `HellwaveHUD#drawBuyMenu()` ([HUD.ts:228-251](../source/game/hellwave/client/HUD.ts#L228-L251))
  runs every HUD frame, relabels/toggles each row's visibility based on `buyMenuItems` +
  current money, then calls `page.draw()` **directly** — this page is never registered with or
  pushed onto `M.menuStack`. It's a manual rendering helper invoked from `HellwaveHUD.draw()`
  ([HUD.ts:139-146](../source/game/hellwave/client/HUD.ts#L139-L146)), which itself runs
  unconditionally every frame regardless of `Key.destination` — the buy menu is a real gameplay
  HUD overlay, not a paused "menu screen."
- All rows are `Label` ([MenuItem.ts:572-586](../source/engine/client/menu/MenuItem.ts#L572-L586)),
  which hard-codes `focusable: false` — even if hooked into the click pipeline as-is, nothing
  about these rows could ever register a hit.
- Opening/closing/purchasing is done entirely through the classic Quake **impulse** mechanism —
  no dedicated input handler exists. `bind b "impulse 21"` /
  `bind 1..9/0 "impulse N"` ([data/hellwave/client.cfg:10-14](../data/hellwave/client.cfg#L10-L14))
  drive `HellwavePlayer#_handleImpulseCommands()`
  ([Player.ts:306-332](../source/game/hellwave/entity/Player.ts#L306-L332)) server-side:
  `impulse 21` toggles `buyzone` between `1` (in zone) and `2` (menu open) via
  `_buyMenuRequested()` ([Player.ts:342-359](../source/game/hellwave/entity/Player.ts#L342-L359));
  `impulse 1..9` while `buyzone === 2` calls `_buyMenuPurchase(impulse)`
  ([Player.ts:361-400](../source/game/hellwave/entity/Player.ts#L361-L400)). The updated
  `buyzone` value syncs back to the client via `clientdata`, and the HUD reacts to it
  reactively via `client.clientdata.field-changed`
  ([HUD.ts:78-93](../source/game/hellwave/client/HUD.ts#L78-L93)).

### Why mouse support doesn't already work, and why it's not a small patch

The id1 main menu got full mouse click/hover support in a recent engine change (`MenuStack`,
`MenuPage`, `Key.ts`). That pipeline is built entirely around `Key.destination ===
KeyDestination.menu`:

- `IN.onclick()` ([IN.ts:313-323](../source/engine/client/IN.ts#L313-L323)) re-acquires pointer
  lock (hides the OS cursor, switches the mouse back to relative-delta aiming) on **any** click
  while `Key.destination === game` — the state the buy menu runs in today. A click on a buy row
  would immediately re-lock the mouse mid-click.
- `IN.onpointerlockchange()` ([IN.ts:343-349](../source/engine/client/IN.ts#L343-L349))
  synthesizes an Escape keypress whenever pointer lock is lost. Fine when the real menu is
  already open (no-op); if the buy menu released pointer lock on its own while still at
  `Key.destination === game`, that synthetic Escape would leak into gameplay and pop open the
  id1 pause menu.
- `MOUSE1` is bound to `+attack` during gameplay
  ([data/hellwave/ironwail.cfg:53](../data/hellwave/ironwail.cfg#L53)); `Key.ts:582-588` executes
  that binding unconditionally whenever `Key.destination === game`. A click on a buy row would
  also fire a shot unless something suppresses it.
- Click dispatch itself (`M.Keydown` → `MenuPage._defaultHandleInput`'s `MOUSE1` branch,
  [MenuPage.ts:200-213](../source/engine/client/menu/MenuPage.ts#L200-L213), which calls
  `layout.hitTest(...)` → `item.handleClick()`/`handleInput(K.ENTER)`) is itself only ever
  invoked from `Key.ts:600-602`, gated on `Key.destination === menu`.

In short: every part of the mouse pipeline (cursor visibility, click routing, hover) assumes the
real menu stack owns input right now. Bolting mouse support onto the buy menu *without* going
through that stack means re-deriving all of the above from scratch (a bespoke pointer-lock
suspension flag, a new raw-click event bypassing `Key.destination`, manual `MOUSE1`
rebind/restore to stop `+attack` from double-firing). That was evaluated and rejected in favor
of the option below, which needs zero engine changes.

## Decision (resolved 2026-07-19)

**Promote the buy menu into a real page on `M.menuStack`.** When `buyzone` becomes `2`, call
`engine.Menu.Open('hellwave_buy')` exactly like any other menu page. This means:

- `Key.destination` becomes `menu` while shopping — **movement and looking around freeze**
  while the buy menu is open, matching how the id1 pause menu already behaves. This is an
  accepted, intentional tradeoff (confirmed with the user), not a bug. It also matches how
  CS-style buy menus commonly behave when they take over the mouse for a cursor.
- Pointer lock release/reacquire, click routing, hover-follows-cursor, and the auto-drawn
  Back/Close button ([Menu.ts:442-456](../source/engine/client/Menu.ts#L442-L456),
  `M.#drawBackButton()`) all come for free — verified these are pure `Key.destination`-driven
  and require no new engine surface.
- `SV.server.paused` is untouched by opening a menu page (confirmed — only the `pause` console
  command touches it, [Host.ts:1529-1544](../source/engine/common/Host.ts#L1529-L1544)), so
  other players, monsters, and the round timer keep running normally while one player shops.
  This must stay true — no change should route buy-menu open/close through `Host.Pause_f`.

This keeps the entire change **mod-local to `source/game/hellwave/`** — no engine
(`source/engine/`) or id1 changes are needed. `Action`, `MenuPage`, `VerticalLayout`, and the
`Menu.Open/Push/Pop/IsOpen` surface are already exposed to game code via `engine.Menu`
([GameAPIs.ts:1249-1516](../source/engine/common/GameAPIs.ts#L1249-L1516)), the same bundle
`HellwaveHUD` already imports from today.

## Design

### 1. Rows: `Label` → `Action`

Replace the per-catalog-entry `Label` with `Action`
([MenuItem.ts:165-190](../source/engine/client/menu/MenuItem.ts#L165-L190)):
mutable `.label`/`.enabled`/`.visible` (same as today), `focusable: true` by default (unlike
`Label`, which hard-codes `false`), and a `.action` callback already wired through
`handleClick()`'s `handleInput(K.ENTER)` fallback. Each row's `action` issues the exact same
effect a keyboard purchase does today:

```ts
new Action({
  label: '',
  visible: false,
  action: () => { this.engine.AppendConsoleText(`impulse ${impulse}\n`); },
})
```

Purchase validation stays 100% server-authoritative in `_buyMenuPurchase()` — unchanged. Both
`VerticalLayout.draw()` and `.hitTest()` already skip `!item.visible` rows entirely (and don't
count their height), so the existing "hide unaffordable items" behavior
(`label.visible = item.cost <= currentMoney`, [HUD.ts:246](../source/game/hellwave/client/HUD.ts#L246))
carries over unchanged with zero new logic — confirmed at
[MenuPage.ts:348-394](../source/engine/client/menu/MenuPage.ts#L348-L394).

### 2. Register once, open/close reactively

Register the page once (e.g. during `HellwaveHUD`'s init, alongside where hellwave already
registers other client-side things) via `engine.Menu.RegisterPage('hellwave_buy', page)`, instead
of the current lazy-build-on-first-draw pattern.

Drive `Open`/close from the *existing* `client.clientdata.field-changed` subscriber
([HUD.ts:78-93](../source/game/hellwave/client/HUD.ts#L78-L93)) — this is an edge-triggered
event (fires on value change), which is the right place for open/close (a one-time transition),
as opposed to `HellwaveHUD.draw()` (a per-frame concern):

- `buyzone` transitions **to** `2` → `engine.Menu.Open('hellwave_buy')`. Also refresh every
  row's `.label`/`.enabled` at this point (equivalent to today's per-frame relabeling, but now
  only needs to happen on open + on money changes — see below).
- `buyzone` transitions **away from** `2` (round timer ran out, player forced out of the zone,
  etc.) while `engine.Menu.IsOpen('hellwave_buy')` is true → `engine.Menu.Pop()`. This covers
  the *involuntary* close case (server-driven), not just the player explicitly backing out.
- `money` changes while the menu is open → refresh row `.label`/`.enabled` again (same helper as
  the open case), so prices/affordability update live instead of only at open time.

`#drawBuyMenu()` shrinks to just the "Buyzone!" prompt (`buyzone === 1`, unchanged,
[HUD.ts:233-235](../source/game/hellwave/client/HUD.ts#L233-L235)) — the manual `page.draw()`
call is deleted. Once opened via `Menu.Open()`, `M.Draw()`
([Menu.ts:442-456](../source/engine/client/Menu.ts#L442-L456)) draws the current page
automatically every frame (plus `Draw.FadeScreen()` and the Back button), independent of the
HUD's own draw pass, which keeps running behind it unmodified — so `#drawAccountBalance()`,
`#drawRoundStats()`, and the existing blur/desaturate `buymenuPostProcessStack`
([HUD.ts:49-52](../source/game/hellwave/client/HUD.ts#L49-L52)) all keep working unchanged. Note
`M.Draw()` also calls `Draw.FadeScreen()`, which will now dim the background *in addition to*
the existing blur/desaturate post-process — worth a look during implementation to check the two
don't stack into an overly dark screen; trivial to drop one if so.

### 3. Preserve the `1`-`9` keyboard shortcuts (not `b` — see below)

While `Key.destination === menu`, printable keys (letters/digits, `Key.ts:130-133`'s
`buildConsoleKeySet()` range) do **not** auto-execute their gameplay binding
([Key.ts:582-583](../source/engine/client/Key.ts#L582-L583)) — they route to `M.Keydown()`
instead, for menu text-entry purposes. So without extra work, pressing `1`-`9` while the buy
page is open would do nothing (no default MenuPage behavior maps arbitrary digit keys to
specific rows).

Fixed with `MenuPage.customHandleInput`
([MenuPage.ts:16-17,150-166](../source/engine/client/menu/MenuPage.ts#L16-L17)), which is
designed for exactly this — intercept a key, fall back to default handling otherwise:

```ts
customHandleInput: (key, page, defaultHandleInput) => {
  if (key >= (49 as K) && key <= (57 as K)) { // '1'-'9'
    engine.AppendConsoleText(`impulse ${key - 48}\n`);
    return true;
  }
  return defaultHandleInput(key);
},
```

This keeps arrow-key navigation, Enter, mouse clicks, and Escape (see §4) all working via
`defaultHandleInput`, while restoring the purchase shortcut players already rely on. Sending an
`impulse` string rather than reading a raw keybind is deliberate: it decouples the shortcut from
the global bind table, so a later "extend the buy menu" pass can remap what a given digit means
per catalog page/category without touching `client.cfg`.

**`b` deliberately not wired as an in-menu close shortcut** (decided during review): since the
buy menu is a real menu page now, `b` while it's open falls through to `defaultHandleInput` like
any other unhandled key and does nothing — closing is Escape or the auto-drawn Back button only.
This was flagged as undecided rather than assumed; revisit if it turns out players expect `b` to
also close it, matching the open behavior.

### 4. Closing: `onEscape` must tell the server, not just pop locally

Escape reaching this page (`Key.ts:508-511` routes it to the current page when
`Key.destination === menu`, same code path as every other menu — no hellwave-specific wiring
needed there) should both close the client-side page **and** resync server state, since the
server's `buyzone` state machine is the source of truth and only moves via `impulse 21`:

```ts
onEscape: () => {
  engine.AppendConsoleText('impulse 21\n'); // server: buyzone 2 -> 1
  engine.Menu.Pop();                        // immediate visual close, don't wait on the round-trip
},
```

Popping immediately (rather than waiting for the server's `buyzone` sync to come back down and
trigger the reactive pop from §2) keeps Escape feeling responsive. The §2 reactive-pop handler
must guard with `engine.Menu.IsOpen('hellwave_buy')` before calling `Pop()` again so the
already-arrived-late `buyzone: 2 -> 1` transition doesn't try to pop an already-closed page.

## Non-goals (explicitly out of scope for this change)

- No visual redesign, no categories/tabs, no grid layout — stays a flat vertical list.
- No change to unaffordable-item visibility (stays fully hidden, not grayed-out) — flagged as a
  possible improvement but deliberately not bundled in here.
- No engine (`source/engine/`) or id1 (`source/game/id1/`) changes.
- Nothing here is scoped to the larger buy-menu redesign mentioned separately (categories,
  richer layout, etc.) — this only fixes mouse usability of the existing catalog list. That
  larger work should get its own plan once ready, and should be able to build on top of this
  (a real `MenuPage` on the stack) rather than fight it.

## Testing

Implemented in `source/game/hellwave/test/hellwave-client.test.mjs`, under a new `'buy menu as
a real menu page'` sub-describe, using a small local `createBuyMenuHud()` rig that wraps the
existing `createMockMenuAPI()` (real `Action`/`MenuPage`/`VerticalLayout` classes, real
push/pop/`IsOpen` stack — already used by the id1 menu tests) just enough to also capture the
registered page for direct inspection:

- Opens on `buyzone` becoming `2`; closes when the server drops it involuntarily (round timer,
  forced out of the zone) without a matching client-initiated close.
- Row labels/visibility refresh correctly from `buyMenuItems` + money, both on open (`onEnter`)
  and on subsequent `money` clientdata changes while already open.
- Activating a row (`Action.action()`) sends the matching `impulse N` console text.
- `customHandleInput` routes `1`-`9` to their impulse and returns `true`; an unhandled key falls
  through to `defaultHandleInput` and returns `false` without sending anything.
- `onEscape` sends `impulse 21` and closes immediately (`IsOpen` false) without waiting on the
  server round-trip.

One test-writing snag worth noting: an earlier draft asserted arrow-key navigation via
`page.handleInput(K.DOWNARROW)`, but `MenuPage._moveCursor` plays a nav sound through the real
`S`/registry singleton, which this lightweight mock doesn't set up — it's not something
`createMockMenuAPI()`'s "construction/activate never touch the registry" guarantee covers, since
that's a call made *during* input handling, not construction. Replaced with an unhandled key
(`K.F1`) to prove the fallback path without touching sound.

Manual/browser verification still recommended before calling this done (per this repo's usual
practice for UI changes): boot the dedicated dev server, join hellwave, walk into a buyzone,
press `b`, confirm the cursor appears and movement/look freezes, click a row to buy, confirm
money/HUD updates, click Back/press Escape to close, confirm movement resumes and the
server-side `buyzone` resynced to `1` (walking out of the zone should behave as before).

## Resolved during review (2026-07-19)

- Movement/looking freezing while the buy menu is open is intentional, not just an accepted
  side effect — the player is meant to focus on purchasing, not get distracted by moving/aiming.
- `b` is **not** wired as an in-menu close shortcut (see §3) — only `1`-`9` got
  `customHandleInput` treatment. Escape/Back close it.
- Routing `1`-`9` through `AppendConsoleText('impulse N\n')` instead of raw key bindings was
  explicitly called out as valuable independent of mouse support: it's no longer constrained to
  the global bind table, so a later pass can extend to more slots or remap what a given digit
  sends based on which buy-menu "page"/category is active client-side — without touching
  `client.cfg`. Nothing further was built toward that now; this is scope for later, kept in mind
  by routing through console text rather than hard-wiring digit-to-impulse 1:1 elsewhere.
- Scope stayed deliberately minimal per direction to "keep it simple, just get the current setup
  going" — no categories/tabs/grid layout, no visibility-model change (still fully hidden vs.
  grayed-out) — consistent with the Non-goals above.

## Still open (not addressed by this pass)

- Whether to keep `buymenuPostProcessStack`'s blur/desaturate now that `M.Draw()`'s
  `FadeScreen()` also dims the background while the page is open — not changed; a look-and-feel
  call best made by eye during manual verification, not a design blocker.
- **Hover still doesn't visually work** (2026-07-19, per real playtest): enabling
  `VerticalLayout`'s `showCursor` (removing the `showCursor: false` this page had) restored
  cursor-index tracking on mouse move (confirmed via unit test — `updateHover` correctly moves
  `page.cursor` between rows) and should draw the classic blinking-arrow indicator next to the
  focused row, but the user still doesn't see any hover feedback live. Not root-caused — could be
  the arrow's `cursorX`/row-height tuning putting it somewhere not visually obvious, a rendering
  issue specific to this page's layout, or something else in `VerticalLayout.draw()` not
  accounted for here. Explicitly deferred, not blocking: the underlying infrastructure (real
  `MenuPage` on the stack, dedicated buy-impulse range, `pausesGame` flag, event-driven feedback)
  is considered solid and ready to build the larger planned buy-menu redesign on top of
  (categories/tabs, richer layout — see the Non-goals section above). Revisit the visual polish,
  including hover, as part of that larger pass rather than continuing to chase it in isolation.
  **Resolved later:** [hellwave-main-menu-rework.md](hellwave-main-menu-rework.md) (Phase 1)
  root-caused the identical symptom on the main menu: `VerticalLayout`'s cursor glyph codes
  (12/13) draw whatever a font's low-range cells contain, which need not look like a cursor. The
  fix, drawing a plain printable `>` next to the focused row from `customDraw`, is in place in
  `BuyMenu.ts`. Checked in code on 2026-09-21; not re-verified in a live session.

## Bug found during first real playtest (2026-07-19): pointer-lock/Escape race

First manual test found three symptoms: mouse clicks didn't register on rows, keyboard shortcuts
did nothing, and Escape brought up the main pause menu instead of returning to the game. All
three traced back to a single **engine-level** race, not something specific to hellwave:

- `MenuStack.push()` calls `IN.ReleasePointerLock()` whenever any menu page opens (including the
  buy menu), so a real cursor is usable instead of the FPS mouselook delta.
- `document.exitPointerLock()` is asynchronous — the resulting `pointerlockchange` event fires
  *after* `Key.destination` has already moved on to `menu`.
- `IN.onpointerlockchange()` ([IN.ts:343-350](../source/engine/client/IN.ts#L343-L350), pre-fix)
  unconditionally synthesizes a fake Escape keypress whenever pointer lock is lost, to compensate
  for browsers that swallow the *physical* Escape keydown as part of their native
  pointer-lock-exit gesture. But when *we* are the ones who requested the unlock (opening a
  menu, not the user pressing Escape), that synthetic Escape has nothing to compensate for — it
  just immediately closes whatever menu was just opened, since `Key.destination` is already
  pointed at it by the time the async event fires.
- This self-close cascade also flips `buyzone` back down to `1` server-side (the synthetic
  Escape reaches the buy page's real `onEscape`, which sends `impulse 21`) and reverts
  `Key.destination` to `game` — so by the time the player notices anything and tries clicking,
  pressing digits, or pressing Escape themselves, the menu is already gone and a stray Escape
  press opens the *main* menu instead. All three symptoms, one cause.

This could not be reproduced with Playwright in this environment — headless Chromium never
actually grants real Pointer Lock (`document.pointerLockElement` stays `null` even after a
synthetic click), so the race never had a lock to lose in the first place. Root-caused by reading
the async pointer-lock/Escape interaction directly, then confirmed with a real fix.

**Fix** ([IN.ts](../source/engine/client/IN.ts)): a new `IN.#voluntaryUnlock` flag, set right
before `ReleasePointerLock()`'s own `document.exitPointerLock()` call and consumed (checked once,
then cleared) by `onpointerlockchange()` — voluntary unlocks no longer synthesize a compensating
Escape; unrelated losses of lock (physical Escape eaten by the browser, tab switch) still do.
This is a genuine, general engine fix, not hellwave-specific — it very likely also affected the
id1 pause menu whenever it was opened while pointer lock was actually engaged (a case earlier
manual/Playwright verification passes may not have consistently exercised). Covered by three new
regression tests in `test/client/in.test.mjs`, confirmed to fail without the fix and pass with it.

A second, separate observation surfaced while chasing this in a scripted headless session:
consecutive rapid `impulse` console commands can overwrite each other in `ClientInput.impulse`
before a frame flushes the first one to the server. This is pre-existing behavior of the shared
single-slot impulse mechanism (not introduced here) and is only reachable at all under the
severe main-loop throttling headless/backgrounded tabs get from the browser — not a realistic
concern at normal interactive frame rates, so left alone.

## Second playtest bug (2026-07-19): open never told the server, and the deeper fix

Opening the menu (`bind b "impulse 21"`, the classic raw keybind, unchanged since before this
whole rework) worked or didn't depending on exactly the same kind of client/server disagreement
as the pointer-lock bug above — the server's `buyzone` state machine (`-1/0/1/2`, "2" meaning
"menu is open") and the client's own `Menu.Open()`/`Menu.Pop()` calls were two independent
sources of truth for the same fact, kept in sync only by careful discipline (send `impulse 21` on
every open *and* every close). Missing one desynced them.

**Redesigned rather than patched**, per discussion: the server has no business knowing whether a
UI element is open on someone's screen. It only needs to answer one question, fresh, every time a
purchase impulse lands: *is this player physically standing in a buyzone right now*. Changes:

- `buyzone` narrows to `-1 | 0 | 1` ([Player.ts](../source/game/hellwave/entity/Player.ts)) —
  purely "eligible and physically in a zone", no menu-UI concept left in it at all.
  `_buyMenuRequested()` (the old toggle handler) is deleted.
- Purchases move to their own impulse range, disjoint from id1's 1-9 weapon-select range:
  `toBuyImpulse`/`fromBuyImpulse` in [Defs.ts](../source/game/hellwave/Defs.ts) map catalog item
  1-9 to wire impulses 111-119. `_buyMenuPurchase()` now independently checks `this.buyzone === 1`
  itself (the server's own live value, recomputed every tick in `playerPostThink`, not a
  synced-and-therefore-laggier copy) — so a purchase is validated fresh every time, never against
  stale "was in the zone when the menu opened" state.
- Opening/closing become **purely client-side, zero round-trip**. `b` is rebound
  (`data/hellwave/client.cfg`) from `impulse 21` to a new `hw_buymenu` client command, registered
  via the existing `RegisterCommand` surface, that calls `Menu.Open()` locally whenever the
  last-synced `buyzone === 1` and the page isn't already open. Escape/Back just call `Menu.Pop()`
  — nothing is sent to the server either way anymore. Opening the menu is now instant instead of
  waiting on a sync round-trip.
- The one thing that stays reactive is *involuntary* close: if `buyzone` drops away from `1`
  while the menu happens to be open (round moved on, forced out of the zone), the client still
  closes it — same mechanism as before, just keyed off leaving `1` instead of leaving `2`.
- The buy-menu blur/desaturate post-process, previously driven off the `buyzone === 2` clientdata
  value, now hooks the buy `MenuPage`'s own `onEnter`/`onExit` — it's a property of "is this page
  currently showing", which is exactly what those callbacks mean, regardless of what drove it.

Net effect: the class of bug where client and server disagree about "is the menu open" is gone
by construction — there's no longer a second copy of that fact to disagree about.
