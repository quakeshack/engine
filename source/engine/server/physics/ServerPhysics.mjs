import Vector from '../../../shared/Vector.mjs';
import * as Defs from '../../../shared/Defs.mjs';
import Q from '../../../shared/Q.mjs';
import { eventBus, registry } from '../../registry.mjs';
import {
  GROUND_ANGLE_THRESHOLD,
  VELOCITY_EPSILON,
  MAX_BUMP_COUNT,
  BlockedFlags,
} from './Defs.mjs';

let { Con, Host, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Host = registry.Host;
  SV = registry.SV;
});

/**
 * Handles core physics simulation, entity movement, and collision handling.
 */
export class ServerPhysics {
  constructor() {
  }

  /**
   * Convert a world-space point into local pusher space using an orthonormal basis.
   * @param {Vector} point point in world space
   * @param {Vector} origin transform origin
   * @param {number[]} basis 3x3 rotation basis from Vector.toRotationMatrix()
   * @returns {Vector} point in local space
   */
  static _transformPointToLocal(point, origin, basis) {
    const delta = point.copy().subtract(origin);
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return new Vector(
      delta.dot(forward),
      delta.dot(right),
      delta.dot(up),
    );
  }

  /**
   * Convert a local-space point back into world space using an orthonormal basis.
   * @param {Vector} point point in local space
   * @param {Vector} origin transform origin
   * @param {number[]} basis 3x3 rotation basis from Vector.toRotationMatrix()
   * @returns {Vector} point in world space
   */
  static _transformPointToWorld(point, origin, basis) {
    const forward = new Vector(basis[0], basis[1], basis[2]);
    const right = new Vector(basis[3], basis[4], basis[5]);
    const up = new Vector(basis[6], basis[7], basis[8]);

    return origin.copy()
      .add(forward.multiply(point[0]))
      .add(right.multiply(point[1]))
      .add(up.multiply(point[2]));
  }

  /**
   * Iterates all non-static entities to ensure none start inside solid space.
   */
  checkAllEnts() {
    for (let e = 1; e < SV.server.num_edicts; e++) {
      const check = SV.server.edicts[e];
      if (check.isFree()) {
        continue;
      }

      switch (check.entity.movetype) {
        case Defs.moveType.MOVETYPE_PUSH:
        case Defs.moveType.MOVETYPE_NONE:
        case Defs.moveType.MOVETYPE_NOCLIP:
          continue;
        default:
      }

      if (SV.collision.testEntityPosition(check)) {
        Con.Print('entity in invalid position\n');
      }
    }
  }

  /**
   * Clamps velocity/origin components and guards against NaN values.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to validate
   */
  checkVelocity(ent) {
    const velo = ent.entity.velocity;
    const origin = ent.entity.origin;

    for (let i = 0; i < 3; i++) {
      let component = velo[i];

      if (Q.isNaN(component)) {
        Con.Print('Got a NaN velocity on ' + ent.entity.classname + '\n');
        component = 0.0;
      }

      if (Q.isNaN(origin[i])) {
        Con.Print('Got a NaN origin on ' + ent.entity.classname + '\n');
        origin[i] = 0.0;
      }

      if (component > SV.maxvelocity.value) {
        component = SV.maxvelocity.value;
      } else if (component < -SV.maxvelocity.value) {
        component = -SV.maxvelocity.value;
      }

      velo[i] = component;
    }

    ent.entity.origin = ent.entity.origin.set(origin);
    ent.entity.velocity = ent.entity.velocity.set(velo);
  }

  /**
   * Executes pending thinks for an entity until caught up with server time.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to process
   * @returns {boolean} false if the entity was freed during thinking
   */
  runThink(ent) {
    while (true) {
      let thinktime = ent.entity.nextthink;

      if (thinktime <= 0.0 || thinktime > (SV.server.time + Host.frametime)) {
        return true;
      }

      if (thinktime < SV.server.time) {
        thinktime = SV.server.time;
      }

      ent.entity.nextthink = 0.0;
      SV.server.gameAPI.time = thinktime;
      ent.entity.think();

      if (ent.isFree()) {
        return false;
      }
    }
  }

  /**
   * Invokes touch callbacks between two entities.
   * @param {import('../Edict.mjs').ServerEdict} e1 first entity
   * @param {import('../Edict.mjs').ServerEdict} e2 second entity
   * @param {Vector} pushVector vector representing the push force
   */
  impact(e1, e2, pushVector) {
    SV.server.gameAPI.time = SV.server.time;

    const ent1 = /** @type {import('../Edict.mjs').BaseEntity} */ (e1.entity);
    const ent2 = /** @type {import('../Edict.mjs').BaseEntity} */ (e2.entity);

    if (ent1.touch && ent1.solid !== Defs.solid.SOLID_NOT) {
      ent1.touch(ent2, pushVector);
    }

    if (ent2.touch && ent2.solid !== Defs.solid.SOLID_NOT) {
      ent2.touch(ent1, pushVector);
    }
  }

  /**
   * Clips the velocity vector against a collision plane.
   * @param {Vector} vec incoming velocity
   * @param {Vector} normal collision normal
   * @param {Vector} out output velocity
   * @param {number} overbounce overbounce factor
   */
  clipVelocity(vec, normal, out, overbounce) {
    const backoff = vec.dot(normal) * overbounce;

    out[0] = vec[0] - normal[0] * backoff;
    if ((out[0] > -VELOCITY_EPSILON) && (out[0] < VELOCITY_EPSILON)) {
      out[0] = 0.0;
    }

    out[1] = vec[1] - normal[1] * backoff;
    if ((out[1] > -VELOCITY_EPSILON) && (out[1] < VELOCITY_EPSILON)) {
      out[1] = 0.0;
    }

    out[2] = vec[2] - normal[2] * backoff;
    if ((out[2] > -VELOCITY_EPSILON) && (out[2] < VELOCITY_EPSILON)) {
      out[2] = 0.0;
    }
  }

  /**
   * Performs sliding movement with up to four collision planes.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to move
   * @param {number} time frame time slice
   * @returns {{blocked: number, steptrace: import('./ServerCollision.mjs').Trace | null}} result with blocked flags and optional wall trace
   */
  flyMove(ent, time) {
    const planes = [];
    const primalVelocity = ent.entity.velocity.copy();
    let originalVelocity = primalVelocity.copy();
    const newVelocity = new Vector();
    let timeLeft = time;
    let blocked = BlockedFlags.NONE;
    let steptrace = null;

    for (let bumpCount = 0; bumpCount < MAX_BUMP_COUNT; bumpCount++) {
      if (ent.entity.velocity.isOrigin()) {
        break;
      }

      const end = ent.entity.origin.copy().add(ent.entity.velocity.copy().multiply(timeLeft));
      const trace = SV.collision.move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, 0, ent);

      if (trace.allsolid) {
        ent.entity.velocity = new Vector();
        return { blocked: BlockedFlags.BOTH, steptrace };
      }

      if (trace.fraction > 0.0) {
        ent.entity.origin = ent.entity.origin.set(trace.endpos);
        originalVelocity = ent.entity.velocity.copy();
        planes.length = 0;
        if (trace.fraction === 1.0) {
          break;
        }
      }

      console.assert(trace.ent !== null, 'trace.ent must not be null');

      if (trace.plane.normal[2] > GROUND_ANGLE_THRESHOLD) {
        blocked |= BlockedFlags.FLOOR;
        if (trace.ent.entity.solid === Defs.solid.SOLID_BSP ||
            trace.ent.entity.solid === Defs.solid.SOLID_BBOX ||
            trace.ent.entity.solid === Defs.solid.SOLID_MESH) {
          ent.entity.flags |= Defs.flags.FL_ONGROUND;
          ent.entity.groundentity = trace.ent.entity;
        }
      } else if (trace.plane.normal[2] === 0.0) {
        blocked |= BlockedFlags.WALL;
        steptrace = trace;
      }

      this.impact(ent, trace.ent, ent.entity.velocity.copy());

      if (ent.isFree()) {
        break;
      }

      timeLeft -= timeLeft * trace.fraction;

      if (planes.length >= 5) {
        ent.entity.velocity = new Vector();
        return { blocked: 3, steptrace };
      }

      planes.push(trace.plane.normal.copy());

      let i;
      let j;
      for (i = 0; i < planes.length; i++) {
        this.clipVelocity(originalVelocity, planes[i], newVelocity, 1.0);
        for (j = 0; j < planes.length; j++) {
          if (j !== i) {
            const plane = planes[j];
            if ((newVelocity[0] * plane[0] + newVelocity[1] * plane[1] + newVelocity[2] * plane[2]) < 0.0) {
              break;
            }
          }
        }
        if (j === planes.length) {
          break;
        }
      }

      if (i !== planes.length) {
        ent.entity.velocity = newVelocity.copy();
      } else {
        if (planes.length !== 2) {
          ent.entity.velocity = new Vector();
          return { blocked: 7, steptrace };
        }
        const dir = planes[0].cross(planes[1]);
        ent.entity.velocity = dir.multiply(dir.dot(ent.entity.velocity));
      }

      if (ent.entity.velocity.dot(primalVelocity) <= 0.0) {
        ent.entity.velocity = new Vector();
        return { blocked, steptrace };
      }
    }

    return { blocked, steptrace };
  }

  /**
   * Applies gravity to an entity taking custom gravity into account.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to influence
   */
  addGravity(ent) {
    const entGravity = typeof(ent.entity.gravity) === 'number' ? ent.entity.gravity : 1.0;
    const velocity = ent.entity.velocity;
    velocity[2] += entGravity * SV.gravity.value * Host.frametime * -1.0;
    ent.entity.velocity = velocity;
  }

  /**
   * Applies a small upward force used for buoyancy.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to influence
   */
  addBuoyancy(ent) {
    const velocity = ent.entity.velocity;
    velocity[2] += SV.gravity.value * Host.frametime * 0.01;
    ent.entity.velocity = velocity;
  }

  /**
   * Pushes an entity by the provided vector and performs collision handling.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to move
   * @param {Vector} pushVector movement vector
   * @returns {import('./ServerCollision.mjs').Trace} resulting trace
   */
  pushEntity(ent, pushVector) {
    const end = ent.entity.origin.copy().add(pushVector);
    const solid = ent.entity.solid;

    let nomonsters;
    if (ent.entity.movetype === Defs.moveType.MOVETYPE_FLYMISSILE) {
      nomonsters = Defs.moveTypes.MOVE_MISSILE;
    } else if (solid === Defs.solid.SOLID_TRIGGER || solid === Defs.solid.SOLID_NOT) {
      nomonsters = Defs.moveTypes.MOVE_NOMONSTERS;
    } else {
      nomonsters = Defs.moveTypes.MOVE_NORMAL;
    }

    const trace = SV.collision.move(ent.entity.origin, ent.entity.mins, ent.entity.maxs, end, nomonsters, ent);

    // CR: Only move the entity if the trace made progress. When allsolid is true,
    // the entity started and remained entirely in solid (e.g. spawned inside a wall),
    // so we keep it at its current position to prevent falling out of world.
    if (!trace.allsolid) {
      ent.entity.origin = ent.entity.origin.set(trace.endpos);
    }
    SV.area.linkEdict(ent, true);

    if (trace.ent) {
      this.impact(ent, trace.ent, pushVector);
    }

    return trace;
  }

  /**
   * Moves a pusher entity and resolves collisions with touched entities.
   * @param {import('../Edict.mjs').ServerEdict} pusher pusher entity
   * @param {number} movetime time to move
   */
  pushMove(pusher, movetime) {
    if (pusher.entity.velocity.isOrigin() && pusher.entity.avelocity.isOrigin()) {
      pusher.entity.ltime += movetime;
      return;
    }

    const move = pusher.entity.velocity.copy().multiply(movetime);
    const rotation = pusher.entity.avelocity.copy().multiply(movetime);
    const mins = pusher.entity.absmin.copy().add(move);
    const maxs = pusher.entity.absmax.copy().add(move);
    const pushorig = pusher.entity.origin.copy();
    const pushangles = pusher.entity.angles.copy();
    const pushbasis = pushangles.isOrigin() ? null : pushangles.toRotationMatrix();

    pusher.entity.origin = pusher.entity.origin.copy().add(move);
    pusher.entity.angles = pusher.entity.angles.copy().add(rotation);
    const finalbasis = pusher.entity.angles.isOrigin() ? null : pusher.entity.angles.toRotationMatrix();
    pusher.entity.ltime += movetime;
    SV.area.linkEdict(pusher);

    const moved = [];

    for (let e = 1; e < SV.server.num_edicts; e++) {
      const check = SV.server.edicts[e];
      if (check.isFree()) {
        continue;
      }

      const movetype = check.entity.movetype;
      if (movetype === Defs.moveType.MOVETYPE_PUSH || movetype === Defs.moveType.MOVETYPE_NONE || movetype === Defs.moveType.MOVETYPE_NOCLIP) {
        continue;
      }

      const wasGroundedOnPusher = (check.entity.flags & Defs.flags.FL_ONGROUND) !== 0 &&
        check.entity.groundentity !== null &&
        check.entity.groundentity.equals(pusher.entity);

      if (!wasGroundedOnPusher) {
        if (!check.entity.absmin.lt(maxs) || !check.entity.absmax.gt(mins)) {
          continue;
        }

        if (!SV.collision.testEntityPosition(check)) {
          continue;
        }
      }

      if (movetype !== Defs.moveType.MOVETYPE_WALK) {
        check.entity.flags &= ~Defs.flags.FL_ONGROUND;
      }

      const entorig = check.entity.origin.copy();
      const entangles = check.entity.angles.copy();
      moved[moved.length] = [entorig, entangles, check];
      pusher.entity.solid = Defs.solid.SOLID_NOT;

      let finalMove = move.copy();

      if (!rotation.isOrigin()) {
        const localOffset = pushbasis === null
          ? check.entity.origin.copy().subtract(pushorig)
          : ServerPhysics._transformPointToLocal(check.entity.origin, pushorig, pushbasis);
        const newPos = finalbasis === null
          ? pusher.entity.origin.copy().add(localOffset)
          : ServerPhysics._transformPointToWorld(localOffset, pusher.entity.origin, finalbasis);

        finalMove = newPos.subtract(check.entity.origin);

        check.entity.angles = check.entity.angles.copy().add(rotation);
      }

      this.pushEntity(check, finalMove);
      pusher.entity.solid = Defs.solid.SOLID_BSP;

      if (SV.collision.testEntityPosition(check)) {
        if (wasGroundedOnPusher) {
          pusher.entity.solid = Defs.solid.SOLID_NOT;
          const blockedByOtherSolid = SV.collision.testEntityPosition(check);
          pusher.entity.solid = Defs.solid.SOLID_BSP;

          if (!blockedByOtherSolid) {
            continue;
          }
        }

        const cmins = check.entity.mins;
        const cmaxs = check.entity.maxs;
        if (cmins[0] === cmaxs[0]) {
          continue;
        }
        if (check.entity.solid === Defs.solid.SOLID_NOT || check.entity.solid === Defs.solid.SOLID_TRIGGER) {
          cmins[0] = cmaxs[0] = 0.0;
          cmins[1] = cmaxs[1] = 0.0;
          cmaxs[2] = cmins[2];
          check.entity.mins = cmins;
          check.entity.maxs = cmaxs;
          continue;
        }
        check.entity.origin = entorig;
        check.entity.angles = entangles;
        SV.area.linkEdict(check, true);
        pusher.entity.origin = pusher.entity.origin.set(pushorig);
        pusher.entity.angles = pusher.entity.angles.set(pushangles);
        SV.area.linkEdict(pusher);
        pusher.entity.ltime -= movetime;
        if (pusher.entity.blocked) {
          pusher.entity.blocked(check.entity);
        }
        for (let i = 0; i < moved.length; i++) { // FIXME: rewrite
          const movedEdict = moved[i];
          movedEdict[2].entity.origin = movedEdict[0];
          movedEdict[2].entity.angles = movedEdict[1];
          SV.area.linkEdict(movedEdict[2]);
        }
        return;
      }
    }
  }

  /**
   * Applies motion to MOVETYPE_PUSH entities.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to process
   */
  physicsPusher(ent) {
    const oldltime = ent.entity.ltime;
    const thinktime = ent.entity.nextthink;
    let movetime;

    if (thinktime > 0.0 && thinktime < (oldltime + Host.frametime)) {
      movetime = Math.max(thinktime - oldltime, 0.0);
    } else {
      movetime = Host.frametime;
    }

    if (movetime > 0.0) {
      this.pushMove(ent, movetime);
    }

    if (thinktime <= oldltime || thinktime > ent.entity.ltime) {
      return;
    }

    ent.entity.nextthink = 0.0;
    SV.server.gameAPI.time = SV.server.time;
    ent.entity.think();
  }

  /**
   * Attempts to resolve a stuck player by nudging the entity around.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to fix
   */
  checkStuck(ent) {
    if (!SV.collision.testEntityPosition(ent)) {
      ent.entity.oldorigin = ent.entity.oldorigin.set(ent.entity.origin);
      return;
    }

    ent.entity.origin = ent.entity.origin.set(ent.entity.oldorigin);
    if (!SV.collision.testEntityPosition(ent)) {
      Con.DPrint('Unstuck.\n');
      SV.area.linkEdict(ent, true);
      return;
    }

    const norg = ent.entity.origin.copy();
    for (norg[2] = 0.0; norg[2] <= 17.0; norg[2]++) {
      for (norg[0] = -1.0; norg[0] <= 1.0; norg[0]++) {
        for (norg[1] = -1.0; norg[1] <= 1.0; norg[1]++) {
          ent.entity.origin = ent.entity.origin.set(norg).add(norg);
          if (!SV.collision.testEntityPosition(ent)) {
            Con.DPrint('Unstuck.\n');
            SV.area.linkEdict(ent, true);
            return;
          }
        }
      }
    }

    Con.DPrint('player is stuck.\n');
  }

  /**
   * Inspects the entity position to determine water level and type.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to inspect
   * @returns {boolean} true if entity is largely underwater
   */
  checkWater(ent) {
    const entity = ent.entity;
    const point = entity.origin.copy().add(new Vector(0.0, 0.0, entity.mins[2] + 1.0));
    entity.waterlevel = Defs.waterlevel.WATERLEVEL_NONE;
    entity.watertype = Defs.content.CONTENT_EMPTY;
    let cont = SV.collision.pointContents(point);
    if (cont > Defs.content.CONTENT_WATER) {
      return false;
    }
    entity.watertype = cont;
    entity.waterlevel = Defs.waterlevel.WATERLEVEL_FEET;
    const origin = entity.origin;
    point[2] = origin[2] + (entity.mins[2] + entity.maxs[2]) * 0.5;
    cont = SV.collision.pointContents(point);
    if (cont <= Defs.content.CONTENT_WATER) {
      entity.waterlevel = Defs.waterlevel.WATERLEVEL_WAIST;

      point[2] = origin[2] + entity.view_ofs[2];
      cont = SV.collision.pointContents(point);
      if (cont <= Defs.content.CONTENT_WATER) {
        entity.waterlevel = Defs.waterlevel.WATERLEVEL_HEAD;
      }
    }
    return entity.waterlevel > Defs.waterlevel.WATERLEVEL_FEET;
  }

  /**
   * Emits splash sounds when transitioning between water and air.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to update
   */
  checkWaterTransition(ent) {
    const cont = SV.collision.pointContents(ent.entity.origin);

    if (!ent.entity.watertype) { // just spawned here
      ent.entity.watertype = cont;
      ent.entity.waterlevel = Defs.waterlevel.WATERLEVEL_FEET;
      return;
    }

    if (cont <= Defs.content.CONTENT_WATER) {
      if (ent.entity.watertype === Defs.content.CONTENT_EMPTY) {
        SV.messages.startSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0);
      }
      ent.entity.watertype = cont;
      ent.entity.waterlevel = Defs.waterlevel.WATERLEVEL_WAIST;
      return;
    }

    if (ent.entity.watertype !== Defs.content.CONTENT_EMPTY) {
      // just walked into water
      SV.messages.startSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0);
    }

    ent.entity.watertype = Defs.content.CONTENT_EMPTY;
    ent.entity.waterlevel = cont; // CR: I’m not sure whether this is correct or should be e.g. WATERLEVEL_NONE
  }

  /**
   * Applies wall friction to prevent jittering when sliding along geometry.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to modify
   * @param {{plane: {normal: Vector}}} trace collision trace
   */
  wallFriction(ent, trace) {
    const viewAngles = ent.entity.v_angle ?? ent.entity.angles;
    const { forward } = viewAngles.angleVectors();
    const normal = trace.plane.normal;
    let d = normal.dot(forward) + 0.5;
    if (d >= 0.0) {
      return;
    }
    d += 1.0;
    const velo = ent.entity.velocity;
    velo[0] = (velo[0] - normal[0] * normal.dot(velo)) * d;
    velo[1] = (velo[1] - normal[1] * normal.dot(velo)) * d;
    ent.entity.velocity = velo;
  }

  /**
   * Attempts to unstick an entity by trying small offsets.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to adjust
   * @param {Vector} oldvel previous velocity
   * @returns {number} resulting clip flags
   */
  tryUnstick(ent, oldvel) {
    const oldorg = ent.entity.origin.copy();
    const dir = new Vector(2.0, 0.0, 0.0);
    for (let i = 0; i <= 7; i++) {
      switch (i) {
        case 1: dir[0] = 0.0; dir[1] = 2.0; break;
        case 2: dir[0] = -2.0; dir[1] = 0.0; break;
        case 3: dir[0] = 0.0; dir[1] = -2.0; break;
        case 4: dir[0] = 2.0; dir[1] = 2.0; break;
        case 5: dir[0] = -2.0; dir[1] = 2.0; break;
        case 6: dir[0] = 2.0; dir[1] = -2.0; break;
        case 7: dir[0] = -2.0; dir[1] = -2.0; break;
        default: break;
      }
      this.pushEntity(ent, dir);
      ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
      const result = this.flyMove(ent, VELOCITY_EPSILON);
      const curorg = ent.entity.origin;
      if (Math.abs(oldorg[1] - curorg[1]) > 4.0 || Math.abs(oldorg[0] - curorg[0]) > 4.0) {
        return result.blocked;
      }
      ent.entity.origin = ent.entity.origin.set(oldorg);
    }
    ent.entity.velocity = new Vector();
    return 7;
  }

  /**
   * Simulates toss/bounce style movement.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to update
   */
  physicsToss(ent) {
    if (!this.runThink(ent)) {
      return;
    }
    if ((ent.entity.flags & Defs.flags.FL_ONGROUND) !== 0) {
      return;
    }

    this.checkVelocity(ent);
    const movetype = ent.entity.movetype;
    if (movetype !== Defs.moveType.MOVETYPE_FLY && movetype !== Defs.moveType.MOVETYPE_FLYMISSILE) {
      this.addGravity(ent);
    }

    ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
    const trace = this.pushEntity(ent, ent.entity.velocity.copy().multiply(Host.frametime));

    // CR: If entity started and stayed entirely in solid (e.g. spawned inside a wall),
    // stop movement to prevent falling out of world. This commonly happens when items
    // are dropped by monsters dying near walls.
    if (trace.allsolid) {
      ent.entity.velocity = new Vector();
      ent.entity.avelocity = new Vector();
      return;
    }

    if (trace.fraction === 1.0 || ent.isFree()) {
      return;
    }

    const velocity = new Vector();
    this.clipVelocity(ent.entity.velocity, trace.plane.normal, velocity, movetype === Defs.moveType.MOVETYPE_BOUNCE ? 1.5 : 1.0);
    ent.entity.velocity = velocity;

    if (trace.plane.normal[2] > GROUND_ANGLE_THRESHOLD) {
      if (ent.entity.velocity[2] < 60.0 || movetype !== Defs.moveType.MOVETYPE_BOUNCE) {
        ent.entity.flags |= Defs.flags.FL_ONGROUND;
        ent.entity.groundentity = trace.ent.entity;
        ent.entity.velocity = new Vector();
        ent.entity.avelocity = new Vector();
      }
    }

    this.checkWaterTransition(ent);
  }

  /**
   * Handles MOVETYPE_STEP entities (most monsters).
   * @param {import('../Edict.mjs').ServerEdict} ent entity to update
   */
  physicsStep(ent) {
    const entity = ent.entity;
    if ((entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      const hitsound = (ent.entity.velocity[2] < (SV.gravity.value * -VELOCITY_EPSILON));
      this.addGravity(ent);
      this.checkVelocity(ent);
      this.flyMove(ent, Host.frametime);
      SV.area.linkEdict(ent, true);
      if ((entity.flags & Defs.flags.FL_ONGROUND) !== 0 && hitsound) {
        SV.messages.startSound(ent, 0, 'demon/dland2.wav', 255, 1.0);
      }
    }
    this.runThink(ent);
    this.checkWaterTransition(ent);
  }

  /**
   * Runs the main entity physics step for the server.
   */
  physics() {
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.startFrame();

    for (let i = 0; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];
      if (ent.isFree()) {
        continue;
      }
      // force_retouch: relink ALL entities so stationary objects re-check
      // trigger contacts (e.g. telefrag triggers).
      if (SV.server.gameAPI.force_retouch) {
        SV.area.linkEdict(ent, true);
      }
      if (ent.isClient()) {
        SV.clientPhysics.physicsClient(ent);
        continue;
      }
      switch (ent.entity.movetype) {
        case Defs.moveType.MOVETYPE_PUSH:
          this.physicsPusher(ent);
          continue;
        case Defs.moveType.MOVETYPE_NONE:
          this.runThink(ent);
          continue;
        case Defs.moveType.MOVETYPE_NOCLIP:
          this.runThink(ent);
          continue;
        case Defs.moveType.MOVETYPE_STEP:
          this.physicsStep(ent);
          continue;
        case Defs.moveType.MOVETYPE_TOSS:
        case Defs.moveType.MOVETYPE_BOUNCE:
        case Defs.moveType.MOVETYPE_FLY:
        case Defs.moveType.MOVETYPE_FLYMISSILE:
          this.physicsToss(ent);
          continue;
        default:
          throw new Error('SV.Physics: bad movetype ' + (ent.entity.movetype >> 0));
      }
    }

    if (SV.server.gameAPI.force_retouch) {
      SV.server.gameAPI.force_retouch--;
    }

    SV.server.time += Host.frametime;
  }
}
