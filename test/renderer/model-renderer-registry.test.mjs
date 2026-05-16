import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { ModelRenderer } from '../../source/engine/client/renderer/ModelRenderer.ts';
import { ModelRendererRegistry } from '../../source/engine/client/renderer/ModelRendererRegistry.ts';

class TestModel extends BaseModel {}
class TestModelChild extends TestModel {}
class OtherModel extends BaseModel {}

class TestModelRenderer extends ModelRenderer {
  getModelClass() {
    return TestModel;
  }
}

class OtherModelRenderer extends ModelRenderer {
  getModelClass() {
    return OtherModel;
  }
}

void describe('ModelRendererRegistry', () => {
  void test('registers and resolves renderers by model class', () => {
    const registry = new ModelRendererRegistry();
    const renderer = new TestModelRenderer();

    registry.register(renderer);

    assert.equal(registry.hasRendererForModelClass(TestModel), true);
    assert.equal(registry.getRendererForModelClass(TestModel), renderer);
    assert.deepEqual(registry.getRegisteredModelClasses(), [TestModel]);
  });

  void test('resolves renderer from concrete model instances', () => {
    const registry = new ModelRendererRegistry();
    const renderer = new TestModelRenderer();
    const model = new TestModel('test-model');

    registry.register(renderer);

    assert.equal(registry.getRendererForModel(model), renderer);
  });

  void test('falls back to instanceof matching for subclasses', () => {
    const registry = new ModelRendererRegistry();
    const renderer = new TestModelRenderer();
    const childModel = new TestModelChild('child-model');

    registry.register(renderer);

    assert.equal(registry.getRendererForModel(childModel), renderer);
  });

  void test('unregisters model-class mappings', () => {
    const registry = new ModelRendererRegistry();
    const testRenderer = new TestModelRenderer();
    const otherRenderer = new OtherModelRenderer();

    registry.register(testRenderer);
    registry.register(otherRenderer);

    assert.equal(registry.unregisterForModelClass(TestModel), true);
    assert.equal(registry.getRendererForModelClass(TestModel), null);
    assert.equal(registry.getRendererForModelClass(OtherModel), otherRenderer);
  });
});
