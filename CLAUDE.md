# QuakeShack Engine

A JavaScript/TypeScript port of the Quake 1 engine for the browser (WebGL/WebAudio) and Node.js, integrated with Cloudflare services.

Be a good boy scout: leave what you touch cleaner than before. Follow the conventions below, run `eslint --fix`, write unit tests that would catch a real bug in what you work on (not copies of the source), keep all tests passing, update JSDoc when changing public APIs. American English.

## Commands

```bash
npm run build:production            # browser client → dist/browser/
npm run dedicated:dev               # dedicated server (watch); dedicated:build:production, dedicated:start
npm test                            # all tests; test:game, test:common, test:physics, test:renderer
npm run typecheck                   # must stay at zero errors (gates Cloudflare build and Docker test stage)
npx eslint --fix <file>             # strict config, fix all warnings
```

## Working Agreements

- Substantial work (architecture changes, cross-cutting refactors, new subsystems) follows the `plan-first-workflow` skill.
- Verify UI-facing changes in a real browser: the `browser-ui-verification` skill runs it in a Sonnet subagent. Say so if it couldn't verify.
- Memory or performance concerns get measured attribution first (heap snapshots, profiles, `scripts/measure-bsp-memory.mts`), never a guessed fix. Check the plan in `plans/` for numbers already taken.
- LLMs know Quake internals only shallowly and this code has diverged a lot from WinQuake: check the source instead of trusting recalled engine details (`LLM.md`).

## Known Traps

Silent failures. The project skills in `.claude/skills/` cover the others (commits under `source/game/`, Dockerfile fixtures, shaders, event bus docs, UI verification, tests); load one when its description matches.

- **Sampling scene depth while drawing**: bind `PostProcess.sceneDepthCopy()`, never `PostProcess.depthTexture` (feedback loop); it copies only when stale, so whatever writes depth after a copy calls `invalidateSceneDepthCopy()`. Contract in its JSDoc (`source/engine/client/renderer/postprocess/PostProcess.ts`).
- **Adding a worker**: register it in `WorkerFactories.ts`, file name ends in `Worker.ts` (`docs/workers.md`).

**Where new knowledge goes**: an API contract in JSDoc, a reference or how-to in `docs/`, a trigger plus checklist as a skill, a cross-cutting rule in the matching `.github/instructions/` file, a rule for certain files only in `.claude/rules/` with `paths:` frontmatter. Everything imported below loads into every session: keep it short, put detail in a skill or `docs/`.

## Imported Guidelines

@.github/instructions/source-directories.instructions.md

@.github/instructions/architecture.instructions.md

@.github/instructions/build-and-deploy.instructions.md

@.github/instructions/code-style-guide.instructions.md

@.github/instructions/typescript-port.instructions.md

@.github/instructions/event-bus.instructions.md
