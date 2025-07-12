/* global Con, COM, Host, Sys, Key, VID,  */

// eslint-disable-next-line no-global-assign
Sys = {};

Sys.events = ['oncontextmenu', 'onfocus', 'onkeydown', 'onkeyup', 'onmousedown', 'onmouseup', 'onmousewheel', 'onunload', 'onwheel'];

Sys.Init = async function() {
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

  const $elem = document.documentElement;
  VID.width = ($elem.clientWidth <= 320) ? 320 : $elem.clientWidth;
  VID.height = ($elem.clientHeight <= 200) ? 200 : $elem.clientHeight;

  const $console = document.getElementById('console');

  Con.OnLinePrint = function(line) {
    const $li = document.createElement('li');
    $li.textContent = line;
    $console.appendChild($li);
    console.info(line);

    // limit the raw console to 25 entries
    if ($console.childNodes.length > 25) {
      $console.removeChild($console.childNodes.item(0));
    }
  };

  Sys.scantokey = [];
  Sys.scantokey[8] = Key.k.backspace;
  Sys.scantokey[9] = Key.k.tab;
  Sys.scantokey[13] = Key.k.enter;
  Sys.scantokey[16] = Key.k.shift;
  Sys.scantokey[17] = Key.k.ctrl;
  Sys.scantokey[18] = Key.k.alt;
  Sys.scantokey[19] = Key.k.pause;
  Sys.scantokey[27] = Key.k.escape;
  Sys.scantokey[32] = Key.k.space;
  Sys.scantokey[33] = Sys.scantokey[105] = Key.k.pgup;
  Sys.scantokey[34] = Sys.scantokey[99] = Key.k.pgdn;
  Sys.scantokey[35] = Sys.scantokey[97] = Key.k.end;
  Sys.scantokey[36] = Sys.scantokey[103] = Key.k.home;
  Sys.scantokey[37] = Sys.scantokey[100] = Key.k.leftarrow;
  Sys.scantokey[38] = Sys.scantokey[104] = Key.k.uparrow;
  Sys.scantokey[39] = Sys.scantokey[102] = Key.k.rightarrow;
  Sys.scantokey[40] = Sys.scantokey[98] = Key.k.downarrow;
  Sys.scantokey[45] = Sys.scantokey[96] = Key.k.ins;
  Sys.scantokey[46] = Sys.scantokey[110] = Key.k.del;
  for (let i = 48; i <= 57; ++i) {
    Sys.scantokey[i] = i;
  } // 0-9
  Sys.scantokey[59] = Sys.scantokey[186] = 59; // ;
  Sys.scantokey[61] = Sys.scantokey[187] = 61; // =
  for (let i = 65; i <= 90; ++i) {
    Sys.scantokey[i] = i + 32;
  } // a-z
  Sys.scantokey[106] = 42; // *
  Sys.scantokey[107] = 43; // +
  Sys.scantokey[109] = Sys.scantokey[173] = Sys.scantokey[189] = 45; // -
  Sys.scantokey[111] = Sys.scantokey[191] = 47; // /
  for (let i = 112; i <= 123; ++i) {
    Sys.scantokey[i] = i - 112 + Key.k.f1;
  } // f1-f12
  Sys.scantokey[188] = 44; // ,
  Sys.scantokey[190] = 46; // .
  Sys.scantokey[192] = 96; // `
  Sys.scantokey[219] = 91; // [
  Sys.scantokey[220] = 92; // backslash
  Sys.scantokey[221] = 93; // ]
  Sys.scantokey[222] = 39; // '

  Sys.oldtime = Date.now() * 0.001;

  Sys.Print('Host.Init\n');

  await Host.Init(false);

  for (let i = 0; i < Sys.events.length; ++i) {
    window[Sys.events[i]] = Sys[Sys.events[i]];
  }

  Sys.frame = setInterval(Host.Frame, 1000.0 / 60.0);
};

Sys.Quit = function() {
  if (Sys.frame != null) {
    clearInterval(Sys.frame);
  }

  for (let i = 0; i < Sys.events.length; ++i) {
    window[Sys.events[i]] = null;
  }

  Host.Shutdown();

  document.body.style.cursor = 'auto';
  if (VID.mainwindow) {
    VID.mainwindow.style.display = 'none';
  }

  if (COM.registered.value !== 0) {
    // document.getElementById('end2').style.display = 'inline';
    // parent.unloadContainer();
  } else {
    // document.getElementById('end1').style.display = 'inline';
    // parent.unloadContainer();
  }
};

Sys.Print = function(text) {
  Con.OnLinePrint(text);
};

Sys.isInError = false;

Sys.Error = function(text) {
  if (Sys.isInError) {
    console.warn('Sys.isInError = true', text);
    // we can end up here multiple times, especially when async functions are also going to throw a tantrum
    return;
  }

  Sys.Print('ERROR: ' + text);

  Sys.isInError = true;

  // TODO: refactor this in a proper Exception that will be caught and the catch-clause will handle all of this below
  if (Sys.frame) {
    clearInterval(Sys.frame);
  }

  for (const event of Sys.events) {
    window[event] = null;
  }

  if (Host.initialized === true) {
    Host.Shutdown();
  }

  document.body.style.cursor = 'auto';

  if (VID.mainwindow) {
    VID.mainwindow.style.display = 'none';
  }

  document.getElementById('console').style.display = 'block';

  const $error = document.getElementById('error');

  if ($error) {
    $error.textContent = text;
  }

  throw new Error(text);
};

Sys.FloatTime = function() {
  return Date.now() * 0.001 - Sys.oldtime;
};

window.onload = function() {
  Sys.Init()
    .then(() => Sys.Print('System running!\n'))
    // .catch((err) => Sys.Error('Fatal error during Sys.Init!\n' + err.message));
};

Sys.oncontextmenu = function(e) {
  e.preventDefault();
};

Sys.onfocus = function() {
  let i;
  for (i = 0; i < 256; ++i) {
    Key.Event(i);
    Key.down[i] = false;
  }
};

Sys.onkeydown = function(e) {
  // Try modern key mapping first
  let key = Sys.getModernKey(e);

  // Fall back to legacy scantokey mapping
  if (key == null) {
    key = Sys.scantokey[e.keyCode];
  }

  if (key == null) {
    return;
  }

  Key.Event(key, true);
  e.preventDefault();
};

Sys.onkeyup = function(e) {
  // Try modern key mapping first
  let key = Sys.getModernKey(e);

  // Fall back to legacy scantokey mapping
  if (key == null) {
    key = Sys.scantokey[e.keyCode];
  }

  if (key == null) {
    return;
  }

  Key.Event(key);
  e.preventDefault();
};

Sys.onmousedown = function(e) {
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
};

Sys.onmouseup = function(e) {
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
};

Sys.onmousewheel = function(e) {
  const key = e.wheelDeltaY > 0 ? Key.k.mwheelup : Key.k.mwheeldown;
  Key.Event(key, true);
  Key.Event(key);
  e.preventDefault();
};

Sys.onunload = function() {
  Host.Shutdown();
};

Sys.onwheel = function(e) {
  const key = e.deltaY < 0 ? Key.k.mwheelup : Key.k.mwheeldown;
  Key.Event(key, true);
  Key.Event(key);
  e.preventDefault();
};

Sys.getModernKey = function(event) {
  // Physical key mappings - maintain WASD regardless of layout
  const physicalKeys = {
    'KeyW': Key.k.w || 119,
    'KeyA': Key.k.a || 97,
    'KeyS': Key.k.s || 115,
    'KeyD': Key.k.d || 100,
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
    'F12': Key.k.f12
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
    'Delete': Key.k.del
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
