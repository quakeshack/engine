# Browser Verification Technique

Testing a UI/frontend change end-to-end requires a real browser driving the live WebGL
client. No `chromium-cli` and no `playwright`/`puppeteer` project dependency exist in this
repo — this doc is the recipe for doing it anyway in a sandboxed dev environment, without
adding either as a permanent dependency.

## 1. Find a cached Chromium + Playwright

A real Chromium build is frequently already cached from a previous `npx playwright` install,
even with no project dependency:

```bash
ls ~/.cache/ms-playwright/ 2>/dev/null            # look for chromium-*
find ~/.npm/_npx -maxdepth 3 -iname playwright 2>/dev/null
```

If both exist, symlink the npx-cached package into a scratch `node_modules/` — Node's ESM
resolver ignores `NODE_PATH`, so a plain `import` only works via a real `node_modules/`
entry:

```bash
mkdir -p node_modules
ln -sfn ~/.npm/_npx/<hash>/node_modules/playwright node_modules/playwright
ln -sfn ~/.npm/_npx/<hash>/node_modules/playwright-core node_modules/playwright-core
```

Then a normal script works for both ESM and CJS:

```js
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
```

Without the GL args the canvas renders blank — `swiftshader` gives software WebGL that
actually rasterizes, so screenshots show real content.

If neither Chromium nor Playwright is cached, this technique doesn't apply in that
environment; say so explicitly rather than skipping verification silently.

## 2. Boot a scratch server without touching an already-running one

Check for an already-running dev server first — this repo's workflow often already has a
dedicated server and/or `vite build --watch` running from a previous session:

```bash
ps aux | grep -E 'dedicated|vite'
ss -ltnp
```

**Don't kill an existing process.** Instead build fresh output and launch a second instance
on a spare port:

```bash
npm run dedicated:build                          # one-shot, doesn't disturb a running node process
npm run build:production                         # fresh dist/browser/
node ./dist/dedicated/dedicated.mjs -game <mod> -port 3001 +exec server.cfg   # e.g. -game hellwave
```

A plain `+exec server.cfg` with no `-game` flag defaults to `id1` (`Def.ts`'s
`defaultGame`/`defaultBasedir`), not whichever mod you're testing — pass `-game <mod>`
explicitly. A mod that sits on another base game needs `-basedir` as well (`-basedir librequake -game hellwave`
for the Hellwave maps; with the default base `id1` the server cannot find the assets and the client fails with
`Couldn't load progs/...`), and the browser build has to be made with the matching
`VITE_GAME_DIR`/`VITE_BASE_DIR` (section 8). The dedicated server serves both the game socket and the static browser client
(`/qfs/*` via `Sys.ts`'s Express route) on that one port, so one process is enough.

The dedicated build writes its worker bundles to `dist/dedicated/workers/` whatever `--outDir` says, so a
scratch build with another `--outDir` still overwrites those (same sources, harmless), and its own server then
cannot find its navigation worker. For a client-only check you do not need a new server at all: the watch
build's `dist/browser/` is served by the dedicated server that is already running, and a server that runs in
the browser's own worker (the default, `?serverthread` opts out, see [server-worker.md](server-worker.md)) needs nothing from it.

If a `vite build --watch` process was already running, don't assume it picked up your
latest edit — check before trusting it:

```bash
find <source dir> -newer dist/browser/index.html
```

## 3. Point the client at the right mod

`?game=<mod>` in the URL maps to `-game <mod>` in the boot argv (`Sys.ts`'s query-string
parser, `decodedKey === 'game'` special case): e.g. `http://localhost:3001/?game=hellwave`.

## 4. Convert virtual menu-space coordinates to real click coordinates

Menu draw calls (`Menu.Print`, `#toScreenPosition`, etc.) live in a virtual 320×200 space,
transformed to real screen pixels via:

```
screenX = 2 * virtualX + VID.width  / 2 - 320
screenY = 2 * virtualY + VID.height / 2 - 200
```

With a Playwright viewport of 960×600 (`VID.width = 960`), that simplifies to
`screenX = 2*virtualX + 160`, `screenY = 2*virtualY + 100`. Use a page's known virtual-space
layout constants (row Y positions, button X/Y) to compute click coordinates instead of
guessing from a screenshot.

## 5. Reach a gated menu/HUD page without its full physical trigger

The page's composition root (`bootstrap/createBrowserClient.ts`) exposes `window.engine` in the browser (`CL`, `COM`, `Con`,
`ConsoleOverlay`, `Host`, `M`, `Key`, etc.; `SV` is `null` unless the page runs with `?serverthread`, by default the server is in a worker and `CL.cls.serverController.state` is what the page knows of it). From a Playwright `page.evaluate()`:

```js
const { M, Key } = window.engine;
Key.destination = 3; // KeyDestination.menu — required, or the page becomes "active"
                      // (onEnter fires) but M.Draw() never renders it, since only
                      // ClientEngineAPI.Menu.Open() sets this before push()
M.menuStack.push('hellwave_buy'); // or M.menuStack.isShowing('hellwave_buy') to check
```

This opens/verifies any registered page's rendering, hover, click, and keyboard handling
live, and still exercises the real server round-trip for anything the page's actions send
(e.g. a buy-menu row click sends a real `impulse N` to the same-process listen-server game,
which validates it server-side) — without needing to physically navigate to the trigger.

`Cmd`/`Cvar` are not on `window.engine`, so `window.engine.Cmd.ExecuteString(...)` throws.
Drive console commands through real keyboard input instead — `` ` ``/`~` opens the
drop-down console by default:

```js
await page.keyboard.press('Backquote');
await page.keyboard.type('map dm6rmx', { delay: 15 });
await page.keyboard.press('Enter');
await page.keyboard.press('Backquote');
```

This round-trips through the real `Key`/`Con`/`Cbuf`/`Cmd` pipeline, so it works for map
loads and any cvar/console command (e.g. toggling `r_shadows`/`r_bloom`/`gl_msaa` live).
Two traps when scripting this: the console closes itself after commands like `map`/`load`, so a
fixed "press Backquote, type, press Enter, press Backquote" sequence drifts out of sync (the second
Backquote then opens it again and the next command's first Backquote closes it, so the text lands in
the game); check whether the drawer is open before and after each command instead (read `window.engine.ConsoleOverlay.isOpen`, or take a screenshot, or look at whether `window.engine.Con.text` grew). And the first
character typed right after the console opens can be swallowed, so wait about 700 ms after the
opening Backquote. To start a single-player game without typing `map`, press Enter twice on the main
menu (Single Player, New Game). `window.engine.Con.text` holds the console lines, which is how to
read the output of a command such as `status`.

Screenshots plus zero console errors/warnings across a `page.on('console', ...)` capture is
a strong signal a rendering-pipeline change (texture binding, FBO attachment points, etc.)
didn't break anything a mocked-`gl` unit test wouldn't catch.

## 6. Known limitations

- Headless Chromium here never grants real Pointer Lock —
  `document.pointerLockElement` stays `null` even after a synthetic `page.mouse.click()`.
  Mouse-look/turning doesn't work; use the classic arrow-key `+left`/`+right` turn
  bindings instead when exploring movement.
- **This is a false-confidence trap, not just a missing feature.** Any bug tied to the
  pointer-lock/mousemove/hover pipeline (mouselook capture, cursor-follows-mouse,
  click-to-relock races, hover-highlight rendering) cannot be reproduced *or ruled out*
  with this harness — it will look like it "works" in an automated pass purely because the
  relevant code path never actually engages. Confirmed bitten twice: a pointer-lock/Escape
  race that only manifests with a genuinely engaged lock (root-caused by reading the async
  event interaction directly, confirmed via a unit test instead), and a hover-highlight fix
  that unit-tested correctly but didn't render live per user report, uncheckable further in
  this sandbox. For this whole class of bug, say explicitly that Playwright verification
  isn't possible here rather than reporting confidence from a passing automated pass — a
  live user test is the only real confirmation.
- Clicking the game canvas *during* active gameplay (not on a menu) can trigger a
  pointer-lock-related error path that cascades into a full `Sys.Quit()`/engine shutdown.
  Only click the canvas during menu screens, where clicks are expected.

## 7. Verifying master-server-backed realtime features without a real WebRTC peer

For session discovery (`/browser` WebSocket) or similar realtime push features, check for
an already-running `wrangler dev` (master-server repo, defaults to `localhost:8787`)
alongside the engine's dedicated server. Rather than driving two full clients through
WebRTC/ICE (slow, flaky in a sandbox), write a small synthetic Node script that connects
directly to `ws://localhost:8787/signaling` and sends:

```js
{ type: 'create-session', isPublic: true, serverInfo: { mod, map, hostname, currentPlayers, maxPlayers, settings } }
```

The master server registers a real public session from that alone — no peer connection
needed. `curl -s http://localhost:8787/list-servers` confirms registration. `serverInfo.mod`
must match the browser client's active `COM.game` (`id1` vs `hellwave`) or the client's own
mod-filtering will correctly hide it. Send `{ type: 'leave-session' }` (or let the process
die) to simulate the host leaving. With a Playwright page already sitting on the
session-list menu, toggling this synthetic host on/off and asserting the list updates with
no navigation/click in between is a fast, real end-to-end proof of a realtime push feature.

## 8. Comparing two builds (before/after screenshots)

A refactor that must not change a pixel (shader chunks are the example) is proven by rendering the same scene with
the build from `HEAD` and the build from the working tree.

- **Do not build into `dist/`.** A `vite build --watch` is usually running and rewrites it, so a scratch build there
  is clobbered half way through a capture. Build each side into its own folder:
  `VITE_GAME_DIR=<game> VITE_BASE_DIR=<base> npx vite build --mode production --outDir <scratch>/dist-after --emptyOutDir`,
  and for `HEAD` do the same from a copy of the tree with the changed files restored from `git show HEAD:<path>`.
- **Set `VITE_GAME_DIR` and `VITE_BASE_DIR` yourself.** The shell that runs the watch build may export them (it
  baked `hellwave`/`librequake` into the page and the dedicated server it started), and a build without them defaults
  to `id1`. A page built for one game against a server that serves the other reports `Could not spawn server`.
- **Serve each folder with a throwaway static server** that proxies `/qfs/*` to the running dedicated server, one
  port per side, and leave that server alone.
- **Freeze the scene:** `map <name>`, `god`, `impulse 9`, `pause`, then put dlights into
  `CL.state.clientEntities.dlights` (`radius`, `origin`, `color`, `die` far in the future) relative to the player's
  origin. `chase_active 1` (with `chase_back`, `chase_up`) shows the player model.
- **Expect noise and measure it.** The sky, turbulent (water, lava) surfaces and the HUD clock animate even while
  paused, and the idle pose of a model is whichever frame the pause hit. Capture the baseline twice, build a mask from
  where those captures differ (dilated by a few pixels), and compare before/after outside it. Report the masked
  pixel count next to the result. A model whose pose varies cannot be compared pixel by pixel across builds.
- Two captures of the same build 1.5 s apart differ only in the noise; if they differ elsewhere, the scene is not
  frozen yet.

### The capture scripts

`scripts/renderer-capture/` automates the recipe above for renderer work:

```bash
# one production build per side, never into dist/
npx vite build --mode production --outDir <scratch>/dist-before --emptyOutDir
# ... change or check out the other side, then
npx vite build --mode production --outDir <scratch>/dist-after --emptyOutDir

# capture each build at least twice (a dedicated server must be running, see section 2)
node scripts/renderer-capture/capture.mjs <scratch>/dist-before <scratch>/before-a 3101
node scripts/renderer-capture/capture.mjs <scratch>/dist-before <scratch>/before-b 3102
node scripts/renderer-capture/capture.mjs <scratch>/dist-after  <scratch>/after-a  3103
node scripts/renderer-capture/capture.mjs <scratch>/dist-after  <scratch>/after-b  3104

node scripts/renderer-capture/compare.mjs \
  --before <scratch>/before-a,<scratch>/before-b --after <scratch>/after-a,<scratch>/after-b
```

- `capture.mjs` loads `e1m1`, pauses, pins the client clock and seeds the particle generator, and writes nine
  views: the spawn view, two dynamic lights with particles and a decal, the player model in chase view, bloom, fog,
  a camera under the largest sky face, above the largest liquid surface and inside it, and the spawn view again.
  It records the `r_speeds` lines of each view in `views.json`. A capture takes about 80 seconds; the page runs on
  software GL at 3 to 5 FPS, so it says nothing about frame time.
- `compare.mjs` needs at least two captures on one side. It measures how far two captures of one build are apart
  and flags a view only when even the closest before/after pair is further apart than that. A view that is
  flagged by a small margin is worth a third capture before it is worth a look. A broken sky or particle pass is
  flagged by a wide margin (tested by disabling both).
- **`r_speeds` is not a rendering check.** It counts brush and alias draws, not sky, particles, decals, coronas or
  post-processing. A build with sky and particles disabled has identical counts. The pixel comparison is what
  sees those.
- The scripts reach into the engine through `window.engine` (see section 5). `installAdapter()` at the top of
  `capture.mjs` names every member it uses and looks for its new home first, so a change that moves a member
  teaches that function and exposes the new home in `bootstrap/createBrowserClient.ts`, and the same script keeps
  working on the build before and the build after.
- What they do not cover: input and pointer lock (section 6), anything that needs another map, and a second
  renderer state such as a changed resolution. Underwater fog is only covered with `CAPTURE_WATERFOG=1` in the
  environment of `capture.mjs`: `e1m1` has no `_qs_waterfog` volume, so the key is set on the worldspawn before the
  liquid views and the "inside the lava" view then shows the underwater fog effect.

## Reporting results

State plainly whether verification actually happened. If Chromium/Playwright aren't
available in the current environment, or the sandbox has no display/GL path that works,
say so explicitly rather than claiming the UI was verified when only unit tests ran.
