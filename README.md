# QuakeShack Engine

This is a modern TypeScript port of Quake 1 with some features sprinkled on top.

Added features include, but are not limited to:

* **Modern Environments**: Dedicated Node.js server, WebGL-based browser client, multithreading, and optimized networking.
* **Enhanced Visuals**: 32-bit textures, WAD3 support, colored static and dynamic lighting (`.lit` files), [PBR materials](./docs/qsmat-format.md), smooth model animations, and semi-transparent water/lava/slime surfaces.
* **Advanced Map Features**: BSP2 format for large maps, high-resolution lightmaps (`LMSCALE`), static skyboxes, and [volumetric fog](./docs/volumetric-fog.md).
* **Modern Geometry Details**: Limited BSPX lump support (including per-pixel lighting from `LIGHTINGDIR`, dynamic lighting through `LIGHTGRID_OCTREE`, etc.).
* **Multiplayer Enhancements**: Built-in peer-to-peer multiplayer using [WebRTC](./docs/webrtc.md) and client-side game code.
* **Gameplay & Audio**: Navigation meshes for smarter NPCs and area portals for dynamic sound and culling.

For more detailed information over the engine architecture, features, and implementations, please refer to the [comprehensive documentation](./docs/README.md).

Yet, there is still plenty to do.

Some features on the roadmap:

* Proper WAD3 support when maps refer them, loading them from external WAD, if not compiled in.
* Better network code with client-side prediction.
* More flexible rendering subsystem, making it easier to reuse model rendering etc.
* HLBSP/BSP30 support.
* Quake 2 support (BSP38, md2, etc.)

This is an educational and recreational project.
Though the vision is to provide an id tech 2 based game engine running in the browser for fun multiplayer projects.
The engine is supposed to be extensible and fun to work with. Made for boomer shooter enthusiasts.

Work on this project is supported by LLMs. Please read [LLM.md](./LLM.md) for more information on this matter.

## Documentation

QuakeShack provides a detailed set of documentation files within the [docs](./docs/README.md) directory. Ensure to read them to understand the structure of the engine, the format specifications, event bus use cases, networking implementations, and more.

### Turn-key ready build and deploy

The Dockerfile used in CI/CD installs dependencies with `npm ci`, builds both `dist/browser/` and `dist/dedicated/`, runs tests in a dedicated stage, and starts the compiled dedicated server in the final image.

You can reproduce that locally with Docker:

```sh
# make sure that the game repo is also cloned
git submodule update --init

# build the container image
./build.sh

# start the container
docker run --rm -ti -p 3000:3000 quakeshack:latest
```

Open http://localhost:3000/ and enjoy the game.

This repository comes with the Quake 1 shareware game assets and computed navigation graphs for the first episode.

### Development environment

The current toolchain targets Node.js 24, matching the Docker image and the `engines` field in `package.json`.

Firstly, install the dependencies and tools exactly like CI/CD does:

```sh
npm ci
```

Also, make sure that the game repo is cloned:

```sh
git submodule update --init
```

For local development you need a browser build, a dedicated build, and the actual dedicated server process:

```sh
# terminal 1: build the browser bundle in watch mode
npm run dev

# terminal 2: build the dedicated bundle in watch mode
npm run dedicated:dev

# terminal 3: once dist/dedicated/dedicated.mjs exists, start the server
npm run dedicated:start
```

`npm run dedicated:start` serves `dist/browser/`, the virtual Quake filesystem, and the networking endpoints. It does not compile TypeScript on the fly, so one of the dedicated build commands must run first.

Open http://localhost:3000/ and enjoy hacking.

### Production environment

For a production build, generate both the browser and dedicated bundles before starting the server:

```sh
npm run build:production
npm run dedicated:build:production
npm run dedicated:start
```

`npm run dedicated:start` always launches the compiled bundle from `dist/dedicated/dedicated.mjs`. The difference between development and production is which build command produced that bundle.

You can override the default base game directory at build time when you want the engine to start from something other than `id1`:

```sh
VITE_BASE_DIR="lq1" npm run build:production
VITE_BASE_DIR="lq1" npm run dedicated:build:production
```

This replaces the fallback used when no `-basedir` argument is supplied. `VITE_GAME_DIR` still remains the hard single-game override for builds that should boot straight into one game directory.

When both variables are set, the engine mounts `VITE_BASE_DIR` first and then mounts `VITE_GAME_DIR` as the active game directory on top of it.

The same variables are wired through the Dockerfile, so container builds can pass them as Docker build arguments as well.

### Deploy to a CDN

You can deploy the built frontend code to a CDN such as Cloudflare and skip the virtual Quake filesystem by providing the URL where to get the game assets (basically everything extracted from the pak files) from.

You can set a custom URL to serve the assets like this:

```sh
VITE_CDN_URL_PATTERN="https://cdn{shard}.example.net/{gameDir}/{filename}"
```

When building through Docker or CI/CD, pass `VITE_CDN_URL_PATTERN` and `VITE_SIGNALING_URL` as `--build-arg` values with the same names.

However, it’s not necessary to provide a different URL, per default it will try to load files from `/qfs/{filename}`. You can skip the `{gameDir}` part, if you only want to serve one mod or the original game (`id1`).

Also `{shard}` is not required, but highly recommended to speed up fetching assets.

Next run `npm run build:production` to build for production.

In `dist/browser/` you’ll have everything you need to upload to your static web server or CDN provider.

**Tip**: Make sure to set the max-age as low as possible for `/index.html` so you can quickly rollout a new version. Each update will produce a different hash for cache busting.

### Launching a multiplayer session

It’s straight forward like back in WinQuake, start the dedicated server and type in:

```
maxplayers 8
coop 1
map e1m1
```

In your browser’s game console you can type in:

```
connect self
```

The `connect self` command will connect to the same webserver hosting the game frontend.

Check the [dedicated server documentation](./docs/dedicated.md) for more details.

However, there’s no need for a dedicated server as the game can also establish a peer-to-peer session.

You can start a P2P game session by typing in the following console commands:

```
maxplayers 4
listen 1
coop 1
map start
```

Using the `invite` command will allow you to invite friends.


### Extending and hacking

These are the important directory structures:

| Directory | Description |
| - | - |
| data/id1 | game assets like pak files etc. |
| source/game/id1 | game code for id1 |
| source/engine/client | anything client-code related |
| source/engine/server | anything server-code related |
| source/engine/common | everything used in both client and server code |
| source/engine/network | networking code |
| source/cloudflare | Cloudflare Worker entrypoint used by `wrangler.toml` |
| source/shared | code that is used in both engine and game code |


There are two build entrypoints at the repository root:

| File | Description |
| - | - |
| index.html | browser build entrypoint; imports `source/engine/main-browser.ts` |
| dedicated.ts | dedicated build entrypoint; imports `source/engine/main-dedicated.ts` |

The engine launchers themselves live in `source/engine/main-browser.ts` and `source/engine/main-dedicated.ts`.

## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (QuakeWorld)
* https://github.com/id-Software/Quake-2 (Quake 2)
* https://github.com/andrei-drexler/ironwail (implementation details of some new features)
* https://github.com/fte-team/fteqw (understanding the BSPX features in detail)
