import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Chase from '../../source/engine/client/Chase.ts';
import { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import GL from '../../source/engine/client/GL.ts';
import R from '../../source/engine/client/R.ts';
import { ModelRenderer } from '../../source/engine/client/renderer/models/ModelRenderer.ts';
import { modelRendererRegistry } from '../../source/engine/client/renderer/models/ModelRendererRegistry.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import Camera from '../../source/engine/client/renderer/scene/Camera.ts';
import FrameUniforms from '../../source/engine/client/renderer/scene/FrameUniforms.ts';
import viewCvars from '../../source/engine/client/view/ViewCvars.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { SpriteModelRenderer } from '../../source/engine/client/renderer/models/SpriteModelRenderer.ts';
import type { ClientGameInterface } from '../../source/shared/GameInterfaces.ts';
import { createCvarStub } from '../support/cvarStub.ts';
import { publishGlReady } from '../support/glEvents.ts';

/** A model class no real renderer is registered for, so a test can see which renderer the view model pass picks. */
class WeaponModel extends BaseModel {}

class WeaponRenderer extends ModelRenderer {
  readonly steps: string[];

  constructor(steps: string[]) {
    super();
    this.steps = steps;
  }

  override getModelClass(): typeof BaseModel {
    return WeaponModel;
  }

  override setupRenderState(pass = 0): void {
    this.steps.push(`setup ${pass}`);
  }

  override render(_model: BaseModel, entity: ClientEdict, pass = 0): void {
    this.steps.push(`render ${pass} at ${entity.origin[0]}`);
  }

  override cleanupRenderState(pass = 0): void {
    this.steps.push(`cleanup ${pass}`);
  }
}

/** What hangs on the weapon: a solid part, a glass part and a sprite, each with a renderer that says which it is. */
class SolidModel extends BaseModel {}
class GlassModel extends BaseModel {}

class AttachmentRenderer extends ModelRenderer {
  readonly #modelClass: typeof BaseModel;
  readonly #translucent: boolean;
  readonly steps: string[];

  constructor(steps: string[], modelClass: typeof BaseModel, translucent: boolean) {
    super();
    this.steps = steps;
    this.#modelClass = modelClass;
    this.#translucent = translucent;
  }

  override getModelClass(): typeof BaseModel {
    return this.#modelClass;
  }

  override rendersOpaquePass(): boolean {
    return !this.#translucent;
  }

  override rendersTransparentPass(): boolean {
    return this.#translucent;
  }

  override setupRenderState(pass = 0): void {
    this.steps.push(`${this.#modelClass.name} setup ${pass}`);
  }

  override render(_model: BaseModel, _entity: ClientEdict, pass = 0): void {
    this.steps.push(`${this.#modelClass.name} render ${pass}`);
  }

  override cleanupRenderState(pass = 0): void {
    this.steps.push(`${this.#modelClass.name} cleanup ${pass}`);
  }
}

void describe('R.DrawViewModel', () => {
  const previous = {
    context: GL.gl,
    drawviewmodel: rendererCvars.drawviewmodel,
    drawentities: rendererCvars.drawentities,
    chase: Chase.active,
    fov: viewCvars.fov,
    gameAPI: clientRuntimeState.gameAPI,
    viewent: clientRuntimeState.viewent,
    vrect: { ...Camera.refdef.vrect },
    fovY: Camera.refdef.fov_y,
  };
  let steps: string[] = [];
  let weaponModel: WeaponModel;

  beforeEach(() => {
    steps = [];
    weaponModel = new WeaponModel('models/v_test.iqm');
    GL.gl = {
      depthRange: (near: number, far: number) => { steps.push(`depthRange ${near} ${far}`); },
      depthMask: (on: boolean) => { steps.push(`depthMask ${on}`); },
      enable: (capability: number) => { steps.push(`enable ${capability === 3042 ? 'BLEND' : capability}`); },
      disable: (capability: number) => { steps.push(`disable ${capability === 3042 ? 'BLEND' : capability}`); },
      blendFunc: (source: number, destination: number) => { steps.push(`blendFunc ${source} ${destination}`); },
      BLEND: 3042,
      ONE: 1,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,
    } as unknown as WebGL2RenderingContext;
    publishGlReady();

    rendererCvars.drawviewmodel = createCvarStub(1);
    rendererCvars.drawentities = createCvarStub(1);
    Chase.active = createCvarStub(0);
    viewCvars.fov = createCvarStub(100);
    Camera.refdef.vrect.width = 800;
    Camera.refdef.vrect.height = 400;
    Camera.refdef.fov_y = 70;

    const viewent = new ClientEdict(-1);
    viewent.model = weaponModel;
    viewent.origin.setTo(7, 0, 0);
    clientRuntimeState.viewent = viewent;
    clientRuntimeState.gameAPI = { viewmodel: { model: weaponModel, frame: 0, visible: true } } as unknown as ClientGameInterface;

    modelRendererRegistry.register(new WeaponRenderer(steps));
    mock.method(FrameUniforms, 'UploadPerspective', () => {
      steps.push(`projection ${Camera.perspective[5].toFixed(4)}`);
    });
  });

  afterEach(() => {
    mock.restoreAll();
    modelRendererRegistry.unregisterForModelClass(WeaponModel);
    modelRendererRegistry.unregisterForModelClass(SolidModel);
    modelRendererRegistry.unregisterForModelClass(GlassModel);
    eventBus.publish('gl.shutdown');
    GL.gl = previous.context;
    rendererCvars.drawviewmodel = previous.drawviewmodel;
    rendererCvars.drawentities = previous.drawentities;
    Chase.active = previous.chase;
    viewCvars.fov = previous.fov;
    clientRuntimeState.gameAPI = previous.gameAPI;
    clientRuntimeState.viewent = previous.viewent;
    Object.assign(Camera.refdef.vrect, previous.vrect);
    Camera.refdef.fov_y = previous.fovY;
    Camera.UpdateProjection(previous.fovY, previous.vrect.width / previous.vrect.height);
  });

  /**
   * The projection's vertical scale for a field of view, as `Camera.UpdateProjection` writes it.
   * @param fovY Vertical field of view in degrees.
   * @returns The text of the scale, as the recording writes it.
   */
  function verticalScale(fovY: number): string {
    return (4.0 / (4.0 * Math.tan(fovY * Math.PI / 360.0))).toFixed(4);
  }

  void test('draws a model of any renderer with the narrow projection, and gives the frame its projection back', () => {
    R.DrawViewModel();

    assert.deepEqual(steps, [
      'depthRange 0 0.3',
      `projection ${verticalScale(100 * 0.82)}`,
      'setup 0',
      'render 0 at 7',
      'cleanup 0',
      `projection ${verticalScale(70)}`,
      'depthRange 0 1',
    ]);
    assert.notEqual(verticalScale(100 * 0.82), verticalScale(70));
  });

  void test('draws nothing the game or the player does not want drawn', () => {
    const wanted = [
      () => { rendererCvars.drawviewmodel = createCvarStub(0); },
      () => { rendererCvars.drawentities = createCvarStub(0); },
      () => { Chase.active = createCvarStub(1); },
      () => { clientRuntimeState.gameAPI = { viewmodel: { model: weaponModel, frame: 0, visible: false } } as unknown as ClientGameInterface; },
      () => { clientRuntimeState.gameAPI = { viewmodel: { model: null, frame: 0, visible: true } } as unknown as ClientGameInterface; },
      () => { clientRuntimeState.gameAPI = { viewmodel: null } as unknown as ClientGameInterface; },
    ];

    for (const change of wanted) {
      change();
      R.DrawViewModel();
      assert.deepEqual(steps, [], 'no state is touched when nothing is drawn');
    }
  });

  void test('restores the projection for a model whose renderer is missing', () => {
    mock.method(console, 'assert', () => {});
    clientRuntimeState.viewent!.model = new BaseModel('models/unknown.bin');

    R.DrawViewModel();

    assert.deepEqual(steps.filter((step) => step.startsWith('projection')), [
      `projection ${verticalScale(100 * 0.82)}`,
      `projection ${verticalScale(70)}`,
    ]);
  });

  void describe('with entities on the weapon', () => {
    let attachments: ClientEdict[] = [];
    let spriteRenderer: SpriteModelRenderer;
    let hadSpriteRenderer: boolean;

    /**
     * @param model What the entity shows.
     * @param alpha How opaque it is.
     * @returns An entity attached to the weapon.
     */
    function attach(model: BaseModel, alpha = 1.0): ClientEdict {
      const entity = new ClientEdict(-1);

      entity.model = model;
      entity.alpha = alpha;
      attachments.push(entity);

      return entity;
    }

    beforeEach(() => {
      attachments = [];
      modelRendererRegistry.register(new AttachmentRenderer(steps, SolidModel, false));
      modelRendererRegistry.register(new AttachmentRenderer(steps, GlassModel, true));
      hadSpriteRenderer = modelRendererRegistry.hasRendererForModelClass(SpriteModel);
      spriteRenderer = new SpriteModelRenderer();
      mock.method(spriteRenderer, 'setupRenderState', (pass: number) => { steps.push(`sprite setup ${pass}`); });
      mock.method(spriteRenderer, 'render', (_model: BaseModel, _entity: ClientEdict, pass: number) => { steps.push(`sprite render ${pass}`); });
      mock.method(spriteRenderer, 'cleanupRenderState', (pass: number) => { steps.push(`sprite cleanup ${pass}`); });
      if (!hadSpriteRenderer) {
        modelRendererRegistry.register(spriteRenderer);
      }
      mock.method(GL, 'StreamFlush', () => { steps.push('flush'); });
      mock.method(clientRuntimeState.clientEntities, 'resolveViewmodelAttachments', () => attachments);
    });

    afterEach(() => {
      if (!hadSpriteRenderer) {
        modelRendererRegistry.unregisterForModelClass(SpriteModel);
      }
    });

    void test('draws them after the weapon and before the projection goes back, solid ones first and blended ones with the depth mask off', () => {
      attach(new GlassModel('glass'), 0.5);
      attach(new SolidModel('solid'));

      R.DrawViewModel();

      const narrow = `projection ${verticalScale(100 * 0.82)}`;
      const wide = `projection ${verticalScale(70)}`;

      assert.deepEqual(steps.slice(steps.indexOf(narrow)), [
        narrow,
        'setup 0',
        'render 0 at 7',
        'cleanup 0',
        'SolidModel setup 0',
        'SolidModel render 0',
        'SolidModel cleanup 0',
        'depthMask false',
        'enable BLEND',
        'blendFunc 770 771',
        'GlassModel setup 2',
        'GlassModel render 2',
        'GlassModel cleanup 2',
        'flush',
        'disable BLEND',
        'depthMask true',
        wide,
        'depthRange 0 1',
      ]);
    });

    void test('draws a sprite blended, with the premultiplied blend function, and flushes what it streamed', () => {
      attach(new SpriteModel('flash'));

      R.DrawViewModel();

      assert.deepEqual(steps.slice(steps.indexOf('cleanup 0') + 1, steps.indexOf('disable BLEND')), [
        'depthMask false',
        'enable BLEND',
        'blendFunc 1 771',
        'sprite setup 1',
        'sprite render 1',
        'sprite cleanup 1',
        'flush',
      ]);
    });

    void test('touches no blend state when everything on the weapon is solid, and skips what is invisible or has no model', () => {
      attach(new SolidModel('solid'));
      attach(new SolidModel('hidden'), 0.0);
      attach(new BaseModel('no renderer'));

      R.DrawViewModel();

      assert.equal(steps.filter((step) => step.startsWith('SolidModel render')).length, 1);
      assert.equal(steps.some((step) => step.startsWith('enable') || step.startsWith('depthMask')), false);
    });

    void test('draws nothing on the weapon when the weapon itself is not drawn', () => {
      attach(new SolidModel('solid'));
      Chase.active = createCvarStub(1);

      R.DrawViewModel();

      assert.deepEqual(steps, []);
    });
  });
});
