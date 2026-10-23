import { eventBus } from '../../../common/EventBus.ts';
import { MissingResourceError } from '../../../common/Errors.ts';
import Host from '../../../common/Host.ts';
import Mod from '../../../common/Mod.ts';
import { DEFAULT_MODEL_LOAD_OPTIONS } from '../../../common/model/ModelLoadContext.ts';
import { ImageSpriteLoader } from '../../../common/model/loaders/ImageSpriteLoader.ts';
import { SpriteSPRLoader } from '../../../common/model/loaders/SpriteSPRLoader.ts';
import { SpriteModel } from '../../../common/model/SpriteModel.ts';
import type { SpriteAsset } from '../../../common/model/sprite/SpriteAsset.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import { com } from '../../PageServices.ts';
import { SpritePlayback, type SpriteClock } from './SpritePlayback.ts';

/** What a game can ask for when it loads a sprite for the screen. */
export interface LoadSpriteOptions {
  /**
   * Whether to look for the settings file next to the sprite (`<file>.json`). `false` is the hint of a game that
   * knows there is none; it saves the request.
   */
  readonly sidecar?: boolean;
  /**
   * The clock the playback follows: `'client'` (the default) is the client's game time, which the world's sprites
   * follow too; `'real'` is the wall clock, for what must not depend on the game's clock. Both run at the same speed
   * today, and neither stops while the game is paused.
   */
  readonly clock?: SpriteClock;
}

/**
 * The sprites the screen draws (HUD elements, screen effects), loaded through the same loaders as a world sprite but
 * kept apart from the model cache: they are not precached, not numbered and not tied to a map. An asset is loaded once
 * per file name and lives for the page, across map changes and disconnects; the GL context going away frees them.
 */
export default class SpriteAssets {
  /** The assets by file name, as promises so that two loads of one file in a row share the work. */
  static readonly #loads = new Map<string, Promise<SpriteAsset>>();

  /**
   * Loads a sprite file (any format a world sprite can be: GIF, PNG/APNG, WebP, Aseprite, Half-Life or Quake `.spr`)
   * and starts a playback of its first sequence.
   * @param filename The file in the game's search path.
   * @param options See {@link LoadSpriteOptions}.
   * @returns A new playback; calling this again for the same file shares the images but not the playback.
   * @throws MissingResourceError when the file does not exist, an error when it is no sprite.
   */
  static async Load(filename: string, options: LoadSpriteOptions = {}): Promise<SpritePlayback> {
    const sidecar = options.sidecar ?? true;
    // a load that skipped the sidecar is a different asset than one that read it
    const key = `${filename}${sidecar ? '' : '?nosidecar'}`;
    let load = SpriteAssets.#loads.get(key);

    if (load === undefined) {
      load = SpriteAssets.#load(filename, sidecar);
      SpriteAssets.#loads.set(key, load);
      // a failed load can be tried again
      load.catch(() => { SpriteAssets.#loads.delete(key); });
    }

    const asset = await load;

    return new SpritePlayback(asset, options.clock === 'real' ? SpriteAssets.#realTime : SpriteAssets.#clientTime);
  }

  /**
   * Frees the textures of all loaded sprites. The context they live in is gone, and so are their playbacks' pictures.
   */
  static Shutdown(): void {
    const loads = [...SpriteAssets.#loads.values()];

    SpriteAssets.#loads.clear();

    for (const load of loads) {
      load.then((asset) => { asset.free(); }, () => {});
    }
  }

  static async #load(filename: string, sidecar: boolean): Promise<SpriteAsset> {
    const buffer = await com.LoadFile(filename);

    if (buffer === null) {
      throw new MissingResourceError(filename);
    }

    // check before loading: any other model's loader would upload its data to the GPU for nothing
    const loader = Mod.modelLoaderRegistry.findLoader(buffer, filename);

    if (!(loader instanceof SpriteSPRLoader || loader instanceof ImageSpriteLoader)) {
      throw new Error(`${filename} is not a sprite (GIF, PNG, WebP, Aseprite or SPR)`);
    }

    const model = await loader.load(buffer, filename, { ...DEFAULT_MODEL_LOAD_OPTIONS, sidecar });

    console.assert(model instanceof SpriteModel && model.asset !== null, 'a sprite loader returns a sprite with its asset');

    return (model as SpriteModel).asset!;
  }

  static readonly #clientTime = (): number => clientRuntimeState.time;

  static readonly #realTime = (): number => Host.realtime;
}

eventBus.subscribe('gl.shutdown', () => { SpriteAssets.Shutdown(); });
