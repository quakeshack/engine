---
name: browser-ui-verification
description: Use before reporting any client/UI/frontend change as done — rendering, menu system, HUD, input handling, or anything touching source/engine/client or a game's client-side code. Verifying "in a real browser" here isn't obvious to do: there's no chromium-cli and no playwright/puppeteer project dependency, so it needs a specific local workaround. Treat this as the trigger to actually run that workaround before claiming a UI change works, instead of stopping at unit tests or a visual read of the diff.
---

# Browser UI verification

This repo has no `chromium-cli` and no `playwright`/`puppeteer` project dependency, but a
real, working recipe for live-browser verification exists and is documented in
`docs/browser-verification.md`. Read that file for the full recipe — this skill is the
trigger to actually use it instead of settling for "the unit tests pass" on a UI change.

## Fast path

1. Check whether the ingredients are available in this environment:
   ```bash
   ls ~/.cache/ms-playwright/ 2>/dev/null
   find ~/.npm/_npx -maxdepth 3 -iname playwright 2>/dev/null
   ```
2. **If both exist:** follow `docs/browser-verification.md` end to end — symlink the
   cached package into a scratch `node_modules/`, build fresh output, boot a scratch
   dedicated server on a spare port (never kill an already-running one), launch Chromium
   with the software-GL args, and drive the actual page (clicks via the virtual-space
   coordinate formula, console commands via real keyboard input, gated menu pages via
   `window.registry`).
3. **If neither is available:** this is an environment gap, not a license to silently
   skip verification. Say so explicitly in your final report — "UI change not verified in
   a live browser: Chromium/Playwright unavailable in this sandbox" — rather than implying
   the change was checked when only unit tests or a code read actually happened.

## What this skill does NOT do

- Does not add `playwright`/`puppeteer` to `package.json`. This stays a local dev/agent
  workaround using whatever happens to be npx-cached, not a project dependency.
- Does not replace unit tests — it's the end-to-end complement to them, for exactly the
  class of bug a mocked-`gl` or DOM-less test can't catch (texture binding order, FBO
  attachment points, real click/keyboard round-trips through the actual input pipeline).
- Does not prove anything about the pointer-lock/mousemove/hover pipeline — headless
  Chromium here never grants real Pointer Lock (see `docs/browser-verification.md` §6), so
  a passing automated pass on that class of bug is a false-confidence trap, not evidence.
  Say explicitly that this class needs a live user test instead of reporting confidence
  from Playwright alone.
