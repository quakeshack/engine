import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import W, { WadFileInterface } from '../common/W.mjs';
import { eventBus, registry } from '../registry.mjs';

let { Con, Draw } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Draw = registry.Draw;
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

  showEntries() {
    const win = window.open('about: blank', '_blank', 'width=800,height=600');
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
        $img.src = Draw.Pic32ToDataURL(this.wad.getLumpMipmap(entry, 0));
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
    const tool = new GfxTool(wad);

    await tool.load();

    switch (command) {
      case 'list':
        tool.printEntries();
        break;

      case 'show':
        tool.showEntries();
        break;

      default:
        Con.Print(`Unknown command: ${command}\n`);
        Con.Print('Usage: gfx <wadfile> [list]\n');
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
