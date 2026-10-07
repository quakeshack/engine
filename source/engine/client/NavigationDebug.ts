import Vector from '../../shared/Vector.ts';
import { getClientRegistry } from '../registry.ts';
import { eventBus } from '../common/EventBus.ts';
import Con from '../common/Console.ts';
import { clientRuntimeState } from './ClientState.ts';

type VectorTuple = readonly [number, number, number];

let { R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ R } = getClientRegistry());
});

/**
 * Draws the navigation debug visualization. The server only says where a dot belongs
 * (`nav.debug.emit-dot.*`), turning it into a particle is the renderer's business.
 */
export default class NavigationDebug {
  /**
   * Subscribes to the debug dot events of the navigation system. Call once at client startup.
   */
  static Init(): void {
    eventBus.subscribe('nav.debug.emit-dot.temporarily', (position: VectorTuple, color: number, ttl: number): void => {
      NavigationDebug.#emitDot(new Vector(...position), color, ttl);
    });

    eventBus.subscribe('nav.debug.emit-dot.permanently', (position: VectorTuple, color: number): void => {
      NavigationDebug.#emitDot(new Vector(...position), color, Infinity);
    });
  }

  static #emitDot(position: Vector, color: number, ttl: number): void {
    const pn = R.AllocParticles(1);

    if (pn.length !== 1) {
      Con.PrintWarning(`Navigation: failed to allocate particle for debug dot at [${position}]\n`);
      return;
    }

    const p = R.particles[pn[0]];
    p.die = clientRuntimeState.time + ttl;
    p.color = color;
    p.vel = new Vector(0, 0, 0);
    p.org = position.copy();
    p.type = R.ptype.tracer;
  }
}
