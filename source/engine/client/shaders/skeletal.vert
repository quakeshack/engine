#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTexCoord;
in vec3 aNormal;

#include "entity-vertex.glsl"

// The vertices arrive already skinned (see SkeletalModelRenderer), so this is the mesh program's vertex stage.
void main(void) {
  emitEntityVertex(aPosition, aNormal, aTexCoord);
}
