import { K } from '../../shared/Keys.ts';
import Q from '../../shared/Q.ts';
import { eventBus, registry } from '../registry.mjs';
import Tools from './Tools.mjs';
import WorkerManager from '../common/WorkerManager.ts';
import workerFactories from '../common/WorkerFactories.ts';

let { COM, Host, Key } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Host = registry.Host;
  Key = registry.Key;
});

eventBus.subscribe('host.crash', (error) => {
  console.error(error);
  document.getElementById('error').textContent = (error.name ?? error.constructor.name) + ': ' + error.message;
  COM.Shutdown(); // abort all pending IO operations
});

/**
 * @param {KeyboardEvent} event keyboard event
 * @returns {number|null} key code or null if not recognized
 */
function getModernKey(event) {
  // Physical key mappings - maintain WASD regardless of layout
  const physicalKeys = {
    'Space': K.SPACE,
    'ShiftLeft': K.SHIFT,
    'ShiftRight': K.SHIFT,
    'ControlLeft': K.CTRL,
    'ControlRight': K.CTRL,
    'AltLeft': K.ALT,
    'AltRight': K.ALT,
    'ArrowUp': K.UPARROW,
    'ArrowDown': K.DOWNARROW,
    'ArrowLeft': K.LEFTARROW,
    'ArrowRight': K.RIGHTARROW,

    'F1': K.F1,
    'F2': K.F2,
    'F3': K.F3,
    'F4': K.F4,
    'F5': K.F5,
    'F6': K.F6,
    'F7': K.F7,
    'F8': K.F8,
    'F9': K.F9,
    'F10': K.F10,
    'F11': K.F11,
    'F12': K.F12,
  };

  // Logical key mappings - use actual key value
  const logicalKeys = {
    'Enter': K.ENTER,
    'Backspace': K.BACKSPACE,
    'Tab': K.TAB,
    'Escape': K.ESCAPE,
    'Pause': K.PAUSE,
    'PageUp': K.PGUP,
    'PageDown': K.PGDN,
    'End': K.END,
    'Home': K.HOME,
    'Insert': K.INS,
    'Delete': K.DEL,
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
        key = K.MOUSE1;
        break;
      case 2:
        key = K.MOUSE3;
        break;
      case 3:
        key = K.MOUSE2;
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
        key = K.MOUSE1;
        break;
      case 2:
        key = K.MOUSE3;
        break;
      case 3:
        key = K.MOUSE2;
        break;
      default:
        return;
    }
    Key.Event(key);
    e.preventDefault();
  },

  onmousewheel(e) {
    const key = e.wheelDeltaY > 0 ? K.MWHEELUP : K.MWHEELDOWN;
    Key.Event(key, true);
    Key.Event(key);
    e.preventDefault();
  },

  onwheel(e) {
    const key = e.deltaY < 0 ? K.MWHEELUP : K.MWHEELDOWN;
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
      for (const param of qs.split('&')) {
        if (param.trim() === '') {
          continue;
        }
        const [key, value] = param.split('=');
        const decodedKey = decodeURIComponent(key);
        const decodedValue = value ? decodeURIComponent(value) : '';
        if (decodedValue === '' || decodedValue.toLowerCase() === 'true') {
          argv.push('-' + decodedKey);
        } else if (decodedKey === 'game') { // HACK: game parameter
          argv.push('-' + decodedKey, decodedValue);
        } else {
          argv.push('+' + decodedKey, decodedValue);
        }
      }
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

    // Start worker manager
    WorkerManager.Init(workerFactories);

    Sys.Print('Host.Init: Initializing game…\n');

    await Host.Init();

    for (const event of Object.keys(eventHandlers)) {
      window.addEventListener(event.substring(2), eventHandlers[event]);
    }

    await Tools.Init();

    Sys.#isRunning = true;

    while (Sys.#isRunning) {
      const startTime = Date.now();

      await Host.Frame();

      if (Host.refreshrate.value === 0) { // uncapped framerate
        await Q.yield();
        continue;
      }

      await Q.sleep(Math.max(0, 1000.0 / Math.min(300, Math.max(60, Host.refreshrate.value)) - (Date.now() - startTime)));
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

    Sys.Print('Sys.Quit: finished, thank you for playing!\n');
  }

  static Print(/** @type {string} */ text) {
    // by this time we feed the Sys.Print into the event bus
    eventBus.publish('console.print-line', text);
  }

  static FloatTime() {
    return Date.now() * 0.001 - Sys.#oldtime;
  }

  static FloatMilliTime() {
    return performance.now();
  }
};
