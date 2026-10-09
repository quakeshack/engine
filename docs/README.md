# QuakeShack Engine Documentation

This directory contains documentation for the QuakeShack engine codebase and features.

## Table of Contents

- [Asset Layer](asset-layer.md) - How content files and user files (saves, config, demos) are stored in the browser: Cache Storage, Web Locks, IndexedDB, cache names and the `localStorage` migration.
- [Server in a Web Worker](server-worker.md) - Running the server of a browser game in its own worker: the data and control channels, when a server frame runs, the realm of the worker and what does not work yet.
- [Browser Verification Technique](browser-verification.md) - How to drive a live headless-browser smoke test of the client (no chromium-cli/playwright dependency) for verifying UI/frontend changes.
- [BSPX Support](bspx.md) - Details on supported BSPX extensions and lumps for advanced mapping features.
- [Client Entities](client-entities.md) - Client-only entities (gibs, bubbles, debris): handlers, spawning, physics, sequences, PVS culling and save games, and how that compares to WinQuake.
- [Client Server Architecture](cs.md) - Overview of the client-side architecture.
- [Code Style Guide](code-style-guide.md) - Coding conventions and style rules for the QuakeShack Engine codebase.
- [Console](console.md) - Details regarding the console implementation.
- [Dedicated Server](dedicated.md) - Information on running QuakeShack as a dedicated server in a Node.js environment.
- [Events](events.md) - Documentation on the engine's event bus system.
- [Game Module Contract](game-module-contract.md) - What the engine calls on a game module, in which order, who writes which field, and how `tsc` checks a game against the engine.
- [Menu System](menu-system.md) - Stack-based, widget-driven menu framework and the `ClientEngineAPI.Menu` API for game code.
- [Post-Process Effects](post-process-effects.md) - Game-controlled screen-space effects (color grading, blur) and how to extend them.
- [QSMAT (QuakeShack Material) Format](qsmat-format.md) - Details on the `.qsmat.json` file format used to define PBR materials for Quake BSP maps.
- [Shader Chunks](shader-chunks.md) - `#include` for GLSL: the chunk folder, once-per-stage expansion, `#line` based error mapping, the list of chunks and how to add one.
- [Traceline API](traceline.md) - Contract and semantics of the gameplay-facing trace query used by server and client game logic.
- [Volumetric Fog](volumetric-fog.md) - Guide on creating atmospheric fog volumes in maps.
- [WebRTC Implementation](webrtc.md) - Details the WebRTC implementation for peer-to-peer networking in the QuakeShack engine.
