import { NotImplementedError } from '../Errors.ts';

/**
 * Abstract base class for model format loaders.
 * Each format (BSP, MDL, SPR, OBJ, IQM, etc.) should implement this interface.
 */
export class ModelLoader {
  // eslint-disable-next-line jsdoc/require-returns-check
  /**
   * Get the magic number(s) that identify this format.
   * Magic numbers are read from the first 4 bytes of the file.
   * @returns {number[]} Array of magic numbers (uint32, little-endian)
   */
  getMagicNumbers() {
    throw new NotImplementedError('ModelLoader.getMagicNumbers must be implemented');
  }

  // eslint-disable-next-line jsdoc/require-returns-check
  /**
   * Get the file extension(s) this loader supports.
   * Used as a fallback when magic number detection isn't conclusive.
   * @returns {string[]} Array of file extensions (e.g., ['.bsp', '.mdl'])
   */
  getExtensions() {
    throw new NotImplementedError('ModelLoader.getExtensions must be implemented');
  }

  /**
   * Check if this loader can handle the given buffer/filename.
   * Default implementation checks magic number and extension.
   * @param {ArrayBuffer} buffer The file buffer to check
   * @param {string} filename The filename (for extension checking)
   * @returns {boolean} True if this loader can handle the file
   */
  canLoad(buffer, filename) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true); // little-endian
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();

    // Check magic number
    if (this.getExtensions().includes(ext) && this.getMagicNumbers().includes(magic)) {
      return true;
    }

    return false;
  }

  /**
   * Load the model from the buffer.
   * @param {ArrayBuffer} buffer The file buffer
   * @param {string} name The model name/path
   * @returns {Promise<import('./BaseModel.mjs').BaseModel>} The loaded model
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async load(buffer, name) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError('ModelLoader.load must be implemented');
  }

  // eslint-disable-next-line jsdoc/require-returns-check
  /**
   * Get a human-readable name for this loader.
   * @returns {string} Loader name (e.g., "BSP29", "Quake MDL", "Sprite")
   */
  getName() {
    throw new NotImplementedError('ModelLoader.getName must be implemented');
  }
}
