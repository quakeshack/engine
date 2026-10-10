import R from '../../source/engine/client/R.ts';
import { installRenderContext } from '../../source/engine/client/renderer/resources/RenderContext.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import Visibility from '../../source/engine/client/renderer/scene/Visibility.ts';
import { patchMembers } from './clientState.ts';

/** Members that were on the renderer and now live on `Camera`. */
const CAMERA_MEMBERS = new Set([
  'refdef', 'vpn', 'vup', 'vright', 'frustum', 'viewMatrix', 'projectionMatrix', 'perspective', 'CullBox', 'WorldToScreen',
]);

/** Members that were on the renderer and now live on `Visibility`, under the name they have there. */
const VISIBILITY_MEMBERS: Record<string, string> = {
  visframecount: 'visframecount',
  viewleaf: 'viewleaf',
  oldviewleaf: 'oldviewleaf',
  drawsky: 'skyVisible',
};

/** Console variables that were on the renderer and now live in `rendererCvars`. */
const CVAR_MEMBERS = new Set(['novis', 'fog_color', 'fog_start', 'fog_end', 'fog_density', 'fog_mode']);

/**
 * Sorts the members of a renderer mock by where the real ones live now.
 * @param mockedRenderer What the test mocked.
 * @returns One object per owner, `undefined` where the mock has nothing for it.
 */
function splitRendererMock(mockedRenderer: object | null | undefined): { camera?: object; visibility?: object; cvars?: object; renderer?: object } {
  if (mockedRenderer === null || mockedRenderer === undefined) {
    return {};
  }

  const camera: Record<string, unknown> = {};
  const visibility: Record<string, unknown> = {};
  const cvars: Record<string, unknown> = {};
  const renderer: Record<string, unknown> = {};

  for (const name of Object.getOwnPropertyNames(mockedRenderer)) {
    const descriptor = Object.getOwnPropertyDescriptor(mockedRenderer, name)!;
    const value: unknown = 'value' in descriptor ? descriptor.value : (mockedRenderer as Record<string, unknown>)[name];

    if (CAMERA_MEMBERS.has(name)) {
      camera[name] = value;
    } else if (name in VISIBILITY_MEMBERS) {
      visibility[VISIBILITY_MEMBERS[name]] = value;
    } else if (CVAR_MEMBERS.has(name)) {
      cvars[name] = value;
    } else {
      renderer[name] = value;
    }
  }

  return { camera, visibility, cvars, renderer };
}

/**
 * Makes the engine's real renderer look like what a test mocked as `engineMocks.R`: the parts of the client that
 * use the renderer import it directly, so a test that wants other values or methods sets them on the real one; the
 * materials and the sky draw with the renderer mock itself. Members that moved out of `R` are set where they live
 * now (`Camera`, `Visibility`, `rendererCvars`), so a mock written in terms of the old facade keeps working.
 * @param mockedRenderer What the test installed as `engineMocks.R`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real renderer back.
 */
export function useRendererOf(mockedRenderer: object | null | undefined): () => void {
  const parts = splitRendererMock(mockedRenderer);
  const restores = [
    patchMembers(R, parts.renderer),
    patchMembers(Camera, parts.camera),
    patchMembers(Visibility, parts.visibility),
    patchMembers(rendererCvars, parts.cvars),
  ];
  const restoreContext = mockedRenderer === null || mockedRenderer === undefined ? () => {} : installRenderContext({ renderer: mockedRenderer as never });

  return () => {
    restoreContext();

    for (const restore of restores.reverse()) {
      restore();
    }
  };
}
