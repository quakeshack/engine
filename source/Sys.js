/* global Con, COM, Host, Sys, Key, VID,  */

// eslint-disable-next-line no-global-assign
Sys = {};

Sys.events = ['oncontextmenu', 'onfocus', 'onkeydown', 'onkeyup', 'onmousedown', 'onmouseup', 'onmousewheel', 'onunload', 'onwheel'];

Sys.Init = function() {
  const cmdline = decodeURIComponent(document.location.search);
  const location = document.location;
  const argv = [location.href.substring(0, location.href.length - location.search.length)];
  if (cmdline.charCodeAt(0) === 63) {
    let text = '';
    let quotes = false;
    let c;
    for (let i = 1; i < cmdline.length; ++i) {
      c = cmdline.charCodeAt(i);
      if ((c < 32) || (c > 127)) {
        continue;
      }
      if (c === 34) {
        quotes = !quotes;
        continue;
      }
      if ((quotes === false) && (c === 32)) {
        if (text.length === 0) {
          continue;
        }
        argv[argv.length] = text;
        text = '';
        continue;
      }
      text += cmdline.charAt(i);
    }
    if (text.length !== 0) {
      argv[argv.length] = text;
    }
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
  Host.Init();

  for (let i = 0; i < Sys.events.length; ++i) {
    window[Sys.events[i]] = Sys[Sys.events[i]];
  }

  Sys.frame = setInterval(Host.Frame, 1000.0 / 60.0);
};

Sys.Quit = function() {
  const $console = document.getElementById('console');

  while ($console.childNodes.length > 0) {
    $console.removeChild($console.childNodes.item(0));
  }

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

Sys.Error = function(text) {
  // TODO: refactor this in a proper Exception that will be caught and the catch-clause will handle all of this below
  if (Sys.frame != null) {
    clearInterval(Sys.frame);
  }

  for (let i = 0; i < Sys.events.length; ++i) {
    window[Sys.events[i]] = null;
  }

  if (Host.initialized === true) {
    Host.Shutdown();
  }

  document.body.style.cursor = 'auto';
  if (VID.mainwindow) {
    VID.mainwindow.style.display = 'none';
  }

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
  Sys.Init();
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
  const key = Sys.scantokey[e.keyCode];
  if (key == null) {
    return;
  }
  Key.Event(key, true);
  e.preventDefault();
};

Sys.onkeyup = function(e) {
  const key = Sys.scantokey[e.keyCode];
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
