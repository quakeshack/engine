import Draw from '../../source/engine/client/Draw.ts';
import IN from '../../source/engine/client/IN.ts';
import Key from '../../source/engine/client/Key.ts';
import S from '../../source/engine/client/Sound.ts';
import SCR from '../../source/engine/client/SCR.ts';
import V from '../../source/engine/client/V.ts';
import * as services from '../../source/engine/client/PageServices.ts';
import { patchMembers } from './clientState.ts';

type Restore = () => void;

/** The static facades of the client: a mock is patched onto the real one. */
const facades: Record<string, object> = { Draw, IN, Key, S, SCR, V };

/** The page services, which are installed by assignment (what a test read before is what it puts back). */
const pageServiceKeys: Record<string, 'com' | 'net' | 'urls' | 'buildConfig'> = {
  COM: 'com',
  NET: 'net',
  urls: 'urls',
  buildConfig: 'buildConfig',
};

interface Slot {
  value: unknown;
  restore: Restore | null;
}

const slots = new Map<string, Slot>();

/**
 * Applies a mock where the engine's parts read it.
 * @returns A function that takes it away again, or `null` when the name is only held.
 */
function restoreFor(name: string, mock: object): Restore | null {
  return name in facades ? patchMembers(facades[name], mock) : null;
}

/**
 * Where a test puts the mocks it wants the engine's parts to see, under the names they are known by. Assigning a
 * mock to a facade (`engineMocks.Key = {...}`) patches it onto the real one, and assigning what was read before puts
 * the real one back; the page services (`COM`, `NET`, `urls`, `buildConfig`) are installed as they are assigned.
 * Everything else (`R`, `CL`, `Host`, `M`, `Con`, `SV`, `Mod`, `Sys`) is only held, for the test to read back, for
 * a helper such as `consoleBridge`, and for the `use...Of` helpers that patch the real client state, host, menu and
 * renderer.
 */
export const engineMocks: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  get(_target, name: string) {
    if (name in pageServiceKeys) {
      return services[pageServiceKeys[name]];
    }

    // A facade reads as the real one with the mock patched onto it, so state the engine changes is seen.
    if (name in facades) {
      return facades[name];
    }

    return slots.get(name)?.value;
  },
  set(_target, name: string, value: unknown) {
    if (name in pageServiceKeys) {
      services.installPageServices({ [pageServiceKeys[name]]: value ?? null });

      return true;
    }

    slots.get(name)?.restore?.();
    slots.delete(name);

    if (value !== null && value !== undefined && value !== facades[name]) {
      slots.set(name, { value, restore: restoreFor(name, value as object) });
    }

    return true;
  },
});
