# QuakeShack Engine

QuakeShack is a modern JavaScript/TypeScript port of the Quake 1 engine running in the browser (WebGL/WebAudio) and on Node.js, integrated with Cloudflare services.

Be a good boy scout: whenever touching something, leave it cleaner than before. Follow the conventions below. Run `eslint --fix`. Write unit tests for things you work on. Keep all existing tests passing. Update JSDoc when changing public APIs.

## Quick Reference

**Build & run**
```bash
npm install
npm run build:production          # browser client → dist/browser/
npm run dedicated:dev             # dedicated server (watch)
npm run dedicated:build:production
npm run dedicated:start
npm test                          # all tests
npm run test:game                 # game/mod tests
npm run test:common               # engine common tests
npm run test:physics
npm run test:renderer
npm run typecheck                 # tsc over engine, game and shared; gates the Cloudflare build and the Docker test stage
npx eslint --fix <file>
```

**Lint and typecheck before committing.** The ESLint config is strict — fix all warnings. `npm run typecheck` must stay at zero errors: it fails the Cloudflare build (`npm run build:wrangler`) and the Docker `test` stage. `.mjs` tests are not type-checked, so search them by hand when you change a signature.

## Working Agreements

How the maintainers want substantial work run: architecture changes, cross-cutting refactors, new subsystems. Not for bug fixes or single-file edits. The `plan-first-workflow` skill (`.claude/skills/plan-first-workflow/SKILL.md`) has the details.

- **Plan first.** Write `plans/<topic>.md` before touching code: Context, Goals, Non-goals, Design, Phasing, Testing, Open questions. `plans/menu-rework.md` is the reference example.
- **Ask on real forks.** Composition vs. subclassing, event-bus boundaries, public API shape, scope: put the options to the developer instead of picking one. Decide implementation details yourself.
- **Work in phases.** Implement the phases the plan lays out and stop at each boundary for a go-ahead rather than running the whole plan unprompted. Record what actually shipped in the plan.
- **Verify UI-facing changes in a real browser**, not just with unit tests (`browser-ui-verification` skill, `docs/browser-verification.md`). If you couldn't verify something, say so. Headless Chromium here never gets real Pointer Lock, so pointer-lock, mouse-look, and hover bugs can't be confirmed or ruled out by an automated pass; they need a live test.
- **LLM output gets reviewed.** `LLM.md` explains how this project uses LLMs: output is read, adjusted, or rewritten, never taken on faith, and LLMs know Quake engine internals only shallowly. This code has diverged a lot from WinQuake, so check the source instead of trusting recalled engine details.

## Known Traps

Things that fail silently, so nothing tells you that you tripped them. Skills live in `.claude/skills/<name>/SKILL.md`: Claude Code loads them on demand by their `description`, and they are plain Markdown that any other tool or developer can read.

- **Committing under `source/game/id1/`** → `submodule-aware-commit`. `id1` is its own git repo (submodule `game.git`), so a top-level `git add -A && git commit` silently skips its files. Commit inside the submodule first, then bump the pointer. `source/game/hellwave` is a plain directory and commits normally.
- **Adding a test file in a new subdirectory under any `test/`** → `test-glob-coverage`. npm runs the test globs through `dash`, where `**` does not recurse, so files nested deeper than the spelled-out patterns are skipped while `npm test` still reports a clean pass.
- **Adding a test fixture or a new top-level source/config file** → `dockerfile-fixture-sync`. The Dockerfile's `test` and `builder` stages only see files they explicitly `COPY`, so it passes locally and fails only in CI.
- **Editing a helper in a `.frag`/`.vert` file** → `shader-duplication-propagation`. There is no `#include`, so shared routines are hand-duplicated across shader files and a missed copy is a silent rendering bug.
- **Adding or changing an `eventBus` event** → `event-bus-docs-sync`. Every event must be documented in `docs/events.md` (engine) or the game's own `docs/events.md`; nothing enforces it.
- **Changing client, UI, HUD, or input code** → `browser-ui-verification`. Unit tests can't catch texture-binding, FBO, or input-pipeline bugs, and there is no `chromium-cli` or Playwright dependency, so verification needs a specific recipe.
- **Asking "what calls X" or "what breaks if I rename Y"** → `graphify-lookup`. Query the code knowledge graph before grepping.
- **Calling `PostProcess.beginDepthSampling()`/`endDepthSampling()`.** Unbind the depth texture from its sampler unit before `endDepthSampling()`, or WebGL raises a `GL_INVALID_OPERATION` feedback-loop error. The contract is JSDoc on those two methods in `source/engine/client/renderer/PostProcess.ts`.
- **Tidying a static facade class (`CL.ts`, `Host.ts`).** Some mix `this.foo` and `ClassName.foo` because they were once one monolithic file. Standardize on `ClassName.foo`; see "Clean up global objects" in `code-style-guide.instructions.md`.
- **Writing engine-level docs, instructions, or skills.** Keep them game-agnostic: references to `id1` or `hellwave` are illustrative examples, not engine facts (`source-directories.instructions.md`).

**Where new knowledge goes.** When you learn a repo gotcha that isn't obvious from the code, record it in the repo instead of only in a personal agent memory, so it reaches every developer. An API contract goes in JSDoc on the API. A reference or how-to goes in `docs/`. Something to *do at a specific moment* (a trigger plus a checklist) becomes a skill. A cross-cutting rule goes in the matching `.github/instructions/` file. Add it to the list above only when none of those fit.

## Miscellaneous

- Use American English.

## Imported Guidelines

@.github/instructions/source-directories.instructions.md

@.github/instructions/architecture.instructions.md

@.github/instructions/build-and-deploy.instructions.md

@.github/instructions/code-style-guide.instructions.md

@.github/instructions/typescript-port.instructions.md

@.github/instructions/event-bus.instructions.md

@.github/instructions/workers.instructions.md

@.github/instructions/shaders.instructions.md

@.github/instructions/unit-tests.instructions.md

@.github/instructions/graphify-usage.instructions.md
