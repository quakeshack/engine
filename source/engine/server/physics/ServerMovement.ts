import type { ServerEdict as ReadonlyServerEdict } from '../../../shared/GameInterfaces.ts';
import type { BaseEntity, ServerEdict } from '../Edict.ts';

import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { STEPSIZE } from '../../common/Pmove.ts';
import { eventBus, getCommonRegistry } from '../../registry.ts';

interface EdictReferenceLike {
  readonly edict?: ReadonlyServerEdict | null;
}

let { SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ SV } = getCommonRegistry());
});

/**
 * Everything related to moving entities around.
 */
export class ServerMovement {
  /**
   * Checks if an entity has solid ground beneath all four bottom corners.
   * If all corners are solid, returns true immediately. Otherwise performs
   * a more detailed trace check to validate the ground surface.
   * @param ent Entity to check.
   * @returns True if entity has solid ground beneath it.
   */
  checkBottom(ent: ServerEdict): boolean {
    const entity = ent.entity!;
    const mins = entity.origin.copy().add(entity.mins);
    const maxs = entity.origin.copy().add(entity.maxs);

    // Quick check: if all four corners are solid, we're definitely on ground
    const allCornersSolid =
      SV.collision.pointContents(new Vector(mins[0], mins[1], mins[2] - 1.0)) === Defs.content.CONTENT_SOLID &&
      SV.collision.pointContents(new Vector(mins[0], maxs[1], mins[2] - 1.0)) === Defs.content.CONTENT_SOLID &&
      SV.collision.pointContents(new Vector(maxs[0], mins[1], mins[2] - 1.0)) === Defs.content.CONTENT_SOLID &&
      SV.collision.pointContents(new Vector(maxs[0], maxs[1], mins[2] - 1.0)) === Defs.content.CONTENT_SOLID;

    if (allCornersSolid) {
      return true;
    }

    // Not all corners solid - do detailed trace check
    const start = entity.origin.copy().add(new Vector(0.0, 0.0, entity.mins[2] + 1.0));
    const stop = start.copy().add(new Vector(0.0, 0.0, -2.0 * STEPSIZE));

    let trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Defs.moveTypes.MOVE_NOMONSTERS, ent);
    if (trace.fraction === 1.0) {
      return false;
    }

    let bottom = trace.endpos[2];
    const mid = bottom;
    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start[0] = stop[0] = x !== 0 ? maxs[0] : mins[0];
        start[1] = stop[1] = y !== 0 ? maxs[1] : mins[1];
        trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Defs.moveTypes.MOVE_NOMONSTERS, ent);
        if (trace.fraction !== 1.0 && trace.endpos[2] > bottom) {
          bottom = trace.endpos[2];
        }
        if (trace.fraction === 1.0 || (mid - trace.endpos[2]) > STEPSIZE) {
          return false;
        }
      }
    }

    return true;
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
        const trace = SV.collision.move(entity.origin, mins, maxs, neworg, Defs.moveTypes.MOVE_NORMAL, ent);
        if (trace.fraction === 1.0) {
          if ((entity.flags & Defs.flags.FL_SWIM) !== 0 && SV.collision.pointContents(trace.endpos) === Defs.content.CONTENT_EMPTY) {
            return false;
          }
          entity.origin = trace.endpos.copy();
          if (relink) {
            SV.area.linkEdict(ent, true);
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
    let trace = SV.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
    if (trace.allsolid) {
      return false;
    }
    if (trace.startsolid) {
      neworg[2] -= STEPSIZE;
      trace = SV.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
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
          SV.area.linkEdict(ent, true);
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
          SV.area.linkEdict(ent, true);
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
      SV.area.linkEdict(ent, true);
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

  moveToGoal(ent: ServerEdict, dist: number, target: Vector | null = null): boolean {
    const entity = ent.entity!;

    if ((entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      return false;
    }

    const goalEdict = this.#resolveEdict(entity.goalentity);
    const enemyEdict = this.#resolveEdict(entity.enemy);

    console.assert(goalEdict !== null, 'must have goal for moveToGoal');

    const goalTarget = target ?? goalEdict!.entity!.origin;

    if (enemyEdict !== null && !enemyEdict.isWorld() && this.closeEnough(ent, goalEdict!, dist)) {
      return false;
    }

    // TODO: consider reintroducing direct movestep steering toward goal to reduce chase ping-pong.
    if (Math.random() >= 0.75 || !this.stepDirection(ent, entity.ideal_yaw, dist)) {
      this.newChaseDir(ent, goalTarget, dist);
      return true;
    }

    return false;
  }

  changeYaw(edict: ServerEdict): number {
    const entity = edict.entity!;
    const angle1 = entity.angles[1];
    const current = Vector.anglemod(angle1);
    const ideal = entity.ideal_yaw;

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
      SV.area.linkEdict(ent, true);
      return true;
    }
    SV.area.linkEdict(ent, true);
    return false;
  }

  newChaseDir(actor: ServerEdict, endpos: Vector, dist: number): void {
    const entity = actor.entity!;
    const olddir = Vector.anglemod(((entity.ideal_yaw / 45.0) >> 0) * 45.0);
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
        return;
      }
    }
    if (Math.random() >= 0.25 || Math.abs(deltay) > Math.abs(deltax)) {
      tdir = dx;
      dx = dy;
      dy = tdir;
    }
    if (dx !== -1 && dx !== turnaround && this.stepDirection(actor, dx, dist)) {
      return;
    }
    if (dy !== -1 && dy !== turnaround && this.stepDirection(actor, dy, dist)) {
      return;
    }
    if (olddir !== -1 && this.stepDirection(actor, olddir, dist)) {
      return;
    }
    if (Math.random() >= 0.5) {
      for (tdir = 0.0; tdir <= 315.0; tdir += 45.0) {
        if (tdir !== turnaround && this.stepDirection(actor, tdir, dist)) {
          return;
        }
      }
    } else {
      for (tdir = 315.0; tdir >= 0.0; tdir -= 45.0) {
        if (tdir !== turnaround && this.stepDirection(actor, tdir, dist)) {
          return;
        }
      }
    }
    if (turnaround !== -1 && this.stepDirection(actor, turnaround, dist)) {
      return;
    }
    entity.ideal_yaw = olddir;
    if (!this.checkBottom(actor)) {
      entity.flags |= Defs.flags.FL_PARTIALGROUND;
    }
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
