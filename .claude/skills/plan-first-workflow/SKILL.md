---
name: plan-first-workflow
description: Use when starting a substantial change to this codebase — an architecture change, a cross-cutting refactor, a new subsystem, or anything that moves ownership between engine and game code or reshapes a public API. Not for bug fixes or single-file edits. The maintainers want a written plan in plans/<topic>.md before any code, genuine design forks put to the developer instead of assumed, implementation in the plan's phases with a pause at each boundary, and UI-facing work verified in a real browser rather than only by unit tests.
---

# Plan-first, phased, browser-verified workflow

Large changes here follow the same loop every time: plan, resolve the forks, implement in
checkpointed phases, verify for real. Reviewing a plan is cheap; unwinding a half-built
architecture change is not. `plans/menu-rework.md` is the reference example of a plan carried
through this loop.

## Fast path

1. **Look for an existing plan.** `ls plans/` and grep for the topic. If one exists, continue
   it (step 5) instead of starting a second one.
2. **Write `plans/<topic>.md` before touching code.** The existing plans share a shape, so
   follow it:
   - `# Title` — the change in one line.
   - `## Context` — the current state and why it's a problem, researched from the code rather
     than assumed. Record decisions already made with the developer here.
   - `## Goals` and `## Non-goals (this pass)` — the scope boundary.
   - `## Design` — lettered subsections (`### A.`, `### B.`, ...), one per moving part, naming
     the files and APIs involved.
   - `## Phasing` — ordered phases, each independently shippable and testable.
   - `## Testing` — which tests are added or extended, and what needs a real browser pass.
   - `## Open questions` (or `## Decisions needed from you`) — every fork not yet settled.
3. **Resolve forks by asking.** A fork is a choice with real architectural consequences:
   composition vs. subclassing, where an event-bus boundary sits, the shape of a public API,
   how much scope to take on. Put the options and a recommendation to the developer (use
   `AskUserQuestion` where available), then record the answer in the plan. Don't ask about
   implementation details you can decide yourself.
4. **Implement one phase at a time.** Stop at each phase boundary and wait for a go-ahead
   before starting the next; don't run the whole plan unprompted. Leave the tests and
   `npx eslint` green at the end of every phase.
5. **Record what shipped.** When a phase lands, append `### What actually shipped in Phase N`
   to the plan: what was built, where it deviated from the design, and why. Later readers need
   that more than the original design.
6. **Verify for real before calling a phase done.** Run the relevant tests (`npm test` or the
   narrower script). For any UI-facing or rendering change, also do a real browser pass with
   the `browser-ui-verification` skill (recipe in `docs/browser-verification.md`): unit tests
   passing is not proof that a menu renders or a shader draws. If a real pass isn't possible
   in the current environment, say so explicitly in your report instead of presenting test
   results as equivalent proof.

## The pointer-lock trap

Headless Chromium in this setup never grants real Pointer Lock. Bugs in the pointer-lock,
mouse-look, click-to-relock, or hover-highlight pipeline therefore look fine in an automated
pass purely because the code path never engages. For that class of bug, reason through the
event interaction directly, cover it with a unit test where possible, and tell the developer
it needs a live test. See `docs/browser-verification.md` for the details.

## What this skill does NOT do

- Does not apply to bug fixes, single-file edits, or changes small enough that the plan would
  be longer than the diff. Use judgment; when in doubt, ask.
- Does not commit anything. Whether the plan doc is committed, and when, is the developer's
  call. For changes under a game that is a git submodule (e.g. `source/game/id1/`), see the
  `submodule-aware-commit` skill before committing.
- Does not replace tests or lint; it sits on top of them.
