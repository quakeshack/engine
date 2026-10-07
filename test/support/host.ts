import Host from '../../source/engine/common/Host.ts';
import { patchMembers } from './clientState.ts';

/**
 * Makes the engine's real host look like what a test mocked as `registry.Host`: the parts of the engine that use
 * the host's clock and cvars import it directly, so a test that wants other values sets them on the real one.
 * @param mockedHost What the test installed as `registry.Host`; `null` or `undefined` changes nothing.
 * @returns A function that puts the real host back.
 */
export function useHostOf(mockedHost: object | null | undefined): () => void {
  return patchMembers(Host, mockedHost ?? undefined);
}
