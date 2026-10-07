import { clientRuntimeState, clientStaticState } from '../../source/engine/client/ClientState.ts';
import CL from '../../source/engine/client/CL.ts';
import clientCvars, { ClientCvars } from '../../source/engine/client/ClientCvars.ts';
import { clientCollision, clientPmove } from '../../source/engine/client/ClientPhysics.ts';

interface ClientStateMock {
  readonly state?: object;
  readonly cls?: object;
  readonly pmove?: object;
  readonly collision?: object;
  readonly serverController?: unknown;
  readonly [member: string]: unknown;
}

const CVAR_NAMES = new Set(Object.keys(new ClientCvars()));

/** What of a mocked client is applied to the parts it was split into; every other member is a method or value of `CL` itself. */
const SPLIT_MEMBERS = new Set(['state', 'cls', 'pmove', 'collision', 'serverController', ...CVAR_NAMES]);

/**
 * Finds where a member is defined, on the object itself or further up its prototype chain.
 * @param target The object.
 * @param key The member.
 * @returns The descriptor and whether it belongs to the object itself, `null` when there is none.
 */
function findMember(target: object, key: string): { readonly descriptor: PropertyDescriptor; readonly own: boolean } | null {
  let owner: object | null = target;

  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);

    if (descriptor !== undefined) {
      return { descriptor, own: owner === target };
    }

    owner = Object.getPrototypeOf(owner) as object | null;
  }

  return null;
}

/**
 * Sets the members of an object a test wants to be different, and remembers what they were.
 * @param target The real object.
 * @param overrides What a test wants it to be. A member mocked as a getter (a clock it advances) is followed live.
 * @returns A function that puts the members back.
 */
export function patchMembers(target: object, overrides: object | undefined): () => void {
  const record = target as Record<string, unknown>;
  const undo: Array<() => void> = [];

  for (const key of Object.getOwnPropertyNames(overrides ?? {})) {
    const wanted = Object.getOwnPropertyDescriptor(overrides, key)!;
    const found = findMember(target, key);
    const previousValue = record[key];
    const hasSetter = found?.descriptor.set !== undefined;
    const isAccessorWithoutSetter = found !== null && found.descriptor.get !== undefined && !hasSetter;

    if (wanted.get !== undefined || isAccessorWithoutSetter) {
      // Shadows the member on the object; the object's own member comes back when the shadow is removed.
      const ownBefore = found !== null && found.own ? found.descriptor : null;

      Object.defineProperty(target, key, wanted.get !== undefined
        ? { get: wanted.get, configurable: true, enumerable: true }
        : { value: wanted.value as unknown, writable: true, configurable: true, enumerable: true });
      undo.push(() => {
        delete record[key];

        if (ownBefore !== null) {
          Object.defineProperty(target, key, ownBefore);
        }
      });
    } else if (hasSetter || (found !== null && found.own)) {
      record[key] = wanted.value as unknown;
      undo.push(() => { record[key] = previousValue; });
    } else {
      // Not a member of the object itself (a method of its class, or nothing yet): an own member shadows it.
      record[key] = wanted.value as unknown;
      undo.push(() => { delete record[key]; });
    }
  }

  return () => {
    for (const restore of undo.reverse()) {
      restore();
    }
  };
}

/**
 * Makes the engine's real client state look like what a test mocked as `registry.CL`: the parts of the
 * client that read the state import it directly, so a test that wants other values sets them on the real one.
 * @param mockedClient What the test installed as `registry.CL`: `state`, `cls`, `pmove`, `collision`, the console variables and the methods of `CL` are applied.
 * @returns A function that puts the real state back.
 */
export function useClientStateOf(mockedClient: ClientStateMock | null | undefined): () => void {
  const cvars = Object.fromEntries(Object.entries(mockedClient ?? {}).filter(([name]) => CVAR_NAMES.has(name)));
  const ownMembers = Object.fromEntries(Object.entries(mockedClient ?? {}).filter(([name]) => !SPLIT_MEMBERS.has(name) && name in CL));
  const restores = [
    patchMembers(clientRuntimeState, mockedClient?.state),
    patchMembers(clientStaticState, mockedClient?.serverController === undefined ? mockedClient?.cls : { ...mockedClient.cls, serverController: mockedClient.serverController }),
    patchMembers(clientCvars, cvars),
    patchMembers(clientPmove, mockedClient?.pmove),
    patchMembers(clientCollision, mockedClient?.collision),
    patchMembers(CL, ownMembers),
  ];

  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}
