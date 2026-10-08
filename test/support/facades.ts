import Draw from '../../source/engine/client/Draw.ts';
import IN from '../../source/engine/client/IN.ts';
import Key from '../../source/engine/client/Key.ts';
import S from '../../source/engine/client/Sound.ts';
import SCR from '../../source/engine/client/SCR.ts';
import V from '../../source/engine/client/V.ts';
import { patchMembers } from './clientState.ts';

type FacadeName = 'Draw' | 'IN' | 'Key' | 'S' | 'SCR' | 'V';

const realFacades: Record<FacadeName, object> = { Draw, IN, Key, S, SCR, V };
const patches = new Map<FacadeName, () => void>();

/**
 * Stands in for the registry entries of the static client facades in tests that mock one of them: the parts of the
 * client that use a facade import it directly, so a mock cannot be swapped in. Assigning a mock patches the members
 * the mock has onto the real facade, assigning the real one (what reading it returned before) puts them back.
 */
export const facades = new Proxy(realFacades, {
  get(target, name) {
    return target[name as FacadeName];
  },
  set(target, name, value) {
    const facade = name as FacadeName;

    patches.get(facade)?.();
    patches.delete(facade);

    if (value !== null && value !== undefined && value !== target[facade]) {
      patches.set(facade, patchMembers(target[facade], value as object));
    }

    return true;
  },
});
