import { eventBus } from '../../source/engine/common/EventBus.ts';

/**
 * Publishes `gl.ready` the way `GL` does, for a test that has no real context. The subscribers read the context from
 * `GL.gl`, not from the event, so a test that needs one sets that.
 * @param gl What the event carries.
 */
export function publishGlReady(gl: WebGL2RenderingContext = {} as WebGL2RenderingContext): void {
  eventBus.publish('gl.ready', gl);
}
