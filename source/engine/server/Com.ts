import { promises as fsPromises } from 'fs';

import COM from '../common/Com.ts';
import type { AssetSource } from '../common/AssetSource.ts';
import { SearchPathAssetSource } from '../common/SearchPathAssetSource.ts';
import { NodeGameFolder } from './NodeGameFolder.ts';

/**
 * The `COM` of Node.js: the dedicated server and its workers. Content is read from `data/` below the working
 * directory through Quake's search path (paks and loose files), files are written there directly.
 */
export default class NodeCOM extends COM {
  /** Reads through `searchpaths`, so a worker that receives them as data reads the same files. */
  readonly #files = new SearchPathAssetSource(new NodeGameFolder('data'), () => this.searchpaths);

  override assetSource: AssetSource | null = this.#files;

  /** Content comes from {@link NodeCOM.assetSource}; Node has no user store, the engine writes into `data/`. */
  override async InitStorage(): Promise<void> {
    // nothing to set up
  }

  override Shutdown(): void {
  }

  override async WriteFile(filename: string, data: ArrayLike<number>, _len: number): Promise<boolean> { // FIXME: len is actually required, needs to be async
    const filepath = `data/${this.searchpaths[this.searchpaths.length - 1].filename}/${filename.toLowerCase()}`;

    try {
      await fsPromises.writeFile(filepath, Uint8Array.from(data));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.sys.Print(`COM.WriteFile: failed on ${filename}, ${message}\n`);
      return false;
    }
    this.sys.Print(`COM.WriteFile: ${filename}\n`);
    return true;
  }

  override async WriteTextFile(filename: string, data: string): Promise<boolean> {
    const filepath = `data/${this.searchpaths[this.searchpaths.length - 1].filename}/${filename.toLowerCase()}`;

    try {
      await fsPromises.writeFile(filepath, data);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.sys.Print(`COM.WriteTextFile: failed on ${filename}, ${message}\n`);
      return false;
    }
    this.sys.Print(`COM.WriteTextFile: ${filename}\n`);
    return true;
  }

  override async AddGameDirectory(dir: string): Promise<void> {
    const { search, paks } = await this.#files.loadGameDirectory(dir);

    for (const { path, directory } of paks) {
      // id's check for the registered version: an unmodified id1/pak0.pak has 339 files and this directory checksum.
      if (directory.entries.length !== 339 || (directory.entries.length > 0 && directory.checksum !== 32981)) {
        this.modified = true;
      }

      this.con.Print(`Added packfile ${path} (${directory.entries.length} files)\n`);
    }

    this.searchpaths.push(search);
  }

  override Path_f(): void {
    this.con.Print('Current search path:\n');
    for (let i = this.searchpaths.length - 1; i >= 0; i--) {
      const s = this.searchpaths[i];
      this.con.Print(`  ${s.filename}/ (virtual Quake filesystem)\n`);
    }
  }
}

