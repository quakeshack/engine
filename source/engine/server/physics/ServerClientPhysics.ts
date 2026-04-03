import type { ServerEdict } from '../Edict.mjs';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { eventBus, getCommonRegistry } from '../../registry.mjs';
import {
  VELOCITY_EPSILON,
} from './Defs.ts';
import { ServerClient } from '../Client.mjs';
import { PM_TYPE } from '../../common/Pmove.ts';
import { BrushModel } from '../../common/Mod.ts';

let { Host, SV, V } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host, SV, V } = getCommonRegistry());
});

/**
 * Handles player-specific physics using the shared PmovePlayer for deterministic
 * client/server movement (Q2-style). All player movement (friction, acceleration,
 * gravity, step-slide) is done by PmovePlayer.move() so that client prediction
 * and server authoritative movement use the exact same code path.
 */
export class ServerClientPhysics {
  // =========================================================================
  // Shared PmovePlayer integration
  // =========================================================================

  /**
   * Populates SV.pmove physents with solid entities near the player.
   * Must be called before running a PmovePlayer for a client.
   * @param playerEdict Player edict (excluded from list).
   */
  _setupPhysents(playerEdict: ServerEdict): void {
    const pm = SV.pmove;
    console.assert(pm !== null, 'SV.pmove must be initialized before setting up physents');

    const activePmove = pm!;

    activePmove.clearEntities();

    for (let index = 1; index < SV.server.num_edicts; index++) {
      const edict = SV.server.edicts[index];
      if (!edict || edict.isFree() || edict === playerEdict) {
        continue;
      }

      const entity = edict.entity;
      if (!entity) {
        continue;
      }

      const solidType = entity.solid;

      if (solidType !== Defs.solid.SOLID_BSP && solidType !== Defs.solid.SOLID_BBOX && solidType !== Defs.solid.SOLID_SLIDEBOX) {
        continue;
      }

      const model = solidType === Defs.solid.SOLID_BSP && entity.modelindex
        ? SV.server.models[entity.modelindex]
        : null;

      activePmove.addEntity(entity, model instanceof BrushModel ? model : null);
    }
  }

  /**
   * Runs the shared PmovePlayer for a client, copying state in and out of
   * the entity and client objects. This replaces the old server-side
   * walkMove/airMove/waterMove/friction/accelerate code with the same
   * movement code the client uses for prediction.
   * @param ent Player edict.
   * @param client Client connection.
   */
  _runSharedPmove(ent: ServerEdict, client: ServerClient): void {
    const entity = ent.entity!;
    const pm = SV.pmove;
    console.assert(pm !== null, 'SV.pmove must be initialized before running shared pmove');

    const activePmove = pm!;

    // --- Set up physents ---
    this._setupPhysents(ent);

    // --- Create a fresh player mover ---
    const pmove = activePmove.newPlayerMove();

    // --- Copy entity state -> pmove ---
    pmove.origin.set(entity.origin);
    pmove.velocity.set(entity.velocity);
    pmove.angles.set(entity.v_angle ?? entity.angles);

    // Persistent PM state from the client connection
    pmove.oldbuttons = client.pmOldButtons;
    pmove.pmFlags = client.pmFlags;
    pmove.pmTime = client.pmTime;
    pmove.waterjumptime = entity.teleport_time > SV.server.time ? (entity.teleport_time - SV.server.time) : 0;
    pmove.dead = entity.deadflag > 0;
    pmove.spectator = false;

    // Determine PM type
    if (entity.deadflag > 0) {
      pmove.pmType = PM_TYPE.DEAD;
    } else if (entity.movetype === Defs.moveType.MOVETYPE_NOCLIP) {
      pmove.pmType = PM_TYPE.SPECTATOR;
    } else {
      pmove.pmType = PM_TYPE.NORMAL;
    }

    // On-ground from entity flags
    if (entity.flags & Defs.flags.FL_ONGROUND) {
      pmove.onground = 0; // world (generic ground)
    } else {
      pmove.onground = null; // airborne
    }

    // Water state from entity
    pmove.waterlevel = entity.waterlevel ?? 0;
    pmove.watertype = entity.watertype ?? -1;

    // Use the client’s declared msec so the server movement matches
    // what the client predicted (QW-style: host_frametime = ucmd->msec * 0.001).
    // Clamp to [1, 200] to prevent speed exploits.
    pmove.cmd.set(client.cmd);
    pmove.cmd.msec = Math.min(200, Math.max(1, client.cmd.msec));

    // --- Execute movement (split long commands like QW’s SV_RunCmd) ---
    // Use float division (/2) to match the client’s PredictUsercmd split
    // (split.msec /= 2) so both sides compute identical time steps.
    if (pmove.cmd.msec > 50) {
      const halfMsec = pmove.cmd.msec / 2;
      pmove.cmd.msec = halfMsec;
      pmove.move();
      // second half, no impulse, carry forward state
      pmove.cmd.impulse = 0;
      pmove.cmd.msec = halfMsec;
      pmove.move();
    } else {
      pmove.move();
    }

    // --- Copy results back -> entity ---
    entity.origin = entity.origin.set(pmove.origin);
    entity.velocity = entity.velocity.set(pmove.velocity);

    // Ground entity
    if (pmove.onground !== null) {
      entity.flags |= Defs.flags.FL_ONGROUND;
      if (pmove.onground > 0 && pmove.onground < activePmove.physents.length) {
        const physent = activePmove.physents[pmove.onground]!;
        const edictId = physent.edictId;

        if (edictId !== undefined && edictId !== null && edictId < SV.server.num_edicts) {
          entity.groundentity = SV.server.edicts[edictId].entity;
        } else {
          entity.groundentity = null;
        }
      } else {
        // onground === 0 means world: clear groundentity so pushMove
        // won't mistakenly think we're riding a mover from a prior frame.
        entity.groundentity = null;
      }
    } else {
      entity.flags &= ~Defs.flags.FL_ONGROUND;
      entity.groundentity = null;
    }

    // Water state
    entity.waterlevel = pmove.waterlevel;
    entity.watertype = pmove.watertype;

    // Waterjump flag sync
    if (pmove.waterjumptime > 0) {
      entity.flags |= Defs.flags.FL_WATERJUMP;
      entity.teleport_time = SV.server.time + pmove.waterjumptime;
    } else {
      entity.flags &= ~Defs.flags.FL_WATERJUMP;
    }

    // Persist PM state on client connection
    client.pmOldButtons = pmove.oldbuttons;
    client.pmFlags = pmove.pmFlags;
    client.pmTime = pmove.pmTime;

    // Touched entities - fire touch functions via SV.physics.impact
    // to match the bidirectional touch semantics used by SV_FlyMove.
    const touchedSet = new Set<number>();
    for (const index of pmove.touchindices) {
      if (index > 0 && index < activePmove.physents.length && !touchedSet.has(index)) {
        touchedSet.add(index);
        const physent = activePmove.physents[index]!;
        const edictId = physent.edictId;

        if (edictId !== undefined && edictId !== null && edictId < SV.server.num_edicts) {
          const touchEdict = SV.server.edicts[edictId];
          if (!touchEdict.isFree()) {
            SV.physics.impact(ent, touchEdict, entity.velocity.copy());
          }
        }
      }
    }
  }

  // =========================================================================
  // Visual angle helpers (server-only, not part of shared movement)
  // =========================================================================

  /**
   * Updates the ideal pitch for a client when standing on the ground.
   * @param ent Player entity.
   */
  setIdealPitch(ent: ServerEdict): void {
    if (!ent || (ent.entity!.flags & Defs.flags.FL_ONGROUND) === 0) {
      return;
    }

    const entity = ent.entity!;
    const origin = entity.origin;
    const angleval = entity.angles[1] * (Math.PI / 180.0);
    const sinval = Math.sin(angleval);
    const cosval = Math.cos(angleval);
    const top = new Vector(0.0, 0.0, origin[2] + entity.view_ofs[2]);
    const bottom = new Vector(0.0, 0.0, top[2] - 160.0);
    const z: number[] = [];

    for (let index = 0; index < 6; index++) {
      top[0] = bottom[0] = origin[0] + cosval * (index + 3) * 12.0;
      top[1] = bottom[1] = origin[1] + sinval * (index + 3) * 12.0;

      const tr = SV.collision.move(top, Vector.origin, Vector.origin, bottom, 1, ent);

      if (tr.allsolid || tr.fraction === 1.0) {
        return;
      }

      z[index] = top[2] - tr.fraction * 160.0;
    }

    let dir = 0.0;
    let steps = 0;

    for (let index = 1; index < 6; index++) {
      const step = z[index] - z[index - 1];

      if (Math.abs(step) <= VELOCITY_EPSILON) {
        continue;
      }

      if (dir !== 0.0 && Math.abs(step - dir) > VELOCITY_EPSILON) {
        return;
      }

      steps++;
      dir = step;
    }

    if (dir === 0.0) {
      entity.idealpitch = 0.0;
      return;
    }

    if (steps >= 2) {
      entity.idealpitch = -dir * SV.idealpitchscale.value;
    }
  }

  // =========================================================================
  // Client think - punchangle decay and visual angle setup
  // =========================================================================

  /**
   * Executes per-frame input processing for a client.
   * Movement is NOT done here - it runs through PmovePlayer in physicsClient.
   * This only handles punchangle decay and visual angle updates.
   * @param edict Client edict.
   * @param _client Client connection (unused, movement runs in physicsClient).
   */
  clientThink(edict: ServerEdict, _client: ServerClient): void {
    void _client;

    const entity = edict.entity!;

    if (!edict || entity.movetype === Defs.moveType.MOVETYPE_NONE) {
      return;
    }

    // Decay punch angle
    const punchangle = entity.punchangle.copy();
    let len = punchangle.normalize() - 10.0 * Host.frametime;

    if (len < 0.0) {
      len = 0.0;
    }

    entity.punchangle = punchangle.multiply(len);

    if (entity.deadflag > 0) {
      return;
    }

    // Visual angle setup (for model rendering by other players)
    const angles = entity.angles;
    const viewAngles = entity.v_angle ?? entity.angles;
    const v_angle = viewAngles.copy().add(entity.punchangle);

    angles[2] = V.CalcRoll(angles, entity.velocity) * 4.0;
    if (!entity.fixangle) {
      angles[0] = v_angle[0] / -3.0;
      angles[1] = v_angle[1];
    }

    entity.angles = angles;
  }

  // =========================================================================
  // Per-frame physics dispatch
  // =========================================================================

  /**
   * Runs per-frame physics for a player entity.
   * For MOVETYPE_WALK, uses the shared PmovePlayer for deterministic movement
   * that matches client-side prediction exactly.
   *
   * When the client runs at a higher frame rate than the server, multiple
   * move commands can arrive in a single server frame. We process each
   * queued command individually with its original msec so the server
   * movement matches the client-side prediction (QW-style).
   * @param ent Edict.
   */
  physicsClient(ent: ServerEdict): void {
    const client = ent.getClient();
    console.assert(client !== null, 'client edict must have an attached server client');

    const activeClient = client!;
    const gameAPI = SV.server.gameAPI as typeof SV.server.gameAPI & { time: number };

    if (activeClient.state < ServerClient.STATE.CONNECTED) {
      return;
    }

    gameAPI.time = SV.server.time;
    SV.server.gameAPI.PlayerPreThink(ent);
    SV.physics.checkVelocity(ent);
    const movetype = ent.entity!.movetype >> 0;
    if (movetype === Defs.moveType.MOVETYPE_TOSS || movetype === Defs.moveType.MOVETYPE_BOUNCE) {
      SV.physics.physicsToss(ent);
    } else {
      if (!SV.physics.runThink(ent)) {
        return; // thinking might have freed the edict
      }
      switch (movetype) {
        case Defs.moveType.MOVETYPE_NONE:
          break;
        case Defs.moveType.MOVETYPE_WALK:
        case Defs.moveType.MOVETYPE_NOCLIP:
          // Process every queued command individually so each command’s msec
          // and input match what the client predicted (QW-style SV_RunCmd).
          // Only run movement for commands that actually arrived.
          // When no commands are queued (packet delay / jitter), skip
          // movement entirely, client-side prediction keeps the view
          // smooth and the next packet will catch up. Running with the
          // last known cmd would add phantom movement, making the
          // remote player appear to move faster than the host.
          for (const cmd of activeClient.pendingCmds) {
            activeClient.cmd.set(cmd);
            this._runSharedPmove(ent, activeClient);
          }
          activeClient.pendingCmds.length = 0;
          break;
        case Defs.moveType.MOVETYPE_FLY:
          SV.physics.flyMove(ent, Host.frametime);
          break;
        default:
          throw new Error(`SV.Physics_Client: bad movetype ${movetype}`);
      }
    }
    SV.area.linkEdict(ent, true);
    gameAPI.time = SV.server.time;
    SV.server.gameAPI.PlayerPostThink(ent);
  }
}
