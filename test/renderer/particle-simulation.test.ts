import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import Particles, { type Particle, ParticleType } from '../../source/engine/client/renderer/effects/Particles.ts';
import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { useHostOf } from '../support/host.ts';
import { assertNear } from '../support/assertions.ts';

const FRAME_TIME = 0.1;
const GRAVITY = 400;

// the engine's gravity scale for particles: frametime * sv_gravity * 0.05
const GRAV = FRAME_TIME * GRAVITY * 0.05;
const DVEL = FRAME_TIME * 4.0;

/**
 * Creates a particle of a type, moving with a velocity.
 * @param type Particle type.
 * @param velocity Velocity in units per second.
 * @param ramp Position in the color ramp.
 * @returns The particle.
 */
function createParticle(type: ParticleType, velocity: Vector, ramp = 0.0): Particle {
  return { die: 1e6, color: 0, ramp, type, org: new Vector(0, 0, 0), vel: velocity };
}

void describe('particle simulation', () => {
  let restores: Array<() => void> = [];

  beforeEach(() => {
    restores = [
      useHostOf({ frametime: FRAME_TIME }),
      useClientStateOf({
        state: { time: 100.0 },
        cls: { serverInfo: { sv_gravity: String(GRAVITY) } },
        // open air: nothing is ever hit, so the collision path moves the particle straight on
        collision: { pointContents: () => content.CONTENT_EMPTY },
      }),
    ];

    mock.method(GL, 'StreamGetSpace', () => {});
    mock.method(GL, 'StreamWriteFloat3', () => {});
    mock.method(GL, 'StreamWriteFloat2', () => {});
    mock.method(GL, 'StreamWriteFloat', () => {});
    mock.method(GL, 'StreamWriteUByte4', () => {});
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void describe('BeginFrame', () => {
    void test('scales gravity and velocity decay with the frame time', () => {
      const frame = Particles.BeginFrame();

      assert.equal(frame.frameTime, FRAME_TIME);
      assertNear(frame.grav, GRAV);
      assertNear(frame.dvel, DVEL);
      assert.equal(frame.coords.length, 12, 'six corners, two numbers each');
    });

    void test('falls back to 800 when the server did not tell its gravity', () => {
      restores.push(useClientStateOf({ cls: { serverInfo: {} } }));

      assertNear(Particles.BeginFrame().grav, FRAME_TIME * 800 * 0.05);
    });
  });

  void describe('RenderAndAdvance', () => {
    void test('emits one billboard of six vertices', () => {
      let vertices = 0;

      mock.method(GL, 'StreamWriteUByte4', () => { vertices++; });

      Particles.RenderAndAdvance(createParticle(ParticleType.tracer, new Vector(0, 0, 0)), Particles.BeginFrame());

      assert.equal(vertices, 6);
    });

    void test('moves a tracer by its velocity and leaves the velocity alone', () => {
      const particle = createParticle(ParticleType.tracer, new Vector(10, 0, -20));

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assert.deepEqual([...particle.org], [1, 0, -2]);
      assert.deepEqual([...particle.vel], [10, 0, -20]);
    });

    void test('pulls a gravity particle down by the frame gravity', () => {
      const particle = createParticle(ParticleType.grav, new Vector(0, 0, 0));

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assertNear(particle.vel[2], -GRAV);
    });

    void test('lets fire rise and walks it along its color ramp', () => {
      const particle = createParticle(ParticleType.fire, new Vector(0, 0, 0), 0.0);

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assertNear(particle.ramp, FRAME_TIME * 5.0);
      assert.equal(particle.color, Particles.ramp3[0]);
      assertNear(particle.vel[2], GRAV);
    });

    void test('kills fire when its ramp runs out', () => {
      const particle = createParticle(ParticleType.fire, new Vector(0, 0, 0), 5.9);

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assert.equal(particle.die, -1.0);
    });

    void test('accelerates an explosion particle outward while it falls', () => {
      const particle = createParticle(ParticleType.explode, new Vector(100, 0, 0), 0.0);

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assertNear(particle.vel[0], 100 + 100 * DVEL);
      assertNear(particle.vel[2], -GRAV);
      // the ramp advances first: 0 + 0.1 * 10 = 1.0
      assert.equal(particle.color, Particles.ramp1[1]);
    });

    void test('slows the second kind of explosion down', () => {
      const particle = createParticle(ParticleType.explode2, new Vector(100, 0, 0), 0.0);

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assertNear(particle.vel[0], 100 - 100 * FRAME_TIME);
      // 0 + 0.1 * 15 = 1.5
      assert.equal(particle.color, Particles.ramp2[1]);
    });

    void test('kills an explosion particle when its ramp runs out', () => {
      const particle = createParticle(ParticleType.explode, new Vector(0, 0, 0), 7.5);

      Particles.RenderAndAdvance(particle, Particles.BeginFrame());

      assert.equal(particle.die, -1.0);
    });
  });
});
