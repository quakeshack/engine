# Session ping/latency: real client-to-host RTT + bracket-stable lobby sort

**Status:** Done. All four phases shipped on 2026-07-23 and the user live-verified them against two
real local sessions (see "What actually shipped in Phase 4"). Follow-ups still open, none started:
the client-side probe cap (`MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS`, never introduced), ping in
id1's `launch_server` page, the master-server hardening and real-join challenge (Security §6), and
further OOB query types (Phase 5, optional). The `Items.ts` type error mentioned in the per-phase
verification notes was fixed later, in [game-module-contract.md](game-module-contract.md) Phase 1.
Paths and line numbers are as of writing.

## Context

[`hellwave-main-menu-rework.md`](hellwave-main-menu-rework.md) built the live session list on
hellwave's `'main'` page and explicitly deferred ping:

> **No ping/latency column in v1.** Nothing in the codebase measures pre-connect latency today —
> building that is a non-trivial, separate infra piece (a signaling-server ping endpoint or ICE
> RTT reading), not something to improvise as a side effect of a menu layout change.

[`hellwave-lobby-cards.md`](hellwave-lobby-cards.md) (2026-07-22) deferred it again, more
concretely:

> **No ping/latency display in this pass.** Confirmed with the user: real pre-connect RTT
> measurement needs its own infra design (a speculative WebRTC probe, or properly wiring up the
> signaling keepalive's currently-discarded `pong` timestamp — either way, a separately-sized
> follow-on plan), and a cheap colo/country-based proxy risks showing a number that reads as
> authoritative but isn't.

This is that follow-on plan, requested 2026-07-23 alongside two more concrete asks: sort the
session list by ping (with hysteresis so it doesn't reorder on every measurement), and make sure
the new client-to-host out-of-band traffic this requires can't be abused to disrupt an active
session.

Like [`hellwave-lobby-cards.md`](hellwave-lobby-cards.md)'s `DiscoveredSession.settings` field,
the actual mechanism here is engine + master-server infrastructure
(`source/engine/network/NetworkDrivers.ts`, `source/engine/client/menu/SessionDiscovery.ts`,
`master-server/src/index.ts`), not hellwave-specific — hellwave's `MainMenu.ts` is simply the first
(and today, only) consumer.

**Framing confirmed with the user (2026-07-23):** classic Quake had a genuine out-of-band packet
concept — `CCREQ_SERVER_INFO`/`CCREQ_RULE_INFO`/`CCREQ_PLAYER_INFO` and friends, sent to a server's
port without ever occupying a client slot, used both by the engine itself (LAN/server browser) and
by third-party tooling (the old PHP server-status pages queried servers directly the same way,
e.g. `CCREQ_PLAYER_INFO` returning each connected player's name/frags/colors for a live scoreboard
snapshot without joining). This plan keeps that spirit: rather than hard-coding a ping-only special
case, it introduces a genuine **connectionless/out-of-band (OOB) peer connection** concept at the
WebRTC/signaling layer — a connection that is structurally incapable of ever becoming a real
client slot — with ping/pong as its first query type for this pass. The wire format (§4) and
host-side dispatch (§2) are deliberately shaped so that a later **player-snapshot query** (names,
scores, colors — the concrete example raised alongside this plan) or other classic-style queries
can be added as one more narrowly-scoped handler on the same connection, without redesigning the
channel or its lifecycle. **This plan does not build any query beyond ping/pong** — only the
extensible envelope and connection lifecycle future queries would ride on.

## What exists today (researched, not assumed)

- **Signaling is one single, globally-shared Durable Object.** `master-server/src/index.ts:30-31`
  always resolves the DO via `env.SIGNALING_SESSION.idFromName('global')` — every hosted session
  and every browsing client anywhere goes through the *same* DO instance. Durable Objects process
  messages serially on one thread, so anything that adds sustained per-message cost here has a
  **global** blast radius (every hosted session's signaling, not just the one being probed), not a
  per-session one. This is the central fact that shapes the design below.
- **No rate limiting exists anywhere in the signaling dispatch today.** `handleMessage`
  (`index.ts:804-844`) and `handleBrowserMessage` (`index.ts:657-681`) switch straight into
  handlers with no per-connection throttling of any kind. Flagged as a pre-existing gap (see
  Security §6), not something this plan needs to fully close.
- **The existing `ping`/`pong` signaling messages are a host-only WebSocket keepalive, not a
  latency measurement.** `WebRTCDriver.#StartPingInterval()`
  (`source/engine/network/NetworkDrivers.ts:1127-1140`) fires only from the *host* every 30s purely
  to keep Cloudflare from idling out the WebSocket; the reply is discarded outright
  (`case 'pong': return;`, `NetworkDrivers.ts:1259-1260`). This is exactly the mechanism
  `hellwave-lobby-cards.md` called "the signaling keepalive's currently-discarded pong timestamp,"
  and is unrelated to the new OOB mechanism below (that one stays as a pure WS keepalive).
- **Joining a session is completely ungated today — exactly the "fills a real client slot"
  problem the user called out.** `handleJoinSession` (`master-server/src/index.ts:965-1006`) lets
  any signaling connection join any session by ID — no public/private check, no room-limit check,
  at the signaling layer. Host-side, `WebRTCDriver.#OnPeerJoined` (`NetworkDrivers.ts:1383-1401`)
  unconditionally creates a real `QSocket` and calls `#CreatePeerConnection` for *any* joining peer,
  before any game-level handshake happens. `SV.CheckForNewClients()`
  (`source/engine/server/Server.ts:351-382`) then unconditionally promotes any delivered `QSocket`
  into a real `ServerClient` slot (`SV.ConnectClient`) and increments `NET.activeconnections`
  (which is exactly what `#GatherServerInfo()` sweeps into the publicly-shown `currentPlayers`).
  **There is no two-phase connect/challenge gate anywhere in this stack** — unlike classic Quake's
  `CCREQ_CONNECT` handshake, a WebRTC "join" *is* already a full connection attempt. This plan's OOB
  connection type is the first real instance of "connect without consuming a slot" in this engine.
- **Only STUN is configured, no TURN** (`NetworkDrivers.ts:920-923`: `stun.l.google.com`,
  `stun.cloudflare.com`, `stun.nextcloud.com`). Real joins already have no TURN fallback, so an OOB
  connection will fail in exactly the same NAT/firewall situations a real join would.
- **Already-connected-player ping is unrelated.** `Client.ts`'s `ping_times`/`ping` getter
  (`source/engine/server/Client.ts:47-49,198-199`), the `clc "ping"` command
  (`Server.ts:145`, `653`), and `svc_updatepings` (`source/engine/server/ServerMessages.ts:861-876`)
  only exist for players already inside a game, driving the in-game scoreboard. None of this helps
  a browsing client evaluate a session it hasn't joined.
- **The lobby side has no ping concept and no sort today.** `DiscoveredSession`
  (`source/engine/client/menu/SessionDiscovery.ts:25-35`) has no ping field.
  `MainMenu.#rebuildSessionRows` (`source/game/hellwave/client/menu/MainMenu.ts:334-368`) renders
  sessions in whatever order they arrive from `Multiplayer.SubscribeSessions`
  (`source/engine/common/GameAPIs.ts:1563-1593`), with no sorting at all.

## Decided direction (confirmed with the user, 2026-07-23)

Two shapes were considered for measuring real pre-connect latency:

- **A genuine client-to-host OOB WebRTC connection** — a browsing client opens an actual (minimal)
  WebRTC connection directly to the target host, purely to exchange small out-of-band messages
  (ping/pong now, room for more later) over a dedicated data channel that structurally can never
  become a real client slot.
- **A signaling-relay approximation** — sum of the host's keepalive RTT to the master server and
  the browsing client's own RTT to the master server. Cheaper, but every leg transits the one
  **globally shared Durable Object**, and it only ever approximates real client→host latency (the
  same "reads as authoritative but isn't" risk already rejected once for a colo/country proxy).

**Decided: build the OOB connection.** It gives the real number the user asked for, its
steady-state ping traffic never touches the shared Durable Object once established (only one-time
connection setup does, at the same cost a real join's signaling already has), and — the deciding
factor — it's the only shape that actually delivers "a new connection doesn't automatically fill a
real client slot," which the user identified as the underlying property worth having independent
of the ping feature itself, echoing classic Quake's out-of-band packet model.

## Design

### 1. Signaling protocol addition (master server)

No brand-new message *types* for the handshake — reuse `join-session` / `offer` / `answer` /
`ice-candidate` / `peer-left` / `leave-session` as-is, just carrying one new field through:

- `join-session` gains an optional `role: 'oob'` (default implicit `'peer'` for a real join).
- `SignalingAttachment` (`index.ts:59-70`) gains `isOob?: boolean`, set in
  `updateSocketAttachment` alongside the existing `sessionId`/`peerId`/`isHost` fields.
- `handleJoinSession`'s `peer-joined` broadcast (`index.ts:1001-1005`) includes `isOob` so the host
  can branch on it.
- `getSessionPeerCounts()` (`index.ts:368-381`) excludes OOB attachments — an OOB connection must
  never be countable as "a peer in this session" for any bookkeeping (peer counts, stale-session
  cleanup, or anything that could keep a dead session alive or otherwise confuse the DO).
- New caps enforced in `handleJoinSession`: `MAX_OOB_CONNECTIONS_PER_SESSION` — reject a
  `role: 'oob'` join beyond the cap with a clean `error` message rather than silently degrading.
- `protocol.ts` gains a small `normalizeRole`-style validator matching the existing
  `normalizeSessionId`/`normalizePeerId` pattern (fixed enum, reject anything else).

This keeps the master-server diff small and reuses already-tested code paths
(`test/signaling-session.test.mjs` already covers `handleJoinSession`/`handlePing` shapes).

### 2. Engine (`WebRTCDriver`) — host side

- `#OnPeerJoined` (`NetworkDrivers.ts:1383-1401`) branches on `message.isOob`: instead of
  `NET.NewQSocket`/pushing to `newConnections`, it calls a new `#OnOobPeerJoined(peerId)`. An OOB
  peer **never gets a `QSocket`, never reaches `NET.activeSockets`, never reaches
  `SV.CheckForNewClients()`** — structurally, not just by a runtime flag check. This is the direct
  implementation of "a new connection doesn't automatically fill a real client slot."
- New `#oobConnections: Map<string, RTCPeerConnection>` (separate from the existing
  `socketData.peerConnections`, which is keyed per-`QSocket` and simply doesn't exist for a peer
  that never got one).
- New `#CreateOobPeerConnection(peerId)`: same `iceServers` as today (`NetworkDrivers.ts:920-923`),
  but its `ondatachannel` only ever wires up a single channel labeled `'oob'` — mirroring the
  existing `ondatachannel` branch at `NetworkDrivers.ts:1586-1612` that already ignores any channel
  label besides `'reliable'`/`'unreliable'`. Any other channel label (or a second channel) on an
  OOB connection is refused/closed, never routed anywhere near `#SetupDataChannelHandlers`.
- The `'oob'` channel handler validates frame shape (see §4) before touching content, then
  dispatches on the leading type byte through a small, explicit **handler table** (`type → handler
  function`) — not a generic or reflective bridge into game code. For this pass the table has
  exactly one entry, `PING → PONG`. An unrecognized type byte is dropped, not an error. Adding a
  future query type (§4's player-snapshot example) means writing one more narrow, hand-authored,
  read-only handler and adding it to this table — never opening a general-purpose RPC/reflection
  path into `SV`/entity state. This distinction is what keeps Security §1's isolation guarantee
  meaningful as more query types are added later, instead of eroding one handler at a time.
- All caps below are enforced **locally, on values the driver itself tracks** — never trusting
  anything the remote peer claims:
  - `MAX_OOB_CONNECTIONS_PER_HOST` (e.g. 16) — reject/close beyond this.
  - `MIN_PING_INTERVAL_MS` (e.g. 1000) per connection — pings arriving faster are silently dropped
    (not answered), never processed further.
  - `OOB_IDLE_TIMEOUT_MS` (e.g. 30000) — auto-close a connection that hasn't sent a valid OOB
    message in this long (covers a viewer who navigated away without a clean WebRTC close).
- OOB connections get the same ICE-failure cleanup path `#ClosePeerConnection` already provides for
  real connections (`NetworkDrivers.ts:1562-1565`), just targeting `#oobConnections` instead.

### 3. Engine (`WebRTCDriver`) — viewer/browsing side

- New method(s) exposed for the browsing side, e.g. `WebRTCDriver.startSessionPing(sessionId)` /
  `stopSessionPing(sessionId)`, built on top of a generic OOB-connection helper rather than baking
  ping directly into the join flow — naming/exact split is an implementation-time detail.
- **Open implementation question surfaced by this design**: today, opening the lobby only opens
  the lightweight `/browser` WebSocket (`SessionDiscovery.ts`) — the `/signaling` WebSocket
  (`WebRTCDriver.#ConnectSignaling`) is only opened once the player actually starts hosting or
  joining. OOB connections require `join-session`/`offer`/`answer`/`ice-candidate`, which only
  exist on `/signaling` today. That means **just opening the lobby now also opens a `/signaling`
  connection**, even before the player picks anything — a genuinely new always-on cost while the
  lobby is on screen, worth calling out explicitly rather than discovering it mid-implementation.
- Flow: send `join-session { sessionId, role: 'oob' }` over `/signaling`; on `session-joined`,
  create an *initiator* `RTCPeerConnection`, open only the `'oob'` data channel (no
  `'reliable'`/`'unreliable'` channels — an OOB connection must never be mistakable for a real
  connect attempt from the viewer's side either), send periodic ping frames, measure elapsed time
  to the matching pong, feed into an EMA (§6).
- Cap concurrent OOB connections client-side too (`MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS`) — only
  probe sessions actually visible in the current lobby view, not every session the master server
  ever returns.
- Teardown (`leave-session` + close) when a session scrolls out of view, the lobby closes, or the
  connection exceeds a max lifetime — mirroring the existing `onExit` cleanup discipline
  `MainMenu.ts`'s session subscription already uses (`MainMenu.ts` `onExit` /
  `unsubscribeSessions`).

### 4. Wire format — the `'oob'` channel payload

Binary, not JSON — consistent with the rest of the transport's binary framing (`SzBuffer`) and
trivially bounds-checkable before any parsing. Shaped as a general **envelope**, not a ping-only
struct, echoing the classic `CCREQ_*`/`CCREP_*` request-byte model:

```
[1 byte type][4 byte sequence][type-specific payload, possibly empty]
```

`RTCDataChannel` already delivers each `send()` as one discrete, whole message on the receiving
end (unlike a byte stream) — so the envelope needs **no internal length prefix**; each type simply
declares its own fixed or bounded `byteLength` rule, checked against `event.data.byteLength` before
anything past the type byte is read.

This pass defines exactly one type pair:

```
type 1 = PING  (viewer -> host):  payload = 8-byte timestamp (double, ms)          -> 13 bytes total
type 2 = PONG  (host -> viewer):  payload = echoes PING's sequence + timestamp     -> 13 bytes total
```

Types `3+` are reserved and rejected today (dropped silently, not an error) — the concrete
extension point named in Context. **Not built in this pass**, but sized for it:

- A hypothetical `PLAYER_SNAPSHOT_REQUEST` (viewer → host) would need no payload beyond the shared
  header (5 bytes: type + sequence) — the request carries no arguments.
- Its `PLAYER_SNAPSHOT_RESPONSE` (host → viewer) is naturally variable-length (one record per
  connected player), but still trivially boundable: the engine already caps player count at
  `SV.svs.maxclients`, so the handler's own response-size cap falls out of a value the engine
  already enforces elsewhere, not a new one invented for this feature. Its source data would
  already exist and already be public — broadcast to every connected client's scoreboard today via
  `svc_updatefrags`/`svc_updatepings` (`ServerMessages.ts:869,917-927`): `ServerClient.name`
  (`Client.ts:180-191`), `.colors` (`Client.ts:44`), the entity's `.frags`
  (`ServerMessages.ts:917`, read via `requireEntity()` — the same generic engine-reads-a-
  game-set-field pattern already used there), and `.ping` (`Client.ts:198-199`). A future handler
  for this type would be a read-only loop over `SV.svs.clients` copying already-broadcast fields
  into the response buffer — not a new window into anything currently private, and not a new
  amplification vector beyond what a live scoreboard already reveals to any connected player.

Preserving this shape now (typed envelope, per-type size rule, no length prefix needed) is what
makes that later addition "one more handler entry," not a wire-format redesign.

The host validates the exact byte length and the type tag *before* reading anything else out of the
buffer; anything else (wrong size, unknown tag, garbage) is dropped silently, never throws.

This lives entirely inside `NetworkDrivers.ts`. It is **not** plumbed into `Protocol.ts`'s
`svc`/`clc` command enums, `MSG.ts`'s reader, or any `Server.ts`/`ServerMessages.ts` code — there
is no code path from the `PING`/`PONG` handler into game state, by construction, not by a runtime
check that could be bypassed or forgotten on some branch. (A future snapshot-query handler would be
the first OOB handler to deliberately, narrowly read already-public game state — see Security §1
for why that's still a bounded, reviewable addition rather than a hole in this guarantee.)

### 5. Client-facing API

- `DiscoveredSession` (`SessionDiscovery.ts:25-35`) gains `ping: number | null` — `null` while
  unmeasured or after a failed/refused OOB connection.
- Recommended: `SessionDiscovery` itself owns the OOB-ping lifecycle for every session it currently
  has live (start on appearance, stop on removal), updates `ping` in place on each pong, and
  re-fires the existing `onSessions` callback on every RTT update — a single subscription surface,
  matching how `settings` already rides through unchanged (`hellwave-lobby-cards.md` §1). No new
  method needed on `ClientEngineAPI.Multiplayer` beyond what `SubscribeSessions` already exposes.

### 6. Sorting: EMA smoothing + bracket-stable ordering

This is the mechanism behind "sorted by ping, but in brackets, so it doesn't jump around":

- **Smooth first**: `smoothed = smoothed === null ? raw : smoothed * (1 - ALPHA) + raw * ALPHA`
  (e.g. `ALPHA = 0.3`), recomputed only when a fresh pong actually lands.
- **Then bucket into coarse brackets**, e.g.: `< 60ms`, `60–120ms`, `120–200ms`, `200–350ms`,
  `350ms+`, `unreachable` (OOB connection never got a pong, or was refused/capped). Concrete
  thresholds are an easy-to-retune constant array, not an architectural decision — see Open
  Questions.
- **Sort key is `[bracketIndex, stableSecondaryKey]`**, where the secondary key is explicitly
  *not* raw ping (that's exactly what jumps around) — e.g. the session's first-seen order in this
  lobby view, or `sessionId`. **Only a bracket-index change ever reorders two rows relative to each
  other** — jitter within a bracket never moves a row.
- "Still probing" (no pong yet) and "unreachable" (OOB connection failed outright) are distinct
  states, not conflated — see Open Questions for where each sorts.
- This sort helper belongs on `SessionDiscovery` (or a small exported pure function next to it),
  not hellwave-specific, so any mod's lobby gets it for free — the same reasoning
  `hellwave-lobby-cards.md` used for `settings`.

### 7. hellwave `MainMenu.ts` changes

- `#rebuildSessionRows` (`MainMenu.ts:334-368`) sorts `sessions` via the new shared helper before
  building rows.
- Each row shows a ping figure (exact presentation — ms number, bracket glyph, or both — is a UI
  detail to settle at implementation time against the real wireframe, not architecturally
  load-bearing).
- A session with no measurement yet shows a neutral placeholder (e.g. `--`), never `NaN`/`undefined`.

## Security: preventing this OOB channel from being abused against an active session

Directly answering the ask — each point is a concrete mechanism, not just an intention:

1. **Structural isolation from game state — and a durable rule for what's allowed to change that.**
   An OOB connection never allocates a `QSocket`, `ServerClient`, or edict, regardless of which
   query type it uses. For `PING`/`PONG` specifically (all this plan builds), the handler has *no
   reference at all* to `SV`, `Server.ts`, or any entity/game code — a fully adversarial peer
   sending arbitrary bytes on this channel cannot reach, corrupt, or desync the game simulation,
   because there is no code path from this handler into it. Future query types (§4's
   player-snapshot example) will legitimately need to *read* some game state, so "no code path
   into game state" can't stay true of the OOB channel as a whole forever — the rule that keeps the
   guarantee meaningful as more types are added is narrower and durable: **every OOB query handler
   is individually hand-authored, read-only, and scoped to already-public data** (the same
   fields already broadcast to connected clients, e.g. the scoreboard fields in §4's example) —
   **never** a generic reflective/RPC bridge that forwards attacker-controlled input into arbitrary
   game methods or mutates anything. The handler table in §2 is what makes this enforceable at
   review time: each new query type is one small, readable diff, not a capability expansion of an
   existing generic path.
2. **Shared-thread cost cap.** A listen-server host runs client and server in the *same* JS thread
   (`architecture.instructions.md`), so "doesn't touch game state" alone isn't sufficient — the
   handler must also be cheap and rate-capped so it can't starve the event loop and stall the real
   game's tick/render loop. Concrete, host-enforced caps (independent of what a modified remote
   peer actually sends): fixed 13-byte frame with reject-before-parse on any other size;
   `MIN_PING_INTERVAL_MS` per connection; `MAX_OOB_CONNECTIONS_PER_HOST`; `OOB_IDLE_TIMEOUT_MS`
   auto-close.
3. **No amplification.** A ping produces exactly one same-size pong. Nothing about this path fans
   out to other peers, other sessions, or produces a response larger than the request. A future
   variable-length response type (§4's player-snapshot sketch) would not keep this exact "same
   size" property, but must keep the *principle*: its own hard response-size cap, derived from a
   bound the engine already enforces (`SV.svs.maxclients`), not an open-ended size.
4. **Zero changes to the trusted in-game wire protocol.** `Protocol.ts`, `Server.ts`, `Client.ts`,
   and `ServerMessages.ts` are untouched by this plan. The real `clc`/`svc` command set — and the
   existing in-game `ping` console command (`Server.ts` `ALLOWED_CLIENT_COMMANDS`, unrelated to
   this feature despite the name) — gain no new attack surface.
5. **Signaling-layer caps.** `MAX_OOB_CONNECTIONS_PER_SESSION` at the master server bounds even a
   coordinated flood of `join-session { role: 'oob' }` from many distinct connections; OOB
   attachments are excluded from `getSessionPeerCounts()` and any "session looks abandoned" logic,
   so they can't be used to keep a session's bookkeeping artificially alive or otherwise confuse
   the DO.
6. **Related pre-existing gap — explicitly out of scope here.** Research for this plan found that
   *real* (non-OOB) `join-session` calls are already completely ungated today: no rate limiting
   anywhere in `handleMessage`/`handleBrowserMessage` dispatch, no public/private or room-limit
   check in `handleJoinSession` itself, and no two-phase connect/challenge gate at all — any WebRTC
   join is already a full connection attempt with an immediately-allocated client slot. This plan's
   new OOB path is the first case of "connect without a slot" in the engine, but it does not by
   itself fix the *real*-join path's lack of gating (hence items 1-5 above focus on making sure the
   *new* path can't make that pre-existing exposure worse). Fully closing it — e.g. giving real
   joins their own lightweight challenge step — is a separate, larger hardening task worth its own
   follow-up plan, not silently folded into this one.

## Master-server considerations

- The single global Durable Object (`idFromName('global')`, `index.ts:30-31`) is why the OOB
  connection's steady-state traffic bypassing it (once the WebRTC connection is actually up)
  matters as much as it does: the DO only ever sees the same lightweight `join-session`/`offer`/
  `answer`/`ice-candidate`/`leave-session` messages it already handles for real joins, at a rate
  bounded by `MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS` and how many sessions are actually visible in
  a lobby — not by continuous per-viewer polling of the DO itself (which the relay-approximation
  alternative would have required).
- No TURN configured today (only STUN, `NetworkDrivers.ts:920-923`) — an OOB connection that fails
  to connect (symmetric NAT, restrictive firewall) fails in exactly the situations a real join to
  that host would also fail. Showing "unreachable" is a useful, honest signal, not a bug to paper
  over. If TURN is ever added for real joins later, OOB connections get the same accuracy
  improvement for free, since they share the exact same connection-setup code path.

## Phasing

1. **Master server**: `role`/`isOob` threading through `join-session`/attachment/`peer-joined`,
   `MAX_OOB_CONNECTIONS_PER_SESSION` cap, peer-count exclusion. Extend
   `test/signaling-session.test.mjs`.
2. **Engine, host side**: `#OnOobPeerJoined`/`#CreateOobPeerConnection`/`'oob'` channel handler +
   all local caps (§2), with only `PING → PONG` implemented against the typed frame format.
   Extend `test/common/network-drivers.test.mjs`.
3. **Engine, viewer side**: OOB-ping lifecycle (start/stop per visible session, EMA), `/signaling`
   connection-on-lobby-open, `DiscoveredSession.ping`. Extend
   `test/client/session-discovery.test.mjs`.
4. **hellwave `MainMenu.ts`**: bracket-stable sort + ping display. Extend the existing
   `main-menu.test.mjs` suite; live-verify with two real local sessions (per this repo's standing
   practice for anything touching menu draw code or netcode) — specifically confirm gameplay in an
   *actively running* session stays smooth while it's being repeatedly probed, since that's the
   direct test of the "can't be abused to crash an active session" requirement.
5. **(Optional, separate follow-up, not this plan)** broader master-server rate limiting and a real
   challenge/two-phase gate for *real* joins (Security §6), and/or additional OOB query types (a
   player-snapshot query, server-info/rules) on top of the frame format from §4.

Land and manually verify each phase before starting the next, per this repo's established practice
for menu/UI and netcode changes.

### What actually shipped in Phase 1 (2026-07-23)

Built as designed in §1, in `master-server/src/protocol.ts` and `src/index.ts`:

- `protocol.ts` gained `SignalingRole` (`'peer' | 'oob'`) and `normalizeRole()`: absent → `'peer'`
  (every existing real-join caller omits the field and keeps joining normally), `'peer'`/`'oob'`
  pass through, anything else (wrong type or unrecognized string) → `null`, rejected by the caller
  with a protocol error — matching `normalizeSessionId`/`normalizePeerId`'s existing strictness.
- `SignalingAttachment` and `PeerMetadata` both gained `isOob`. `updateSocketAttachment`/
  `createPeerData` take it as an explicit parameter now (never inferred) — the two
  `handleCreateSession` call sites (new session, host reconnect) always pass `false` since a host
  is never OOB; `handleJoinSession` is the only caller that threads a real value through.
- `getSessionPeerCounts()` skips any attachment with `isOob: true`, so `countSessionPeers()`,
  `/list-servers`, and every peer-count broadcast are automatically correct with no per-call-site
  changes. New `countSessionOobConnections(sessionId)` mirrors it for the cap check.
- `handleJoinSession` validates `message.role` via `normalizeRole`, rejects an unrecognized role
  with `{ type: 'error', error: 'Invalid role' }`, and — for an `'oob'` join — rejects beyond
  `MAX_OOB_CONNECTIONS_PER_SESSION = 8` with `{ type: 'error', error: 'Too many out-of-band
  connections for this session' }` before ever touching the attachment/storage. Both
  `session-joined` (to the joiner) and `peer-joined` (broadcast to the rest of the session,
  including the host) now carry `isOob`.
- **No engine/browser changes in this phase, and none needed for it to be safe to ship**: nothing
  in `source/engine/network/NetworkDrivers.ts` sends `role: 'oob'` today, so this is purely
  additive, dormant plumbing until Phase 2/3 wires the engine side up to actually use it — verified
  by grepping for `role:` in `NetworkDrivers.ts` (no hits) before landing this phase.
- Tests: `test/protocol.test.mjs` gained a `normalizeRole` case (default/accept/reject, including a
  non-string input). `test/signaling-session.test.mjs` gained `'rejects an unrecognized role'` plus
  a new `'SignalingSession out-of-band (probe) joins'` describe block (4 tests: role flagged on
  both sides of the join, peer-count exclusion including a subsequent real joiner's own reported
  count, per-session cap rejection, and a disconnecting OOB peer not perturbing the real peer count
  broadcast to others) — directly exercising Security §5's peer-count-exclusion and per-session-cap
  guarantees. One existing test (`'joins an existing session and notifies other peers'`) updated
  for the new `isOob: false` field on both messages it already asserted on.
- Full suite: 45 tests passing (was 39), `npm run typecheck`/`npm run lint` both clean.

### What actually shipped in Phase 2 (2026-07-23)

Built as designed in §2, entirely inside `source/engine/network/NetworkDrivers.ts`:

- `#OnPeerJoined` now checks `!this.isHost` first (a single early return, replacing the old
  `if (this.isHost) { ... }` wrapper) and branches to a new `#OnOobPeerJoined(peerId)` when
  `message.isOob` is set — an OOB peer never reaches `NET.NewQSocket`/`this.newConnections` at all.
  Real-peer behavior is byte-for-byte unchanged; the only observable difference is that a non-host
  socket no longer prints the "Peer X joined" debug line for someone else's join (it returns before
  reaching that `Con.DPrint`), which is debug-log-only and not a behavior most systems could
  observe.
- New `oobConnections: Map<string, OobConnectionState>` (a plain field, not `#`-private, so tests
  can inspect it directly) holds `{ peerConnection, channel, lastPingAt, idleTimer }` per OOB peer
  — deliberately never a `QSocket`/`WebRTCSocketState`.
- `#OnOobPeerJoined` enforces `MAX_OOB_CONNECTIONS_PER_HOST = 16` before calling
  `#CreateOobPeerConnection`, which is where the host is always the *initiator* (same convention
  `#OnPeerJoined` already uses for a real peer): it creates a single `'oob'` data channel
  (`{ ordered: false, maxRetransmits: 0 }`, matching the plan's "fire-and-forget, a lost ping just
  waits for the next one" reasoning), creates the offer, and sends it. Its `ondatachannel` handler
  immediately closes any channel the remote peer opens instead — the host never expects an incoming
  channel here, so this is an explicit reject rather than relying on "we just never listen."
- `#HandleOobMessage` is the entire query dispatch for this pass: rejects any frame that isn't
  exactly `OOB_FRAME_LENGTH = 13` bytes before reading anything past the length check, rejects any
  type byte other than `OOB_PING = 1` (so a stray `OOB_PONG = 2` sent by a misbehaving peer is
  silently dropped, not processed), enforces `MIN_PING_INTERVAL_MS = 1000` per connection using a
  timestamp *this driver tracks itself* (`state.lastPingAt`), and otherwise echoes an `OOB_PONG`
  frame carrying the same sequence/timestamp. `#ResetOobIdleTimer` (`OOB_IDLE_TIMEOUT_MS = 30000`)
  runs on every accepted ping and auto-closes a connection that goes quiet.
- `#OnAnswer`/`#OnIceCandidate` were refactored to share a new `#FindActivePeerConnection(peerId)`
  helper that checks `oobConnections` first, falling back to the existing `QSocket`-based lookup —
  zero behavior change for real peers (the OOB map is simply empty for them), and it's the one
  place besides `#OnPeerJoined` that needed to become OOB-aware, since both messages are pure
  WebRTC signaling plumbing with no game-state involvement either way (safe to share, unlike
  anything that touches `SV`).
- `#ClosePeerConnection` (the `#OnPeerLeft` cleanup path) checks `oobConnections` first and
  delegates to a new `#CloseOobPeerConnection`/`#CloseAllOobConnections` pair; the latter is also
  called from `#ForceClose` when the host's own session socket tears down, so stopping hosting
  cleans up any still-open OOB connections instead of leaking them.
- **A real re-entrancy bug found while designing the tests, not by them failing first**: the first
  draft of `#CloseOobPeerConnection` called `state.channel?.close()`/`state.peerConnection.close()`
  *before* `this.oobConnections.delete(peerId)`. Since closing a channel/connection can
  synchronously re-fire the very `onclose`/`onconnectionstatechange` handlers that call
  `#CloseOobPeerConnection` again, this risked either an infinite loop (against a permissive mock
  or a browser that keeps firing close events) or redundant double-close calls. Fixed by deleting
  from the map *first*, so any re-entrant call sees no state and no-ops — verified by writing the
  test mocks' own `close()` methods to be realistically idempotent (guard against an
  already-`closed`/already-`'closed'`-readyState re-close) rather than leaving them naively
  permissive, which would have hidden exactly this class of bug.
- **Deviation from the plan's Testing section, found while implementing it**: no
  `RTCPeerConnection`/`RTCDataChannel`/signaling-`WebSocket` mock harness existed anywhere in this
  test file (or, as far as a search turned up, anywhere else in the suite) — the existing
  `WebRTCDriver.Init` tests only ever exercised URL construction, never a live connection. Built
  `MockRTCDataChannel`/`MockRTCPeerConnection`/`MockSignalingWebSocket` from scratch, installed via
  `globalThis.WebSocket`/`globalThis.RTCPeerConnection` in a new `withOobHostScenario` helper that
  otherwise mirrors this file's existing `withSignalingScenario`/`LoopDriver`-test registry-mocking
  pattern. Tests bypass the full `create-session`/`session-created` handshake (setting
  `driver.isHost`/`driver.sessionId` directly, since the OOB path never depends on how those got
  set) but do simulate the signaling socket already being open (`ws.readyState = 1`), since
  `#SendSignaling` gates every send on that and a real host only ever receives `peer-joined` once
  its own connection is fully up.
- **A second issue found only by running the tests, not by reasoning about the code first**: the
  first test run took ~30 seconds (matching `OOB_IDLE_TIMEOUT_MS`) and reported "asynchronous
  activity after the test ended" crashes reading `Con.DPrint` on `undefined` — every OOB connection
  created during a test left a real 30-second `setTimeout` running past the test's own cleanup,
  which then fired against an already-restored (torn-down) registry. Fixed by having
  `withOobHostScenario`'s `finally` block walk `driver.oobConnections.values()` and `clearTimeout`
  each `idleTimer` directly (a plain, non-private field, so no production code needed to change for
  this) before restoring the registry/globals. Full run dropped from ~30s to ~250ms once fixed.
- 9 new tests in a `'WebRTCDriver out-of-band (probe) connections'` describe block: no-QSocket
  guarantee, single-channel-as-initiator + offer sent, `MAX_OOB_CONNECTIONS_PER_HOST` rejection
  (including that a rejected join never even constructs a new `RTCPeerConnection`), valid
  ping-echoes-pong with exact byte fidelity, `MIN_PING_INTERVAL_MS` drop, malformed/wrong-type frame
  drop (asserted via `assert.doesNotThrow`, not just absence of a response), the `ondatachannel`
  rejection, idle-timer reset, and `peer-left` cleanup. Full suite: 1238 engine tests, 388 game
  tests, all green; `npm run typecheck`/`npx eslint` both clean (modulo the same pre-existing,
  unrelated `Items.ts` error noted in `hellwave-lobby-cards.md`).

### What actually shipped in Phase 3 (2026-07-23)

Built as designed in §3, with one real architectural correction found during implementation:

- **The plan's own open question ("does opening the lobby open one shared `/signaling`
  connection?") turned out to have the wrong shape entirely.** The master server's
  `SignalingAttachment` (Phase 1) tracks exactly *one* `(sessionId, peerId)` pair per WebSocket
  connection — reusing the driver's single `signalingWs` for multiple concurrent probes would mean
  each new `join-session` silently overwrites the previous probe's identity on the same socket,
  breaking every probe but the most recent. Fixed by giving **each probed session its own
  dedicated `/signaling` WebSocket** (`ViewerOobProbeState.ws`), opened and torn down independently
  of the driver's real `signalingWs`/`sessionId`/`isHost` fields, which a probe never touches. This
  means the true cost model is "one `/signaling` connection per *visible* lobby row," not "one for
  the whole lobby" — worth knowing when picking `MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS` (still an
  open question, §Open Questions) since it now maps directly to real WebSocket count.
- **The viewer is always the answerer.** Symmetric with `#OnPeerJoined`'s existing rule that the
  host always initiates to a new peer: the host creates the `'oob'` channel and sends the offer
  (Phase 2), so the viewer's new `#OnViewerOobOffer` mirrors the shape of the existing `#OnOffer`
  (receive offer → `setRemoteDescription` → `createAnswer` → `setLocalDescription` → send answer)
  but is scoped entirely to a `ViewerOobProbeState`, never a `QSocket` — an OOB connection can't be
  mistaken for a real connect attempt from the viewer's side either. Its own `ondatachannel` rejects
  anything but the one `'oob'` channel the host already created, mirroring Phase 2's host-side rule.
- New public API: `startSessionPing(sessionId, onPing)` (no-ops if already probing that session)
  and `stopSessionPing(sessionId)` (safe to call even if none is running). `onPing` receives a
  smoothed RTT in ms on every fresh pong, or `null` once the probe becomes unreachable (ws error/
  close, peer connection failure, or the OOB channel itself closing).
- The ping loop (`#StartViewerOobPingLoop`) sends the first `PING` the instant the channel opens,
  then every `PING_INTERVAL_MS = 4000`. `#HandleViewerOobPong` rejects a pong whose sequence number
  doesn't match the currently in-flight ping — necessary because the `'oob'` channel is
  `{ ordered: false }`, so a late reply for an *older* ping can arrive after a newer one was already
  sent; without this check a stale pong would be averaged in as if it were current. A matching pong
  folds its RTT into `smoothedRtt` via the `PING_EMA_ALPHA = 0.3` exponential moving average from
  §6 before being reported.
- **Two real bugs found while writing the tests, both latent since Phase 2 and only surfaced now
  because Phase 3 is the first code path to actually complete a full offer→answer round trip**:
  1. The test mock `MockRTCPeerConnection` never implemented `createAnswer()` — only `createOffer()`,
     since every Phase 2 (host-side) test stopped at "offer sent" and never simulated a peer
     actually answering back. The very first viewer-side test hit `peerConnection.createAnswer is
     not a function` immediately.
  2. Neither Phase 2 nor Phase 3's scenario helper installed `globalThis.RTCSessionDescription`/
     `globalThis.RTCIceCandidate` — Node has no WebRTC globals at all, and `#OnViewerOobOffer`'s
     `new RTCSessionDescription(message.offer)` threw a bare `ReferenceError`, caught by the
     method's own `try`/`catch` (so it failed quietly as "no answer sent" rather than crashing the
     test process). Phase 2 never noticed because none of its tests exercised `#OnAnswer`/
     `#OnIceCandidate` with real payloads either. Fixed by adding minimal
     `MockRTCSessionDescription`/`MockRTCIceCandidate` classes and installing them in both scenario
     helpers (host and viewer) for symmetry, even though only the viewer path exercises them today.
  Found by temporarily making the mock `Con.PrintError` actually log instead of silently swallowing
  the message — the caught-and-logged error was the concrete "aha," not guesswork.
- **A confusing full-suite hang (~120s, eventually killed) preceded both fixes above** and looked at
  first like a real infinite loop; isolating each new test individually (via
  `--test-name-pattern`) showed every test failing fast (not hanging) once run alone, which pointed
  at cross-test interference rather than a single broken test. It did not reproduce after fixing
  the two bugs above (confirmed by two clean full-file runs in a row, ~150ms each) — most likely
  some interaction between a repeatedly-thrown, repeatedly-caught error path and this file's timer
  bookkeeping, but the fix was verified by its absence rather than a fully isolated root cause;
  flagged here rather than silently assumed away.
- 8 new tests in a `'WebRTCDriver viewer-side out-of-band ping probes'` describe block: dedicated
  per-session signaling connection + correct `join-session` payload, no second connection for an
  already-probed session, answering the host's offer while rejecting any non-`'oob'` channel, EMA
  smoothing math together with stale/mismatched-sequence pong rejection (both in one test, since the
  second depends on state built up by the first), unreachable-reporting on peer-connection failure,
  and `stopSessionPing` tearing down the channel/peer-connection/socket together (plus a no-op
  check). `withOobViewerScenario`'s cleanup calls the driver's own public `stopSessionPing` for any
  probe still running at test end — unlike Phase 2's host-side scenario, no direct reach into
  private timer state was needed, since the public API is itself sufficient cleanup here.
- Full suite: 1246 engine tests (up from 1238), 388 game tests, all green; `npm run typecheck`/
  `npx eslint` both clean (modulo the same pre-existing, unrelated `Items.ts` error).

### What actually shipped in Phase 4 (2026-07-23)

Built as designed in §5-§7, across `SessionDiscovery.ts`, hellwave's `MainMenu.ts`, and their test
fixtures:

- `DiscoveredSession` gained `ping: number | null` and `pingUnreachable: boolean`. `SessionDiscovery`
  owns the whole probe lifecycle: `#syncProbes()` (called from every `'server-list'`/`'server-added'`/
  `'server-updated'` push) starts a probe for every currently-live, game-matching sessionId and stops
  any probe for a sessionId no longer in that set; `'server-removed'` and the last-subscriber
  `#disconnect()` both stop probes directly. A stale `onPing` callback firing after its probe was
  already stopped is explicitly guarded against (checked in `#onPing` against `#probedSessionIds`)
  rather than assumed away — covered by its own test.
- **A nice simplification found while implementing §6's sort, not in the original sketch**: the plan
  called for an explicit "stable secondary key" (first-seen order or sessionId) alongside the bracket
  index. Turned out to be unnecessary — `#sessionsById` is a `Map`, which never reorders an existing
  key's position on `.set()` (only brand-new keys append), so `Array.from(#sessionsById.values())` is
  already in first-seen order; `Array.prototype.sort` has been spec-guaranteed stable since ES2019.
  `#sortByPing` is therefore just `sessions.slice().sort((a, b) => bracket(a) - bracket(b))` — ties
  keep their original relative order for free, no decorator-sort pattern or extra bookkeeping needed.
- Bracket thresholds landed exactly as sketched: `<60ms`/`60-120ms`/`120-200ms`/`200-350ms`/`350ms+`
  (indices 0-4), then `5` = "still probing" (no measurement yet) and `6` = "unreachable" (a probe
  confirmed the host can't be reached) — resolving the plan's open question on that ordering: still-
  probing sorts optimistically (after every measured bracket, but ahead of confirmed-unreachable),
  so a session doesn't rank below one that's already proven dead just because its first measurement
  hasn't landed yet.
- `#getWebRTCDriver()` casts `NET.driverRegistry.get('webrtc')` rather than checking
  `instanceof WebRTCDriver` — a deliberate choice: an `instanceof` check would reject any duck-typed
  test double, forcing tests to import and subclass the real (heavy, WebRTC-dependent) driver class
  just to verify probe start/stop calls. The registry's own registration contract (`Network.ts`
  always registers `'webrtc'` as a real `WebRTCDriver`) already guarantees the cast is safe.
- hellwave `MainMenu.ts`: no new draw code, no new `SessionRowInfo` field — `#formatPing` bakes the
  ping display directly into the same `fullLabel` string the map/player-count already builds
  (`${label} [${current}/${max}] ${pingLabel}`), so the existing hover-border width calculation
  (already based on `fullLabel.length`) picks it up with zero further changes. `#formatPing` treats
  a *missing* `ping` field the same as an explicit `null` (`session.ping ?? null`) — belt-and-braces
  against a `Math.round(undefined)` → `"NaNms"` from any caller that doesn't fully populate the
  field, on top of the type system already guaranteeing `DiscoveredSession.ping` is real. Shows
  `"42ms"` when measured, `"--"` while still probing, `"N/A"` once confirmed unreachable — never a
  raw `null`/`undefined`/`NaN`. `rebuildSessionRows` does no sorting of its own; a comment notes
  `sessions` already arrives bracket-sorted from `SessionDiscovery`.
- **Every existing test with a hardcoded `DiscoveredSession`-shaped literal needed updating** (the
  same kind of fixture-shape break `hellwave-lobby-cards.md` hit when `settings` was added) — four
  files: `test/client/session-discovery.test.mjs` (4 assertions, plus its shared
  `withMockDiscoveryRegistry` helper gained a `FakeWebRTCDriver` test double — `registry.NET` didn't
  exist there before this phase at all), `test/common/client-engine-api-multiplayer.test.mjs` (1),
  hellwave's `main-menu.test.mjs` (6 label assertions gained a `" --"` suffix, since none of those
  fixtures populate ping), and the shared `MockDiscoveredSession` interface in
  `source/game/id1/test/client/fixtures.ts` (gained the two fields for accuracy — confirmed via grep
  that no `.ts` file anywhere constructs a literal against that interface directly, so widening it
  to two new required fields couldn't break id1's own typed call sites).
- New tests: `session-discovery.test.mjs` gained a `'SessionDiscovery ping probes'` block (7 tests:
  probe starts on appearance and reports through `onSessions`, never probes a different game's
  session, stops on removal, stops everything on last-unsubscribe, ignores a stale post-stop
  callback, bracket-sort ordering with a same-bracket fluctuation that doesn't reorder, and the
  still-probing/unreachable/measured three-way ordering). Hellwave's `main-menu.test.mjs` gained one
  test covering both the numeric and `"N/A"` display cases together (the `"--"` placeholder case is
  already exercised repeatedly by every other test in the file, via the label suffix).
- Full suite: 1254 engine tests (up from 1246), 389 game tests (up from 388), all green; `npm run
  typecheck`/`npx eslint` both clean (modulo the same pre-existing, unrelated `Items.ts` error).
- **Live verification**: the user tried it live against two real local sessions and confirmed it
  works end to end (ping appears, sort behaves) — satisfying the plan's own Testing-section
  requirement for manual/browser verification alongside the automated suite above.

## Testing

- **Master server**: role threading, peer-count exclusion, per-session cap rejection
  (`test/signaling-session.test.mjs`, mirroring existing `handleJoinSession`/`handlePing` test
  shapes).
- **`NetworkDrivers.ts`**: host ignores any non-`'oob'` channel label on an OOB connection, echoes
  valid 13-byte ping frames correctly, drops malformed/oversized/wrong-tag frames without throwing,
  enforces `MIN_PING_INTERVAL_MS`/`MAX_OOB_CONNECTIONS_PER_HOST`/idle timeout
  (`test/common/network-drivers.test.mjs`).
- **`SessionDiscovery`**: ping updates surface through `subscribe()`; EMA smoothing math; bracket
  assignment; sort stability across repeated small RTT fluctuations that stay within one bracket
  (`test/client/session-discovery.test.mjs`).
- **hellwave `MainMenu.ts`**: rows render in sorted order; ping placeholder for unmeasured/
  unreachable sessions; existing round/thumbnail/hostname tests still pass with the field added.
- **Live/manual verification**: host two real local sessions, confirm both show a plausible ping,
  confirm the sort order doesn't visibly jitter row-to-row across repeated measurements, and
  confirm an actively-running session's gameplay stays smooth while a probing client repeatedly
  measures it, and confirm `currentPlayers` for a session never counts an open OOB connection.

## Open questions

- Concrete numeric constants — ping interval, EMA `ALPHA`, bracket thresholds,
  `MAX_OOB_CONNECTIONS_PER_HOST`, `MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS`, `MIN_PING_INTERVAL_MS`,
  `OOB_IDLE_TIMEOUT_MS`, `MAX_OOB_CONNECTIONS_PER_SESSION` — starting values proposed inline above,
  all easy to retune later, none architectural.
  **Mostly resolved.** In the code (2026-09-21): viewer ping interval 4000 ms
  (`PING_INTERVAL_MS`), `PING_EMA_ALPHA = 0.3`, bracket thresholds 60/120/200/350 ms,
  `MAX_OOB_CONNECTIONS_PER_HOST = 16`, `MIN_PING_INTERVAL_MS = 1000`,
  `OOB_IDLE_TIMEOUT_MS = 30 s`, and `MAX_OOB_CONNECTIONS_PER_SESSION = 8` in the master server.
  **Still open: `MAX_CONCURRENT_CLIENT_OOB_CONNECTIONS` was never introduced.**
  `SessionDiscovery.#syncProbes` starts a probe for every live, game-matching session, not only
  the rows in view, and each probe holds its own `/signaling` WebSocket and WebRTC connection, so
  the client cost grows with the number of live sessions.
- Whether "still probing" (no pong yet) sorts optimistically, neutrally, or pessimistically before
  the first measurement lands, versus "unreachable" which should clearly sort last.
  **Resolved (Phase 4):** optimistic. "Still probing" is bracket 5, after every measured bracket
  but ahead of "unreachable" (bracket 6).
- Whether hellwave's UI shows a raw ms number, a bracket-only glyph, or both.
  **Resolved (Phase 4):** a raw number (`42ms`), `--` while probing, `N/A` once unreachable.
- Whether the OOB mechanism should stay hellwave-only for v1, or id1's `launch_server` page
  (`source/game/id1/client/Menu.ts:366-466`) should get the same sort/display in the same pass,
  since the mechanism is engine-generic. Recommended: land the engine-generic mechanism as
  designed above, but treat id1's UI wiring as a separate, small follow-up — mirroring how
  `DiscoveredSession.settings` landed engine-wide but only hellwave reads it today.
  **Still open as a follow-up:** as recommended, only hellwave shows ping; id1's `launch_server`
  page (now built in `#buildLaunchServerPage`, `source/game/id1/client/Menu.ts`) has no ping
  code (checked 2026-09-21).
- The pre-existing master-server hardening gap and lack of a real-join challenge/slot-gate
  (Security §6) — worth flagging as its own follow-up plan rather than silently expanding this
  one's scope.
- A player-snapshot query (names/scores/colors, echoing classic `CCREQ_PLAYER_INFO`) is the named
  future example (§4) and the one this plan's envelope/dispatch shape was explicitly checked
  against — but it, and any other classic-style query (`CCREQ_SERVER_INFO`/`CCREQ_RULE_INFO`), is
  still not committed to being built. This plan only reserves the type-byte space and keeps the
  dispatch/handler-table shape (§2) ready for it.
