/* global Con, Key, COM, Host, CL, Cmd, Cvar, S, SCR, Draw, VID, M, Vector */

// eslint-disable-next-line no-global-assign
Con = {};

Con.backscroll = 0;
Con.current = 0;
Con.text = [];
Con.captureBuffer = null;

Con.ToggleConsole_f = function() {
  SCR.EndLoadingPlaque();
  if (Key.dest.value === Key.dest.console) {
    if (CL.cls.state !== CL.active.connected) {
      M.Menu_Main_f();
      return;
    }
    Key.dest.value = Key.dest.game;
    // Key.edit_line = ''; // CR: this annoys me otherwise
    Key.history_line = Key.lines.length;
    return;
  }
  Key.dest.value = Key.dest.console;
};

Con.Clear_f = function() {
  Con.backscroll = 0;
  Con.current = 0;
  Con.text = [];
};

Con.ClearNotify = function() {
  let i = Con.text.length - 4;
  if (i < 0) {
    i = 0;
  }
  for (; i < Con.text.length; ++i) {
    Con.text[i].time = 0.0;
  }
};

Con.MessageMode_f = function() {
  Key.dest.value = Key.dest.message;
  Key.team_message = false;
};

Con.MessageMode2_f = function() {
  Key.dest.value = Key.dest.message;
  Key.team_message = true;
};

Con.Init = function() {
  if (COM.CheckParm('-condebug')) {
    Con.Print('NOTE: -condebug parameter is no longer supported. Use Developer Tools instead.\n');
  }

  Con.Print('Console initialized.\n');

  Con.notifytime = new Cvar('con_notifytime', '3', Cvar.FLAG.ARCHIVE, 'How long to display console messages.');
  Cmd.AddCommand('toggleconsole', Con.ToggleConsole_f);
  Cmd.AddCommand('messagemode', Con.MessageMode_f);
  Cmd.AddCommand('messagemode2', Con.MessageMode2_f);
  Cmd.AddCommand('clear', Con.Clear_f);
};

Con.StartCapturing = function() {
  Con.captureBuffer = [];
};

Con.StopCapturing = function() {
  const data = Con.captureBuffer.join('\n') + '\n';
  Con.captureBuffer = null;
  return data;
};

// eslint-disable-next-line no-unused-vars
Con.OnLinePrint = function(line) {
};

Con.Print = function(msg, color = new Vector(1.0, 1.0, 1.0)) {
  Con.backscroll = 0;

  let mask = 0;
  if (msg.charCodeAt(0) <= 2) {
    mask = 128;
    if (msg.charCodeAt(0) === 1) {
      S.LocalSound(Con.sfx_talk);
    }
    msg = msg.substring(1);
  }
  let i;
  for (i = 0; i < msg.length; ++i) {
    if (!Con.text[Con.current]) {
      Con.text[Con.current] = {text: '', time: Host.realtime || 0, color};
    }
    if (msg.charCodeAt(i) === 10) {
      const line = Con.text[Con.current].text;
      if (Con.captureBuffer !== null) {
        Con.captureBuffer.push(line);
      }
      Con.OnLinePrint(line);
      if (Con.text.length >= 1024) {
        Con.text = Con.text.slice(-512);
        Con.current = Con.text.length;
      } else {
        ++Con.current;
      }
      continue;
    }
    Con.text[Con.current].text += String.fromCharCode(msg.charCodeAt(i) + mask);
  }
};

Con.DPrint = function(msg) {
  if (Host.developer.value === 0) {
    return;
  }

  Con.Print(msg, new Vector(0.7, 0.7, 1.0));
};

Con.PrintWarning = function(msg) {
  Con.Print(msg, new Vector(1.0, 1.0, 0.3));
};

Con.PrintError = function(msg) {
  Con.Print(msg, new Vector(1.0, 0.3, 0.3));
};

Con.PrintSuccess = function(msg) {
  Con.Print(msg, new Vector(0.3, 1.0, 0.3));
};

Con.DrawInput = function() {
  if ((Key.dest.value !== Key.dest.console) && (Con.forcedup !== true)) {
    return;
  }
  let text = ']' + Key.edit_line + String.fromCharCode(10 + ((Host.realtime * 4.0) & 1));
  const width = (VID.width / 8) - 2;
  if (text.length >= width) {
    text = text.substring(1 + text.length - width);
  }
  Draw.String(8, Con.vislines - 16, text);
};

Con.DrawNotify = function() {
  const width = (VID.width / 8) - 2;
  let i = Con.text.length - 4; let v = 0;
  if (i < 0) {
    i = 0;
  }
  for (; i < Con.text.length; ++i) {
    if ((Host.realtime - Con.text[i].time) > Con.notifytime.value) {
      continue;
    }
    Draw.String(8, v, Con.text[i].text.substring(0, width));
    v += 8;
  }

  v += 8;

  if (Key.dest.value === Key.dest.message) {
    Draw.String(8, v, 'say: ' + Key.chat_buffer + String.fromCharCode(10 + ((Host.realtime * 4.0) & 1)), 2.0);
  }
};

Con.DrawConsole = function(lines) {
  if (lines <= 0) {
    return;
  }
  lines = Math.floor(lines * VID.height * 0.005);
  Draw.ConsoleBackground(lines);
  Con.vislines = lines;
  const width = (VID.width / 8) - 2;
  let rows;
  let y = lines - 16;
  let i;
  for (i = Con.text.length - 1 - Con.backscroll; i >= 0;) {
    if (Con.text[i].text.length === 0) {
      y -= 8;
    } else {
      y -= Math.ceil(Con.text[i].text.length / width) << 3;
    }
    --i;
    if (y <= 0) {
      break;
    }
  }
  for (++i; i < Con.text.length - Con.backscroll; ++i) {
    const {text, color} = Con.text[i];
    rows = Math.ceil(text.length / width);
    if (rows === 0) {
      y += 8;
      continue;
    }
    for (let j = 0; j < rows; ++j) {
      Draw.String(8, y, text.substr(j * width, width), 1.0, color);
      y += 8;
    }
  }
  Con.DrawInput();
};
