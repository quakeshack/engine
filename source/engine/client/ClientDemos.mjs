
import { clientConnectionState } from '../common/Def.mjs';
import MSG from '../network/MSG.mjs';
import { eventBus, registry } from '../registry.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { HostError } from '../common/Errors.mjs';

let { CL, COM, Con, Host, NET } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  NET = registry.NET;
});

export default class ClientDemos {
  /** @type {string} */
  demoname = null;
  demonum = 0;
  demoplayback = false;
  demorecording = false;
  /** @type {string[]} */
  demos = [];

  /** @type {ArrayBuffer} */
  demofile = null;
  demoofs = 0;
  demosize = 0;
  timedemo = false;
  td_starttime = 0;
  td_startframe = 0;
  td_lastframe = -1;
  forcetrack = -1;

  writeDemoMessage() {
    const len = this.demoofs + 16 + NET.message.cursize;

    if (this.demofile.byteLength < len) {
      const src = new Uint8Array(this.demofile, 0, this.demoofs);
      this.demofile = new ArrayBuffer(this.demofile.byteLength + 16384);
      (new Uint8Array(this.demofile)).set(src);
    }

    const f = new DataView(this.demofile, this.demoofs, 16);
    f.setInt32(0, NET.message.cursize, true);
    f.setFloat32(4, CL.state.viewangles[0], true);
    f.setFloat32(8, CL.state.viewangles[1], true);
    f.setFloat32(12, CL.state.viewangles[2], true);
    (new Uint8Array(this.demofile)).set(new Uint8Array(NET.message.data, 0, NET.message.cursize), this.demoofs + 16);

    this.demoofs = len;
  };

  getMessage() {
    console.assert(this.demoplayback, 'must be in playback mode to get message');

    if (CL.cls.signon === 4) {
      if (this.timedemo === true) {
        if (Host.framecount === this.td_lastframe) {
          return 0;
        }
        this.td_lastframe = Host.framecount;
        if (Host.framecount === (this.td_startframe + 1)) {
          this.td_starttime = Host.realtime;
        }
      } else if (CL.state.time <= CL.state.mtime[0]) {
        return 0;
      }
    }

    if ((this.demoofs + 16) >= this.demosize) {
      CL.StopPlayback();
      return 0;
    }

    const view = new DataView(this.demofile);
    NET.message.cursize = view.getUint32(this.demoofs, true);

    if (NET.message.cursize > 8000) {
      throw new HostError('Demo message > MAX_MSGLEN');
    }

    CL.state.viewangles.setTo(view.getFloat32(this.demoofs + 4, true), view.getFloat32(this.demoofs + 8, true), view.getFloat32(this.demoofs + 12, true));

    this.demoofs += 16;

    if ((this.demoofs + NET.message.cursize) > this.demosize) {
      CL.StopPlayback();
      return 0;
    }

    const src = new Uint8Array(this.demofile, this.demoofs, NET.message.cursize);
    const dest = new Uint8Array(NET.message.data, 0, NET.message.cursize);

    for (let i = 0; i < NET.message.cursize; i++) {
      dest[i] = src[i];
    }

    this.demoofs += NET.message.cursize;

    return 1;
  }

  startPlayback(demoname, timedemo = false) {
    console.assert(CL.cls.state === clientConnectionState.disconnected, 'must be disconnected to start playback');
    console.assert(!this.demoplayback, 'must not be in playback mode');

    const name = COM.DefaultExtension(demoname, '.dem');
    Con.Print('Playing demo from ' + name + '.\n');

    this.demofile = COM.LoadFile(name);
    if (this.demofile === null) {
      Con.PrintError('ERROR: couldn\'t open ' + demoname + '\n');
      this.demonum = -1;
      // TODO: SCR.disabled_for_loading = false;
      return;
    }

    const demofile_u8 = new Uint8Array(this.demofile);
    this.demosize = demofile_u8.length;
    this.demoplayback = true;
    CL.cls.state = clientConnectionState.connected;
    this.forcetrack = 0;

    let i;
    let neg = false;

    for (i = 0; i < demofile_u8.length; i++) {
      const c = demofile_u8[i];

      if (c === 10) {
        break;
      }

      if (c === 45) {
        neg = true;
      } else {
        this.forcetrack = this.forcetrack * 10 + c - 48;
      }
    }

    if (neg === true) {
      this.forcetrack = -this.forcetrack;
    }

    this.demoofs = i + 1;

    if (timedemo) {
      this.timedemo = true;
      this.td_startframe = Host.framecount;
      this.td_lastframe = -1;
    }
  }

  stopPlayback() {
    if (!this.demoplayback) {
      return;
    }

    this.demoplayback = false;
    this.demofile = null;
    CL.cls.state = clientConnectionState.disconnected;

    if (this.timedemo) {
      this.#finishTimeDemo();
    }
  };

  startRecording(demoname, forcetrack = -1) {
    console.assert(CL.cls.state === clientConnectionState.connected, 'must be connected to start recording a demo');

    if (forcetrack !== -1) {
      Con.Print(`Forcing track ${forcetrack} for demo recording.\n`);
    }

    this.forcetrack = forcetrack;

    this.demoname = COM.DefaultExtension(demoname, '.dem');

    Con.PrintSuccess('recording to ' + this.demoname + '.\n');

    this.demofile = new ArrayBuffer(16384);

    const trackstr = this.forcetrack.toString() + '\n';
    const dest = new Uint8Array(this.demofile, 0, trackstr.length);

    for (let i = 0; i < trackstr.length; i++) {
      dest[i] = trackstr.charCodeAt(i);
    }

    this.demoofs = trackstr.length;
    this.demorecording = true;
  }

  stopRecording() {
    if (!this.demorecording) {
      Con.Print('Not recording a demo.\n');
      return false;
    }

    NET.message.clear();
    MSG.WriteByte(NET.message, Protocol.svc.disconnect);
    MSG.WriteString(NET.message, 'ClientDemos.stopRecording: stopping demo recording');

    this.writeDemoMessage();

    if (!COM.WriteFile(this.demoname, new Uint8Array(this.demofile), this.demoofs)) {
      Con.PrintError(`ERROR: couldn't write demo file ${this.demoname}!`);
      return false;
    }

    this.demofile = null;
    this.demorecording = false;

    Con.PrintSuccess('Completed demo\n');

    return true;
  }

  startDemos(demos) {
    this.demos.length = 0;
    this.demos.push(...demos);

    if (this.demonum !== -1 && !this.demoplayback) {
      this.demonum = 0;
      this.playNext();
    } else {
      this.demonum = -1;
    }
  }

  playNext() {
    if (this.demonum === -1) {
      return;
    }

    if (this.demonum >= this.demos.length) {
      if (this.demos.length === 0) {
        Con.Print('No demos listed with startdemos\n');
        this.demonum = -1;
        return;
      }

      this.demonum = 0;
    }

    this.stopPlayback();
    this.startPlayback(this.demos[this.demonum++]);
  }

  #finishTimeDemo() {
    this.timedemo = false;

    const frames = Host.framecount - this.td_startframe - 1;
    const time = Math.max(1, Host.realtime - this.td_starttime);

    Con.Print(frames + ' frames ' + time.toFixed(1) + ' seconds ' + (frames / time).toFixed(1) + ' fps\n');
  }
};
