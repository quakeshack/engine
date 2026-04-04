import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import { eventBus } from '../registry.ts';

class FullscreenCommand extends ConsoleCommand {
  override async run(): Promise<void> {
    await VID.mainwindow.requestFullscreen();
  }
}

export default class VID {
  static width = 0;
  static height = 0;
  static mainwindow: HTMLCanvasElement;
  static pixelRatio = 1;

  static Resize(): void {
    const root = document.documentElement;
    const width = root.clientWidth <= 320 ? 320 : root.clientWidth;
    const height = root.clientHeight <= 200 ? 200 : root.clientHeight;

    if (width === VID.width && height === VID.height && window.devicePixelRatio === VID.pixelRatio) {
      return; // no change
    }

    VID.width = width;
    VID.height = height;
    VID.pixelRatio = window.devicePixelRatio || 1;
    VID.mainwindow.width = Math.round(width * VID.pixelRatio);
    VID.mainwindow.height = Math.round(height * VID.pixelRatio);
    VID.mainwindow.style.width = `${width}px`;
    VID.mainwindow.style.height = `${height}px`;

    eventBus.publish('vid.resize', {
      width: VID.width,
      height: VID.height,
      pixelRatio: VID.pixelRatio,
    });
  }

  static DownloadScreenshot(): void {
    const dataURL = VID.mainwindow.toDataURL('image/jpeg');
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = 'screenshot.jpg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  static Init(): void {
    const mainwindow = document.getElementById('mainwindow');
    if (!(mainwindow instanceof HTMLCanvasElement)) {
      throw new Error('Missing required canvas #mainwindow');
    }
    VID.mainwindow = mainwindow;

    VID.mainwindow.style.display = 'inline-block';

    const progress = document.getElementById('progress');
    if (progress === null || progress.parentElement === null) {
      throw new Error('Missing required progress indicator');
    }
    progress.parentElement.removeChild(progress);

    VID.Resize(); // trigger once since we are ready now

    window.addEventListener('resize', VID.Resize);

    Cmd.AddCommand('fullscreen', FullscreenCommand);

    eventBus.publish('vid.ready');
  }

  static Shutdown(): void {
    VID.mainwindow.style.display = 'none';

    window.removeEventListener('resize', VID.Resize);

    eventBus.publish('vid.shutdown');
  }
}
