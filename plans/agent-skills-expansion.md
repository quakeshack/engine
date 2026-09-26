# Expanding the agent-skills roster

**Status:** Done. Seven new skills across three rounds, two new docs, docs/events.md drift
fixed as a demonstration, and one candidate deliberately left as documentation instead of a
skill. Round 3 moved the last memory-only knowledge into the repo (see below).

## Context

`graphify-lookup` (see `plans/graphify-integration.md`) established a pattern for this
repo: a policy that already exists as prose in an always-loaded instructions file
(`.github/instructions/*.instructions.md`, imported via `CLAUDE.md`) can still go
unused, because prose alone doesn't reliably change tool-selection habits — there's no
trigger forcing an agent to stop and check applicability before defaulting to whatever it
already knows how to do. A `.claude/skills/*/SKILL.md` file is a much stronger trigger: its
`description:` frontmatter surfaces in a listing shown every turn.

Asked "what other skills can we introduce," the approach was to look for other cases
matching that exact shape: a real, already-documented policy that's easy to skip, ideally
with evidence of actual drift rather than a hypothetical risk.

## What was found

Checked every `.github/instructions/*.md` file for policies with (a) a real enforcement
gap and (b) either measurable current drift or a non-obvious execution path that's easy to
skip. Four qualified; one candidate (a TypeScript-porting skill) did not, and was dropped
after checking real state.

### 1. Event-bus docs sync — confirmed live drift

`event-bus.instructions.md` says every event must be documented in `docs/events.md`.
Measured: 71 unique `eventBus.publish/emit(...)` call sites in `source/` (via
`grep -rhoE "eventBus\.(publish|emit)\(['\"][a-zA-Z0-9_.\-]+" source --include='*.ts'`)
against 58 documented rows — and the doc had no `### Game` or `### Registry` or
`### Navigation` section at all. Fully undocumented: `registry.frozen` (used everywhere,
including as the canonical example in `code-style-guide.instructions.md`'s registry
pattern), all four `nav.*` events from `Navigation.ts`, and nine `game.*` events across
`id1` (`game.monster.spawned/injured/killed`, `game.player.died`, `game.secret.found/spawned`)
and `hellwave` (`game.phase.changed/endingtime`, `game.round.started`).

Fixed as part of this work — see `docs/events.md`'s new `### Registry`, `### Navigation`,
and `## Game Events` (`### id1` / `### Hellwave`) sections. The one remaining "gap" the
audit script flagged, `worker.test`, turned out to be dead commented-out code in
`WorkerManager.ts:44`, not a real event — correctly left undocumented.

### 2. Browser UI verification — mandated, but the technique lived only in session memory

The verification requirement itself isn't repo policy — it's a standing instruction this
agent always operates under ("for UI/frontend changes, use the feature in a browser before
reporting done"). What *is* repo-specific is that satisfying it here isn't obvious: there's
no `chromium-cli` and no `playwright`/`puppeteer` project dependency. A working recipe
existed, but only as an agent's personal cross-session memory
(`reference_headless_browser_verification_technique.md`) — useful to that one agent, invisible
to anyone else (human or agent) working in this repo. Promoted it to `docs/browser-verification.md`
(cached-Chromium discovery, scratch `node_modules/` symlink trick, spare-port dedicated
server boot, virtual-to-screen click-coordinate math, the `window.registry`/`Key.destination`
trick for reaching gated menu pages, the synthetic `/signaling` WebSocket technique for
master-server realtime features, and known limitations like no real Pointer Lock in headless
Chromium here) and added it to `docs/README.md`'s index. `browser-ui-verification` is the
short trigger skill pointing to it.

### 3. Dockerfile / test-fixture sync

`build-and-deploy.instructions.md` already states this plainly: the Dockerfile's `test`
stage only sees files it explicitly `COPY`s, so a new `data/` fixture or new top-level
source/config file silently passes every local `npm test`/build and only breaks in CI,
inside Docker — a confusing place to first discover the rule. Lower frequency than #1/#2,
but the failure mode (a red CI check with no obvious local repro) justified a skill: a
checklist to run at the moment a fixture or top-level file is added, not after CI already
caught it.

### 4. Shader duplication propagation

`shaders.instructions.md` §4 already documents the mechanism: no `#include` in this
codebase's GLSL, so shared routines are hand-duplicated across independent shader files.
Verified the duplication is real, not just a hypothetical: `sampleLocalShadow` currently
exists in 4 separate files out of 60 total `.frag`/`.vert` files under
`source/engine/client/shaders/`. Editing one copy and missing the others is a silent
rendering bug — it compiles fine, it just renders wrong in whichever shaders didn't get the
fix. The skill's fast path is the grep-before-and-after checklist the instructions file
already asks for, plus a pointer to `browser-ui-verification` for visually confirming the
propagated fix actually renders consistently.

### Dropped: TypeScript porting

`typescript-port.instructions.md` / `game-logic-port.instructions.md` describe a detailed,
18-item-checklist `.mjs` → `.ts` porting workflow — exactly the kind of multi-step,
easy-to-skip-a-step process that looked like a strong skill candidate on paper. Checked
actual repo state before building anything: `find source/engine -name '*.mjs'` returns
nothing, and every non-test `.mjs` under `source/game` is gone too (`hellwave` was written
directly in TypeScript — 25 `.ts` files, zero `.mjs`). The porting effort these instructions
describe is already complete; the docs are reference material now, not an active workflow.
No skill built for this — there's no live task for it to trigger on.

## Round 2 — mining cross-session agent memory

Asked "anything else we can extract from the memories and turn into skills?" — a different
source than round 1: instead of auditing instructions files for undersupported policy, this
pass read every file in the agent's own persistent cross-session memory
(`~/.claude/projects/.../memory/*.md`, excluding the one already spent on
`browser-ui-verification`) and checked each one against current repo state, since memories
are point-in-time and can go stale. Six files existed; four besides the one already used.

### 5. Submodule-aware commit — confirmed still true

`project_repo_layout_submodules.md` recorded that `source/game/id1` is a real git submodule
and `source/game/hellwave` is not. Re-verified live: `.gitmodules` still declares
`source/game/id1` (`url = ../game.git`), and `git submodule status` still reports it as a
tracked submodule at a real commit. The failure mode is exactly as recorded — a top-level
`git add -A && git commit` silently misses the submodule's internal file diffs, capturing at
most a gitlink pointer bump — so a skill was built rather than left as memory, since this
needs to survive independent of which agent/session happens to remember it.

### 6. Test-glob coverage — confirmed zero current gap, but also zero headroom

`project_test_glob_recursion_gap.md` recorded that dash's `**` doesn't recurse, so
`package.json`'s test scripts need one explicit glob segment per directory level. Re-ran the
diff check the memory itself proposed — through real `sh -c` expansion (not zsh, which
*does* recurse `**` and would have given a false negative) against every `*.test.mjs` file
on disk. Result: zero gap right now, confirming the prior fix (`test`/`test:game`'s third
segment) is holding. But also found something the memory didn't have visibility into: three
other scripts (`test:common`, `test:physics`, `test:renderer`) use only a single `**`
segment each, and the engine-side portion of `test`/`test:game` (`test/**/*.test.mjs`) does
too — all four are one level deep with zero extra segments, same latent-gap shape as the
game-side pattern, just not yet hit because `test/client/`, `test/common/`, `test/physics/`,
and `test/renderer/` all happen to be flat today. Combined with the game-side pattern
already sitting exactly at its covered depth (`source/game/hellwave/test/client/menu/`),
every one of these five scripts is currently at max depth with no headroom — the next
subdirectory added anywhere under any `test/` folder breaks silently. Documented this fuller
picture in the skill rather than just the original game-side finding.

### Not built as skills

- **This./ClassName. style drift** (`project_this_vs_classname_static_style_drift.md`) — a
  judgment-call explanation ("why does `CL.ts` mix both styles"), not a trigger/action
  policy. No clear moment to fire on, and no drift to measure — it's a fact about existing
  code, not a rule that gets violated going forward. Added as a short paragraph to
  `code-style-guide.instructions.md`'s "Clean up global objects" section instead, so any
  contributor (not just an agent with this specific memory) understands the judgment call
  next time they clean up a static facade class.
- **Plan-first, phased, browser-verified workflow** (`feedback_plan_first_workflow.md`) —
  this is collaboration guidance about how the user wants *this agent* to work with them
  (write a plan doc, surface forks via `AskUserQuestion`, checkpoint at phase boundaries),
  not a codebase policy a skill would encode for arbitrary contributors. Left as feedback
  memory, where it already does its job. **(Reversed in Round 3: it is now a skill and a
  `CLAUDE.md` section.)** One piece of it *was* actionable, though: its
  "Known Playwright/headless limitation" note — that a passing automated pass on
  pointer-lock/hover bugs is a false-confidence trap, not evidence, because the harness
  never grants real Pointer Lock — was folded into `docs/browser-verification.md` §6 and the
  `browser-ui-verification` skill, which had originally only captured the narrower "mouse
  look doesn't work" fact and missed the sharper warning.

## Round 3 — making the rest usable by other developers (2026-09-19)

Asked to make the agent-facing knowledge available to every developer, not only to the one
agent session that happened to hold it: put the memories into `CLAUDE.md`, and turn memories
into skills where that fits. Re-read all seven memory files against the repo. Six were already
in the repo (rounds 1-2, the `PostProcess.ts` JSDoc, and the `id1` conventions move). One was
still memory-only: the plan-first workflow, which round 2 had deliberately left as personal
collaboration guidance.

### 7. Plan-first workflow — reversed, now shared

The workflow is how the maintainers want substantial work run here, so it belongs to every
contributor, not one agent. Built `.claude/skills/plan-first-workflow/SKILL.md` as the
on-demand procedure. Its plan template was derived from the headings the existing `plans/*.md`
actually share (Context, Goals, Non-goals, Design, Phasing, Testing, Open questions, plus
`What actually shipped in Phase N` appended as phases land), not invented. It cites
`plans/menu-rework.md` as the example because that is the only tracked plan; most others are
still untracked, so other developers can't see them.

### `CLAUDE.md` additions

- **Working Agreements** — the always-loaded, four-line rule form of the workflow, plus a
  pointer to `LLM.md` (kept as a pointer, not an `@import`: it is a long first-person
  disclosure, not agent instructions).
- **Known Traps** — one line per silent-failure trap with the skill or doc to read. This is
  deliberately an index, not a copy: the detail stays in each skill, `docs/`, or JSDoc. It
  also covers three items that are not skills (depth-sampling feedback loop, `this.` vs
  `ClassName.` drift, the game-agnostic docs policy), and states where new knowledge should go
  so the next gotcha lands in the repo instead of in someone's private memory.

### Re-checked, still not a skill

- **GL depth-sampling feedback loop.** The memory said to reconsider a skill if a third
  `beginDepthSampling`/`endDepthSampling` call site appeared. Re-grepped: still exactly two
  pairs, both in `BrushModelRenderer.ts`, both unbinding first, and the JSDoc contract on
  `PostProcess.ts` is intact. Left as JSDoc plus a `Known Traps` line.

### Deliberately not copied

- The user-level synced skills under `~/.claude/skills/synced/` (docx, pdf, pptx, xlsx,
  skill-creator, docs, ...) are generic account skills with their own license files, not
  project knowledge.
- The full browser-verification recipe: it already lives in `docs/browser-verification.md`
  with a skill trigger, and copying ~8 KB into an always-loaded file would cost context on
  every session.

## What was done

1. **`docs/browser-verification.md`** — new reference doc, indexed in `docs/README.md`.
   Deliberately *not* added to `CLAUDE.md`'s Imported Guidelines: unlike the graphify
   instructions file, this technique is only relevant to UI-verification tasks specifically,
   not broad enough to justify always-loaded context on every session. The skill is the
   on-demand trigger instead.
2. **`.claude/skills/browser-ui-verification/SKILL.md`**
3. **`.claude/skills/event-bus-docs-sync/SKILL.md`**, plus a one-line pointer added to
   `event-bus.instructions.md`'s existing "documented in `docs/events.md`" bullet.
4. **`.claude/skills/dockerfile-fixture-sync/SKILL.md`**, plus a one-line pointer added to
   `build-and-deploy.instructions.md`'s existing Dockerfile-sync paragraph.
5. **`.claude/skills/shader-duplication-propagation/SKILL.md`**, plus a one-line pointer
   added to `shaders.instructions.md` §4's existing "Action" bullet.
6. **`docs/events.md`** — fixed the drift found during research (see above) as a concrete
   demonstration of the new skill, not left as a hypothetical.
7. **`.claude/skills/submodule-aware-commit/SKILL.md`**.
8. **`.claude/skills/test-glob-coverage/SKILL.md`**, plus a one-line pointer added to
   `unit-tests.instructions.md`'s "Category globs" bullet.
9. **`code-style-guide.instructions.md`** — added the `this.`/`ClassName.` style-drift note
   to the "Clean up global objects" section.
10. **`docs/browser-verification.md`** and `.claude/skills/browser-ui-verification/SKILL.md`
    — strengthened with the pointer-lock false-confidence warning from
    `feedback_plan_first_workflow.md` (see Round 2 above).
11. **`.claude/skills/plan-first-workflow/SKILL.md`**, plus the `Working Agreements` and
    `Known Traps` sections in `CLAUDE.md` (see Round 3 above).

## Decisions made (and why)

- **Instructions files get a one-line pointer to the new skill, not a rewrite.** Mirrors
  how `graphify-usage.instructions.md` names `graphify-lookup` as its primary trigger — the
  instructions file stays the policy statement, the skill stays the enforcement/fast-path
  layer, and the two stay consistent by the skill linking back rather than duplicating the
  policy prose.
- **Not every new instructions-file doc gets added to `CLAUDE.md`'s Imported Guidelines.**
  Graphify's instructions file is always-loaded because "check the graph before grepping"
  applies broadly across many kinds of exploration tasks. `docs/browser-verification.md`
  doesn't share that property — it's only relevant when a UI change specifically needs
  live-browser verification — so keeping it as an on-demand doc the skill points to avoids
  paying always-loaded context cost for a narrow-purpose recipe.
- **Checked real repo state before building a skill, not just instructions-file text.** The
  TypeScript-porting candidate looked strong from the instructions files alone; only
  checking actual `.mjs` counts revealed the work was already finished. Worth recording so
  a future pass doesn't re-propose the same idea without re-checking.
- **Not every good memory is a good skill.** A memory being true and useful doesn't imply it
  belongs in `.claude/skills/`. The dividing line used here: does it describe a repo-wide
  policy with a trigger/action shape (something any future contributor or agent needs to
  *do* at a specific moment), or is it collaboration guidance / explanatory history that
  only changes how one agent behaves or how one judgment call gets made? The former became
  skills; the latter became either a short instructions-file note (style drift) or stayed as
  personal memory (plan-first workflow).
- **Cross-session agent memory that documents a real repo gotcha should get promoted to the
  repo, not left as one agent's private notes.** `reference_headless_browser_verification_technique.md`
  and the submodule/test-glob project memories were all genuinely useful facts about *this
  repository*, not about the user or the collaboration — leaving them only in
  `~/.claude/projects/.../memory/` means they only help whichever agent happens to have that
  specific memory loaded. Promoting the repo-facts (not the user/collaboration-facts) into
  `docs/`, `.github/instructions/`, and `.claude/skills/` makes them available to any future
  session, any agent, and any human contributor who opens the repo.
