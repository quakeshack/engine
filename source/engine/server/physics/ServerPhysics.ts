import { HostError } from '../../common/Errors.ts';
import type { ServerEdict } from '../Edict.ts';
import type { CollisionTrace } from './ServerCollisionSupport.ts';

import Vector, { Quaternion } from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import Q from '../../../shared/Q.ts';
import { eventBus, getCommonRegistry } from '../../registry.ts';
import {
  GROUND_ANGLE_THRESHOLD,
  VELOCITY_EPSILON,
  MAX_BUMP_COUNT,
  BlockedFlags,
} from './Defs.ts';

interface FlyMoveResult {
  readonly blocked: number;
  readonly steptrace: CollisionTrace | null;
}

interface MovedEntityState {
  readonly origin: Vector;
  readonly angles: Vector;
  readonly edict: ServerEdict;
}

let { Con, Host, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, Host, SV } = getCommonRegistry());
});

/**
 * Handles core physics simulation, entity movement, and collision handling.
 */
export class ServerPhysics {
  /**
   * Convert a world-space point into local pusher space using an orthonormal basis.
   * @returns Point in local space.
   */
  static _transformPointToLocal(point: Vector, origin: Vector, basis: number[]): Vector {
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
   * @returns Point in world space.
   */
  static _transformPointToWorld(point: Vector, origin: Vector, basis: number[]): Vector {
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
  checkAllEnts(): void {
    for (let index = 1; index < SV.server.num_edicts; index++) {
      const check = SV.server.edicts[index];
      if (check.isFree()) {
        continue;
      }

      switch (check.entity!.movetype) {
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
   */
  checkVelocity(ent: ServerEdict): void {
    const entity = ent.entity!;
    const velo = entity.velocity;
    const origin = entity.origin;

    for (let index = 0; index < 3; index++) {
      let component = velo[index];

      if (Q.isNaN(component)) {
        Con.Print(`Got a NaN velocity on ${entity.classname}\n`);
        component = 0.0;
      }

      if (Q.isNaN(origin[index])) {
        Con.Print(`Got a NaN origin on ${entity.classname}\n`);
        origin[index] = 0.0;
      }

      if (component > SV.maxvelocity!.value) {
        component = SV.maxvelocity!.value;
      } else if (component < -SV.maxvelocity!.value) {
        component = -SV.maxvelocity!.value;
      }

      velo[index] = component;
    }

    entity.origin = entity.origin.set(origin);
    entity.velocity = entity.velocity.set(velo);
  }

  /**
   * Executes pending thinks for an entity until caught up with server time.
   * @returns False if the entity was freed during thinking.
   */
  runThink(ent: ServerEdict): boolean {
    const entity = ent.entity!;

    while (true) {
      let thinktime = entity.nextthink!;

      if (thinktime <= 0.0 || thinktime > (SV.server.time + Host.frametime)) {
        return true;
      }

      if (thinktime < SV.server.time) {
        thinktime = SV.server.time;
      }

      entity.nextthink = 0.0;
      SV.server.gameAPI!.time = thinktime;
      console.assert(entity.think instanceof Function, 'runThink: entity.think must be a function');
      entity.think!();

      if (ent.isFree()) {
        return false;
      }
    }
  }

  /**
   * Invokes touch callbacks between two entities.
   */
  impact(e1: ServerEdict, e2: ServerEdict, pushVector: Vector): void {
    SV.server.gameAPI!.time = SV.server.time;

    const ent1 = e1.entity!;
    const ent2 = e2.entity!;

    if (ent1.touch && ent1.solid !== Defs.solid.SOLID_NOT) {
      ent1.touch(ent2, pushVector);
    }

    if (ent2.touch && ent2.solid !== Defs.solid.SOLID_NOT) {
      ent2.touch(ent1, pushVector);
    }
  }

  /**
   * Clips the velocity vector against a collision plane.
   */
  clipVelocity(vec: Vector, normal: Vector, out: Vector, overbounce: number): void {
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
   * @returns Blocked flags and an optional wall trace.
   */
  flyMove(ent: ServerEdict, time: number): FlyMoveResult {
    const entity = ent.entity!;
    const planes: Vector[] = [];
    const primalVelocity = entity.velocity.copy();
    let originalVelocity = primalVelocity.copy();
    const newVelocity = new Vector();
    let timeLeft = time;
    let blocked = BlockedFlags.NONE;
    let steptrace: CollisionTrace | null = null;

    for (let bumpCount = 0; bumpCount < MAX_BUMP_COUNT; bumpCount++) {
      if (entity.velocity.isOrigin()) {
        break;
      }

      const end = entity.origin.copy().add(entity.velocity.copy().multiply(timeLeft));
      const trace = SV.collision.move(entity.origin, entity.mins, entity.maxs, end, 0, ent);

      if (trace.allsolid) {
        entity.velocity = new Vector();
        return { blocked: BlockedFlags.BOTH, steptrace };
      }

      if (trace.fraction > 0.0) {
        entity.origin = entity.origin.set(trace.endpos);
        originalVelocity = entity.velocity.copy();
        planes.length = 0;
        if (trace.fraction === 1.0) {
          break;
        }
      }

      console.assert(trace.ent !== null, 'trace.ent must not be null');
      const traceEnt = trace.ent!;

      if (trace.plane.normal[2] > GROUND_ANGLE_THRESHOLD) {
        blocked |= BlockedFlags.FLOOR;
        if (traceEnt.entity!.solid === Defs.solid.SOLID_BSP
            || traceEnt.entity!.solid === Defs.solid.SOLID_BBOX
            || traceEnt.entity!.solid === Defs.solid.SOLID_MESH) {
          entity.flags |= Defs.flags.FL_ONGROUND;
          entity.groundentity = traceEnt.entity!;
        }
      } else if (trace.plane.normal[2] === 0.0) {
        blocked |= BlockedFlags.WALL;
        steptrace = trace;
      }

      this.impact(ent, traceEnt, entity.velocity.copy());

      if (ent.isFree()) {
        break;
      }

      timeLeft -= timeLeft * trace.fraction;

      if (planes.length >= 5) {
        entity.velocity = new Vector();
        return { blocked: 3, steptrace };
      }

      planes.push(trace.plane.normal.copy());

      let planeIndex: number;
      let otherPlaneIndex: number;
      for (planeIndex = 0; planeIndex < planes.length; planeIndex++) {
        this.clipVelocity(originalVelocity, planes[planeIndex], newVelocity, 1.0);
        for (otherPlaneIndex = 0; otherPlaneIndex < planes.length; otherPlaneIndex++) {
          if (otherPlaneIndex !== planeIndex) {
            const plane = planes[otherPlaneIndex];
            if ((newVelocity[0] * plane[0] + newVelocity[1] * plane[1] + newVelocity[2] * plane[2]) < 0.0) {
              break;
            }
          }
        }
        if (otherPlaneIndex === planes.length) {
          break;
        }
      }

      if (planeIndex !== planes.length) {
        entity.velocity = newVelocity.copy();
      } else {
        if (planes.length !== 2) {
          entity.velocity = new Vector();
          return { blocked: 7, steptrace };
        }
        const dir = planes[0].cross(planes[1]);
        entity.velocity = dir.multiply(dir.dot(entity.velocity));
      }

      if (entity.velocity.dot(primalVelocity) <= 0.0) {
        entity.velocity = new Vector();
        return { blocked, steptrace };
      }
    }

    return { blocked, steptrace };
  }

  /**
   * Applies gravity to an entity taking custom gravity into account.
   */
  addGravity(ent: ServerEdict): void {
    const entity = ent.entity!;
    const entGravity = typeof entity.gravity === 'number' ? entity.gravity : 1.0;
    const velocity = entity.velocity;
    velocity[2] += entGravity * SV.gravity!.value * Host.frametime * -1.0;
    entity.velocity = velocity;
  }

  /**
   * Applies a small upward force used for buoyancy.
   */
  addBuoyancy(ent: ServerEdict): void {
    const velocity = ent.entity!.velocity;
    velocity[2] += SV.gravity!.value * Host.frametime * 0.01;
    ent.entity!.velocity = velocity;
  }

  /**
   * Pushes an entity by the provided vector and performs collision handling.
   * @returns Resulting trace.
   */
  pushEntity(ent: ServerEdict, pushVector: Vector): CollisionTrace {
    const entity = ent.entity!;
    const end = entity.origin.copy().add(pushVector);
    const solid = entity.solid;

    let nomonsters: number;
    if (entity.movetype === Defs.moveType.MOVETYPE_FLYMISSILE) {
      nomonsters = Defs.moveTypes.MOVE_MISSILE;
    } else if (solid === Defs.solid.SOLID_TRIGGER || solid === Defs.solid.SOLID_NOT) {
      nomonsters = Defs.moveTypes.MOVE_NOMONSTERS;
    } else {
      nomonsters = Defs.moveTypes.MOVE_NORMAL;
    }

    const trace = SV.collision.move(entity.origin, entity.mins, entity.maxs, end, nomonsters, ent);

    // CR: Only move the entity if the trace made progress. When allsolid is true,
    // the entity started and remained entirely in solid (e.g. spawned inside a wall),
    // so we keep it at its current position to prevent falling out of world.
    if (!trace.allsolid) {
      entity.origin = entity.origin.set(trace.endpos);
    }
    SV.area.linkEdict(ent, true);

    if (trace.ent) {
      this.impact(ent, trace.ent, pushVector);
    }

    return trace;
  }

  /**
   * Moves a pusher entity and resolves collisions with touched entities.
   */
  pushMove(pusher: ServerEdict, movetime: number): void {
    const pusherEntity = pusher.entity!;

    console.assert(pusherEntity !== null, 'pushMove: pusherEntity must not be null');
    console.assert(pusherEntity.ltime !== undefined, 'pushMove: pusherEntity.ltime must be defined');
    console.assert(typeof (pusherEntity.ltime) === 'number' && !Number.isNaN(pusherEntity.ltime), 'pushMove: pusherEntity.ltime must be a number');

    if (pusherEntity.velocity.isOrigin() && pusherEntity.avelocity.isOrigin()) {
      pusherEntity.ltime! += movetime;
      return;
    }

    const move = pusherEntity.velocity.copy().multiply(movetime);
    const rotation = pusherEntity.avelocity.copy().multiply(movetime);
    const mins = pusherEntity.absmin.copy().add(move);
    const maxs = pusherEntity.absmax.copy().add(move);
    const pushorig = pusherEntity.origin.copy();
    const pushangles = pusherEntity.angles.copy();
    const pushbasis = pushangles.isOrigin() ? null : pushangles.toRotationMatrix();

    pusherEntity.origin = pusherEntity.origin.copy().add(move);
    pusherEntity.angles = Vector.fromQuaternion(
      Quaternion.fromVector(pusherEntity.angles).multiply(Quaternion.fromVector(rotation)),
    );
    const finalbasis = pusherEntity.angles.isOrigin() ? null : pusherEntity.angles.toRotationMatrix();
    pusherEntity.ltime! += movetime;
    SV.area.linkEdict(pusher);

    const moved: MovedEntityState[] = [];

    for (let index = 1; index < SV.server.num_edicts; index++) {
      const check = SV.server.edicts[index];
      if (check.isFree()) {
        continue;
      }

      const checkEntity = check.entity!;
      const movetype = checkEntity.movetype;
      if (movetype === Defs.moveType.MOVETYPE_PUSH || movetype === Defs.moveType.MOVETYPE_NONE || movetype === Defs.moveType.MOVETYPE_NOCLIP) {
        continue;
      }

      const wasGroundedOnPusher = (checkEntity.flags & Defs.flags.FL_ONGROUND) !== 0
        && checkEntity.groundentity !== null
        && checkEntity.groundentity.equals(pusherEntity);

      if (!wasGroundedOnPusher) {
        if (!checkEntity.absmin.lt(maxs) || !checkEntity.absmax.gt(mins)) {
          continue;
        }

        if (!SV.collision.testEntityPosition(check)) {
          continue;
        }
      }

      if (movetype !== Defs.moveType.MOVETYPE_WALK) {
        checkEntity.flags &= ~Defs.flags.FL_ONGROUND;
      }

      const entorig = checkEntity.origin.copy();
      const entangles = checkEntity.angles.copy();
      moved.push({ origin: entorig, angles: entangles, edict: check });
      pusherEntity.solid = Defs.solid.SOLID_NOT;

      let finalMove = move.copy();

      if (!rotation.isOrigin()) {
        const localOffset = pushbasis === null
          ? checkEntity.origin.copy().subtract(pushorig)
          : ServerPhysics._transformPointToLocal(checkEntity.origin, pushorig, pushbasis);
        const newPos = finalbasis === null
          ? pusherEntity.origin.copy().add(localOffset)
          : ServerPhysics._transformPointToWorld(localOffset, pusherEntity.origin, finalbasis);

        finalMove = newPos.subtract(checkEntity.origin);

        checkEntity.angles = Vector.fromQuaternion(
          Quaternion.fromVector(checkEntity.angles).multiply(Quaternion.fromVector(rotation)),
        );
      }

      this.pushEntity(check, finalMove);
      pusherEntity.solid = Defs.solid.SOLID_BSP;

      if (SV.collision.testEntityPosition(check)) {
        if (wasGroundedOnPusher) {
          pusherEntity.solid = Defs.solid.SOLID_NOT;
          const blockedByOtherSolid = SV.collision.testEntityPosition(check);
          pusherEntity.solid = Defs.solid.SOLID_BSP;

          if (!blockedByOtherSolid) {
            continue;
          }
        }

        const cmins = checkEntity.mins;
        const cmaxs = checkEntity.maxs;
        if (cmins[0] === cmaxs[0]) {
          continue;
        }
        if (checkEntity.solid === Defs.solid.SOLID_NOT || checkEntity.solid === Defs.solid.SOLID_TRIGGER) {
          cmins[0] = cmaxs[0] = 0.0;
          cmins[1] = cmaxs[1] = 0.0;
          cmaxs[2] = cmins[2];
          checkEntity.mins = cmins;
          checkEntity.maxs = cmaxs;
          continue;
        }
        checkEntity.origin = entorig;
        checkEntity.angles = entangles;
        SV.area.linkEdict(check, true);
        pusherEntity.origin = pusherEntity.origin.set(pushorig);
        pusherEntity.angles = pusherEntity.angles.set(pushangles);
        SV.area.linkEdict(pusher);
        pusherEntity.ltime! -= movetime;
        if (pusherEntity.blocked) {
          pusherEntity.blocked(checkEntity);
        }
        // Undo every entity the pusher carried this call, including `check` itself (already
        // restored above; `check` is always the last entry here, matching vanilla SV_Push, which
        // walks this list back-to-front for the same reason). Order doesn't matter: each entry
        // restores its own captured origin/angles independently, and relinking one entity into
        // the area tree has no effect on any other entity's restore.
        for (const movedEdict of moved) {
          movedEdict.edict.entity!.origin = movedEdict.origin;
          movedEdict.edict.entity!.angles = movedEdict.angles;
          SV.area.linkEdict(movedEdict.edict);
        }
        return;
      }
    }
  }

  /**
   * Applies motion to MOVETYPE_PUSH entities.
   */
  physicsPusher(ent: ServerEdict): void {
    const entity = ent.entity!;
    const oldltime = entity.ltime!;
    const thinktime = entity.nextthink!;
    let movetime: number;

    if (thinktime > 0.0 && thinktime < (oldltime + Host.frametime)) {
      movetime = Math.max(thinktime - oldltime, 0.0);
    } else {
      movetime = Host.frametime;
    }

    if (movetime > 0.0) {
      this.pushMove(ent, movetime);
    }

    if (thinktime <= oldltime || thinktime > entity.ltime!) {
      return;
    }

    entity.nextthink = 0.0;
    SV.server.gameAPI!.time = SV.server.time;

    console.assert(entity.think instanceof Function, 'physicsPusher: entity.think must be a function');
    entity.think!();
  }

  /**
   * Attempts to resolve a stuck player by nudging the entity around.
   */
  checkStuck(ent: ServerEdict): void {
    const entity = ent.entity!;

    if (!SV.collision.testEntityPosition(ent)) {
      entity.oldorigin = entity.oldorigin!.set(entity.origin);
      return;
    }

    entity.origin = entity.origin.set(entity.oldorigin!);
    if (!SV.collision.testEntityPosition(ent)) {
      Con.DPrint('Unstuck.\n');
      SV.area.linkEdict(ent, true);
      return;
    }

    const norg = entity.origin.copy();
    for (norg[2] = 0.0; norg[2] <= 17.0; norg[2]++) {
      for (norg[0] = -1.0; norg[0] <= 1.0; norg[0]++) {
        for (norg[1] = -1.0; norg[1] <= 1.0; norg[1]++) {
          entity.origin = entity.origin.set(norg).add(norg);
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
   * @returns True if entity is largely underwater.
   */
  checkWater(ent: ServerEdict): boolean {
    const entity = ent.entity!;
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
   */
  checkWaterTransition(ent: ServerEdict): void {
    const entity = ent.entity!;
    const cont = SV.collision.pointContents(entity.origin);

    if (!entity.watertype) {
      entity.watertype = cont;
      entity.waterlevel = Defs.waterlevel.WATERLEVEL_FEET;
      return;
    }

    if (cont <= Defs.content.CONTENT_WATER) {
      if (entity.watertype === Defs.content.CONTENT_EMPTY) {
        SV.messages.startSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0);
      }
      entity.watertype = cont;
      entity.waterlevel = Defs.waterlevel.WATERLEVEL_WAIST;
      return;
    }

    if (entity.watertype !== Defs.content.CONTENT_EMPTY) {
      // just walked into water
      SV.messages.startSound(ent, 0, 'misc/h2ohit1.wav', 255, 1.0);
    }

    entity.watertype = Defs.content.CONTENT_EMPTY;
    entity.waterlevel = Defs.waterlevel.WATERLEVEL_NONE; // FIXME: double check if this is correct, used to be `cont` before
  }

  /**
   * Applies wall friction to prevent jittering when sliding along geometry.
   */
  wallFriction(ent: ServerEdict, trace: CollisionTrace): void {
    const entity = ent.entity!;
    const viewAngles = entity.v_angle ?? entity.angles;
    const { forward } = viewAngles.angleVectors();
    const normal = trace.plane.normal;
    let d = normal.dot(forward) + 0.5;
    if (d >= 0.0) {
      return;
    }
    d += 1.0;
    const velo = entity.velocity;
    velo[0] = (velo[0] - normal[0] * normal.dot(velo)) * d;
    velo[1] = (velo[1] - normal[1] * normal.dot(velo)) * d;
    entity.velocity = velo;
  }

  /**
   * Attempts to unstick an entity by trying small offsets.
   * @returns Resulting clip flags.
   */
  tryUnstick(ent: ServerEdict, oldvel: Vector): number {
    const entity = ent.entity!;
    const oldorg = entity.origin.copy();
    const dir = new Vector(2.0, 0.0, 0.0);
    for (let index = 0; index <= 7; index++) {
      switch (index) {
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
      entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
      const result = this.flyMove(ent, VELOCITY_EPSILON);
      const curorg = entity.origin;
      if (Math.abs(oldorg[1] - curorg[1]) > 4.0 || Math.abs(oldorg[0] - curorg[0]) > 4.0) {
        return result.blocked;
      }
      entity.origin = entity.origin.set(oldorg);
    }
    entity.velocity = new Vector();
    return 7;
  }

  /**
   * Simulates toss/bounce style movement.
   */
  physicsToss(ent: ServerEdict): void {
    const entity = ent.entity!;

    if (!this.runThink(ent)) {
      return;
    }
    if ((entity.flags & Defs.flags.FL_ONGROUND) !== 0) {
      return;
    }

    this.checkVelocity(ent);
    const movetype = entity.movetype;
    if (movetype !== Defs.moveType.MOVETYPE_FLY && movetype !== Defs.moveType.MOVETYPE_FLYMISSILE) {
      this.addGravity(ent);
    }

    if (!entity.avelocity.isOrigin()) {
      const angularStep = entity.avelocity.copy().multiply(Host.frametime);
      entity.angles = Vector.fromQuaternion(
        Quaternion.fromVector(entity.angles).multiply(Quaternion.fromVector(angularStep)),
      );
    }

    const trace = this.pushEntity(ent, entity.velocity.copy().multiply(Host.frametime));

    // CR: If entity started and stayed entirely in solid (e.g. spawned inside a wall),
    // stop movement to prevent falling out of world. This commonly happens when items
    // are dropped by monsters dying near walls.
    if (trace.allsolid) {
      entity.velocity = new Vector();
      entity.avelocity = new Vector();
      return;
    }

    if (trace.fraction === 1.0 || ent.isFree()) {
      return;
    }

    const velocity = new Vector();
    this.clipVelocity(entity.velocity, trace.plane.normal, velocity, movetype === Defs.moveType.MOVETYPE_BOUNCE ? 1.5 : 1.0);
    entity.velocity = velocity;

    if (trace.plane.normal[2] > GROUND_ANGLE_THRESHOLD) {
      if (entity.velocity[2] < 60.0 || movetype !== Defs.moveType.MOVETYPE_BOUNCE) {
        console.assert(trace.ent !== null, 'grounding toss trace must resolve a hit entity');
        entity.flags |= Defs.flags.FL_ONGROUND;
        entity.groundentity = trace.ent!.entity!;
        entity.velocity = new Vector();
        entity.avelocity = new Vector();
      }
    }

    this.checkWaterTransition(ent);
  }

  /**
   * Handles MOVETYPE_STEP entities (most monsters).
   */
  physicsStep(ent: ServerEdict): void {
    const entity = ent.entity!;
    if ((entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      const hitsound = entity.velocity[2] < (SV.gravity!.value * -VELOCITY_EPSILON);
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
  physics(): void {
    console.assert(SV.server.gameAPI !== null, 'physics: gameAPI must not be null');
    SV.server.gameAPI!.time = SV.server.time;
    SV.server.gameAPI!.startFrame();

    for (let index = 0; index < SV.server.num_edicts; index++) {
      const ent = SV.server.edicts[index];
      if (ent.isFree()) {
        continue;
      }
      // force_retouch: relink ALL entities so stationary objects re-check
      // trigger contacts (e.g. telefrag triggers).
      if (SV.server.gameAPI!.force_retouch) {
        SV.area.linkEdict(ent, true);
      }
      if (ent.isClient()) {
        SV.clientPhysics.physicsClient(ent);
        continue;
      }
      switch (ent.entity!.movetype) {
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
          throw new HostError(`SV.Physics: bad movetype ${ent.entity!.movetype >> 0}`);
      }
    }

    if (SV.server.gameAPI!.force_retouch) {
      SV.server.gameAPI!.force_retouch--;
    }

    SV.server.time += Host.frametime;
  }
}
