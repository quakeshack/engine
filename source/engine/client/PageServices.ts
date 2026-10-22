import type { BuildConfig, URLs } from '../build-config';
import type COM from '../common/Com.ts';
import type NET from '../network/Network.ts';
import type { ClientEngineAPI } from './ClientEngineAPI.ts';

/**
 * The services that belong to the page and that the client modules share: the file system and command line, the
 * network layer, and where the build says its servers are. There is exactly one of each per page; they are built by
 * the composition root (`createBrowserClient`), which installs them once before anything runs. Importers read the live
 * bindings, so there is no lookup table and nothing to subscribe to; reading one before installation yields `null`.
 */
export let com: COM = null!;

/** The page's network layer, see {@link com}. */
export let net: NET = null!;

/** What the game's client side sees of the engine, see {@link com}. */
export let engineApi: ClientEngineAPI = null!;

/** Where the signaling and master servers are reached, `null` until installed. */
export let urls: URLs | null = null;

/** The build the page was made by, `null` until installed. */
export let buildConfig: BuildConfig | null = null;

/** What {@link installPageServices} takes: every member is optional so that a test can install only what it exercises. */
export interface PageServicesInstall {
  readonly com?: COM;
  readonly net?: NET;
  readonly engineApi?: ClientEngineAPI;
  readonly urls?: URLs | null;
  readonly buildConfig?: BuildConfig | null;
}

/**
 * Installs the page's services. Called by the composition root once, and by tests with fakes.
 * @returns A function that puts back what was installed before.
 */
export function installPageServices(services: PageServicesInstall): () => void {
  const previous = { com, net, engineApi, urls, buildConfig };

  com = services.com === undefined ? com : services.com;
  net = services.net === undefined ? net : services.net;
  engineApi = services.engineApi === undefined ? engineApi : services.engineApi;
  urls = services.urls === undefined ? urls : services.urls;
  buildConfig = services.buildConfig === undefined ? buildConfig : services.buildConfig;

  return () => {
    ({ com, net, engineApi, urls, buildConfig } = previous);
  };
}
