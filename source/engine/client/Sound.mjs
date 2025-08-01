import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../common/Q.mjs';
import { eventBus, registry } from '../registry.mjs';

let { CL, COM, Con, Host, Mod } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
});

export class SFX {
  static STATE = {
    NEW: 'new',
    LOADING: 'loading',
    AVAILABLE: 'available',
    FAILED: 'failed',
  };

  constructor(name) {
    this.name = name;
    this.cache = null;
    this.state = SFX.STATE.NEW;
    this.loadtime = null;

    this._availableQueue = [];
  }

  queueAvailableHandler(handler) {
    this._availableQueue.push(handler);

    return this;
  }

  makeAvailable() {
    this.state = SFX.STATE.AVAILABLE;

    while (this._availableQueue.length > 0) {
      const handler = this._availableQueue.shift();
      handler(this);
    }

    return this;
  }

  async load() {
    if (this.state !== SFX.STATE.NEW) {
      return false;
    }

    return await S.LoadSound(this);
  }
}

class SoundBaseChannel {
  static STATE = {
    NOT_READY: 'not-ready',
    STOPPED: 'stopped',
    PLAYING: 'playing',
  };

  constructor(S) {
    this._S = S;
    this.reset();
  }

  reset() {
    this.stop();

    this.sfx = null;

    this.origin = new Vector();
    this.dist_mult = 0;
    this.entnum = null;
    this.entchannel = null;

    this.end = 0.0;
    this.pos = 0.0;

    this.master_vol = 0.0;
    this.left_vol = 0.0;
    this.right_vol = 0.0;

    this._playFailedTime = null;
    this._state = SoundBaseChannel.STATE.NOT_READY;

    return this;
  }

  withOrigin(origin) {
    this.origin = origin.copy();
    this.spatialize();

    return this;
  }

  withSfx(sfx) {
    this.sfx = sfx;

    if (!sfx) {
      this.reset();
    }

    return this;
  }

  // eslint-disable-next-line no-unused-vars
  static async decodeAudioData(rawData) {
    return null;
  }

  loadData() {
    return this;
  }

  stop() {
    return this;
  }

  start() {
    return this;
  }

  updateVol() {
    return this;
  }

  updateLoop() {
    return this;
  }

  /**
   * (Re)computes left_vol and right_vol for a channel based on the listener position/orientation.
   */
  spatialize() {
    this._S = S;

    // If channel is from the player's own gun, full volume in both ears
    if (this.entnum === CL.state.viewentity) {
      this.left_vol = this.master_vol;
      this.right_vol = this.master_vol;
      this.updateVol();
      return this;
    }

    // Calculate distance from the listener
    const source = [
      this.origin[0] - this._S._listenerOrigin[0],
      this.origin[1] - this._S._listenerOrigin[1],
      this.origin[2] - this._S._listenerOrigin[2],
    ];

    let dist = Math.sqrt(source[0] * source[0] + source[1] * source[1] + source[2] * source[2]);
    if (dist !== 0.0) {
      source[0] /= dist;
      source[1] /= dist;
      source[2] /= dist;
    }
    dist *= this.dist_mult;

    // Dot product with the listener's right vector
    const dot = (
      this._S._listenerRight[0] * source[0] +
      this._S._listenerRight[1] * source[1] +
      this._S._listenerRight[2] * source[2]
    );

    const adjustedVolume = (1.0 - dist);
    const left = adjustedVolume * (1.0 - dot);
    const right = adjustedVolume * (1.0 + dot);

    this.right_vol = Math.max(0, this.master_vol * right);
    this.left_vol = Math.max(0, this.master_vol * left);
    this.updateVol();

    return this;
  }
}

class AudioContextChannel extends SoundBaseChannel {
  static async decodeAudioData(rawData) {
    return await S._context.decodeAudioData(rawData);
  }

  reset() {
    super.reset();

    this._nodes = null;

    return this;
  }

  loadData() {
    if (!this._S._started || !this.sfx || this.sfx.state === SFX.STATE.FAILED) {
      this._state = SoundBaseChannel.STATE.NOT_READY;
      return this;
    }

    const sc = this.sfx.cache;

    const nodes = {
      source: this._S._context.createBufferSource(),
      merger1: this._S._context.createChannelMerger(2),
      splitter: this._S._context.createChannelSplitter(2),
      gain0: this._S._context.createGain(),
      gain1: this._S._context.createGain(),
      merger2: this._S._context.createChannelMerger(2),
    };

    nodes.source.buffer = sc.data;

    // looping
    if (sc.loopstart !== null) {
      nodes.source.loop = true;
      nodes.source.loopStart = sc.loopstart;
      nodes.source.loopEnd = sc.data.duration;
    }

    // Duplicate into left & right channels
    nodes.source.connect(nodes.merger1);
    nodes.source.connect(nodes.merger1, 0, 1);
    nodes.merger1.connect(nodes.splitter);

    // Gains
    nodes.splitter.connect(nodes.gain0, 0);
    nodes.splitter.connect(nodes.gain1, 1);

    // Set initial volume
    this.updateVol();

    // Merge back to stereo
    nodes.gain0.connect(nodes.merger2, 0, 0);
    nodes.gain1.connect(nodes.merger2, 0, 1);
    nodes.merger2.connect(this._S._context.destination);

    this._nodes = nodes;

    this._state = SoundBaseChannel.STATE.STOPPED;

    return this;
  }

  updateVol() {
    if (!this._nodes) {
      return this;
    }

    const leftVol = Math.min(this.left_vol, 1.0) * this._S.volume.value;
    const rightVol = Math.min(this.right_vol, 1.0) * this._S.volume.value;
    this._nodes.gain0.gain.value = leftVol;
    this._nodes.gain1.gain.value = rightVol;

    return this;
  }

  stop() {
    if (this._state !== SoundBaseChannel.STATE.PLAYING) {
      return this;
    }

    if (this._nodes.source) {
      this._nodes.source.stop(0);
    }

    this._state = SoundBaseChannel.STATE.STOPPED;
    return this;
  }

  start() {
    if (this._state !== SoundBaseChannel.STATE.STOPPED) {
      return this;
    }

    if (this._nodes.source) {
      this._nodes.source.start(0, this.pos);
    }

    this._state = SoundBaseChannel.STATE.PLAYING;
    return this;
  }
}

class AudioElementChannel extends SoundBaseChannel {
  static async decodeAudioData(rawData) {
    return new Audio(`data:audio/wav;base64,${Q.btoa(new Uint8Array(rawData))}`);
  }

  loadData() {
    if (!this._S._started || !this.sfx || this.sfx.state === SFX.STATE.FAILED) {
      this._state = SoundBaseChannel.STATE.NOT_READY;
      return this;
    }

    this._audio = this.sfx.cache.data.cloneNode();
    this._audio.pause();

    this._audio.loop = this.sfx.cache.loopstart !== null;

    this.updateVol();

    this._state = SoundBaseChannel.STATE.STOPPED;

    return this;
  }

  updateVol() {
    if (!this._audio) {
      return this;
    }

    const volume = Math.min((this.left_vol + this.right_vol) * 0.5, 1.0);
    this._audio.volume = volume * this._S.volume.value;

    return this;
  }

  updateLoop() {
    if (!this.sfx || !this.sfx.cache) {
      return this;
    }

    try {
      this._audio.currentTime = this.sfx.cache.loopstart;
      this.end = Host.realtime + this.sfx.cache.length - (this.sfx.cache.loopstart || 0);
    } catch (e) {
      Con.DPrint(`AudioElementChannel.updateLoop: failed to set currentTime, ${e.message}`);
      this.end = Host.realtime;
    }

    return this;
  }

  stop() {
    if (this._state !== SoundBaseChannel.STATE.PLAYING) {
      return this;
    }

    this._audio.pause();

    this._state = SoundBaseChannel.STATE.STOPPED;
    return this;
  }

  start() {
    if (this._state !== SoundBaseChannel.STATE.STOPPED) {
      return this;
    }

    // If we tried playing too recently, wait a bit
    if (Host.realtime - (this._playFailedTime || 0) < 3) {
      return this;
    }

    this._audio.currentTime = this.pos;
    this._audio.play().catch((e) => {
      Con.Print(`AudioElementChannel.start: failed to play audio, ${e.message}, retrying later\n`);
      this._playFailedTime = Host.realtime;
    }).then(() => {
      this._playFailedTime = null;
    });

    this._state = SoundBaseChannel.STATE.PLAYING;
    return this;
  }
}

const S = {
  _channels: [],
  _staticChannels: [],
  _ambientChannels: [],
  _knownSfx: [],

  // Listener state
  _listenerOrigin: new Vector(),
  _listenerForward: new Vector(),
  _listenerRight: new Vector(),
  _listenerUp: new Vector(),

  _started: false,
  _context: null,

  // Cvars
  _precache: null,
  _nosound: null,
  _ambientLevel: null,
  _ambientFade: null,

  // Public Cvars
  volume: null,
  bgmvolume: null,

  _NewChannel() {
    return new this._channelDriver(this);
  },

  /**
   * Picks or finds an available channel for a new sound to Play on.
   * Possibly kills an older channel from same entnum/entchannel.
   * @param entnum
   * @param entchannel
   */
  PickChannel(entnum, entchannel) {
    let i;
    let channel = null;

    // If entchannel != 0, see if there is an existing channel with the same
    // entnum and entchannel. If so, kill it.
    if (entchannel !== 0) {
      for (i = 0; i < this._channels.length; i++) {
        channel = this._channels[i];
        if (!channel) {
          continue;
        }
        const matchingEnt = (channel.entnum === entnum);
        const matchingChan = (channel.entchannel === entchannel) || (entchannel === -1);
        if (matchingEnt && matchingChan) {
          // Kill old
          channel.reset();
          break;
        }
      }
    }

    // If entchannel == 0 or we never found a free channel, pick a free or new channel.
    if ((entchannel === 0) || (i === this._channels.length)) {
      for (i = 0; i < this._channels.length; i++) {
        channel = this._channels[i];
        if (!channel || !channel.sfx) {
          break;
        }
      }
    }
    if (i === this._channels.length) {
      // No free channel found, allocate a new one
      this._channels[i] = this._NewChannel();
    }
    this._channels[i].reset();
    return this._channels[i];
  },

  //
  // --- Initialization
  //

  Init() {
    Cmd.AddCommand('play', this.Play_f.bind(this));
    Cmd.AddCommand('playvol', this.PlayVol_f.bind(this));
    Cmd.AddCommand('stopsound', this.StopAllSounds.bind(this));
    Cmd.AddCommand('soundlist', this.SoundList_f.bind(this));

    this._nosound = new Cvar('nosound', COM.CheckParm('-nosound') ? '1' : '0', Cvar.FLAG.READONLY);
    this.volume = new Cvar('volume', '0.7', Cvar.FLAG.ARCHIVE);
    this._precache = new Cvar('precache', '1');
    this.bgmvolume = new Cvar('bgmvolume', '1', Cvar.FLAG.ARCHIVE);
    this._ambientLevel = new Cvar('ambient_level', '0.3');
    this._ambientFade = new Cvar('ambient_fade', '100');

    // Attempt to create an AudioContext
    try {
      this._context = new AudioContext({sampleRate: 22050});
      this._channelDriver = AudioContextChannel;
    } catch (e) {
      Con.Print(`S.Init: failed to initialize AudioContextChannel (${e.message}), falling back to AudioElementChannel.\n`);
      this._context = null;
      this._channelDriver = AudioElementChannel;
    }

    this._started = true;

    // Initialize ambient channels
    for (const ambientSfx of ['water1', 'wind2']) {
      const name = `ambience/${ambientSfx}.wav`;

      const sfx = this.PrecacheSound(name);

      if (!sfx) {
        return;
      }

      const ch = this._NewChannel().withSfx(sfx);

      this._ambientChannels.push(ch);

      sfx.queueAvailableHandler(() => {
        ch.loadData();
        ch.updateVol();
        ch.start();

        if (sfx.cache.loopstart === null) {
          Con.Print(`S.Init: Sound ${name} not looped\n`);
        }
      });

      if (sfx.state === SFX.STATE.NEW) {
        this.LoadSound(sfx);
      }
    }

    Con.Print('Sound subsystem initialized.\n');
  },

  Shutdown() {
    this.StopAllSounds();
    setTimeout(() => this.StopAllSounds(), 1000); // poor man’s version of fixing issues
    this._started = false;
    setTimeout(() => {
      this._knownSfx = [];
    }, 1001);
    Con.Print('S.Shutdown: sound subsystem shut down.\n');
  },

  //
  // --- Sound data loading
  //

  /**
   * Slowly load all other pending files
   */
  LoadPendingFiles() {
    const pendingSfx = this._knownSfx.filter((sfx) => sfx.state === SFX.STATE.NEW);

    if (pendingSfx.length === 0) {
      return;
    }

    const promises = [];

    // load up to four at a time
    for (let i = 0; i < Math.min(pendingSfx.length, 4); i++) {
      promises.push(pendingSfx[i].load());
    }

    // wait for all of them, process next batch
    Promise.all(promises).then(() => {
      this.LoadPendingFiles();
    });
  },

  /**
   * Precache a sound by name. Optionally load it if precache cvar is set.
   * @param name
   * @returns {SFX|null} The SFX object or null if sound is disabled.
   */
  PrecacheSound(name) {
    if (this._nosound.value !== 0) {
      return null;
    }
    // Search known list
    let sfx = this._knownSfx.find((k) => k.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      this._knownSfx.push(sfx);
    }
    if (this._precache.value !== 0) {
      // we do not need all sounds right away, let’s prioritize them
      if (sfx.state === SFX.STATE.NEW) {
        this.LoadSound(sfx).catch((error) => {
          if (!this._started) {
            return;
          }

          Con.Print(`S.PrecacheSound: async precaching ${name} failed, ${error}\n`);
        });
      }
    }
    return sfx;
  },

  async PrecacheSoundAsync(name) {
    if (this._nosound.value !== 0) {
      return null;
    }
    // Search known list
    let sfx = this._knownSfx.find((k) => k.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      this._knownSfx.push(sfx);
    }
    if (this._precache.value !== 0) {
      // we do not need all sounds right away, let’s prioritize them
      if (sfx.state === SFX.STATE.NEW) {
        await this.LoadSound(sfx);
      }
    }
    return sfx;
  },

  /**
   * Actually load sound data and decode it.
   * @param sfx
   */
  async LoadSound(sfx) {
    if (!this._started || this._nosound.value !== 0) {
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    if (sfx.state === SFX.STATE.LOADING) {
      throw new Error('LoadSound on isLoading = true');
    }

    if ([SFX.STATE.AVAILABLE, SFX.STATE.FAILED].includes(sfx.state)) {
      // Already loaded or given up on
      return sfx.cache !== null;
    }

    const sc = {
      length: null,
      size: null,
      data: null,
      loopstart: null,
    };

    sfx.state = SFX.STATE.LOADING;
    sfx.loadtime = Host.realtime || null;
    const data = await COM.LoadFileAsync(`sound/${sfx.name}`);

    if (!data) {
      if (!this._started) {
        return false;
      }

      Con.Print(`S.LoadSound: Couldn't load ${sfx.name}\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    if (!this._started) {
      Con.Print(`S.LoadSound: Loaded sound ${sfx.name} after sound subsystem shutdown.\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    // Minimal parsing of a WAV
    let view = new DataView(data);
    // Quick check for 'RIFF' & 'WAVE'
    if (view.getUint32(0, true) !== 0x46464952 || view.getUint32(8, true) !== 0x45564157) {
      Con.Print(`S.LoadSound: Missing RIFF/WAVE chunks on ${sfx.name}\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    let p = 12;
    let fmt = null;
    let dataOfs = null;
    let dataLen = null;
    let loopstart = null;
    let cueFound = false;
    let totalSamples = null;

    while (p < data.byteLength) {
      const chunkId = view.getUint32(p, true);
      const chunkSize = view.getUint32(p + 4, true);
      switch (chunkId) {
        case 0x20746d66: // 'fmt '
          if (view.getInt16(p + 8, true) !== 1) {
            Con.Print(`S.LoadSound: ${sfx.name} is not in Microsoft PCM format\n`);
            sfx.state = SFX.STATE.FAILED;
            return false;
          }
          fmt = {
            channels: view.getUint16(p + 10, true),
            samplesPerSec: view.getUint32(p + 12, true),
            avgBytesPerSec: view.getUint32(p + 16, true),
            blockAlign: view.getUint16(p + 20, true),
            bitsPerSample: view.getUint16(p + 22, true),
          };
          break;
        case 0x61746164: // 'data'
          dataOfs = p + 8;
          dataLen = chunkSize;
          break;
        case 0x20657563: // 'cue '
          cueFound = true;
          loopstart = view.getUint32(p + 32, true);
          break;
        case 0x5453494c: // 'LIST'
          if (cueFound === true) {
            // 'cue' chunk was found earlier, so let's interpret the 'LIST' chunk
            cueFound = false;
            if (view.getUint32(p + 28, true) === 0x6b72616d) { // 'mark'
              totalSamples = loopstart + view.getUint32(p + 24, true);
            }
          }
          break;
        default:
          break;
      }
      p += (chunkSize + 8);
      if (p & 1) { // pad if needed
        p += 1;
      }
    }

    if (!fmt) {
      Con.Print(`S.LoadSound: ${sfx.name} is missing the fmt chunk\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }
    if (dataOfs === null) {
      Con.Print(`S.LoadSound: ${sfx.name} is missing the data chunk\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    // Convert loopstart from "samples" to "seconds" if we have it
    if (loopstart !== null) {
      sc.loopstart = loopstart * fmt.blockAlign / fmt.samplesPerSec;
    } else {
      sc.loopstart = null;
    }

    if (totalSamples !== null) {
      sc.length = totalSamples / fmt.samplesPerSec;
    } else {
      sc.length = dataLen / fmt.avgBytesPerSec;
    }
    sc.size = dataLen + 44;
    if (sc.size & 1) {
      sc.size++;
    }

    // Construct a new valid WAV in an ArrayBuffer
    const out = new ArrayBuffer(sc.size);
    view = new DataView(out);
    // RIFF
    view.setUint32(0, 0x46464952, true); // 'RIFF'
    view.setUint32(4, sc.size - 8, true);
    view.setUint32(8, 0x45564157, true); // 'WAVE'
    // fmt
    view.setUint32(12, 0x20746d66, true); // 'fmt '
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, fmt.channels, true);
    view.setUint32(24, fmt.samplesPerSec, true);
    view.setUint32(28, fmt.avgBytesPerSec, true);
    view.setUint16(32, fmt.blockAlign, true);
    view.setUint16(34, fmt.bitsPerSample, true);
    // data
    view.setUint32(36, 0x61746164, true); // 'data'
    view.setUint32(40, dataLen, true);
    new Uint8Array(out, 44, dataLen).set(new Uint8Array(data, dataOfs, dataLen));

    sc.data = await this._channelDriver.decodeAudioData(out);
    // eslint-disable-next-line require-atomic-updates
    sfx.cache = sc;
    sfx.makeAvailable();

    return true;
  },

  //
  // --- Playing sounds
  //

  StartSound(entnum, entchannel, sfx, origin, vol, attenuation) {
    if (this._nosound.value !== 0 || !sfx) {
      return;
    }

    // 1) Create a local callback that sets up the channel once data is loaded
    const onDataAvailable = (sc) => {
      // Pick or free a channel
      const targetChan = this.PickChannel(entnum, entchannel).withSfx(sfx);
      targetChan.origin = origin.copy();
      targetChan.dist_mult = attenuation * 0.001;
      targetChan.master_vol = vol;
      targetChan.entnum = entnum;
      targetChan.entchannel = entchannel;

      // Spatialize
      targetChan.spatialize();

      // Out of reach
      if (targetChan.left_vol <= 0 && targetChan.right_vol <= 0) {
        return;
      }

      targetChan.pos = 0.0;
      targetChan.end = Host.realtime + sc.length;

      // Load channel data
      targetChan.loadData();

      // Play immediately
      targetChan.start();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      // 2) If already cached, call onDataAvailable immediately
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === SFX.STATE.NEW) {
      // 3) Not cached yet
      this.LoadSound(sfx).then((res) => {
        if (!res) {
          return;
        }

        // jump back up to playing it
        onDataAvailable(sfx.cache);
      });
      return;
    }
  },

  StopSound(entnum, entchannel) {
    if (this._nosound.value !== 0) {
      return;
    }

    // release that channel
    const ch = this._channels.find((ch) => ch && ch.entnum === entnum && ch.entchannel === entchannel);

    console.assert(ch, 'valid channel', entnum, entchannel);

    ch.stop();
  },

  StopAllSounds() {
    if (this._nosound.value !== 0) {
      return;
    }

    // Ambient channels
    for (const ch of this._ambientChannels) {
      ch.right_vol = 0;
      ch.left_vol = 0;
      ch.updateVol();
    }

    // Dynamic channels
    while (this._channels.length > 0) {
      const ch = this._channels.shift();
      ch.stop();
    }

    // Static channels
    while (this._staticChannels.length > 0) {
      const ch = this._staticChannels.shift();
      ch.stop();
    }
  },

  StaticSound(sfx, origin, vol, attenuation) {
    if (this._nosound.value !== 0 || !sfx) {
      return;
    }

    const ss = this._NewChannel().withSfx(sfx);
    ss.origin = origin.copy();
    ss.master_vol = vol;
    ss.dist_mult = attenuation * 0.000015625;

    this._staticChannels.push(ss);

    const onDataAvailable = (sc) => {
      if (sc.loopstart === null) {
        Con.Print(`S.StaticSound: Sound ${sfx.name} not looped\n`);
        return;
      }

      ss.loadData();
      ss.end = Host.realtime + sc.length;

      ss.spatialize();
      ss.start();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === SFX.STATE.LOADING || sfx.state === SFX.STATE.NEW) {
      sfx.queueAvailableHandler((sfx) => onDataAvailable(sfx.cache));
      return;
    }
  },

  //
  // --- Console Commands
  //

  SoundList_f() {
    let total = 0;
    for (let i = 0; i < this._knownSfx.length; i++) {
      const sfx = this._knownSfx[i];
      let sizeStr = '';
      const flags = [];

      switch (sfx.state) {
        case SFX.STATE.AVAILABLE: {
          const sc = sfx.cache;
          sizeStr = sc.size.toString();
          total += sc.size;
          if (sc.loopstart !== null) {
            flags.push('L');
          }
        }
          break;
        case SFX.STATE.FAILED:
          sizeStr = 'FAILED';
          break;
        case SFX.STATE.LOADING:
          sizeStr = 'LOADING';
          break;
        case SFX.STATE.NEW:
          sizeStr = 'NEW';
          break;
        default:
          sizeStr = `(${sfx.state})`;
      }

      sizeStr = `${flags.join('').padEnd(3, ' ')} ${sizeStr.padEnd(8, ' ')}`;

      Con.Print(`${sizeStr} : ${sfx.name}\n`);
    }
    Con.Print(`Total resident: ${total}\n`);
  },

  Play_f(...samples) {
    if (this._nosound.value !== 0) {
      return;
    }
    // e.g. "play misc/hit1 misc/hit2"
    for (const sample of samples) {
      const sfxName = COM.DefaultExtension(sample, '.wav');
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this._listenerOrigin, 1.0, 1.0);
      }
    }
  },

  PlayVol_f(...args) {
    if (this._nosound.value !== 0) {
      return;
    }
    // e.g. "playvol misc/hit1 0.5 misc/hit2 0.2"
    for (let i = 0; i < args.length; i += 2) {
      const sfxName = COM.DefaultExtension(args[i], '.wav');
      const volume = Q.atof(args[i + 1] || 0);
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this._listenerOrigin, volume, 1.0);
      }
    }
  },

  //
  // --- Per-frame updates
  //

  UpdateAmbientSounds() {
    if (!CL.state.worldmodel) {
      for (const ch of this._ambientChannels) {
        ch.right_vol = 0;
        ch.left_vol = 0;
        ch.updateVol();
      }

      // no map yet
      return;
    }

    const l = Mod.PointInLeaf(this._listenerOrigin, CL.state.worldmodel);
    if (!l || this._ambientLevel.value === 0) {
      // turn off all ambients

      for (const ch of this._ambientChannels) {
        ch.right_vol = 0;
        ch.left_vol = 0;
        ch.updateVol();
      }
      return;
    }

    // ramp up/down volumes
    for (let i = 0; i < this._ambientChannels.length; i++) {
      const ch = this._ambientChannels[i];
      let vol = this._ambientLevel.value * l.ambient_level[i];
      if (vol < 8.0) {
        vol = 0.0;
      }
      vol /= 255.0;

      // fade
      if (ch.master_vol < vol) {
        ch.master_vol += (Host.frametime * this._ambientFade.value) / 255.0;
        if (ch.master_vol > vol) {
          ch.master_vol = vol;
        }
      } else if (ch.master_vol > vol) {
        ch.master_vol -= (Host.frametime * this._ambientFade.value) / 255.0;
        if (ch.master_vol < vol) {
          ch.master_vol = vol;
        }
      }

      if (ch.master_vol > 1.0) {
        ch.master_vol = 1.0;
      }

      ch.right_vol = ch.master_vol;
      ch.left_vol = ch.master_vol;

      ch.updateVol();
    }
  },

  UpdateDynamicSounds() {
    for (let i = 0; i < this._channels.length; i++) {
      const ch = this._channels[i];

      if (!ch || !ch.sfx) {
        continue;
      }

      if (Host.realtime >= ch.end) {
        const sc = ch.sfx.cache;
        // If it's looped, try to wrap around
        if (sc.loopstart !== null) {
          ch.updateLoop();
        } else {
          // no longer needed, release channel
          ch.reset();
          continue;
        }
      }

      // Re-Spatialize
      ch.spatialize();
    }
  },

  UpdateStaticSounds() {
    // Spatialize all static channels
    for (const ch of this._staticChannels) {
      ch.spatialize();

      // Only load sound files when really needed
      if (ch.sfx.state === SFX.STATE.NEW && (ch.left_vol > 0 || ch.right_vol > 0)) {
        ch.sfx.load().catch((err) => {
          Con.Print(`S.UpdateStaticSounds: failed to lazy load ${ch.sfx.name}, ${err.message}\n`);
        });
      }
    }

    // Combine channels that share the same sfx
    for (let i = 0; i < this._staticChannels.length; i++) {
      const ch = this._staticChannels[i];
      if (ch.left_vol <= 0.0 && ch.right_vol <= 0.0) {
        continue;
      }
      for (let j = i + 1; j < this._staticChannels.length; j++) {
        const ch2 = this._staticChannels[j];
        if (ch.sfx === ch2.sfx) {
          ch.left_vol += ch2.left_vol;
          ch.right_vol += ch2.right_vol;
          ch2.left_vol = 0.0;
          ch2.right_vol = 0.0;
        }
      }
    }
  },

  Update(origin, forward, right, up) {
    if (this._nosound.value !== 0) {
      return;
    }

    // Copy listener info
    this._listenerOrigin[0] = origin[0];
    this._listenerOrigin[1] = origin[1];
    this._listenerOrigin[2] = origin[2];

    this._listenerForward[0] = forward[0];
    this._listenerForward[1] = forward[1];
    this._listenerForward[2] = forward[2];

    this._listenerRight[0] = right[0];
    this._listenerRight[1] = right[1];
    this._listenerRight[2] = right[2];

    this._listenerUp[0] = up[0];
    this._listenerUp[1] = up[1];
    this._listenerUp[2] = up[2];

    // Bound volume [0..1]
    if (this.volume.value < 0.0) {
      Cvar.SetValue('volume', 0.0);
    } else if (this.volume.value > 1.0) {
      Cvar.SetValue('volume', 1.0);
    }

    this.UpdateAmbientSounds();
    this.UpdateDynamicSounds();
    this.UpdateStaticSounds();
  },

  LocalSound(sound) {
    // Plays a sound at the view entity, entchannel = -1
    this.StartSound(CL.state.viewentity, -1, sound, Vector.origin, 1.0, 1.0);
  },
};

export default S;
