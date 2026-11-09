#version 300 es
precision highp float;
precision highp sampler2D;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

#include "fog-vertex.glsl"
#include "lightstyle-vertex.glsl"

in vec3 aPosition;
in vec3 aNormal;
in vec4 aTexCoord;
in vec4 aLightStyle;
in vec3 aTangent;

out vec4 vTexCoord;
out vec3 vFallbackLight;
out vec2 vDlightTexCoord;
out float vHasLightmap;

// The surface is not displaced like GLQuake's warp: vanilla maps do not have the PVS for it. turbulent-depth.vert has
// to put the surface where this one does.
void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  emitLightstyleBrightness(aLightStyle);
  vFallbackLight = aNormal;
  vDlightTexCoord = aTangent.xy;
  vHasLightmap = aTangent.z;

  vFog = computeFog(length(worldPos - uViewOrigin));
}
