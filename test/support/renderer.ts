import R from '../../source/engine/client/R.ts';
import { installRenderContext } from '../../source/engine/client/renderer/RenderContext.ts';
import { patchMembers } from './clientState.ts';

/**
 * Makes the engine's real renderer look like what a test mocked as `engineMocks.R`: the parts of the client that
 * use the renderer import it directly, so a test that wants other values or methods sets them on the real one; the
 * materials and the sky draw with the renderer mock itself.
 * @param mockedRenderer What the test installed as `engineMocks.R`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real renderer back.
 */
export function useRendererOf(mockedRenderer: object | null | undefined): () => void {
  const restoreMembers = patchMembers(R, mockedRenderer ?? undefined);
  const restoreContext = mockedRenderer === null || mockedRenderer === undefined ? () => {} : installRenderContext({ renderer: mockedRenderer as never });

  return () => {
    restoreContext();
    restoreMembers();
  };
}
