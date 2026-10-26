---
name: browser-ui-verification
description: Use before reporting any client/UI change as done (rendering, menus, HUD, input; anything under source/engine/client or a game's client code); unit tests alone do not count. Runs in a Sonnet subagent, so pass as args what changed, how to reach it (mod, map, menu, console command) and what should be seen; relay its verdict.
context: fork
agent: browser-verifier
---

# Browser UI verification

Verify this change in a live browser:

$ARGUMENTS

## Fast path

1. Check whether the ingredients are available:
   ```bash
   ls ~/.cache/ms-playwright/ 2>/dev/null
   find ~/.npm/_npx -maxdepth 3 -iname playwright 2>/dev/null
   ```
2. **If both exist:** follow `docs/browser-verification.md` end to end: symlink the cached package into a scratch
   `node_modules/`, build fresh output, boot a scratch dedicated server on a spare port (never kill an already-running
   one), launch Chromium with the software-GL args, and drive the actual page (clicks via the virtual-space coordinate
   formula, console commands via real keyboard input, gated menu pages via `window.engine`).
3. **For a change that must not alter what is drawn** (a renderer refactor, a shader move), use
   `scripts/renderer-capture/` instead of a one-off: `capture.mjs` renders nine fixed views of a build, `compare.mjs`
   compares two builds against the noise between captures of one build (`docs/browser-verification.md` §8).
4. **If neither is available:** report "not verified in a live browser: Chromium/Playwright unavailable". Never imply
   the change was checked when only unit tests or a code read happened.

## Limits

- Do not add `playwright`/`puppeteer` to `package.json`; this uses whatever is npx-cached.
- This complements unit tests for the bugs a mocked `gl` or DOM-less test cannot catch (texture binding order, FBO
  attachments, real click/keyboard round-trips).
- Headless Chromium never grants real Pointer Lock (`docs/browser-verification.md` §6): a pass on the
  pointer-lock/mousemove/hover pipeline is no evidence. Say that this class needs a live user test.
