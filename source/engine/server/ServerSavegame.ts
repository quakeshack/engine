import type { ServerSaveResult, ServerSaveState } from '../common/ServerController.ts';
import type { ServerGameInterface } from '../../shared/GameInterfaces.ts';
import type Server from './Server.ts';
import type { ServerEdict } from './Edict.ts';

import { SerializableEntity } from '../../shared/GameInterfaces.ts';
import Cvar from '../common/Cvar.ts';
import * as Def from '../common/Def.ts';
import { HostError } from '../common/Errors.ts';
import { ServerClient } from './Client.ts';

/**
 * The server's half of saving and loading a game: the entities, the game's globals, the spawn
 * parameters and the cvars of server and game. The other half, what the client knows, is written
 * next to it by whoever owns the player's screen, see `Host.Savegame_f`.
 */
export default class ServerSavegame {
  /**
   * Collects the state of the running single player game.
   * @param sv The server to save.
   * @returns The state, or why this game cannot be saved.
   */
  static capture(sv: Server): ServerSaveResult {
    if (!sv.server.active) {
      return { ok: false, reason: 'Not playing a local game.' };
    }

    if (sv.svs.maxclients !== 1) {
      return { ok: false, reason: 'Can\'t save multiplayer games.' };
    }

    const client = sv.svs.clients[0];
    const clientEntity = client.edict.entity;
    console.assert(clientEntity !== null, 'savegame requires a connected player entity');

    if (clientEntity === null) {
      return { ok: false, reason: 'There is no player to save.' };
    }

    if (client.state >= ServerClient.STATE.CONNECTED && clientEntity.health <= 0.0) {
      return { ok: false, reason: 'Can\'t savegame with a dead player' };
    }

    const { gameAPI, gameVersion, mapname } = sv.server;

    console.assert(gameAPI !== null, 'savegame requires a loaded game API');
    console.assert(gameVersion !== null, 'savegame requires a loaded game version');
    console.assert(mapname !== null, 'savegame requires an active map name');

    if (gameAPI === null || gameVersion === null || mapname === null) {
      return { ok: false, reason: 'The game is not loaded.' };
    }

    // IDEA: we could actually compress this by using a list of common fields.
    const edicts: ServerSaveState['edicts'] = [];

    for (const edict of sv.server.edicts) {
      const entity = edict.entity;

      edicts.push(edict.isFree() || entity === null || !(entity instanceof SerializableEntity)
        ? null
        : [entity.classname, entity.serialize()]);
    }

    return {
      ok: true,
      state: {
        version: Def.gamestateVersion,
        gameversion: gameVersion,
        spawn_parms: client.spawn_parms,
        mapname,
        time: sv.server.time,
        lightstyles: sv.server.lightstyles,
        globals: gameAPI.serialize(),
        cvars: [...Cvar.Filter((cvar) => (cvar.flags & (Cvar.FLAG.SERVER | Cvar.FLAG.GAME)) !== 0)].map((cvar) => [cvar.name, cvar.string]),
        edicts,
        num_edicts: sv.server.num_edicts,
      },
    };
  }

  /**
   * Starts the map of a savegame and puts the saved state back.
   * @param sv The server to load into.
   * @param state The server's half of the savegame.
   * @param source Where the savegame came from, named in errors.
   * @throws HostError when the map cannot be spawned or the savegame does not fit the game.
   */
  static async restore(sv: Server, state: ServerSaveState, source: string): Promise<void> {
    // Restore all server and game cvars.
    for (const [name, value] of state.cvars) {
      const cvar = Cvar.FindVar(name);

      if (cvar !== null) {
        cvar.set(value);
        continue;
      }

      sv.con.PrintWarning(`Saved cvar ${name} not found, skipping\n`);
    }

    if (!await sv.SpawnServer(state.mapname)) {
      sv.ShutdownServer(false);
      throw new HostError(`Couldn't load map ${state.mapname} for save game ${source}\n`);
    }

    if (state.gameversion !== sv.server.gameVersion) {
      sv.ShutdownServer(false);
      throw new HostError(`Game is version ${state.gameversion}, not ${sv.server.gameVersion}\n`);
    }

    sv.server.paused = false;
    sv.server.loadgame = true;

    sv.server.lightstyles = state.lightstyles;
    const gameAPI = sv.server.gameAPI;
    console.assert(gameAPI !== null, 'loadgame requires a live server game API');

    if (gameAPI === null) {
      return;
    }

    if (state.num_edicts > state.edicts.length) {
      throw new HostError(`Savegame ${source} has ${state.num_edicts} active edicts but only ${state.edicts.length} saved edict records.`);
    }

    if (state.edicts.length > sv.server.edicts.length) {
      throw new HostError(`Savegame ${source} needs ${state.edicts.length} edicts but the server only allocated ${sv.server.edicts.length}.`);
    }

    sv.server.num_edicts = state.num_edicts;

    ServerSavegame.#applyEdicts(sv.server.edicts, state.edicts, gameAPI);
    gameAPI.deserialize(state.globals);

    sv.server.time = state.time;

    sv.svs.clients[0].spawn_parms = state.spawn_parms;
  }

  /**
   * Restores saved edicts in two passes so entity references resolve after all entity instances have been created.
   */
  static #applyEdicts(
    edicts: ServerEdict[],
    savedEdicts: ServerSaveState['edicts'],
    gameAPI: Pick<ServerGameInterface, 'prepareEntity'>,
  ): void {
    for (let index = 0; index < edicts.length; index++) {
      const edict = edicts[index];
      const savedEdict = savedEdicts[index];

      if (savedEdict === undefined || savedEdict === null) {
        edict.freeEdict();
        continue;
      }

      const [classname] = savedEdict;
      console.assert(gameAPI.prepareEntity(edict, classname), 'no entity for classname');
    }

    for (let index = 0; index < edicts.length; index++) {
      const edict = edicts[index];
      const savedEdict = savedEdicts[index];

      if (edict.isFree() || savedEdict === undefined || savedEdict === null) {
        continue;
      }

      const [, entityData] = savedEdict;
      const entity = edict.entity;
      console.assert(entity instanceof SerializableEntity, 'loaded edict entity must support serialization');

      if (!(entity instanceof SerializableEntity)) {
        continue;
      }

      entity.deserialize(entityData);
      edict.linkEdict();
    }
  }
}
