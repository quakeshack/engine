import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import W, { WadFileInterface } from '../common/W.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

let { Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con } = getCommonRegistry());
});

/**
 * Returns a readable message for an unknown error value.
 * @returns Readable error message.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Looks up a renderable lump texture and throws when the entry cannot be decoded.
 * @returns Decoded lump texture.
 */
function getRequiredLumpTexture(wad: WadFileInterface, entry: string) {
  const texture = wad.getLumpMipmap(entry, 0);
  if (texture === null) {
    throw new Error(`Could not decode wad entry ${entry}`);
  }

  return texture;
}

class GfxTool {
  filename: string;
  wad: WadFileInterface | null = null;

  constructor(filename: string) {
    this.filename = filename;
  }

  async load(): Promise<void> {
    this.wad = await W.LoadFile(this.filename);
  }

  /**
   * Returns the loaded wad file.
   * @returns Loaded wad file.
   */
  getWad(): WadFileInterface {
    if (this.wad === null) {
      throw new Error(`Wad ${this.filename} was not loaded`);
    }

    return this.wad;
  }

  printEntries(): void {
    const wad = this.getWad();
    Con.Print(`Wad entries in ${this.filename} (${wad.constructor.name}):\n`);
    for (const entry of wad.getLumpNames()) {
      Con.Print(`${entry}\n`);
    }
  }

  showEntry(entry: string): void {
    const win = window.open('about:blank', '_blank');
    if (win === null) {
      throw new Error('Popup blocked while opening wad entry preview');
    }

    const wad = this.getWad();
    const doc = win.document;
    const image = doc.createElement('img');
    image.src = getRequiredLumpTexture(wad, entry).toDataURL();
    doc.body.appendChild(image);
    doc.title = `Image - ${entry} (${this.filename})`;
  }

  showEntries(): void {
    const win = window.open('about:blank', '_blank');
    if (win === null) {
      throw new Error('Popup blocked while opening wad browser');
    }

    const wad = this.getWad();
    const doc = win.document;
    const table = doc.createElement('table');
    table.style.width = '100%';

    for (const entry of wad.getLumpNames()) {
      const row = doc.createElement('tr');

      const nameCell = doc.createElement('td');
      nameCell.textContent = entry;
      row.appendChild(nameCell);

      const imageCell = doc.createElement('td');
      try {
        const image = doc.createElement('img');
        image.src = getRequiredLumpTexture(wad, entry).toDataURL();
        imageCell.appendChild(image);
      } catch (error: unknown) {
        imageCell.textContent = `Error loading image: ${getErrorMessage(error)}`;
      }
      row.appendChild(imageCell);

      table.appendChild(row);
    }

    doc.title = `Image Table - ${this.filename}`;
    doc.body.appendChild(table);
  }
}

class GfxToolCommand extends ConsoleCommand {
  override async run(wad?: string, command?: string): Promise<void> {
    if (wad === undefined) {
      Con.Print('Usage: gfx <wadfile> [list|show-all|show]\n');
      return;
    }

    const tool = new GfxTool(wad);

    await tool.load();

    switch (command) {
      case 'list':
        tool.printEntries();
        break;

      case 'show-all':
        tool.showEntries();
        break;

      case 'show': {
        const entry = this.argv[3];
        if (entry === undefined) {
          Con.Print('Usage: gfx <wadfile> show <entry>\n');
          return;
        }
        try {
          tool.showEntry(entry);
        } catch (error: unknown) {
          Con.PrintError(`Error showing entries: ${getErrorMessage(error)}\n`);
        }
        break;
      }

      default:
        Con.Print(`Unknown command: ${command}\n`);
        Con.Print('Usage: gfx <wadfile> [list|show-all|show]\n');
        break;
    }
  }
}

export default class Tools {
  static Init(): void {
    Cmd.AddCommand('gfx', GfxToolCommand);
  }

  static Shutdown(): void {
  }
}
