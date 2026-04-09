# WebRTC Implementation

This document details the WebRTC implementation for peer-to-peer networking in the QuakeShack engine.

## Overview

The WebRTC implementation allows clients to connect directly to each other for multiplayer games, minimizing latency by avoiding a central game server relay. A dedicated "Signaling Server" (Cloudflare Worker) is used only for the initial connection handshake (SDP offer/answer exchange).

## Architecture

```
                                  +---------------------+
                                  |   Signaling Server  |
                                  | (Cloudflare Worker) |
                                  +----------+----------+
                                             ^
                                             | WebSocket (WSS)
                                             |
                  +--------------------------+-------------------------+
                  |                                                    |
         +--------v--------+                                  +--------v--------+
         |     Host        |                                  |     Client      |
         | (WebRTCDriver)  |<----- P2P Data Channels -------->| (WebRTCDriver)  |
         +-----------------+       (UDP/SCTP)                 +-----------------+
```

### Components

1.  **WebRTCDriver (`engine/source/engine/network/NetworkDrivers.ts`)**:
    *   Implements the `BaseDriver` interface.
    *   Handles signaling handshake via WebSocket.
    *   Manages `RTCPeerConnection` and `RTCDataChannel`s.
    *   Supports Mesh topology (every peer connects to every other peer).

2.  **Signaling Server (`master-server/src/index.js`)**:
    *   Cloudflare Worker using Durable Objects and WebSocket Hibernation.
    *   Facilitates the exchange of connection information (Session IDs, SDP Offers/Answers, ICE Candidates).
    *   Maintains a list of active sessions for the server browser.
    *   **Note**: This replaces previous local Node.js/Express `signaling.mjs` implementations.

## WebRTCDriver Implementation

The driver acts as both a client (connecting to signaling) and a peer manager.

*   **Initialization**: Defaults to connecting to `ws://{hostname}:8787/signaling` (local dev) or production URL.
*   **Connection URI**:
    *   `webrtc://host` or `host`: Creates a new session.
    *   `webrtc://<sessionId>` or `<sessionId>`: Joins an existing session.
*   **Data Channels**:
    *   Uses two channels per peer:
        1.  `reliable`: Ordered, reliable transmission (e.g., game state, events).
        2.  `unreliable`: Unordered, unreliable transmission (e.g., player positions).
*   **Protocol**:
    *   Encapsulates the standard Quake network protocol (3-byte header) over the DataChannel.

## Signaling Protocol

The signaling server communicates via JSON messages over WebSocket.

**Endpoint**: `/signaling`

### Client -> Server Messages

| Type | Payload Attributes | Description |
| :--- | :--- | :--- |
| `create-session` | `sessionId` (opt), `isPublic` (bool), `serverInfo` (obj), `hostToken` (opt) | Create a new game session. `hostToken` allows reconnection. |
| `join-session` | `sessionId` | Join an existing session by ID. |
| `offer` | `targetPeerId`, `offer` (SDP) | Forward WebRTC Offer to a specific peer. |
| `answer` | `targetPeerId`, `answer` (SDP) | Forward WebRTC Answer to a specific peer. |
| `ice-candidate` | `targetPeerId`, `candidate` (ICE) | Forward ICE Candidate to a specific peer. |
| `update-server-info` | `serverInfo` | Update server metadata (map, player count, etc.) for the browser. |
| `ping` | - | Keep-alive to prevent session timeout. |
| `leave-session` | - | Gracefully leave the current session. |

### Server -> Client Messages

| Type | Payload Attributes | Description |
| :--- | :--- | :--- |
| `session-created` | `sessionId`, `peerId`, `isHost`, `hostToken`, `existingPeers` | Confirmation of session creation. |
| `session-joined` | `sessionId`, `peerId`, `isHost`, `peerCount`, `serverInfo` | Confirmation of joining a session. |
| `peer-joined` | `peerId`, `peerCount`, `isHost` | Notification that a new peer has joined the session. |
| `peer-left` | `peerId`, `peerCount` | Notification that a peer has disconnected. |
| `offer` | `fromPeerId`, `offer` | Incoming WebRTC Offer from another peer. |
| `answer` | `fromPeerId`, `answer` | Incoming WebRTC Answer from another peer. |
| `ice-candidate` | `fromPeerId`, `candidate` | Incoming ICE Candidate. |
| `session-closed` | `reason` | The session has ended (e.g., host left). |
| `error` | `error` | Error message description. |

## Session Management

*   **Host Authority**: The peer that creates the session is the "Host".
*   **Host Token**: A secure token returned to the host upon creation. Allows the host to reconnect and reclaim the session if their WebSocket drops.
*   **Stale Sessions**: Sessions with no activity (pings) for 60 seconds are automatically cleaned up by the Durable Object.
*   **Browser Integration**: Public sessions are automatically listed in the public server list (accessed via `/browser` WebSocket or `/list-servers` HTTP endpoint).

## Comparison with Old Implementation

*   **Signaling Server**: Moved from a standalone Node.js script (`signaling.mjs`) to the `master-server` Cloudflare Worker.
*   **Protocol**: Enhanced to support `hostToken` for reconnections and `serverInfo` for the server browser.
*   **Storage**: Uses Cloudflare Durable Objects storage instead of in-memory only.

## Usage

To host a game, start the client and use the following commands:

```
maxplayers 2
listen 1
coop 1
map e1m1
```

Once the game has started, you can use `invite` to generate an invite link.

To join a game:

```
connect <SessionID>
```
