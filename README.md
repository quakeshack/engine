# QuakeShack Engine

QuakeShack is a TypeScript port of the Quake 1 engine that runs in the browser (WebGL, Web Audio) and as a dedicated server in Node.js, with plenty of features added on top. It is meant to be extensible and fun to work with, made for boomer shooter enthusiasts.

Play it in your browser at https://play.quakeshack.dev/.

This is an educational and recreational project. The vision is an id tech 2 based game engine running in the browser for fun multiplayer projects.

Work on this project is supported by LLMs. Please read [LLM.md](./LLM.md) for more on this.

## Features

Added features include, but are not limited to:

* **Platforms**: WebGL browser client, dedicated Node.js server, the browser game's server running in its own [Web Worker](./docs/server-worker.md), and path searches in a [worker](./docs/workers.md) as well.
* **Networking**: client-side prediction, peer-to-peer multiplayer over [WebRTC](./docs/webrtc.md) with invites, and game code that runs on the client as well.
* **Rendering**: 32-bit textures, colored static and dynamic lighting (`.lit` files), [PBR materials](./docs/qsmat-format.md), per-pixel lighting from deluxemaps, shadows from point lights and a top-down shadow map, smooth model animations, semi-transparent water, lava and slime, screen-space [refraction](./docs/refraction.md) of translucent liquids and glass, and game-controlled [post-process effects](./docs/post-process-effects.md) such as color grading and [color shifts](./docs/color-shifts.md).
* **Maps**: BSP2 for large maps, Quake II maps (BSP38, including collision, visibility and area portals), [BSPX lumps](./docs/bspx.md) for both formats, high-resolution lightmaps (`LMSCALE`), WAD3 textures compiled into the map, static skyboxes, and [volumetric fog](./docs/volumetric-fog.md).
* **Skeletal models**: rigged [Inter-Quake Models](./docs/skeletal-models.md) (`.iqm`), skinned on the CPU, animated by frame number like MDL, lit and shadowed like any model, with player colors on truecolor skins, tags, and attachments (an entity that follows a tag of another, such as a weapon in a hand).
* **Sprites**: animated [sprites](./docs/sprites.md) from GIF, PNG/APNG, WebP and Aseprite files next to Quake's and Half-Life's `.spr`, with blend modes, scale and origin, named sequences, Doom-style rotations and optional per-sprite settings. The same files also draw as animated HUD elements, sprite sheet regions and screen effects.
* **Game code**: a typed [contract](./docs/game-module-contract.md) between engine and game, [navigation graphs](./docs/navigation.md) that account for monster sizes, a widget-based [menu system](./docs/menu-system.md), [client-only entities](./docs/client-entities.md) such as gibs and debris, and an [event bus](./docs/events.md).
* **Tooling**: [frame profiling](./docs/frame-profiling.md) with `r_speeds` and `r_bench` for the CPU and GPU time of every part of a frame.

## Roadmap

There is still plenty to do. Some features on the roadmap:

* Loading WAD3 textures from external WAD files when a map refers to them instead of having them compiled in.
* A more flexible rendering subsystem, making it easier to reuse model rendering and the like.
* HLBSP/BSP30 support.
* Full Quake II gameplay support (MD2 models, `baseq2` game logic, monster AI and more). Loading Quake II maps is already supported.

## Quick start with Docker

The Dockerfile used in CI/CD installs dependencies with `npm ci`, builds both `dist/browser/` and `dist/dedicated/`, runs the tests in a stage of its own, and starts the compiled dedicated server in the final image.

```sh
# the game code is a submodule
git submodule update --init

# build the container image
./build.sh

# start the container
docker run --rm -ti -p 3000:3000 quakeshack:latest
```

Open http://localhost:3000/ and enjoy the game.

This repository comes with the Quake 1 shareware game assets and precomputed navigation graphs for the first episode.

## Development

The toolchain targets Node.js 24, matching the Docker image and the `engines` field in `package.json`.

Install the dependencies exactly like CI/CD does and fetch the game code:

```sh
npm ci
git submodule update --init
```

For local development you need a browser build, a dedicated build, and the dedicated server process:

```sh
# terminal 1: build the browser bundle in watch mode
npm run dev

# terminal 2: build the dedicated bundle in watch mode
npm run dedicated:dev

# terminal 3: once dist/dedicated/dedicated.mjs exists, start the server
npm run dedicated:watch
```

The dedicated server serves `dist/browser/`, the virtual Quake filesystem, and the networking endpoints. It does not compile TypeScript on the fly, so one of the dedicated build commands must run first. `npm run dedicated:watch` restarts the server whenever the dedicated bundle is rebuilt; `npm run dedicated:start` runs it once.

Open http://localhost:3000/ and enjoy hacking.

Before committing, make sure these pass. The Docker image and the Cloudflare deployment run the tests and the type check and fail on any error:

```sh
npm test            # all unit tests (test:engine, test:game, test:common, test:physics and test:renderer run a part)
npm run typecheck   # the only type check: the build strips types without checking them
npm run lint        # ESLint, fixing what it can
```

### Layout

| Directory | Description |
| - | - |
| `source/engine/client` | client code: rendering, input, audio, menus |
| `source/engine/server` | server code |
| `source/engine/common` | code used by both client and server |
| `source/engine/network` | protocols, messages and network drivers |
| `source/shared` | code used by both engine and game code |
| `source/game/id1` | the Quake game code (a submodule) |
| `source/cloudflare` | Cloudflare Worker entry point used by `wrangler.toml` |
| `data/id1` | game assets such as pak files, configs and navigation graphs |
| `docs` | engine documentation |
| `test` | engine unit tests |

The two build entry points are at the repository root: `index.html` for the browser build and `dedicated.ts` for the dedicated build. They import the launchers in `source/engine/main-browser.ts` and `source/engine/main-dedicated.ts`.

## Building and deploying

For a production build, generate both bundles before starting the server:

```sh
npm run build:production
npm run dedicated:build:production
npm run dedicated:start
```

`npm run dedicated:start` always launches the compiled bundle from `dist/dedicated/dedicated.mjs`. Development and production differ only in which build command produced it.

### Build variables

These environment variables are read at build time. The Dockerfile takes them as build arguments of the same name (`--build-arg`).

| Variable | Description |
| - | - |
| `VITE_BASE_DIR` | Base game directory used when no `-basedir` argument is given. Defaults to `id1`. |
| `VITE_GAME_DIR` | Boots straight into this game directory, mounted on top of the base directory. |
| `VITE_CDN_URL_PATTERN` | Where the browser loads game assets from, see below. Defaults to `/qfs/{filename}` on the same host. |
| `VITE_SIGNALING_URL` | Master server for WebRTC signaling and the public server list. Without it, there are no peer-to-peer sessions and no server browser. |

For example, to start from another base game:

```sh
VITE_BASE_DIR="lq1" npm run build:production
VITE_BASE_DIR="lq1" npm run dedicated:build:production
```

### Deploying to a CDN

The browser build can be served from a static web server or a CDN without the dedicated server's virtual Quake filesystem. In that case, the game assets (everything extracted from the pak files) are loaded from the URL given by `VITE_CDN_URL_PATTERN`:

```sh
VITE_CDN_URL_PATTERN="https://cdn{shard}.example.net/{gameDir}/{filename}" npm run build:production
```

`{gameDir}` can be left out if you serve only one game, such as the original game (`id1`). `{shard}` is optional too, but recommended because it speeds up fetching assets.

Upload everything in `dist/browser/` to your web server or CDN provider.

**Tip**: keep the max-age of `/index.html` as low as possible so you can quickly roll out a new version. Every other file gets a new hash with each build, which busts the cache.

### Cloudflare

`wrangler.toml` deploys the browser build as a Cloudflare Worker with static assets. Its build command, `npm run build:wrangler`, runs the type check and all tests before the production build, so a type error or failing test stops the deployment.

## Multiplayer

It's as straightforward as back in WinQuake. Start the dedicated server and type into its console:

```
maxplayers 8
coop 1
map e1m1
```

Then type into the game console in your browser:

```
connect self
```

`connect self` connects to the same web server that hosts the game. The [dedicated server documentation](./docs/dedicated.md) has more details.

A dedicated server is not required, since the game can also host a peer-to-peer session in the browser. Type these console commands:

```
maxplayers 4
listen 1
coop 1
map start
```

The `invite` command copies a link to the session to your clipboard, ready to send to your friends.

## Documentation

The [docs](./docs/README.md) directory covers the engine's architecture, file formats, the event bus, networking and more.

## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (WinQuake and QuakeWorld)
* https://github.com/id-Software/Quake-2 (Quake II)
* https://github.com/andrei-drexler/ironwail (implementation details of some new features)
* https://github.com/fte-team/fteqw (understanding the BSPX features in detail)

## License

The engine is licensed under the GNU General Public License version 2, see [LICENSE](./LICENSE). The Quake shareware assets in `data/id1/pak0.pak` are id Software's and are covered by the shareware license that came with them, not by the GPL.
