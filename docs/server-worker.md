# Server in a Web Worker

The server of a browser game (single player, or hosting) can run in its own Web Worker instead of on the
render thread. This is the design of [plans/engine-architecture-modernization.md](../plans/engine-architecture-modernization.md),
Track B. **Status: the default in the browser.** `?serverthread` in the URL keeps the server in the page's thread
instead, which is for debugging (breakpoints and the whole engine in one place) and the only way a dedicated server runs.

Everything a page does with a server works as with one in the page's thread: console variables and commands, saving
and loading, the development commands, hosting for other players over WebRTC.

## Enabling and disabling it

The worker is used unless the page is opened with `?serverthread`, for example `http://localhost:3000/?serverthread`,
or the browser has no `Worker`. The flag has no value on purpose: a parameter with a value (`?server=thread`) would
be run as a console command at startup. The controller you get is `clientStaticState.serverController`, a `WorkerServerController`
instead of an `InThreadServerController`; `registry.SV` is undefined on the page, because the server does not live there.

## Two channels, one port

The page creates a `MessageChannel`, keeps `port1` and transfers `port2` to the worker in the first message
(`ServerWorkerBoot`). Everything after that goes over that one port, told apart by an envelope:

| Plane | Envelope | What | Code |
| :--- | :--- | :--- | :--- |
| Data | `{ channel: ChannelMessage }` | The game protocol: packets of the local player, as transferred `ArrayBuffer`s | `network/ChannelDriver.ts` |
| Control | `{ control: ... }` | Requests, the state of the server, console output, events | `common/ServerWorkerProtocol.ts` |

**Data plane.** `ChannelDriver` is a network driver like the WebSocket one. The page connects to `local`
and the worker sees a new connection, exactly as a remote player would appear. `Protocol.ts` and `MSG.ts`
are untouched, `CL` and `ServerClient` do not know where their peer is. One channel carries any number of
sockets, told apart by a connection id; this is also how remote players will be relayed (a worker has no
`RTCPeerConnection`). A reliable and ordered channel needs no flow control, so a socket can always send
while it is connected.

**Control plane.** `ServerController` is the interface the client uses (`state`, `setSimulationAllowed`,
`runLocalFrame`, `start`, `announceChangelevel`, `changelevel`, `stop`, and `init` to boot it).
`WorkerServerController` implements it on the page, `ServerWorkerRuntime` answers it in the worker.

| Page to worker | Meaning |
| :--- | :--- |
| `request` `start` / `announce-changelevel` / `changelevel` / `stop` | Answered once with `response`. Requests run one after the other, in the order they were made |
| `simulation-allowed` | The menu gate, sent when it changes |
| `cvar-set` | A variable changed on the page that the server mirrors or shares |
| `command` | A line the player typed that the page does not know, with the player's name |

| Worker to page | Meaning |
| :--- | :--- |
| `ready` | The worker booted, the game module is loaded, cvars are registered. Carries every cvar and the names of all commands |
| `cvar-registered`, `cvar-changed` | A variable appeared or changed in the worker |
| `noclip-anglehack` | The server switched the view hack for a player who flies through walls |
| `session-request` | The game asked for a level change or a restart (`ServerEngineAPI.ChangeLevel`, a dead single player). Only the page can reset the client, so it runs it, see "Level changes and restarts" |
| `response` | The answer to a request: a boolean, the server's half of a savegame, the viewthing, or a host error that becomes a `HostError` on the page |
| `state` | `{ active, maxclients, mapname, paused }`, sent when it changes and always **before** the answer of the request that changed it, so a caller can read `controller.state` right after `await` |
| `print` | A console line with its level and color, printed on the page's console |
| `event` | An engine event that happened in the worker, published on the page's event bus. Only `forwardedServerEvents` cross over |
| `error` | A host error in a server frame: the server was shut down, the page shows the alert |
| `crash` | Anything else: the page handles it like a crashed engine |

## Console variables and commands

Both realms have their own `Cvar` and `Cmd` tables, and the page owns the console and the configuration file.
Whoever registers a variable owns it. `ServerController.attachConsole()` joins the two, and `Host.Init` calls it
once every variable of the page exists, right before the configuration runs:

| Registered by | Is | Where it lives |
| :--- | :--- | :--- |
| Only the worker (`sv_*`, `nav_*`, every cvar a game registers through `ServerEngineAPI`) | Server-owned | An ordinary `Cvar` on the page too (`client/ServerCvarMirror.ts`), so completion, `cvarlist`, `set`, `toggle` and `config.cfg` see it. The worker decides its value |
| Only the page (`cl_*`, `volume`, the renderer) | Client-owned | The page; it never goes over |
| Both (`developer`, `host_framerate`, `cl_rollangle`, ...) | Shared | Both; the page's value is pushed to the worker when they meet, and changes travel both ways |

Rules the sync keeps, each with a test (`test/server/server-cvar-realms.test.mjs` runs them against a real
second realm in a `worker_threads` worker):

1. A write on the page is on the same port as the packets that follow it, so server code sees it before its next frame.
2. A write by the game appears on the page without anyone asking.
3. Server variables exist on the page before the first console command; when the worker is gone they keep their
   value but become read-only.
4. Archived server variables are written to `config.cfg` by the page.
5. Read-only and cheat flags are enforced by the worker (`Cvar.GetChangeBlock`), not only by the page's copy. The worker
   answers every change with the value the variable has afterwards, so a refused change is put right on the page.

A change that came from the other side is never sent back. Cvars the worker registers after boot are reported.

**Commands.** The page registers a stand-in for every command only the worker has (`status`, `god`, `give`, `kick`,
`maxplayers`, `nav`, and what a game registered). It sends the line over, with the player's name. The worker runs it as
the console; a command that asks to forward itself as the player (`command.forward()`, which is what `god`, `give`,
`kill`, `say`, ... do when typed at a console) is run for the local player instead, which is what forwarding does
when the server shares the console. Commands both realms have (`set`, `exec`, `echo`, `listen`, `name`, `color`)
stay on the page. The list is taken at boot.

## Level changes and restarts

`changelevel` and `restart` are session commands: they reset the client, show the loading plaque and reconnect, which
only the page can do. A game reaches them through the server's own command buffer (`ServerEngineAPI.ChangeLevel`
appends `changelevel <map>`, a dead single player appends `restart`), so with the server in a worker the worker
registers both (`ServerHost.InitSessionRequestCommands`) and they send a `session-request` instead of acting. The page
answers with `ClientHost.HandleSessionRequest`, which runs its own `changelevel` and `restart` commands; the first of
those announces the change back to the worker as a request. The worker ignores them from remote players and
once a change was announced, and the page changes the level once however often it was asked in a frame. The
page's thread has the commands in the shared table, so the same game code runs them directly there.

## Saving and loading

`save` and `load` stay on the page, which owns the file, the screen and the client's half of the state. The server's
half (entities, game globals, spawn parameters, server and game cvars) is `ServerSavegame` in `server/`, behind
`ServerController.saveState()` and `restoreState()`. The file format did not change. The client's half is collected
before the server's arrives. The development commands `viewmodel`, `viewframe`, `viewnext` and `viewprev` read and
set the viewthing's model and frame through `getViewthing()` and `setViewthingFrame()`.

## Hosting for other players

A worker has no `RTCPeerConnection` (and `RTCDataChannel` can only be handed over before it opens), so the peers of
a game for several players are accepted on the page, by the same `WebRTCDriver` as ever. `client/PeerRelay.ts`
gives each of them a socket on the channel to the worker and carries the packets in both directions every 8 ms,
reliable and unreliable kept apart; to the server a relayed player is a client like any other, with the address of
the peer. A player who leaves is dropped on the server, and one the server drops (a kick, a level change that
fails, the server shutting down) is disconnected on the page. The relay also does what the server does for its own
network layer in the page's thread: it starts listening when a game for more than one player begins and stops when
it ends, following the server's state; a `listen` typed by hand stays until the server changes.

Browsers do not throttle the timers of a page with an open data channel, so the relay keeps its pace in a background tab.

## A hidden tab

A page in a background tab gets throttled timers, and a single player world would crawl at the pace of its clamped
time step. While `document.hidden` is true the page tells the server not to run the world below multiplayer capacity
(`setSimulationAllowed(false)`, the same gate a menu uses). A game for several players keeps running, because the
gate only applies to a server that could be for one player.

## When the server runs a frame

Today the server of a listen game takes its turn inside the client frame, right after the client sent its
command. The worker keeps that cadence without sharing a thread: **a server frame runs whenever something
arrives on the channel** (a command of the local player, or a new connection), and `runLocalFrame` is
a no-op. Frames that arrive while one is running, or while a request is in progress, are folded into one
more frame afterwards. A timer (`sys_ticrate`, 0.05 s) runs a frame when nothing arrived for that long and a
server is active, so remote players and an idle local one do not stall the world. Measured in a synthetic
loop, a frame driven by a command adds no latency over the server in the page's thread, while a fixed timer
adds up to a few frames (Phase 0 finding 4).

The time step of a frame is the wall-clock time since the previous one, clamped to 1 ms to 100 ms like
`Host` does, or `host_framerate`.

## The realm of the worker

A worker is its own JavaScript realm, so it has its own `Cvar` and `Cmd` tables and its own module state.
`bootstrap/createServerWorker.ts` is its composition root: it builds the realm services (console, clock,
files, network with the channel as its only driver), the server runtime on top of them (`createServerRuntime`,
the same one the page and the dedicated server use), and fills the registry that code in that realm still
reads. `ServerRealm` plays the part `Host` plays on the page: frame timing, scheduling and the cvars
(`developer`, `host_framerate`, `host_speeds`, `sys_ticrate`) the server code reads.

The worker never loads a client: `test/common/engine-boundaries.test.mjs` fails when the import closure of
`server/ServerWorker.ts` reaches client code other than the data classes the model loaders import. The
navigation worker is started from inside the server worker, with its own factory list.

## Files in the worker

The worker reads content and writes saves through the same asset layer as the page, see
[asset-layer.md](asset-layer.md): Cache Storage, Web Locks and IndexedDB are shared between realms. The
page sends the search paths and the game directory in the boot message, the worker does not search for
them itself.

## What a game sees

`ServerEngineAPI` is an instance owned by the server (`server/ServerEngineAPI.ts`), so the game in the worker
gets the instance of its own realm. See [game-module-contract.md](game-module-contract.md).

## Cost, measured

Chromium 1234 headless with software GL, E1M1, an idle player, 480x300, 20 s of frames after the map loaded; the
numbers are the shape, not the absolute values (the frames took 33 ms here, a GPU takes a third of that).

| | Server in the page's thread | Server in a worker |
| :--- | :--- | :--- |
| Command sent to reply seen, mean | 33.1 ms | 38.4 ms |
| p50 / p95 / max | 33.5 / 37.4 / 49.2 ms | 34.9 / 67.3 / 82.8 ms |
| Frames between send and reply, beyond the usual one | 0 | 0.1 on average, 1 at p95 |
| Heap after a collection: page | 94.2 MB | 43.9 MB |
| Heap: server worker (navigation worker 0.9 MB in both) | | 73.0 MB |
| Heap, all realms | 95.0 MB | 117.7 MB |

A server frame runs when the command arrives, so the reply is normally seen by the next page frame, as in the page's
thread. When the reply lands just after the page read its messages it shows one frame later; that is the p95. The
worker costs about 23 MB more in total, because the engine and the game exist twice and the world's geometry is
loaded by both sides; the textures are not (the worker loads without render data). The local player's ping reads
higher with the worker (about 300 ms against 75 ms with the frames at 33 ms): it is the round trip of the protocol's
own ping messages, which are read once per page frame, so it is two or three page frames either way; it scales with
the frame time and is a lot lower with a GPU.

## Limitations

- **Commands registered by the worker after boot** are not known to the page.
- **The worker is a second copy of the engine and game**, see the heap above.
- **The page does not notice a worker that is killed from outside** (a browser task manager); one that fails reports
  itself, as does one that throws.

## Testing

- `test/common/channel-driver.test.mjs`: the driver, in-process and over a real `MessageChannel`.
- `test/server/server-worker-runtime.test.mjs`, `server-realm.test.mjs`, `server-worker-console.test.mjs`:
  the worker side with stand-ins.
- `test/client/worker-server-controller.test.mjs`: the page side against a scripted worker.
- `test/server/server-worker-control-plane.test.mjs`: both sides over a real `MessageChannel`, with a fake
  server in the middle.
- `test/server/server-cvar-realms.test.mjs`: cvar and command sync against a second realm in a real worker thread
  (`test/server/fixtures/cvar-realm.mjs`).
- `server-cvar-sync`, `server-cvar-mirror`, `server-local-console`, `server-savegame`: the pieces on their own.
- `test/client/peer-relay.test.mjs`: the relay between a made-up WebRTC driver and a worker-side network layer.
- A real browser: serve the build and open the game, see [browser-verification.md](browser-verification.md). The relay was
  checked with two Chromium contexts against a local master server (`wrangler dev` in the master-server repo).
