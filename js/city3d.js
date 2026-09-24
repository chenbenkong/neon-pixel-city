import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { hash, rng, clamp, lerp, easeInOutCubic, makeCanvas, shade } from './util.js';
import { DISTRICTS, ADS, PIXEL_FONT } from './data.js';
import { pixelText, drawTiny, tinyWidth } from './pixel.js';

const N = 32, P = 34, LOT = 22, TILE = N * P;
const REGION = 360;
const FOG = 0.0043;
const mod = (a, n) => ((a % n) + n) % n;
export const regionDistrict = (x, z) => {
  const rx = Math.floor(x / REGION), rz = Math.floor(z / REGION);
  return mod(rx * 5 + rz * 3 + mod(rx * rz, 5), 6);
};

const GLSL_COMMON = /* glsl */ `
  uniform vec2 uCam;
  uniform float uTile;
  uniform float uTime;
  uniform float uBeat;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uPal[18];
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 wrapOff(vec2 c){ return floor((uCam - c) / uTile + 0.5) * uTile; }
  float districtIdx(vec2 w){ vec2 r = floor(w / ${REGION.toFixed(1)}); return mod(r.x * 5.0 + r.y * 3.0 + mod(r.x * r.y, 5.0), 6.0); }
  vec3 applyFog(vec3 col, vec3 wp){
    float d = length(wp - cameraPosition);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    float hf = exp(-max(wp.y, 0.0) * 0.012) * 0.25;
    return mix(col, uFogColor, clamp(f + hf * f, 0.0, 1.0));
  }
`;

const BUILDING_VS = /* glsl */ `
  ${GLSL_COMMON}
  varying vec3 vWorld; varying vec3 vLocal; varying vec3 vN; varying vec3 vScale; varying float vSeed; varying float vDist;
  void main(){
    vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vec2 c = instanceMatrix[3].xz;
    vec2 off = wrapOff(c);
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    wp.xz += off;
    vWorld = wp.xyz;
    vLocal = position * sc;
    vScale = sc;
    vN = normal;
    vSeed = h12(c * 0.1373 + sc.y * 0.011);
    vDist = districtIdx(c + off);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BUILDING_FS = /* glsl */ `
  ${GLSL_COMMON}
  varying vec3 vWorld; varying vec3 vLocal; varying vec3 vN; varying vec3 vScale; varying float vSeed; varying float vDist;
  vec3 pal(float k){ int i = int(vDist + 0.5) * 3 + int(mod(k, 3.0) + 0.001); return uPal[i]; }
  void main(){
    vec3 n = normalize(vN);
    float s = vSeed;
    vec3 base = mix(vec3(0.007, 0.006, 0.016), vec3(0.02, 0.014, 0.034), h12(vec2(s, 1.7)));
    vec3 neonA = pal(floor(s * 17.0));
    vec3 neonB = pal(floor(s * 17.0) + 1.0);
    vec3 col = base;
    if (abs(n.y) > 0.5) {
      vec2 e = vScale.xz * 0.5 - abs(vLocal.xz);
      float edge = min(e.x, e.y);
      col = base * 0.7;
      vec2 g = fract(vLocal.xz / 3.0);
      col += vec3(0.008, 0.006, 0.014) * step(0.85, max(g.x, g.y));
      col += neonA * 2.6 * smoothstep(0.4, 0.0, edge) * step(0.45, fract(s * 13.7));
    } else {
      bool xFace = abs(n.x) > 0.5;
      float u = xFace ? vLocal.z : vLocal.x;
      float fw = xFace ? vScale.z : vScale.x;
      float v = vLocal.y;
      float faceId = xFace ? n.x * 3.0 : n.z * 7.0;
      vec2 cs = vec2(1.25 + floor(fract(s * 5.3) * 3.0) * 0.3, 1.9);
      vec2 cell = vec2((u + fw * 0.5) / cs.x, v / cs.y);
      vec2 id = floor(cell);
      vec2 f = fract(cell);
      float win = step(0.14, f.x) * step(f.x, 0.86) * step(0.34, f.y) * step(f.y, 0.8);
      float litRatio = 0.12 + fract(s * 91.3) * 0.38;
      float hv = h12(id + vec2(s * 113.0, faceId));
      float floorLit = step(0.93, h12(vec2(id.y, s * 71.0 + faceId)));
      float lit = max(step(1.0 - litRatio, hv), floorLit);
      float fl = step(0.985, h12(id + floor(uTime * 3.0)));
      lit = max(lit - fl, 0.0);
      float kind = h12(id * 1.3 + s);
      vec3 wc = kind < 0.66 ? vec3(1.0, 0.62, 0.32) : kind < 0.82 ? neonA : kind < 0.9 ? neonB : vec3(0.6, 0.75, 1.0);
      wc *= 0.25 + 0.75 * h12(id + 3.1);
      float blur = clamp(length(fwidth(cell)) * 1.2 - 0.25, 0.0, 1.0);
      float w = mix(win * lit, litRatio * 0.22, blur);
      col *= 0.8 + 0.4 * step(0.5, fract((u + fw * 0.5) / 3.0));
      col += neonA * 0.05 * exp(-v * 0.06);
      col = mix(col, wc * (0.85 + uBeat * 0.2), w);
      col = mix(col, vec3(0.003, 0.004, 0.012), win * (1.0 - lit) * (1.0 - blur) * 0.7);
      // street-level storefronts
      float shop = step(v, 3.6) * step(0.8, v);
      float shopSeg = step(0.3, h12(vec2(floor((u + fw * 0.5) / 4.0), s * 7.0)));
      col = mix(col, neonB * 0.7 + 0.05, shop * shopSeg * (1.0 - blur * 0.7));
      col += neonA * 2.4 * step(3.6, v) * step(v, 3.85);
      // horizontal neon bands
      float bandOn = step(0.55, fract(s * 7.31));
      float period = 12.0 + floor(fract(s * 3.7) * 4.0) * 6.0;
      float bandY = mod(v, period);
      col += neonB * 2.4 * bandOn * (1.0 - smoothstep(0.0, 0.22, abs(bandY - period * 0.5))) * step(8.0, v);
      // corner edge lines
      float edge = fw * 0.5 - abs(u);
      float edgeOn = step(0.4, fract(s * 29.1));
      col += neonA * 2.0 * edgeOn * smoothstep(0.22, 0.0, edge) * (0.75 + 0.25 * sin(uTime * 2.0 + s * 30.0));
      // top rim
      col += neonA * 2.8 * step(0.5, fract(s * 41.9)) * smoothstep(0.6, 0.0, vScale.y - v);
      // vertical neon sign strip
      float stripOn = step(0.72, fract(s * 53.3));
      float sx = (fract(s * 61.0) - 0.5) * fw * 0.7;
      float strip = step(abs(u - sx), 0.55) * step(6.0, v) * step(v, min(vScale.y - 4.0, 30.0 + fract(s * 9.0) * 30.0));
      float glyph = step(0.35, h12(floor(vec2((u - sx) * 1.8, v * 1.1)) + s));
      float blink = step(0.08, fract(uTime * 0.13 + s * 5.0));
      col = mix(col, neonB * (0.7 + glyph * 1.2) * blink + 0.01, strip * stripOn);
    }
    col = applyFog(col, vWorld);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main(){
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    vec4 p = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FS = /* glsl */ `
  uniform vec3 uFogColor; uniform vec3 uTop; uniform vec3 uGlow; uniform float uTime; uniform float uFlash;
  varying vec3 vDir;
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    vec3 d = normalize(vDir);
    float e = d.y;
    vec3 col = mix(uFogColor, uTop, smoothstep(0.0, 0.55, e));
    col += uGlow * exp(-max(e, 0.0) * 7.0) * 0.45 * smoothstep(0.0, 0.08, e);
    vec2 sp = floor(vec2(atan(d.z, d.x) * 180.0, e * 280.0));
    float st = step(0.996, h12(sp)) * smoothstep(0.12, 0.5, e);
    col += vec3(0.9, 0.85, 1.0) * st * (0.5 + 0.5 * sin(uTime * 2.0 + h12(sp + 7.0) * 30.0));
    vec3 md = normalize(vec3(-0.55, 0.32, -0.78));
    float m = dot(d, md);
    float disc = smoothstep(0.9982, 0.9986, m);
    float crater = step(0.62, h12(floor((d.xy - md.xy) * 900.0))) * 0.18;
    col = mix(col, vec3(1.0, 0.86, 0.95) * (0.95 - crater), disc);
    col += vec3(1.0, 0.4, 0.8) * pow(max(m, 0.0), 260.0) * 0.22;
    col += vec3(0.7, 0.6, 1.0) * uFlash * (0.4 + 0.6 * smoothstep(0.0, 0.5, e));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const GROUND_SHADER = {
  name: 'NeonGround',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uTime: { value: 0 }, uFogColor: { value: new THREE.Color() }, uFogDensity: { value: FOG }, uCamY: { value: 50 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv; varying vec3 vWorld;
    void main(){
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec3 uFogColor; uniform float uFogDensity;
    varying vec4 vUv; varying vec3 vWorld;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y); }
    void main(){
      vec2 w = vWorld.xz;
      float puddle = smoothstep(0.45, 0.7, noise(w * 0.06));
      vec2 rip = vec2(noise(w * 0.9 + uTime * 1.5), noise(w * 0.9 - uTime * 1.3)) - 0.5;
      vec4 uv = vUv;
      uv.xy += rip * uv.w * (0.014 - puddle * 0.01);
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;
      vec2 m = mod(w, ${P.toFixed(1)});
      float sx = step(${LOT.toFixed(1)}, m.x), sz = step(${LOT.toFixed(1)}, m.y);
      float street = max(sx, sz);
      vec3 col = mix(vec3(0.03, 0.028, 0.05), vec3(0.015, 0.012, 0.028), street);
      col += refl * mix(0.3, 0.8, puddle);
      float mid = ${(LOT + (P - LOT) / 2).toFixed(1)};
      float lx = smoothstep(0.14, 0.0, abs(m.x - mid)) * sx * (1.0 - sz) * step(0.5, fract(w.y * 0.12));
      float lz = smoothstep(0.14, 0.0, abs(m.y - mid)) * sz * (1.0 - sx) * step(0.5, fract(w.x * 0.12));
      col += vec3(1.0, 0.75, 0.3) * (lx + lz) * 0.9;
      float cx = min(abs(m.x - ${LOT.toFixed(1)}), abs(m.x - ${P.toFixed(1)}));
      float cz = min(abs(m.y - ${LOT.toFixed(1)}), abs(m.y - ${P.toFixed(1)}));
      float curb = smoothstep(0.18, 0.0, min(cx + sz * 99.0, cz + sx * 99.0));
      vec2 blk = floor(w / ${P.toFixed(1)});
      vec3 cc = h12(blk) < 0.5 ? vec3(1.0, 0.1, 0.8) : vec3(0.1, 0.9, 1.0);
      col += cc * curb * 1.4;
      float cross = sx * sz * step(0.5, fract((m.x + m.y) * 0.5)) * 0.06;
      col += vec3(cross);
      float d = length(vWorld - cameraPosition);
      float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
      col = mix(col, uFogColor, f);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const FINAL_SHADER = {
  uniforms: { tDiffuse: { value: null }, uAberr: { value: 0.006 }, uTime: { value: 0 }, uFlash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uAberr; uniform float uTime; uniform float uFlash;
    varying vec2 vUv;
    float b2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
    float bayer(vec2 a){ return b2(0.5 * a) * 0.25 + b2(a); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 o = d * uAberr * (0.5 + r2 * 4.0);
      vec3 c = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b);
      c += vec3(0.015, 0.0, 0.03) * (1.0 - c);
      float lv = 22.0;
      c = floor(c * lv + (bayer(gl_FragCoord.xy) - 0.5) + 0.5) / lv;
      c *= 1.0 - r2 * 1.1;
      c += uFlash * vec3(0.7, 0.8, 1.0);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export class City3D {
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.audio = audio;
    this.px = 3;
    this.time = 0;
    this.flash = 0;
    this.intro = 1;
    this.shake = 0;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.fogColor = new THREE.Color('#361243');
    this.scene.fog = new THREE.FogExp2(this.fogColor.getHex(), FOG);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 3000);
    this.camera.position.set(0, 60, 0);

    const pal = [];
    for (const d of DISTRICTS) for (const k of ['a', 'b', 'c']) pal.push(new THREE.Color(d[k]));
    this.U = {
      uCam: { value: new THREE.Vector2() }, uTile: { value: TILE }, uTime: { value: 0 }, uBeat: { value: 0 },
      uFogColor: { value: this.fogColor }, uFogDensity: { value: FOG }, uPal: { value: pal },
    };

    this.buildCity();
    this.buildGround();
    this.buildSky();
    this.buildRain();
    this.buildTraffic();
    this.buildBillboards();
    this.buildLandmarks();
    this.buildCar();
    this.buildDust();
    this.scene.add(new THREE.HemisphereLight(0x8a5cff, 0xff2bd6, 1.3));
    const moon = new THREE.DirectionalLight(0xbfd0ff, 1.2);
    moon.position.set(-0.55, 0.6, -0.78);
    this.scene.add(moon);

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(1);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.42, 0.55);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.composer.addPass(this.finalPass);
    this.fpsAcc = 0; this.fpsN = 0;
    this.resize();
  }

  // ---------------- city ----------------
  buildCity() {
    const blds = [];
    this.blocks = Array.from({ length: N * N }, () => []);
    const centers = [[0.28, 0.33, 1], [0.7, 0.68, 0.9], [0.18, 0.8, 0.6], [0.8, 0.2, 0.55]];
    this.plazas = [];
    this.megas = [];
    for (let bi = 0; bi < N; bi++) {
      for (let bj = 0; bj < N; bj++) {
        const r = rng(hash(bi, bj, 42));
        const u = (bi + 0.5) / N, v = (bj + 0.5) / N;
        let dt = 0;
        for (const [cx, cz, s] of centers) {
          let dx = Math.abs(u - cx), dz = Math.abs(v - cz);
          dx = Math.min(dx, 1 - dx); dz = Math.min(dz, 1 - dz);
          dt = Math.max(dt, Math.exp(-(dx * dx + dz * dz) / 0.018) * s);
        }
        const x0 = bi * P, z0 = bj * P;
        const add = (cx, cz, w, d, h) => {
          const b = { x: cx, z: cz, w, d, h };
          blds.push(b);
          this.blocks[bi * N + bj].push(b);
          return b;
        };
        if (r() < 0.04) { this.plazas.push({ x: x0 + LOT / 2, z: z0 + LOT / 2 }); continue; }
        if (r() < 0.01 + dt * 0.05) {
          const h = 210 + r() * 140;
          add(x0 + LOT / 2, z0 + LOT / 2, LOT - 1, LOT - 1, h * 0.55);
          add(x0 + LOT / 2, z0 + LOT / 2, LOT * 0.7, LOT * 0.7, h * 0.85);
          const top = add(x0 + LOT / 2, z0 + LOT / 2, LOT * 0.4, LOT * 0.4, h);
          this.megas.push(top);
          continue;
        }
        const split = r();
        const subs = [];
        if (split < 0.3) subs.push([x0 + 0.8, z0 + 0.8, LOT - 1.6, LOT - 1.6]);
        else if (split < 0.62) {
          const k = 0.35 + r() * 0.3;
          if (r() < 0.5) { subs.push([x0 + 0.8, z0 + 0.8, LOT * k - 1.2, LOT - 1.6]); subs.push([x0 + LOT * k + 0.4, z0 + 0.8, LOT * (1 - k) - 1.2, LOT - 1.6]); }
          else { subs.push([x0 + 0.8, z0 + 0.8, LOT - 1.6, LOT * k - 1.2]); subs.push([x0 + 0.8, z0 + LOT * k + 0.4, LOT - 1.6, LOT * (1 - k) - 1.2]); }
        } else {
          const hw = LOT / 2;
          for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) subs.push([x0 + a * hw + 0.6, z0 + b * hw + 0.6, hw - 1.2, hw - 1.2]);
        }
        for (const [sx, sz, sw, sd] of subs) {
          const shrinkX = r() * Math.min(3, sw * 0.2), shrinkZ = r() * Math.min(3, sd * 0.2);
          const w = sw - shrinkX, d = sd - shrinkZ;
          let h = 7 + Math.pow(r(), 2.2) * 38 + dt * (30 + r() * 150);
          if (r() < 0.07) h *= 1.7;
          const cx = sx + sw / 2 + (r() - 0.5) * shrinkX, cz = sz + sd / 2 + (r() - 0.5) * shrinkZ;
          add(cx, cz, w, d, h);
          if (w > 8 && d > 8 && r() < 0.35) add(cx, cz, w * (0.45 + r() * 0.25), d * (0.45 + r() * 0.25), h + 8 + r() * 40);
        }
      }
    }
    this.buildings = blds;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({ uniforms: this.U, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });
    const mesh = new THREE.InstancedMesh(geo, mat, blds.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    blds.forEach((b, i) => { p.set(b.x, 0, b.z); s.set(b.w, b.h, b.d); m.compose(p, q, s); mesh.setMatrixAt(i, m); });
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.cityMesh = mesh;
  }

  heightAt(x, z, margin = 1.2) {
    const px = mod(x, TILE), pz = mod(z, TILE);
    const ox = x - px, oz = z - pz;
    const bi = Math.floor(px / P), bj = Math.floor(pz / P);
    let hit = null;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const ii = mod(bi + di, N), jj = mod(bj + dj, N);
      const shiftX = (bi + di < 0 ? -TILE : bi + di >= N ? TILE : 0), shiftZ = (bj + dj < 0 ? -TILE : bj + dj >= N ? TILE : 0);
      for (const b of this.blocks[ii * N + jj]) {
        const bx = b.x + shiftX + ox, bz = b.z + shiftZ + oz;
        if (Math.abs(x - bx) < b.w / 2 + margin && Math.abs(z - bz) < b.d / 2 + margin) {
          if (!hit || b.h > hit.h) hit = { h: b.h, x: bx, z: bz, w: b.w, d: b.d };
        }
      }
    }
    return hit;
  }

  buildGround() {
    const geo = new THREE.PlaneGeometry(2600, 2600);
    const g = new Reflector(geo, { textureWidth: 256, textureHeight: 256, clipBias: 0.003, multisample: 0, shader: GROUND_SHADER });
    g.rotation.x = -Math.PI / 2;
    g.material.uniforms.uFogColor.value = this.fogColor;
    this.scene.add(g);
    this.ground = g;
  }

  buildSky() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uFogColor: { value: this.fogColor }, uTop: { value: new THREE.Color('#05020d') }, uGlow: { value: new THREE.Color('#ff3aa0') }, uTime: this.U.uTime, uFlash: { value: 0 } },
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  buildRain() {
    const n = 4200;
    const drop = new Float32Array(n * 2 * 4), end = new Float32Array(n * 2), pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), s = Math.random();
      for (let k = 0; k < 2; k++) { drop.set([x, y, z, s], (i * 2 + k) * 4); end[i * 2 + k] = k; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDrop', new THREE.BufferAttribute(drop, 4));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.U.uTime, uCam3: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam3; uniform vec3 uVel;
        attribute vec4 aDrop; attribute float aEnd; varying float vA;
        void main(){
          float S = 140.0;
          vec3 p = aDrop.xyz * S;
          p.y -= uTime * (55.0 + aDrop.w * 35.0);
          p.x += uTime * 6.0;
          p = mod(p - uCam3 + S * 0.5, S) + uCam3 - S * 0.5;
          vec3 streak = vec3(0.35, -2.2, 0.0) - uVel * 0.045;
          p += streak * aEnd;
          vA = mix(0.0, 1.0, aEnd) * 0.5 + 0.25;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(vec3(0.55, 0.65, 1.0) * vA * 0.45, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  buildTraffic() {
    const lanes = [];
    const r = rng(hash(7, 7, 7));
    const alts = [9, 16, 26, 38, 55, 75, 100, 130];
    for (let k = 0; k < 64; k++) {
      const axis = r() < 0.5 ? 0 : 1;
      const street = Math.floor(r() * N);
      const alt = alts[Math.floor(r() * alts.length)] + r() * 3;
      for (const dir of [-1, 1]) lanes.push({ axis, cross: street * P + LOT + (P - LOT) / 2 + dir * 2.8, alt: alt + (dir > 0 ? 2.5 : 0), speed: dir * (26 + r() * 22), cars: 3 + Math.floor(r() * 5) });
    }
    let count = 0;
    for (const l of lanes) count += l.cars;
    const aLane = new Float32Array(count * 4), aPhase = new Float32Array(count), aColor = new Float32Array(count * 3);
    const cols = [[1, 0.2, 0.85], [0.2, 0.95, 1], [1, 0.75, 0.2], [0.75, 0.4, 1]];
    let i = 0;
    for (const l of lanes) for (let c = 0; c < l.cars; c++) {
      aLane.set([l.axis, l.cross, l.alt, l.speed * (0.9 + r() * 0.2)], i * 4);
      aPhase[i] = r() * TILE;
      aColor.set(cols[Math.floor(r() * cols.length)], i * 3);
      i++;
    }
    const vs = (trail) => /* glsl */ `
      ${GLSL_COMMON}
      attribute vec4 aLane; attribute float aPhase; attribute vec3 aColor;
      varying vec3 vCol; varying float vLz; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        float dir = sign(aLane.w);
        float along = mod(aPhase + aLane.w * uTime, uTile);
        vec2 b = aLane.x < 0.5 ? vec2(along, aLane.y) : vec2(aLane.y, along);
        b += wrapOff(b);
        vec3 lp = position; lp.z *= dir; vec3 nn = normal; nn.z *= dir;
        vec3 wp = aLane.x < 0.5 ? vec3(lp.z, lp.y, lp.x) : lp;
        vNrm = aLane.x < 0.5 ? vec3(nn.z, nn.y, nn.x) : nn;
        wp += vec3(b.x, aLane.z + sin(uTime * 0.7 + aPhase) * 0.25, b.y);
        vLz = position.z; vCol = aColor; vWorld = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`;
    const geo = new THREE.BoxGeometry(1.5, 0.55, 3.4);
    const add = (g) => {
      g.setAttribute('aLane', new THREE.InstancedBufferAttribute(aLane, 4));
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
      g.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    };
    add(geo);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.U,
      vertexShader: vs(false),
      fragmentShader: /* glsl */ `
        ${GLSL_COMMON}
        varying vec3 vCol; varying float vLz; varying vec3 vWorld; varying vec3 vNrm;
        void main(){
          vec3 c = vec3(0.035, 0.035, 0.06);
          if (vLz > 1.62) c = vec3(3.2, 3.0, 2.6);
          else if (vLz < -1.62) c = vec3(3.5, 0.2, 0.35);
          else if (vNrm.y < -0.5) c = vCol * 2.5;
          else if (vNrm.y > 0.5 && abs(vLz) < 0.8) c = vec3(0.1, 0.4, 0.6);
          else c += vCol * 0.9 * step(abs(vWorld.y - floor(vWorld.y) - 0.5), 0.08);
          gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
        }`,
    });
    const cars = new THREE.InstancedMesh(geo, mat, count);
    cars.frustumCulled = false;
    this.scene.add(cars);
    const tgeo = new THREE.BoxGeometry(0.25, 0.12, 16);
    tgeo.translate(0, 0, -9.7);
    add(tgeo);
    const tmat = new THREE.ShaderMaterial({
      uniforms: this.U,
      vertexShader: vs(true),
      fragmentShader: /* glsl */ `
        ${GLSL_COMMON}
        varying vec3 vCol; varying float vLz; varying vec3 vWorld; varying vec3 vNrm;
        void main(){
          float k = clamp((vLz + 17.7) / 16.0, 0.0, 1.0);
          vec3 c = mix(vCol, vec3(1.0, 0.15, 0.3), 0.5) * k * k * 1.6;
          float d = length(vWorld - cameraPosition);
          float f = exp(-uFogDensity * uFogDensity * d * d);
          gl_FragColor = vec4(c * f, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const trails = new THREE.InstancedMesh(tgeo, tmat, count);
    trails.frustumCulled = false;
    this.scene.add(trails);
  }

  adTexture(ad, vertical) {
    const w = vertical ? 48 : 96, h = vertical ? 96 : 48;
    const c = makeCanvas(w, h), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, shade(ad.c1, -0.1)); g.addColorStop(1, '#14041f');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.08)';
    for (let y = 0; y < h; y += 3) x.fillRect(0, y, w, 1);
    if (vertical) {
      Array.from(ad.t1).forEach((ch, i) => { const t = pixelText(ch, '#ffffff'); x.drawImage(t, (w - t.width) >> 1, 6 + i * 15); });
      x.save(); x.translate(w - 8, h - 4); x.rotate(-Math.PI / 2); drawTiny(x, ad.t2, 0, 0, ad.c2); x.restore();
    } else {
      const t = pixelText(ad.t1, '#ffffff');
      x.drawImage(t, (w - t.width) >> 1, 8);
      drawTiny(x, ad.t2, (w - tinyWidth(ad.t2, 2)) >> 1, 28, ad.c2, 2);
    }
    x.fillStyle = ad.c2;
    x.fillRect(0, 0, w, 2); x.fillRect(0, h - 2, w, 2); x.fillRect(0, 0, 2, h); x.fillRect(w - 2, 0, 2, h);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildBillboards() {
    const texV = ADS.map((a) => this.adTexture(a, true));
    const texH = ADS.map((a) => this.adTexture(a, false));
    const r = rng(hash(3, 1, 4));
    const cands = this.buildings.filter((b) => b.h > 28 && b.w > 7 && b.d > 7);
    const vs = /* glsl */ `
      ${GLSL_COMMON}
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        wp.xz += wrapOff(modelMatrix[3].xz);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`;
    const fs = /* glsl */ `
      ${GLSL_COMMON}
      uniform sampler2D map; uniform float uSeed;
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        vec2 uv = vUv;
        float gl = step(0.97, h12(vec2(floor(uTime * 12.0), uSeed)));
        uv.x += gl * (h12(vec2(floor(uv.y * 20.0), uTime)) - 0.5) * 0.2;
        vec3 c = texture2D(map, uv).rgb;
        float scan = 0.8 + 0.2 * sin(vUv.y * 180.0 - uTime * 8.0);
        float bar = smoothstep(0.04, 0.0, abs(fract(vUv.y - uTime * 0.25 + uSeed) - 0.5)) * 0.6;
        float fl = step(0.03, fract(uTime * 0.21 + uSeed * 3.0)) * 0.85 + 0.15;
        c = c * scan * (2.1 + uBeat * 0.6) * fl + bar * c;
        gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
      }`;
    this.boards = [];
    for (let i = 0; i < 110 && cands.length; i++) {
      const b = cands[Math.floor(r() * cands.length)];
      const vertical = r() < 0.55;
      const ai = Math.floor(r() * ADS.length);
      const W = vertical ? 5 + r() * 3 : 12 + r() * 6, H = vertical ? W * 2 : W / 2;
      const face = Math.floor(r() * 4);
      const y = 8 + H / 2 + r() * Math.max(1, b.h - H - 14);
      const mat = new THREE.ShaderMaterial({ uniforms: { ...this.U, map: { value: vertical ? texV[ai] : texH[ai] }, uSeed: { value: r() } }, vertexShader: vs, fragmentShader: fs, side: THREE.DoubleSide });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      const nx = [1, -1, 0, 0][face], nz = [0, 0, 1, -1][face];
      m.position.set(b.x + nx * (b.w / 2 + 0.35), y, b.z + nz * (b.d / 2 + 0.35));
      m.rotation.y = Math.atan2(nx, nz);
      m.frustumCulled = false;
      this.scene.add(m);
    }
  }

  buildLandmarks() {
    this.landmarks = [];
    const add = (obj, x, z) => { this.scene.add(obj); this.landmarks.push({ obj, x, z }); };
    const addMat = (hex, k = 2.5, op = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    // halo rings around mega towers
    this.rings = [];
    this.megas.slice(0, 6).forEach((b, i) => {
      const g = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(b.w * 1.1 + k * 4, 0.35, 6, 48), addMat(k % 2 ? '#29f0ff' : '#ff2bd6', 3, 0.9));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = b.h * (0.6 + k * 0.13);
        g.add(ring);
        this.rings.push({ m: ring, sp: (k % 2 ? 1 : -1) * (0.2 + k * 0.1), base: ring.position.y });
      }
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 26, 0.8), addMat('#ff3050', 4));
      beacon.position.y = b.h + 13;
      g.add(beacon);
      g.position.set(b.x, 0, b.z);
      add(g, b.x, b.z);
    });
    // giant holograms over plazas
    this.holos = [];
    const plazas = this.plazas.slice(0, 5);
    plazas.forEach((p, i) => {
      const g = new THREE.Group();
      const geo = i % 2 ? new THREE.OctahedronGeometry(14, 0) : new THREE.IcosahedronGeometry(13, 1);
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: new THREE.Color(i % 2 ? '#ffd166' : '#29f0ff').multiplyScalar(2.5), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(4, 0), addMat('#ff2bd6', 3));
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(5, 9, 60, 20, 1, true), addMat('#29f0ff', 0.5, 0.35));
      beam.position.y = -30;
      const holo = new THREE.Group();
      holo.add(wire, core);
      holo.position.y = 60;
      beam.position.y = 30;
      g.add(holo, beam);
      g.position.set(p.x, 0, p.z);
      add(g, p.x, p.z);
      this.holos.push({ holo, wire, core, seed: i });
    });
    // holographic koi circling the tallest tower
    const host = this.megas[0] || { x: TILE / 2, z: TILE / 2, h: 200, w: 10 };
    this.koi = { segs: [], x: host.x, z: host.z, h: host.h * 0.7, r: host.w + 32 };
    const kg = new THREE.Group();
    for (let k = 0; k < 26; k++) {
      const s = k < 4 ? 2.6 + k * 0.3 : Math.max(0.5, 3.8 - (k - 4) * 0.16);
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), addMat(k < 1 ? '#ffffff' : k % 3 ? '#ff5ea8' : '#ffb020', 2.2, 0.55));
      kg.add(m);
      this.koi.segs.push(m);
    }
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), addMat('#ff5ea8', 2, 0.4));
      fin.material.side = THREE.DoubleSide;
      kg.add(fin);
      this.koi.segs.push({ fin, side, m: fin });
    }
    add(kg, host.x, host.z);
    this.koi.group = kg;
    // searchlights
    this.beams = [];
    const bm = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#c8b8ff') } },
      vertexShader: `varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vY; void main(){ gl_FragColor = vec4(uColor * pow(1.0 - vY, 2.0) * 0.3, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const tall = [...this.buildings].sort((a, b) => b.h - a.h).filter((_, i) => i % 3 === 0).slice(0, 12);
    tall.forEach((b, i) => {
      const geo = new THREE.CylinderGeometry(9, 0.4, 320, 16, 1, true);
      geo.translate(0, 160, 0);
      const m = new THREE.Mesh(geo, bm);
      const g = new THREE.Group();
      g.add(m);
      g.position.set(b.x, b.h, b.z);
      add(g, b.x, b.z);
      this.beams.push({ m, seed: i * 1.7 });
    });
  }

  buildCar() {
    const car = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: 0x3a3452, metalness: 0.45, roughness: 0.3, emissive: 0x120820 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0a12, metalness: 0.3, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x050b14, emissive: 0x0a6f88, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.2 });
    const neon = (hex, k = 4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) });
    const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); car.add(b); return b; };
    box(2.3, 0.6, 4.8, body, 0, 0, 0);
    box(2.0, 0.35, 3.2, body, 0, 0.45, -0.3);
    box(1.6, 0.5, 1.9, glass, 0, 0.8, -0.2);
    box(2.5, 0.25, 1.1, dark, 0, 0.1, -2.1);
    box(0.08, 0.1, 4.4, neon('#ff2bd6'), 1.18, -0.05, 0);
    box(0.08, 0.1, 4.4, neon('#ff2bd6'), -1.18, -0.05, 0);
    box(2.4, 0.16, 0.1, neon('#ff2040', 6), 0, 0.12, -2.72);
    box(0.12, 0.3, 0.1, neon('#ff2bd6', 5), 1.1, 0.25, -2.7);
    box(0.12, 0.3, 0.1, neon('#ff2bd6', 5), -1.1, 0.25, -2.7);
    box(0.5, 0.14, 0.08, neon('#fff4dc', 5), 0.75, 0.05, 2.42);
    box(0.5, 0.14, 0.08, neon('#fff4dc', 5), -0.75, 0.05, 2.42);
    box(1.6, 0.06, 0.06, neon('#29f0ff', 3), 0, 0.62, 1.1);
    this.thrusters = [];
    for (const [x, z] of [[1.1, 1.7], [-1.1, 1.7], [1.1, -1.7], [-1.1, -1.7]]) {
      box(0.7, 0.35, 0.7, dark, x, -0.35, z);
      const t = box(0.5, 0.06, 0.5, neon('#29f0ff', 4), x, -0.54, z);
      this.thrusters.push(t);
    }
    const c = makeCanvas(64, 64), x = c.getContext('2d');
    const rg = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,60,200,1)'); rg.addColorStop(0.5, 'rgba(255,40,180,0.35)'); rg.addColorStop(1, 'rgba(255,40,180,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(c);
    this.underglow = new THREE.Mesh(new THREE.PlaneGeometry(9, 11), new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color(0.8, 0.8, 0.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.underglow.rotation.x = -Math.PI / 2;
    this.scene.add(this.underglow);
    const hc = makeCanvas(32, 128), hx = hc.getContext('2d');
    const lg = hx.createLinearGradient(0, 128, 0, 0);
    lg.addColorStop(0, 'rgba(255,245,220,0.55)'); lg.addColorStop(1, 'rgba(255,245,220,0)');
    hx.fillStyle = lg; hx.fillRect(0, 0, 32, 128);
    const beamTex = new THREE.CanvasTexture(hc);
    for (const sx of [-0.75, 0.75]) {
      const hb = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 22), new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      hb.rotation.x = -Math.PI / 2;
      hb.position.set(sx, 0, 13.4);
      car.add(hb);
    }
    this.car = car;
    this.scene.add(car);
    this.st = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, speed: 0, bank: 0, pitch: 0, vy: 0, boost: 0 };
    this.cam = { yawOff: 0, pitchOff: 0.12, dist: 13, pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.resetCar();
  }

  resetCar() {
    const host = this.megas[0] || { x: TILE / 2, z: TILE / 2 };
    const bi = Math.floor(host.x / P) + 3, bj = Math.floor(host.z / P);
    this.st.pos.set(bi * P + LOT + (P - LOT) / 2, 72, bj * P - 60);
    this.st.yaw = 0;
    this.st.speed = 26;
    this.st.vel.set(0, 0, 26);
  }

  buildDust() {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.U.uTime, uCam3: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam3; varying float vK;
        void main(){
          float S = 90.0;
          vec3 p = position * S + vec3(sin(uTime * 0.3 + position.y * 20.0) * 2.0, uTime * 0.8, 0.0);
          p = mod(p - uCam3 + S * 0.5, S) + uCam3 - S * 0.5;
          vK = fract(position.x * 37.0);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(40.0 / -mv.z, 1.0, 3.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vK; void main(){ vec3 c = vK < 0.5 ? vec3(1.0, 0.3, 0.8) : vec3(0.3, 0.9, 1.0); gl_FragColor = vec4(c * 0.8, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  // ---------------- lifecycle ----------------
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const rw = Math.max(160, Math.ceil(w / this.px)), rh = Math.max(90, Math.ceil(h / this.px));
    this.renderer.setSize(rw, rh, false);
    this.composer.setSize(rw, rh);
    this.bloom.resolution.set(rw, rh);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.ground.getRenderTarget().setSize(Math.ceil(rw * 0.75), Math.ceil(rh * 0.75));
  }

  enter() {
    this.intro = 0;
    const s = this.st;
    this.introFrom = s.pos.clone().add(new THREE.Vector3(-60, 210, -120));
    this.introLook = s.pos.clone().add(new THREE.Vector3(0, 0, 80));
    this.cam.pos.copy(this.introFrom);
  }

  getInfo() {
    const s = this.st;
    const d = DISTRICTS[regionDistrict(s.pos.x, s.pos.z)];
    const hdg = ((((-s.yaw * 180) / Math.PI) % 360) + 360) % 360;
    return {
      zh: d.zh, en: d.en, color: d.a,
      tele: [`ALT ${String(Math.round(s.pos.y)).padStart(3, '0')} M`, `SPD ${String(Math.round(s.vel.length() * 3.6)).padStart(3, '0')} KM/H`, `HDG ${String(Math.round(hdg)).padStart(3, '0')}°`],
    };
  }

  update(dt, input) {
    this.time += dt;
    const t = this.time;
    this.U.uTime.value = t;
    this.U.uBeat.value = this.audio.getBeat();
    const s = this.st;
    if (this.intro < 1) this.intro = Math.min(1, this.intro + dt / 2.6);
    const ctl = this.intro > 0.55 ? 1 : 0;

    const thr = ((input.down('KeyW', 'ArrowUp') ? 1 : 0) - (input.down('KeyS', 'ArrowDown') ? 1 : 0) - input.joy.y) * ctl;
    const steer = ((input.down('KeyD', 'ArrowRight') ? 1 : 0) - (input.down('KeyA', 'ArrowLeft') ? 1 : 0) + input.joy.x) * ctl;
    const lift = ((input.down('Space', 'KeyE') || input.btn.up ? 1 : 0) - (input.down('KeyQ', 'KeyC', 'ControlLeft') || input.btn.down ? 1 : 0)) * ctl;
    const boost = (input.down('ShiftLeft', 'ShiftRight') || input.btn.boost) && ctl;
    const maxSp = boost ? 130 : 62;
    const tgt = thr > 0.1 ? maxSp * Math.min(1, thr) : thr < -0.1 ? -20 : s.speed * 0.985;
    s.speed += (tgt - s.speed) * Math.min(1, dt * (thr < -0.1 ? 2.2 : boost ? 1.6 : 1.1));
    s.boost += ((boost && thr > 0 ? 1 : 0) - s.boost) * Math.min(1, dt * 4);
    const turnK = clamp(1.8 - Math.abs(s.speed) / 120, 0.9, 1.8);
    s.yaw -= clamp(steer, -1, 1) * turnK * dt;
    s.bank += (clamp(steer, -1, 1) * 0.55 * Math.min(1, Math.abs(s.speed) / 30 + 0.3) - s.bank) * Math.min(1, dt * 5);
    s.vy += (lift * 26 - s.vy) * Math.min(1, dt * 3);
    s.pitch += (-s.vy * 0.012 - s.pitch) * Math.min(1, dt * 4);
    const fwd = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const want = fwd.clone().multiplyScalar(s.speed);
    s.vel.x += (want.x - s.vel.x) * Math.min(1, dt * 2.6);
    s.vel.z += (want.z - s.vel.z) * Math.min(1, dt * 2.6);
    s.vel.y = s.vy;
    s.pos.addScaledVector(s.vel, dt);
    if (s.pos.y < 3) { s.pos.y = 3; s.vy = Math.max(0, s.vy); }
    if (s.pos.y > 360) { s.pos.y = 360; s.vy = Math.min(0, s.vy); }
    // collisions
    const hit = this.heightAt(s.pos.x, s.pos.z, 1.6);
    if (hit && s.pos.y < hit.h + 1.2) {
      if (s.pos.y > hit.h - 2.5) { s.pos.y = hit.h + 1.2; s.vy = Math.max(0, s.vy); }
      else {
        const dx = s.pos.x - hit.x, dz = s.pos.z - hit.z;
        const px = hit.w / 2 + 1.6 - Math.abs(dx), pz = hit.d / 2 + 1.6 - Math.abs(dz);
        if (px < pz) { s.pos.x += Math.sign(dx) * px; s.vel.x *= -0.3; }
        else { s.pos.z += Math.sign(dz) * pz; s.vel.z *= -0.3; }
        if (Math.abs(s.speed) > 15) { this.shake = Math.min(1, this.shake + Math.abs(s.speed) / 80); this.audio.land(1.5); }
        s.speed *= 0.45;
      }
    }
    // vehicle transform
    this.car.position.copy(s.pos);
    this.car.position.y += Math.sin(t * 2.2) * 0.12;
    this.car.rotation.set(0, 0, 0);
    this.car.rotateY(s.yaw);
    this.car.rotateX(s.pitch);
    this.car.rotateZ(s.bank);
    const floor = hit && hit.h < s.pos.y ? hit.h : 0;
    this.underglow.position.set(s.pos.x, floor + 0.08, s.pos.z);
    const hgt = s.pos.y - floor;
    this.underglow.material.opacity = clamp(1.3 - hgt / 30, 0, 1);
    this.underglow.scale.setScalar(1 + hgt / 25);
    this.underglow.rotation.z = s.yaw;
    const tk = 2.5 + s.boost * 5 + Math.sin(t * 40) * 0.5;
    for (const th of this.thrusters) th.material.color.setRGB(0.16 * tk, 0.94 * tk, 1.0 * tk);

    // camera
    const c = this.cam;
    if (input.drag.active || input.drag.dx || input.drag.dy) {
      c.yawOff -= input.drag.dx * 0.005;
      c.pitchOff = clamp(c.pitchOff + input.drag.dy * 0.004, -0.25, 1.2);
      this.dragIdle = 0;
    } else {
      this.dragIdle = (this.dragIdle || 0) + dt;
      if (this.dragIdle > 1.5) { c.yawOff *= Math.pow(0.2, dt); c.pitchOff += (0.12 - c.pitchOff) * Math.min(1, dt * 0.8); }
    }
    c.dist = clamp(c.dist + input.wheel * 0.01, 7, 40);
    const dist = c.dist + s.boost * 3 + Math.abs(s.speed) * 0.03;
    const cy = s.yaw + c.yawOff + Math.PI;
    const chase = new THREE.Vector3(
      s.pos.x + Math.sin(cy) * dist * Math.cos(c.pitchOff),
      s.pos.y + 3 + Math.sin(c.pitchOff) * dist,
      s.pos.z + Math.cos(cy) * dist * Math.cos(c.pitchOff),
    );
    for (let k = 1; k <= 8; k++) {
      const f = k / 8;
      const px = lerp(s.pos.x, chase.x, f), py = lerp(s.pos.y, chase.y, f), pz = lerp(s.pos.z, chase.z, f);
      const hh = this.heightAt(px, pz, 0.6);
      if (hh && py < hh.h + 0.8) {
        const back = Math.max(0.15, (k - 1) / 8);
        chase.set(lerp(s.pos.x, chase.x, back), Math.max(lerp(s.pos.y, chase.y, back), s.pos.y + 1.5), lerp(s.pos.z, chase.z, back));
        break;
      }
    }
    const look = s.pos.clone().addScaledVector(fwd, 6 + Math.abs(s.speed) * 0.08);
    look.y += 1.2;
    if (this.intro < 1) {
      const e = easeInOutCubic(this.intro);
      c.pos.lerpVectors(this.introFrom, chase, e);
      c.look.lerpVectors(this.introLook, look, e);
    } else {
      c.pos.lerp(chase, Math.min(1, dt * 5));
      const ch = this.heightAt(c.pos.x, c.pos.z, 0.4);
      if (ch && c.pos.y < ch.h + 0.8) c.pos.lerp(chase, 0.6);
      c.look.lerp(look, Math.min(1, dt * 8));
    }
    this.camera.position.copy(c.pos);
    this.shake = Math.max(0, this.shake - dt * 2);
    const sh = this.shake * 0.6 + s.boost * 0.08;
    if (sh > 0) this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh));
    this.camera.lookAt(c.look);
    this.camera.rotateZ(-s.bank * 0.25);
    const fov = 68 + Math.min(1, Math.abs(s.speed) / 130) * 14 + s.boost * 8 + (1 - easeInOutCubic(this.intro)) * 10;
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // world-follow objects
    const cp = this.camera.position;
    this.U.uCam.value.set(cp.x, cp.z);
    this.sky.position.copy(cp);
    this.ground.position.set(Math.round(cp.x / P) * P, 0, Math.round(cp.z / P) * P);
    this.rain.material.uniforms.uCam3.value.copy(cp);
    this.rain.material.uniforms.uVel.value.copy(s.vel);
    this.dust.material.uniforms.uCam3.value.copy(cp);
    this.ground.material.uniforms.uTime.value = t;
    for (const L of this.landmarks) {
      L.obj.position.x = L.x + Math.round((cp.x - L.x) / TILE) * TILE;
      L.obj.position.z = L.z + Math.round((cp.z - L.z) / TILE) * TILE;
    }
    for (const r of this.rings) { r.m.rotation.z += r.sp * dt; r.m.position.y = r.base + Math.sin(t * 0.8 + r.sp * 10) * 2; }
    const beat = this.U.uBeat.value;
    for (const h of this.holos) {
      h.holo.rotation.y += dt * 0.4;
      h.holo.rotation.x = Math.sin(t * 0.3 + h.seed) * 0.4;
      h.holo.position.y = 60 + Math.sin(t * 0.9 + h.seed) * 4;
      const sc = 1 + beat * 0.08;
      h.holo.scale.setScalar(sc);
      h.wire.material.opacity = 0.6 + 0.4 * (Math.sin(t * 13 + h.seed) > -0.8 ? 1 : 0);
      h.core.rotation.y -= dt * 2;
    }
    for (const b of this.beams) {
      b.m.rotation.set(Math.sin(t * 0.3 + b.seed) * 0.5, 0, Math.cos(t * 0.23 + b.seed * 1.3) * 0.5);
    }
    this.updateKoi(t);
    // lightning
    this.nextFlash = (this.nextFlash ?? 10) - dt;
    if (this.nextFlash <= 0) { this.nextFlash = 16 + Math.random() * 20; this.flash = 1; this.audio.thunder(0.6 + Math.random()); }
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.sky.material.uniforms.uFlash.value = this.flash * (Math.random() < 0.7 ? 1 : 0.3);
    this.finalPass.uniforms.uFlash.value = this.flash * 0.05;
    this.finalPass.uniforms.uAberr.value = 0.004 + s.boost * 0.012 + this.shake * 0.04 + (1 - this.intro) * 0.03;
    this.audio.setEngine(true, Math.min(1, s.vel.length() / 130), s.boost > 0.5);

    // adaptive resolution
    if (t > 5 && dt < 0.049) { this.fpsAcc += dt; this.fpsN++; }
    if (this.fpsAcc > 2.5) {
      const avg = this.fpsAcc / this.fpsN;
      if (avg > 1 / 38 && this.px < 5) { this.px++; this.resize(); }
      this.fpsAcc = 0; this.fpsN = 0;
    }
  }

  updateKoi(t) {
    const k = this.koi;
    const path = (tt) => {
      const a = tt * 0.22;
      return new THREE.Vector3(Math.cos(a) * k.r, k.h + Math.sin(tt * 0.5) * 18 + Math.sin(a * 3) * 6, Math.sin(a) * k.r);
    };
    const segs = k.segs.filter((s) => !s.fin);
    segs.forEach((m, i) => {
      const p = path(t - i * 0.22);
      m.position.copy(p);
      m.position.y += Math.sin(t * 3 - i * 0.5) * 0.8;
    });
    const head = path(t), ahead = path(t + 0.1);
    const dir = ahead.sub(head).normalize();
    k.segs.filter((s) => s.fin).forEach((f) => {
      const p = path(t - 0.6);
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(f.side * 4);
      f.m.position.copy(p).add(side);
      f.m.lookAt(p.clone().add(new THREE.Vector3(0, 1, 0)));
      f.m.rotation.z = Math.atan2(dir.x, dir.z) + Math.sin(t * 4) * 0.3 * f.side;
    });
  }

  render() {
    this.composer.render();
  }

  dispose() {}
}
