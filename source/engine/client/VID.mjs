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

  static async Init() {
    // @ts-ignore
    VID.mainwindow = document.getElementById('mainwindow');

    const $progress = document.getElementById('progress');
    $progress.parentElement.removeChild($progress);

    document.getElementById('console').style.display = 'none';

    GL.Init();
  };

  static async Shutdown() {
    GL.Shutdown();

    document.getElementById('console').style.display = 'block';
  }
};
