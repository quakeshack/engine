# Dedicated Server

QuakeShack supports running as a dedicated server in a Node.js environment. A dedicated server allows you to host multiplayer games with better performance and without requiring a client GUI to be actively running.

To build and start a dedicated server for production use, run:

```sh
npm run dedicated:build:production
npm run dedicated:start
```

It will automatically execute `server.cfg` upon start.

For customizing the server settings and behaviors, you can use various console variables either directly in the console or through a configuration file.

## Server Console Variables

Here is the list of available server console variables in QuakeShack:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `coop` | `0` | Enables cooperative mode when set to `1`. |
| `deathmatch` | `0` | Enables deathmatch mode when set to `1`. |
| `edgefriction` | `2` | Friction factor applied when a player is standing on the edge of a drop. |
| `fraglimit` | `0` | Frags required by a player to end the current match. |
| `hostname` | `UNNAMED` | Descriptive name of the server. |
| `noexit` | `0` | Prevents level exits from firing when set to `1`. |
| `nomonsters` | `0` | Removes non-player monsters if set to `1`. |
| `pausable` | `1` | Set to `1` to allow players to pause the game. |
| `samelevel` | `0` | Set to `1` to stay on the same map even after it is over. |
| `skill` | `1` | Difficulty level (`0` = Easy, `1` = Normal, `2` = Hard, `3` = Nightmare). |
| `sv_accelerate` | `10` | Ground player acceleration rate. |
| `sv_aim` | `0.93` | Auto-aim tolerance factor. |
| `sv_airaccelerate` | `0.7` | Air acceleration rate. |
| `sv_cheats` | `0` | Enables cheats if set to `1`. |
| `sv_friction` | `4` | Ground friction value. |
| `sv_gravity` | `800` | World gravity value. |
| `sv_idealpitchscale` | `0.8` | Controls the scaling of the ideal pitch when auto-look/lookspring is used. |
| `sv_maplist` | *(empty)* | Comma-separated list of maps to cycle through after each map change. |
| `sv_maxspeed` | `320` | Maximum ground speed for players. |
| `sv_maxvelocity` | `2000` | Maximum allowed velocity bounds for all entities. |
| `sv_nextmap` | *(empty)* | Next map to change to. Will automatically populate with the next map in `sv_maplist` after each map change. |
| `sv_nostep` | `0` | Disables player stair stepping if set to `1`. |
| `sv_public` | `1` | Make this server publicly listed in the master server. |
| `sv_rcon_password` | *(empty)* | Password used for remote console (RCON) access. |
| `sv_spectatormaxspeed` | `500` | Maximum flight speed for spectators. |
| `sv_stopspeed` | `100` | Minimum speed limit at which player movement comes to a complete halt. |
| `sv_wateraccelerate` | `10` | Acceleration rate inside of water. |
| `sv_waterfriction` | `4` | Friction applied while in water. |
| `teamplay` | `0` | Enables team play configuration when set to `1` (game-specific rules). |
| `timelimit` | `0` | Time in minutes before a map naturally ends (`deathmatch` or `coop`) naturally ends. |

## Serverinfo

All console variables flagged as `Cvar.SERVER` are being shared with all clients.

Clients can invoke the `serverinfo` command to receive the server configuration.

Inside the client code, you have access to the `CL.cls.serverInfo` map. Also the `client.server-info.updated` event is emitted whenever any of that information changes.

## Good to know

When the dedicated server has no active clients, it will go into an eternal sleep state. No frames will be processed anymore and the main loop is halted. It will only resume when the REPL receives a command or a new connection is being established.

## Extending the game

The server game code can access console variables during the `init` phase and listen to changes using events.


