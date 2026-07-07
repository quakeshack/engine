import { K } from '../../shared/Keys.ts';
import Q from '../../shared/Q.ts';
import { eventBus, getClientRegistry, registry } from '../registry.ts';
import Tools from './Tools.ts';
import IN from './IN.ts';
import { KeyDestination } from './Key.ts';
import WorkerManager from '../common/WorkerManager.ts';
import workerFactories from '../common/WorkerFactories.ts';

interface LegacyWheelEvent extends Event {
  readonly wheelDeltaY: number;
}

let { COM, Host, Key } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Host, Key } = getClientRegistry());
});

eventBus.subscribe('host.crash', (error: unknown) => {
  console.error(error);

  const errorElement = document.getElementById('error');
  if (errorElement !== null) {
    errorElement.textContent = `${getErrorName(error)}: ${getErrorMessage(error)}`;
  }

  // abort all pending IO operations
  COM.Shutdown();
});

/**
 * Returns a stable display name for a thrown value.
 * @returns Stable error name.
 */
function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error === 'object' && error !== null && 'constructor' in error) {
    const constructorValue = error.constructor;
    if (typeof constructorValue === 'function' && constructorValue.name.length > 0) {
      return constructorValue.name;
    }
  }

  return typeof error;
}

/**
 * Returns a readable message for a thrown value.
 * @returns Readable error message.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return String(error);
}

/**
 * Resolves a modern browser keycode to the engine key enum.
 * @returns Engine key code or null when unmapped.
 */
function getModernKey(event: KeyboardEvent): number | null {
  // Physical key mappings - maintain WASD regardless of layout
  const physicalKeys: Record<string, number> = {
    Space: K.SPACE,
    ShiftLeft: K.SHIFT,
    ShiftRight: K.SHIFT,
    ControlLeft: K.CTRL,
    ControlRight: K.CTRL,
    AltLeft: K.ALT,
    AltRight: K.ALT,
    ArrowUp: K.UPARROW,
    ArrowDown: K.DOWNARROW,
    ArrowLeft: K.LEFTARROW,
    ArrowRight: K.RIGHTARROW,
    F1: K.F1,
    F2: K.F2,
    F3: K.F3,
    F4: K.F4,
    F5: K.F5,
    F6: K.F6,
    F7: K.F7,
    F8: K.F8,
    F9: K.F9,
    F10: K.F10,
    F11: K.F11,
    F12: K.F12,
  };
  // Logical key mappings - use actual key value
  const logicalKeys: Record<string, number> = {
    Enter: K.ENTER,
    Backspace: K.BACKSPACE,
    Tab: K.TAB,
    Escape: K.ESCAPE,
    Pause: K.PAUSE,
    PageUp: K.PGUP,
    PageDown: K.PGDN,
    End: K.END,
    Home: K.HOME,
    Insert: K.INS,
    Delete: K.DEL,
  };

  // Check physical mapping first for game controls
  if (event.code.length > 0 && physicalKeys[event.code] !== undefined) {
    return physicalKeys[event.code];
  }

  // Check logical mapping for special keys
  if (logicalKeys[event.key] !== undefined) {
    return logicalKeys[event.key];
  }

  // Handle printable characters (for console input)
  if (event.key.length === 1) {
    return event.key.toLowerCase().charCodeAt(0);
  }

  return null;
}

/** Prevents the browser context menu from stealing mouse input. */
function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
}

/** Clears pressed-key state when the window regains focus. */
function handleFocus(): void {
  for (let index = 0; index < 256; index++) {
    Key.Event(index, false);
  }
}

/**
 * Reads the clipboard and forwards its text to the active text input (menu textbox, console,
 * or chat line). Clipboard access requires an async round-trip, so this can't be folded into
 * the synchronous key handler.
 */
async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    Key.Paste(text);
  } catch {
    // Clipboard access denied or unavailable; nothing to paste.
  }
}

/** Dispatches key-down events into the engine input system. */
function handleKeyDown(event: KeyboardEvent): void {
  // Ctrl/Cmd+V: paste into the active text input instead of typing a literal 'v'.
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV' && Key.destination !== KeyDestination.game) {
    event.preventDefault();
    void pasteFromClipboard();
    return;
  }

  const key = getModernKey(event);
  if (key === null) {
    return;
  }

  IN.NoteKeyboardActivity();
  Key.Event(key, true);
  event.preventDefault();
}

/** Dispatches key-up events into the engine input system. */
function handleKeyUp(event: KeyboardEvent): void {
  const key = getModernKey(event);
  if (key === null) {
    return;
  }

  Key.Event(key, false);
  event.preventDefault();
}

/**
 * Maps browser mouse button indices to engine button constants.
 * @returns Engine mouse key code or null when unmapped.
 */
function getMouseButtonKey(button: number): number | null {
  switch (button) {
    case 1:
      return K.MOUSE1;
    case 2:
      return K.MOUSE3;
    case 3:
      return K.MOUSE2;
    default:
      return null;
  }
}

/** Dispatches mouse-button presses into the engine input system. */
function handleMouseDown(event: MouseEvent): void {
  const key = getMouseButtonKey(event.which);
  if (key === null) {
    return;
  }

  Key.Event(key, true);
  event.preventDefault();
}

/** Records real mouse pointer activity outside pointer lock so mobile warnings can clear. */
function handlePointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse') {
    IN.NoteMouseActivity();
  }
}

/** Dispatches mouse-button releases into the engine input system. */
function handleMouseUp(event: MouseEvent): void {
  const key = getMouseButtonKey(event.which);
  if (key === null) {
    return;
  }

  Key.Event(key, false);
  event.preventDefault();
}

/** Handles the legacy mousewheel event used by older browsers. */
function handleLegacyMouseWheel(event: LegacyWheelEvent): void {
  const key = event.wheelDeltaY > 0 ? K.MWHEELUP : K.MWHEELDOWN;
  Key.Event(key, true);
  Key.Event(key, false);
  event.preventDefault();
}

/** Handles standard wheel events for mouse wheel bindings. */
function handleWheel(event: WheelEvent): void {
  const key = event.deltaY < 0 ? K.MWHEELUP : K.MWHEELDOWN;
  Key.Event(key, true);
  Key.Event(key, false);
  event.preventDefault();
}

/** Registers all browser event listeners required by the client runtime. */
function registerWindowListeners(): void {
  window.addEventListener('contextmenu', handleContextMenu);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('mousedown', handleMouseDown);
  window.addEventListener('mouseup', handleMouseUp);
  window.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('mousewheel', handleLegacyMouseWheel as EventListener, { passive: false });
}

/** Unregisters all browser event listeners installed during startup. */
function unregisterWindowListeners(): void {
  window.removeEventListener('contextmenu', handleContextMenu);
  window.removeEventListener('focus', handleFocus);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('pointerdown', handlePointerDown);
  window.removeEventListener('mousedown', handleMouseDown);
  window.removeEventListener('mouseup', handleMouseUp);
  window.removeEventListener('wheel', handleWheel);
  window.removeEventListener('mousewheel', handleLegacyMouseWheel as EventListener);
}

/**
 * Looks up an element that must exist for browser startup to continue.
 * @returns Matching DOM element.
 */
function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return element;
}

export default class Sys {
  static #oldtime = 0;
  static #isRunning = false;

  static async Init(): Promise<void> {
    (window as Window & { registry?: typeof registry }).registry = registry;

    const location = document.location;
    const argv = [location.hostname];
    if (location.search.length > 1) {
      const queryString = location.search.substring(1);
      for (const param of queryString.split('&')) {
        if (param.trim() === '') {
          continue;
        }

        const [key, value] = param.split('=');
        const decodedKey = decodeURIComponent(key);
        const decodedValue = value ? decodeURIComponent(value) : '';
        if (decodedValue === '' || decodedValue.toLowerCase() === 'true') {
          argv.push(`-${decodedKey}`);
        } else if (decodedKey === 'game') { // HACK: game parameter
          argv.push(`-${decodedKey}`, decodedValue);
        } else {
          argv.push(`+${decodedKey}`, decodedValue);
        }
      }
    }

    COM.InitArgv(argv);

    const consoleElement = getRequiredElement('console');

    // make sure we print from the console to the HTML console
    eventBus.subscribe('console.print-line', (line: string) => {
      const listItem = document.createElement('li');
      listItem.textContent = line;
      consoleElement.appendChild(listItem);
      console.info(line);

      // limit the raw console to 40 entries
      if (consoleElement.childNodes.length > 40) {
        consoleElement.removeChild(consoleElement.childNodes.item(0));
      }
    });

    Sys.#oldtime = Date.now() * 0.001;

    getRequiredElement('progress').style.display = 'none';

  // Start worker manager
    WorkerManager.Init(workerFactories);

    Sys.Print('Host.Init: Initializing game…\n');

    await Host.Init();

    registerWindowListeners();

    Tools.Init();

    // eslint-disable-next-line require-atomic-updates
    Sys.#isRunning = true;

    while (Sys.#isRunning) {
      const startTime = Date.now();

      await Host.Frame();

      const refreshRate = Host.refreshrate;
      // uncapped framerate
      if (refreshRate === null || refreshRate.value === 0) {
        await Q.yield();
        continue;
      }

      const targetFrameMs = 1000.0 / Math.min(300, Math.max(60, refreshRate.value));
      await Q.sleep(Math.max(0, targetFrameMs - (Date.now() - startTime)));
    }
  }

  static Quit(): void {
    Sys.#isRunning = false;

    unregisterWindowListeners();

    Tools.Shutdown();
    Host.Shutdown();

    document.body.style.cursor = 'auto';

    if (COM.registered?.value !== 0) {
      // document.getElementById('end2').style.display = 'inline';
      // parent.unloadContainer();
    } else {
      // document.getElementById('end1').style.display = 'inline';
      // parent.unloadContainer();
    }

    delete (window as Window & { registry?: typeof registry }).registry;

    Sys.Print('Sys.Quit: finished, thank you for playing!\n');
  }

  static Print(text: string): void {
    // by this time we feed the Sys.Print into the event bus
    eventBus.publish('console.print-line', text);
  }

  static FloatTime(): number {
    return Date.now() * 0.001 - Sys.#oldtime;
  }

  static FloatMilliTime(): number {
    return performance.now();
  }
}
