# The Quake Shack Engine

This is a modern TypeScript port of Quake 1 with some features sprinkled on top.

Added features include, but are not limited to:

* **Modern Environments**: Dedicated Node.js server, WebGL-based browser client, multithreading, and optimized networking.
* **Enhanced Visuals**: 32-bit textures, WAD3 support, colored static and dynamic lighting (`.lit` files), [PBR materials](./docs/qsmat-format.md), and smooth model animations.
* **Advanced Map Features**: BSP2 format for large maps, high-resolution lightmaps (`LMSCALE`), static skyboxes, and [volumetric fog](./docs/volumetric-fog.md).
* **Modern Geometry Details**: Limited BSPX lump support (including per-pixel lighting from `LIGHTINGDIR`, dynamic lighting through `LIGHTGRID_OCTREE`, etc.).
* **Multiplayer Enhancements**: Built-in peer-to-peer multiplayer using [WebRTC](./docs/webrtc.md) and client-side game code.
* **Gameplay & Audio**: Navigation meshes for smarter NPCs and area portals for dynamic sound and culling.

For more detailed information over the engine architecture, features, and implementations, please refer to the [comprehensive documentation](./docs/README.md).

Yet, there is still plenty to do.

Some features on the roadmap:

* Semi-transparent turbulent (water, lava, slime) support.
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

Use Docker to build and start a container:

```sh
# make sure that the game repo is also cloned
git submodule update --init

# build the container image
./build.sh

# start the container
docker run --rm -ti -p 3000:3000 quakeshack
```

Open http://localhost:3000/ and enjoy the game.

This repository comes with the Quake 1 shareware game assets and computed navigation graphs for the first episode.

### Development environment

Firstly, you need to install the dependencies and tools (eslint, vite):

```sh
npm install
```

Also, make sure that the game repo is cloned:

```sh
git submodule update --init
```

Next, you need to start both the dedicated server and vite watcher like so:

```sh
# start vite in development mode in the background
npm run dev &

# start the dedicated server to serve both the virtual Quake filesystem and whatever vite is building for you
npm run dedicated:start
```

Open http://localhost:3000/ and enjoy hacking.

### Production environment

The dedicated server can be started using `npm run dedicated:start`, but this will run with many `console.assert(…)` in hot paths and is only really suitable for development work.

That’s why you should compile the dedicated server with `npm run dedicated:build:production` and start it using `npm run dedicated:start`.

### Deploy to a CDN

You can deploy the built frontend code to a CDN such as Cloudflare and skip the virtual Quake filesystem by providing the URL where to get the game assets (basically everything extracted from the pak files) from.

You can set a custom URL to serve the assets like this:

```sh
VITE_CDN_URL_PATTERN="https://cdn{shard}.example.net/{gameDir}/{filename}"
```

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
| source/shared | code that is used in both engine and game code |


There are two main entrypoints:

| File | Description |
| - | - |
| source/engine/main-browser.ts | launcher for a full browser session |
| source/engine/main-dedicated.ts | launcher for a dedicated server |

## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (QuakeWorld)
* https://github.com/id-Software/Quake-2 (Quake 2)
* https://github.com/andrei-drexler/ironwail (implementation details of some new features)
* https://github.com/fte-team/fteqw (understanding the BSPX features in detail)
