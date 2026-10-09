// Vertex side of the lit entity programs (alias, mesh, player), matched by entity-lighting.glsl. A program provides
// the object-space position (interpolated or not) and calls emitEntityVertex() from main().
uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;
uniform vec3 uDynamicLightVec;

// Shadow mapping
uniform mat4 uLightSpaceMatrix;

#include "entity-varyings-out.glsl"
#include "fog-vertex.glsl"

/**
 * Writes gl_Position and all varyings of a lit entity vertex.
 * @param localPosition Position in the model's own space.
 * @param localNormal Normal in the model's own space.
 * @param texCoord Texture coordinate.
 */
void emitEntityVertex(vec3 localPosition, vec3 localNormal, vec2 texCoord) {
  vec3 worldPos = uAngles * localPosition + uOrigin;
  vWorldPos = worldPos;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  // Shadow coordinates in light space
  vShadowCoord = uLightSpaceMatrix * vec4(worldPos, 1.0);

  vTexCoord = texCoord;
  vec3 worldNormal = uAngles * localNormal;
  vec3 lightDir = normalize(worldPos - uLightVec);
  vec3 dynamicLightDir = normalize(worldPos - uDynamicLightVec);
  vLightDot = max(0.0, dot(worldNormal, lightDir));
  vDynamicLightDot = max(0.0, dot(worldNormal, dynamicLightDir));
  vNormal = worldNormal;
  vLightVec = lightDir;
  vDynamicLightVec = dynamicLightDir;
  vViewVec = normalize(uViewOrigin - worldPos);

  // fog distance (world position)
  vFog = computeFog(length(worldPos - uViewOrigin));
}
