import R from '../../source/engine/client/R.ts';
import { patchMembers } from './clientState.ts';

/**
 * Makes the engine's real renderer look like what a test mocked as `registry.R`: the parts of the client that
 * use the renderer import it directly, so a test that wants other values or methods sets them on the real one.
 * @param mockedRenderer What the test installed as `registry.R`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real renderer back.
 */
export function useRendererOf(mockedRenderer: object | null | undefined): () => void {
  return patchMembers(R, mockedRenderer ?? undefined);
}
