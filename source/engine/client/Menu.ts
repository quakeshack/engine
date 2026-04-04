import type { SFX } from './Sound.ts';

import { K } from '../../shared/Keys.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';
import ClientLifecycle from './ClientLifecycle.ts';
import { GLTexture } from './GL.mjs';
import MultiplayerMainMenu from './menu/Multiplayer.ts';
import VID from './VID.ts';

let { CL, COM, Con, Draw, Host, Key, S, SCR, SV, V } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Draw, Host, Key, S, SCR, SV, V } = getClientRegistry());
});

enum MenuStateId {
  none = 0,
  main = 1,
  singleplayer = 2,
  load = 3,
  save = 4,
  multiplayer = 5,
  options = 6,
  keys = 7,
  help = 8,
  quit = 9,
  alert = 10,
  launch_server = 11,
}

type MenuStateStore = {
  readonly none: MenuStateId.none;
  readonly main: MenuStateId.main;
  readonly singleplayer: MenuStateId.singleplayer;
  readonly load: MenuStateId.load;
  readonly save: MenuStateId.save;
  readonly multiplayer: MenuStateId.multiplayer;
  readonly options: MenuStateId.options;
  readonly keys: MenuStateId.keys;
  readonly help: MenuStateId.help;
  readonly quit: MenuStateId.quit;
  readonly alert: MenuStateId.alert;
  readonly launch_server: MenuStateId.launch_server;
  value: MenuStateId;
};

type MenuPic = GLTexture & { translate?: GLTexture | null };
type SaveGameData = { comment?: string; mapname?: string };
type BindName = [string, string];
type QuitMessage = [string, string, string, string];

const launchServerMenu = new MultiplayerMainMenu();

export default class M {
  static state: MenuStateStore = {
    none: MenuStateId.none,
    main: MenuStateId.main,
    singleplayer: MenuStateId.singleplayer,
    load: MenuStateId.load,
    save: MenuStateId.save,
    multiplayer: MenuStateId.multiplayer,
    options: MenuStateId.options,
    keys: MenuStateId.keys,
    help: MenuStateId.help,
    quit: MenuStateId.quit,
    alert: MenuStateId.alert,
    launch_server: MenuStateId.launch_server,
    value: MenuStateId.none,
  };

  static main_cursor = 0;
  static main_items = 5;
  static save_demonum = 0; // THIS IS THE REASON WHY I HATE UNINITIALIZED PROPERTIES, this line was missing and it quietly caused some NaNs deep in the demo code…

  static singleplayer_cursor = 0;
  static singleplayer_items = 3;

  static load_cursor = 0;
  static max_savegames = 12;
  static filenames: string[] = [];
  static loadable: boolean[] = [];
  static removable: boolean[] = [];

  static multiplayer_cursor = 1;
  static multiplayer_cursor_table = [56, 72, 96, 120, 156];
  static multiplayer_joinname = (() => {
    const url = new URL(location.href);
    return url.host + url.pathname + (!url.pathname.endsWith('/') ? '/' : '') + 'api/';
  })();
  static multiplayer_items = 5;
  static multiplayer_myname = '';
  static multiplayer_top = 0;
  static multiplayer_oldtop = 0;
  static multiplayer_bottom = 0;
  static multiplayer_oldbottom = 0;

  static options_cursor = 0;
  static options_items = 12;

  static bindnames: BindName[] = [
    ['+attack', 'attack'],
    ['impulse 10', 'change weapon'],
    ['+jump', 'jump / swim up'],
    ['+forward', 'walk forward'],
    ['+back', 'backpedal'],
    ['+left', 'turn left'],
    ['+right', 'turn right'],
    ['+speed', 'run'],
    ['+moveleft', 'step left'],
    ['+moveright', 'step right'],
    ['+strafe', 'sidestep'],
    ['+lookup', 'look up'],
    ['+lookdown', 'look down'],
    ['centerview', 'center view'],
    ['+mlook', 'mouse look'],
    ['+klook', 'keyboard look'],
    ['+moveup', 'swim up'],
    ['+movedown', 'swim down'],
  ];
  static keys_cursor = 0;
  static bind_grab = false;

  static num_help_pages = 6;
  static help_page = 0;

  static quitMessage: QuitMessage[] = [
    ['  Are you gonna quit', '  this game just like', '   everything else?', ''],
    [' Milord, methinks that', '   thou art a lowly', ' quitter. Is this true?', ''],
    [' Do I need to bust your', '  face open for trying', '        to quit?', ''],
    [' Man, I oughta smack you', '   for trying to quit!', '     Press Y to get', '      smacked out.'],
    [' Press Y to quit like a', '   big loser in life.', '  Press N to stay proud', '    and successful!'],
    ['   If you press Y to', '  quit, I will summon', '  Satan all over your', '      hard drive!'],
    ['  Um, Asmodeus dislikes', ' his children trying to', ' quit. Press Y to return', '   to your Tinkertoys.'],
    ['  If you quit now, I\'ll', '  throw a blanket-party', '   for you next time!', ''],
  ];

  static wasInMenus = false;
  static quit_prevstate: MenuStateId = MenuStateId.none;
  static msgNumber = 0;

  static alertMessage = { title: '', message: '' };

  static recursiveDraw = false;
  static entersound = false;

  static sfx_menu1: SFX | null = null;
  static sfx_menu2: SFX | null = null;
  static sfx_menu3: SFX | null = null;

  static box_tl: MenuPic = null!;
  static box_ml: MenuPic = null!;
  static box_bl: MenuPic = null!;
  static box_tm: MenuPic = null!;
  static box_mm: MenuPic = null!;
  static box_mm2: MenuPic = null!;
  static box_bm: MenuPic = null!;
  static box_tr: MenuPic = null!;
  static box_mr: MenuPic = null!;
  static box_br: MenuPic = null!;

  static qplaque: MenuPic = null!;
  static menudot: MenuPic[] = [];
  static ttl_main: MenuPic = null!;
  static mainmenu: MenuPic = null!;

  static ttl_sgl: MenuPic = null!;
  static sp_menu: MenuPic = null!;
  static p_load: MenuPic = null!;
  static p_save: MenuPic = null!;

  static p_multi: MenuPic = null!;
  static bigbox: MenuPic = null!;
  static menuplyr: MenuPic = null!;

  static p_option: MenuPic = null!;
  static ttl_cstm: MenuPic = null!;
  static help_pages: MenuPic[] = [];

  static DrawCharacter(cx: number, cy: number, num: number): void {
    Draw.Character(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, num, 2.0);
  }

  static Print(cx: number, cy: number, str: string): void {
    Draw.StringWhite(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, str, 2.0);
  }

  static PrintWhite(cx: number, cy: number, str: string): void {
    Draw.String(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, str, 2.0);
  }

  static DrawPic(x: number, y: number, pic: MenuPic): void {
    Draw.Pic(x * 2 + Math.floor(VID.width / 2) - 320, y * 2 + Math.floor(VID.height / 2) - 200, pic, 2.0);
  }

  static DrawPicTranslate(x: number, y: number, pic: MenuPic, top: number, bottom: number): void {
    Draw.PicTranslate(x * 2 + Math.floor(VID.width / 2) - 320, y * 2 + Math.floor(VID.height / 2) - 200, pic, top, bottom, 2.0);
  }

  static DrawTextBox(x: number, y: number, width: number, lines: number): void {
    let cx: number;
    let cy: number;
    let n: number;

    cy = y;
    M.DrawPic(x, cy, M.box_tl);
    for (n = 0; n < lines; n++) {
      M.DrawPic(x, cy += 8, M.box_ml);
    }
    M.DrawPic(x, cy + 8, M.box_bl);

    cx = x + 8;
    let p: MenuPic;
    for (; width > 0;) {
      cy = y;
      M.DrawPic(cx, y, M.box_tm);
      p = M.box_mm;
      for (n = 0; n < lines; n++) {
        M.DrawPic(cx, cy += 8, p);
        if (n === 0) {
          p = M.box_mm2;
        }
      }
      M.DrawPic(cx, cy + 8, M.box_bm);
      width -= 2;
      cx += 16;
    }

    cy = y;
    M.DrawPic(cx, cy, M.box_tr);
    for (n = 0; n < lines; n++) {
      M.DrawPic(cx, cy += 8, M.box_mr);
    }
    M.DrawPic(cx, cy + 8, M.box_br);
  }

  static CloseMenu(): void {
    if (CL.cls.state === clientConnectionState.connected) {
      Key.dest.value = Key.dest.game;
    } else {
      Key.dest.value = Key.dest.console;
    }
    M.state.value = M.state.none;
  }

  static ToggleMenu_f(): void {
    M.entersound = true;
    if (Key.dest.value === Key.dest.menu) {
      if (M.state.value !== M.state.main) {
        M.Menu_Main_f();
        return;
      }
      M.CloseMenu();
      return;
    }
    M.Menu_Main_f();
  }

  // Main menu
  static Menu_Main_f(): void {
    if (CL.cls.connecting !== null) {
      return;
    }

    if (Key.dest.value !== Key.dest.menu) {
      M.save_demonum = CL.cls.demonum;
      CL.cls.demonum = -1;
    }
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.main;
    M.entersound = true;
  }

  static Main_Draw(): void {
    M.DrawPic(16, 4, M.qplaque);
    M.DrawPic(160 - (M.ttl_main.width / 2), 4, M.ttl_main);
    M.DrawPic(72, 32, M.mainmenu);
    M.DrawPic(54, 32 + M.main_cursor * 20, M.menudot[Math.floor(Host.realtime * 10.0) % 6]);
  }

  static Main_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.CloseMenu();
        CL.cls.demonum = M.save_demonum;
        if ((CL.cls.demonum !== -1) && (CL.cls.demoplayback !== true) && (CL.cls.state !== clientConnectionState.connected)) {
          CL.NextDemo();
        }
        return;
      case K.DOWNARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.main_cursor >= M.main_items) {
          M.main_cursor = 0;
        }
        return;
      case K.UPARROW:
        S.LocalSound(M.sfx_menu1);
        if (M.main_cursor-- === 0) {
          M.main_cursor = M.main_items - 1;
        }
        return;
      case K.ENTER:
        M.entersound = true;
        switch (M.main_cursor) {
          case 0:
            M.Menu_SinglePlayer_f();
            return;
          case 1:
            M.Menu_MultiPlayer_f();
            return;
          case 2:
            M.Menu_Options_f();
            return;
          case 3:
            M.Menu_Help_f();
            return;
          case 4:
            M.Menu_Quit_f();
        }
    }
  }

  // Single player menu
  static Menu_SinglePlayer_f(): void {
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.singleplayer;
    M.entersound = true;
  }

  static SinglePlayer_Draw(): void {
    M.DrawPic(16, 4, M.qplaque);
    M.DrawPic(160 - (M.ttl_sgl.width / 2), 4, M.ttl_sgl);
    M.DrawPic(72, 32, M.sp_menu);
    M.DrawPic(54, 32 + M.singleplayer_cursor * 20, M.menudot[Math.floor(Host.realtime * 10.0) % 6]);
  }

  static SinglePlayer_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.Menu_Main_f();
        return;
      case K.DOWNARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.singleplayer_cursor >= M.singleplayer_items) {
          M.singleplayer_cursor = 0;
        }
        return;
      case K.UPARROW:
        S.LocalSound(M.sfx_menu1);
        if (--M.singleplayer_cursor < 0) {
          M.singleplayer_cursor = M.singleplayer_items - 1;
        }
        return;
      case K.ENTER:
        M.entersound = true;
        switch (M.singleplayer_cursor) {
          case 0:
            if (SV.server.active) {
              void Cmd.ExecuteString('disconnect');
            }
            Key.dest.value = Key.dest.game;
            ClientLifecycle.startGame!.startSingleplayerGame();
            return;
          case 1:
            M.Menu_Load_f();
            return;
          case 2:
            M.Menu_Save_f();
            return;
        }
    }
  }

  // Load/save menu
  static ScanSaves(): void {
    const searchpaths = COM.searchpaths;
    const search = 'Quake.' + COM.gamedir[0].filename + '/s';
    COM.searchpaths = COM.gamedir;
    for (let i = 0; i < M.max_savegames; i++) {
      const f = localStorage.getItem(search + i + '.json');
      if (!f) {
        M.filenames[i] = 'Empty slot';
        M.loadable[i] = false;
        M.removable[i] = false;
        continue;
      }
      const gamestate = JSON.parse(f) as SaveGameData;
      M.filenames[i] = gamestate.comment || gamestate.mapname || '';
      M.loadable[i] = true;
      M.removable[i] = true;
    }
    COM.searchpaths = searchpaths;
  }

  static Menu_Load_f(): void {
    M.entersound = true;
    M.state.value = M.state.load;
    Key.dest.value = Key.dest.menu;
    M.ScanSaves();
  }

  static Menu_Save_f(): void {
    if ((SV.server.active !== true) || (CL.state.intermission !== 0) || (SV.svs.maxclients !== 1)) {
      return;
    }
    M.entersound = true;
    M.state.value = M.state.save;
    Key.dest.value = Key.dest.menu;
    M.ScanSaves();
  }

  static Load_Draw(): void {
    M.DrawPic(160 - (M.p_load.width / 2), 4, M.p_load);
    for (let i = 0; i < M.max_savegames; i++) {
      M.Print(16, 32 + (i << 3), M.filenames[i]);
    }
    M.DrawCharacter(8, 32 + (M.load_cursor << 3), 12 + ((Host.realtime * 4.0) & 1));
  }

  static Save_Draw(): void {
    M.DrawPic(160 - (M.p_save.width / 2), 4, M.p_save);
    for (let i = 0; i < M.max_savegames; i++) {
      M.Print(16, 32 + (i << 3), M.filenames[i]);
    }
    M.DrawCharacter(8, 32 + (M.load_cursor << 3), 12 + ((Host.realtime * 4.0) & 1));
  }

  static Load_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.Menu_SinglePlayer_f();
        return;
      case K.ENTER:
        S.LocalSound(M.sfx_menu2);
        if (M.loadable[M.load_cursor] !== true) {
          return;
        }
        M.CloseMenu();
        SCR.BeginLoadingPlaque();
        Cmd.text += 'load s' + M.load_cursor + '\n';
        return;
      case K.UPARROW:
      case K.LEFTARROW:
        S.LocalSound(M.sfx_menu1);
        if (--M.load_cursor < 0) {
          M.load_cursor = M.max_savegames - 1;
        }
        return;
      case K.DOWNARROW:
      case K.RIGHTARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.load_cursor >= M.max_savegames) {
          M.load_cursor = 0;
        }
        return;
      case K.DEL:
        if (M.removable[M.load_cursor] !== true) {
          return;
        }
        if (confirm('Delete selected game?') !== true) {
          return;
        }
        localStorage.removeItem('Quake.' + COM.gamedir[0].filename + '/s' + M.load_cursor + '.sav');
        M.ScanSaves();
    }
  }

  static Save_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.Menu_SinglePlayer_f();
        return;
      case K.ENTER:
        M.CloseMenu();
        Cmd.text += 'save s' + M.load_cursor + '\n';
        return;
      case K.UPARROW:
      case K.LEFTARROW:
        S.LocalSound(M.sfx_menu1);
        if (--M.load_cursor < 0) {
          M.load_cursor = M.max_savegames - 1;
        }
        return;
      case K.DOWNARROW:
      case K.RIGHTARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.load_cursor >= M.max_savegames) {
          M.load_cursor = 0;
        }
        return;
      case K.DEL:
        if (M.removable[M.load_cursor] !== true) {
          return;
        }
        if (confirm('Delete selected game?') !== true) {
          return;
        }
        localStorage.removeItem('Quake.' + COM.gamedir[0].filename + '/s' + M.load_cursor + '.sav');
        M.ScanSaves();
    }
  }

  // Multiplayer menu
  static Menu_MultiPlayer_f(): void {
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.multiplayer;
    M.entersound = true;
    M.multiplayer_myname = CL.name.string;
    M.multiplayer_top = M.multiplayer_oldtop = CL.color.value >> 4;
    M.multiplayer_bottom = M.multiplayer_oldbottom = CL.color.value & 15;
    M.multiplayer_cursor = 1;
  }

  static MultiPlayer_Draw(): void {
    M.DrawPic(16, 4, M.qplaque);
    M.DrawPic(160 - (M.p_multi.width / 2), 4, M.p_multi);

    const y0 = 24;

    // M.Print(64, 40 - y0, 'Join game at:');
    // M.DrawTextBox(72, 48 - y0, 22, 1);
    // M.Print(80, 56 - y0, M.multiplayer_joinname.substring(M.multiplayer_joinname.length - 21));

    M.Print(64, 72 - y0, 'Your name');
    M.DrawTextBox(160, 64 - y0, 16, 1);
    M.PrintWhite(168, 72 - y0, M.multiplayer_myname);

    M.Print(64, 96 - y0, 'Shirt color');
    M.Print(64, 120 - y0, 'Pants color');

    const label = CL.cls.state !== clientConnectionState.connected ? 'Join Game' : 'Accept Changes';

    M.DrawTextBox(64, 148 - y0, label.length, 1);
    M.PrintWhite(72, 156 - y0, label);

    M.DrawPic(160, 80 - y0, M.bigbox);
    M.DrawPicTranslate(172, 88 - y0, M.menuplyr,
      (M.multiplayer_top << 4) + (M.multiplayer_top >= 8 ? 4 : 11),
      (M.multiplayer_bottom << 4) + (M.multiplayer_bottom >= 8 ? 4 : 11));

    M.DrawCharacter(56, M.multiplayer_cursor_table[M.multiplayer_cursor] - y0, 12 + ((Host.realtime * 4.0) & 1));

    if (M.multiplayer_cursor === 0) {
      M.DrawCharacter(M.multiplayer_joinname.length <= 20 ? 80 + (M.multiplayer_joinname.length << 3) : 248, 56 - y0, 10 + ((Host.realtime * 4.0) & 1));
    } else if (M.multiplayer_cursor === 1) {
      M.DrawCharacter(168 + (M.multiplayer_myname.length << 3), 72 - y0, 10 + ((Host.realtime * 4.0) & 1));
    }
  }

  static MultiPlayer_Key(k: number): void {
    if (k === K.ESCAPE) {
      M.Menu_Main_f();
    }

    switch (k) {
      case K.UPARROW:
        S.LocalSound(M.sfx_menu1);
        if (--M.multiplayer_cursor < 1) {
          M.multiplayer_cursor = M.multiplayer_items - 1;
        }
        return;
      case K.DOWNARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.multiplayer_cursor >= M.multiplayer_items) {
          M.multiplayer_cursor = 1;
        }
        return;
      case K.LEFTARROW:
        if (M.multiplayer_cursor === 2) {
          if (--M.multiplayer_top < 0) {
            M.multiplayer_top = 13;
          }
          S.LocalSound(M.sfx_menu3);
        } else if (M.multiplayer_cursor === 3) {
          if (--M.multiplayer_bottom < 0) {
            M.multiplayer_bottom = 13;
          }
          S.LocalSound(M.sfx_menu3);
        }
        return;
      case K.RIGHTARROW:
        if (M.multiplayer_cursor === 2) {
          (M.multiplayer_top <= 12) ? ++M.multiplayer_top : M.multiplayer_top = 0;
        } else if (M.multiplayer_cursor === 3) {
          (M.multiplayer_bottom <= 12) ? ++M.multiplayer_bottom : M.multiplayer_bottom = 0;
        } else {
          return;
        }
        S.LocalSound(M.sfx_menu3);
        return;
      case K.ENTER:
        switch (M.multiplayer_cursor) {
          case 0:
            S.LocalSound(M.sfx_menu2);
            M.CloseMenu();
            Cmd.text += 'connect "' + M.multiplayer_joinname + '"\n';
            return;
          case 2:
            S.LocalSound(M.sfx_menu3);
            (M.multiplayer_top <= 12) ? ++M.multiplayer_top : M.multiplayer_top = 0;
            return;
          case 3:
            S.LocalSound(M.sfx_menu3);
            (M.multiplayer_bottom <= 12) ? ++M.multiplayer_bottom : M.multiplayer_bottom = 0;
            return;
          case 4:
            if (CL.name.string !== M.multiplayer_myname) {
              Cmd.text += 'name "' + M.multiplayer_myname + '"\n';
            }
            if ((M.multiplayer_top !== M.multiplayer_oldtop) || (M.multiplayer_bottom !== M.multiplayer_oldbottom)) {
              M.multiplayer_oldtop = M.multiplayer_top;
              M.multiplayer_oldbottom = M.multiplayer_bottom;
              Cmd.text += 'color ' + M.multiplayer_top + ' ' + M.multiplayer_bottom + '\n';
            }

            S.LocalSound(M.sfx_menu2);

            if (CL.cls.state !== clientConnectionState.connected) {
              // M.CloseMenu();
              // Cmd.text += 'connect "' + M.multiplayer_joinname + '"\n';
              M.Menu_Launch_Server_f();
              return;
            }

            M.CloseMenu();
            return;
        }
        return;
      case K.BACKSPACE:
        if (M.multiplayer_cursor === 0) {
          if (M.multiplayer_joinname.length !== 0) {
            M.multiplayer_joinname = M.multiplayer_joinname.substring(0, M.multiplayer_joinname.length - 1);
          }
          return;
        }
        if (M.multiplayer_cursor === 1) {
          if (M.multiplayer_myname.length !== 0) {
            M.multiplayer_myname = M.multiplayer_myname.substring(0, M.multiplayer_myname.length - 1);
          }
        }
        return;
    }

    if ((k < 32) || (k > 127)) {
      return;
    }
    if (M.multiplayer_cursor === 0) {
      M.multiplayer_joinname += String.fromCharCode(k);
      return;
    }
    if (M.multiplayer_cursor === 1) {
      if (M.multiplayer_myname.length <= 14) {
        M.multiplayer_myname += String.fromCharCode(k);
      }
    }
  }

  // Options menu
  static Menu_Options_f(): void {
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.options;
    M.entersound = true;
  }

  static AdjustSliders(dir: number): void {
    S.LocalSound(M.sfx_menu3);

    switch (M.options_cursor) {
      case 3: {
        let viewsize = SCR.viewsize.value;
        viewsize += dir * 10;
        if (viewsize < 30) {
          viewsize = 30;
        } else if (viewsize > 120) {
          viewsize = 120;
        }
        Cvar.Set('viewsize', viewsize);
        return;
      }
      case 4: {
        let gamma = V.gamma.value;
        gamma -= dir * 0.05;
        if (gamma < 0.5) {
          gamma = 0.5;
        } else if (gamma > 1.0) {
          gamma = 1.0;
        }
        Cvar.Set('gamma', gamma);
        return;
      }
      case 5: {
        let sensitivity = CL.sensitivity.value;
        sensitivity += dir * 0.5;
        if (sensitivity < 1.0) {
          sensitivity = 1.0;
        } else if (sensitivity > 11.0) {
          sensitivity = 11.0;
        }
        Cvar.Set('sensitivity', sensitivity);
        return;
      }
      case 6: {
        let bgmvolume = S.bgmvolume.value;
        bgmvolume += dir * 0.1;
        if (bgmvolume < 0.0) {
          bgmvolume = 0.0;
        } else if (bgmvolume > 1.0) {
          bgmvolume = 1.0;
        }
        Cvar.Set('bgmvolume', bgmvolume);
        return;
      }
      case 7: {
        let volume = S.volume.value;
        volume += dir * 0.1;
        if (volume < 0.0) {
          volume = 0.0;
        } else if (volume > 1.0) {
          volume = 1.0;
        }
        Cvar.Set('volume', volume);
        return;
      }
      case 8:
        if (CL.forwardspeed.value > 200.0) {
          Cvar.Set('cl_forwardspeed', 200.0);
          Cvar.Set('cl_backspeed', 200.0);
          return;
        }
        Cvar.Set('cl_forwardspeed', 400.0);
        Cvar.Set('cl_backspeed', 400.0);
        return;
      case 9:
        Cvar.Set('m_pitch', -CL.m_pitch.value);
        return;
      case 10:
        Cvar.Set('lookspring', (CL.lookspring.value !== 0) ? 0 : 1);
        return;
      case 11:
        Cvar.Set('lookstrafe', (CL.lookstrafe.value !== 0) ? 0 : 1);
    }
  }

  static DrawSlider(x: number, y: number, range: number): void {
    if (range < 0) {
      range = 0;
    } else if (range > 1) {
      range = 1;
    }
    M.DrawCharacter(x - 8, y, 128);
    M.DrawCharacter(x, y, 129);
    M.DrawCharacter(x + 8, y, 129);
    M.DrawCharacter(x + 16, y, 129);
    M.DrawCharacter(x + 24, y, 129);
    M.DrawCharacter(x + 32, y, 129);
    M.DrawCharacter(x + 40, y, 129);
    M.DrawCharacter(x + 48, y, 129);
    M.DrawCharacter(x + 56, y, 129);
    M.DrawCharacter(x + 64, y, 129);
    M.DrawCharacter(x + 72, y, 129);
    M.DrawCharacter(x + 80, y, 130);
    M.DrawCharacter(x + Math.floor(72 * range), y, 131);
  }

  static Options_Draw(): void {
    M.DrawPic(16, 4, M.qplaque);
    M.DrawPic(160 - (M.p_option.width / 2), 4, M.p_option);

    M.Print(48, 32, 'Customize controls');
    M.Print(88, 40, 'Go to console');
    M.Print(56, 48, 'Reset to defaults');

    M.Print(104, 56, 'Screen size');
    M.DrawSlider(220, 56, (SCR.viewsize.value - 30) / 90);
    M.Print(112, 64, 'Brightness');
    M.DrawSlider(220, 64, (1.0 - V.gamma.value) * 2.0);
    M.Print(104, 72, 'Mouse Speed');
    M.DrawSlider(220, 72, (CL.sensitivity.value - 1) / 10);
    M.Print(72, 80, 'CD Music Volume');
    M.DrawSlider(220, 80, S.bgmvolume.value);
    M.Print(96, 88, 'Sound Volume');
    M.DrawSlider(220, 88, S.volume.value);
    M.Print(112, 96, 'Always Run');
    M.Print(220, 96, (CL.forwardspeed.value > 200.0) ? 'on' : 'off');
    M.Print(96, 104, 'Invert Mouse');
    M.Print(220, 104, (CL.m_pitch.value < 0.0) ? 'on' : 'off');
    M.Print(112, 112, 'Lookspring');
    M.Print(220, 112, (CL.lookspring.value !== 0) ? 'on' : 'off');
    M.Print(112, 120, 'Lookstrafe');
    M.Print(220, 120, (CL.lookstrafe.value !== 0) ? 'on' : 'off');

    M.DrawCharacter(200, 32 + (M.options_cursor << 3), 12 + ((Host.realtime * 4.0) & 1));
  }

  static Options_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.Menu_Main_f();
        return;
      case K.ENTER:
        M.entersound = true;
        switch (M.options_cursor) {
          case 0:
            M.Menu_Keys_f();
            return;
          case 1:
            M.CloseMenu();
            Con.ToggleConsole_f();
            return;
          case 2:
            Cmd.text += 'exec default.cfg\n';
            return;
          default:
            M.AdjustSliders(1);
        }
        return;
      case K.UPARROW:
        S.LocalSound(M.sfx_menu1);
        if (M.options_cursor-- === 0) {
          M.options_cursor = M.options_items - 1;
        }
        return;
      case K.DOWNARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.options_cursor >= M.options_items) {
          M.options_cursor = 0;
        }
        return;
      case K.LEFTARROW:
        M.AdjustSliders(-1);
        return;
      case K.RIGHTARROW:
        M.AdjustSliders(1);
    }
  }

  // Keys menu
  static Menu_Keys_f(): void {
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.keys;
    M.entersound = true;
  }

  static FindKeysForCommand(command: string): number[] {
    const twokeys: number[] = [];
    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] === command) {
        twokeys[twokeys.length] = i;
        if (twokeys.length === 2) {
          return twokeys;
        }
      }
    }
    return twokeys;
  }

  static UnbindCommand(command: string): void {
    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] === command) {
        delete Key.bindings[i];
      }
    }
  }

  static Keys_Draw(): void {
    M.DrawPic(160 - (M.ttl_cstm.width / 2), 4, M.ttl_cstm);

    if (M.bind_grab === true) {
      M.Print(12, 32, 'Press a key or button for this action');
      M.DrawCharacter(130, 48 + (M.keys_cursor << 3), 61);
    } else {
      M.Print(18, 32, 'Enter to change, backspace to clear');
      M.DrawCharacter(130, 48 + (M.keys_cursor << 3), 12 + ((Host.realtime * 4.0) & 1));
    }

    let y = 48;
    let keys: number[];
    let name: string;
    for (let i = 0; i < M.bindnames.length; i++) {
      M.Print(16, y, M.bindnames[i][1]);
      keys = M.FindKeysForCommand(M.bindnames[i][0]);
      if (keys[0] === undefined) {
        M.Print(140, y, '???');
      } else {
        name = Key.KeynumToString(keys[0]);
        if (keys[1] !== undefined) {
          name += ' or ' + Key.KeynumToString(keys[1]);
        }
        M.Print(140, y, name);
      }
      y += 8;
    }
  }

  static Keys_Key(k: number): void {
    if (M.bind_grab === true) {
      S.LocalSound(M.sfx_menu1);
      if ((k !== K.ESCAPE) && (k !== 96)) {
        Cmd.text = 'bind "' + Key.KeynumToString(k) + '" "' + M.bindnames[M.keys_cursor][0] + '"\n' + Cmd.text;
      }
      M.bind_grab = false;
      return;
    }

    switch (k) {
      case K.ESCAPE:
        M.Menu_Options_f();
        return;
      case K.LEFTARROW:
      case K.UPARROW:
        S.LocalSound(M.sfx_menu1);
        if (--M.keys_cursor < 0) {
          M.keys_cursor = M.bindnames.length - 1;
        }
        return;
      case K.DOWNARROW:
      case K.RIGHTARROW:
        S.LocalSound(M.sfx_menu1);
        if (++M.keys_cursor >= M.bindnames.length) {
          M.keys_cursor = 0;
        }
        return;
      case K.ENTER:
        S.LocalSound(M.sfx_menu2);
        if (M.FindKeysForCommand(M.bindnames[M.keys_cursor][0])[1] !== undefined) {
          M.UnbindCommand(M.bindnames[M.keys_cursor][0]);
        }
        M.bind_grab = true;
        return;
      case K.BACKSPACE:
      case K.DEL:
        S.LocalSound(M.sfx_menu2);
        M.UnbindCommand(M.bindnames[M.keys_cursor][0]);
    }
  }

  // Help menu
  static Menu_Help_f(): void {
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.help;
    M.entersound = true;
    M.help_page = 0;
  }

  static Help_Draw(): void {
    M.DrawPic(0, 0, M.help_pages[M.help_page]);
  }

  static Help_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
        M.Menu_Main_f();
        return;
      case K.UPARROW:
      case K.RIGHTARROW:
        M.entersound = true;
        if (++M.help_page >= M.num_help_pages) {
          M.help_page = 0;
        }
        return;
      case K.DOWNARROW:
      case K.LEFTARROW:
        M.entersound = true;
        if (--M.help_page < 0) {
          M.help_page = M.num_help_pages - 1;
        }
    }
  }

  // Quit menu
  static Menu_Quit_f(): void {
    if (M.state.value === M.state.quit) {
      return;
    }
    M.wasInMenus = (Key.dest.value === Key.dest.menu);
    Key.dest.value = Key.dest.menu;
    M.quit_prevstate = M.state.value;
    M.state.value = M.state.quit;
    M.entersound = true;
    M.msgNumber = Math.floor(Math.random() * M.quitMessage.length);
  }

  static Alert(title: string, message: string): void {
    if (M.state.value === M.state.alert) {
      return;
    }
    M.wasInMenus = (Key.dest.value === Key.dest.menu);
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.alert;
    M.entersound = true; // TODO: have a different sound
    M.alertMessage = { title, message };
  }

  static Alert_Draw(): void {
    const { title, message } = M.alertMessage;
    const titleLines = title ? title.split('\n') : [];
    const messageLines = message ? message.split('\n') : [];

    const lines: Array<string | null> = [];
    if (titleLines.length) {
      lines.push(...titleLines);
      lines.push('\x1d' + '\x1e'.repeat(60) + '\x1f');
    }

    lines.push(null);

    if (messageLines.length) {
      lines.push(...messageLines);
    }

    lines.push(null);
    lines.push('Press enter to continue.');

    // Calculate dimensions for the text box
    const boxWidth = 64;
    const totalLines = lines.length;
    const x = (320 - boxWidth * 8) / 2;

    M.DrawTextBox(x, 52, boxWidth, totalLines + 2);

    for (let i = 0, y = 68; i < totalLines; i++, y += 8) {
      if (lines[i]) {
        // Limit each line to 62 characters for safe drawing
        M.PrintWhite(x + 16, y, lines[i]!.substring(0, 62));
      }
    }
  }

  static Alert_Key(k: number): void {
    if (k === K.ENTER || k === K.ESCAPE) {
      M.CloseMenu();
    }
  }

  static Launch_Server_Draw(): void {
    launchServerMenu.draw();
  }

  static Launch_Server_Key(k: number): void {
    if (k === K.ESCAPE) {
      launchServerMenu.deactivate();
      M.CloseMenu();
      return;
    }

    launchServerMenu.handleInput(k);
  }

  static Menu_Launch_Server_f(): void {
    if (M.state.value === M.state.launch_server) {
      return;
    }
    M.wasInMenus = (Key.dest.value === Key.dest.menu);
    Key.dest.value = Key.dest.menu;
    M.state.value = M.state.launch_server;
    M.entersound = true;

    launchServerMenu.activate();
  }

  static Quit_Draw(): void {
    if (M.wasInMenus === true) {
      M.state.value = M.quit_prevstate;
      M.recursiveDraw = true;
      M.Draw();
      M.state.value = M.state.quit;
    }
    M.DrawTextBox(56, 76, 24, 4);
    M.Print(64, 84, M.quitMessage[M.msgNumber][0]);
    M.Print(64, 92, M.quitMessage[M.msgNumber][1]);
    M.Print(64, 100, M.quitMessage[M.msgNumber][2]);
    M.Print(64, 108, M.quitMessage[M.msgNumber][3]);
  }

  static Quit_Key(k: number): void {
    switch (k) {
      case K.ESCAPE:
      case 110:
        if (M.wasInMenus === true) {
          M.state.value = M.quit_prevstate;
          M.entersound = true;
        } else {
          M.CloseMenu();
        }
        break;
      case 121:
        Key.dest.value = Key.dest.console;
        Host.Quit_f();
    }
  }

  // Menu Subsystem
  static async Init(): Promise<void> {
    Cmd.AddCommand('togglemenu', M.ToggleMenu_f);
    Cmd.AddCommand('menu_main', M.Menu_Main_f);
    Cmd.AddCommand('menu_singleplayer', M.Menu_SinglePlayer_f);
    Cmd.AddCommand('menu_load', M.Menu_Load_f);
    Cmd.AddCommand('menu_save', M.Menu_Save_f);
    Cmd.AddCommand('menu_multiplayer', M.Menu_MultiPlayer_f);
    Cmd.AddCommand('menu_setup', M.Menu_MultiPlayer_f);
    Cmd.AddCommand('menu_options', M.Menu_Options_f);
    Cmd.AddCommand('menu_keys', M.Menu_Keys_f);
    Cmd.AddCommand('help', M.Menu_Help_f);
    Cmd.AddCommand('menu_quit', M.Menu_Quit_f);
    Cmd.AddCommand('menu_server_launch', M.Menu_Launch_Server_f);

    M.sfx_menu1 = S.PrecacheSound('misc/menu1.wav');
    M.sfx_menu2 = S.PrecacheSound('misc/menu2.wav');
    M.sfx_menu3 = S.PrecacheSound('misc/menu3.wav');

    M.box_tl = Draw.LoadPicFromLumpDeferred('box_tl');
    M.box_ml = Draw.LoadPicFromLumpDeferred('box_ml');
    M.box_bl = Draw.LoadPicFromLumpDeferred('box_bl');
    M.box_tm = Draw.LoadPicFromLumpDeferred('box_tm');
    M.box_mm = Draw.LoadPicFromLumpDeferred('box_mm');
    M.box_mm2 = Draw.LoadPicFromLumpDeferred('box_mm2');
    M.box_bm = Draw.LoadPicFromLumpDeferred('box_bm');
    M.box_tr = Draw.LoadPicFromLumpDeferred('box_tr');
    M.box_mr = Draw.LoadPicFromLumpDeferred('box_mr');
    M.box_br = Draw.LoadPicFromLumpDeferred('box_br');

    M.qplaque = Draw.LoadPicFromLumpDeferred('qplaque');

    // eslint-disable-next-line require-atomic-updates
    M.menudot = await Promise.all([
      Draw.LoadPicFromLump('menudot1'),
      Draw.LoadPicFromLump('menudot2'),
      Draw.LoadPicFromLump('menudot3'),
      Draw.LoadPicFromLump('menudot4'),
      Draw.LoadPicFromLump('menudot5'),
      Draw.LoadPicFromLump('menudot6'),
    ]);

    // eslint-disable-next-line require-atomic-updates
    M.ttl_main = await Draw.LoadPicFromLump('ttl_main');
    // eslint-disable-next-line require-atomic-updates
    M.mainmenu = await Draw.LoadPicFromLump('mainmenu');

    // eslint-disable-next-line require-atomic-updates
    M.ttl_sgl = Draw.LoadPicFromLumpDeferred('ttl_sgl');
    // eslint-disable-next-line require-atomic-updates
    M.sp_menu = Draw.LoadPicFromLumpDeferred('sp_menu');
    // eslint-disable-next-line require-atomic-updates
    M.p_load = Draw.LoadPicFromLumpDeferred('p_load');
    // eslint-disable-next-line require-atomic-updates
    M.p_save = Draw.LoadPicFromLumpDeferred('p_save');

    // eslint-disable-next-line require-atomic-updates
    M.p_multi = Draw.LoadPicFromLumpDeferred('p_multi');
    // eslint-disable-next-line require-atomic-updates
    M.bigbox = Draw.LoadPicFromLumpDeferred('bigbox');
    // eslint-disable-next-line require-atomic-updates
    M.menuplyr = Draw.LoadPicFromLumpDeferred('menuplyr');

    // FIXME: I really don’t like this, but it’s the only way to get the player picture translation right for now
    {
      const lmpfile = await COM.LoadFile('gfx/menuplyr.lmp');
      if (lmpfile === null) {
        throw new Error('Failed to load gfx/menuplyr.lmp');
      }

      const view = new DataView(lmpfile, 0, 8);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const data = new Uint8Array(lmpfile, 8, width * height);

      const trans = new Uint8Array(new ArrayBuffer(width * height * 4));

      for (let i = 0; i < 4096; i++) {
        const p = data[i];
        if ((p >> 4) === 1) {
          trans[i << 2] = (p & 15) * 17;
          trans[(i << 2) + 1] = 255;
        } else if ((p >> 4) === 6) {
          trans[(i << 2) + 2] = (p & 15) * 17;
          trans[(i << 2) + 3] = 255;
        }
      }

      // eslint-disable-next-line require-atomic-updates
      M.menuplyr.translate = GLTexture.Allocate('menuplyr_translate', width, height, trans);
    }

    // eslint-disable-next-line require-atomic-updates
    M.p_option = Draw.LoadPicFromLumpDeferred('p_option');
    // eslint-disable-next-line require-atomic-updates
    M.ttl_cstm = Draw.LoadPicFromLumpDeferred('ttl_cstm');

    // eslint-disable-next-line require-atomic-updates
    M.help_pages = [
      Draw.LoadPicFromLumpDeferred('help0'),
      Draw.LoadPicFromLumpDeferred('help1'),
      Draw.LoadPicFromLumpDeferred('help2'),
      Draw.LoadPicFromLumpDeferred('help3'),
      Draw.LoadPicFromLumpDeferred('help4'),
      Draw.LoadPicFromLumpDeferred('help5'),
    ];

    await launchServerMenu.init();

    // always close the menu when a connection progresses
    eventBus.subscribe('client.signon', () => {
      M.CloseMenu();
    });
  }

  static Draw(): void {
    if (M.state.value === M.state.none || Key.dest.value !== Key.dest.menu) {
      return;
    }

    if (!M.recursiveDraw) {
      Draw.FadeScreen();
    } else {
      M.recursiveDraw = false;
    }

    switch (M.state.value) {
      case M.state.main:
        M.Main_Draw();
        break;
      case M.state.singleplayer:
        M.SinglePlayer_Draw();
        break;
      case M.state.load:
        M.Load_Draw();
        break;
      case M.state.save:
        M.Save_Draw();
        break;
      case M.state.multiplayer:
        M.MultiPlayer_Draw();
        break;
      case M.state.options:
        M.Options_Draw();
        break;
      case M.state.keys:
        M.Keys_Draw();
        break;
      case M.state.help:
        M.Help_Draw();
        break;
      case M.state.quit:
        M.Quit_Draw();
        break;
      case M.state.alert:
        M.Alert_Draw();
        break;
      case M.state.launch_server:
        M.Launch_Server_Draw();
        break;
    }
    if (M.entersound === true) {
      S.LocalSound(M.sfx_menu2);
      M.entersound = false;
    }
  }

  static Keydown(key: number): void {
    switch (M.state.value) {
      case M.state.main:
        M.Main_Key(key);
        return;
      case M.state.singleplayer:
        M.SinglePlayer_Key(key);
        return;
      case M.state.load:
        M.Load_Key(key);
        return;
      case M.state.save:
        M.Save_Key(key);
        return;
      case M.state.multiplayer:
        M.MultiPlayer_Key(key);
        return;
      case M.state.options:
        M.Options_Key(key);
        return;
      case M.state.keys:
        M.Keys_Key(key);
        return;
      case M.state.help:
        M.Help_Key(key);
        return;
      case M.state.quit:
        M.Quit_Key(key);
        return;
      case M.state.alert:
        M.Alert_Key(key);
        return;
      case M.state.launch_server:
        M.Launch_Server_Key(key);
        return;
    }
  }
}
