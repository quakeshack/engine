import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../source/game/id1/GameAPI.ts');

const { FogEntity } = await import('../../source/game/id1/entity/props/Misc.ts');

/**
 * Create a minimal game API surface for fog entity tests.
 * @returns {{ entity: import('../../source/game/id1/entity/props/Misc.ts').FogEntity }} Fixture data.
 */
function createFogFixture() {
  const gameAPI = {
    engine: {
      IsLoading() {
        return false;
      },
    },
  };

  const entity = new FogEntity(null, gameAPI).initializeEntity();
  return { entity };
}

void describe('FogEntity', () => {
  void test('uses decorated defaults for fog fields', () => {
    const { entity } = createFogFixture();
    const serialized = entity._serializer.serialize();

    assert.equal(entity.fog_color, '128 128 128');
    assert.equal(entity.fog_density, 0.01);
    assert.equal(entity.fog_max_opacity, 0.8);
    assert.ok(FogEntity.serializableFields.includes('fog_color'));
    assert.ok(FogEntity.serializableFields.includes('fog_density'));
    assert.ok(FogEntity.serializableFields.includes('fog_max_opacity'));
    assert.ok('fog_color' in serialized);
    assert.ok('fog_density' in serialized);
    assert.ok('fog_max_opacity' in serialized);
  });

  void test('assignInitialData overrides fog parameters with map values', () => {
    const { entity } = createFogFixture();

    entity.assignInitialData({
      fog_color: '10 20 30',
      fog_density: '0.05',
      fog_max_opacity: '0.4',
    });

    assert.equal(entity.fog_color, '10 20 30');
    assert.equal(entity.fog_density, 0.05);
    assert.equal(entity.fog_max_opacity, 0.4);
  });
});
