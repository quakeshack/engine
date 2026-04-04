import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import Q from '../../shared/Q.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';

let { COM, Con, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, S } = getClientRegistry());
});

export default class CDAudio {
  static readonly #eventListeners: Array<() => void> = [];
  static initialized = false;
  static enabled = false;
  static playTrack: number | null = null;
  static cd: HTMLAudioElement | null = null;
  static cdvolume = 1.0;

  static #playCurrentTrack(): void {
    if (CDAudio.cd === null || CDAudio.playTrack === null) {
      return;
    }

    CDAudio.cd.play().catch((error: unknown) => {
      Con.PrintWarning(`Could not play track ${CDAudio.playTrack}: ${String(error)}\n`);
      CDAudio.Stop();
    });
  }

  static Play(track: number, looping: boolean): void {
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

  static Stop(): void {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }

    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }

    CDAudio.playTrack = null;
    CDAudio.cd = null;
  }

  static Pause(): void {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }

    CDAudio.cd?.pause();
  }

  static Resume(): void {
    if (!CDAudio.initialized || !CDAudio.enabled) {
      return;
    }

    if (CDAudio.cd !== null) {
      CDAudio.#playCurrentTrack();
    }
  }

  static CD_f(command?: string, track?: string): void {
    if (!CDAudio.initialized) {
      Con.PrintWarning('CD Audio not initialized\n');
      return;
    }

    switch ((command ?? '').toLowerCase()) {
      case 'on':
        CDAudio.enabled = true;
        return;
      case 'off':
        CDAudio.Stop();
        CDAudio.enabled = false;
        return;
      case 'play':
        CDAudio.Play(Q.atoi(track ?? ''), false);
        return;
      case 'loop':
        CDAudio.Play(Q.atoi(track ?? ''), true);
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
        if (CDAudio.cd !== null && !CDAudio.cd.paused) {
          const playbackMode = CDAudio.cd.loop ? 'looping' : 'playing';
          const path = new URL(CDAudio.cd.src).pathname;
          Con.Print(`Currently ${playbackMode} ${path}\n`);
        }
        Con.Print(`Volume is ${CDAudio.cdvolume}\n`);
        return;
      default:
        Con.Print('Unknown command.  Commands are on, off, play, loop, stop, pause, resume, info\n');
        return;
    }
  }

  static Update(): void {
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

  static Init(): void {
    Cmd.AddCommand('cd', CDAudio.CD_f.bind(CDAudio));
    if (COM.CheckParm('-nocdaudio') || COM.CheckParm('-nosound')) {
      return;
    }

    CDAudio.initialized = true;
    CDAudio.enabled = true;
    CDAudio.Update();
    CDAudio.#eventListeners.push(eventBus.subscribe('client.cdtrack', (track: number) => CDAudio.Play(track, true)));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.paused', () => CDAudio.Pause()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.unpaused', () => CDAudio.Resume()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.disconnected', () => CDAudio.Stop()));
    Con.DPrint('CD Audio Initialized\n');
  }

  static Shutdown(): void {
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
}
