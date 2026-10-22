## Architecture

The code started as WinQuake, adapted to the web with many added features (some backported from Quake 2, some original). The goal is to replace almost all of the original with new implementations; the architecture is inspired by id tech 3, GoldSrc and Source, not copied from them.

- A **client** (browser: WebGL, Web Audio), a **server** (Node.js dedicated, or in the browser as a listen server that players join over WebRTC) and a **master server** (public server list, signaling) talk over WebSockets, WebRTC or, in single player, the loopback driver in one process.
- **Maps (BSP)**: always traverse the BSP tree and use the plane equations for collision detection, visibility checks and other spatial queries. No AABB min/max checks, no ray-box tests, no distance checks.
