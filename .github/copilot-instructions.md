# QuakeShack AI Assistant Instructions

QuakeShack is a TypeScript port of the Quake 1 engine (browser and Node.js) integrated with Cloudflare services. The full rules are in `CLAUDE.md` at the root of `engine/`. It pulls its guidelines in with `@imports`, which Copilot does not follow, so read these files yourself: `.github/instructions/source-directories.instructions.md`, `architecture`, `build-and-deploy`, `code-style-guide`, `typescript-port` (the TypeScript conventions), `event-bus` and `unit-tests`, all in `.github/instructions/`. `LLM.md` explains how this project uses LLMs.

## Multi-root workspace

- `engine/`: the game engine (browser client, listen server, Node.js dedicated server). Adapted from WinQuake but heavily modernized.
- `master-server/`: the global server browser and WebRTC signaling (Cloudflare Workers with Durable Objects: server listing over REST, signaling over a WebSocket upgrade). Study its documentation for the exact WebSocket protocol used for WebRTC negotiation.
- `tools/`: map compilers and utilities (C++ based, e.g. `ericw-tools`).

## Commands

- **Engine:** `npm run build:production` (browser client into `dist/browser/`), `npm run dedicated:dev` then `npm run dedicated:start` (dedicated server, entry `dedicated.ts`), `npm test`, `npm run typecheck` (must stay at zero errors), `npx eslint --fix <file>`.
- **Master server:** `wrangler dev` (local Cloudflare emulation) and `wrangler deploy -e production`. The `wrangler.toml` files of `engine/` and `master-server/` are separate.

## Always

- Leave code cleaner than you found it. Write unit tests for what you touch, keep the existing ones passing, run `eslint --fix`, and update JSDoc when a public API changes.
- Import the module you need (`Con`, `Host`, `CL`, `R`, ...); per-realm classes get their collaborators through the constructor. Details in `code-style-guide.instructions.md`.
- Game code under `source/game/` never imports engine files; it uses the API the engine passes in.
