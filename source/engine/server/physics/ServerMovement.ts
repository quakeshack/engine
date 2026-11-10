import type { ServerEdict as ReadonlyServerEdict } from '../../../shared/GameInterfaces.ts';
import type { BaseEntity, ServerEdict } from '../Edict.ts';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { STEPSIZE } from '../../common/Pmove.ts';
import type Server from '../Server.ts';
import { GroundSupport, type GroundProbe } from './GroundSupport.ts';
import type { CollisionTrace } from './ServerCollisionSupport.ts';

interface EdictReferenceLike {
  readonly edict?: ReadonlyServerEdict | null;
}

/**
 * The live world under a monster for {@link GroundSupport}: line traces ignore monsters and skip the monster
 * itself and what it owns, as QuakeC's `checkBottom` does.
 */
class MonsterGroundProbe implements GroundProbe {
  /** The monster whose ground is probed, set for the duration of one check. */
  monster: ServerEdict | null = null;

  readonly #sv: Server;

  constructor(sv: Server) {
    this.#sv = sv;
  }

  traceLine(start: Vector, end: Vector): CollisionTrace {
    return this.#sv.collision.move(start, Vector.origin, Vector.origin, end, Defs.moveTypes.MOVE_NOMONSTERS, this.monster);
  }

  pointContents(point: Vector): Defs.content {
    return this.#sv.collision.pointContents(point);
  }
}

/**
 * Everything related to moving entities around.
 */
export class ServerMovement {
  private readonly sv: Server;

  /** Probes the ground under a monster for {@link ServerMovement#checkBottom}, kept to spare an allocation per step. */
  readonly #groundProbe: MonsterGroundProbe;

  /**
   * @param sv The server whose entities are moved.
   */
  constructor(sv: Server) {
    this.sv = sv;
    this.#groundProbe = new MonsterGroundProbe(sv);
  }

  /**
   * QuakeC's `checkBottom`: whether the entity has ground beneath its middle and all four bottom corners
   * ({@link GroundSupport.check}), probing the live world without monsters.
   * @param ent Entity to check.
   * @returns True if entity has solid ground beneath it.
   */
  checkBottom(ent: ServerEdict): boolean {
    const entity = ent.entity!;

    this.#groundProbe.monster = ent;
    const supported = GroundSupport.check(this.#groundProbe, entity.origin, entity.mins, entity.maxs);
    this.#groundProbe.monster = null;

    return supported;
  }

  movestep(ent: ServerEdict, move: Vector, relink: boolean): boolean {
    const entity = ent.entity!;
    const oldorg = entity.origin.copy();
    const mins = entity.mins;
    const maxs = entity.maxs;

    if ((entity.flags & (Defs.flags.FL_SWIM | Defs.flags.FL_FLY)) !== 0) {
      const enemy = entity.enemy;
      const neworg = new Vector();
      for (let index = 0; index <= 1; index++) {
        const origin = entity.origin.copy();
        neworg[0] = origin[0] + move[0];
        neworg[1] = origin[1] + move[1];
        neworg[2] = origin[2];
        if (index === 0 && enemy) {
          const enemyEntity = this.#resolveEntity(enemy);
          console.assert(enemyEntity !== null, 'enemy must resolve to an entity when steering swim/fly movement');

          const dz = entity.origin[2] - enemyEntity!.origin[2];
          if (dz > 40.0) {
            neworg[2] -= 8.0;
          } else if (dz < 30.0) {
            neworg[2] += 8.0;
          }
        }
        const trace = this.sv.collision.move(entity.origin, mins, maxs, neworg, Defs.moveTypes.MOVE_NORMAL, ent);
        if (trace.fraction === 1.0) {
          if ((entity.flags & Defs.flags.FL_SWIM) !== 0 && this.sv.collision.pointContents(trace.endpos) === Defs.content.CONTENT_EMPTY) {
            return false;
          }
          entity.origin = trace.endpos.copy();
          if (relink) {
            this.sv.area.linkEdict(ent, true);
          }
          return true;
        }
        if (!enemy) {
          return false;
        }
      }
      return false;
    }

    const neworg = entity.origin.copy();
    neworg[0] += move[0];
    neworg[1] += move[1];
    neworg[2] += STEPSIZE;
    const end = neworg.copy();
    end[2] -= STEPSIZE * 2.0;
    let trace = this.sv.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
    if (trace.allsolid) {
      return false;
    }
    if (trace.startsolid) {
      neworg[2] -= STEPSIZE;
      trace = this.sv.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
      if (trace.allsolid || trace.startsolid) {
        return false;
      }
    }
    if (trace.fraction === 1.0) {
      if ((entity.flags & Defs.flags.FL_PARTIALGROUND) !== 0) {
        const fallback = entity.origin.copy();
        fallback[0] += move[0];
        fallback[1] += move[1];
        entity.origin = fallback;
        if (relink) {
          this.sv.area.linkEdict(ent, true);
        }
        entity.flags &= ~Defs.flags.FL_ONGROUND;
        return true;
      }
      return false;
    }
    entity.origin = trace.endpos.copy();
    if (!this.checkBottom(ent)) {
      if ((entity.flags & Defs.flags.FL_PARTIALGROUND) !== 0) {
        if (relink) {
          this.sv.area.linkEdict(ent, true);
        }
        return true;
      }
      entity.origin = entity.origin.set(oldorg);
      return false;
    }
    console.assert(trace.ent !== null, 'ground trace must have an entity when movestep succeeds');
    entity.flags &= ~Defs.flags.FL_PARTIALGROUND;
    entity.groundentity = trace.ent!.entity;
    if (relink) {
      this.sv.area.linkEdict(ent, true);
    }
    return true;
  }

  walkMove(ent: ServerEdict, yaw: number, dist: number): boolean {
    const entity = ent.entity!;

    if ((entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      return false;
    }

    const radians = yaw * (Math.PI / 180.0);
    return this.movestep(ent, new Vector(Math.cos(radians) * dist, Math.sin(radians) * dist, 0.0), true);
  }

  /**
   * Takes one chase step of `dist` units toward the entity's goal, QuakeC's `movetogoal`. Without a `target` it is
   * QuakeC's chase: keep the current heading three times out of four, else (or when blocked) pick one of the eight
   * chase directions toward the goal entity. With a `target` point, such as a navigation waypoint, it heads straight
   * for the point and picks a chase direction only when that step is blocked. Keeping a stale heading toward a
   * waypoint makes the entity overshoot it and turn back and forth at corners
   * (`scripts/simulate-monster-chase.mts` measures it).
   * Does nothing while the entity is neither on the ground, flying nor swimming, or once it is close enough to its
   * goal while it has an enemy.
   * @param ent The entity that moves; its `goalentity` must be set.
   * @param dist How far to move.
   * @param target Where to head instead of the goal entity, or `null` for the goal entity.
   * @returns True when the entity moved or turned toward a new direction.
   */
  moveToGoal(ent: ServerEdict, dist: number, target: Vector | null = null): boolean {
    const entity = ent.entity!;

    if ((entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      return false;
    }

    const goalEdict = this.#resolveEdict(entity.goalentity || null);
    const enemyEdict = this.#resolveEdict(entity.enemy || null);

    console.assert(goalEdict !== null, 'must have goal for moveToGoal');

    if (enemyEdict !== null && !enemyEdict.isWorld() && this.closeEnough(ent, goalEdict!, dist)) {
      return false;
    }

    if (target !== null) {
      if (this.stepDirection(ent, target.copy().subtract(entity.origin).toYaw(), dist)) {
        return true;
      }

      return this.newChaseDir(ent, target, dist);
    }

    if (Math.random() >= 0.75 || !this.stepDirection(ent, entity.ideal_yaw || 0, dist)) {
      return this.newChaseDir(ent, goalEdict!.entity!.origin, dist);
    }

    return true;
  }

  changeYaw(edict: ServerEdict): number {
    const entity = edict.entity!;
    const angle1 = entity.angles[1];
    const current = Vector.anglemod(angle1);
    const ideal = entity.ideal_yaw || 0;

    if (current === ideal) {
      return angle1;
    }

    let move = ideal - current;

    if (ideal > current) {
      if (move >= 180.0) {
        move -= 360.0;
      }
    } else if (move <= -180.0) {
      move += 360.0;
    }

    const speed = entity.yaw_speed || 0;

    if (move > 0.0) {
      if (move > speed) {
        move = speed;
      }
    } else if (move < -speed) {
      move = -speed;
    }

    return Vector.anglemod(current + move);
  }

  stepDirection(ent: ServerEdict, yaw: number, dist: number): boolean {
    const entity = ent.entity!;

    entity.ideal_yaw = yaw;
    entity.angles = new Vector(entity.angles[0], this.changeYaw(ent), entity.angles[2]);
    const radians = yaw * (Math.PI / 180.0);
    const oldorigin = entity.origin.copy();
    if (this.movestep(ent, new Vector(Math.cos(radians) * dist, Math.sin(radians) * dist, 0.0), false)) {
      const delta = entity.angles[1] - entity.ideal_yaw;
      if (delta > 45.0 && delta < 315.0) {
        entity.origin = entity.origin.set(oldorigin);
      }
      this.sv.area.linkEdict(ent, true);
      return true;
    }
    this.sv.area.linkEdict(ent, true);
    return false;
  }

  /**
   * Picks a new chase direction toward a point and steps along it, QuakeC's `SV_NewChaseDir`: the diagonal toward the
   * point, then each axis, the old direction, every other direction, and turning around only as the last resort. Marks
   * the entity as partly on the ground when nothing works and its bottom isn't fully supported.
   * @param actor The entity that moves.
   * @param endpos The point to chase.
   * @param dist How far to move.
   * @returns True when one of the directions worked.
   */
  newChaseDir(actor: ServerEdict, endpos: Vector, dist: number): boolean {
    const entity = actor.entity!;
    const olddir = Vector.anglemod((((entity.ideal_yaw || 0) / 45.0) >> 0) * 45.0);
    const turnaround = Vector.anglemod(olddir - 180.0);
    const deltax = endpos[0] - entity.origin[0];
    const deltay = endpos[1] - entity.origin[1];
    let dx: number;
    let dy: number;
    if (deltax > 10.0) {
      dx = 0.0;
    } else if (deltax < -10.0) {
      dx = 180.0;
    } else {
      dx = -1;
    }
    if (deltay < -10.0) {
      dy = 270.0;
    } else if (deltay > 10.0) {
      dy = 90.0;
    } else {
      dy = -1;
    }
    let tdir: number;
    if (dx !== -1 && dy !== -1) {
      if (dx === 0.0) {
        tdir = dy === 90.0 ? 45.0 : 315.0;
      } else {
        tdir = dy === 90.0 ? 135.0 : 215.0;
      }
      if (tdir !== turnaround && this.stepDirection(actor, tdir, dist)) {
        return true;
      }
    }
    if (Math.random() >= 0.25 || Math.abs(deltay) > Math.abs(deltax)) {
      tdir = dx;
      dx = dy;
      dy = tdir;
    }
    if (dx !== -1 && dx !== turnaround && this.stepDirection(actor, dx, dist)) {
      return true;
    }
    if (dy !== -1 && dy !== turnaround && this.stepDirection(actor, dy, dist)) {
      return true;
    }
    if (olddir !== -1 && this.stepDirection(actor, olddir, dist)) {
      return true;
    }
    if (Math.random() >= 0.5) {
      for (tdir = 0.0; tdir <= 315.0; tdir += 45.0) {
        if (tdir !== turnaround && this.stepDirection(actor, tdir, dist)) {
          return true;
        }
      }
    } else {
      for (tdir = 315.0; tdir >= 0.0; tdir -= 45.0) {
        if (tdir !== turnaround && this.stepDirection(actor, tdir, dist)) {
          return true;
        }
      }
    }
    if (turnaround !== -1 && this.stepDirection(actor, turnaround, dist)) {
      return true;
    }
    entity.ideal_yaw = olddir;
    if (!this.checkBottom(actor)) {
      entity.flags |= Defs.flags.FL_PARTIALGROUND;
    }
    return false;
  }

  closeEnough(ent: ServerEdict, goal: { readonly entity: BaseEntity | null }, dist: number): boolean {
    const absmin = ent.entity!.absmin;
    const absmax = ent.entity!.absmax;
    const absminGoal = goal.entity!.absmin;
    const absmaxGoal = goal.entity!.absmax;
    for (let index = 0; index < 3; index++) {
      if (absminGoal[index] > absmax[index] + dist) {
        return false;
      }
      if (absmaxGoal[index] < absmin[index] - dist) {
        return false;
      }
    }
    return true;
  }

  #resolveEdict(value: BaseEntity | EdictReferenceLike | ReadonlyServerEdict | ServerEdict | null): ReadonlyServerEdict | ServerEdict | null {
    if (!value) {
      return null;
    }
    if (this.#isServerEdictLike(value)) {
      return value;
    }
    return value.edict ?? null;
  }

  #resolveEntity(value: BaseEntity | EdictReferenceLike | ReadonlyServerEdict | ServerEdict | null): BaseEntity | null {
    if (!value) {
      return null;
    }
    if (this.#isServerEdictLike(value)) {
      return value.entity;
    }
    if ('origin' in value) {
      return value;
    }
    return value.edict?.entity ?? null;
  }

  #isServerEdictLike(value: BaseEntity | EdictReferenceLike | ReadonlyServerEdict | ServerEdict): value is ReadonlyServerEdict | ServerEdict {
    return 'entity' in value && typeof value.isWorld === 'function';
  }
}
