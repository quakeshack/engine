import Q from '../common/Q.mjs';
import { eventBus, registry } from '../registry.mjs';
import Tools from './Tools.mjs';

let { COM, Host, Key } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Host = registry.Host;
  Key = registry.Key;
});

eventBus.subscribe('host.crash', (error) => {
  console.error(error);
  document.getElementById('error').textContent = error.name + ': ' + error.message;
});

/**
 * @param {KeyboardEvent} event keyboard event
 * @returns {number|null} key code or null if not recognized
 */
function getModernKey(event) {
  // Physical key mappings - maintain WASD regardless of layout
  const physicalKeys = {
    'KeyW': 119,
    'KeyA': 97,
    'KeyS': 115,
    'KeyD': 100,

    'Space': Key.k.space,
    'ShiftLeft': Key.k.shift,
    'ShiftRight': Key.k.shift,
    'ControlLeft': Key.k.ctrl,
    'ControlRight': Key.k.ctrl,
    'AltLeft': Key.k.alt,
    'AltRight': Key.k.alt,
    'ArrowUp': Key.k.uparrow,
    'ArrowDown': Key.k.downarrow,
    'ArrowLeft': Key.k.leftarrow,
    'ArrowRight': Key.k.rightarrow,

    'F1': Key.k.f1,
    'F2': Key.k.f2,
    'F3': Key.k.f3,
    'F4': Key.k.f4,
    'F5': Key.k.f5,
    'F6': Key.k.f6,
    'F7': Key.k.f7,
    'F8': Key.k.f8,
    'F9': Key.k.f9,
    'F10': Key.k.f10,
    'F11': Key.k.f11,
    'F12': Key.k.f12,
  };

  // Logical key mappings - use actual key value
  const logicalKeys = {
    'Enter': Key.k.enter,
    'Backspace': Key.k.backspace,
    'Tab': Key.k.tab,
    'Escape': Key.k.escape,
    'Pause': Key.k.pause,
    'PageUp': Key.k.pgup,
    'PageDown': Key.k.pgdn,
    'End': Key.k.end,
    'Home': Key.k.home,
    'Insert': Key.k.ins,
    'Delete': Key.k.del,
  };

  // Check physical mapping first for game controls
  if (event.code && physicalKeys[event.code]) {
    return physicalKeys[event.code];
  }

  // Check logical mapping for special keys
  if (logicalKeys[event.key]) {
    return logicalKeys[event.key];
  }

  // Handle printable characters (for console input)
  if (event.key && event.key.length === 1) {
    const char = event.key.toLowerCase();
    return char.charCodeAt(0);
  }

  return null;
};

const eventHandlers = {
  oncontextmenu(e) {
    e.preventDefault();
  },

  onfocus() {
    for (let i = 0; i < 256; i++) {
      Key.Event(i);
      Key.down[i] = false;
    }
  },

  onkeydown(e) {
    // Try modern key mapping first
    const key = getModernKey(e);

    if (key === null) {
      return;
    }

    Key.Event(key, true);
    e.preventDefault();
  },

  onkeyup(e) {
    // Try modern key mapping first
    const key = getModernKey(e);

    if (key === null) {
      return;
    }

    Key.Event(key);
    e.preventDefault();
  },

  onmousedown(e) {
    let key;
    switch (e.which) {
      case 1:
        key = Key.k.mouse1;
        break;
      case 2:
        key = Key.k.mouse3;
        break;
      case 3:
        key = Key.k.mouse2;
        break;
      default:
        return;
    }
    Key.Event(key, true);
    e.preventDefault();
  },

  onmouseup(e) {
    let key;
    switch (e.which) {
      case 1:
        key = Key.k.mouse1;
        break;
      case 2:
        key = Key.k.mouse3;
        break;
      case 3:
        key = Key.k.mouse2;
        break;
      default:
        return;
    }
    Key.Event(key);
    e.preventDefault();
  },

  onmousewheel(e) {
    const key = e.wheelDeltaY > 0 ? Key.k.mwheelup : Key.k.mwheeldown;
    Key.Event(key, true);
    Key.Event(key);
    e.preventDefault();
  },

  onwheel(e) {
    const key = e.deltaY < 0 ? Key.k.mwheelup : Key.k.mwheeldown;
    Key.Event(key, true);
    Key.Event(key);
    e.preventDefault();
  },
};

export default class Sys {
  static #oldtime = 0;
  static #isRunning = false;

  static async Init() {
    // @ts-ignore
    window.registry = registry;

    const location = document.location;
    const argv = [location.hostname];
    if (location.search && location.search.length > 1) {
      const qs = location.search.substring(1);
      qs.split('&').forEach(param => {
        if (param.trim() === '') return;
        const [key, value] = param.split('=');
        const decodedKey = decodeURIComponent(key);
        const decodedValue = value ? decodeURIComponent(value) : '';
        if (decodedValue === '' || decodedValue.toLowerCase() === 'true') {
          argv.push('-' + decodedKey);
        } else {
          argv.push('-' + decodedKey, decodedValue);
        }
      });
    }

    COM.InitArgv(argv);

    const $console = document.getElementById('console');

    // make sure we print from the console to the HTML console
    eventBus.subscribe('console.print-line', (line) => {
      const $li = document.createElement('li');
      $li.textContent = line;
      $console.appendChild($li);
      console.info(line);

      // limit the raw console to 40 entries
      if ($console.childNodes.length > 40) {
        $console.removeChild($console.childNodes.item(0));
      }
    });

    Sys.#oldtime = Date.now() * 0.001;

    document.getElementById('progress').style.display = 'none';

    Sys.Print('Host.Init\n');

    await Host.Init();

    for (const event of Object.keys(eventHandlers)) {
      window.addEventListener(event.substring(2), eventHandlers[event]);
    }

    await Tools.Init();

    Sys.#isRunning = true;

    while (Sys.#isRunning) {
      const startTime = Date.now();

      Host.Frame();

      await Q.sleep(Math.max(0, 1000.0 / 60.0 - (Date.now() - startTime)));
    }
  }

  static Quit() {
    Sys.#isRunning = false;

    for (const event of Object.keys(eventHandlers)) {
      window.removeEventListener(event.substring(2), eventHandlers[event]);
    }

    Tools.Shutdown();
    Host.Shutdown();

    document.body.style.cursor = 'auto';

    if (COM.registered.value !== 0) {
      // document.getElementById('end2').style.display = 'inline';
      // parent.unloadContainer();
    } else {
      // document.getElementById('end1').style.display = 'inline';
      // parent.unloadContainer();
    }

    // @ts-ignore
    delete window.registry;

    Sys.Print('Sys.Quit: done\n');
  }

  static Print(text) {
    eventBus.publish('console.print-line', text);
  }

  static FloatTime() {
    return Date.now() * 0.001 - Sys.#oldtime;
  }
};
