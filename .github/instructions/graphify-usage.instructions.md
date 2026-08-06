## Graphify — Code Knowledge Graph for Agentic Exploration

[Graphify](https://graphify.net/) is a local, tree-sitter-based CLI that builds a queryable
knowledge graph of a codebase (`graph.json`), with an optional LLM pass for naming clusters
of related code. It is a developer/agent-assist tool, not part of the build, test, or deploy
pipeline — it must never be added to `package.json`, CI, or the Dockerfile.

### One-time setup

Run `scripts/graphify-setup.sh` once. It bootstraps `pip` (via the official PyPA
`get-pip.py`, since this machine may not have `pip` or `python3-venv` available without
sudo) and installs `graphifyy` into `~/.local/share/graphify-pylibs`, outside the repo.
`pip install --target` does not generate a `bin/graphify` launcher, so invoke it as a
module:

```
PYTHONPATH="$HOME/.local/share/graphify-pylibs" python3 -m graphify <command>
```

### When to reach for it

A `.claude/skills/graphify-lookup/SKILL.md` in this repo is the primary trigger for this —
it surfaces automatically for architecture/dependency/blast-radius questions. This section
is the underlying policy it (and you) should follow:

Before defaulting to grep/Explore for a question about symbol relationships, dependencies,
or blast radius ("what calls X", "what depends on Y", "what would this rename break"), or
before orienting in a large/unfamiliar directory (`source/engine/client/`-scale or bigger),
**check whether `source/graphify-out/graph.json` exists.** If it does, query it first — see
the Fast path in the skill file or the cheat-sheet below. Don't silently reach for grep just
because it's the familiar default; a graph that's already built and sitting on disk unused
is a real cost, not a neutral choice.

Do **not** reach for it on small or targeted lookups where you already know the file.
Validated on `source/shared/` (8 files): grep and a normal Explore search answered the same
questions faster than graphify did, with no loss of accuracy. It only starts paying for
itself at real scale.

### Command cheat-sheet

- `update <path> --no-cluster` — free, local, incremental (hashes each file via
  `manifest.json`'s `ast_hash`/`mtime`, only re-parses what changed). Default target for a
  full pass is `source`.
- `god-nodes --graph <path>/graphify-out/graph.json` — most-connected symbols, i.e. the
  real core abstractions of the scanned tree.
- `query "<question>" --graph <path>/graphify-out/graph.json` — BFS traversal answering
  free-form questions with cited file:line evidence.
- `explain "<Symbol>" --graph <path>/graphify-out/graph.json` — one-hop neighbor summary
  for a single symbol. Common names can be ambiguous across files (e.g. `EventBus` exists
  in both `GameAPIs.ts` and `registry.ts`) — graphify reports the conflict and lists node
  ids instead of guessing; retry with the printed node id or a more specific query.
- `affected "<Symbol>" --graph <path>/graphify-out/graph.json` — reverse traversal to find
  what would be impacted by changing a symbol; use this before a rename or signature change.

**Always run `update --no-cluster` immediately before any `query`/`explain`/`affected`/
`god-nodes` call.** It is cheap (seconds cold on the full `source/` tree, near-instant warm)
and guards against querying a graph that's stale relative to the current working tree. This
does not apply to full re-clustering — cluster labels only matter for the big-picture
community report, not point lookups, so there is no need to re-cluster before every query.

### Community labeling — when and how

Naming communities (`Community 47` → `"Brush Collision Tracing"`) needs an LLM call and is
**opt-in only — run it when the user explicitly asks for it, never automatically and never
bundled into a routine `update`.**

**When:** only when the task actually needs the community/report-level overview — e.g. the
user wants a map of the codebase's major subsystems, or is onboarding into an area with no
existing mental model. Point lookups (`query`, `explain`, `affected`, `god-nodes`) all work
fine against an unclustered or unlabeled graph, so don't label just to run one of those.
Communities are also comparatively stable — re-label after a structural change big enough to
plausibly shift subsystem boundaries (a large refactor, a new subsystem added/removed), not
on every commit or every `update`.

**How:** `cluster-only` does clustering *and* labeling in one pass — `--no-label` is what
opts back out, so plain `cluster-only` already calls the LLM. Always pin the backend and
model explicitly rather than relying on auto-detect (which walks other providers' API-key
env vars first and may pick something unexpected):

```
GRAPHIFY_CLAUDE_CLI_MODEL=haiku PYTHONPATH="$HOME/.local/share/graphify-pylibs" \
  python3 -m graphify cluster-only <path> --no-viz --backend=claude-cli
```

`--no-viz` skips `graph.html` generation — not needed for agent consumption and slow on
graphs this size. If a graph is already labeled and only a few communities changed (e.g.
after `update` added new nodes), prefer `label <path> --missing-only` over a full
`cluster-only` re-label — it only names placeholder/missing communities, cheaper than
relabeling everything.

**Cost reference:** labeling the full `source/` tree (254 files, 5,384 nodes, 197
communities, batch size 100 → 2 serial `claude -p` calls) cost ~138K input / ~17K output
tokens on Haiku. Use this as a ballpark for future runs of similar scope.

### Verified caveats — treat these sections as leads, not facts

- **Import Cycles.** Graphify does not distinguish `import type` from `import`. On this
  codebase, spot-checked reported cycles turned out to be 2/3 type-only edges — compile-time
  constructs erased by esbuild, not real runtime circular dependencies. Verify every
  reported cycle by hand (`grep -n "^import" <file>`) before treating it as real.
- **Knowledge Gaps / isolated-node counts.** The extractor misparses this repo's
  registry-destructuring prolog (`let { CL, COM, Con, ... } = registry;`, mandated by
  `code-style-guide.instructions.md`) as standalone unconnected nodes. Expect noise in
  these counts; don't take them at face value.

### Non-goals

- Never commit `graphify-out/` (gitignored).
- Never wire into Docker, CI, or `package.json` scripts.
- Not a substitute for BSP-tree traversal or the other architectural invariants in
  `architecture.instructions.md` — it is a navigation aid over source text, not a runtime
  spatial/collision authority.
