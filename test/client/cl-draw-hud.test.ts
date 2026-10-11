import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import CL from '../../source/engine/client/CL.ts';
import clientCvars from '../../source/engine/client/ClientCvars.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import type { ClientGameInterface } from '../../source/shared/GameInterfaces.ts';
import { patchMembers } from '../support/clientState.ts';

void describe('CL.DrawHUD', () => {
  let restores: Array<() => void> = [];
  let calls: string[] = [];

  /**
   * Makes a game that records what the engine asked of it.
   * @param members Which of the optional hooks it has.
   * @returns The game.
   */
  function createGame(members: { readonly overlay: boolean }): ClientGameInterface {
    const game = {
      draw: (): void => { calls.push('draw'); },
    } as unknown as ClientGameInterface;

    if (members.overlay) {
      (game as { drawOverlay?: () => void }).drawOverlay = (): void => { calls.push('drawOverlay'); };
    }

    return game;
  }

  /**
   * Installs a game and the `nohud` variable.
   * @param game The game the client runs.
   * @param nohud The value of `cl_nohud`.
   */
  function install(game: ClientGameInterface | null, nohud: number): void {
    restores.push(
      patchMembers(clientRuntimeState, { gameAPI: game }),
      patchMembers(clientCvars, { nohud: { value: nohud } as Cvar }),
    );
  }

  beforeEach(() => {
    restores = [];
    calls = [];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }
  });

  void test('draws the HUD and then the overlay of the game', () => {
    install(createGame({ overlay: true }), 0);

    CL.DrawHUD();

    assert.deepEqual(calls, ['draw', 'drawOverlay']);
  });

  void test('skips the HUD with nohud and still draws the overlay', () => {
    install(createGame({ overlay: true }), 1);

    CL.DrawHUD();

    assert.deepEqual(calls, ['drawOverlay']);
  });

  void test('draws only the HUD for a game that has no overlay', () => {
    install(createGame({ overlay: false }), 0);

    CL.DrawHUD();

    assert.deepEqual(calls, ['draw']);
  });

  void test('draws nothing for a game that has no overlay with nohud', () => {
    install(createGame({ overlay: false }), 1);

    CL.DrawHUD();

    assert.deepEqual(calls, []);
  });

  void test('does nothing before a game is there', () => {
    install(null, 0);

    assert.doesNotThrow(() => { CL.DrawHUD(); });
  });
});
