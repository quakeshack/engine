## Source Directories

- `source/engine/` by realm: `common/` (client and server), `client/` (rendering, input, audio), `server/`, `network/` (protocols, messages).
- `source/shared/`: engine-agnostic code for engine and games (math, data structures, algorithms, re-exported engine types games need).
- `source/game/<mod>/`: game modules (`id1`, `hellwave`; `baseq2` planned). Both are separate repos, committed from inside (`submodule-aware-commit`). `id1` has its own `CLAUDE.md`.
- **Game code never imports engine files**, only the API the engine hands it (`ServerEngineAPI`/`ClientEngineAPI`). The contract is `source/shared/GameInterfaces.ts` (`docs/game-module-contract.md`); `npm run typecheck` reports drift between the two sides.
- **Engine-level docs, instructions and skills stay game-agnostic.** A concrete game is an illustrative example, labeled as one; game-specific behavior belongs with that game.
