import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import W, { WadFileInterface } from '../common/W.mjs';
import { eventBus, registry } from '../registry.mjs';

let { Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
});

class GfxTool {
  constructor(filename) {
    this.filename = filename;
    /** @type {WadFileInterface} */
    this.wad = null;
  }

  async load() {
    this.wad = await W.LoadFile(this.filename);
  }

  printEntries() {
    Con.Print(`Wad entries in ${this.filename} (${this.wad.constructor.name}):\n`);
    for (const entry of this.wad.getLumpNames()) {
      Con.Print(`${entry}\n`);
    }
  }

  showEntry(entry) {
    const win = window.open('about: blank', '_blank');
    const $document = win.document;
    const $img = $document.createElement('img');
    $img.src = this.wad.getLumpMipmap(entry, 0).toDataURL();
    $document.body.appendChild($img);
    $document.title = `Image - ${entry} (${this.filename})`;
  }

  showEntries() {
    const win = window.open('about: blank', '_blank');
    const $document = win.document;

    const $table = $document.createElement('table');
    $table.style.width = '100%';

    for (const entry of this.wad.getLumpNames()) {
      const $tr = $document.createElement('tr');

      const $tdName = $document.createElement('td');
      $tdName.textContent = entry;
      $tr.appendChild($tdName);

      const $tdImage = $document.createElement('td');
      try {
        const $img = $document.createElement('img');
        $img.src = this.wad.getLumpMipmap(entry, 0).toDataURL();
        $tdImage.appendChild($img);
      } catch (e) {
        $tdImage.textContent = `Error loading image: ${e.message}`;
      }
      $tr.appendChild($tdImage);

      $table.appendChild($tr);
    }

    $document.title = `Image Table - ${this.filename}`;
    $document.body.appendChild($table);
  }
}

class GfxToolCommand extends ConsoleCommand {
  async run(wad, command = null) {
    if (!wad) {
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

      case 'show':
        if (this.argv.length < 3) {
          Con.Print('Usage: gfx <wadfile> show <entry>\n');
          return;
        }
        try {
          tool.showEntry(this.argv[3]);
        } catch(e) {
          Con.PrintError(`Error showing entries: ${e.message}\n`);
        }
        break;

      default:
        Con.Print(`Unknown command: ${command}\n`);
        Con.Print('Usage: gfx <wadfile> [list|show-all|show]\n');
        break;
    }
  }
};

export default class Tools {
  static async Init() {
    Cmd.AddCommand('gfx', GfxToolCommand);
  }

  static Shutdown() {
  }
};
