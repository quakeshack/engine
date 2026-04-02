import Vector from '../../../shared/Vector.ts';
import * as Defs from '../../../shared/Defs.ts';
import { STEPSIZE } from '../../common/Pmove.mjs';
import { ServerEdict } from '../Edict.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

/**
 * Everything related to moving entities around.
 */
export class ServerMovement {
  constructor() {
  }

  /**
   * Checks if an entity has solid ground beneath all four bottom corners.
   * If all corners are solid, returns true immediately. Otherwise performs
   * a more detailed trace check to validate the ground surface.
   * @param {import('../Edict.mjs').ServerEdict} ent entity to check
   * @returns {boolean} true if entity has solid ground beneath it
   */
  checkBottom(ent) {
    const mins = ent.entity.origin.copy().add(ent.entity.mins);
    const maxs = ent.entity.origin.copy().add(ent.entity.maxs);

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
    const start = ent.entity.origin.copy().add(new Vector(0.0, 0.0, ent.entity.mins[2] + 1.0));
    const stop = start.copy().add(new Vector(0.0, 0.0, -2.0 * STEPSIZE));

    let trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Defs.moveTypes.MOVE_NOMONSTERS, ent);
    if (trace.fraction === 1.0) {
      return false;
    }
    let bottom = trace.endpos[2];
    const mid = bottom;
    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start[0] = stop[0] = (x !== 0) ? maxs[0] : mins[0];
        start[1] = stop[1] = (y !== 0) ? maxs[1] : mins[1];
        trace = SV.collision.move(start, Vector.origin, Vector.origin, stop, Defs.moveTypes.MOVE_NOMONSTERS, ent);
        if ((trace.fraction !== 1.0) && (trace.endpos[2] > bottom)) {
          bottom = trace.endpos[2];
        }
        if ((trace.fraction === 1.0) || ((mid - trace.endpos[2]) > STEPSIZE)) {
          return false;
        }
      }
    }
    return true;
  }

  movestep(ent, move, relink) {
    const oldorg = ent.entity.origin.copy();
    const mins = ent.entity.mins;
    const maxs = ent.entity.maxs;
    if ((ent.entity.flags & (Defs.flags.FL_SWIM | Defs.flags.FL_FLY)) !== 0) {
      const enemy = ent.entity.enemy;
      const neworg = new Vector();
      for (let i = 0; i <= 1; i++) {
        const origin = ent.entity.origin.copy();
        neworg[0] = origin[0] + move[0];
        neworg[1] = origin[1] + move[1];
        neworg[2] = origin[2];
        if (i === 0 && enemy) {
          const enemyEntity = enemy instanceof ServerEdict ? enemy.entity : enemy;
          const dz = ent.entity.origin[2] - enemyEntity.origin[2];
          if (dz > 40.0) {
            neworg[2] -= 8.0;
          } else if (dz < 30.0) {
            neworg[2] += 8.0;
          }
        }
        const trace = SV.collision.move(ent.entity.origin, mins, maxs, neworg, Defs.moveTypes.MOVE_NORMAL, ent);
        if (trace.fraction === 1.0) {
          if (((ent.entity.flags & Defs.flags.FL_SWIM) !== 0) && (SV.collision.pointContents(trace.endpos) === Defs.content.CONTENT_EMPTY)) {
            return false;
          }
          ent.entity.origin = trace.endpos.copy();
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
    const neworg = ent.entity.origin.copy();
    neworg[0] += move[0];
    neworg[1] += move[1];
    neworg[2] += STEPSIZE;
    const end = neworg.copy();
    end[2] -= STEPSIZE * 2.0;
    let trace = SV.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
    if (trace.allsolid === true) {
      return false;
    }
    if (trace.startsolid === true) {
      neworg[2] -= STEPSIZE;
      trace = SV.collision.move(neworg, mins, maxs, end, Defs.moveTypes.MOVE_NORMAL, ent);
      if ((trace.allsolid === true) || (trace.startsolid === true)) {
        return false;
      }
    }
    if (trace.fraction === 1.0) {
      if ((ent.entity.flags & Defs.flags.FL_PARTIALGROUND) !== 0) {
        const fallback = ent.entity.origin.copy();
        fallback[0] += move[0];
        fallback[1] += move[1];
        ent.entity.origin = fallback;
        if (relink) {
          SV.area.linkEdict(ent, true);
        }
        ent.entity.flags &= (~Defs.flags.FL_ONGROUND);
        return true;
      }
      return false;
    }
    ent.entity.origin = trace.endpos.copy();
    if (!this.checkBottom(ent)) {
      if ((ent.entity.flags & Defs.flags.FL_PARTIALGROUND) !== 0) {
        if (relink) {
          SV.area.linkEdict(ent, true);
        }
        return true;
      }
      ent.entity.origin = ent.entity.origin.set(oldorg);
      return false;
    }
    ent.entity.flags &= ~Defs.flags.FL_PARTIALGROUND;
    ent.entity.groundentity = trace.ent.entity;
    if (relink) {
      SV.area.linkEdict(ent, true);
    }
    return true;
  }

  walkMove(ent, yaw, dist) {
    if ((ent.entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      return false;
    }

    const radians = yaw * (Math.PI / 180.0);
    return this.movestep(ent, new Vector(Math.cos(radians) * dist, Math.sin(radians) * dist, 0.0), true);
  }

  moveToGoal(ent, dist, target = null) {

    if ((ent.entity.flags & (Defs.flags.FL_ONGROUND | Defs.flags.FL_FLY | Defs.flags.FL_SWIM)) === 0) {
      return false;
    }

    const resolveEdict = (value) => {
      if (!value) {
        return null;
      }
      if (value instanceof ServerEdict) {
        return value;
      }
      return value.edict || null;
    };

    const goalEdict = resolveEdict(ent.entity.goalentity);
    const enemyEdict = resolveEdict(ent.entity.enemy);

    console.assert(goalEdict !== null, 'must have goal for moveToGoal');

    const goalTarget = target ?? goalEdict.entity.origin;

    if (enemyEdict !== null && !enemyEdict.isWorld() && this.closeEnough(ent, goalEdict, dist)) {
      return false;
    }

    // TODO: consider reintroducing direct movestep steering toward goal to reduce chase ping-pong.
    if (Math.random() >= 0.75 || !this.stepDirection(ent, ent.entity.ideal_yaw, dist)) {
      this.newChaseDir(ent, goalTarget, dist);
      return true;
    }

    return false;
  }

  changeYaw(edict) {
    const angle1 = edict.entity.angles[1];
    const current = Vector.anglemod(angle1);
    const ideal = edict.entity.ideal_yaw;

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

    const speed = edict.entity.yaw_speed || 0;

    if (move > 0.0) {
      if (move > speed) {
        move = speed;
      }
    } else if (move < -speed) {
      move = -speed;
    }

    return Vector.anglemod(current + move);
  }

  stepDirection(ent, yaw, dist) {
    ent.entity.ideal_yaw = yaw;
    ent.entity.angles = new Vector(ent.entity.angles[0], this.changeYaw(ent), ent.entity.angles[2]);
    const radians = yaw * (Math.PI / 180.0);
    const oldorigin = ent.entity.origin.copy();
    if (this.movestep(ent, new Vector(Math.cos(radians) * dist, Math.sin(radians) * dist, 0.0), false)) {
      const delta = ent.entity.angles[1] - ent.entity.ideal_yaw;
      if ((delta > 45.0) && (delta < 315.0)) {
        ent.entity.origin = ent.entity.origin.set(oldorigin);
      }
      SV.area.linkEdict(ent, true);
      return true;
    }
    SV.area.linkEdict(ent, true);
    return false;
  }

  newChaseDir(actor, endpos, dist) {
    const olddir = Vector.anglemod(((actor.entity.ideal_yaw / 45.0) >> 0) * 45.0);
    const turnaround = Vector.anglemod(olddir - 180.0);
    const deltax = endpos[0] - actor.entity.origin[0];
    const deltay = endpos[1] - actor.entity.origin[1];
    let dx;
    let dy;
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
    let tdir;
    if ((dx !== -1) && (dy !== -1)) {
      if (dx === 0.0) {
        tdir = (dy === 90.0) ? 45.0 : 315.0;
      } else {
        tdir = (dy === 90.0) ? 135.0 : 215.0;
      }
      if ((tdir !== turnaround) && this.stepDirection(actor, tdir, dist)) {
        return;
      }
    }
    if ((Math.random() >= 0.25) || (Math.abs(deltay) > Math.abs(deltax))) {
      tdir = dx;
      dx = dy;
      dy = tdir;
    }
    if ((dx !== -1) && (dx !== turnaround) && this.stepDirection(actor, dx, dist)) {
      return;
    }
    if ((dy !== -1) && (dy !== turnaround) && this.stepDirection(actor, dy, dist)) {
      return;
    }
    if ((olddir !== -1) && this.stepDirection(actor, olddir, dist)) {
      return;
    }
    if (Math.random() >= 0.5) {
      for (tdir = 0.0; tdir <= 315.0; tdir += 45.0) {
        if ((tdir !== turnaround) && this.stepDirection(actor, tdir, dist)) {
          return;
        }
      }
    } else {
      for (tdir = 315.0; tdir >= 0.0; tdir -= 45.0) {
        if ((tdir !== turnaround) && this.stepDirection(actor, tdir, dist)) {
          return;
        }
      }
    }
    if ((turnaround !== -1) && this.stepDirection(actor, turnaround, dist)) {
      return;
    }
    actor.entity.ideal_yaw = olddir;
    if (!this.checkBottom(actor)) {
      actor.entity.flags |= Defs.flags.FL_PARTIALGROUND;
    }
  }

  closeEnough(ent, goal, dist) {
    const absmin = ent.entity.absmin;
    const absmax = ent.entity.absmax;
    const absminGoal = goal.entity.absmin;
    const absmaxGoal = goal.entity.absmax;
    for (let i = 0; i < 3; i++) {
      if (absminGoal[i] > (absmax[i] + dist)) {
        return false;
      }
      if (absmaxGoal[i] < (absmin[i] - dist)) {
        return false;
      }
    }
    return true;
  }
};
