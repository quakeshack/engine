import { engineMocks } from './engineMocks.ts';
import { useClientStateOf } from './clientState.ts';
import { useHostOf } from './host.ts';
import { useMenuOf } from './menu.ts';
import { useRendererOf } from './renderer.ts';

/** The mocks that are also patched onto the real object the engine's parts import, by their name in `engineMocks`. */
const realObjectHooks: Record<string, (installed: unknown) => () => void> = {
  CL: useClientStateOf,
  Host: useHostOf,
  M: useMenuOf,
  R: useRendererOf,
};

/**
 * Installs mocks in `engineMocks`. `CL`, `Host`, `M` and `R` are also patched onto the real client state, host, menu
 * and renderer, as the `use...Of` helpers do.
 * @param mocks The mocks by the name the engine's parts know them by (`Con`, `Host`, `NET`, ...).
 * @returns A function that puts back what was there before.
 */
export function installEngineMocks(mocks: Record<string, unknown>): () => void {
  const previous = Object.keys(mocks).map((name): [string, unknown] => [name, engineMocks[name]]);
  const restores: Array<() => void> = [];

  for (const [name, mock] of Object.entries(mocks)) {
    engineMocks[name] = mock;

    if (name in realObjectHooks) {
      restores.push(realObjectHooks[name](engineMocks[name]));
    }
  }

  return () => {
    for (const undo of restores.reverse()) {
      undo();
    }

    for (const [name, value] of previous.reverse()) {
      engineMocks[name] = value;
    }
  };
}

/**
 * Installs mocks in `engineMocks` for the duration of a callback and puts back what was there before, whether the
 * callback returns, throws, or (when it returns a promise) settles.
 * @param mocks The mocks by the name the engine's parts know them by (`Con`, `Host`, `NET`, ...), see `installEngineMocks`.
 * @param callback The test body.
 * @returns What the callback returned.
 */
export function withEngineMocks<T>(mocks: Record<string, unknown>, callback: () => T): T {
  const restore = installEngineMocks(mocks);
  let result: T;

  try {
    result = callback();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }

  restore();

  return result;
}
