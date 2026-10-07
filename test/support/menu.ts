import M from '../../source/engine/client/Menu.ts';
import { patchMembers } from './clientState.ts';

/**
 * Makes the engine's real menu look like what a test mocked as `registry.M`: the parts of the client that use
 * the menu import it directly, so a test that wants other values or methods sets them on the real one.
 * @param mockedMenu What the test installed as `registry.M`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real menu back.
 */
export function useMenuOf(mockedMenu: object | null | undefined): () => void {
  return patchMembers(M, mockedMenu ?? undefined);
}
