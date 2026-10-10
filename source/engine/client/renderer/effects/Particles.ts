import Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import PhysicsMath from '../../../common/PhysicsMath.ts';
import W from '../../../common/W.ts';
import Host from '../../../common/Host.ts';
import { eventBus } from '../../../common/EventBus.ts';
import { avertexnormals } from '../../../common/model/loaders/AliasMDLLoader.ts';
import GL from '../../GL.ts';
import { clientRuntimeState, clientStaticState } from '../../ClientState.ts';
import { clientCollision } from '../../ClientPhysics.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import R from '../../R.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** A particle as it is written to a savegame: times are relative to the clock when it was saved. */
export interface SerializedParticle {
  i: number;
  die: number;
  color: number;
  ramp: number;
  type: number;
  org: [number, number, number];
  vel: [number, number, number];
}

export interface Particle {
  die: number;
  color: number;
  ramp: number;
  type: ParticleType;
  org: Vector;
  vel: Vector;
}

/** What the simulation of one frame of particles needs, see {@link Particles.BeginFrame}. */
export interface ParticleFrame {
  /** Offsets of the six corners of a billboard quad (two triangles). */
  readonly coords: readonly number[];
  readonly frameTime: number;
  /** Velocity change per frame of a particle that falls. */
  readonly grav: number;
  /** Velocity scale per frame of explosion and blob particles. */
  readonly dvel: number;
}

type AngularVelocity = [number, number, number];

export enum ParticleType {
  tracer = 0,
  grav = 1,
  slowgrav = 2,
  fire = 3,
  explode = 4,
  explode2 = 5,
  blob = 6,
  blob2 = 7,
}

/**
 * Overbounce factor for a gravity particle reflecting off a floor-like surface, matching
 * `MOVETYPE_BOUNCE`'s server-side factor (`ServerPhysics.physicsToss()`) for a consistent,
 * lively bounce instead of a dead stop.
 */
const PARTICLE_BOUNCE_OVERBOUNCE = 1.5;

const BILLBOARD_COORDS: readonly number[] = [-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];

/**
 * The particle pool of the client: world effects (explosions, trails, splashes), their simulation and drawing.
 * Particles are not client entities, there are far too many of them.
 */
export class Particles {
  /**
   * The pool: `numparticles` slots, and a slot whose `die` time has passed is free for the next effect.
   */
  static particles: Particle[] = [];

  /**
   * Size of the pool, set by {@link Particles.Init}.
   */
  static numparticles = 0;

  /**
   * Fixed random angular velocities of the 162 particles that circle an entity (`EntityParticles`).
   */
  static avelocities: AngularVelocity[] = [];

  /**
   * Particle types that collide with world geometry in `RenderAndAdvance()` instead of
   * flying through it -- every type whose velocity already integrates gravity (see the
   * `ParticleType` switch below), except `fire`, whose upward "embers" drift is not gravity in
   * the falling sense. A one-line escape hatch: drop a type from this set if profiling ever shows
   * its collision cost isn't worth it for that type specifically, without reverting the feature.
   */
  static readonly collidableParticleTypes = new Set<ParticleType>([
    ParticleType.grav,
    ParticleType.slowgrav,
    ParticleType.explode,
    ParticleType.explode2,
    ParticleType.blob,
    ParticleType.blob2,
  ]);

  static #scratchNewOrigin = new Vector();
  static #scratchClippedVelocity = new Vector();

  /**
   * Creates a particle that is free for reuse.
   * @returns The particle.
   */
  private static _createDeadParticle(): Particle {
    return {
      die: -1.0,
      color: 0,
      ramp: 0.0,
      type: ParticleType.slowgrav,
      org: new Vector(),
      vel: new Vector(),
    };
  }

  /**
   * Resolves a gravity particle's pending move from `origin` to `newOrigin` against world
   * geometry: a floor-like surface (`PhysicsMath.GROUND_ANGLE_THRESHOLD`) reflects `velocity` via
   * the shared `PhysicsMath.clipVelocity()` formula, matching `MOVETYPE_BOUNCE`'s overbounce; a
   * wall/ceiling-like surface, or a start already embedded in solid, reports a kill instead of
   * clipping through it. Always leaves `origin` at the particle's actual resting position for this
   * step -- `newOrigin` when nothing was hit, the impact point otherwise. `clientCollision.
   * pointContents()` (a cheap BSP point classification, no swept-hull work) gates the real
   * `traceStaticWorldLine()` call, so the common case of open-air flight never pays for a full
   * trace -- see the "Extension: gravity-particle collision" section of
   * plans/client-entity-architecture.md for why this matters at explosion-burst particle counts.
   * @returns True when the particle hit a wall/ceiling-like surface and should be killed.
   */
  static ResolveParticleCollision(origin: Vector, velocity: Vector, newOrigin: Vector): boolean {
    if (clientCollision.pointContents(newOrigin) !== content.CONTENT_SOLID) {
      origin.set(newOrigin);
      return false;
    }

    const trace = clientCollision.traceStaticWorldLine(origin, newOrigin);
    origin.set(trace.endpos);

    if (!trace.allsolid && trace.fraction >= 1.0) {
      // The cheap point check flagged newOrigin as solid, but the swept trace found nothing
      // along the actual path -- a boundary/epsilon disagreement between point classification
      // and segment tracing at the destination. Nothing was really hit; move on normally.
      return false;
    }

    if (trace.allsolid || trace.plane.normal[2] <= PhysicsMath.GROUND_ANGLE_THRESHOLD) {
      return true;
    }

    PhysicsMath.clipVelocity(velocity, trace.plane.normal, Particles.#scratchClippedVelocity, PARTICLE_BOUNCE_OVERBOUNCE);
    velocity.set(Particles.#scratchClippedVelocity);
    return false;
  }

  /**
   * Emit one particle billboard and advance its simulation by one frame.
   */
  static RenderAndAdvance(particle: Particle, frame: ParticleFrame): void {
    const { coords, frameTime, grav, dvel } = frame;
    const color = W.d_8to24table[particle.color];
    let scale = (particle.org[0] - R.refdef.vieworg[0]) * R.vpn[0]
      + (particle.org[1] - R.refdef.vieworg[1]) * R.vpn[1]
      + (particle.org[2] - R.refdef.vieworg[2]) * R.vpn[2];
    if (scale < 20.0) {
      scale = 0.375;
    } else {
      scale = 0.375 + scale * 0.0015;
    }

    GL.StreamGetSpace(6);
    for (let j = 0; j < 6; j++) {
      GL.StreamWriteFloat3(particle.org[0], particle.org[1], particle.org[2]);
      GL.StreamWriteFloat2(coords[j * 2], coords[j * 2 + 1]);
      GL.StreamWriteFloat(scale);
      GL.StreamWriteUByte4(color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
    }

    if (Particles.collidableParticleTypes.has(particle.type)) {
      const newOrigin = Particles.#scratchNewOrigin;
      newOrigin[0] = particle.org[0] + particle.vel[0] * frameTime;
      newOrigin[1] = particle.org[1] + particle.vel[1] * frameTime;
      newOrigin[2] = particle.org[2] + particle.vel[2] * frameTime;

      if (Particles.ResolveParticleCollision(particle.org, particle.vel, newOrigin)) {
        particle.die = -1.0;
      }
    } else {
      particle.org[0] += particle.vel[0] * frameTime;
      particle.org[1] += particle.vel[1] * frameTime;
      particle.org[2] += particle.vel[2] * frameTime;
    }

    switch (particle.type) {
    case ParticleType.fire:
      particle.ramp += frameTime * 5.0;
      if (particle.ramp >= 6.0) {
        particle.die = -1.0;
      } else {
        particle.color = Particles.ramp3[Math.floor(particle.ramp)];
      }
      particle.vel[2] += grav;
      return;
    case ParticleType.explode:
      particle.ramp += frameTime * 10.0;
      if (particle.ramp >= 8.0) {
        particle.die = -1.0;
      } else {
        particle.color = Particles.ramp1[Math.floor(particle.ramp)];
      }
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] += particle.vel[2] * dvel - grav;
      return;
    case ParticleType.explode2:
      particle.ramp += frameTime * 15.0;
      if (particle.ramp >= 8.0) {
        particle.die = -1.0;
      } else {
        particle.color = Particles.ramp2[Math.floor(particle.ramp)];
      }
      particle.vel[0] -= particle.vel[0] * frameTime;
      particle.vel[1] -= particle.vel[1] * frameTime;
      particle.vel[2] -= particle.vel[2] * frameTime + grav;
      return;
    case ParticleType.blob:
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] += particle.vel[2] * dvel - grav;
      return;
    case ParticleType.blob2:
      particle.vel[0] += particle.vel[0] * dvel;
      particle.vel[1] += particle.vel[1] * dvel;
      particle.vel[2] -= grav;
      return;
    case ParticleType.grav:
    case ParticleType.slowgrav:
      particle.vel[2] -= grav;
      return;
    default:
      return;
    }
  }

  /**
   * Palette indices that `explode` particles walk through while they age.
   */
  static ramp1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
  /**
   * Palette indices that `explode2` particles walk through while they age.
   */
  static ramp2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
  /**
   * Palette indices that `fire` particles (rocket and grenade trails) walk through while they age.
   */
  static ramp3 = [0x6d, 0x6b, 6, 5, 4, 3];

  /**
   * Sizes the pool and rolls the angular velocities of the entity effect. Call once, before the first map.
   */
  static Init(): void {
    Particles.numparticles = 32786;
    Particles.avelocities = [];
    for (let i = 0; i <= 161; i++) {
      Particles.avelocities[i] = [Math.random() * 2.56, Math.random() * 2.56, Math.random() * 2.56];
    }
  }

  /**
   * Writes the live particles for a savegame, with times relative to the clock and values rounded to a tenth.
   * @returns The live particles, each with its slot.
   */
  static SerializeParticles(): SerializedParticle[] {
    const data = [];
    const round = (num: number): number => Math.round(num * 10) / 10; // we do not need a high precision here
    const roundVector = (vector: Vector): [number, number, number] => [
      round(vector[0]),
      round(vector[1]),
      round(vector[2]),
    ];

    for (let i = 0; i < Particles.numparticles; i++) {
      const p = Particles.particles[i];

      if (p.die < clientRuntimeState.time) {
        continue;
      }

      data.push({
        i: i,
        die: round(p.die - clientRuntimeState.time),
        color: p.color,
        ramp: round(p.ramp),
        type: round(p.type),
        org: roundVector(p.org),
        vel: roundVector(p.vel),
      });
    }

    return data;
  }

  /**
   * Puts particles from a savegame back into their slots, re-anchoring their times on the current clock.
   */
  static DeserializeParticles(data: SerializedParticle[]): void {
    for (const p of data) {
      console.assert(p.i >= 0 && p.i < Particles.particles.length, 'valid particle index', p.i);
      Particles.particles[p.i] = {
        die: p.die + clientRuntimeState.time,
        color: p.color,
        ramp: p.ramp,
        type: p.type,
        org: new Vector(...p.org),
        vel: new Vector(...p.vel),
      };
    }
  }

  /**
   * Spawns the ring of particles that circles an entity with the quad-damage style effect.
   */
  static EntityParticles(ent: ClientEdict): void {
    const allocated = Particles.AllocParticles(162);

    for (let i = 0; i < allocated.length; i++) {
      const angleP = clientRuntimeState.time * Particles.avelocities[i][0];
      const sp = Math.sin(angleP);
      const cp = Math.cos(angleP);
      const angleY = clientRuntimeState.time * Particles.avelocities[i][1];
      const sy = Math.sin(angleY);
      const cy = Math.cos(angleY);

      Particles.particles[allocated[i]] = { // TODO: Particle Class
        die: clientRuntimeState.time + 0.01,
        color: 0x6f,
        ramp: 0.0,
        type: ParticleType.explode,
        org: new Vector(
          ent.origin[0] + avertexnormals[i * 3 + 0] * 64.0 + cp * cy * 16.0,
          ent.origin[1] + avertexnormals[i * 3 + 1] * 64.0 + cp * sy * 16.0,
          ent.origin[2] + avertexnormals[i * 3 + 2] * 64.0 + sp * -16.0,
        ),
        vel: new Vector(),
      };
    }
  }

  /**
   * Frees every slot of the pool.
   */
  static Clear(): void {
    // anything that still holds the old array must not see stale particles
    Particles.particles.length = 0;
    Particles.particles = [];
    for (let i = 0; i < Particles.numparticles; i++) {
      Particles.particles[i] = Particles._createDeadParticle();
    }
  }

  /**
   * A rocket or grenade explosion.
   */
  static ParticleExplosion(org: Vector): void {
    const allocated = Particles.AllocParticles(1024);
    for (let i = 0; i < allocated.length; i++) {
      Particles.particles[allocated[i]] = {
        die: clientRuntimeState.time + 5.0,
        color: Particles.ramp1[0],
        ramp: Math.floor(Math.random() * 4.0),
        type: ((i & 1) !== 0) ? ParticleType.explode : ParticleType.explode2,
        org: new Vector(
          org[0] + Math.random() * 32.0 - 16.0,
          org[1] + Math.random() * 32.0 - 16.0,
          org[2] + Math.random() * 32.0 - 16.0,
        ),
        vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
      };
    }
  }

  /**
   * A colored explosion with the palette range `colorStart` to `colorStart + colorLength`.
   */
  static ParticleExplosion2(org: Vector, colorStart: number, colorLength: number): void {
    const allocated = Particles.AllocParticles(512);
    let colorMod = 0;
    for (let i = 0; i < allocated.length; i++) {
      Particles.particles[allocated[i]] = {
        die: clientRuntimeState.time + 0.3,
        color: colorStart + (colorMod++ % colorLength),
        ramp: 0.0,
        type: ParticleType.blob,
        org: new Vector(
          org[0] + Math.random() * 32.0 - 16.0,
          org[1] + Math.random() * 32.0 - 16.0,
          org[2] + Math.random() * 32.0 - 16.0,
        ),
        vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
      };
    }
  }

  /**
   * The spike-ball (tarbaby) explosion.
   */
  static BlobExplosion(org: Vector): void {
    const allocated = Particles.AllocParticles(1024);
    for (let i = 0; i < allocated.length; i++) {
      const p = Particles.particles[allocated[i]];
      p.die = clientRuntimeState.time + 1.0 + Math.random() * 0.4;
      if ((i & 1) !== 0) {
        p.type = ParticleType.blob;
        p.color = 66 + Math.floor(Math.random() * 7.0);
      } else {
        p.type = ParticleType.blob2;
        p.color = 150 + Math.floor(Math.random() * 7.0);
      }
      p.org = new Vector(
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      );
      p.vel = new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0);
    }
  }

  /**
   * A burst of `count` short-lived particles, as for bullet impacts and blood.
   */
  static RunParticleEffect(org: Vector, dir: Vector, color: number, count: number): void {
    const allocated = Particles.AllocParticles(count); let i;
    for (i = 0; i < allocated.length; i++) {
      Particles.particles[allocated[i]] = {
        die: clientRuntimeState.time + 0.6 * Math.random(),
        color: (color & 0xf8) + Math.floor(Math.random() * 8.0),
        ramp: 0.0,
        type: ParticleType.slowgrav,
        org: new Vector(
          org[0] + Math.random() * 16.0 - 8.0,
          org[1] + Math.random() * 16.0 - 8.0,
          org[2] + Math.random() * 16.0 - 8.0,
        ),
        vel: dir.copy().multiply(15.0),
      };
    }
  }

  /**
   * The lava burst of a lava ball landing.
   */
  static LavaSplash(org: Vector): void {
    const allocated = Particles.AllocParticles(1024);
    let k = 0;
    for (let i = -16; i <= 15; i++) {
      for (let j = -16; j <= 15; j++) {
        if (k >= allocated.length) {
          return;
        }
        const p = Particles.particles[allocated[k++]];
        p.die = clientRuntimeState.time + 2.0 + Math.random() * 0.64;
        p.color = 224 + Math.floor(Math.random() * 8.0);
        p.type = ParticleType.slowgrav;
        const dir = new Vector((j + Math.random()) * 8.0, (i + Math.random()) * 8.0, 256.0);
        p.org = new Vector(org[0] + dir[0], org[1] + dir[1], org[2] + Math.random() * 64.0);
        dir.normalize();
        p.vel = dir.multiply(50.0 + Math.random() * 64.0);
      }
    }
  }

  /**
   * The particle cloud of a teleporter.
   */
  static TeleportSplash(org: Vector): void {
    const allocated = Particles.AllocParticles(896);
    let l = 0;
    for (let i = -16; i <= 15; i += 4) {
      for (let j = -16; j <= 15; j += 4) {
        for (let k = -24; k <= 31; k += 4) {
          if (l >= allocated.length) {
            return;
          }
          const p = Particles.particles[allocated[l++]];
          p.die = clientRuntimeState.time + 0.2 + Math.random() * 0.16;
          p.color = 7 + Math.floor(Math.random() * 8.0);
          p.type = ParticleType.slowgrav;
          const dir = new Vector(j * 8.0, i * 8.0, k * 8.0);
          p.org = new Vector(
            org[0] + i + Math.random() * 4.0,
            org[1] + j + Math.random() * 4.0,
            org[2] + k + Math.random() * 4.0,
          );
          dir.normalize();
          p.vel = dir.multiply(50.0 + Math.random() * 64.0);
        }
      }
    }
  }

  /**
   * Alternates the side tracer particles drift to, and their colors.
   */
  static tracercount = 0;
  /**
   * Lays particles along the line from `start` to `end`, one per few units. `type` selects the look: 0 rocket,
   * 1 grenade smoke, 2 blood, 3 and 5 tracers, 4 slight blood, 6 the voor trail, 7 like 1 but it lasts 8 seconds longer.
   */
  static RocketTrail(start: Vector, end: Vector, type: number): void {
    let vec = end.copy().subtract(start);

    const len = vec.len();

    if (len === 0.0 || !isFinite(len)) {
      return;
    }

    vec.normalize();

    let allocated;
    if (type === 4) {
      allocated = Particles.AllocParticles(Math.floor(len / 6.0));
    } else {
      allocated = Particles.AllocParticles(Math.floor(len / 3.0));
    }

    for (let i = 0; i < allocated.length; i++) {
      const p = Particles.particles[allocated[i]];
      p.vel = new Vector();
      p.die = clientRuntimeState.time + 2.0;
      switch (type) {
        case 7:
          type = 1;
          p.die += 8.0;
        // eslint-disable-next-line no-fallthrough
        case 0:
        case 1:
          p.ramp = Math.floor(Math.random() * 4.0) + (type << 1);
          p.color = Particles.ramp3[p.ramp];
          p.type = ParticleType.fire;
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 2:
          p.type = ParticleType.grav;
          p.color = 67 + Math.floor(Math.random() * 4.0);
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 3:
        case 5:
          p.die = clientRuntimeState.time + 0.5;
          p.type = ParticleType.tracer;
          if (type === 3) {
            p.color = 52 + ((Particles.tracercount++ & 4) << 1);
          } else {
            p.color = 230 + ((Particles.tracercount++ & 4) << 1);
          }
          p.org = new Vector(start[0], start[1], start[2]);
          if ((Particles.tracercount & 1) !== 0) {
            p.vel[0] = 30.0 * vec[1];
            p.vel[2] = -30.0 * vec[0];
          } else {
            p.vel[0] = -30.0 * vec[1];
            p.vel[2] = 30.0 * vec[0];
          }
          break;
        case 4:
          p.type = ParticleType.grav;
          p.color = 67 + Math.floor(Math.random() * 4.0);
          p.org = new Vector(
            start[0] + Math.random() * 6.0 - 3.0,
            start[1] + Math.random() * 6.0 - 3.0,
            start[2] + Math.random() * 6.0 - 3.0,
          );
          break;
        case 6:
          p.color = 152 + Math.floor(Math.random() * 4.0);
          p.type = ParticleType.tracer;
          p.die = clientRuntimeState.time + 0.3;
          p.org = new Vector(
            start[0] + Math.random() * 16.0 - 8.0,
            start[1] + Math.random() * 16.0 - 8.0,
            start[2] + Math.random() * 16.0 - 8.0,
          );
          break;
        default:
          console.assert(false, 'Unknown particle type: ' + type);
      }
      start.add(vec);
    }
  }

  /**
   * Reads what the simulation of one frame needs from the clock and the server: how long the frame is and how much
   * gravity pulls on particles in it.
   * @returns The constants to pass to every {@link Particles.RenderAndAdvance} call of this frame.
   */
  static BeginFrame(): ParticleFrame {
    const frameTime = Host.frametime;
    const gravity = +clientStaticState.serverInfo.sv_gravity || 800;

    return {
      coords: BILLBOARD_COORDS,
      frameTime,
      grav: frameTime * gravity * 0.05,
      dvel: frameTime * 4.0,
    };
  }

  /**
   * Draws and advances all live particles in one pass, used when the map has no world model to sort against.
   */
  static Draw(): void {
    GL.StreamFlush();

    GL.UseProgram('particle');
    gl.depthMask(false);
    gl.enable(gl.BLEND);

    const frame = Particles.BeginFrame();

    for (let i = 0; i < Particles.numparticles; i++) {
      const p = Particles.particles[i];
      if (p.die < clientRuntimeState.time) {
        continue;
      }

      Particles.RenderAndAdvance(p, frame);
    }

    GL.StreamFlush();

    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  /**
   * Finds free slots in the pool.
   * @returns Up to `count` slot indices, fewer when the pool is nearly full.
   */
  static AllocParticles(count: number): number[] {
    const allocated = new Array<number>(count);
    for (let i = 0, j = 0; i < Particles.numparticles; i++) {
      if (count === 0) {
        return allocated;
      }
      if (Particles.particles[i].die < clientRuntimeState.time) {
        allocated[j++] = i;
        count--;
      }
    }
    allocated.length = allocated.length - count;
    return allocated;
  }
}

export default Particles;
