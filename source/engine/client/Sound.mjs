import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import Q from '../../shared/Q.ts';
import { eventBus, registry } from '../registry.mjs';

/** @typedef {import('../common/model/BSP.ts').Node} BSPNode */

let { CL, COM, Con, Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Host } = registry);
});

const MAX_DYNAMIC_CHANNELS = 64;

/** @typedef {{data: AudioBuffer, length: number, size: number, loopstart: ?number}} SFXCache */

// ─── SFX ────────────────────────────────────────────────────────────────────────

export class SFX {
  static STATE = {
    NEW: 'new',
    LOADING: 'loading',
    AVAILABLE: 'available',
    FAILED: 'failed',
  };

  /** @param {string} name sfx filename */
  constructor(name) {
    /** @type {string} */
    this.name = name;
    /** @type {SFXCache|null} */
    this.cache = null;
    /** @type {string} */
    this.state = SFX.STATE.NEW;

    /** @type {Promise<SFX>|null} */
    this._readyPromise = null;
    /** @type {((sfx: SFX) => void)|null} */
    this._readyResolve = null;
    /** @type {((err: Error) => void)|null} */
    this._readyReject = null;
  }

  /** @returns {Promise<SFX>} resolves when the SFX data is loaded */
  get ready() {
    if (this._readyPromise === null) {
      if (this.state === SFX.STATE.AVAILABLE) {
        this._readyPromise = Promise.resolve(this);
      } else if (this.state === SFX.STATE.FAILED) {
        this._readyPromise = Promise.reject(new Error(`SFX failed: ${this.name}`));
      } else {
        this._readyPromise = new Promise((resolve, reject) => {
          this._readyResolve = resolve;
          this._readyReject = reject;
        });
      }
    }
    return this._readyPromise;
  }

  /** @returns {Promise<boolean>} whether loading succeeded */
  async load() {
    if (this.state !== SFX.STATE.NEW) {
      return false;
    }
    return await Sound.LoadSound(this);
  }

  play() {
    Sound.LocalSound(this);
  }
}

// ─── Channel ────────────────────────────────────────────────────────────────────

class Channel {
  /**
   * @param {AudioContext} context Web Audio context
   * @param {AudioNode} destination master gain bus
   */
  constructor(context, destination) {
    /** @type {SFX|null} */
    this.sfx = null;
    /** @type {Vector} */
    this.origin = new Vector();
    /** @type {number} */
    this.dist_mult = 0;
    /** @type {number|null} */
    this.entnum = null;
    /** @type {number|null} */
    this.entchannel = null;
    /** @type {number} */
    this.end = 0;
    /** @type {number} */
    this.master_vol = 0;
    /** @type {number} */
    this.channel_vol = 0;
    /** @type {number} */
    this.pan = 0;

    /** @type {AudioContext} */
    this._context = context;
    /** @type {StereoPannerNode} */
    this._panner = context.createStereoPanner();
    /** @type {GainNode} */
    this._gain = context.createGain();
    this._panner.connect(this._gain);
    this._gain.connect(destination);

    /** @type {AudioBufferSourceNode|null} */
    this._source = null;
  }

  reset() {
    this.stop();
    this.sfx = null;
    this.origin[0] = 0;
    this.origin[1] = 0;
    this.origin[2] = 0;
    this.dist_mult = 0;
    this.entnum = null;
    this.entchannel = null;
    this.end = 0;
    this.master_vol = 0;
    this.channel_vol = 0;
    this.pan = 0;
  }

  /** Starts playback of the current sfx from the beginning. */
  play() {
    if (!this.sfx?.cache) {
      return;
    }

    this.stop();

    const sc = this.sfx.cache;
    const source = this._context.createBufferSource();
    source.buffer = sc.data;

    if (sc.loopstart !== null) {
      source.loop = true;
      source.loopStart = sc.loopstart;
      source.loopEnd = sc.data.duration;
    } else {
      // Auto-cleanup when a non-looping sound ends naturally
      source.onended = () => {
        source.disconnect();
        if (this._source === source) {
          this._source = null;
        }
      };
    }

    source.connect(this._panner);
    source.start(0);
    this._source = source;
    this.updateVol();
  }

  stop() {
    if (!this._source) {
      return;
    }

    const source = this._source;
    this._source = null;
    source.onended = null;

    try {
      source.stop(0);
    } catch { /* already stopped */ }
    source.disconnect();
  }

  updateVol() {
    this._panner.pan.value = Math.max(-1, Math.min(1, this.pan));
    this._gain.gain.value = Math.max(0, this.channel_vol * Sound.volume.value);
  }

  /**
   * Computes pan and channel_vol based on the listener position/orientation.
   */
  spatialize() {
    // Local sound: full volume, center pan
    if (this.entnum === CL.state.viewentity) {
      this.pan = 0;
      this.channel_vol = this.master_vol;
      this.updateVol();
      return;
    }

    // Area portal occlusion
    if (CL.areaportals?.value > 0 && CL.state.worldmodel && Sound._listenerLeaf) {
      const leaf = CL.state.worldmodel.getLeafForPoint(this.origin);
      if (!CL.state.worldmodel.areaPortals.leafsConnected(Sound._listenerLeaf, leaf)) {
        this.channel_vol = 0;
        this.updateVol();
        return;
      }
    }

    // Distance attenuation and stereo panning
    const dx = this.origin[0] - Sound._listenerOrigin[0];
    const dy = this.origin[1] - Sound._listenerOrigin[1];
    const dz = this.origin[2] - Sound._listenerOrigin[2];
    let dist = Math.hypot(dx, dy, dz);

    if (dist > 0) {
      const inv = 1 / dist;
      this.pan = (dx * inv) * Sound._listenerRight[0]
               + (dy * inv) * Sound._listenerRight[1]
               + (dz * inv) * Sound._listenerRight[2];
    } else {
      this.pan = 0;
    }

    dist *= this.dist_mult;
    this.channel_vol = Math.max(0, (1 - dist) * this.master_vol);
    this.updateVol();
  }

  /** Disconnects all persistent audio nodes from the graph. */
  dispose() {
    this.stop();
    this._panner.disconnect();
    this._gain.disconnect();
  }
}

// ─── Sound ──────────────────────────────────────────────────────────────────────

class Sound {
  /** @type {Channel[]} */
  static _channels = [];
  /** @type {Channel[]} */
  static _staticChannels = [];
  /** @type {Channel[]} */
  static _ambientChannels = [];
  /** @type {SFX[]} */
  static _knownSfx = [];

  // Listener state
  static _listenerOrigin = new Vector();
  static _listenerRight = new Vector();
  /** @type {BSPNode|null} */
  static _listenerLeaf = null;

  static _started = false;
  /** @type {AudioContext|null} */
  static _context = null;
  /** @type {GainNode|null} */
  static _masterGain = null;
  /** @type {BiquadFilterNode|null} */
  static _underwaterFilter = null;

  // Cvars
  /** @type {Cvar} */
  static _precache = null;
  /** @type {Cvar} */
  static _nosound = null;
  /** @type {Cvar} */
  static _ambientLevel = null;
  /** @type {Cvar} */
  static _ambientFade = null;
  /** @type {Cvar} */
  static volume = null;
  /** @type {Cvar} */
  static bgmvolume = null;

  /** @type {Array<() => void>} */
  static _eventListeners = [];

  // ─── Init / Shutdown ────────────────────────────────────────────────────────

  static Init() {
    Cmd.AddCommand('play', Sound.Play_f.bind(Sound));
    Cmd.AddCommand('playvol', Sound.PlayVol_f.bind(Sound));
    Cmd.AddCommand('stopsound', Sound.StopAllSounds.bind(Sound));
    Cmd.AddCommand('soundlist', Sound.SoundList_f.bind(Sound));

    Sound._nosound = new Cvar('nosound', COM.CheckParm('-nosound') ? '1' : '0', Cvar.FLAG.READONLY);
    Sound.volume = new Cvar('volume', '0.7', Cvar.FLAG.ARCHIVE);
    Sound._precache = new Cvar('precache', '1');
    Sound.bgmvolume = new Cvar('bgmvolume', '1', Cvar.FLAG.ARCHIVE);
    Sound._ambientLevel = new Cvar('ambient_level', '0.3');
    Sound._ambientFade = new Cvar('ambient_fade', '100');

    try {
      Sound._context = new AudioContext({ sampleRate: 22050 });

      // Audio graph: [channels] → masterGain → underwaterFilter → destination
      Sound._masterGain = Sound._context.createGain();
      Sound._underwaterFilter = Sound._context.createBiquadFilter();
      Sound._underwaterFilter.type = 'lowpass';
      Sound._underwaterFilter.frequency.value = 11025;
      Sound._underwaterFilter.Q.value = 0.7;
      Sound._masterGain.connect(Sound._underwaterFilter);
      Sound._underwaterFilter.connect(Sound._context.destination);

      Sound._started = true;
    } catch (err) {
      Con.PrintWarning(`S.Init: AudioContext failed (${err.message}). Sound disabled.\n`);
      return;
    }

    // Ambient channels
    for (const name of ['ambience/water1.wav', 'ambience/wind2.wav']) {
      const sfx = Sound.PrecacheSound(name);
      if (!sfx) {
        continue;
      }

      const ch = Sound._newChannel();
      ch.sfx = sfx;
      Sound._ambientChannels.push(ch);

      sfx.ready.then(() => {
        if (sfx.cache.loopstart === null) {
          Con.Print(`S.Init: Sound ${name} not looped\n`);
        }
        ch.play();
      }).catch(() => {});
    }

    Sound._eventListeners.push(
      eventBus.subscribe('client.paused', () => Sound._context?.suspend()),
      eventBus.subscribe('client.unpaused', () => Sound._context?.resume()),
    );

    Con.DPrint('Sound subsystem initialized.\n');
  }

  static Shutdown() {
    for (const unsub of Sound._eventListeners) {
      unsub();
    }
    Sound._eventListeners.length = 0;

    Sound.StopAllSounds();
    Sound._started = false;
    Sound._knownSfx.length = 0;

    for (const ch of Sound._channels) {
      ch.dispose();
    }
    Sound._channels.length = 0;

    for (const ch of Sound._ambientChannels) {
      ch.dispose();
    }
    Sound._ambientChannels.length = 0;

    if (Sound._context) {
      Sound._context.close().catch(() => {});
      Sound._context = null;
    }
    Sound._masterGain = null;
    Sound._underwaterFilter = null;

    Con.Print('S.Shutdown: sound subsystem shut down.\n');
  }

  // ─── Loading ────────────────────────────────────────────────────────────────

  /**
   * @param {string} name sound filename
   * @returns {SFX|null} the SFX handle or null if sound is disabled
   */
  static PrecacheSound(name) {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return null;
    }

    let sfx = Sound._knownSfx.find((s) => s.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      Sound._knownSfx.push(sfx);
    }

    if (Sound._precache.value !== 0 && sfx.state === SFX.STATE.NEW) {
      Sound.LoadSound(sfx).catch(() => {});
    }

    return sfx;
  }

  /**
   * @param {string} name sound filename
   * @returns {Promise<SFX|null>} the SFX handle or null if sound is disabled
   */
  static async PrecacheSoundAsync(name) {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return null;
    }

    let sfx = Sound._knownSfx.find((s) => s.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      Sound._knownSfx.push(sfx);
    }

    if (sfx.state === SFX.STATE.NEW) {
      await Sound.LoadSound(sfx);
    } else if (sfx.state === SFX.STATE.LOADING) {
      await sfx.ready.catch(() => {});
    }

    return sfx;
  }

  /**
   * Loads sound data from disk and decodes it into an AudioBuffer.
   * @param {SFX} sfx sound effect to load
   * @returns {Promise<boolean>} whether loading succeeded
   */
  static async LoadSound(sfx) {
    if (!Sound._started || Sound._nosound.value !== 0) {
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    if (sfx.state === SFX.STATE.LOADING) {
      return false;
    }

    if (sfx.state !== SFX.STATE.NEW) {
      return sfx.state === SFX.STATE.AVAILABLE;
    }

    sfx.state = SFX.STATE.LOADING;

    const data = await COM.LoadFile(`sound/${sfx.name}`);
    if (!data || !Sound._started) {
      // eslint-disable-next-line require-atomic-updates
      sfx.state = SFX.STATE.FAILED;
      sfx._readyReject?.(new Error(`Failed to load ${sfx.name}`));
      sfx._readyResolve = null;
      sfx._readyReject = null;
      return false;
    }

    const loopInfo = Sound._parseWavLoopInfo(data);

    let audioBuffer;
    try {
      audioBuffer = await Sound._context.decodeAudioData(data);
    } catch (e) {
      Con.PrintError(`S.LoadSound: decodeAudioData failed for ${sfx.name}: ${e.message}\n`);
      sfx.state = SFX.STATE.FAILED;
      sfx._readyReject?.(new Error(e.message));
      sfx._readyResolve = null;
      sfx._readyReject = null;
      return false;
    }

    let loopstart = null;
    if (loopInfo.loopstartSamples !== null) {
      const rate = loopInfo.sampleRate || audioBuffer.sampleRate;
      loopstart = loopInfo.loopstartSamples / rate;
    }

    // eslint-disable-next-line require-atomic-updates
    sfx.cache = { data: audioBuffer, length: audioBuffer.duration, size: data.byteLength, loopstart };
    // eslint-disable-next-line require-atomic-updates
    sfx.state = SFX.STATE.AVAILABLE;
    sfx._readyResolve?.(sfx);
    sfx._readyResolve = null;
    sfx._readyReject = null;

    return true;
  }

  /** Loads up to 4 pending sounds per batch, then recurses. */
  static LoadPendingFiles() {
    const pending = Sound._knownSfx.filter((sfx) => sfx.state === SFX.STATE.NEW);
    if (pending.length === 0) {
      return;
    }

    Promise.all(pending.slice(0, 4).map((sfx) => sfx.load())).then(() => {
      Sound.LoadPendingFiles();
    }).catch((err) => {
      Con.PrintError(`S.LoadPendingFiles: ${err.message || err}\n`);
    });
  }

  // ─── Playback ───────────────────────────────────────────────────────────────

  /**
   * @param {number} entnum entity number
   * @param {number} entchannel channel on entity (0 = any, -1 = local)
   * @param {SFX} sfx sound to play
   * @param {Vector} origin world position
   * @param {number} vol master volume [0..1]
   * @param {number} attenuation distance falloff factor
   */
  static StartSound(entnum, entchannel, sfx, origin, vol, attenuation) {
    if (!Sound._started || Sound._nosound.value !== 0 || !sfx) {
      return;
    }

    Sound._ensureContextRunning();

    // Snapshot origin so the closure is safe if the caller mutates the vector
    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];

    const play = () => {
      const ch = Sound._pickChannel(entnum, entchannel);
      ch.sfx = sfx;
      ch.origin[0] = ox;
      ch.origin[1] = oy;
      ch.origin[2] = oz;
      ch.dist_mult = attenuation * 0.001;
      ch.master_vol = vol;
      ch.entnum = entnum;
      ch.entchannel = entchannel;
      ch.end = Host.realtime + (sfx.cache?.length || 1);
      ch.spatialize();
      ch.play();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      play();
      return;
    }

    if (sfx.state === SFX.STATE.NEW) {
      Sound.LoadSound(sfx).catch(() => {});
    }

    if (sfx.state !== SFX.STATE.FAILED) {
      sfx.ready.then(() => play()).catch(() => {});
    }
  }

  /**
   * @param {SFX} sfx looping sound
   * @param {Vector} origin world position
   * @param {number} vol master volume [0..1]
   * @param {number} attenuation distance falloff factor
   */
  static StaticSound(sfx, origin, vol, attenuation) {
    if (!Sound._started || Sound._nosound.value !== 0 || !sfx) {
      return;
    }

    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];

    const ch = Sound._newChannel();
    ch.sfx = sfx;
    ch.origin[0] = ox;
    ch.origin[1] = oy;
    ch.origin[2] = oz;
    ch.master_vol = vol;
    ch.dist_mult = attenuation * 0.000015625;
    Sound._staticChannels.push(ch);

    const start = () => {
      if (sfx.cache.loopstart === null) {
        Con.PrintWarning(`S.StaticSound: ${sfx.name} not looped, assuming start 0\n`);
        sfx.cache.loopstart = 0;
      }
      ch.end = Host.realtime + sfx.cache.length;
      ch.spatialize();
      ch.play();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      start();
    } else if (sfx.state !== SFX.STATE.FAILED) {
      sfx.ready.then(() => start()).catch(() => {});
    }
  }

  /**
   * @param {number} entnum entity number
   * @param {number} entchannel channel on entity
   */
  static StopSound(entnum, entchannel) {
    if (!Sound._started) {
      return;
    }

    const ch = Sound._channels.find((c) => c.entnum === entnum && c.entchannel === entchannel);
    if (ch) {
      ch.stop();
      ch.reset();
    }
  }

  static StopAllSounds() {
    if (!Sound._started) {
      return;
    }

    for (const ch of Sound._ambientChannels) {
      ch.channel_vol = 0;
      ch.updateVol();
    }

    for (const ch of Sound._channels) {
      ch.stop();
      ch.reset();
    }

    for (const ch of Sound._staticChannels) {
      ch.dispose();
    }
    Sound._staticChannels.length = 0;
  }

  /**
   * Plays a local (non-spatialized) sound at the view entity.
   * @param {SFX} sfx sound to play
   */
  static LocalSound(sfx) {
    Sound.StartSound(CL.state.viewentity, -1, sfx, Vector.origin, 1.0, 1.0);
  }

  // ─── Console commands ───────────────────────────────────────────────────────

  /** @param {...string} samples sound names to play */
  static Play_f(...samples) {
    if (!Sound._started) {
      return;
    }

    for (const sample of samples) {
      const sfx = Sound.PrecacheSound(COM.DefaultExtension(sample, '.wav'));
      if (sfx) {
        Sound.StartSound(CL.state.viewentity, 0, sfx, Sound._listenerOrigin, 1.0, 1.0);
      }
    }
  }

  /** @param {...string} args name/volume pairs */
  static PlayVol_f(...args) {
    if (!Sound._started) {
      return;
    }

    for (let i = 0; i < args.length; i += 2) {
      const sfx = Sound.PrecacheSound(COM.DefaultExtension(args[i], '.wav'));
      if (sfx) {
        Sound.StartSound(CL.state.viewentity, 0, sfx, Sound._listenerOrigin, Q.atof(args[i + 1] || '0'), 1.0);
      }
    }
  }

  static SoundList_f() {
    let total = 0;
    for (const sfx of Sound._knownSfx) {
      let info;
      if (sfx.state === SFX.STATE.AVAILABLE && sfx.cache) {
        const loop = sfx.cache.loopstart !== null ? 'L ' : '  ';
        info = `${loop} ${String(sfx.cache.size).padEnd(8)}`;
        total += sfx.cache.size;
      } else {
        info = `   ${sfx.state.toUpperCase().padEnd(8)}`;
      }
      Con.Print(`${info} : ${sfx.name}\n`);
    }

    const playing = Sound._channels.filter((c) => c._source !== null).length;
    Con.Print(`Total resident: ${total}\n`);
    Con.Print(`Active channels: ${playing}/${Sound._channels.length}\n`);
  }

  // ─── Per-frame update ───────────────────────────────────────────────────────

  /**
   * @param {Vector} origin listener position
   * @param {Vector} _forward unused (kept for API compat)
   * @param {Vector} right listener right vector
   * @param {Vector} _up unused (kept for API compat)
   * @param {boolean} underwater whether the listener is submerged
   */
  static Update(origin, _forward, right, _up, underwater) {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return;
    }

    Sound._listenerOrigin[0] = origin[0];
    Sound._listenerOrigin[1] = origin[1];
    Sound._listenerOrigin[2] = origin[2];

    Sound._listenerRight[0] = right[0];
    Sound._listenerRight[1] = right[1];
    Sound._listenerRight[2] = right[2];

    Sound._listenerLeaf = CL.state.worldmodel
      ? CL.state.worldmodel.getLeafForPoint(origin)
      : null;

    if (Sound.volume.value < 0) {
      Cvar.Set('volume', 0);
    } else if (Sound.volume.value > 1) {
      Cvar.Set('volume', 1);
    }

    // Underwater muffling via single lowpass toggle
    if (Sound._underwaterFilter) {
      Sound._underwaterFilter.frequency.value = underwater ? 800 : 11025;
    }

    Sound._updateAmbientSounds();
    Sound._updateDynamicSounds();
    Sound._updateStaticSounds();
  }

  /** @protected */
  static _updateAmbientSounds() {
    if (!CL.state.worldmodel || !Sound._listenerLeaf || Sound._ambientLevel.value === 0) {
      for (const ch of Sound._ambientChannels) {
        ch.channel_vol = 0;
        ch.updateVol();
      }
      return;
    }

    for (let i = 0; i < Sound._ambientChannels.length; i++) {
      const ch = Sound._ambientChannels[i];
      let vol = (Sound._ambientLevel.value * Sound._listenerLeaf.ambient_level[i]) / 255;
      if (vol < 8 / 255) {
        vol = 0;
      }

      // Fade toward target volume
      const fade = (Host.frametime * Sound._ambientFade.value) / 255;
      if (ch.master_vol < vol) {
        ch.master_vol = Math.min(ch.master_vol + fade, vol);
      } else if (ch.master_vol > vol) {
        ch.master_vol = Math.max(ch.master_vol - fade, vol);
      }

      ch.master_vol = Math.min(1, ch.master_vol);
      ch.channel_vol = ch.master_vol;
      ch.updateVol();
    }
  }

  /** @protected */
  static _updateDynamicSounds() {
    for (const ch of Sound._channels) {
      if (!ch.sfx) {
        continue;
      }

      if (Host.realtime >= ch.end) {
        if (ch.sfx.cache?.loopstart !== null) {
          // Looping sound continues
        } else {
          ch.reset();
          continue;
        }
      }

      ch.spatialize();
    }
  }

  /** @protected */
  static _updateStaticSounds() {
    for (const ch of Sound._staticChannels) {
      ch.spatialize();
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** @returns {Channel} a new audio channel wired to the master bus */
  static _newChannel() {
    return new Channel(Sound._context, Sound._masterGain);
  }

  static _ensureContextRunning() {
    if (Sound._context?.state === 'suspended') {
      Sound._context.resume().catch(() => {});
    }
  }

  /**
   * @param {number} entnum entity number
   * @param {number} entchannel channel on entity
   * @returns {Channel} allocated or reused channel
   */
  static _pickChannel(entnum, entchannel) {
    // Reuse existing channel for same entity+channel
    if (entchannel !== 0) {
      const existing = Sound._channels.find((c) => c.entnum === entnum && c.entchannel === entchannel);
      if (existing) {
        existing.reset();
        return existing;
      }
    }

    // Find a free channel
    const free = Sound._channels.find((c) => !c.sfx);
    if (free) {
      return free;
    }

    // Allocate new channel if under limit
    if (Sound._channels.length < MAX_DYNAMIC_CHANNELS) {
      const ch = Sound._newChannel();
      Sound._channels.push(ch);
      return ch;
    }

    // Voice steal: pick quietest non-local channel
    let victim = null;
    let lowestVol = Infinity;
    for (const ch of Sound._channels) {
      if (ch.entnum === CL.state.viewentity) {
        continue;
      }
      if (ch.channel_vol < lowestVol) {
        lowestVol = ch.channel_vol;
        victim = ch;
      }
    }

    if (!victim) {
      victim = Sound._channels[0];
    }

    victim.reset();
    return victim;
  }

  /**
   * Parses WAV chunk data for loop markers (cue and smpl chunks).
   * @param {ArrayBuffer} data raw WAV file data
   * @returns {{loopstartSamples: number|null, sampleRate: number|null}} parsed loop info
   */
  static _parseWavLoopInfo(data) {
    const view = new DataView(data);

    if (data.byteLength < 12
      || view.getUint32(0, true) !== 0x46464952   // 'RIFF'
      || view.getUint32(8, true) !== 0x45564157) { // 'WAVE'
      return { loopstartSamples: null, sampleRate: null };
    }

    let pos = 12;
    let sampleRate = null;
    let cueLoopStart = null;
    let smplLoopStart = null;

    while (pos + 8 <= data.byteLength) {
      const id = view.getUint32(pos, true);
      const size = Math.min(view.getUint32(pos + 4, true), data.byteLength - pos - 8);
      const at = pos + 8;

      if (id === 0x20746d66 && size >= 8) {          // 'fmt '
        sampleRate = view.getUint32(at + 4, true);
      } else if (id === 0x20657563 && size >= 28) {   // 'cue '
        const n = view.getUint32(at, true);
        if (n > 0 && size >= 4 + n * 24) {
          cueLoopStart = view.getUint32(at + 4 + (n - 1) * 24 + 20, true);
        }
      } else if (id === 0x6c706d73 && size >= 60) {   // 'smpl'
        if (view.getUint32(at + 28, true) >= 1) {
          smplLoopStart = view.getUint32(at + 36 + 8, true);
        }
      }

      pos += size + 8;
      if (pos & 1) {
        pos++;
      }
    }

    return { loopstartSamples: smplLoopStart ?? cueLoopStart, sampleRate };
  }
}

export default Sound;
