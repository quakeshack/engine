# QuakeShack AI Assistant Instructions

**Important**: Also consider .github/instructions/**.md for more specific architectural rules and coding conventions.

You are working on QuakeShack, a modern JavaScript port of the Quake 1 engine integrated with Cloudflare services.

Be a good boy scout, whenever touching something, make sure it’s cleaner than before. Refactor and improve code quality, readability, and maintainability whenever possible. Follow the coding conventions and architectural rules outlined in the documentation and instruction files. Also write unit tests for things you work on, and make sure all existing tests pass. Always use `eslint --fix` and follow the configured rules. If you are making a change that affects the public API, make sure to update the JSDoc comments accordingly.

## Project Structure & Architecture

- **Multi-Root Workspace**:
  - `engine/`: Core game engine (Browser/Node.js). Adapted from WinQuake but heavily modernized.
  - `master-server/`: Global server browser & WebRTC signaling (Cloudflare Workers + Durable Objects).
  - `tools/`: Map compilers and utilities (C++ based, e.g., `ericw-tools`).

### Engine Architecture (`engine/`)
- **Runtime Targets**:
  - **Browser**: Client (WebGL, WebAudio) & Listen Server.
  - **Node.js**: Dedicated Server (`dedicated.mjs`).
- **Networking**:
  - **WebRTC**: Peer-to-peer multiplayer (Client <-> Listen Server).
  - **WebSocket**: Client <-> Dedicated Server & Signaling with Master Server.
  - **Loopback**: Used for Singleplayer (Client <-> Server in same process).
- **Resource Loading**: Modern asynchronous asset loading (WAD3, BSP2, textures).
- **Rendering**: WebGL-based. Supports colored lighting (`.lit`, RGBLIGHTING), dynamic lights, and static skyboxes.

### Master Server Architecture (`master-server/`)
- **Infrastructure**: Cloudflare Workers with Durable Objects for state persistence.
- **Function**: Handles server listing (REST) and WebRTC signaling (WebSocket upgrade).

## Key Developer Workflows

### Engine
- **Build**: `npm run build:production` (via Vite). Output in `dist/`.
- **Run**:
  - Browser: Served via Vite during dev.
  - Dedicated: `src/dedicated.mjs` (Node environment).
- **Linting**: Strict ESLint configuration (`eslint.config.mjs`).

### Master Server
- **Run/Dev**: `wrangler dev` (Cloudflare local emulation).
- **Deploy**: `wrangler deploy -e production`.

## Critical Coding Conventions

### The Registry Pattern (Strict)
This project uses a unique "Registry" pattern for global modules.
- **ALWAYS destructure** registry modules at top-level scope.
- **NEVER** access properties directly (e.g. `registry.Con` is forbidden).
- **Subscribe to `registry.frozen`** to re-assign modules after initialization.

**Required Boilerplate:**
```javascript
let { CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry;

eventBus.subscribe("registry.frozen", () => {
  ({ CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry);
});
```

### JSDoc & Typing
- **Mandatory JSDoc** for class properties (no inline comments).
- **No `any`, `unknown`, or `*`**. Use specific types (e.g. `ArrayBuffer`).
- **No `@returns {void}`**.

## Specific Patterns to Observe

- **Module System**: ES Modules exclusively (`type: "module"` in package.json).
- **Asset Paths**: Game data resides in `data/` (id1, hellwave) and `resources/`.
- **Event Bus**: Use `eventBus` for lifecycle events (`registry.frozen`, `game.start`). See `docs/events.md`.
- **Physics**: Uses `ammojs3` / `cannon`.
- **Legacy Compatibility**: Maintains Quake 1 structures (BSP, MDL) but wrapped in modern JS classes.
- **Signaling**: Study `master-server` documentation for the exact WebSocket protocol used for WebRTC negotiation.

## Specialized Files
- `LLM.md`: Project philosophy regarding AI contribution.
- `engine/.github/instructions/*.md`: Detailed architectural rules.
- `wrangler.toml`: Cloudflare configuration (exists in both `engine` and `master-server`).
