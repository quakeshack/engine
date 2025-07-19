import { eventBus, registry } from '../registry.mjs';

let { GL } = registry;

eventBus.subscribe('registry.frozen', () => {
  GL = registry.GL;
});

export default class VID {
  /** @type {number} */
  static width = null;
  /** @type {number} */
  static height = null;
  /** @type {HTMLCanvasElement} */
  static mainwindow = null;
  /** @type {number} */
  static pixelRatio = 1;

  static Resize() {
    const elem = document.documentElement;
    const width = (elem.clientWidth <= 320) ? 320 : elem.clientWidth;
    const height = (elem.clientHeight <= 200) ? 200 : elem.clientHeight;

    if (width === VID.width && height === VID.height && window.devicePixelRatio === VID.pixelRatio) {
      return; // no change
    }

    VID.width = width;
    VID.height = height;
    VID.pixelRatio = window.devicePixelRatio || 1;
    VID.mainwindow.width = Math.round(width * VID.pixelRatio);
    VID.mainwindow.height = Math.round(height * VID.pixelRatio);
    VID.mainwindow.style.width = width + 'px';
    VID.mainwindow.style.height = height + 'px';

    eventBus.publish('vid.resize', {
      width: VID.width,
      height: VID.height,
      pixelRatio: VID.pixelRatio,
    });
  }

  static DownloadScreenshot() {
    const dataURL = VID.mainwindow.toDataURL('image/jpeg');
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = 'screenshot.jpg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  static async Init() {
    // @ts-ignore
    VID.mainwindow = document.getElementById('mainwindow');

    VID.mainwindow.style.display = 'inline-block';

    const $progress = document.getElementById('progress');
    $progress.parentElement.removeChild($progress);

    document.getElementById('console').style.display = 'none';

    VID.Resize();
    GL.Init();

    window.addEventListener('resize', VID.Resize);
  };

  static async Shutdown() {
    GL.Shutdown();

    document.getElementById('console').style.display = 'block';
    VID.mainwindow.style.display = 'none';

    window.removeEventListener('resize', VID.Resize);
  }
};
