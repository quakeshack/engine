import Host from '../../source/engine/common/Host.ts';
import { patchMembers } from './clientState.ts';

/**
 * Makes the engine's real host look like what a test mocked as `registry.Host`: the parts of the engine that use
 * the host's clock and cvars import it directly, so a test that wants other values sets them on the real one.
 * @param installedHost What the test installed as `engineMocks.Host`, read back from there; `null` or `undefined` changes nothing.
 * @returns A function that puts the real host back.
 */
export function useHostOf(installedHost: unknown): () => void {
  return patchMembers(Host, (installedHost ?? undefined) as object | undefined);
}
