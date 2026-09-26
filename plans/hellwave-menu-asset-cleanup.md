# Let hellwave opt out of id1's classic menu front end

**Status:** Done, as proposed (checked 2026-09-21). `Id1Menu.Init(engineAPI, options)` takes
`classicFrontend` (default `true`), id1's `ClientGameAPI._getMenuInitOptions()` supplies it, and
hellwave overrides that with `{ classicFrontend: false }`. With the flag off, id1 builds only
`options`, `keys`, `quit` and `alert` and loads none of the classic-only pics or sounds; `help`
stayed in the classic group, as the plan proposed. Tests:
`source/game/id1/test/client/menu.test.mjs` (the `classicFrontend: false` block) and
`source/game/hellwave/test/client/client-api.test.mjs` (asserts hellwave's exact registered-page
set). The `hellwave-client.test.mjs` this plan names was later split up
([hellwave-menu-decomposition.md](hellwave-menu-decomposition.md)); file and line links below are
as of writing.

## Problem

`Id1ClientGameAPI.Init` ([ClientAPI.ts:313-316](source/game/id1/client/ClientAPI.ts#L313-L316)) unconditionally calls
`Id1Menu.Init(engineAPI)`, which builds **every** classic Quake menu page and loads **every** pic/sound it needs,
regardless of caller. `HellwaveClientGameAPI.Init` ([ClientAPI.ts:136-139](source/game/hellwave/client/ClientAPI.ts#L136-L139))
calls `super.Init()` (running all of that) and then layers `HellwaveMenu.Init(engineAPI)` on top, which registers its
own `'main'` page (overwriting id1's) and its own profile/map-picker pages.

Net effect: for every hellwave client, `Id1Menu.Init` still builds and the engine still loads assets for pages
hellwave never navigates to:

| Page (id1) | Pics it loads | Reachable from hellwave? |
|---|---|---|
| `main` | `qplaque`, `ttl_main`, `mainmenu` | No — immediately overwritten by `HellwaveMenu`'s own `'main'` |
| `singleplayer` | `qplaque`, `ttl_sgl`, `sp_menu` | No |
| `load` / `save` | `p_load`, `p_save` | No — hellwave has no save-game UI |
| `multiplayer` | `qplaque`, `p_multi`, `bigbox`, `menuplyr` | No — replaced by `hellwave_profile` |
| `launch_server` | — | No — only reachable from `multiplayer` |
| `help` | `help0`..`help5` (6 pics) | No — hellwave sidebar has no Help entry |

Plus `misc/menu2.wav` (`sfxMenu2`), only used by the load/save and help pages above.

Pages hellwave **does** reach through id1: `options` (pushed from its sidebar), `keys` (pushed from `options`),
`quit` (pushed from its sidebar, and via `host.quit-requested`), `alert` (via the generic `host.alert` event). Those
need `qplaque`, `p_option`, `ttl_cstm` — nothing else.

None of this crashes today (`LoadPicFromLump` degrades to a placeholder texture + a logged error on a missing lump,
and the dead pages just sit unreachable in the menu registry), but it means every hellwave client requests id1 gfx
lumps hellwave's asset pack has no reason to ship, and carries ~600 lines worth of dead `MenuPage`/`Action` objects
in memory. Worth cleaning up now while the menu rework is fresh.

## Approach

Mirror the extension pattern this file already uses for the HUD: `ClientGameAPI._getHUDClass()`
([ClientAPI.ts:309-311](source/game/id1/client/ClientAPI.ts#L309-L311)) is a `protected static` hook, overridden by
`HellwaveClientGameAPI`, that `Init` dispatches through instead of hardcoding `Q1HUD`. Add the same shape for the
menu:

1. **`Id1Menu.Init` takes an options object** with one flag, `classicFrontend` (default `true` — id1 itself is
   unaffected). When `false`, skip building `main`/`singleplayer`/`load`/`save`/`multiplayer`/`launch_server`/`help`
   and skip loading the pics/sound only those pages use. Always build `options`/`keys`/`quit`/`alert` — every mod
   needs those regardless of front end.
2. **Add `ClientGameAPI._getMenuInitOptions()`** (protected static, id1 base) returning `{}` by default, dispatched
   through from `Init` (`Id1Menu.Init(engineAPI, this._getMenuInitOptions())`).
3. **hellwave overrides `_getMenuInitOptions()`** to return `{ classicFrontend: false }`.

This is a boolean toggle rather than a per-page allowlist deliberately — hellwave is the only mod extending id1
today (`ls source/game/` — just `hellwave`, `id1`), and the two groups (id1's classic single-player front end vs.
the generic utility pages) are the only split anyone actually needs right now. A per-page config is easy to add
later if a second mod needs a different cut; no reason to build it speculatively.

## Changes

### `source/game/id1/client/Menu.ts`

- Split the `MenuPics` interface: `qplaque`, `p_option`, `ttl_cstm` stay required; the rest
  (`ttl_main`, `mainmenu`, `ttl_sgl`, `sp_menu`, `p_load`, `p_save`, `p_multi`, `bigbox`, `menuplyr`, `help_pages`)
  become optional. They're only ever populated/read together, gated by the same `classicFrontend` flag, so classic
  page builders read them with a plain `!` (no `console.assert` needed — the pairing is a compile-time-adjacent
  invariant enforced by `Init`'s own control flow, not a runtime one to defend against).
- Add:
  ```ts
  export interface Id1MenuOptions {
    /**
     * Whether to build id1's classic single-player front end (main/singleplayer/load/save/
     * multiplayer/launch_server/help pages, and the pics/sound only they use). Total-conversion
     * mods that replace the main menu (e.g. hellwave) should pass `false` -- they still get the
     * shared options/keys/quit/alert pages, which every mod needs.
     */
    readonly classicFrontend?: boolean;
  }
  ```
- `static Init(engineAPI: ClientEngineAPI, options: Id1MenuOptions = {}): void`:
  - Destructure `const { classicFrontend = true } = options;`.
  - Load `qplaque`/`p_option`/`ttl_cstm` unconditionally; load the rest of `pics` only `if (classicFrontend)`.
  - Load `sfxMenu2` only `if (classicFrontend)`.
  - Call `#buildMainPage`/`#buildSinglePlayerPage`/`#buildLoadSavePages`/`#buildMultiplayerPage`/
    `#buildLaunchServerPage`/`#buildHelpPage` only `if (classicFrontend)`.
  - Always call `#buildOptionsPage`/`#buildKeysPage`/`#buildQuitPage`/`#buildAlertPage`.
  - Call `Menu.SetRootPage('main')` only `if (classicFrontend)` (there's nothing to root to otherwise — hellwave
    sets its own root via `HellwaveMenu.Init`'s `Menu.RegisterPage('main', mainPage)`, which
    [resolves lazily by name](source/engine/common/GameAPIs.ts#L1274-L1281), so ordering between the two `Init`
    calls doesn't matter either way).
  - Keep the `host.alert`/`host.quit-requested` subscriptions unconditional (both target pages are always built).

### `source/game/id1/client/ClientAPI.ts`

- Add, next to `_getHUDClass`:
  ```ts
  /**
   * Options passed to `Id1Menu.Init`. Mods that replace id1's classic single-player front end
   * (e.g. Hellwave's `HellwaveMenu`) override this to skip building the pages/assets they never
   * navigate to.
   * @returns The menu init options for this mod.
   */
  protected static _getMenuInitOptions(): Id1MenuOptions {
    return {};
  }
  ```
- Change `Init` to `Id1Menu.Init(engineAPI, this._getMenuInitOptions());`.
- Import `Id1MenuOptions` as a type from `./Menu.ts`.

### `source/game/hellwave/client/ClientAPI.ts`

- Add:
  ```ts
  protected static override _getMenuInitOptions(): Id1MenuOptions {
    return { classicFrontend: false };
  }
  ```
- Import `Id1MenuOptions` as a type from `../../id1/client/Menu.ts`.

## Tests

### `source/game/id1/test/client/menu.test.mjs`

- Existing tests call `Id1Menu.Init(engine)` with no options — unaffected, still exercise the full classic set.
- Add a new `describe('Id1Menu.Init with classicFrontend: false', ...)` block:
  - Registers only `['alert', 'keys', 'options', 'quit']` (sorted) — not `main`/`singleplayer`/`load`/`save`/
    `multiplayer`/`launch_server`/`help`.
  - `options` and `keys` pages still work (still have their items, titlePic set).
  - `host.alert` / `host.quit-requested` still open their pages.
  - Doesn't call `Menu.SetRootPage` (spy on the mock, assert not called — or assert root stays whatever it was
    before `Init`).

### `source/game/hellwave/test/hellwave-client.test.mjs`

- Update the existing test at [hellwave-client.test.mjs:616](source/game/hellwave/test/hellwave-client.test.mjs#L616)
  ("registers the hellwave main menu page alongside the inherited id1 pages") to also assert the classic-only pages
  are **absent** — e.g. `assert.equal(engine.Menu.IsOpen('singleplayer'), false)` is meaningless (nothing to open),
  so instead capture registered pages the way `menu.test.mjs` does (`captureRegisteredPages`, moved to a shared
  fixture or duplicated locally per this repo's existing test-fixture conventions) and assert the registered-page
  set is exactly `['alert', 'hellwave_newgame', 'hellwave_newgame_settings', 'hellwave_profile', 'keys', 'main',
  'options', 'quit']`.

## Verification

- `npx eslint --fix source/game/id1/client/Menu.ts source/game/id1/client/ClientAPI.ts source/game/hellwave/client/ClientAPI.ts`
- `npm run test:game`
- Manually: `npm run dedicated:dev` isn't relevant here (client-only); instead run the browser client against
  hellwave (`npm run build:production` or existing dev flow) and confirm the main menu, Options → Customize
  controls, and Quit still work, and check the browser console/network tab for `gfx/sp_menu.lmp` etc. requests to
  confirm they're gone.

## Open questions for you

1. Confirm the two-group split (classic front end vs. shared utility pages) matches your mental model — in
   particular, should `help` move into the "always built" group instead (in case hellwave adds a Help entry later),
   or is skipping it correct for now?
2. Any other id1 menu assets/pages you know are dead weight for hellwave that I didn't catch by reading the code
   (e.g. something only reachable via a console command rather than menu navigation)?
