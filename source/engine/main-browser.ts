import type { BuildConfig, URLs } from './build-config';

import { createBrowserClient } from './bootstrap/createBrowserClient.ts';

export default class EngineLauncher {
  static async Launch(urls: URLs, buildConfig: BuildConfig): Promise<void> {
    await createBrowserClient(urls, buildConfig);
  }
}
