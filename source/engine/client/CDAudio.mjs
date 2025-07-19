import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../common/Q.mjs';
import { eventBus, registry } from '../registry.mjs';

let { COM, Con, S } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  S = registry.S;
});

export default class CDAudio {
  /** @type {Function[]} */
  static #eventListeners = [];
  /** @type {string[]} */
  static known = [];
  static initialized = false;
  static enabled = false;
  static playTrack = null;
  /** @type {HTMLAudioElement} */
  static cd = null;
  static cdvolume = 1.0;

  static Play(track, looping) {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    track -= 2;
    if (CDAudio.playTrack === track) {
      if (CDAudio.cd !== null) {
        CDAudio.cd.loop = looping;
        if (looping === true && CDAudio.cd.paused === true) {
          CDAudio.cd.play(); // FIXME: await
        }
      }
      return;
    }
    if (track < 0 || track >= CDAudio.known.length) {
      Con.DPrint('CDAudio.Play: Bad track number ' + (track + 2) + '.\n');
      return;
    }
    CDAudio.Stop();
    CDAudio.playTrack = track;
    CDAudio.cd = new Audio(CDAudio.known[track]);
    CDAudio.cd.loop = looping;
    CDAudio.cd.volume = CDAudio.cdvolume;
    CDAudio.cd.play(); // FIXME: await
  }

  static Stop() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
    CDAudio.playTrack = null;
    CDAudio.cd = null;
  }

  static Pause() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
  }

  static Resume() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.play(); // FIXME: await
    }
  }

  static CD_f(command, track) {
    if (!CDAudio.initialized || !command || !track) {
      return;
    }
    switch (command.toLowerCase()) {
      case 'on':
        CDAudio.enabled = true;
        return;
      case 'off':
        CDAudio.Stop();
        CDAudio.enabled = false;
        return;
      case 'play':
        CDAudio.Play(Q.atoi(track), false);
        return;
      case 'loop':
        CDAudio.Play(Q.atoi(track), true);
        return;
      case 'stop':
        CDAudio.Stop();
        return;
      case 'pause':
        CDAudio.Pause();
        return;
      case 'resume':
        CDAudio.Resume();
        return;
      case 'info':
        Con.Print(CDAudio.known.length + ' tracks\n');
        if (CDAudio.cd !== null) {
          if (CDAudio.cd.paused !== true) {
            Con.Print('Currently ' + (CDAudio.cd.loop === true ? 'looping' : 'playing') + ' track ' + (CDAudio.playTrack + 2) + '\n');
          }
        }
        Con.Print('Volume is ' + CDAudio.cdvolume + '\n');
        return;
    }
  }

  static Update() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (S.bgmvolume.value === CDAudio.cdvolume) {
      return;
    }
    if (S.bgmvolume.value < 0.0) {
      Cvar.SetValue('bgmvolume', 0.0);
    } else if (S.bgmvolume.value > 1.0) {
      Cvar.SetValue('bgmvolume', 1.0);
    }
    CDAudio.cdvolume = S.bgmvolume.value;
    if (CDAudio.cd !== null) {
      CDAudio.cd.volume = CDAudio.cdvolume;
    }
  }

  static async Init() {
    Cmd.AddCommand('cd', CDAudio.CD_f.bind(CDAudio));
    if (COM.CheckParm('-nocdaudio')) {
      return;
    }
    for (let i = 1; i <= 99; i++) {
      const track = '/media/quake' + (i <= 9 ? '0' : '') + i + '.ogg';
      let found = false;
      for (let j = COM.searchpaths.length - 1; j >= 0; j--) {
        try {
          const res = await fetch(COM.searchpaths[j].filename + track, { method: 'HEAD' });
          if (res.ok) {
            CDAudio.known[i - 1] = COM.searchpaths[j].filename + track;
            found = true;
            break;
          }
        // eslint-disable-next-line no-unused-vars
        } catch (e) {
          // ignore fetch errors
        }
      }
      if (!found) {
        break;
      }
    }
    if (CDAudio.known.length === 0) {
      Con.Print('No CD Audio tracks found.\n');
      CDAudio.initialized = CDAudio.enabled = false;
      return;
    }
    CDAudio.initialized = CDAudio.enabled = true;
    CDAudio.Update();
    CDAudio.#eventListeners.push(eventBus.subscribe('client.cdtrack', (track) => CDAudio.Play(track, true)));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.paused', () => CDAudio.Pause()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.unpaused', () => CDAudio.Resume()));
    Con.Print('CD Audio Initialized\n');
  }

  static Shutdown() {
    for (const unsubscribe of CDAudio.#eventListeners) {
      unsubscribe();
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
      CDAudio.cd = null;
    }
    CDAudio.playTrack = null;
    CDAudio.known = [];
    CDAudio.initialized = false;
    CDAudio.enabled = false;
  }
};
