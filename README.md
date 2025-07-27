# The Quake Shack Engine

This is a modern JavaScript port of Quake 1 with some features sprinkled on top.

Added features include but not limited to:

* Dedicated server running in node.js with a console shell.
* Improved resource loading using asynchroneous code.
* Support for client-side game code.
* 32-bit texture support.
* WAD3 file support.
* Colored dynamic lighting support.
* Slightly improved console subsystem.

Yet, there is still plenty to do.

Some features on the roadmap:

* HLBSP/BSP30 support for colorful maps.
* More flexible rendering subsystem, making it easier to reuse model rendering etc.
* Better network code with client-side predicition.
* Smooth animations using lerping.

This is an educational and recreational project.
Though the vision is to provide an id tech 2 based game engine running in the browser for fun multiplayer projects.
The engine is supposed to be extensible and fun to work with. Made for boomer shooter enthusiasts.

## Documentation

There’s some documentation in `docs/`, make sure to read the `README.md` over at the game project.

### Deploying

Either you use node.js on your computer:

```sh
npm install
npm run start
```

Or you use Docker to build and start a container:

```sh
# build the Docker image
./build.sh

# start the container
docker run --rm -ti -p 3000:3000 quakeshack
```

Open http://localhost:3000/ and enjoy the game.

This repository comes with the Quake 1 shareware game assets.

### Extending and hacking

These are the important directory structures:

| Directory | Description |
| - | - |
| data/id1 | game assets like pak files etc. |
| source/game/id | game code for id1 |
| engine/client | anything client-code related |
| engine/server | anything server-code related |
| engine/common | everything used in both client and server code |
| engine/network | networking code |
| shared | code that is used in both engine and game code |


There are two main entrypoints:

| File | Description |
| - | - |
| source/engine/main-browser.mjs | launcher for a full browser session |
| source/engine/main-dedicated.mjs | launcher for a dedicated server |


## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (QuakeWorld)
