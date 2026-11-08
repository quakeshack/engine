
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import Q from '../../shared/Q.ts';
import { eventBus } from '../common/EventBus.ts';
import Con from '../common/Console.ts';
import { clientRuntimeState } from './ClientState.ts';
import FrameProfiler from './FrameProfiler.ts';
import clientCvars from './ClientCvars.ts';
import Host from '../common/Host.ts';
import { com } from './PageServices.ts';

const MAX_DYNAMIC_CHANNELS = 64;

type SFXCache = {
  data: AudioBuffer;
  length: number;
  size: number;
  loopstart: number | null;
};

export enum SfxState {
  NEW = 'new',
  LOADING = 'loading',
  AVAILABLE = 'available',
  FAILED = 'failed',
}

// ─── SFX ────────────────────────────────────────────────────────────────────────

export class SFX {
  static readonly STATE = SfxState;

  name: string;
  cache: SFXCache | null = null;
  state: SfxState = SfxState.NEW;

  _readyPromise: Promise<SFX> | null = null;
  _readyResolve: ((sfx: SFX) => void) | null = null;
  _readyReject: ((err: Error) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** @returns resolves when the SFX data is loaded */
  get ready(): Promise<SFX> {
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

  /** @returns whether loading succeeded */
  async load(): Promise<boolean> {
    if (this.state !== SFX.STATE.NEW) {
      return false;
    }

    return Sound.LoadSound(this);
  }

  play(): void {
    Sound.LocalSound(this);
  }
}

// ─── Channel ────────────────────────────────────────────────────────────────────

class Channel {
  sfx: SFX | null = null;
  origin = new Vector();
  dist_mult = 0;
  entnum: number | null = null;
  entchannel: number | null = null;
  end = 0;
  master_vol = 0;
  channel_vol = 0;
  pan = 0;

  _context: AudioContext;
  _panner: StereoPannerNode;
  _gain: GainNode;
  _source: AudioBufferSourceNode | null = null;

  /** The pan last written to the panner, so an unchanged one is not written again. */
  #writtenPan = NaN;

  /** The gain last written to the gain node, so an unchanged one is not written again. */
  #writtenGain = NaN;

  /** Set by {@link Channel.dispose}: the nodes are out of the graph and the channel plays nothing any more. */
  #disposed = false;

  constructor(context: AudioContext, destination: AudioNode) {
    this._context = context;
    this._panner = context.createStereoPanner();
    this._gain = context.createGain();
    this._panner.connect(this._gain);
    this._gain.connect(destination);
  }

  reset(): void {
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

  /**
   * Starts playback of the current sfx from the beginning. Does nothing on a disposed channel: a sound that finishes
   * loading after its channel was let go of (a static sound of the map before) would otherwise start a looping
   * source that no list holds any more, so nothing would ever stop it.
   * @param loop Whether it loops; a sound without a loop marker loops from its start.
   */
  play(loop = this.sfx?.cache?.loopstart !== null): void {
    if (this.#disposed || !this.sfx?.cache) {
      return;
    }

    this.stop();

    const sc = this.sfx.cache;
    const source = this._context.createBufferSource();
    source.buffer = sc.data;

    if (loop) {
      source.loop = true;
      source.loopStart = sc.loopstart ?? 0;
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

  stop(): void {
    if (!this._source) {
      return;
    }

    const source = this._source;
    this._source = null;
    source.onended = null;

    try {
      source.stop(0);
    } catch {
      /* already stopped */
    }

    source.disconnect();
  }

  /**
   * Writes the pan and the volume to the audio graph, when they changed and the context runs. A suspended context
   * (the game is paused, or the browser has not let it start) consumes no automation events, so in Chrome every
   * `value` write adds one that stays, and each write after it takes longer: 0.6 ms a write after a while, half a
   * frame for a map's static sounds. Nothing is heard while it is suspended; the next update after it resumes writes
   * what changed in the meantime.
   */
  updateVol(): void {
    if (this._context.state !== 'running') {
      return;
    }

    const pan = Math.max(-1, Math.min(1, this.pan));
    const gain = Math.max(0, this.channel_vol * Sound.volume.value);

    FrameProfiler.begin('audio params');

    if (pan !== this.#writtenPan) {
      this._panner.pan.value = pan;
      this.#writtenPan = pan;
    }

    if (gain !== this.#writtenGain) {
      this._gain.gain.value = gain;
      this.#writtenGain = gain;
    }

    FrameProfiler.end();
  }

  /**
   * Computes pan and channel_vol based on the listener position/orientation.
   */
  spatialize(): void {
    // Local sound: full volume, center pan
    if (this.entnum === clientRuntimeState.viewentity) {
      this.pan = 0;
      this.channel_vol = this.master_vol;
      this.updateVol();
      return;
    }

    // Area portal occlusion
    if (clientCvars.areaportals.value > 0 && clientRuntimeState.worldmodel && Sound._listenerLeaf !== null) {
      const leaf = clientRuntimeState.worldmodel.getLeafIndexForPoint(this.origin);
      if (!clientRuntimeState.worldmodel.leafsConnected(Sound._listenerLeaf, leaf)) {
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

  /** Stops the channel and takes its nodes out of the graph, for good. */
  dispose(): void {
    this.#disposed = true;
    this.stop();
    this._panner.disconnect();
    this._gain.disconnect();
  }
}

// ─── Sound ──────────────────────────────────────────────────────────────────────

export default class Sound {
  static _channels: Channel[] = [];
  static _staticChannels: Channel[] = [];
  static _ambientChannels: Channel[] = [];
  static _knownSfx: SFX[] = [];

  // Listener state
  static _listenerOrigin = new Vector();
  static _listenerRight = new Vector();
  static _listenerLeaf: number | null = null;

  static _started = false;
  static _context: AudioContext | null = null;
  static _masterGain: GainNode | null = null;
  static _underwaterFilter: BiquadFilterNode | null = null;

  // Cvars
  static _precache: Cvar = null!;
  static _nosound: Cvar = null!;
  static _ambientLevel: Cvar = null!;
  static _ambientFade: Cvar = null!;
  static volume: Cvar = null!;
  static bgmvolume: Cvar = null!;

  static _eventListeners: Array<() => void> = [];

  /** Counts {@link Sound.StopAllSounds}, so a sound that was asked for before it and loads after it is not started. */
  static #generation = 0;

  // ─── Init / Shutdown ────────────────────────────────────────────────────────

  static Init(): void {
    Cmd.AddCommand('play', Sound.Play_f.bind(Sound));
    Cmd.AddCommand('playvol', Sound.PlayVol_f.bind(Sound));
    Cmd.AddCommand('stopsound', Sound.StopAllSounds.bind(Sound));
    Cmd.AddCommand('soundlist', Sound.SoundList_f.bind(Sound));

    Sound._nosound = new Cvar('nosound', com.CheckParm('-nosound') ? '1' : '0', Cvar.FLAG.READONLY);
    Sound.volume = new Cvar('volume', '0.7', Cvar.FLAG.ARCHIVE);
    Sound._precache = new Cvar('s_precache', '1', Cvar.FLAG.NONE, '0 = only load sounds when played, 1 = load all sounds at level start');
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
      const message = err instanceof Error ? err.message : String(err);
      Con.PrintWarning(`S.Init: AudioContext failed (${message}). Sound disabled.\n`);
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
        if (sfx.cache?.loopstart === null) {
          Con.Print(`S.Init: Sound ${name} not looped\n`);
        }
        ch.play();
      }).catch(() => {});
    }

    Sound._eventListeners.push(
      eventBus.subscribe('client.paused', () => void Sound._context?.suspend()),
      eventBus.subscribe('client.unpaused', () => void Sound._context?.resume()),
    );

    Con.DPrint('Sound subsystem initialized.\n');
  }

  static Shutdown(): void {
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
   * @param name sound filename
   * @returns the SFX handle or null if sound is disabled
   */
  static PrecacheSound(name: string): SFX | null {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return null;
    }

    let sfx = Sound._knownSfx.find((soundEffect) => soundEffect.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      Sound._knownSfx.push(sfx);
    }

    if (Sound._precache.value !== 0 && sfx.state === SFX.STATE.NEW) {
      void Sound.LoadSound(sfx).catch(() => {});
    }

    return sfx;
  }

  /**
   * @param name sound filename
   * @returns the SFX handle or null if sound is disabled
   */
  static async PrecacheSoundAsync(name: string): Promise<SFX | null> {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return null;
    }

    let sfx = Sound._knownSfx.find((soundEffect) => soundEffect.name === name);
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
   * @param sfx sound effect to load
   * @returns whether loading succeeded
   */
  static async LoadSound(sfx: SFX): Promise<boolean> {
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

    const context = Sound._context;
    if (context === null) {
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    sfx.state = SFX.STATE.LOADING;

    const data = await com.LoadFile(`sound/${sfx.name}`);
    if (!data || !Sound._started) {
      // eslint-disable-next-line require-atomic-updates
      sfx.state = SFX.STATE.FAILED;
      sfx._readyReject?.(new Error(`Failed to load ${sfx.name}`));
      sfx._readyResolve = null;
      sfx._readyReject = null;
      return false;
    }

    const loopInfo = Sound._parseWavLoopInfo(data);

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Con.PrintError(`S.LoadSound: decodeAudioData failed for ${sfx.name}: ${message}\n`);
      sfx.state = SFX.STATE.FAILED;
      sfx._readyReject?.(new Error(message));
      sfx._readyResolve = null;
      sfx._readyReject = null;
      return false;
    }

    let loopstart: number | null = null;
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
  static LoadPendingFiles(): void {
    const pending = Sound._knownSfx.filter((sfx) => sfx.state === SFX.STATE.NEW);
    if (pending.length === 0) {
      return;
    }

    Promise.all(pending.slice(0, 4).map((sfx) => sfx.load())).then(() => {
      Sound.LoadPendingFiles();
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      Con.PrintError(`S.LoadPendingFiles: ${message}\n`);
    });
  }

  // ─── Playback ───────────────────────────────────────────────────────────────

  /**
   * @param entnum entity number
   * @param entchannel channel on entity (0 = any, -1 = local)
   * @param sfx sound to play
   * @param origin world position
   * @param vol master volume [0..1]
   * @param attenuation distance falloff factor
   */
  static StartSound(entnum: number, entchannel: number, sfx: SFX | null, origin: Vector, vol: number, attenuation: number): void {
    if (!Sound._started || Sound._nosound.value !== 0 || !sfx) {
      return;
    }

    Sound._ensureContextRunning();

    // a copy, the caller may change the vector before the sound has loaded
    const at = origin.copy();
    const generation = Sound.#generation;

    const play = () => {
      // asked for before the sounds were stopped (the map changed), loaded after
      if (generation !== Sound.#generation) {
        return;
      }

      const ch = Sound._pickChannel(entnum, entchannel);
      ch.sfx = sfx;
      ch.origin.set(at);
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
      void Sound.LoadSound(sfx).catch(() => {});
    }

    if (sfx.state !== SFX.STATE.FAILED) {
      sfx.ready.then(() => { play(); }).catch(() => {});
    }
  }

  /**
   * @param sfx looping sound
   * @param origin world position
   * @param vol master volume [0..1]
   * @param attenuation distance falloff factor
   */
  static StaticSound(sfx: SFX | null, origin: Vector, vol: number, attenuation: number): void {
    if (!Sound._started || Sound._nosound.value !== 0 || !sfx) {
      return;
    }

    const ch = Sound._newChannel();
    ch.sfx = sfx;
    ch.origin.set(origin);
    ch.master_vol = vol;
    ch.dist_mult = attenuation * 0.000015625;
    Sound._staticChannels.push(ch);

    const start = () => {
      if (!sfx.cache) {
        return;
      }

      // looped by this channel only: the data is shared with every other play of the sound, which would loop too
      if (sfx.cache.loopstart === null) {
        Con.PrintWarning(`S.StaticSound: ${sfx.name} not looped, assuming start 0\n`);
      }
      ch.end = Host.realtime + sfx.cache.length;
      ch.spatialize();
      ch.play(true);
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      start();
    } else if (sfx.state !== SFX.STATE.FAILED) {
      sfx.ready.then(() => { start(); }).catch(() => {});
    }
  }

  /**
   * @param entnum entity number
   * @param entchannel channel on entity
   */
  static StopSound(entnum: number, entchannel: number): void {
    if (!Sound._started) {
      return;
    }

    const ch = Sound._channels.find((channel) => channel.entnum === entnum && channel.entchannel === entchannel);
    if (ch) {
      ch.stop();
      ch.reset();
    }
  }

  /** Stops every sound and lets go of the static ones, on a map change, a disconnect and `stopsound`. */
  static StopAllSounds(): void {
    if (!Sound._started) {
      return;
    }

    Sound.#generation++;

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
   * @param sfx sound to play
   */
  static LocalSound(sfx: SFX | null): void {
    Sound.StartSound(clientRuntimeState.viewentity, -1, sfx, Vector.origin, 1.0, 1.0);
  }

  // ─── Console commands ───────────────────────────────────────────────────────

  /** @param samples sound names to play */
  static Play_f(...samples: string[]): void {
    if (!Sound._started) {
      return;
    }

    for (const sample of samples) {
      const sfx = Sound.PrecacheSound(com.DefaultExtension(sample, '.wav'));
      if (sfx) {
        Sound.StartSound(clientRuntimeState.viewentity, 0, sfx, Sound._listenerOrigin, 1.0, 1.0);
      }
    }
  }

  /** @param args name/volume pairs */
  static PlayVol_f(...args: string[]): void {
    if (!Sound._started) {
      return;
    }

    for (let i = 0; i < args.length; i += 2) {
      const sfx = Sound.PrecacheSound(com.DefaultExtension(args[i], '.wav'));
      if (sfx) {
        Sound.StartSound(clientRuntimeState.viewentity, 0, sfx, Sound._listenerOrigin, Q.atof(args[i + 1] || '0'), 1.0);
      }
    }
  }

  static SoundList_f(): void {
    let total = 0;
    for (const sfx of Sound._knownSfx) {
      let info: string;
      if (sfx.state === SFX.STATE.AVAILABLE && sfx.cache) {
        const loop = sfx.cache.loopstart !== null ? 'L ' : '  ';
        info = `${loop} ${String(sfx.cache.size).padEnd(8)}`;
        total += sfx.cache.size;
      } else {
        info = `   ${sfx.state.toUpperCase().padEnd(8)}`;
      }
      Con.Print(`${info} : ${sfx.name}\n`);
    }

    const playing = Sound._channels.filter((channel) => channel._source !== null).length;
    Con.Print(`Total resident: ${total}\n`);
    Con.Print(`Active channels: ${playing}/${Sound._channels.length}\n`);
  }

  // ─── Per-frame update ───────────────────────────────────────────────────────

  /**
   * @param origin listener position
   * @param _forward unused (kept for API compat)
   * @param right listener right vector
   * @param _up unused (kept for API compat)
   * @param underwater whether the listener is submerged
   */
  static Update(origin: Vector, _forward: Vector, right: Vector, _up: Vector, underwater: boolean): void {
    if (!Sound._started || Sound._nosound.value !== 0) {
      return;
    }

    Sound._listenerOrigin[0] = origin[0];
    Sound._listenerOrigin[1] = origin[1];
    Sound._listenerOrigin[2] = origin[2];

    Sound._listenerRight[0] = right[0];
    Sound._listenerRight[1] = right[1];
    Sound._listenerRight[2] = right[2];

    Sound._listenerLeaf = clientRuntimeState.worldmodel
      ? clientRuntimeState.worldmodel.getLeafIndexForPoint(origin)
      : null;

    if (Sound.volume.value < 0) {
      Cvar.Set('volume', 0);
    } else if (Sound.volume.value > 1) {
      Cvar.Set('volume', 1);
    }

    // Underwater muffling via single lowpass toggle, written only when it changes, see Channel.updateVol
    const frequency = underwater ? 800 : 11025;

    if (Sound._underwaterFilter !== null && Sound._underwaterFilter.context.state === 'running' && Sound._underwaterFilter.frequency.value !== frequency) {
      Sound._underwaterFilter.frequency.value = frequency;
    }

    FrameProfiler.begin('ambient');
    Sound._updateAmbientSounds();
    FrameProfiler.end();

    FrameProfiler.begin('dynamic');
    Sound._updateDynamicSounds();
    FrameProfiler.end();

    FrameProfiler.begin('static');
    Sound._updateStaticSounds();
    FrameProfiler.end();
  }

  /**
   * Checks whether a world position could possibly be heard from the current listener position,
   * using the worldmodel's PHS. Entity-attached sounds are already PHS-filtered server-side
   * (see ServerMessages.startSound), but some events (e.g. temp entities) are broadcast to every
   * client unconditionally and only rely on distance attenuation and area-portal occlusion in
   * Channel.spatialize — neither of which accounts for a source sitting in a wholly disconnected
   * part of the map. Defaults to audible when PHS data isn't available, matching Visibility's own
   * fallback for maps without compiled vis data.
   *
   * Uses the "fat point" PHS (`getFatPhsByPoint`) rather than a single strict leaf lookup: a
   * source position sitting on or just inside solid content — e.g. an explosion's impact point
   * against a wall or floor, which is the common case, not the exception — would otherwise
   * resolve to the meaningless solid/outside leaf and read as unconditionally inaudible.
   * @param origin World-space position of the sound source.
   * @returns True when the position is potentially audible, or PHS data is unavailable.
   */
  static IsPositionAudible(origin: Vector): boolean {
    const worldmodel = clientRuntimeState.worldmodel;

    if (!worldmodel || Sound._listenerLeaf === null || worldmodel.phsdata === null) {
      return true;
    }

    return worldmodel.getFatPhsByPoint(origin).isRevealed(Sound._listenerLeaf);
  }

  /** @protected */
  static _updateAmbientSounds(): void {
    if (!clientRuntimeState.worldmodel || Sound._listenerLeaf === null || Sound._ambientLevel.value === 0) {
      for (const ch of Sound._ambientChannels) {
        ch.channel_vol = 0;
        ch.updateVol();
      }
      return;
    }

    for (let i = 0; i < Sound._ambientChannels.length; i++) {
      const ch = Sound._ambientChannels[i];
      let vol = (Sound._ambientLevel.value * clientRuntimeState.worldmodel.leafTable.ambient[Sound._listenerLeaf * 4 + i]) / 255;
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
  static _updateDynamicSounds(): void {
    for (const ch of Sound._channels) {
      if (!ch.sfx) {
        continue;
      }

      // a looping sound plays until it is stopped or its channel is taken, anything else is over at its end, a sound
      // without data included: it plays nothing and would hold the channel for good
      const looping = ch.sfx.cache !== null && ch.sfx.cache.loopstart !== null;

      if (Host.realtime >= ch.end && !looping) {
        ch.reset();
        continue;
      }

      ch.spatialize();
    }
  }

  /** @protected */
  static _updateStaticSounds(): void {
    for (const ch of Sound._staticChannels) {
      ch.spatialize();
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** @returns a new audio channel wired to the master bus */
  static _newChannel(): Channel {
    const context = Sound._context;
    const masterGain = Sound._masterGain;

    if (context === null || masterGain === null) {
      throw new Error('Sound graph is not initialized');
    }

    return new Channel(context, masterGain);
  }

  static _ensureContextRunning(): void {
    if (Sound._context?.state === 'suspended') {
      Sound._context.resume().catch(() => {});
    }
  }

  /**
   * @param entnum entity number
   * @param entchannel channel on entity
   * @returns allocated or reused channel
   */
  static _pickChannel(entnum: number, entchannel: number): Channel {
    // Reuse existing channel for same entity+channel
    if (entchannel !== 0) {
      const existing = Sound._channels.find((channel) => channel.entnum === entnum && channel.entchannel === entchannel);
      if (existing) {
        existing.reset();
        return existing;
      }
    }

    // Find a free channel
    const free = Sound._channels.find((channel) => !channel.sfx);
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
    let victim: Channel | null = null;
    let lowestVol = Infinity;
    for (const ch of Sound._channels) {
      if (ch.entnum === clientRuntimeState.viewentity) {
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
   * @param data raw WAV file data
   * @returns parsed loop info
   */
  static _parseWavLoopInfo(data: ArrayBuffer): { loopstartSamples: number | null; sampleRate: number | null } {
    const view = new DataView(data);

    if (data.byteLength < 12
      || view.getUint32(0, true) !== 0x46464952
      || view.getUint32(8, true) !== 0x45564157) {
      return { loopstartSamples: null, sampleRate: null };
    }

    let pos = 12;
    let sampleRate: number | null = null;
    let cueLoopStart: number | null = null;
    let smplLoopStart: number | null = null;

    while (pos + 8 <= data.byteLength) {
      const id = view.getUint32(pos, true);
      const size = Math.min(view.getUint32(pos + 4, true), data.byteLength - pos - 8);
      const at = pos + 8;

      if (id === 0x20746d66 && size >= 8) {
        sampleRate = view.getUint32(at + 4, true);
      } else if (id === 0x20657563 && size >= 28) {
        const n = view.getUint32(at, true);
        if (n > 0 && size >= 4 + n * 24) {
          cueLoopStart = view.getUint32(at + 4 + (n - 1) * 24 + 20, true);
        }
      } else if (id === 0x6c706d73 && size >= 60) {
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
