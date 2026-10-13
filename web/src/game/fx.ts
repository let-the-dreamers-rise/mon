import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  VignetteEffect,
} from 'postprocessing';

const bodycamFrag = /* glsl */ `
uniform float time;
uniform float distortion;
uniform float staticAmt;
uniform float tear;
uniform float hollowTint;
uniform float desat;
uniform float exposure;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void mainUv(inout vec2 uv) {
  // barrel / fisheye of a cheap body-worn lens
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  uv = 0.5 + c * (1.0 - distortion * 0.18 + distortion * r2 * 0.55);
  // horizontal tearing during swaps and torments
  float band = step(0.985 - tear * 0.25, hash(vec2(floor(uv.y * 90.0), floor(time * 24.0))));
  uv.x += band * (hash(vec2(time, uv.y)) - 0.5) * 0.12 * (0.2 + tear);
  uv.y += tear * 0.015 * sin(time * 40.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb * exposure;
  // cheap camera colour science: lifted blacks, crushed highlights, slight green cast
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), desat);
  col = col * vec3(0.96, 1.02, 0.94) + vec3(0.012, 0.016, 0.01);
  // the Hollow sees the world bleeding
  col = mix(col, vec3(l * 1.3, l * 0.25, l * 0.22), hollowTint);
  // scanlines + rolling bar
  float scan = 0.94 + 0.06 * sin(uv.y * 900.0);
  float roll = 0.97 + 0.03 * smoothstep(0.0, 0.08, abs(fract(uv.y - time * 0.07) - 0.5));
  col *= scan * roll;
  // static
  float n = hash(uv * vec2(1920.0, 1080.0) + fract(time * 13.0) * 100.0);
  col = mix(col, vec3(n), clamp(staticAmt, 0.0, 1.0));
  // out-of-lens black
  vec2 c = uv - 0.5;
  if (abs(c.x) > 0.5 || abs(c.y) > 0.5) col = vec3(0.0);
  outputColor = vec4(col, inputColor.a);
}
`;

export class BodycamEffect extends Effect {
  constructor() {
    super('BodycamEffect', bodycamFrag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['time', new THREE.Uniform(0)],
        ['distortion', new THREE.Uniform(1)],
        ['staticAmt', new THREE.Uniform(0)],
        ['tear', new THREE.Uniform(0)],
        ['hollowTint', new THREE.Uniform(0)],
        ['desat', new THREE.Uniform(0.22)],
        ['exposure', new THREE.Uniform(1)],
      ]),
    });
  }
  u(name: string) {
    return this.uniforms.get(name)!;
  }
}

/** Post-processing stack that turns the render into body-worn camera footage. */
export class Fx {
  readonly composer: EffectComposer;
  readonly bodycam = new BodycamEffect();
  readonly chroma: ChromaticAberrationEffect;
  readonly vignette: VignetteEffect;
  readonly noise: NoiseEffect;
  readonly bloom: BloomEffect;
  private renderPass: RenderPass;
  /** 0..1 transient values decayed every frame */
  staticBurst = 0;
  tearBurst = 0;
  sanity = 1;
  hollow = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new BloomEffect({ intensity: 1.1, luminanceThreshold: 0.55, luminanceSmoothing: 0.3, mipmapBlur: true });
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0012, 0.0008), radialModulation: true, modulationOffset: 0.2 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.noise.blendMode.opacity.value = 0.28;
    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.72 });
    this.composer.addPass(new EffectPass(camera, this.bloom, this.chroma));
    this.composer.addPass(new EffectPass(camera, this.bodycam, this.noise, this.vignette));
    addEventListener('resize', () => this.composer.setSize(innerWidth, innerHeight));
  }

  setCamera(camera: THREE.Camera) {
    this.renderPass.mainCamera = camera;
    this.composer.passes.forEach((p) => (p.mainCamera = camera));
  }

  swap() {
    this.staticBurst = 1;
    this.tearBurst = 1;
  }

  /** 1 = eyes shut; opens by itself */
  eyelids = 0;

  update(now: number, dt: number) {
    this.staticBurst = Math.max(0, this.staticBurst - dt * 0.9);
    this.tearBurst = Math.max(0, this.tearBurst - dt * 0.7);
    const insanity = 1 - this.sanity;
    const b = this.bodycam;
    b.u('time').value = now / 1000;
    b.u('staticAmt').value = Math.min(1, this.staticBurst * this.staticBurst * 0.95 + insanity * 0.03 + Math.random() * 0.012);
    b.u('tear').value = Math.min(1, this.tearBurst + insanity * insanity * 0.6 * (Math.random() < 0.1 ? 1 : 0.2));
    b.u('hollowTint').value = this.hollow * 0.55;
    b.u('desat').value = 0.22 + insanity * 0.4;
    // eyelids: black after a swap, then a few heavy blinks open
    this.eyelids = Math.max(0, this.eyelids - dt * 0.7);
    const lid = this.eyelids > 0 ? Math.min(1, this.eyelids * 1.5) * (0.8 + 0.2 * Math.abs(Math.sin(now / 140))) : 0;
    b.u('exposure').value = (1 + Math.sin(now / 900) * 0.02) * (1 - lid);
    const off = 0.0012 + insanity * 0.006 + this.staticBurst * 0.01;
    this.chroma.offset.set(off, off * 0.6);
    this.vignette.darkness = 0.7 + insanity * 0.25;
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
