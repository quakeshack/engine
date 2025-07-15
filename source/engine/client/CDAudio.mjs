import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../common/Q.mjs';
import { eventBus, registry } from '../registry.mjs';

const CDAudio = {};

export default CDAudio;

let { COM, Con, S } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  S = registry.S;
});

CDAudio.known = [];

CDAudio.Play = function(track, looping) {
  if ((CDAudio.initialized !== true) || (CDAudio.enabled !== true)) {
    return;
  }
  track -= 2;
  if (CDAudio.playTrack === track) {
    if (CDAudio.cd != null) {
      CDAudio.cd.loop = looping;
      if ((looping === true) && (CDAudio.cd.paused === true)) {
        S.HandlePlayPromise('CDAudio.Play', CDAudio.cd.play());
      }
    }
    return;
  }
  if ((track < 0) || (track >= CDAudio.known.length)) {
    Con.DPrint('CDAudio.Play: Bad track number ' + (track + 2) + '.\n');
    return;
  }
  CDAudio.Stop();
  CDAudio.playTrack = track;
  CDAudio.cd = new Audio(CDAudio.known[track]);
  CDAudio.cd.loop = looping;
  CDAudio.cd.volume = CDAudio.cdvolume;
  S.HandlePlayPromise('CDAudio.Play', CDAudio.cd.play());
};

CDAudio.Stop = function() {
  if ((CDAudio.initialized !== true) || (CDAudio.enabled !== true)) {
    return;
  }
  if (CDAudio.cd != null) {
    CDAudio.cd.pause();
  }
  CDAudio.playTrack = null;
  CDAudio.cd = null;
};

CDAudio.Pause = function() {
  if ((CDAudio.initialized !== true) || (CDAudio.enabled !== true)) {
    return;
  }
  if (CDAudio.cd != null) {
    CDAudio.cd.pause();
  }
};

CDAudio.Resume = function() {
  if ((CDAudio.initialized !== true) || (CDAudio.enabled !== true)) {
    return;
  }
  if (CDAudio.cd != null) {
    S.HandlePlayPromise('CDAudio.Resume', CDAudio.cd.play());
  }
};

CDAudio.CD_f = function(command, track) {
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
      if (CDAudio.cd != null) {
        if (CDAudio.cd.paused !== true) {
          Con.Print('Currently ' + (CDAudio.cd.loop === true ? 'looping' : 'playing') + ' track ' + (CDAudio.playTrack + 2) + '\n');
        }
      }
      Con.Print('Volume is ' + CDAudio.cdvolume + '\n');
      return;
  }
};

CDAudio.Update = function() {
  if ((CDAudio.initialized !== true) || (CDAudio.enabled !== true)) {
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
  if (CDAudio.cd != null) {
    CDAudio.cd.volume = CDAudio.cdvolume;
  }
};

CDAudio.Init = function() {
  Cmd.AddCommand('cd', CDAudio.CD_f);
  if (COM.CheckParm('-nocdaudio')) {
    return;
  }
  let i; let j; let track;
  const xhr = new XMLHttpRequest();
  for (i = 1; i <= 99; ++i) {
    track = '/media/quake' + (i <= 9 ? '0' : '') + i + '.ogg';
    for (j = COM.searchpaths.length - 1; j >= 0; --j) {
      xhr.open('HEAD', COM.searchpaths[j].filename + track, false);
      xhr.send();
      if ((xhr.status >= 200) && (xhr.status <= 299)) {
        CDAudio.known[i - 1] = COM.searchpaths[j].filename + track;
        break;
      }
    }
    if (j < 0) {
      break;
    }
  }
  if (CDAudio.known.length === 0) {
    return;
  }
  CDAudio.initialized = CDAudio.enabled = true;
  CDAudio.Update();
  Con.Print('CD Audio Initialized\n');
};
