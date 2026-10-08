import type R from '../R.ts';
import type { ClientRuntimeState } from '../ClientState.ts';
import type { GLTexture } from '../GL.ts';

/** The renderer as the materials and the sky see it. */
export type RendererView = typeof R;

const nullTexture: GLTexture = {
  bind() {},
  free() {},
} as unknown as GLTexture;

/**
 * No renderer is available in headless mode (the server, a worker, tests), so materials read the few members
 * of it they need from this stand-in instead.
 * @returns The stand-in.
 */
function createHeadlessRenderer(): RendererView {
  return {
    blacktexture: nullTexture,
    notexture: nullTexture,
    flatnormalmap: nullTexture,
    interpolation: { value: false },
    c_brush_texture_binds: 0,
  } as unknown as RendererView;
}

/**
 * What the materials and the sky read at draw time: the renderer and the client state. The model loaders create
 * them in a server worker too, where there is neither, so this module imports nothing at run time (the client
 * must not be loaded there). The page installs the real ones before anything is drawn; until then, and in a
 * realm that never does, the renderer is a headless stand-in and the state is `null`.
 */
export let renderer: RendererView = createHeadlessRenderer();

/** The client state, see {@link renderer}. */
export let clientState: ClientRuntimeState = null!;

/** What {@link installRenderContext} takes. */
export interface RenderContextInstall {
  readonly renderer?: RendererView;
  readonly clientState?: ClientRuntimeState;
}

/**
 * Installs the renderer and the client state that materials and the sky draw with.
 * @returns A function that puts back what was installed before.
 */
export function installRenderContext(context: RenderContextInstall): () => void {
  const previous = { renderer, clientState };

  renderer = context.renderer ?? renderer;
  clientState = context.clientState ?? clientState;

  return () => {
    ({ renderer, clientState } = previous);
  };
}
