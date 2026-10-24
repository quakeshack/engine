import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { GameFolder } from '../common/SearchPathAssetSource.ts';

/**
 * A game folder on disk (`data/` for the dedicated server). Files are opened as blobs, so a pak is read in ranges,
 * never whole.
 */
export class NodeGameFolder implements GameFolder {
  readonly #root: string;

  /**
   * @param root The folder, relative to the working directory or absolute.
   */
  constructor(root: string) {
    this.#root = root;
  }

  async open(path: string): Promise<Blob | null> {
    // Paths come from the network too (`/qfs/`), nothing may leave the folder.
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      return null;
    }

    const fullPath = join(this.#root, path);

    try {
      if (!(await stat(fullPath)).isFile()) {
        return null;
      }

      return await openAsBlob(fullPath);
    } catch (_error) {
      return null;
    }
  }
}
