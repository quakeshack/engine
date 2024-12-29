S = {
  channels: [],
  staticChannels: [],
  ambientChannels: [],
  knownSfx: [],

  // Listener state
  listenerOrigin: [0.0, 0.0, 0.0],
  listenerForward: [0.0, 0.0, 0.0],
  listenerRight: [0.0, 0.0, 0.0],
  listenerUp: [0.0, 0.0, 0.0],

  started: false,
  context: null,

  // Cvars
  nosound: null,
  volume: null,
  precache: null,
  bgmvolume: null,
  ambientLevel: null,
  ambientFade: null,

  // Constants
  SFX_STATE: {
    NEW: 0,
    LOADING: 1,
    AVAILABLE: 2,
    FAILED: 3,
  },

  SFX: class SFX {
    constructor(name) {
      this.name = name;
      this.cache = null;
      this.state = S.SFX_STATE.NEW;

      this._availableQueue = [];
    }

    queueAvailableHandler(handler) {
      this._availableQueue.push(handler);
      return this;
    }

    makeAvailable() {
      this.state = S.SFX_STATE.AVAILABLE;

      while (this._availableQueue.length > 0) {
        const handler = this._availableQueue.shift();
        handler(this);
      }

      return this;
    }
  },

  //
  // --- Helpers
  //

  /**
   * Safely starts (NoteOn) an AudioBufferSourceNode.
   */
  NoteOn(node) {
    try {
      node.start();
    } catch (e) {
      // Possibly already started
    }
  },

  /**
   * Safely stops (NoteOff) an AudioBufferSourceNode.
   */
  NoteOff(node) {
    try {
      node.stop(0);
    } catch (e) {
      // Possibly already stopped
    }
  },

  /**
   * Helper to attempt playing a fallback HTML audio element,
   * catching any user gesture issues and retrying later.
   */
  TryPlayingChannel(ch) {
    // If we tried playing too recently, wait a bit
    if (Host.realtime - (ch.playFailedTime || 0) < 3) {
      return;
    }

    ch.audio.Play().catch((e) => {
      Con.Print(`S.TryPlayingChannel: failed to Play audio, ${e.message}, retrying later\n`);
      ch.playFailedTime = Host.realtime;
    }).then(() => {
      ch.playFailedTime = null;
    });
  },

  /**
   * Picks or finds an available channel for a new sound to Play on.
   * Possibly kills an older channel from same entnum/entchannel.
   */
  PickChannel(entnum, entchannel) {
    let i;
    let channel = null;

    // If entchannel != 0, see if there is an existing channel with the same
    // entnum and entchannel. If so, kill it.
    if (entchannel !== 0) {
      for (i = 0; i < this.channels.length; ++i) {
        channel = this.channels[i];
        if (!channel) {
          continue;
        }
        const matchingEnt = (channel.entnum === entnum);
        const matchingChan = (channel.entchannel === entchannel) || (entchannel === -1);
        if (matchingEnt && matchingChan) {
          // Kill old
          channel.sfx = null;
          if (channel.nodes) {
            this.NoteOff(channel.nodes.source);
            channel.nodes = null;
          } else if (channel.audio) {
            channel.audio.pause();
            channel.audio = null;
          }
          break;
        }
      }
    }

    // If entchannel == 0 or we never found a free channel, pick a free or new channel.
    if ((entchannel === 0) || (i === this.channels.length)) {
      for (i = 0; i < this.channels.length; ++i) {
        channel = this.channels[i];
        if (!channel || !channel.sfx) {
          break;
        }
      }
    }
    if (i === this.channels.length) {
      // No free channel found, allocate a new one
      this.channels[i] = { end: 0.0 };
    }
    return this.channels[i];
  },

  /**
   * (Re)computes leftvol and rightvol for a channel based on the listener position/orientation.
   */
  Spatialize(ch) {
    // If channel is from the player's own gun, full volume in both ears
    if (ch.entnum === CL.state.viewentity) {
      ch.leftvol = ch.master_vol;
      ch.rightvol = ch.master_vol;
      return;
    }

    // Calculate distance from the listener
    const source = [
      ch.origin[0] - this.listenerOrigin[0],
      ch.origin[1] - this.listenerOrigin[1],
      ch.origin[2] - this.listenerOrigin[2],
    ];
    let dist = Math.sqrt(source[0] * source[0] + source[1] * source[1] + source[2] * source[2]);
    if (dist !== 0.0) {
      source[0] /= dist;
      source[1] /= dist;
      source[2] /= dist;
    }
    dist *= ch.dist_mult;

    // Dot product with the listener's right vector
    const dot = (
      this.listenerRight[0] * source[0] +
      this.listenerRight[1] * source[1] +
      this.listenerRight[2] * source[2]
    );

    const adjustedVolume = (1.0 - dist);
    const left = adjustedVolume * (1.0 - dot);
    const right = adjustedVolume * (1.0 + dot);

    ch.rightvol = ch.master_vol * right;
    ch.leftvol = ch.master_vol * left;

    if (ch.rightvol < 0.0) ch.rightvol = 0.0;
    if (ch.leftvol < 0.0) ch.leftvol = 0.0;
  },

  //
  // --- Initialization
  //

  Init() {
    Con.Print('\nSound Initialization\n');
    Cmd.AddCommand('Play', this.Play.bind(this));
    Cmd.AddCommand('playvol', this.PlayVol.bind(this));
    Cmd.AddCommand('stopsound', this.StopAllSounds.bind(this));
    Cmd.AddCommand('soundlist', this.SoundList_f.bind(this));

    this.nosound = Cvar.RegisterVariable('nosound', COM.CheckParm('-nosound') != null ? '1' : '0');
    this.volume = Cvar.RegisterVariable('volume', '0.7', true);
    this.precache = Cvar.RegisterVariable('precache', '1');
    this.bgmvolume = Cvar.RegisterVariable('bgmvolume', '1', true);
    this.ambientLevel = Cvar.RegisterVariable('ambient_level', '0.3');
    this.ambientFade = Cvar.RegisterVariable('ambient_fade', '100');

    this.started = true;

    // Attempt to create an AudioContext
    try {
      this.context = new AudioContext({ sampleRate: 22050 });
    } catch (e) {
      this.context = null;
    }

    // Initialize ambient channels
    const ambientSfxList = ['water1', 'wind2'];
    for (let i = 0; i < ambientSfxList.length; ++i) {
      const name = `ambience/${ambientSfxList[i]}.wav`;
      const ch = {
        sfx: this.PrecacheSound(name),
        end: 0.0,
        master_vol: 0.0,
      };
      this.ambientChannels[i] = ch;

      // Will get called after the sound data is loaded & decoded
      if (ch.sfx.state !== S.SFX_STATE.NEW) {
        continue;
      }

      this.LoadSound(ch.sfx).then(() => {
        const sc = ch.sfx.cache;
        if (this.context) {
          const nodes = {
            source: this.context.createBufferSource(),
            gain: this.context.createGain(),
          };
          ch.nodes = nodes;
          nodes.source.buffer = sc.data;
          // Attempt to loop
          nodes.source.loop = true;
          nodes.source.loopStart = sc.loopstart || 0;
          nodes.source.loopEnd = sc.length;
          nodes.source.connect(nodes.gain);
          nodes.gain.connect(this.context.destination);
        } else {
          // fallback
          ch.audio = sc.data.cloneNode();
        }

        if (ch.sfx.cache.loopstart == null) {
          Con.Print(`Sound ${name} not looped\n`);
        }
      });
    }

    Con.sfx_talk = this.PrecacheSound('misc/talk.wav');
  },

  //
  // --- Sound data loading
  //

  /**
   * Precache a sound by name. Optionally load it if precache cvar is set.
   */
  PrecacheSound(name) {
    if (this.nosound.value !== 0) {
      return null;
    }
    // Search known list
    let sfx = this.knownSfx.find((k) => k.name === name);
    if (!sfx) {
      sfx = new S.SFX(name);
      this.knownSfx.push(sfx);
    }
    if (this.precache.value !== 0) {
      if (sfx.state === S.SFX_STATE.NEW) {
        this.LoadSound(sfx);
      }
    }
    return sfx;
  },

  /**
   * Actually load sound data from disk (COM.LoadFile) and decode it.
   */
  async LoadSound(sfx) {
    if (this.nosound.value !== 0) {
      sfx.state = S.SFX_STATE.FAILED;
      return false;
    }

    if (sfx.state === S.SFX_STATE.LOADING) {
      throw new Error('LoadSound on isLoading = true');
    }

    if ([S.SFX_STATE.AVAILABLE, S.SFX_STATE.FAILED].includes(sfx.state)) {
      // Already loaded or given up on
      return sfx.cache !== null;
    }

    const sc = {};
    sfx.state = S.SFX_STATE.LOADING;
    const data = await COM.LoadFileAsync(`sound/${sfx.name}`);

    if (!data) {
      Con.Print(`Couldn't load sound/${sfx.name}\n`);
      sfx.state = S.SFX_STATE.FAILED;
      return false;
    }

    // Minimal parsing of a WAV
    let view = new DataView(data);
    // Quick check for 'RIFF' & 'WAVE'
    if (view.getUint32(0, true) !== 0x46464952 || view.getUint32(8, true) !== 0x45564157) {
      Con.Print(`S.LoadSound: Missing RIFF/WAVE chunks on ${sfx.name}\n`);
      sfx.state = S.SFX_STATE.FAILED;
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
            sfx.state = S.SFX_STATE.FAILED;
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
      if (p & 1) p += 1; // pad if needed
    }

    if (!fmt) {
      Con.Print(`S.LoadSound: ${sfx.name} is missing the fmt chunk\n`);
      sfx.state = S.SFX_STATE.FAILED;
      return false;
    }
    if (dataOfs == null) {
      Con.Print(`S.LoadSound: ${sfx.name} is missing the data chunk\n`);
      sfx.state = S.SFX_STATE.FAILED;
      return false;
    }

    // Convert loopstart from "samples" to "seconds" if we have it
    if (loopstart != null) {
      sc.loopstart = loopstart * fmt.blockAlign / fmt.samplesPerSec;
    }

    if (totalSamples != null) {
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

    // Decode via AudioContext or fallback to HTMLAudioElement
    if (this.context) {
      sc.data = null;

      const audioData = await this.context.decodeAudioData(out);

      sc.data = audioData;
      sc.length = audioData.duration;
    } else {
      sc.data = new Audio(`data:audio/wav;base64,${Q.btoa(new Uint8Array(out))}`);
    }

    sfx.cache = sc;
    sfx.makeAvailable();
    return true;
  },

  //
  // --- Playing sounds
  //

  StartSound(entnum, entchannel, sfx, origin, vol, attenuation) {
    if (this.nosound.value !== 0 || !sfx) {
      return;
    }
    // Pick or free a channel
    const targetChan = this.PickChannel(entnum, entchannel);
    targetChan.origin = [...origin];
    targetChan.dist_mult = attenuation * 0.001;
    targetChan.master_vol = vol;
    targetChan.entnum = entnum;
    targetChan.entchannel = entchannel;

    // Spatialize
    this.Spatialize(targetChan);
    if (targetChan.leftvol === 0.0 && targetChan.rightvol === 0.0) {
      return;
    }

    // 1) Create a local callback that sets up the channel once data is loaded
    const onDataAvailable = (sc) => {
      targetChan.sfx = sfx;
      targetChan.pos = 0.0;
      targetChan.end = Host.realtime + sc.length;

      if (this.context) {
        // Web Audio path
        const nodes = {
          source: this.context.createBufferSource(),
          merger1: this.context.createChannelMerger(2),
          splitter: this.context.createChannelSplitter(2),
          gain0: this.context.createGain(),
          gain1: this.context.createGain(),
          merger2: this.context.createChannelMerger(2),
        };
        targetChan.nodes = nodes;

        nodes.source.buffer = sc.data;
        if (sc.loopstart) {
          nodes.source.loop = true;
          nodes.source.loopStart = sc.loopstart;
          nodes.source.loopEnd = sc.length;
        }

        // Duplicate into left & right channels
        nodes.source.connect(nodes.merger1);
        nodes.source.connect(nodes.merger1, 0, 1);
        nodes.merger1.connect(nodes.splitter);
        // Gains
        nodes.splitter.connect(nodes.gain0, 0);
        nodes.splitter.connect(nodes.gain1, 1);

        // Set initial volume
        const leftVol = Math.min(targetChan.leftvol, 1.0) * this.volume.value;
        const rightVol = Math.min(targetChan.rightvol, 1.0) * this.volume.value;
        nodes.gain0.gain.value = leftVol;
        nodes.gain1.gain.value = rightVol;

        // Merge back to stereo
        nodes.gain0.connect(nodes.merger2, 0, 0);
        nodes.gain1.connect(nodes.merger2, 0, 1);
        nodes.merger2.connect(this.context.destination);

        // Start playing
        this.NoteOn(nodes.source);
      } else {
        // Fallback to HTMLAudioElement
        targetChan.audio = sc.data.cloneNode();
        let volume = (targetChan.leftvol + targetChan.rightvol) * 0.5;
        if (volume > 1.0) volume = 1.0;
        targetChan.audio.volume = volume * this.volume.value;
        this.TryPlayingChannel(targetChan);
      }
    };

    if (sfx.state === S.SFX_STATE.AVAILABLE) {
      // 2) If already cached, call onDataAvailable immediately
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === S.SFX_STATE.NEW) {
      // 3) Not cached yet
      this.LoadSound(sfx).then((res) => {
        if (!res) {
          targetChan.sfx = null;
          return;
        }

        // jump back up to playing it
        onDataAvailable(sfx.cache);
      });
      return;
    }
  },

  StopSound(entnum, entchannel) {
    if (this.nosound.value !== 0) {
      return;
    }
    for (let i = 0; i < this.channels.length; ++i) {
      const ch = this.channels[i];
      if (!ch) continue;
      if (ch.entnum === entnum && ch.entchannel === entchannel) {
        ch.end = 0.0;
        ch.sfx = null;
        if (ch.nodes) {
          this.NoteOff(ch.nodes.source);
          ch.nodes = null;
        } else if (ch.audio) {
          ch.audio.pause();
          ch.audio = null;
        }
        return;
      }
    }
  },

  StopAllSounds() {
    if (this.nosound.value !== 0) return;

    // Ambient channels
    for (let i = 0; i < this.ambientChannels.length; i++) {
      const ch = this.ambientChannels[i];
      ch.master_vol = 0.0;
      if (ch.nodes) {
        this.NoteOff(ch.nodes.source);
      } else if (ch.audio) {
        ch.audio.pause();
      }
    }

    // Dynamic channels
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      if (!ch) continue;
      if (ch.nodes) {
        this.NoteOff(ch.nodes.source);
      } else if (ch.audio) {
        ch.audio.pause();
      }
    }
    this.channels = [];

    // Static channels
    if (this.context) {
      for (let i = 0; i < this.staticChannels.length; i++) {
        const sch = this.staticChannels[i];
        if (sch && sch.nodes && sch.nodes.source) {
          this.NoteOff(sch.nodes.source);
        }
      }
    } else {
      for (let i = 0; i < this.staticChannels.length; i++) {
        const sch = this.staticChannels[i];
        if (sch && sch.audio) {
          sch.audio.pause();
        }
      }
    }
    this.staticChannels = [];
  },

  StaticSound(sfx, origin, vol, attenuation) {
    if (this.nosound.value !== 0 || !sfx) {
      return;
    }

    const onDataAvailable = (sc) => {
      if (sc.loopstart == null) {
        Con.Print(`Sound ${sfx.name} not looped\n`);
        return;
      }
      const ss = {
        sfx,
        origin: [...origin],
        master_vol: vol,
        dist_mult: attenuation * 0.000015625,
        end: Host.realtime + sc.length,
        playFailedTime: null,
      };
      this.staticChannels.push(ss);

      if (this.context) {
        const nodes = {
          source: this.context.createBufferSource(),
          merger1: this.context.createChannelMerger(2),
          splitter: this.context.createChannelSplitter(2),
          gain0: this.context.createGain(),
          gain1: this.context.createGain(),
          merger2: this.context.createChannelMerger(2),
        };
        ss.nodes = nodes;

        nodes.source.buffer = sc.data;
        nodes.source.loop = true;
        nodes.source.loopStart = sc.loopstart;
        nodes.source.loopEnd = sc.data.duration;

        // route
        nodes.source.connect(nodes.merger1);
        nodes.source.connect(nodes.merger1, 0, 1);
        nodes.merger1.connect(nodes.splitter);
        nodes.splitter.connect(nodes.gain0, 0);
        nodes.splitter.connect(nodes.gain1, 1);
        nodes.gain0.connect(nodes.merger2, 0, 0);
        nodes.gain1.connect(nodes.merger2, 0, 1);
        nodes.merger2.connect(this.context.destination);

      } else {
        ss.audio = sc.data.cloneNode();
        ss.audio.pause();
      }
    };

    if (sfx.state === S.SFX_STATE.AVAILABLE) {
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === S.SFX_STATE.LOADING) {
      sfx.queueAvailableHandler((sfx) => onDataAvailable(sfx.cache));
      return;
    }

    if (sfx.state === S.SFX_STATE.NEW) {
      this.LoadSound(sfx).then((res) => {
        if (!res) {
          return;
        }

        onDataAvailable(sfx.cache);
      });
      return;
    }

    if (sfx.state === S.SFX_STATE.LOADING) {
      Con.Print(`S.StaticSound: loading state for ${sfx.name}\n`);

    }
  },

  //
  // --- Commands
  //

  SoundList_f() {
    let total = 0;
    for (let i = 0; i < this.knownSfx.length; i++) {
      const sfx = this.knownSfx[i];
      let sizeStr = '';

      switch (sfx.state) {
        case S.SFX_STATE.AVAILABLE: {
            const sc = sfx.cache;
            sizeStr = sc.size.toString();
            total += sc.size;
          }
          break;
        case S.SFX_STATE.FAILED:
          sizeStr = 'FAILED';
          break;
        case S.SFX_STATE.LOADING:
          sizeStr = 'LOADING';
          break;
        case S.SFX_STATE.NEW:
          sizeStr = 'NEW';
          break;
        default:
          sizeStr = `(${sfx.state})`;
      }

      while (sizeStr.length <= 8) {
        sizeStr = ` ${sizeStr}`;
      }

      sizeStr = (sfx.cache?.loopstart != null) ? `L ${sizeStr}` : `  ${sizeStr}`;

      Con.Print(`${sizeStr} : ${sfx.name}\n`);
    }
    Con.Print(`Total resident: ${total}\n`);
  },

  Play() {
    if (this.nosound.value !== 0) {
      return;
    }
    // e.g. "Play misc/hit1 misc/hit2"
    for (let i = 1; i < Cmd.argv.length; ++i) {
      const sfxName = COM.DefaultExtension(Cmd.argv[i], '.wav');
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this.listenerOrigin, 1.0, 1.0);
      }
    }
  },

  PlayVol() {
    if (this.nosound.value !== 0) {
      return;
    }
    // e.g. "playvol misc/hit1 0.5 misc/hit2 0.2"
    for (let i = 1; i < Cmd.argv.length; i += 2) {
      const sfxName = COM.DefaultExtension(Cmd.argv[i], '.wav');
      const volume = Q.atof(Cmd.argv[i + 1]);
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this.listenerOrigin, volume, 1.0);
      }
    }
  },

  //
  // --- Per-frame updates
  //

  UpdateAmbientSounds() {
    if (!CL.state.worldmodel) {
      // no map yet
      return;
    }

    const l = Mod.PointInLeaf(this.listenerOrigin, CL.state.worldmodel);
    if (!l || this.ambientLevel.value === 0) {
      // turn off all ambients
      for (let i = 0; i < this.ambientChannels.length; i++) {
        const ch = this.ambientChannels[i];
        ch.master_vol = 0.0;
        if (ch.nodes) {
          this.NoteOff(ch.nodes.source);
        } else if (ch.audio && !ch.audio.paused) {
          ch.audio.pause();
        }
      }
      return;
    }

    // ramp up/down volumes
    for (let i = 0; i < this.ambientChannels.length; i++) {
      const ch = this.ambientChannels[i];
      if (!ch.nodes && !ch.audio) {
        continue;
      }
      let vol = this.ambientLevel.value * l.ambient_level[i];
      if (vol < 8.0) vol = 0.0;
      vol /= 255.0;

      // fade
      if (ch.master_vol < vol) {
        ch.master_vol += (Host.frametime * this.ambientFade.value) / 255.0;
        if (ch.master_vol > vol) ch.master_vol = vol;
      } else if (ch.master_vol > vol) {
        ch.master_vol -= (Host.frametime * this.ambientFade.value) / 255.0;
        if (ch.master_vol < vol) ch.master_vol = vol;
      }

      // If volume = 0, stop playing
      if (ch.master_vol <= 0.0) {
        if (ch.nodes) {
          this.NoteOff(ch.nodes.source);
        } else if (ch.audio && !ch.audio.paused) {
          ch.audio.pause();
        }
        continue;
      }
      if (ch.master_vol > 1.0) ch.master_vol = 1.0;

      // Actually set volume
      if (this.context && ch.nodes) {
        ch.nodes.gain.gain.value = ch.master_vol * this.volume.value;
        this.NoteOn(ch.nodes.source);
      } else if (ch.audio) {
        ch.audio.volume = ch.master_vol * this.volume.value;
        const sc = ch.sfx.cache;
        if (ch.audio.paused) {
          this.TryPlayingChannel(ch);
          ch.end = Host.realtime + sc.length;
          continue;
        }
        if (Host.realtime >= ch.end) {
          try {
            ch.audio.currentTime = sc.loopstart;
          } catch (e) {
            ch.end = Host.realtime;
            continue;
          }
          ch.end = Host.realtime + sc.length - sc.loopstart;
        }
      }
    }
  },

  UpdateDynamicSounds() {
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      if (!ch || !ch.sfx) continue;

      if (Host.realtime >= ch.end) {
        const sc = ch.sfx.cache;
        // If it's looped, try to wrap around
        if (sc.loopstart != null) {
          if (!this.context && ch.audio) {
            try {
              ch.audio.currentTime = sc.loopstart;
            } catch (e) {
              ch.end = Host.realtime;
              continue;
            }
          }
          ch.end = Host.realtime + sc.length - (sc.loopstart || 0);
        } else {
          ch.sfx = null;
          ch.nodes = null;
          ch.audio = null;
          continue;
        }
      }

      // Re-Spatialize
      this.Spatialize(ch);

      // Recompute volume
      if (this.context && ch.nodes) {
        ch.leftvol = Math.min(ch.leftvol, 1.0);
        ch.rightvol = Math.min(ch.rightvol, 1.0);
        ch.nodes.gain0.gain.value = ch.leftvol * this.volume.value;
        ch.nodes.gain1.gain.value = ch.rightvol * this.volume.value;
      } else if (ch.audio) {
        let volume = (ch.leftvol + ch.rightvol) * 0.5;
        volume = Math.min(volume, 1.0);
        ch.audio.volume = volume * this.volume.value;
      }
    }
  },

  UpdateStaticSounds() {
    // Spatialize all static channels
    for (let i = 0; i < this.staticChannels.length; i++) {
      this.Spatialize(this.staticChannels[i]);
    }

    // Combine channels that share the same sfx
    for (let i = 0; i < this.staticChannels.length; i++) {
      const ch = this.staticChannels[i];
      if (ch.leftvol <= 0.0 && ch.rightvol <= 0.0) {
        continue;
      }
      for (let j = i + 1; j < this.staticChannels.length; j++) {
        const ch2 = this.staticChannels[j];
        if (ch.sfx === ch2.sfx) {
          ch.leftvol += ch2.leftvol;
          ch.rightvol += ch2.rightvol;
          ch2.leftvol = 0.0;
          ch2.rightvol = 0.0;
        }
      }
    }

    if (this.context) {
      for (let i = 0; i < this.staticChannels.length; i++) {
        const ch = this.staticChannels[i];
        if (!ch.nodes || (!ch.leftvol && !ch.rightvol)) {
          if (ch?.nodes?.source) this.NoteOff(ch.nodes.source);
          continue;
        }
        ch.leftvol = Math.min(ch.leftvol, 1.0);
        ch.rightvol = Math.min(ch.rightvol, 1.0);
        ch.nodes.gain0.gain.value = ch.leftvol * this.volume.value;
        ch.nodes.gain1.gain.value = ch.rightvol * this.volume.value;
        this.NoteOn(ch.nodes.source);
      }
    } else {
      for (let i = 0; i < this.staticChannels.length; i++) {
        const ch = this.staticChannels[i];
        if (!ch.audio) continue;

        let vol = (ch.leftvol + ch.rightvol) * 0.5;
        vol = Math.min(vol, 1.0);
        if (vol <= 0.0) {
          if (!ch.audio.paused) {
            ch.audio.pause();
          }
          continue;
        }
        ch.audio.volume = vol * this.volume.value;

        const sc = ch.sfx.cache;
        if (ch.audio.paused) {
          this.TryPlayingChannel(ch);
          ch.end = Host.realtime + sc.length;
          continue;
        }
        if (Host.realtime >= ch.end) {
          try {
            ch.audio.currentTime = sc.loopstart;
          } catch (e) {
            ch.end = Host.realtime;
          }
        }
      }
    }
  },

  Update(origin, forward, right, up) {
    if (this.nosound.value !== 0) {
      return;
    }

    // Copy listener info
    this.listenerOrigin[0] = origin[0];
    this.listenerOrigin[1] = origin[1];
    this.listenerOrigin[2] = origin[2];

    this.listenerForward[0] = forward[0];
    this.listenerForward[1] = forward[1];
    this.listenerForward[2] = forward[2];

    this.listenerRight[0] = right[0];
    this.listenerRight[1] = right[1];
    this.listenerRight[2] = right[2];

    this.listenerUp[0] = up[0];
    this.listenerUp[1] = up[1];
    this.listenerUp[2] = up[2];

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

  //
  // --- Utility
  //

  LocalSound(sound) {
    // Plays a sound at the view entity, entchannel = -1
    this.StartSound(CL.state.viewentity, -1, sound, Vec.origin, 1.0, 1.0);
  },
};
