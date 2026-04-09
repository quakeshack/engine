import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MaterialFlags, resolveMaterialLuminanceTexture } from '../../source/engine/client/renderer/Materials.ts';

void describe('resolveMaterialLuminanceTexture', () => {
  void test('keeps the explicit luminance texture when one is present', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const luminanceTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, luminanceTexture, diffuseTexture, fallbackTexture),
      luminanceTexture,
    );
  });

  void test('uses the diffuse texture as luminance for MF_FULLBRIGHT materials without an emissive map', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_FULLBRIGHT, fallbackTexture, diffuseTexture, fallbackTexture),
      diffuseTexture,
    );
  });

  void test('falls back to the renderer black texture for non-fullbright materials without emissive data', () => {
    const fallbackTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});
    const diffuseTexture = /** @type {import('../../source/engine/client/GL.ts').GLTexture} */ ({});

    assert.equal(
      resolveMaterialLuminanceTexture(MaterialFlags.MF_NONE, null, diffuseTexture, fallbackTexture),
      fallbackTexture,
    );
  });
});
