

## Source Directories

- Source code is located in the `source/` directory.
- The engine is organized in `source/engine/` and is divided into subdirectories based on functionality:
  - `source/engine/common/` - Shared code between client and server.
  - `source/engine/client/` - Client-specific code, such as rendering, input, and audio.
  - `source/engine/server/` - Server-specific code.
  - `source/engine/network/` - Networking code such as protocols and message handling.
- The game is organized in `source/game/` and follows a slightly different structure:
  - `source/game/id1/` - the original Quake game logic. A separate git submodule (`game.git`); changes there need their own commit inside the submodule (see the `submodule-aware-commit` skill).
  - `source/game/hellwave/` - the Hellwave game mod. A plain directory in this repo, not a submodule.
  - `source/game/baseq2/` - (future) Quake II game logic.
  - Game code must never directly import files from the engine; it should only use the public API exposed by the engine.
- There is code which is shared between the engine and game, located in `source/shared/`.
  - The idea is to keep engine-agnostic code here, such as math utilities, data structures, and algorithms.
  - Data structures and types implemented or declared in the engine, can be re-exported here.
- Keep the same boundary in documentation and agent instructions/skills. Engine-level docs (`docs/`), `.github/instructions/`, and `.claude/skills/` should describe game-facing engine APIs and mechanisms in game-agnostic terms. A reference to a concrete game (`id1`, `hellwave`) there is an illustrative example, not a permanent engine fact, and should be labeled as such — game-specific behavior, event lists, or walkthroughs belong with that game once it has its own docs/instructions to hold them.
  - `source/game/id1/` has its own `CLAUDE.md` and `.github/instructions/` (e.g. its entity/TypeScript conventions doc, previously misplaced at the engine repo root as a now-obsolete `.mjs`-to-`.ts` porting guide) — a nested `CLAUDE.md` like this loads automatically for agent sessions working under that path, without needing an `@import` from the top-level `CLAUDE.md`. `source/game/hellwave/` doesn't have one yet; add one there the same way once it accumulates enough of its own agent-facing conventions to be worth a dedicated home.
