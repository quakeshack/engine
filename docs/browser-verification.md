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
explicitly. The dedicated server serves both the game socket and the static browser client
(`/qfs/*` via `Sys.ts`'s Express route) on that one port, so one process is enough.

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

`Sys.ts`'s `Init()` exposes `window.registry` in the browser (`CL`, `COM`, `Con`, `Host`,
`M`, `Key`, `SV`, etc.). From a Playwright `page.evaluate()`:

```js
const { M, Key } = window.registry;
Key.destination = 3; // KeyDestination.menu — required, or the page becomes "active"
                      // (onEnter fires) but M.Draw() never renders it, since only
                      // ClientEngineAPI.Menu.Open() sets this before push()
M.menuStack.push('hellwave_buy'); // or M.menuStack.isShowing('hellwave_buy') to check
```

This opens/verifies any registered page's rendering, hover, click, and keyboard handling
live, and still exercises the real server round-trip for anything the page's actions send
(e.g. a buy-menu row click sends a real `impulse N` to the same-process listen-server game,
which validates it server-side) — without needing to physically navigate to the trigger.

`Cmd`/`Cvar` are deliberately excluded from `window.registry` (see the registry pattern in
`code-style-guide.instructions.md`), so `window.registry.Cmd.ExecuteString(...)` throws.
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

## Reporting results

State plainly whether verification actually happened. If Chromium/Playwright aren't
available in the current environment, or the sandbox has no display/GL path that works,
say so explicitly rather than claiming the UI was verified when only unit tests ran.
