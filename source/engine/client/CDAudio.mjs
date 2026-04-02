import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import Q from '../../shared/Q.ts';
import { eventBus, registry } from '../registry.mjs';

let { COM, Con, S } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, S } = registry);
});

export default class CDAudio {
  /** @type {Array<() => void>} */
  static #eventListeners = [];
  static initialized = false;
  static enabled = false;
  /** @type {number | null} */
  static playTrack = null;
  /** @type {HTMLAudioElement | null} */
  static cd = null;
  static cdvolume = 1.0;

  static #playCurrentTrack() {
    if (CDAudio.cd === null || CDAudio.playTrack === null) {
      return;
    }

    CDAudio.cd.play().catch((error) => {
      Con.PrintWarning(`Could not play track ${CDAudio.playTrack}: ${error}\n`);
      CDAudio.Stop();
    });
  }

  static Play(track, looping) {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }
    if (CDAudio.playTrack === track) {
      if (CDAudio.cd !== null) {
        CDAudio.cd.loop = looping;
        if (looping && CDAudio.cd.paused) {
          CDAudio.#playCurrentTrack();
        }
      }
      return;
    }
    CDAudio.Stop();
    CDAudio.playTrack = track;
    CDAudio.cd = new Audio(COM.GetNetpath(`music/${track}.opus`));
    CDAudio.cd.loop = looping;
    CDAudio.cd.volume = CDAudio.cdvolume;
    CDAudio.#playCurrentTrack();
  }

  static Stop() {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
    CDAudio.playTrack = null;
    CDAudio.cd = null;
  }

  static Pause() {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
  }

  static Resume() {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.#playCurrentTrack();
    }
  }

  static CD_f(command, track) {
    if (!CDAudio.initialized) {
      Con.PrintWarning('CD Audio not initialized\n');
      return;
    }
    switch (String(command).toLowerCase()) {
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
        if (CDAudio.cd !== null) {
          if (!CDAudio.cd.paused) {
            const playbackMode = CDAudio.cd.loop ? 'looping' : 'playing';
            const path = new URL(CDAudio.cd.src).pathname;
            Con.Print(`Currently ${playbackMode} ${path}\n`);
          }
        }
        Con.Print(`Volume is ${CDAudio.cdvolume}\n`);
        return;
      default:
        Con.Print('Unknown command.  Commands are on, off, play, loop, stop, pause, resume, info\n');
        return;
    }
  }

  static Update() {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }
    if (S.bgmvolume.value === CDAudio.cdvolume) {
      return;
    }
    if (S.bgmvolume.value < 0.0) {
      Cvar.Set('bgmvolume', 0.0);
    } else if (S.bgmvolume.value > 1.0) {
      Cvar.Set('bgmvolume', 1.0);
    }
    CDAudio.cdvolume = S.bgmvolume.value;
    if (CDAudio.cd !== null) {
      CDAudio.cd.volume = CDAudio.cdvolume;
    }
  }

  static Init() {
    Cmd.AddCommand('cd', CDAudio.CD_f.bind(CDAudio));
    if (COM.CheckParm('-nocdaudio') || COM.CheckParm('-nosound')) {
      return;
    }
    CDAudio.initialized = CDAudio.enabled = true;
    CDAudio.Update();
    CDAudio.#eventListeners.push(eventBus.subscribe('client.cdtrack', (track) => CDAudio.Play(track, true)));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.paused', () => CDAudio.Pause()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.unpaused', () => CDAudio.Resume()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.disconnected', () => CDAudio.Stop()));
    Con.DPrint('CD Audio Initialized\n');
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
    CDAudio.initialized = false;
    CDAudio.enabled = false;
  }
};
