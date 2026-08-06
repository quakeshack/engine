---
name: graphify-lookup
description: Use for any question about this codebase's architecture, symbol relationships, dependencies, or blast radius — "what calls X", "what depends on Y", "what would this rename/refactor break", orienting in an unfamiliar or large subsystem (source/engine/client/-scale or bigger). If source/graphify-out/graph.json exists, treat the question as a graphify query FIRST, before grep or an Explore search. Not for single-file or single-symbol lookups you already know the location of — grep still wins there.
---

# Graphify lookup

This repo has a local code knowledge graph (built with [graphify](https://graphify.net/))
for exactly the kind of cross-file question that grep answers slowly or incompletely:
"what calls X", "what depends on Y", "what's the blast radius of changing Z", or getting
oriented in a subsystem you don't know yet. Full policy, caveats, and the labeling workflow
live in `.github/instructions/graphify-usage.instructions.md` — this file is the short
trigger + command reference; read that one for depth.

## Fast path

1. Check whether the graph exists: `ls source/graphify-out/graph.json`.
2. **If it exists:** run the free, incremental staleness guard, then answer from the graph:
   ```
   PYTHONPATH="$HOME/.local/share/graphify-pylibs" python3 -m graphify update source --no-cluster
   PYTHONPATH="$HOME/.local/share/graphify-pylibs" python3 -m graphify query "<question>" --graph source/graphify-out/graph.json
   ```
   `update` is seconds cold, near-instant warm (incremental cache) — always run it first so
   the answer reflects the current working tree, not a stale snapshot.
3. **If it does not exist:** this is a one-time setup gap, not a reason to silently fall
   back to grep for a qualifying question. Run `scripts/graphify-setup.sh` once, then
   `update source --no-cluster` as above. For a genuinely narrow, single-symbol lookup where
   this setup detour isn't worth it, grep is fine — see the "Not for" clause above.

## Command reference

- `query "<question>" --graph source/graphify-out/graph.json` — BFS traversal, free-form
  question, cited file:line evidence. Best default for "what calls/depends on/relates to X".
- `explain "<Symbol>" --graph source/graphify-out/graph.json` — one-hop neighbor summary for
  a single symbol. Can be ambiguous on common names shared across files (e.g. `EventBus`) —
  graphify lists node ids to retry with rather than guessing.
- `affected "<Symbol>" --graph source/graphify-out/graph.json` — reverse traversal; use
  before a rename or signature change to see what breaks.
- `god-nodes --graph source/graphify-out/graph.json` — most-connected symbols; good first
  call when orienting in an unfamiliar directory.

## What this skill does NOT do

- Does not run the full extraction/clustering/labeling pipeline or dispatch subagents —
  only the free `update --no-cluster` step and point queries above.
- Does not auto-label communities. Labeling costs real LLM usage and is opt-in only, run
  explicitly on request — see the "Community labeling" section of
  `.github/instructions/graphify-usage.instructions.md` for when and how.
- Does not touch git hooks, CI, or `package.json` — this is a local dev/agent-assist tool.
- Import-cycle and "isolated node" report sections are noisy on this codebase (type-only
  imports and the registry-destructuring idiom both get misparsed) — verify before trusting
  either, per the instructions file.
