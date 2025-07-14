import { registry } from './registry.mjs';

export default class EngineLauncher {
  static async Launch() {
    console.log('Launching engine in browser mode...');

    registry.isDedicatedServer = false;
  }
};
