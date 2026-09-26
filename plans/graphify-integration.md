# Graphify integration for agentic exploration

**Status:** Done. Setup script, gitignore entry, and instructions file are in place. The
trial runs that motivated this are documented below for future reference — re-verify the
caveats if graphify is upgraded, since they're specific to the version tested
(`graphifyy` 0.9.34).

## Context

[Graphify](https://graphify.net/) is a third-party CLI (`pip install graphifyy`) that turns
a codebase into a queryable knowledge graph via local tree-sitter AST extraction, with an
optional LLM pass for naming clusters of related code. It was trial-run against this repo
twice — first `source/shared/` (8 files), then the full `source/` tree (254 files, 5,384
nodes / 13,967 edges, extracted in a few seconds) — to decide whether it's worth adopting
for agentic (Claude Code) work here, and if so, how.

### What held up

The deterministic layer — `update` (AST extraction, no LLM), `god-nodes`, `query`,
`explain`, `affected`, and unlabeled clustering — is free, local, and accurate. No API key,
no network call for this part. `god-nodes` on the full tree correctly surfaced `Vector`
(527 edges), `BaseEntity` (303), `serializableObject()`, `BrushModel`, `ServerEdict`,
`PlayerEntity`, `EventBus` as the real core abstractions — exactly what anyone who knows
this codebase would already point to.

### What didn't hold up

Two of graphify's higher-value report sections are unreliable on this codebase:

- **Import Cycles.** The full-tree run flagged a dozen 3–4 file "cycles," e.g.
  `engine/client/ClientEntities.ts → engine/common/model/BSP.ts →
  engine/client/renderer/Materials.ts → engine/client/ClientEntities.ts`. Verified by hand:

  ```
  source/engine/client/ClientEntities.ts:16   import { revealedVisibility, type Node } from '../common/model/BSP.ts';
  source/engine/common/model/BSP.ts:1         import type { BaseMaterial } from '../../client/renderer/Materials.ts';
  source/engine/client/renderer/Materials.ts:2 import type { ClientEdict } from '../ClientEntities.ts';
  ```

  Two of the three edges are `import type` — erased by esbuild at compile time, no actual
  runtime circular dependency. A second sampled cycle (`Cmd.ts → Client.ts → Edict.ts →
  Cmd.ts`) showed the same pattern. Graphify doesn't distinguish `import type` from
  `import`, so on a codebase that leans on type-only imports as much as this one does (per
  `typescript-port.instructions.md`), most reported "cycles" are false alarms. A
  TypeScript-aware tool (`madge --ts-config`, `dependency-cruiser`) would filter these
  correctly; graphify does not.
- **Knowledge Gaps ("534 isolated nodes").** Spot-checked `{ COM, Con, S }` in the reported
  list — this is the registry-destructuring prolog pattern mandated by
  `code-style-guide.instructions.md` (`let { CL, COM, Con, ... } = registry;`), misparsed as
  a standalone unconnected symbol rather than recognized as the idiom it is. Most of the
  534 count is likely the same kind of noise.

### Scale matters

On `source/shared/` (8 files), `god-nodes`/`query`/`explain` didn't surface anything a
10-second grep wouldn't have. The tool only starts paying for itself at real scale —
directories the size of `source/engine/client/` or bigger, or cross-cutting questions that
span the client/server/common split.

### The `claude-cli` LLM backend

Community labeling (`Community 47` → a real name) is the one feature that needs an LLM.
Inspected `graphify/llm.py::_call_claude_cli`: it shells out to `claude -p --output-format
json --no-session-persistence` as a **separate headless, one-shot subprocess** — not the
calling session. It reuses the existing Claude Code subscription auth (no separate
`ANTHROPIC_API_KEY` needed), but **defaults to Opus** unless `GRAPHIFY_CLAUDE_CLI_MODEL` is
set, and graphify forces these calls to run serially (parallel `claude -p` subprocesses
corrupt each other's sessions). Given the real cost implication, this stays an opt-in step
defaulting to Haiku — see the instructions file.

### First live labeling run

After the integration landed, ran a real labeling pass on the full `source/` tree (254
files, 5,384 nodes, 197 communities) via:

```
GRAPHIFY_CLAUDE_CLI_MODEL=haiku PYTHONPATH="$HOME/.local/share/graphify-pylibs" \
  python3 -m graphify cluster-only source --no-viz --backend=claude-cli
```

Result: ~138K input / ~17K output tokens on Haiku, 2 serial `claude -p` batches (batch size
100). Label quality was genuinely good — e.g. `"Entity Base Class Core"`, `"Brush Collision
Tracing"`, `"Server Collision Clipping"`, `"BSP Map Data Structures"` — accurate enough to
navigate by, not generic filler. This is the part unlabeled clustering couldn't deliver.

Two things learned worth keeping in mind: `cluster-only` labels *by default* — `--no-label`
is what opts back out, not a flag you add to opt in — and `explain` can be ambiguous on
common symbol names shared across files (hit this on `EventBus`, which exists in both
`GameAPIs.ts` and `registry.ts`); graphify handles it gracefully by listing node ids to
retry with rather than guessing. Both are now documented in the instructions file, along
with a "when to actually run a label pass" section (communities are stable — re-label after
a structural change, not on every `update`; prefer `label --missing-only` for incremental
re-labeling over a full `cluster-only` re-run).

## What was done

1. **`scripts/graphify-setup.sh`** — no-sudo bootstrap. This machine has no `pip` and
   `python3 -m venv` needs `apt install python3.13-venv` (sudo). Validated a working
   alternative live: `curl -fsSL https://bootstrap.pypa.io/get-pip.py | python3 - --target=<dir>`
   followed by `pip install --target=<dir> graphifyy`. The script installs into
   `~/.local/share/graphify-pylibs`, outside the repo — this is machine-level tooling, not
   a project dependency, so nothing here touches `package.json`, CI, or the Dockerfile.
   `pip install --target` doesn't generate a `bin/graphify` launcher (confirmed: the
   package's `entry_points.txt` declares `graphify = graphify.__main__:main`, but no script
   wrapper is written to a `--target` dir), so it must be invoked as
   `PYTHONPATH=<dir> python3 -m graphify <command>`.
2. **`.gitignore`** — added `graphify-out/` (the tool's default output directory) to the
   existing flat list.
3. **`.github/instructions/graphify-usage.instructions.md`** — new instructions file
   covering setup, when to use it vs. not, the command cheat-sheet, the "always `update`
   before querying" rule (validated cost: seconds cold on the full 254-file tree, and
   incremental via `manifest.json`'s per-file `ast_hash`/`mtime` cache, so warm re-runs only
   touch changed files), a dedicated "when and how to run a label pass" section (see below),
   the two caveats above, and explicit non-goals (never commit `graphify-out/`, never wire
   into Docker/CI).
4. **`CLAUDE.md`** — added `@.github/instructions/graphify-usage.instructions.md` to the
   Imported Guidelines list, so every future Claude Code session in this repo picks up the
   guidance automatically.

### Getting the instructions file actually used

The user ran a real feature-work session after all of the above landed and observed Claude
using only grep — never once querying the graph, despite it existing and the instructions
file being imported. Prose in an always-loaded instructions file, it turns out, doesn't
reliably change tool-selection habits; there's no trigger forcing the agent to stop and
check applicability before defaulting to what it already knows how to do.

Fix: added `.claude/skills/graphify-lookup/SKILL.md`, a project-scoped Claude Code Skill
(not the full official `graphify` skill graphify ships for `graphify install` — that one
auto-dispatches subagents for semantic extraction and does inline labeling on every full
pipeline run, both of which conflict with the "opt-in labeling only, no automatic heavy
work" policy already agreed here). This skill is intentionally narrow: it covers only the
free `update` + point-query fast path, points to the instructions file for the labeling
policy and caveats, and its `description:` frontmatter is the actual activation lever —
skills surface in a listing shown every turn, which is a much stronger trigger than prose
inside an imported instructions file that has to be independently recalled mid-task. Modeled
the description on graphify's own official skill.md, which uses near-identical framing
("...the question should be treated as a graphify query first") — that phrasing is
apparently the tool author's own answer to this exact adoption problem.

Also tightened the instructions file's "When to reach for it" section to explicitly name
the skill as the primary trigger and state the policy it encodes, so the two documents stay
consistent rather than the skill drifting from the doc it points back to.

## Decisions made (and why)

- **Manual regeneration only, no git hook.** Graphify ships a `hook install` command for a
  git post-commit auto-refresh. Declined: it would be this repo's first-ever git hook, and
  the deterministic `update` step is cheap enough to just run on demand before a graphify
  session rather than adding a standing dependency for every contributor.
- **Auto-loaded instructions file over a reference-only doc.** The point of this
  integration is to make agentic work systemically faster, not just faster in the session
  that happened to remember the tool exists — so the guidance had to go where every future
  session automatically sees it (`CLAUDE.md`'s Imported Guidelines), not just in a `plans/`
  doc that has to be rediscovered.
- **Labeling opt-in, defaulting to Haiku, never automatic.** Avoids silently spending
  Opus-tier usage on a structured/cheap labeling task, and avoids the `claude -p` subprocess
  cost showing up unexpectedly as part of routine `update` calls.
