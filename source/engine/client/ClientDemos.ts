import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';
import * as Protocol from '../network/Protocol.ts';
import { HostError } from '../common/Errors.ts';

let { CL, COM, Con, Host, NET } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Host, NET } = getClientRegistry());
});

/**
 * Returns a readable error message for demo playback failures.
 * @returns Readable error message.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class ClientDemos {
  demoname: string | null = null;
  demonum = 0;
  demoplayback = false;
  demorecording = false;
  demos: string[] = [];

  demofile: ArrayBuffer | null = null;
  demoofs = 0;
  demosize = 0;
  timedemo = false;
  td_starttime = 0;
  td_startframe = 0;
  td_lastframe = -1;
  forcetrack = -1;

  /** Host.realtime when gameplay (signon 4) first began. */
  demoBaseRealtime: number | null = null;

  /** Server time (clientMessages.mtime[0]) at demoBaseRealtime. */
  demoBaseServertime = 0;

  #getDemoFile(): ArrayBuffer {
    if (this.demofile === null) {
      throw new HostError('demo file is not open');
    }

    return this.demofile;
  }

  writeDemoMessage(): void {
    const currentFile = this.#getDemoFile();
    const len = this.demoofs + 16 + NET.message.cursize;

    if (currentFile.byteLength < len) {
      const src = new Uint8Array(currentFile, 0, this.demoofs);
      this.demofile = new ArrayBuffer(currentFile.byteLength + 16384);
      new Uint8Array(this.demofile).set(src);
    }

    const demoFile = this.#getDemoFile();
    const view = new DataView(demoFile, this.demoofs, 16);
    view.setInt32(0, NET.message.cursize, true);
    view.setFloat32(4, CL.state.viewangles[0], true);
    view.setFloat32(8, CL.state.viewangles[1], true);
    view.setFloat32(12, CL.state.viewangles[2], true);
    new Uint8Array(demoFile).set(new Uint8Array(NET.message.data, 0, NET.message.cursize), this.demoofs + 16);

    this.demoofs = len;
  }

  getMessage(): 0 | 1 {
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
      } else {
        // keep track of time when the first frame with time kicks in
        // we need to make sure we stick to the timeline
        if (this.demoBaseRealtime === null) {
          this.demoBaseRealtime = Host.realtime;
          this.demoBaseServertime = CL.state.clientMessages.mtime[0];
        }

        const elapsed = Host.realtime - this.demoBaseRealtime;
        const demoTime = this.demoBaseServertime + elapsed;

        if (demoTime <= CL.state.clientMessages.mtime[0]) {
          return 0;
        }
      }
    }

    if ((this.demoofs + 16) >= this.demosize) {
      CL.StopPlayback();
      return 0;
    }

    const demoFile = this.#getDemoFile();
    const view = new DataView(demoFile);
    NET.message.cursize = view.getUint32(this.demoofs, true);

    if (NET.message.cursize > 8000) {
      throw new HostError('Demo message > MAX_MSGLEN');
    }

    CL.state.viewangles.setTo(
      view.getFloat32(this.demoofs + 4, true),
      view.getFloat32(this.demoofs + 8, true),
      view.getFloat32(this.demoofs + 12, true),
    );

    this.demoofs += 16;

    if ((this.demoofs + NET.message.cursize) > this.demosize) {
      CL.StopPlayback();
      return 0;
    }

    const src = new Uint8Array(demoFile, this.demoofs, NET.message.cursize);
    const dest = new Uint8Array(NET.message.data, 0, NET.message.cursize);

    for (let index = 0; index < NET.message.cursize; index++) {
      dest[index] = src[index];
    }

    this.demoofs += NET.message.cursize;

    return 1;
  }

  async startPlayback(demoname: string, timedemo = false): Promise<void> {
    console.assert(CL.cls.state === clientConnectionState.disconnected, 'must be disconnected to start playback');
    console.assert(!this.demoplayback, 'must not be in playback mode');

    const name = COM.DefaultExtension(demoname, '.dem');
    Con.Print(`Playing demo from ${name}.\n`);

    this.demofile = await COM.LoadFile(name);
    if (this.demofile === null) {
      Con.PrintError(`ERROR: couldn't open ${demoname}\n`);
      this.demonum = -1;
      // TODO: SCR.disabled_for_loading = false;
      return;
    }

    const demoFileBytes = new Uint8Array(this.demofile);
    this.demosize = demoFileBytes.length;
    this.demoplayback = true;
    // eslint-disable-next-line require-atomic-updates
    CL.cls.state = clientConnectionState.connected;
    this.forcetrack = 0;

    let index: number;
    let neg = false;

    for (index = 0; index < demoFileBytes.length; index++) {
      const character = demoFileBytes[index];

      if (character === 10) {
        break;
      }

      if (character === 45) {
        neg = true;
      } else {
        this.forcetrack = this.forcetrack * 10 + character - 48;
      }
    }

    if (neg === true) {
      this.forcetrack = -this.forcetrack;
    }

    this.demoofs = index + 1;

    this.demoBaseRealtime = null;
    this.demoBaseServertime = 0;

    if (timedemo) {
      this.timedemo = true;
      this.td_startframe = Host.framecount;
      this.td_lastframe = -1;
    }
  }

  stopPlayback(): void {
    if (!this.demoplayback) {
      return;
    }

    this.demoplayback = false;
    this.demofile = null;
    this.demoBaseRealtime = null;
    this.demoBaseServertime = 0;
    CL.cls.state = clientConnectionState.disconnected;

    if (this.timedemo) {
      this.#finishTimeDemo();
    }
  }

  startRecording(demoname: string, forcetrack = -1): void {
    console.assert(CL.cls.state === clientConnectionState.connected, 'must be connected to start recording a demo');

    if (forcetrack !== -1) {
      Con.Print(`Forcing track ${forcetrack} for demo recording.\n`);
    }

    this.forcetrack = forcetrack;

    this.demoname = COM.DefaultExtension(demoname, '.dem');

    Con.PrintSuccess(`recording to ${this.demoname}.\n`);

    this.demofile = new ArrayBuffer(16384);

    const trackString = `${this.forcetrack.toString()}\n`;
    const dest = new Uint8Array(this.demofile, 0, trackString.length);

    for (let index = 0; index < trackString.length; index++) {
      dest[index] = trackString.charCodeAt(index);
    }

    this.demoofs = trackString.length;
    this.demorecording = true;
  }

  async stopRecording(): Promise<boolean> {
    if (!this.demorecording) {
      Con.Print('Not recording a demo.\n');
      return false;
    }

    NET.message.clear();
    NET.message.writeByte(Protocol.svc.disconnect);
    NET.message.writeString('ClientDemos.stopRecording: stopping demo recording');

    this.writeDemoMessage();

    const demoname = this.demoname;
    const demoFile = this.demofile;
    if (demoname === null || demoFile === null) {
      throw new HostError('demo recording state is incomplete');
    }

    if (!await COM.WriteFile(demoname, new Uint8Array(demoFile), this.demoofs)) {
      Con.PrintError(`ERROR: couldn't write demo file ${demoname}!`);
      return false;
    }

    this.demofile = null;
    this.demorecording = false;

    Con.PrintSuccess('Completed demo\n');

    return true;
  }

  startDemos(demos: string[]): void {
    this.demos.length = 0;
    this.demos.push(...demos);

    if (this.demonum !== -1 && !this.demoplayback) {
      this.demonum = 0;
      this.playNext();
    } else {
      this.demonum = -1;
    }
  }

  playNext(): void {
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
    this.startPlayback(this.demos[this.demonum++]).catch((error: unknown) => {
      Con.PrintError(`Failed to start playback: ${getErrorMessage(error)}\n`);
    });
  }

  #finishTimeDemo(): void {
    this.timedemo = false;

    const frames = Host.framecount - this.td_startframe - 1;
    const time = Math.max(1, Host.realtime - this.td_starttime);

    Con.Print(`${frames} frames ${time.toFixed(1)} seconds ${(frames / time).toFixed(1)} fps\n`);
  }
}
