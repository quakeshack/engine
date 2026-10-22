import { ClientEngineAPI } from '../../source/engine/client/ClientEngineAPI.ts';

/**
 * Builds a client engine API for a test.
 * @param edition The edition of the game data the API reports; the registered game by default.
 * @returns A fresh instance, independent of the one the page installs.
 */
export function createClientEngineApi(edition = { registered: true, hipnotic: false, rogue: false }): ClientEngineAPI {
  return new ClientEngineAPI(() => edition);
}
