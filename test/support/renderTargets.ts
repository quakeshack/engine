import GL, { type GLRenderTexture } from '../../source/engine/client/GL.ts';
import type RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';

/** Value of `gl.FRAMEBUFFER`, so a fake target can bind without a real context constant. */
const FRAMEBUFFER = 0x8D40;

/**
 * A render target that allocates nothing. Binding it tells the page's `GL.gl` (when that has a `bindFramebuffer`)
 * which framebuffer was bound, so a test that watches the context still sees the order of bindings; every call is
 * also appended to `log`. It is never `RenderTarget.bound`, so a test that runs passes of the frame over fakes
 * silences `console.assert` for the checks of `Frame`.
 * @param name Names the target and its textures.
 * @param log Receives one line per call, `bind <name>` and so on.
 * @returns The fake, typed as the real class.
 */
export function createFakeRenderTarget(name: string, log: string[] = []): RenderTarget {
  const framebuffer = { id: `${name} framebuffer` } as unknown as WebGLFramebuffer;
  const textures = new Map<number, GLRenderTexture>();

  const fake = {
    name,
    framebuffer,
    width: 0,
    height: 0,
    samples: 0,
    depthTexture: null,
    depthRenderbuffer: null,

    bind(): void {
      log.push(`bind ${name}`);
      (GL.gl as Partial<WebGL2RenderingContext> | null)?.bindFramebuffer?.(FRAMEBUFFER, framebuffer);
    },

    bindForRead(): void {
      log.push(`bind ${name} for read`);
    },

    bindForDraw(): void {
      log.push(`bind ${name} for draw`);
    },

    isAttached(): boolean {
      return false;
    },

    colorTexture(index = 0): GLRenderTexture {
      let texture = textures.get(index);

      if (texture === undefined) {
        texture = { id: `${name} color ${index}` } as unknown as GLRenderTexture;
        textures.set(index, texture);
      }

      return texture;
    },

    resize(width: number, height: number, samples = 0): void {
      log.push(`resize ${name} ${width}x${height} samples ${samples}`);
      fake.width = width;
      fake.height = height;
      fake.samples = samples;
    },

    attachDepthCubeFace(_texture: WebGLTexture, face: number): void {
      log.push(`attach ${name} cube face ${face}`);
    },

    swapDepthToRenderbuffer(): void {
      log.push(`swap depth of ${name} to a renderbuffer`);
    },

    restoreDepthTexture(): void {
      log.push(`restore depth texture of ${name}`);
    },

    free(): void {
      log.push(`free ${name}`);
    },
  };

  return fake as unknown as RenderTarget;
}
