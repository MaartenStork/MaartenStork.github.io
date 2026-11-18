/* =====================================================================
   ASCII SPACE: a real-time 3D scene rendered as text characters.
   No dependencies. Needs WebGL2.

   Pipeline (every frame):
     1. SCENE pass: ray-trace planets / ray-march the ship / smoke at
        2x3 samples per character cell.
     2. CELL pass: for every cell, choose the character whose *shape*
        best matches those 6 samples ("shape-vector" matching), so
        edges get / \ | _ instead of blurry blobs. Planets use block
        shading characters, the ship and smoke use ASCII.
     3. COMPOSITE pass: draw the chosen glyphs from a font atlas at full
        resolution, plus a soft glow.
   ===================================================================== */
(() => {
  'use strict';

  const DATA = window.PORTFOLIO;
  const params = new URLSearchParams(location.search);
  const SIM = params.has('sim');
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FONT_STACK = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const MAX_PLANETS = 6;
  const MAX_SMOKE = 160;
  const MAX_DUST_SHADER = 220;
  const HIST_N = 11, HIST_DT = 0.032;           // dust trail: 11 samples ~ 0.35 s
  const DUST_ROWS = HIST_N + 3;                  // meta, bbox, head + history

  /* ------------------------------------------------------------------ */
  /* math                                                               */
  /* ------------------------------------------------------------------ */
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const bez = (a, b, c, d, t) => { const u = 1 - t; return add(add(mul(a, u * u * u), mul(b, 3 * u * u * t)), add(mul(c, 3 * u * t * t), mul(d, t * t * t))); };
  const bezD = (a, b, c, d, t) => { const u = 1 - t; return add(add(mul(sub(b, a), 3 * u * u), mul(sub(c, b), 6 * u * t)), mul(sub(d, c), 3 * t * t)); };

  /* ------------------------------------------------------------------ */
  /* shaders                                                            */
  /* ------------------------------------------------------------------ */
  const VS = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCam;
uniform mat3  uCamRot;     // columns: right, up, forward
uniform float uTanH;
uniform float uAspect;
uniform vec3  uSun;

uniform int   uPCount;
uniform vec4  uP[${MAX_PLANETS}];     // center.xyz, radius
uniform vec4  uPI[${MAX_PLANETS}];    // type, hover, seed, rings
uniform vec3  uPAtmo[${MAX_PLANETS}];

uniform vec3  uShipPos;
uniform mat3  uShipRot;     // columns: right, up, forward
uniform float uShipScale;
uniform float uShipOn;
uniform float uThrust;
uniform float uHot;
uniform float uCharge;   // return-trip warp charge: blue energy rim

uniform sampler2D uSmoke;   // ${MAX_SMOKE} x 2, RGBA32F
uniform int   uSmokeCount;

uniform sampler2D uDustTex; // ${MAX_DUST_SHADER} x ${HIST_N + 3}: (brightness, depth, width, count), bbox, then trail points (scene texels)
uniform int   uDustCount;

layout(location = 0) out vec4 oColor;  // rgb colour, a = luminance
layout(location = 1) out vec4 oClass;  // r = class (0 sky, .5 planet, 1 ascii), gba = nebula haze

const vec3 RING_N = vec3(0.3123, 0.7808, -0.5410);

float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i),                 b = hash13(i + vec3(1,0,0));
  float c = hash13(i + vec3(0,1,0)),   d = hash13(i + vec3(1,1,0));
  float e = hash13(i + vec3(0,0,1)),   g = hash13(i + vec3(1,0,1));
  float h = hash13(i + vec3(0,1,1)),   k = hash13(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}
float fbm(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s;
}

vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x - s*p.z, p.y, s*p.x + c*p.z); }
vec3 rotZ(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x - s*p.y, s*p.x + c*p.y, p.z); }

vec2 sphereHit(vec3 ro, vec3 rd, vec3 c, float r){
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r*r;
  float h = b*b - cc;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

/* ---------------- background ---------------- */
vec3 starLayer(vec3 rd, float scale, float dens, float bright){
  vec3 p = rd * scale;
  vec3 id = floor(p);
  vec3 h = hash33(id);
  if (h.x > dens) return vec3(0.0);
  vec3 sp = 0.25 + 0.5 * hash33(id + 17.0);
  float d = length(p - id - sp);
  float tw = 0.6 + 0.4 * sin(uTime * (0.6 + 2.4 * h.y) + h.z * 40.0);
  float b = smoothstep(0.45, 0.0, d) * bright * (0.3 + 0.7 * h.y * h.y) * tw;
  vec3 tint = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.85, 0.68), h.z);
  return tint * b;
}

vec3 nebula(vec3 rd){
  float n1 = fbm(rd * 2.0 + vec3(4.0, 1.0, 9.0), 4);
  float n2 = fbm(rd * 4.2 + vec3(n1 * 3.0), 3);
  float neb = smoothstep(0.42, 0.85, n1 * 0.65 + n2 * 0.55);
  vec3 nc = mix(vec3(0.40, 0.10, 0.58), vec3(0.05, 0.30, 0.60), smoothstep(0.35, 0.65, n2));
  return nc * neb;
}
vec3 background(vec3 rd){
  vec3 col = vec3(0.0);
  col += starLayer(rd, 70.0, 0.09, 1.25);
  col += starLayer(rd, 150.0, 0.06, 0.6);
  return col;
}

/* ---------------- planets ---------------- */
void surface(int type, vec3 q, float seed, out vec3 alb, out vec3 emi, out float spec){
  emi = vec3(0.0); spec = 0.0;
  vec3 s3 = vec3(seed * 7.13, seed * 3.71, seed * 5.17);
  if (type == 0) {                       // terra
    float h = fbm(q * 1.9 + s3, 5);
    float land = smoothstep(0.50, 0.535, h);
    vec3 ocean = mix(vec3(0.02, 0.07, 0.24), vec3(0.05, 0.32, 0.58), smoothstep(0.36, 0.50, h));
    vec3 ground = mix(vec3(0.16, 0.44, 0.15), vec3(0.62, 0.50, 0.27), smoothstep(0.55, 0.66, h + 0.15 * q.y * q.y));
    ground = mix(ground, vec3(0.46, 0.41, 0.37), smoothstep(0.66, 0.74, h));
    alb = mix(ocean, ground, land);
    float ice = smoothstep(0.78, 0.86, abs(q.y) + (h - 0.5) * 0.35);
    alb = mix(alb, vec3(0.92, 0.96, 1.0), ice);
    spec = (1.0 - land) * (1.0 - ice) * 0.6;
    float c = smoothstep(0.50, 0.70, fbm(q * 3.0 + s3 * 1.7 + vec3(uTime * 0.012, 0.0, 0.0), 4));
    alb = mix(alb, vec3(0.97, 0.98, 1.0), c * 0.9);
    spec *= 1.0 - c;
  } else if (type == 1) {                // gas giant
    float w = fbm(q * vec3(1.6, 5.0, 1.6) + s3, 4);
    float lat = q.y + (w - 0.5) * 0.22;
    float b = 0.5 + 0.5 * sin(lat * 22.0);
    float b2 = 0.5 + 0.5 * sin(lat * 9.0 + 1.7);
    alb = mix(vec3(0.94, 0.80, 0.57), vec3(0.72, 0.42, 0.21), smoothstep(0.35, 0.75, b));
    alb = mix(alb, vec3(0.99, 0.93, 0.82), smoothstep(0.6, 1.0, b2) * 0.55);
    vec3 sp = q - normalize(vec3(0.55, -0.28, 0.78));
    float st = smoothstep(0.24, 0.0, length(sp * vec3(1.0, 2.0, 1.0)));
    alb = mix(alb, vec3(0.82, 0.32, 0.15), st * 0.9);
  } else if (type == 2) {                // ice
    float n = fbm(q * 2.6 + s3, 5);
    float r = 1.0 - abs(2.0 * fbm(q * 5.0 + s3 * 2.0, 3) - 1.0);
    alb = mix(vec3(0.48, 0.70, 0.90), vec3(0.93, 0.97, 1.0), smoothstep(0.35, 0.70, n));
    alb = mix(alb, vec3(0.20, 0.44, 0.78), smoothstep(0.88, 0.98, r) * 0.8);
    spec = 0.35;
  } else if (type == 3) {                // lava
    float n = fbm(q * 2.2 + s3, 5);
    float r = 1.0 - abs(2.0 * fbm(q * 2.0 + s3 * 1.3, 3) - 1.0);
    alb = mix(vec3(0.16, 0.10, 0.09), vec3(0.42, 0.28, 0.22), smoothstep(0.3, 0.7, n));
    float cr = smoothstep(0.80, 0.95, r);
    float pulse = 0.75 + 0.25 * sin(uTime * 1.3 + n * 12.0);
    emi = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.78, 0.32), cr) * cr * pulse * 1.4;
  } else {                               // moon
    float n = fbm(q * 3.0 + s3, 5);
    alb = mix(vec3(0.30, 0.24, 0.46), vec3(0.74, 0.64, 0.88), smoothstep(0.30, 0.75, n));
    vec3 cp = q * 4.0 + s3;
    vec3 ci = floor(cp), cf = fract(cp);
    float md = 9.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
      vec3 o = vec3(float(x), float(y), float(z));
      vec3 rr = hash33(ci + o);
      if (rr.y < 0.45) continue;
      md = min(md, length(o + rr - cf) / (0.16 + 0.26 * rr.x));
    }
    float bowl = smoothstep(1.0, 0.55, md);
    float rim = smoothstep(0.75, 1.0, md) * smoothstep(1.25, 1.0, md);
    alb *= 1.0 - bowl * 0.38;
    alb += rim * 0.12;
  }
}

float ringAlpha(float rr, float seed){
  if (rr < 1.3 || rr > 2.35) return 0.0;
  float b  = vnoise(vec3(rr * 26.0, seed * 10.0, 0.5));
  float b2 = vnoise(vec3(rr * 7.0, seed * 3.0, 2.5));
  float a = mix(0.25, 1.0, b * 0.6 + b2 * 0.4);
  a *= smoothstep(1.3, 1.42, rr) * smoothstep(2.35, 2.2, rr);
  a *= mix(0.05, 1.0, smoothstep(0.0, 0.05, abs(rr - 1.83)));
  return a * 0.92;
}
vec3 ringColor(float rr){
  float k = vnoise(vec3(rr * 13.0, 4.0, 1.0));
  return mix(vec3(0.86, 0.82, 0.74), vec3(0.52, 0.46, 0.42), k);
}

vec3 shadePlanet(int i, vec3 ro, vec3 rd, float t){
  vec3 c = uP[i].xyz; float r = uP[i].w;
  vec4 info = uPI[i];
  int type = int(info.x + 0.5);
  float hv = info.y, seed = info.z;
  vec3 pos = ro + rd * t;
  vec3 n = (pos - c) / r;
  vec3 q = rotY(rotZ(n, 0.25 + seed * 0.15), uTime * (0.03 + 0.012 * seed) + seed * 3.0);
  vec3 alb, emi; float spec;
  surface(type, q, seed, alb, emi, spec);
  float ndl = dot(n, uSun);
  float diff = clamp((ndl + 0.12) / 1.12, 0.0, 1.0);
  vec3 col = alb * (diff * 1.35 + 0.1) + emi + uPAtmo[i] * 0.02;
  vec3 v = -rd;
  vec3 hh = normalize(uSun + v);
  col += spec * pow(max(dot(n, hh), 0.0), 36.0) * 0.6 * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  col += uPAtmo[i] * fres * (0.12 + 0.88 * smoothstep(-0.25, 0.5, ndl)) * (0.75 + 0.7 * hv);
  if (info.w > 0.5) {                    // ring shadow on the planet
    float dn = dot(uSun, RING_N);
    if (abs(dn) > 1e-3) {
      float tt = dot(c - pos, RING_N) / dn;
      if (tt > 0.0) col *= 1.0 - ringAlpha(length(pos + uSun * tt - c) / r, seed) * 0.6;
    }
  }
  return col * (1.0 + hv * 0.2);
}

/* ---------------- ship (signed distance field) ---------------- */
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdEllipsoid(vec3 p, vec3 r){ float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){ vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// local space: +x right, +y up, +z forward (nose). Returns (distance, material)
vec2 mapShip(vec3 p){
  float body = sdRoundCone(p, vec3(0.0, 0.0, -1.62), vec3(0.0, 0.05, 2.2), 0.5, 0.07);
  body = max(body, -p.z - 1.72);

  vec3 q = vec3(abs(p.x), p.y, p.z);
  float wy = -0.10 - 0.07 * (q.x - 0.3);
  float th = mix(0.075, 0.025, clamp((q.x - 0.3) / 2.2, 0.0, 1.0));
  float slab  = abs(q.y - wy) - th;
  float lead  = dot(q.xz - vec2(0.3, 0.6),   vec2(0.6522, 0.7580));
  float trail = dot(q.xz - vec2(0.3, -1.45), vec2(-0.1155, -0.9933));
  float wing = max(slab, max(q.x - 2.45, max(lead, trail)));

  vec3 f = p - vec3(0.0, 0.32, 0.0);
  float fin = max(abs(f.x) - 0.035,
              max(max(-f.y, f.y - 0.5),
                  max(dot(vec2(f.z + 0.45, f.y), vec2(0.604, 0.797)),
                      dot(vec2(f.z + 1.72, f.y), vec2(-0.9905, -0.1376)))));

  float hull = smin(body, wing, 0.12);
  hull = smin(hull, fin, 0.05);

  vec3 e = q - vec3(0.95, -0.14, 0.0);
  float nac = sdRoundCone(e, vec3(0.0, 0.0, -1.85), vec3(0.0, 0.0, -0.35), 0.27, 0.15);
  nac = max(nac, -e.z - 2.02);

  float canopy = sdEllipsoid(p - vec3(0.0, 0.30, 0.75), vec3(0.24, 0.20, 0.72));
  float cannon = sdCapsule(q, vec3(2.42, -0.247, -1.55), vec3(2.42, -0.247, 0.45), 0.045);

  float d = smin(hull, nac, 0.08);
  float m = nac < hull ? 2.0 : 0.0;
  if (canopy < d) { d = canopy; m = 1.0; }
  if (cannon < d) { d = cannon; m = 3.0; }
  return vec2(d, m);
}

vec3 shipNormal(vec3 p){
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0015;
  return normalize(k.xyy * mapShip(p + k.xyy * e).x + k.yyx * mapShip(p + k.yyx * e).x +
                   k.yxy * mapShip(p + k.yxy * e).x + k.xxx * mapShip(p + k.xxx * e).x);
}

vec3 flameCol(float h){
  vec3 cold = mix(vec3(0.50, 0.75, 1.0), vec3(0.18, 0.36, 1.0), h);
  vec3 hot  = mix(vec3(1.0, 0.93, 0.72), vec3(1.0, 0.36, 0.08), h);
  return mix(cold, hot, uHot);
}

float traceShip(vec3 ro, vec3 rd, float tMax, out vec3 lp, out float mat){
  mat3 inv = transpose(uShipRot);
  vec3 lro = inv * (ro - uShipPos) / uShipScale;
  vec3 lrd = inv * rd;
  vec2 bs = sphereHit(lro, lrd, vec3(0.0), 3.2);
  if (bs.y < 0.0) return -1.0;
  float t = max(bs.x, 0.0);
  float tEnd = min(bs.y, tMax / uShipScale);
  for (int i = 0; i < 110; i++){
    vec3 p = lro + lrd * t;
    vec2 h = mapShip(p);
    if (h.x < 0.0012 * max(1.0, t)) { lp = p; mat = h.y; return t * uShipScale; }
    t += h.x * 0.9;
    if (t > tEnd) break;
  }
  return -1.0;
}

vec3 shadeShip(vec3 lp, float m, vec3 rd){
  vec3 nL = shipNormal(lp);
  vec3 n = uShipRot * nL;
  vec3 v = -rd;
  vec3 base;
  float specK = 0.55;
  if (m < 0.5) {                                  // hull
    base = vec3(0.60, 0.63, 0.69);
    base *= 1.0 - 0.3 * smoothstep(0.44, 0.5, abs(fract(lp.z * 0.7 + 0.3) - 0.5));
    float stripe  = smoothstep(0.08, 0.06, abs(lp.x)) * step(0.2, lp.y) * step(lp.y, 0.5) * step(lp.z, 1.3);
    stripe = max(stripe, step(0.7, lp.y));                       // fin tip
    float wstripe = smoothstep(0.12, 0.08, abs(abs(lp.x) - 1.95)) * step(abs(lp.y + 0.22), 0.3);
    base = mix(base, vec3(1.0, 0.42, 0.12), max(stripe, wstripe));
  } else if (m < 1.5) {                           // canopy glass
    base = vec3(0.05, 0.12, 0.17);
    specK = 1.8;
  } else if (m < 2.5) {                           // engine nacelles
    base = vec3(0.32, 0.34, 0.39);
    base *= 1.0 - 0.45 * smoothstep(0.4, 0.5, abs(fract(lp.z * 1.2) - 0.5));
  } else {                                        // cannons
    base = vec3(0.26, 0.27, 0.31);
  }
  float ndl = max(dot(n, uSun), 0.0);
  float ao = clamp(0.35 + 0.65 * mapShip(lp + nL * 0.15).x / 0.15, 0.0, 1.0);
  vec3 col = base * (ndl * 1.35 + (0.09 + 0.10 * (0.5 + 0.5 * n.y)) * ao);
  vec3 hh = normalize(uSun + v);
  col += specK * pow(max(dot(n, hh), 0.0), 40.0) * 0.6;
  col += pow(1.0 - max(dot(n, v), 0.0), 3.0) * vec3(0.25, 0.35, 0.65) * 0.55;
  // engine glow spilling on the rear hull
  col += flameCol(0.3) * base * uThrust * 0.9 * smoothstep(-0.9, -1.95, lp.z) * clamp(0.5 - nL.z * 0.5, 0.0, 1.0);
  // engine bells: dark ring + glowing core
  float noz = 0.0, bell = 0.0;
  if (lp.z < -1.69) { float r = length(lp.xy); bell = step(r, 0.4); noz = smoothstep(0.29, 0.02, r); }
  vec3 e = vec3(abs(lp.x), lp.y, lp.z) - vec3(0.95, -0.14, 0.0);
  if (e.z < -1.99) { float r = length(e.xy); bell = max(bell, step(r, 0.23)); noz = max(noz, smoothstep(0.17, 0.01, r)); }
  col = mix(col, vec3(0.05, 0.05, 0.07) + col * 0.15, bell);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.0);
  col += vec3(0.35, 0.65, 1.0) * uCharge * (0.25 + 1.6 * rim) * (0.75 + 0.25 * sin(uTime * 31.0));
  col += flameCol(0.0) * (0.45 + 2.6 * uThrust) * noz;
  return col;
}

float segRayDist(vec3 ro, vec3 rd, vec3 a, vec3 b, out float h, out float t){
  vec3 ba = b - a, oa = ro - a;
  float d1 = dot(rd, ba), d2 = dot(ba, ba), d3 = dot(oa, rd), d4 = dot(oa, ba);
  float den = d2 - d1 * d1;
  h = den > 1e-6 ? clamp((d4 - d1 * d3) / den, 0.0, 1.0) : 0.0;
  t = max(d1 * h - d3, 0.0);
  return length(oa + rd * t - ba * h);
}

/* ---------------- space dust (sense of speed) ----------------
   Real 3D particles simulated on the CPU. Each one is drawn as the streak between where
   it is now and where it was a moment ago, so the lines always radiate from wherever
   the camera is actually heading. */
vec3 dust(vec2 px, float sceneZ){
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_DUST_SHADER}; i++){
    if (i >= uDustCount) break;
    vec4 M = texelFetch(uDustTex, ivec2(i, 0), 0);
    if (M.y > sceneZ) continue;
    vec4 bb = texelFetch(uDustTex, ivec2(i, 1), 0);
    if (px.x < bb.x || px.y < bb.y || px.x > bb.z || px.y > bb.w) continue;
    int cnt = int(M.w + 0.5);
    vec2 a = texelFetch(uDustTex, ivec2(i, 2), 0).xy;
    float best = length(px - a), along = 0.0;
    for (int k = 1; k < ${HIST_N + 1}; k++){
      if (k >= cnt) break;
      vec2 b = texelFetch(uDustTex, ivec2(i, 2 + k), 0).xy;
      vec2 ba = b - a;
      float h = clamp(dot(px - a, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d = length(px - a - ba * h);
      if (d < best) { best = d; along = (float(k - 1) + h) / float(cnt - 1); }
      a = b;
    }
    float w = M.z * mix(1.0, 0.4, along);                  // taper toward the tail
    acc += vec3(0.72, 0.80, 1.0) * smoothstep(w + 0.6, w * 0.25, best) * M.x * (1.0 - 0.8 * along);
  }
  return acc;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = uCam;
  vec3 rdc = normalize(vec3(uv.x * uTanH * uAspect, uv.y * uTanH, 1.0));   // camera space
  vec3 rd = uCamRot * rdc;
  float texelRad = 2.0 * uTanH / uRes.y;

  vec3 col = background(rd);
  float cls = 0.0;
  float tMin = 1e9;

  // planets: nearest hit
  int hitP = -1;
  for (int i = 0; i < ${MAX_PLANETS}; i++){
    if (i >= uPCount) break;
    vec2 h = sphereHit(ro, rd, uP[i].xyz, uP[i].w);
    if (h.x > 0.0 && h.x < tMin) { tMin = h.x; hitP = i; }
  }
  float pl = 0.0;
  if (hitP >= 0) { col = shadePlanet(hitP, ro, rd, tMin); cls = 1.0; pl = 1.0; }

  // halos, rings, hover reticle
  for (int i = 0; i < ${MAX_PLANETS}; i++){
    if (i >= uPCount) break;
    vec3 c = uP[i].xyz; float r = uP[i].w;
    vec4 info = uPI[i];
    vec3 oc = c - ro;
    float tc = dot(oc, rd);
    float b = sqrt(max(dot(oc, oc) - tc * tc, 0.0));
    if (tc > 0.0 && b > r && tc < tMin) {
      float x = (b - r) / r;
      vec3 dirp = normalize(ro + rd * tc - c);
      float lit = smoothstep(-0.35, 0.6, dot(dirp, uSun));
      float g = exp(-x * 13.0) * (0.25 + 0.75 * lit) * (0.6 + 0.7 * info.y);
      col += uPAtmo[i] * g * 0.75;
      if (g > 0.12) { cls = 1.0; pl = max(pl, 0.6); }
    }
    if (info.w > 0.5) {
      float den = dot(rd, RING_N);
      if (abs(den) > 1e-4) {
        float t = dot(c - ro, RING_N) / den;
        if (t > 0.0 && t < tMin) {
          vec3 p = ro + rd * t;
          float rr = length(p - c) / r;
          float a = ringAlpha(rr, info.z);
          if (a > 0.0) {
            float sh = sphereHit(p, uSun, c, r).x > 0.0 ? 0.12 : 1.0;
            float lit = (0.3 + 0.9 * abs(dot(RING_N, uSun))) * sh;
            col = mix(col, ringColor(rr) * lit * (1.0 + info.y * 0.25), a);
            if (a > 0.2) cls = 1.0;
          }
        }
      }
    }
  }

  // ship
  if (uShipOn > 0.5) {
    vec3 lp; float mat;
    float t = traceShip(ro, rd, tMin, lp, mat);
    if (t > 0.0) { tMin = t; col = shadeShip(lp, mat, rd); cls = 1.0; pl = 0.0; }

    vec3 F = uShipRot[2];
    for (int k = 0; k < 3; k++){
      vec3 ln = k == 0 ? vec3(0.0, 0.0, -1.66) : vec3(k == 1 ? 0.95 : -0.95, -0.14, -1.97);
      float nr = k == 0 ? 0.30 : 0.18;
      vec3 a = uShipPos + uShipRot * ln * uShipScale;
      float L = (0.25 + 3.4 * uThrust * uThrust) * uShipScale * (k == 0 ? 1.0 : 0.75);
      float hh, tt;
      float d = segRayDist(ro, rd, a, a - F * L, hh, tt);
      if (tt < tMin + 0.35 * uShipScale) {
        float w = nr * uShipScale * (1.0 - 0.75 * hh);
        float core = exp(-d * d / (w * w * 0.35));
        float halo = exp(-d * d / (w * w * 3.0)) * 0.35;
        float flick = 0.85 + 0.15 * sin(uTime * 40.0 + float(k) * 2.0 + hh * 10.0);
        float I = (core + halo) * pow(1.0 - hh, 1.3) * (0.35 + 0.9 * uThrust) * flick;
        col += flameCol(hh) * I * 1.4;
        if (I > 0.3) cls = 1.0;
      }
    }
  }

  col += dust(gl_FragCoord.xy, tMin * rdc.z);

  // smoke
  vec4 sm = vec4(0.0);
  for (int i = 0; i < ${MAX_SMOKE}; i++){
    if (i >= uSmokeCount) break;
    vec4 A = texelFetch(uSmoke, ivec2(i, 0), 0);
    vec4 B = texelFetch(uSmoke, ivec2(i, 1), 0);
    vec3 oc = A.xyz - ro;
    float tc = dot(oc, rd);
    if (tc < 0.0) continue;
    float r = A.w;
    float d2 = dot(oc, oc) - tc * tc;
    if (d2 > r * r) continue;
    float half_ = sqrt(r * r - d2);
    if (tc - half_ > tMin) continue;
    float x = sqrt(d2) / r;
    vec3 pc = ro + rd * (tc - half_ * 0.5);
    vec3 lpn = (pc - A.xyz) / r;
    float nz = fbm(lpn * 2.4 + B.z * 17.0 + vec3(0.0, uTime * 0.3, 0.0), 3);
    float dens = 1.0 - x * x;
    dens = dens * dens;
    dens *= smoothstep(0.38, 0.78, nz + dens * 0.22) * B.x;
    float lit = 0.2 + 0.8 * clamp(dot(normalize(lpn + rd * 0.3), uSun) * 0.5 + 0.5, 0.0, 1.0);
    vec3 sc = vec3(0.70, 0.72, 0.78) * lit;
    sc = mix(sc, vec3(1.7, 0.75, 0.25), B.y * (0.6 + 0.4 * (1.0 - x)));
    float a = clamp(dens, 0.0, 1.0);
    sm.rgb += (1.0 - sm.a) * a * sc;
    sm.a += (1.0 - sm.a) * a;
    if (sm.a > 0.97) break;
  }
  col = col * (1.0 - sm.a) + sm.rgb;
  if (sm.a > 0.3) cls = 1.0;

  col = 1.0 - exp(-col * 1.15);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float mc = max(col.r, max(col.g, col.b));
  float lum = clamp(mix(l, mc, 0.45), 0.0, 1.0);
  lum = mix(lum, pow(clamp(lum * 1.3, 0.0, 1.0), 0.85), pl * (1.0 - sm.a));
  oColor = vec4(col, lum);
  vec3 haze = hitP < 0 && tMin > 1e8 ? nebula(rd) * (1.0 - sm.a) : vec3(0.0);
  oClass = vec4(cls, clamp(haze * 2.0, 0.0, 1.0));
}`;

  const CELL_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uScene;     // 3x3 samples per cell
uniform sampler2D uClass;
uniform sampler2D uGlyph;     // count x 3, RGBA32F: (v0..v3), (v4..v7), (v8, mask, 0, 0)
uniform int   uGlyphCount;
uniform int   uAsciiCount;
uniform ivec2 uSceneSize;
uniform float uReveal;
uniform float uTime;
uniform vec2  uDirExp[3];     // per class: (directional exponent, global exponent)
uniform int   uRamp[10];      // glyph indices of " .:-=+*#%@"
uniform float uFlash;

layout(location = 0) out vec4 oCell;  // rgb fg colour, a = glyph index / 255
layout(location = 1) out vec4 oGlow;

float L(ivec2 p){ p = clamp(p, ivec2(0), uSceneSize - 1); return texelFetch(uScene, p, 0).a; }

void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy);
  ivec2 b = cell * 3;
  float v[9];
  vec3 csum = vec3(0.0), haze = vec3(0.0), cw = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 9; k++){
    int i = k % 3, j = k / 3;                  // j = 0 is the top row
    ivec2 pp = clamp(b + ivec2(i, 2 - j), ivec2(0), uSceneSize - 1);
    vec4 s = texelFetch(uScene, pp, 0);
    vec4 cl = texelFetch(uClass, pp, 0);
    v[k] = s.a;
    float w = s.a + 0.002;
    csum += s.rgb * w;
    wsum += w;
    haze += cl.gba * (0.5 / 9.0);
    if (cl.r < 0.25) cw.x += w; else if (cl.r < 0.75) cw.y += w; else cw.z += w;
  }
  int cls = 0;
  if (cw.z >= cw.x && cw.z >= cw.y) cls = 2;
  else if (cw.y >= cw.x) cls = 1;
  if (cw.z > 0.5 * (cw.x + cw.y + cw.z)) cls = 2;

  float mn = 1.0, mean = 0.0, raw = 0.0;
  for (int k = 0; k < 9; k++){ mn = min(mn, v[k]); raw = max(raw, v[k]); mean += v[k] / 9.0; }

  // contrast enhancement: directional (vs neighbouring cells) then global (within the cell)
  vec2 e2 = uDirExp[cls];
  for (int k = 0; k < 9; k++){
    int i = k % 3, j = k / 3;
    ivec2 sp = b + ivec2(i, 2 - j);
    float e = 0.0;
    if (i == 0) e = max(e, L(sp + ivec2(-1, 0)));
    if (i == 2) e = max(e, L(sp + ivec2(1, 0)));
    if (j == 0) e = max(e, L(sp + ivec2(0, 1)));
    if (j == 2) e = max(e, L(sp + ivec2(0, -1)));
    float m = max(v[k], e);
    if (m > 0.001) v[k] = m * pow(v[k] / m, e2.x);
  }
  float mx = 0.0;
  for (int k = 0; k < 9; k++) mx = max(mx, v[k]);
  if (mx > 0.001) for (int k = 0; k < 9; k++) v[k] = mx * pow(v[k] / mx, e2.y);

  // flat ascii cells: classic density ramp. edges: nearest glyph by shape
  int bi = 0;
  if (cls == 2 && raw - mn < 0.16) {
    bi = uRamp[int(clamp(pow(mean, 0.9) * 9.99, 0.0, 9.0))];
  } else if (mx > 0.05) {
    int bit = 1 << cls;
    float best = 1e9;
    for (int g = 0; g < 256; g++){
      if (g >= uGlyphCount) break;
      vec4 C = texelFetch(uGlyph, ivec2(g, 2), 0);
      if ((int(C.y + 0.5) & bit) == 0) continue;
      vec4 A = texelFetch(uGlyph, ivec2(g, 0), 0);
      vec4 B = texelFetch(uGlyph, ivec2(g, 1), 0);
      vec4 da = A - vec4(v[0], v[1], v[2], v[3]);
      vec4 db = B - vec4(v[4], v[5], v[6], v[7]);
      float dc = C.x - v[8];
      float d = dot(da, da) + dot(db, db) + dc * dc;
      if (d < best) { best = d; bi = g; }
    }
  }

  vec3 avg = csum / wsum;
  float mc = max(avg.r, max(avg.g, avg.b));
  vec3 fg;
  if (cls == 1) fg = min(avg * 1.4, vec3(1.0));
  else fg = avg / max(mc, 0.001) * mix(0.5, 1.0, smoothstep(0.0, 0.55, mc));

  // boot-up reveal: cells resolve out of random characters
  float hv = fract(sin(dot(vec2(cell), vec2(12.9898, 78.233))) * 43758.5453);
  if (uReveal < 1.15) {
    if (uReveal < hv) { bi = 0; }
    else if (uReveal < hv + 0.15 && hv > 0.3) {
      float fl = fract(hv * 91.7 + floor(uTime * 18.0) * 0.371);
      bi = 1 + int(fl * float(uAsciiCount - 1));
      fg = vec3(1.0, 0.55, 0.22) * 0.8;
    }
  }

  // warp flash: dense characters bloom outward from the centre
  if (uFlash > 0.001) {
    vec2 grid = vec2(textureSize(uScene, 0)) / 3.0;
    vec2 cc = (vec2(cell) + 0.5) / grid * 2.0 - 1.0;
    float r = length(cc * vec2(1.0, 0.75));
    float hv2 = fract(sin(dot(vec2(cell), vec2(39.3468, 11.135))) * 24634.6345);
    float th = uFlash * 1.9 - r * 0.9;
    if (hv2 < th) {
      float dens = clamp((th - hv2) * 1.5, 0.0, 1.0);
      bi = uRamp[int(clamp(3.0 + dens * 6.99, 0.0, 9.0))];
      fg = mix(vec3(0.55, 0.75, 1.0), vec3(1.0), dens);
    }
  }

  oCell = vec4(fg, float(bi) / 255.0);
  oGlow = vec4(max(avg - 0.62, 0.0) * 2.2 + avg * 0.07 + haze * 0.55, 1.0);
}`;

  const COMP_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uCell;
uniform sampler2D uGlow;
uniform sampler2D uAtlas;
uniform ivec2 uCellPx;
uniform vec2  uGridPx;
uniform float uGlowAmt;
uniform float uFlash;
uniform sampler2D uRawTex;
uniform int uRaw;

out vec4 o;

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 cell = px / uCellPx;
  ivec2 lp = px - cell * uCellPx;
  vec4 c = texelFetch(uCell, cell, 0);
  int g = int(c.a * 255.0 + 0.5);
  float a = texelFetch(uAtlas, ivec2(g * uCellPx.x + lp.x, uCellPx.y - 1 - lp.y), 0).r;

  vec2 uv = gl_FragCoord.xy / uGridPx;
  vec2 ts = 1.0 / vec2(textureSize(uGlow, 0));
  vec3 gl = texture(uGlow, uv).rgb * 0.36;
  gl += (texture(uGlow, uv + vec2(ts.x * 1.5, 0.0)).rgb + texture(uGlow, uv - vec2(ts.x * 1.5, 0.0)).rgb +
         texture(uGlow, uv + vec2(0.0, ts.y * 1.5)).rgb + texture(uGlow, uv - vec2(0.0, ts.y * 1.5)).rgb) * 0.12;
  gl += (texture(uGlow, uv + ts * vec2(3.0, 3.0)).rgb + texture(uGlow, uv + ts * vec2(-3.0, 3.0)).rgb +
         texture(uGlow, uv + ts * vec2(3.0, -3.0)).rgb + texture(uGlow, uv + ts * vec2(-3.0, -3.0)).rgb) * 0.04;

  vec3 bg = mix(vec3(0.050, 0.035, 0.095), vec3(0.012, 0.016, 0.040), smoothstep(0.0, 1.0, uv.y));
  float vig = 1.0 - 0.55 * pow(length((uv - 0.5) * vec2(1.0, 0.9)), 2.2);
  vec3 col = bg * vig + c.rgb * a + gl * uGlowAmt;
  col += vec3(0.35, 0.5, 0.8) * uFlash * uFlash * 0.35;
  if (uRaw == 1) col = texture(uRawTex, uv).rgb;
  o = vec4(col, 1.0);
}`;

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */
  const $ = (s) => document.querySelector(s);
  const canvas = $('#scene');
  const debugEl = $('#debug');
  const panel = $('#panel');
  const panelBody = $('#panel-body');
  const backBtn = $('#back-btn');
  const dockNav = $('#dock-nav');
  const navLeft = $('#nav-left');
  const navRight = $('#nav-right');
  const labelsEl = $('#labels');
  const reticle = $('#reticle');
  const reticleReadout = $('#reticle-readout');

  function fail(msg) {
    console.error(msg);
    document.body.classList.remove('booting');
    const fb = $('#fallback');
    const list = $('#fallback-list');
    list.innerHTML = DATA.planets.map((p) => `<section><h2>${p.label}</h2>${p.html}</section>`).join('');
    fb.hidden = false;
    if (SIM) { debugEl.hidden = false; debugEl.textContent = String(msg).slice(0, 3000); }
  }

  /* ------------------------------------------------------------------ */
  /* glyph set                                                          */
  /* ------------------------------------------------------------------ */
  // class bits: 1 = sky (stars), 4 = ascii (planets, ship, smoke)
  const SKY_CHARS = ".'`,+*";
  const GLYPHS = [{ ch: ' ', mask: 7 }];
  // curated symbol set: reads as ASCII art, without letter soup
  for (const ch of ".,:;'\"`^-_~=+*<>/\\|()[]{}!#%@") {
    GLYPHS.push({ ch, mask: 4 | (SKY_CHARS.includes(ch) ? 1 : 0) });
  }
  const ASCII_COUNT = GLYPHS.length - 1;
  const CPU_VECS = [];
  const RAMP_IDX = new Int32Array([...' .:-=+*#%@'].map((ch) => GLYPHS.findIndex((g) => g.ch === ch)));
  GLYPHS.push({ ch: '·', mask: 1 | 4 });

  /* ------------------------------------------------------------------ */
  /* WebGL setup                                                        */
  /* ------------------------------------------------------------------ */
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    preserveDrawingBuffer: SIM, powerPreference: 'high-performance',
  });
  if (!gl) { fail('WebGL2 not available'); return; }

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  function makeTex(w, h, opts = {}) {
    const { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, filter = gl.NEAREST, data = null } = opts;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function makeFbo(texs) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete ' + st);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }

  let P;
  try {
    P = { scene: program(SCENE_FS), cell: program(CELL_FS), comp: program(COMP_FS) };
  } catch (e) { fail(e.message); return; }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const MAX_DUST = 220;
  const dustBuf = new Float32Array(MAX_DUST * DUST_ROWS * 4);
  const smokeBuf = new Float32Array(MAX_SMOKE * 2 * 4);
  const texSmoke = makeTex(MAX_SMOKE, 2, { internal: gl.RGBA32F, type: gl.FLOAT });
  const texDust = makeTex(MAX_DUST, DUST_ROWS, { internal: gl.RGBA32F, type: gl.FLOAT });

  /* ------------------------------------------------------------------ */
  /* grid / resources (rebuilt on resize)                               */
  /* ------------------------------------------------------------------ */
  const G = { dpr: 1, font: 13, cw: 8, ch: 16, cols: 1, rows: 1, wCss: 1, hCss: 1, aspect: 1, quality: 0 };
  const R = {};
  const TAN_H = Math.tan((50 * Math.PI) / 180 / 2);

  function buildAtlas() {
    const n = GLYPHS.length;
    const cv = document.createElement('canvas');
    cv.width = n * G.cw;
    cv.height = G.ch;
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000';
    x.fillRect(0, 0, cv.width, cv.height);
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = `${G.font * G.dpr}px ${FONT_STACK}`;
    GLYPHS.forEach((g, i) => {
      x.save();
      x.translate(i * G.cw, 0);
      x.beginPath();
      x.rect(0, 0, G.cw, G.ch);
      x.clip();
      if (g.draw) g.draw(x, G.cw, G.ch);
      else x.fillText(g.ch, G.cw / 2, G.ch / 2 + G.font * G.dpr * 0.04);
      x.restore();
    });
    // shape vectors: coverage inside 6 small ellipses centred on the scene sample points,
    // measured on a high-res render so tiny cells still give stable numbers
    const SS = Math.max(1, Math.ceil(40 / G.cw));
    const hw = G.cw * SS, hh = G.ch * SS;
    const hc = document.createElement('canvas');
    hc.width = n * hw;
    hc.height = hh;
    const hx = hc.getContext('2d', { willReadFrequently: true });
    hx.fillStyle = '#000';
    hx.fillRect(0, 0, hc.width, hc.height);
    hx.fillStyle = '#fff';
    hx.textAlign = 'center';
    hx.textBaseline = 'middle';
    hx.font = `${G.font * G.dpr * SS}px ${FONT_STACK}`;
    GLYPHS.forEach((g, i) => {
      hx.save();
      hx.translate(i * hw, 0);
      hx.beginPath();
      hx.rect(0, 0, hw, hh);
      hx.clip();
      if (g.draw) g.draw(hx, hw, hh);
      else hx.fillText(g.ch, hw / 2, hh / 2 + G.font * G.dpr * SS * 0.04);
      hx.restore();
    });
    const img = hx.getImageData(0, 0, hc.width, hc.height).data;
    const CC = [1 / 6, 0.5, 5 / 6];
    const rx = 0.17 * hw, ry = 0.15 * hh;
    const vecs = GLYPHS.map((g, i) => {
      const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let k = 0; k < 9; k++) {
        const cx = CC[k % 3] * hw, cy = CC[(k / 3) | 0] * hh;
        let sum = 0, cnt = 0;
        for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
          for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
            const dx = (px + 0.5 - cx) / rx, dy = (py + 0.5 - cy) / ry;
            if (dx * dx + dy * dy > 1 || px < 0 || py < 0 || px >= hw || py >= hh) continue;
            sum += img[(py * hc.width + i * hw + px) * 4] / 255;
            cnt++;
          }
        }
        v[k] = sum / Math.max(1, cnt);
      }
      return v;
    });
    // normalise ascii/sky glyphs per dimension so the densest glyph reaches 1
    const mx = new Array(9).fill(0);
    vecs.forEach((v, i) => { if (GLYPHS[i].mask & 4) v.forEach((a, k) => { mx[k] = Math.max(mx[k], a); }); });
    const data = new Float32Array(n * 3 * 4);
    vecs.forEach((v, i) => {
      const nv = GLYPHS[i].mask & 4 ? v.map((a, k) => a / (mx[k] || 1)) : v;
      CPU_VECS[i] = nv;
      data.set([nv[0], nv[1], nv[2], nv[3]], i * 4);
      data.set([nv[4], nv[5], nv[6], nv[7]], (n + i) * 4);
      data.set([nv[8], GLYPHS[i].mask, 0, 0], (2 * n + i) * 4);
    });
    if (R.atlas) gl.deleteTexture(R.atlas);
    if (R.glyph) gl.deleteTexture(R.glyph);
    R.atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, R.atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    R.glyph = makeTex(n, 3, { internal: gl.RGBA32F, type: gl.FLOAT, data });
  }

  function resize() {
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth, vh = window.innerHeight;
    const base = clamp(Math.min(vh / 64, vw / 70), 9, 14);
    G.font = Math.round(base * Math.pow(1.18, G.quality) * 2) / 2;
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${G.font * G.dpr}px ${FONT_STACK}`;
    G.cw = Math.max(4, Math.round(m.measureText('M').width));
    G.ch = Math.max(8, Math.round(G.font * G.dpr * 1.2));
    G.cols = Math.ceil((vw * G.dpr) / G.cw);
    G.rows = Math.ceil((vh * G.dpr) / G.ch);
    canvas.width = G.cols * G.cw;
    canvas.height = G.rows * G.ch;
    G.wCss = canvas.width / G.dpr;
    G.hCss = canvas.height / G.dpr;
    canvas.style.width = G.wCss + 'px';
    canvas.style.height = G.hCss + 'px';
    G.aspect = canvas.width / canvas.height;

    ['scene', 'cls', 'cell', 'glow'].forEach((k) => R[k] && gl.deleteTexture(R[k]));
    ['fbScene', 'fbCell'].forEach((k) => R[k] && gl.deleteFramebuffer(R[k]));
    R.scene = makeTex(G.cols * 3, G.rows * 3);
    R.cls = makeTex(G.cols * 3, G.rows * 3);
    R.cell = makeTex(G.cols, G.rows);
    R.glow = makeTex(G.cols, G.rows, { filter: gl.LINEAR });
    R.fbScene = makeFbo([R.scene, R.cls]);
    R.fbCell = makeFbo([R.cell, R.glow]);
    buildAtlas();
    layoutPlanets();
  }

  /* ------------------------------------------------------------------ */
  /* world                                                              */
  /* ------------------------------------------------------------------ */
  const TYPES = { terra: 0, gas: 1, ice: 2, lava: 3, moon: 4 };
  const ATMO = {
    terra: [0.35, 0.62, 1.0], gas: [1.0, 0.72, 0.42], ice: [0.55, 0.85, 1.0],
    lava: [1.0, 0.38, 0.12], moon: [0.72, 0.52, 1.0],
  };
  // [screen x, screen y, distance, radius]: screen coords in -1..1
  const LAYOUT_WIDE = [
    [-0.47, 0.39, 520, 60], [0.45, 0.35, 660, 80], [-0.07, 0.56, 900, 50],
    [-0.83, -0.12, 560, 46], [0.84, -0.30, 480, 36], [0.16, 0.12, 1400, 30],
  ];
  const LAYOUT_TALL = [
    [-0.48, 0.56, 520, 30], [0.40, 0.30, 660, 38], [0.55, 0.74, 900, 24],
    [-0.52, 0.12, 560, 24], [0.50, -0.14, 480, 20], [-0.10, 0.45, 1400, 18],
  ];
  const SUN = norm([-0.72, 0.55, -0.32]);

  const planets = DATA.planets.slice(0, MAX_PLANETS).map((p, i) => ({
    ...p,
    type: TYPES[p.type] ?? 0,
    atmo: ATMO[p.type] || ATMO.terra,
    seed: 0.37 + i * 1.13,
    pos: [0, 0, 0],
    r: 1,
    hover: 0,
  }));

  function layoutPlanets() {
    const L = G.aspect < 0.95 ? LAYOUT_TALL : LAYOUT_WIDE;
    planets.forEach((p, i) => {
      const [nx, ny, d, r] = L[i];
      p.pos = [nx * TAN_H * G.aspect * d, ny * TAN_H * d, d];
      p.r = r;
      p.nx = nx;
    });
    // numbers follow what you see: 01..05 from left to right
    [...planets].sort((a, b) => a.nx - b.nx).forEach((p, k) => { p.num = k + 1; });
    planets.forEach((p) => { if (p.el) p.el.querySelector('.idx').textContent = pad2(p.num); });
  }
  const shipHome = () => (G.aspect < 0.95 ? [0, -2.3, 10.5] : [0, -1.55, 7.6]);
  const SHIP_SCALE = 1.7;
  // Docked camera: fly in along the line toward the planet (aimed just beside it, so the
  // warp lines come from right next to it), then turn so the planet sits left of the panel
  // (or above it on tall screens).
  function viewFor(i) {
    const p = planets[i], Rr = p.r;
    const tall = G.aspect < 0.95;
    const dirP = norm(p.pos);
    const [rP, uP] = basis(dirP);
    const dist = tall ? Rr * 4.4 : Rr * 3.8;
    const pos = add(add(p.pos, mul(dirP, -dist)), tall ? mul(uP, -Rr * 0.6) : mul(rP, Rr * 0.8));
    const d = len(sub(p.pos, pos));
    const look = tall ? add(p.pos, mul(uP, -d * 0.42 * TAN_H)) : add(p.pos, mul(rP, d * 0.45 * TAN_H * G.aspect));
    return { pos, fwd: norm(sub(look, pos)) };
  }

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */
  const S = {
    mode: 'idle', mt: 0, time: 0, target: -1, hovered: -1, labelHover: -1,
    mouse: { x: -1, y: -1, nx: 0, ny: 0, sx: 0, sy: 0 },
    camBase: [0, 0, 0], cam: [0, 0, 0], camFwd: [0, 0, 1], camRoll: 0, camR: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], camTw: null, par: 1, prevCamBase: [0, 0, 0], prevPar: [0, 0, 0], camVel: [0, 0, 0],
    ship: { pos: [0, -1.55, 7.6], fwd: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0], roll: 0, scale: 1, on: 1, thrust: 0.3, hot: 0, vel: [0, 0, 0] },
    dust: 0, warp: 0, reveal: 0, shake: 0, path: null, orbit: 0, emitAcc: 0, burst: false, panelOpen: false,
    smoke: [], smokeCount: 0, sideSign: 1,
    flash: 0, charge: 0, dustFocus: null, dustAlong: false, teleported: false, ret: null, dustCount: 0,
  };

  function basis(fwd, roll = 0) {
    const f = norm(fwd);
    let r = cross([0, 1, 0], f);
    r = len(r) < 1e-4 ? [1, 0, 0] : norm(r);
    const u = cross(f, r);
    if (!roll) return [r, u, f];
    const c = Math.cos(roll), s = Math.sin(roll);
    return [add(mul(r, c), mul(u, s)), sub(mul(u, c), mul(r, s)), f];
  }
  const toCamSpace = (v) => [dot(S.camR[0], v), dot(S.camR[1], v), dot(S.camR[2], v)];

  function orient(fwd, roll) {
    const f = norm(fwd);
    let r = cross([0, 1, 0], f);
    r = len(r) < 1e-4 ? [1, 0, 0] : norm(r);
    const u = cross(f, r);
    const c = Math.cos(roll), s = Math.sin(roll);
    S.ship.right = add(mul(r, c), mul(u, s));
    S.ship.up = sub(mul(u, c), mul(r, s));
    S.ship.fwd = f;
    S.ship.roll = roll;
  }

  // never fly through a planet: push the ship out of a padded sphere around each one
  function avoidPlanets(p, scale) {
    let q = p;
    for (const pl of planets) {
      const safe = pl.r * (1 + 0.1 * pl.hover) * 1.12 + 3.2 * scale;   // 3.2 = wingtip reach
      const d = sub(q, pl.pos);
      const L = len(d);
      if (L < safe) q = add(pl.pos, mul(d, safe / Math.max(L, 1e-3)));
    }
    return q;
  }
  // heading from actual motion when the path had to bend around a planet
  function headingFrom(prev, next, fallback) {
    const d = sub(next, prev);
    return len(d) > 1e-3 ? norm(d) : fallback;
  }

  function tweenCam(to, dur, delay = 0, ctrl = null, fwdTo = null) {
    // bank into the turn (like an aircraft), back to level on arrival
    const turn = fwdTo ? cross(S.camFwd, fwdTo)[1] : 0;
    const bank = -Math.sign(turn) * 0.2 * Math.min(1, Math.abs(turn) / 0.35);
    S.camTw = { from: S.camBase.slice(), to, t0: S.time + delay, dur, ctrl, fFrom: S.camFwd.slice(), fTo: fwdTo, bank };
  }

  /* ---------------- dust ---------------- */
  // Particles live in a box in camera space and wrap around (= an endless dust field).
  // Each keeps a short history of where it appeared on screen; drawing that history gives
  // motion trails that bend with the camera's turns, banks and swirls.
  const DUST_Z0 = 0.4, DUST_Z1 = 32, DUST_SCALE = 0.06;
  const dustPts = Array.from({ length: MAX_DUST }, () => ({ p: [rnd(-1, 1), rnd(-1, 1), rnd(DUST_Z0, DUST_Z1)], hist: [], acc: rnd(0, HIST_DT) }));
  let dustInit = false, dustR = null;
  function resetDust() { dustPts.forEach((d) => { d.hist.length = 0; }); dustR = null; }
  function updateDust(dt, Vw, focus) {
    const R = S.camR;
    if (dustR) {   // camera turned: carry particles into the new camera frame
      for (const d of dustPts) {
        const p = d.p;
        const w = add(add(mul(dustR[0], p[0]), mul(dustR[1], p[1])), mul(dustR[2], p[2]));
        p[0] = dot(R[0], w); p[1] = dot(R[1], w); p[2] = dot(R[2], w);
      }
    }
    dustR = R.map((v) => v.slice());
    const V = toCamSpace(Vw);
    const W = DUST_Z1 * TAN_H * G.aspect * 1.15, H = DUST_Z1 * TAN_H * 1.15, D = DUST_Z1 - DUST_Z0;
    if (!dustInit) { dustPts.forEach((d) => { d.p[0] *= W; d.p[1] *= H; }); dustInit = true; }
    const texW = G.cols * 3, texH = G.rows * 3;
    const toTex = (q) => [
      (q[0] / (q[2] * TAN_H * G.aspect) * 0.5 + 0.5) * texW,
      (q[1] / (q[2] * TAN_H) * 0.5 + 0.5) * texH,
    ];
    const maxJump = texH * 0.35;
    const fc = focus ? toCamSpace(sub(focus.p, S.cam)) : null;
    let n = 0;
    for (const d of dustPts) {
      const p = d.p;
      p[0] -= V[0] * dt; p[1] -= V[1] * dt; p[2] -= V[2] * dt;
      if (fc) {   // k < 0 pulls toward the focus, k > 0 pushes away from it
        const dx = p[0] - fc[0], dy = p[1] - fc[1], dz = p[2] - fc[2];
        const dl = Math.hypot(dx, dy, dz) || 1;
        const k = focus.k * dt * (focus.k < 0 ? Math.min(1, dl / 4) : 1) / dl;
        p[0] += dx * k; p[1] += dy * k; p[2] += dz * k;
      }
      let wrapped = false;
      if (p[2] < DUST_Z0) { p[2] += D; p[0] = rnd(-W, W); p[1] = rnd(-H, H); wrapped = true; }
      else if (p[2] > DUST_Z1) { p[2] -= D; p[0] = rnd(-W, W); p[1] = rnd(-H, H); wrapped = true; }
      if (p[0] < -W) { p[0] += 2 * W; wrapped = true; } else if (p[0] > W) { p[0] -= 2 * W; wrapped = true; }
      if (p[1] < -H) { p[1] += 2 * H; wrapped = true; } else if (p[1] > H) { p[1] -= 2 * H; wrapped = true; }
      if (wrapped) d.hist.length = 0;
      if (p[2] < 0.5) { d.hist.length = 0; continue; }
      const head = toTex(p);
      d.acc += dt;
      if (d.acc >= HIST_DT) {
        d.acc %= HIST_DT;
        d.hist.unshift(head);
        if (d.hist.length > HIST_N) d.hist.pop();
      }
      // polyline: now -> older samples (stop at any big jump)
      const pts = [head];
      let trail = 0;
      for (const h of d.hist) {
        const last = pts[pts.length - 1];
        const seg = Math.hypot(h[0] - last[0], h[1] - last[1]);
        if (seg > maxJump) break;
        trail += seg;
        pts.push(h);
      }
      const width = 0.65 + 1.3 * smooth(9, 1, p[2]);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      const pad = width + 1.5;
      if (x1 < -pad || y1 < -pad || x0 > texW + pad || y0 > texH + pad) continue;
      const fade = smooth(DUST_Z1, DUST_Z1 * 0.55, p[2]) * smooth(0.5, 2.0, p[2]);
      const I = fade * (0.22 + 0.95 * clamp(trail / (texH * 0.12), 0, 1));
      if (I < 0.02) continue;
      dustBuf.set([I, p[2], width, pts.length], (0 * MAX_DUST + n) * 4);
      dustBuf.set([x0 - pad, y0 - pad, x1 + pad, y1 + pad], (1 * MAX_DUST + n) * 4);
      pts.forEach((q, k) => dustBuf.set([q[0], q[1], 0, 0], ((2 + k) * MAX_DUST + n) * 4));
      n++;
    }
    S.dustCount = n;
  }

  /* ---------------- smoke ---------------- */
  function nozzles() {
    const s = S.ship;
    return [[0, 0, -1.8], [0.95, -0.14, -2.05], [-0.95, -0.14, -2.05]].map((l) =>
      add(s.pos, mul(add(add(mul(s.right, l[0]), mul(s.up, l[1])), mul(s.fwd, l[2])), s.scale)));
  }
  function spawnPuff(at, size, extraVel) {
    const sh = S.ship, sc = sh.scale;
    const jit = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)];
    const distBoost = 1 + len(sub(at, S.cam)) * 0.012;
    let v = add(mul(sh.fwd, -rnd(2.2, 3.8) * sc), mul(jit, 0.55 * sc));
    v = add(v, mul(sh.vel, 0.04));
    if (extraVel) v = add(v, extraVel);
    if (S.smoke.length >= MAX_SMOKE) S.smoke.shift();
    S.smoke.push({
      p: add(at, mul(jit, 0.08 * sc)), v,
      r0: rnd(0.18, 0.3) * sc * size * distBoost, r: 0,
      grow: rnd(0.9, 1.5) * sc * size * distBoost,
      age: 0, life: rnd(1.5, 2.6), a0: 0.6, seed: Math.random(),
    });
  }
  function emitExhaust(dt, rate) {
    S.emitAcc += dt * 52 * rate;
    if (S.emitAcc < 1) return;
    const noz = nozzles();
    while (S.emitAcc >= 1) {
      S.emitAcc -= 1;
      const k = Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? 1 : 2;
      spawnPuff(noz[k], k === 0 ? 1 : 0.75);
    }
  }
  function ignitionBurst() {
    const noz = nozzles(), sh = S.ship;
    for (let n = 0; n < 26; n++) {
      const ang = Math.random() * Math.PI * 2;
      const radial = add(mul(sh.right, Math.cos(ang)), mul(sh.up, Math.sin(ang) * 0.7));
      spawnPuff(noz[n % 3], 1.15, add(mul(radial, rnd(1.0, 2.6)), mul(sh.fwd, -rnd(0.5, 2.0))));
    }
  }
  function updateSmoke(dt) {
    const k = Math.exp(-1.3 * dt);
    for (const q of S.smoke) {
      q.age += dt;
      q.v = mul(q.v, k);
      q.p = add(q.p, mul(q.v, dt));
      q.r = q.r0 + (q.grow * (1 - Math.exp(-q.age * 0.9))) / 0.9;
    }
    S.smoke = S.smoke.filter((q) => q.age < q.life);
    let n = 0;
    for (const q of S.smoke) {
      const dz = q.p[2] - S.cam[2];
      const camFade = smooth(0.8, 3.2, dz - q.r * 0.3);
      const a = q.a0 * Math.min(1, q.age * 7) * Math.pow(1 - q.age / q.life, 1.4) * camFade;
      if (a < 0.01) continue;
      smokeBuf.set([q.p[0], q.p[1], q.p[2], q.r], n * 4);
      smokeBuf.set([a, Math.max(0, 1 - q.age * 2.4), q.seed, 0], (MAX_SMOKE + n) * 4);
      n++;
    }
    S.smokeCount = n;
  }

  /* ---------------- travel ---------------- */
  const T_IGN = REDUCED ? 0.25 : 0.7;
  const T_FLY = REDUCED ? 2.0 : 3.0;

  function launch(i) {
    if (S.mode !== 'idle' || !planets[i]) return;
    const p = planets[i];
    S.mode = 'launch'; S.mt = 0; S.target = i; S.burst = false; S.emitAcc = 0;
    const home = S.ship.pos.slice();
    const C = p.pos, Ro = p.r * 1.5;
    const toHome = norm(sub(home, C));
    const a = norm(add(toHome, [C[0] > 0 ? -0.9 : 0.9, 0.25, 0]));
    const Q = add(C, mul(a, Ro));
    let T = norm(cross([0, 1, 0], a));
    if (dot(T, sub(Q, home)) < 0) T = mul(T, -1);
    const D = len(sub(Q, home));
    S.path = { P0: home, P1: add(home, [0, D * 0.05, D * 0.4]), P2: sub(Q, mul(T, D * 0.22)), P3: Q, C, a, T, Ro };
    S.sideSign = Math.sign(dot(cross(T, mul(a, -1)), [0, 1, 0])) || 1;
    caption.hide();
    const view = viewFor(i);
    tweenCam(view.pos, REDUCED ? 1.4 : 2.4, T_IGN + T_FLY * 0.42, null, view.fwd);
  }

  // sweep to the neighbouring planet (left/right): camera pulls back a little and swings
  // over while the ship flies across. No warp.
  const T_HOP = REDUCED ? 1.4 : 2.4;
  const neighbour = (i, dir) => planets.findIndex((p) => p.num === planets[i].num + dir);
  function hop(dir) {
    if (S.mode !== 'docked') return;
    const j = neighbour(S.target, dir);
    if (j < 0) return;
    closePanel();
    const p = planets[j], sh = S.ship;
    const view = viewFor(j);
    const C = p.pos, Ro = p.r * 1.5;
    const from = sh.pos.slice();
    const a = norm(add(norm(sub(view.pos, C)), [-dir * 0.9, 0.25, 0]));     // arrive on the side facing the camera
    const Q = add(C, mul(a, Ro));
    let T = norm(cross([0, 1, 0], a));
    if (dot(T, sub(Q, from)) < 0) T = mul(T, -1);
    const D = len(sub(Q, from));
    S.hop = {
      j, P0: from, P1: add(from, mul(sh.fwd, D * 0.3)), P2: sub(Q, mul(T, D * 0.25)), P3: Q,
      path: { C, a, T, Ro },
      sideSign: Math.sign(dot(cross(T, mul(a, -1)), [0, 1, 0])) || 1,
    };
    // camera arcs back (toward the start) on the way, so it never skims another planet
    const A = S.camBase.slice(), B = view.pos, d = len(sub(B, A));
    tweenCam(B, T_HOP, 0, [add(A, mul(norm(mul(A, -1)), d * 0.35)), add(B, mul(norm(mul(B, -1)), d * 0.35))], view.fwd);
    S.mode = 'hop'; S.mt = 0; S.emitAcc = 0;
  }

  // return trip: fly back into frame -> charge (hover + vibrate) -> warp jump home
  const T_RFLY = REDUCED ? 1.4 : 2.6;     // fly straight back to the middle of the screen
  const T_CHARGE = REDUCED ? 0.6 : 1.6;   // hover, vibrate, spool up
  const T_BLAST = REDUCED ? 0.4 : 0.6;    // straight at the camera
  const T_WOUT = REDUCED ? 0.9 : 1.4;     // drop out of warp at the start
  const WARP_BACK = 420;
  const HOME_YAW = 0.14, HOME_PITCH = 0.06, HOME_ROLL = -0.12;
  const homeFwd = () => norm([Math.sin(HOME_YAW), Math.sin(HOME_PITCH), Math.cos(HOME_YAW)]);

  function goHome() {
    if (S.mode !== 'docked') return;
    closePanel();
    const sh = S.ship;
    const camD = S.camBase.slice();
    S.camTw = null;
    const [cr, cu, cf] = S.camR.map((v) => v.slice());
    const inCam = (x, y, z) => add(add(mul(cr, x), mul(cu, y)), mul(cf, z));
    const mid = add(camD, inCam(0, 0.2, 22));          // middle of the screen
    const P0 = sh.pos.slice();
    const side = Math.sign(dot(sub(P0, camD), cr)) || 1;
    const D = len(sub(mid, P0));
    const C = planets[S.target].pos, Rp = planets[S.target].r;
    const outward = norm(sub(P0, C));
    const dir = norm(sub(mid, P0));
    const oc = sub(C, P0);
    const blocked = len(sub(oc, mul(dir, clamp(dot(oc, dir), 0, D)))) < Rp * 1.5;
    let P1;
    if (blocked) {
      // ship is behind / beside the planet: first swing out past its edge
      let lat = sub(outward, mul(dir, dot(outward, dir)));
      if (len(lat) < 0.2) lat = cross([0, 1, 0], dir);
      P1 = add(add(C, mul(norm(lat), Rp * 2.3)), mul(dir, -Rp * 0.3));
    } else {
      P1 = add(P0, add(mul(outward, Rp * 0.4), mul(sh.fwd, Math.min(D * 0.25, Rp))));
    }
    S.ret = {
      P0,
      P1,
      P2: add(mid, inCam(side * 3, 1.5, 26)),
      cr, cu, cf,
      P3: mid,
      camD,
      scale0: sh.scale,
      flashed: false,
    };
    S.mode = 'return'; S.mt = 0; S.emitAcc = 0; S.charge = 0;
  }

  function update(dt) {
    S.time += dt;
    S.mt += dt;
    S.reveal = Math.min(1.2, S.reveal + dt / 1.7);
    const m = S.mouse;
    m.sx = damp(m.sx, m.nx, 3, dt);
    m.sy = damp(m.sy, m.ny, 3, dt);
    const sh = S.ship;
    const t = S.mt;

    if (S.mode === 'idle') {
      const home = shipHome();
      const yaw = 0.14 + m.sx * 0.1, pitch = 0.06 + m.sy * 0.05 + Math.sin(S.time * 0.5) * 0.012;
      sh.pos = add(home, [m.sx * 0.08, Math.sin(S.time * 0.9) * 0.07, 0]);
      orient([Math.sin(yaw), Math.sin(pitch), Math.cos(yaw)], -0.12 - m.sx * 0.16 + Math.sin(S.time * 0.7) * 0.03);
      sh.thrust = damp(sh.thrust, 0.22, 2, dt);
      sh.hot = damp(sh.hot, 0, 2, dt);
      sh.scale = SHIP_SCALE; sh.on = 1; sh.vel = [0, 0, 0];
    } else if (S.mode === 'launch') {
      const pa = S.path;
      if (t < T_IGN) {
        const k = t / T_IGN;
        sh.thrust = lerp(0.3, 1, k * k);
        sh.hot = k;
        S.shake = 0.03 * k;
        sh.pos = add(pa.P0, [0, -0.07 * Math.sin(k * Math.PI * 0.5), 0]);
        orient(mix3(sh.fwd, [0.05, 0.06, 1], 1 - Math.exp(-dt * 6)), damp(sh.roll, 0, 6, dt));
        if (!S.burst && k > 0.4) { S.burst = true; ignitionBurst(); }
        emitExhaust(dt, 0.6 * k);
      } else {
        const u = clamp((t - T_IGN) / T_FLY, 0, 1);
        const s = easeInOutQuad(u);
        const raw = bez(pa.P0, pa.P1, pa.P2, pa.P3, s);
        const p = avoidPlanets(raw, sh.scale);
        let f = norm(bezD(pa.P0, pa.P1, pa.P2, pa.P3, Math.max(s, 0.001)));
        if (len(sub(p, raw)) > 1e-3) f = headingFrom(sh.pos, p, f);
        sh.vel = mul(sub(p, sh.pos), 1 / Math.max(dt, 1e-3));
        sh.pos = p;
        const turn = dot(cross(sh.fwd, f), [0, 1, 0]) / Math.max(dt, 1e-3);
        orient(f, damp(sh.roll, clamp(-turn * 0.5, -0.9, 0.9), 4, dt));
        sh.scale = lerp(SHIP_SCALE, 3.2, smooth(0.35, 1, s));
        sh.thrust = damp(sh.thrust, 1, 6, dt);
        sh.hot = 1;
        S.shake = 0.03 * Math.max(0, 1 - (t - T_IGN) * 1.4);
        emitExhaust(dt, 1 - smooth(0.5, 0.85, s));
        if (u >= 1) { S.mode = 'docked'; S.mt = 0; S.orbit = 0; }
      }
    } else if (S.mode === 'docked') {
      const { C, a, T, Ro } = S.path;
      S.orbit += dt * 0.11;
      const ph = S.orbit;
      sh.pos = avoidPlanets(add(C, add(mul(a, Ro * Math.cos(ph)), mul(T, Ro * Math.sin(ph)))), sh.scale);
      orient(add(mul(a, -Math.sin(ph)), mul(T, Math.cos(ph))), damp(sh.roll, -S.sideSign * 0.35, 2, dt));
      sh.thrust = damp(sh.thrust, 0.35, 2, dt);
      sh.hot = damp(sh.hot, 0.4, 2, dt);
      sh.vel = [0, 0, 0];
      S.shake = 0;
      if (!S.panelOpen && t > 0.35) openPanel(S.target);
    } else if (S.mode === 'hop') {
      const hp = S.hop;
      const s = easeInOut(clamp(t / T_HOP, 0, 1));
      const raw = bez(hp.P0, hp.P1, hp.P2, hp.P3, s);
      const p = avoidPlanets(raw, sh.scale);
      let f = norm(bezD(hp.P0, hp.P1, hp.P2, hp.P3, Math.min(Math.max(s, 0.001), 0.999)));
      if (len(sub(p, raw)) > 1e-3) f = headingFrom(sh.pos, p, f);
      const turn = dot(cross(sh.fwd, f), [0, 1, 0]) / Math.max(dt, 1e-3);
      sh.vel = mul(sub(p, sh.pos), 1 / Math.max(dt, 1e-3));
      sh.pos = p;
      orient(f, damp(sh.roll, clamp(-turn * 0.5, -0.8, 0.8), 4, dt));
      sh.thrust = damp(sh.thrust, 0.85, 4, dt);
      sh.hot = damp(sh.hot, 0.7, 3, dt);
      emitExhaust(dt, 0.3);
      if (t >= T_HOP && !S.camTw) {
        S.mode = 'docked'; S.mt = 0; S.target = hp.j; S.orbit = 0;
        S.path = hp.path; S.sideSign = hp.sideSign;
      }
    } else if (S.mode === 'return') {
      const rt = S.ret;
      const t1 = T_RFLY, t3 = t1 + T_CHARGE, t4 = t3 + T_BLAST;
      const toCam = norm(sub(rt.camD, rt.P3));
      sh.on = 1;
      if (t < t1) {
        // 1. leave orbit and fly straight back, nose toward us, easing into a hover mid-screen
        S.charge = 0;
        const s = easeInOut(t / t1);
        const raw = bez(rt.P0, rt.P1, rt.P2, rt.P3, s);
        const p = avoidPlanets(raw, sh.scale);
        let tang = norm(bezD(rt.P0, rt.P1, rt.P2, rt.P3, Math.min(s, 0.999)));
        if (len(sub(p, raw)) > 1e-3) tang = headingFrom(sh.pos, p, tang);
        sh.vel = mul(sub(p, sh.pos), 1 / Math.max(dt, 1e-3));
        sh.pos = p;
        const f = norm(mix3(tang, toCam, smooth(0.6, 1, s)));
        const turn = dot(cross(sh.fwd, f), [0, 1, 0]) / Math.max(dt, 1e-3);
        const settle = smooth(0.7, 1, s);
        orient(f, damp(sh.roll, lerp(clamp(-turn * 0.5, -0.9, 0.9), 0, settle), 4, dt));
        sh.scale = lerp(rt.scale0, SHIP_SCALE, smooth(0.35, 0.95, s));
        sh.thrust = damp(sh.thrust, 0.8, 4, dt);
        sh.hot = damp(sh.hot, 0.7, 3, dt);
        emitExhaust(dt, 0.35 * (1 - settle));
      } else if (t < t3) {
        // 2. hover and charge: vibration builds, it backs off a touch, energy gathers
        const k = (t - t1) / T_CHARGE;
        S.charge = k;
        const amp = 0.012 + 0.06 * k * k;
        const recoil = 1.4 * smooth(0, 1, k);
        const jit = (x, y, z) => add(add(mul(rt.cr, x), mul(rt.cu, y)), mul(rt.cf, z));
        sh.pos = add(rt.P3, jit(rnd(-1, 1) * amp, rnd(-1, 1) * amp + Math.sin(S.time * 1.7) * 0.05, recoil + rnd(-1, 1) * amp * 0.5));
        orient(add(toCam, jit(rnd(-1, 1) * amp * 0.3, rnd(-1, 1) * amp * 0.3, 0)), rnd(-1, 1) * amp * 0.6);
        sh.thrust = lerp(0.35, 1.25, k);
        sh.hot = lerp(0.4, 1, k);
        S.shake = Math.max(S.shake, 0.014 * k);
        S.dustFocus = { p: sh.pos, k: -9 * k };          // dust gets pulled into the ship
      } else if (t < t4) {
        // 3. go: straight at the camera, back toward the start. White-out as it reaches us
        const k = (t - t3) / T_BLAST;
        const from = add(rt.P3, mul(rt.cf, 1.4));
        const to = add(rt.camD, add(mul(rt.cu, -1.1), mul(rt.cf, -2.5)));
        const p = mix3(from, to, k * k * k);
        sh.vel = mul(sub(p, sh.pos), 1 / Math.max(dt, 1e-3));
        sh.pos = p;
        orient(norm(sub(to, from)), 0);
        S.charge = 1 - k * 0.5;
        sh.thrust = 1.4;
        sh.hot = 1;
        S.flash = smooth(0.45, 1, k);
        S.dustFocus = { p: sh.pos, k: 22 * k };          // and blasted outward from it
        S.shake = 0.02 + 0.04 * k;
        emitExhaust(dt, 1);
      } else {
        // 4. drop out of warp just behind the start and coast in
        if (!rt.flashed) { rt.flashed = true; S.teleported = true; S.smoke = []; S.camFwd = [0, 0, 1]; resetDust(); }
        const k = clamp((t - t4) / T_WOUT, 0, 1);
        S.camRoll = 0.5 * Math.pow(1 - k, 2.2);         // swirl out of the warp
        S.charge = 0;
        S.dustFocus = null;
        S.dustAlong = true;                               // warp lines stream from the ship
        S.camBase = [0, 0, -WARP_BACK * (1 - easeOut(k))];
        S.flash = 1 - smooth(0, 0.4, k);
        sh.pos = add(S.camBase, shipHome());
        orient(homeFwd(), HOME_ROLL);
        sh.thrust = lerp(1.2, 0.25, smooth(0, 0.8, k));
        sh.hot = 1 - k;
        S.shake = 0.03 * (1 - k);
        if (k >= 1) { S.mode = 'idle'; S.mt = 0; S.flash = 0; S.camBase = [0, 0, 0]; S.camRoll = 0; caption.show(); }
      }
    }

    // camera
    if (S.camTw) {
      const u = clamp((S.time - S.camTw.t0) / S.camTw.dur, 0, 1);
      if (S.time >= S.camTw.t0) {
        const tw = S.camTw, e = easeInOut(u);
        S.camBase = tw.ctrl ? bez(tw.from, tw.ctrl[0], tw.ctrl[1], tw.to, e) : mix3(tw.from, tw.to, e);
        if (tw.fTo) {
          S.camFwd = norm(mix3(tw.fFrom, tw.fTo, easeInOut(smooth(0.1, 1, u))));
          S.camRoll = tw.bank * Math.sin(Math.PI * easeInOut(u));
        }
      }
      if (u >= 1) S.camTw = null;
    }
    S.par = damp(S.par, S.mode === 'idle' ? 1 : 0, 2.5, dt);
    S.shake = damp(S.shake, 0, 3, dt);
    const sk = S.shake;
    S.camR = basis(S.camFwd, S.camRoll);
    S.cam = add(S.camBase, [
      m.sx * 0.2 * S.par + Math.sin(S.time * 61) * sk,
      m.sy * 0.11 * S.par + Math.sin(S.time * 47 + 1.3) * sk,
      0,
    ]);
    // camera velocity (no shake), teleport-safe
    let cv = mul(sub(S.camBase, S.prevCamBase), 1 / Math.max(dt, 1e-3));
    if (S.teleported) { cv = S.camVel; S.teleported = false; }
    S.camVel = cv;
    S.prevCamBase = S.camBase.slice();
    const par = [m.sx * 0.2 * S.par, m.sy * 0.11 * S.par, 0];
    const pv = mul(sub(par, S.prevPar), 1 / Math.max(dt, 1e-3));
    S.prevPar = par;
    if (S.mode !== 'return') { S.dustFocus = null; S.dustAlong = false; }
    // dust moves in a scaled-down world (so it streaks instead of strobing) but in the
    // true direction of travel, plus a slow idle drift and the warp-charge push/pull
    let Vd = add(mul(cv, DUST_SCALE), pv);
    if (S.dustAlong) Vd = mul(norm(sub(S.ship.pos, S.cam)), len(cv) * DUST_SCALE);
    updateDust(dt, add(Vd, [0, 0, 0.5]), S.dustFocus);
    if (S.mode !== 'return') S.flash = damp(S.flash, 0, 6, dt);

    // hover
    const hovered = S.mode === 'idle' && S.reveal > 0.9
      ? (S.labelHover >= 0 ? S.labelHover : pick(m.x, m.y)) : -1;
    if (hovered !== S.hovered) {
      S.hovered = hovered;
      document.body.classList.toggle('pointer', hovered >= 0);
    }
    planets.forEach((p, i) => { p.hover = damp(p.hover, i === S.hovered ? 1 : 0, 9, dt); });

    updateSmoke(dt);
  }

  /* ------------------------------------------------------------------ */
  /* projection + picking                                               */
  /* ------------------------------------------------------------------ */
  function project(p, r) {
    const v = toCamSpace(sub(p, S.cam));
    if (v[2] < 0.5) return null;
    const nx = v[0] / (v[2] * TAN_H * G.aspect);
    const ny = v[1] / (v[2] * TAN_H);
    const d = len(v);
    return {
      x: (nx * 0.5 + 0.5) * G.wCss,
      y: (0.5 - ny * 0.5) * G.hCss,
      r: (r / Math.sqrt(Math.max(d * d - r * r, 1e-3)) / TAN_H) * G.hCss * 0.5,
      z: v[2],
    };
  }
  function pick(x, y) {
    if (x < 0) return -1;
    let best = -1, bz = Infinity;
    planets.forEach((p, i) => {
      const pr = project(p.pos, p.r * (1 + 0.1 * p.hover));
      if (!pr) return;
      const rr = Math.max(pr.r * 1.08, 18);
      if ((x - pr.x) ** 2 + (y - pr.y) ** 2 < rr * rr && pr.z < bz) { best = i; bz = pr.z; }
    });
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* render                                                             */
  /* ------------------------------------------------------------------ */
  const plBuf = new Float32Array(MAX_PLANETS * 4);
  const piBuf = new Float32Array(MAX_PLANETS * 4);
  const paBuf = new Float32Array(MAX_PLANETS * 3);
  const dirExp = new Float32Array([1.0, 1.0, 1.3, 1.2, 1.8, 1.5]);

  function bindTex(unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (loc) gl.uniform1i(loc, unit);
  }

  function render() {
    // ---- scene ----
    let u = P.scene.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbScene);
    gl.viewport(0, 0, G.cols * 3, G.rows * 3);
    gl.useProgram(P.scene.p);
    planets.forEach((p, i) => {
      const s = 1 + 0.1 * p.hover;
      plBuf.set([p.pos[0], p.pos[1], p.pos[2], p.r * s], i * 4);
      piBuf.set([p.type, p.hover, p.seed, p.rings ? 1 : 0], i * 4);
      paBuf.set(p.atmo, i * 3);
    });
    gl.uniform2f(u.uRes, G.cols * 3, G.rows * 3);
    gl.uniform1f(u.uTime, S.time);
    gl.uniform3fv(u.uCam, S.cam);
    gl.uniformMatrix3fv(u.uCamRot, false, [...S.camR[0], ...S.camR[1], ...S.camR[2]]);
    gl.uniform1f(u.uTanH, TAN_H);
    gl.uniform1f(u.uAspect, G.aspect);
    gl.uniform3fv(u.uSun, SUN);
    gl.uniform1i(u.uPCount, planets.length);
    gl.uniform4fv(u.uP, plBuf);
    gl.uniform4fv(u.uPI, piBuf);
    gl.uniform3fv(u.uPAtmo, paBuf);
    const sh = S.ship;
    gl.uniform3fv(u.uShipPos, sh.pos);
    gl.uniformMatrix3fv(u.uShipRot, false, [...sh.right, ...sh.up, ...sh.fwd]);
    gl.uniform1f(u.uShipScale, sh.scale);
    gl.uniform1f(u.uShipOn, sh.on);
    gl.uniform1f(u.uThrust, sh.thrust);
    gl.uniform1f(u.uHot, sh.hot);
    gl.uniform1f(u.uCharge, S.charge);
    gl.uniform1i(u.uSmokeCount, S.smokeCount);
    gl.uniform1i(u.uDustCount, S.dustCount);
    bindTex(0, texSmoke, u.uSmoke);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_SMOKE, 2, gl.RGBA, gl.FLOAT, smokeBuf);
    bindTex(1, texDust, u.uDustTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_DUST, DUST_ROWS, gl.RGBA, gl.FLOAT, dustBuf);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- cells ----
    u = P.cell.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbCell);
    gl.viewport(0, 0, G.cols, G.rows);
    gl.useProgram(P.cell.p);
    bindTex(0, R.scene, u.uScene);
    bindTex(1, R.cls, u.uClass);
    bindTex(2, R.glyph, u.uGlyph);
    gl.uniform1i(u.uGlyphCount, GLYPHS.length);
    gl.uniform2i(u.uSceneSize, G.cols * 3, G.rows * 3);
    gl.uniform1f(u.uReveal, S.reveal);
    gl.uniform1f(u.uTime, S.time);
    gl.uniform2fv(u.uDirExp, dirExp);
    gl.uniform1i(u.uAsciiCount, ASCII_COUNT);
    gl.uniform1iv(u.uRamp, RAMP_IDX);
    gl.uniform1f(u.uFlash, S.flash);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- composite ----
    u = P.comp.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(P.comp.p);
    bindTex(0, R.cell, u.uCell);
    bindTex(1, R.glow, u.uGlow);
    bindTex(2, R.atlas, u.uAtlas);
    gl.uniform2i(u.uCellPx, G.cw, G.ch);
    gl.uniform2f(u.uGridPx, canvas.width, canvas.height);
    gl.uniform1f(u.uGlowAmt, 0.55);
    gl.uniform1f(u.uFlash, S.flash);
    bindTex(3, R.scene, u.uRawTex);
    gl.uniform1i(u.uRaw, params.has('raw') ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ------------------------------------------------------------------ */
  /* HUD, labels, panel                                                 */
  /* ------------------------------------------------------------------ */
  const pad2 = (n) => String(n).padStart(2, '0');
  planets.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'label';
    b.innerHTML = `<span class="lb-top"><span class="br">[ </span><span class="idx">${pad2(p.num || i + 1)}</span> ${p.label}<span class="br"> ]</span></span>` +
      (p.hint ? `<span class="lb-hint">${p.hint}</span>` : '');
    b.setAttribute('aria-label', `Travel to ${p.label}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); launch(i); });
    b.addEventListener('pointerenter', () => { S.labelHover = i; });
    b.addEventListener('pointerleave', () => { if (S.labelHover === i) S.labelHover = -1; });
    b.addEventListener('focus', () => { S.labelHover = i; });
    b.addEventListener('blur', () => { if (S.labelHover === i) S.labelHover = -1; });
    labelsEl.appendChild(b);
    p.el = b;
  });

  let reticleFor = -1;
  function updateLabels() {
    const show = S.mode === 'idle' && S.reveal > 0.95;
    document.body.classList.toggle('show-labels', show);
    const hv = show ? S.hovered : -1;
    reticle.classList.toggle('on', hv >= 0);
    if (hv >= 0) {
      const p = planets[hv];
      const pr = project(p.pos, p.r * (1 + 0.1 * p.hover));
      if (pr) {
        const h = Math.round(pr.r * 1.18 + 6);
        reticle.style.transform = `translate(${Math.round(pr.x - h)}px, ${Math.round(pr.y - h)}px)`;
        reticle.style.width = reticle.style.height = 2 * h + 'px';
        if (reticleFor !== hv) {
          reticleFor = hv;
          reticleReadout.textContent = `${pad2(p.num)} / ${p.label.toLowerCase()}\nd ${String(Math.round(len(sub(p.pos, S.cam)))).padStart(5, '0')}\nr ${String(Math.round(p.r)).padStart(5, '0')}`;
          scramble(reticleReadout, 260);
        }
      }
    } else reticleFor = -1;
    if (!show) return;
    planets.forEach((p, i) => {
      const pr = project(p.pos, p.r * (1 + 0.1 * p.hover));
      if (!pr) return;
      const y = pr.y + pr.r * (p.rings ? 1.15 : 1) + 10;
      p.el.style.transform = `translate(${Math.round(pr.x)}px, ${Math.round(y)}px) translate(-50%, 0)`;
      p.el.classList.toggle('hover', i === S.hovered);
    });
  }

  /* ---------------- characters from pixels (CPU twin of the cell shader) ---------------- */
  function asciiFromPixels(px, cols, rows, opt = {}) {
    const { gamma = 1, dirExp = 1.8, globExp = 1.5, flat = 0.16 } = opt;
    const sw = cols * 3, sh = rows * 3;
    const L = new Float32Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) L[i] = Math.pow((0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255 * (px[i * 4 + 3] / 255), gamma);
    const at = (x, y) => L[clamp(y, 0, sh - 1) * sw + clamp(x, 0, sw - 1)];
    const cand = [];
    GLYPHS.forEach((g, i) => { if ((g.mask & 4) && CPU_VECS[i]) cand.push(i); });
    const out = [];
    const v = new Array(9);
    for (let cy = 0; cy < rows; cy++) {
      const row = [];
      for (let cx = 0; cx < cols; cx++) {
        let r = 0, g = 0, b = 0, w = 0, mn = 1, mx0 = 0, mean = 0;
        for (let k = 0; k < 9; k++) {
          const sx = cx * 3 + (k % 3), sy = cy * 3 + ((k / 3) | 0);
          const l = at(sx, sy);
          v[k] = l; mn = Math.min(mn, l); mx0 = Math.max(mx0, l); mean += l / 9;
          const o = (sy * sw + sx) * 4, ww = l + 0.002;
          r += px[o] * ww; g += px[o + 1] * ww; b += px[o + 2] * ww; w += ww;
        }
        for (let k = 0; k < 9; k++) {
          const i = k % 3, j = (k / 3) | 0, sx = cx * 3 + i, sy = cy * 3 + j;
          let e = 0;
          if (i === 0) e = Math.max(e, at(sx - 1, sy));
          if (i === 2) e = Math.max(e, at(sx + 1, sy));
          if (j === 0) e = Math.max(e, at(sx, sy - 1));
          if (j === 2) e = Math.max(e, at(sx, sy + 1));
          const m = Math.max(v[k], e);
          if (m > 0.001) v[k] = m * Math.pow(v[k] / m, dirExp);
        }
        let mx = 0;
        for (let k = 0; k < 9; k++) mx = Math.max(mx, v[k]);
        if (mx > 0.001) for (let k = 0; k < 9; k++) v[k] = mx * Math.pow(v[k] / mx, globExp);
        let gi = 0;
        if (mx0 - mn < flat) gi = RAMP_IDX[Math.min(9, Math.floor(Math.pow(mean, 0.9) * 9.99))];
        else if (mx > 0.05) {
          let best = 1e9;
          for (const c of cand) {
            const cv = CPU_VECS[c];
            let d = 0;
            for (let k = 0; k < 9; k++) { const t = cv[k] - v[k]; d += t * t; }
            if (d < best) { best = d; gi = c; }
          }
        }
        r /= w; g /= w; b /= w;
        const m3 = Math.max(r, g, b, 1);
        const br = 0.45 + 0.55 * smooth(0, 150, m3);
        const hex = '#' + [r, g, b].map((c) => Math.round(clamp(c / m3 * 255 * br, 0, 255)).toString(16).padStart(2, '0')).join('');
        row.push([GLYPHS[gi].ch, hex]);
      }
      out.push(row);
    }
    return out;
  }
  // compact FIGlet-style letters ("small" look), for the big name
  const BIG_FONT = {"A": ["   _   ", "  /_\\  ", " / _ \\ ", "/_/ \\_\\"], "B": [" ___ ", "| _ )", "| _ \\", "|___/"], "C": ["  ___ ", " / __|", "| (__ ", " \\___|"], "D": [" ___  ", "|   \\ ", "| |) |", "|___/ "], "E": [" ___ ", "| __|", "| _| ", "|___|"], "F": [" ___ ", "| __|", "| _| ", "|_|  "], "G": ["  ___ ", " / __|", "| (_ |", " \\___|"], "H": [" _  _ ", "| || |", "| __ |", "|_||_|"], "I": [" ___ ", "|_ _|", " | | ", "|___|"], "J": ["    _ ", " _ | |", "| || |", " \\__/ "], "K": [" _  __", "| |/ /", "| ' < ", "|_|\\_\\"], "L": [" _    ", "| |   ", "| |__ ", "|____|"], "M": [" __  __ ", "|  \\/  |", "| |\\/| |", "|_|  |_|"], "N": [" _  _ ", "| \\| |", "| .` |", "|_|\\_|"], "O": ["  ___  ", " / _ \\ ", "| (_) |", " \\___/ "], "P": [" ___ ", "| _ \\", "|  _/", "|_|  "], "Q": ["  ___  ", " / _ \\ ", "| (_) |", " \\__\\_\\"], "R": [" ___ ", "| _ \\", "|   /", "|_|_\\"], "S": [" ___ ", "/ __|", "\\__ \\", "|___/"], "T": [" _____ ", "|_   _|", "  | |  ", "  |_|  "], "U": [" _   _ ", "| | | |", "| |_| |", " \\___/ "], "V": ["__   __", "\\ \\ / /", " \\ V / ", "  \\_/  "], "W": ["__      __", "\\ \\    / /", " \\ \\/\\/ / ", "  \\_/\\_/  "], "X": ["__  __", "\\ \\/ /", " >  < ", "/_/\\_\\"], "Y": ["__   __", "\\ \\ / /", " \\ V / ", "  |_|  "], "Z": [" ____", "|_  /", " / / ", "/___|"], "-": ["     ", "     ", " ___ ", "|___|"], ".": ["   ", "   ", " _ ", "(_)"], " ": ["  ", "  ", "  ", "  "]};
  const BIG_ROWS = 4;
  function bigText(line) {
    const rows = Array(BIG_ROWS).fill('');
    for (const ch of line.toUpperCase()) {
      const g = BIG_FONT[ch] || BIG_FONT[' '];
      for (let r = 0; r < BIG_ROWS; r++) rows[r] += g[r];
    }
    return rows;
  }
  // colour-photo ASCII: every subject cell gets a fairly dense character; the real pixel
  // colour does most of the work, so the face stays recognisable at small sizes
  const PHOTO_RAMP = ".:-=+*#%@";
  function photoAscii(px, cols, rows) {
    const sw = cols * 2, sh = rows * 2;                 // 2x2 samples per cell, averaged
    const out = [];
    for (let cy = 0; cy < rows; cy++) {
      const row = [];
      for (let cx = 0; cx < cols; cx++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
          const o = ((cy * 2 + (k >> 1)) * sw + cx * 2 + (k & 1)) * 4;
          r += px[o]; g += px[o + 1]; b += px[o + 2]; a += (px[o] + px[o + 1] + px[o + 2] > 24 ? 1 : 0);
        }
        r /= 4; g /= 4; b /= 4;
        const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (a < 2 || l < 0.06) { row.push([' ', '#000000']); continue; }
        const ch = PHOTO_RAMP[Math.min(PHOTO_RAMP.length - 1, Math.floor((0.25 + 0.75 * Math.pow(l, 0.8)) * PHOTO_RAMP.length))];
        const k = 1.18 + 0.25 * (1 - l);              // lift darker tones a bit so they stay visible
        const hx = (m, add) => '#' + [r, g, b].map((c) => Math.round(clamp(c * m + add, 0, 255)).toString(16).padStart(2, '0')).join('');
        row.push([ch, hx(k, 10) + '|' + hx(0.42, 0)]);   // fg | cell background (fills the gaps between strokes)
      }
      out.push(row);
    }
    return out;
  }
  // big name: FIGlet-style letters when they fit, else shape-matched lettering
  function titleArt(text, rowsPerLine, maxCols) {
    const upper = text.toUpperCase();
    const known = [...upper].every((c) => BIG_FONT[c]);
    if (known) {
      const words = upper.split(/\s+/);
      const one = bigText(upper);
      const lines = one[0].length <= maxCols ? [upper] : [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')];
      const rows = [];
      lines.forEach((l, i) => { if (i) rows.push(''); rows.push(...bigText(l)); });
      if (Math.max(...rows.map((r) => r.length)) <= maxCols) return rows.map((r) => [...r.padEnd(Math.max(...rows.map((x) => x.length)))].map((c) => [c, '']));
    }
    const words = text.toUpperCase().split(/\s+/);
    const lines = words.length > 1 && text.length > 9 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [text.toUpperCase()];
    const hS = rowsPerLine * 3;
    const c = document.createElement('canvas');
    const x = c.getContext('2d', { willReadFrequently: true });
    const fontFor = (fs) => `900 ${fs}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    let fs = hS * 1.22;
    x.font = fontFor(fs);
    const widest = Math.max(...lines.map((l) => x.measureText(l).width));
    if (widest / 3 > maxCols) fs *= (maxCols * 3) / widest;
    x.font = fontFor(fs);
    const cols = Math.min(maxCols, Math.ceil((Math.max(...lines.map((l) => x.measureText(l).width)) + 2) / 3));
    c.width = cols * 3;
    c.height = hS * lines.length;
    x.fillStyle = '#000';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff';
    x.font = fontFor(fs);
    x.textBaseline = 'alphabetic';
    lines.forEach((l, i) => x.fillText(l, 1, i * hS + hS * 0.9));
    return asciiFromPixels(x.getImageData(0, 0, c.width, c.height).data, cols, rowsPerLine * lines.length);
  }

  /* ---------------- home caption, drawn entirely in characters ---------------- */
  const INTRO = Object.assign({ title: DATA.name, subtitle: DATA.role, text: '', hint: '> pick a planet to explore' }, DATA.intro || {});
  const escHTML = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function wrapText(t, w) {
    const out = [];
    let line = '';
    for (const word of t.split(/\s+/)) {
      if (!word) continue;
      if ((line ? line.length + 1 : 0) + word.length > w) { if (line) out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) out.push(line);
    return out;
  }
  const caption = (() => {
    const el = $('#caption'), pre = $('#cap-pre'), face = $('#cap-face');
    const PFONT = (SIM && params.has('p_font')) ? parseFloat(params.get('p_font')) : 4.6;   // portrait character size (px)
    $('#cap-sr').innerHTML = `<h1>${escHTML(INTRO.title)}</h1><p>${escHTML(INTRO.subtitle)}</p><p>${escHTML(INTRO.text)}</p>`;
    let portrait = null, shown = false;
    const mix = (a, b, t) => '#' + [0, 1, 2].map((k) => Math.round(parseInt(a.slice(1 + 2 * k, 3 + 2 * k), 16) * (1 - t) + parseInt(b.slice(1 + 2 * k, 3 + 2 * k), 16) * t).toString(16).padStart(2, '0')).join('');
    function render() {
      const narrow = window.innerWidth < 720;
      const CAPF = narrow ? 10 : 9.5;                       // caption character size (px)
      pre.style.fontSize = CAPF + 'px';
      face.style.fontSize = PFONT + 'px';
      const capCW = CAPF * 0.6, capCH = CAPF * 1.2, faceCW = PFONT * 0.6, faceCH = PFONT * 1.2;
      const maxRW = narrow ? Math.max(24, Math.floor((window.innerWidth - 24) / capCW) - 4) : 80;
      const art = titleArt(INTRO.title, BIG_ROWS, maxRW);
      const span = (t, c) => {
        if (!c.startsWith('#')) return `<span class="${c}">${escHTML(t)}</span>`;
        const [fg, bg] = c.split('|');
        return `<span style="color:${fg}${bg ? ';background:' + bg : ''}">${escHTML(t)}</span>`;
      };
      const runs = (cells) => {   // cells: [char, colour]; merge equal colours into one span
        let h = '', cur = null, buf = '';
        for (const [ch, col] of cells) { if (col !== cur && buf) { h += span(buf, cur); buf = ''; } cur = col; buf += ch; }
        return buf ? h + span(buf, cur) : h;
      };
      // text box rows: { html, len }
      const right = [];
      art.forEach((row, i) => {
        const col = mix('#ffffff', '#ff8a3d', i / Math.max(1, art.length - 1));
        right.push({ html: runs(row.map(([ch]) => [ch, col])), len: row.length });
      });
      const text = (t, c) => ({ html: span(t, c), len: t.length });
      const artW = Math.max(...art.map((r) => r.length));
      const RW = Math.max(artW, Math.min(maxRW, Math.max(INTRO.subtitle.length, INTRO.text.length)));
      right.push(text('', 'c-txt'));
      right.push(text(INTRO.subtitle.toUpperCase().slice(0, RW), 'c-sub'));
      if (INTRO.text) wrapText(INTRO.text, RW).forEach((l) => right.push(text(l, 'c-txt')));
      const F = (t) => `<span class="c-frame">${t}</span>`;
      const dash = (n) => '-'.repeat(n);
      const textBox = [F(`.${dash(RW + 2)}.`)];
      right.forEach((rr) => textBox.push(F('|') + ' ' + rr.html + ' '.repeat(Math.max(0, RW - rr.len)) + ' ' + F('|')));
      textBox.push(F(`'${dash(RW + 2)}'`));

      // portrait box: drawn in a finer character grid (its own <pre>) inside a character frame
      const P = !narrow && portrait ? portrait : null;
      let leftBox = [], PW = 0;
      if (P) {
        PW = Math.ceil((P[0].length * faceCW) / capCW);
        const PR = Math.ceil((P.length * faceCH) / capCH);
        leftBox.push(F(`.${dash(PW)}.`));
        for (let r = 0; r < PR; r++) leftBox.push(F('|') + ' '.repeat(PW) + F('|'));
        leftBox.push(F(`'${dash(PW)}'`));
        face.hidden = false;
        face.innerHTML = P.map((row) => runs(row)).join('\n');
        face.style.left = (capCW + (PW * capCW - P[0].length * faceCW) / 2) + 'px';
        face.style.top = (capCH + (PR * capCH - P.length * faceCH) / 2) + 'px';
      } else face.hidden = true;

      const lines = [];
      for (let r = 0; r < Math.max(leftBox.length, textBox.length); r++) {
        const l = leftBox.length ? (leftBox[r] || ' '.repeat(PW + 2)) + ' ' : '';
        lines.push(l + (textBox[r] || ''));
      }
      pre.innerHTML = lines.join('\n');
    }
    function loadPortrait() {
      const P = window.PORTRAIT;
      if (!P || !P.src) return;
      const img = new Image();
      img.onload = () => {
        const cols = (SIM && params.has('p_cols')) ? parseInt(params.get('p_cols'), 10) : (P.cols || 62);
        const rows = Math.round(cols * (img.height / img.width) * 0.5);
        const c = document.createElement('canvas');
        c.width = cols * 2; c.height = rows * 2;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, c.width, c.height);
        const opt = { gamma: 0.72, dirExp: 1.1, globExp: 1.05, flat: 0.3 };
        if (SIM) ['gamma', 'dirExp', 'globExp', 'flat'].forEach((k) => { if (params.has('p_' + k)) opt[k] = parseFloat(params.get('p_' + k)); });
        portrait = photoAscii(x.getImageData(0, 0, c.width, c.height).data, cols, rows);
        render();

      };
      img.src = P.src;
    }
    function show() {
      if (shown) return;
      shown = true;
      el.classList.add('on');
      if (!SIM) scramble(pre, 900);
    }
    function hide() { shown = false; el.classList.remove('on'); }
    return { render, show, hide, loadPortrait };
  })();

  let lastStatus = '', lastClock = '';
  function updateHud() { /* no on-screen HUD text */ }

  const SCRAMBLE = '!<>-_\\/[]{}=+*^?#%&@$';
  function scramble(root, total = 900) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let count = 0;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.nodeValue.trim()) continue;
      nodes.push({ n, text: n.nodeValue, start: count });
      count += n.nodeValue.length;
    }
    if (!count || REDUCED || SIM) return;
    const per = Math.min(10, total / count);
    const t0 = performance.now();
    const step = (now) => {
      const el = now - t0;
      let done = true;
      for (const o of nodes) {
        let s = '';
        for (let i = 0; i < o.text.length; i++) {
          const ch = o.text[i];
          const at = (o.start + i) * per;
          if (el >= at + 160 || /\s/.test(ch)) s += ch;
          else if (el >= at) { s += SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0]; done = false; }
          else { s += ' '; done = false; }
        }
        o.n.nodeValue = s;
      }
      if (!done) requestAnimationFrame(step);
      else nodes.forEach((o) => { o.n.nodeValue = o.text; });
    };
    requestAnimationFrame(step);
  }

  // panel frame drawn with characters: +--[ 02 / RESEARCH ]-------[ esc ]--+
  function panelChars() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + (window.innerWidth < 720 ? 12 : 14) + 'px var(--font)';
    probe.textContent = '0'.repeat(100);
    document.body.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 100 || 7.8;
    probe.remove();
    const narrow = window.innerWidth < 720;
    const W = narrow ? Math.floor((window.innerWidth - 24) / cw) : Math.min(90, Math.floor((window.innerWidth * 0.5) / cw));
    return { W, cw, narrow };
  }
  function drawPanelFrame(i) {
    const p = planets[i];
    const { W, cw, narrow } = panelChars();
    panel.style.width = W * cw + 'px';
    // sits right next to the docked planet (which fills the left ~45% of the screen)
    panel.style.left = narrow ? '' : Math.round(Math.min(window.innerWidth * 0.455, window.innerWidth - W * cw - 24)) + 'px';
    const label = p.label.toUpperCase();
    const fill = Math.max(1, W - (5 + 2 + 3 + label.length + 2 + 1));
    $('#panel-top').innerHTML = `<span aria-hidden="true">+--[ </span><span class="panel-idx">${pad2(p.num)}</span><span aria-hidden="true"> / </span>` +
      `<h2 id="panel-title">${escHTML(label)}</h2><span aria-hidden="true"> ]${'-'.repeat(fill)}+</span>`;
    $('#panel-bot').textContent = '+' + '-'.repeat(W - 2) + '+';
    panel.querySelectorAll('.abox-side').forEach((e) => { e.textContent = '|'.repeat(400); });
  }
  // logo holograms next to entries (<li data-logo="uva">): the real logo, floating
  function addLogos(root) {
    root.querySelectorAll('li[data-logo]').forEach((li, k) => {
      const name = li.getAttribute('data-logo');
      const src = name && window.LOGOS && window.LOGOS[name];
      const body = document.createElement('div');
      body.className = 'entry-body';
      while (li.firstChild) body.appendChild(li.firstChild);
      const holo = document.createElement('div');
      holo.className = 'holo' + (src ? '' : ' empty');
      holo.setAttribute('aria-hidden', 'true');
      if (src) {
        holo.style.setProperty('--img', `url("${src}")`);
        holo.style.setProperty('--d', (-1.7 * k).toFixed(2) + 's');      // out of sync with each other
        holo.innerHTML = '<div class="holo-img"><i class="hl"></i><i class="hl r"></i><i class="hl c"></i><i class="hs"></i></div>';
      }
      li.classList.add('has-logo');
      li.append(holo, body);
    });
  }

  function openPanel(i) {
    const p = planets[i];
    S.panelOpen = true;
    caption.hide();
    drawPanelFrame(i);
    panelBody.innerHTML = p.html;
    addLogos(panelBody);
    // publication visuals: wrap so the image and its scanlines float together
    panelBody.querySelectorAll('figure.holo-media').forEach((fig, k) => {
      const img = fig.querySelector('img');
      if (!img) return;
      const wrap = document.createElement('div');
      wrap.className = 'hm';
      wrap.style.animationDelay = (-2.3 * k) + 's';
      img.replaceWith(wrap);
      wrap.append(img, Object.assign(document.createElement('i'), { className: 'hm-scan' }));
    });
    // dot leaders between a title and its meta:  Project .......... 2025
    panelBody.querySelectorAll('.list .row, .list a, .links li').forEach((r) => {
      const m = r.querySelector('.m');
      if (!m) return;
      const lead = document.createElement('span');
      lead.className = 'leader';
      lead.setAttribute('aria-hidden', 'true');
      if (r.matches('.links li')) r.insertBefore(lead, m.nextSibling); else r.insertBefore(lead, m);
    });
    panel.hidden = false;
    panel.scrollTop = 0;
    requestAnimationFrame(() => panel.classList.add('open'));
    scramble(panel, 800);
    const L = neighbour(i, -1), Rn = neighbour(i, 1);
    navLeft.hidden = L < 0;
    navRight.hidden = Rn < 0;
    if (L >= 0) navLeft.textContent = `[ \u2190 ${pad2(planets[L].num)} ${planets[L].label} ]`;
    if (Rn >= 0) navRight.textContent = `[ ${pad2(planets[Rn].num)} ${planets[Rn].label} \u2192 ]`;
    dockNav.classList.add('on');
    setTimeout(() => backBtn.focus({ preventScroll: true }), 60);
    try { history.replaceState(null, '', '#' + p.id); } catch (e) { /* file:// */ }
  }
  function closePanel() {
    S.panelOpen = false;
    panel.classList.remove('open');
    dockNav.classList.remove('on');
    if (dockNav.contains(document.activeElement)) document.activeElement.blur();
    setTimeout(() => { if (!S.panelOpen) panel.hidden = true; }, 450);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
  }

  /* ------------------------------------------------------------------ */
  /* input                                                              */
  /* ------------------------------------------------------------------ */
  window.addEventListener('pointermove', (e) => {
    S.mouse.x = e.clientX;
    S.mouse.y = e.clientY;
    if (e.pointerType === 'mouse') {
      S.mouse.nx = (e.clientX / window.innerWidth) * 2 - 1;
      S.mouse.ny = -((e.clientY / window.innerHeight) * 2 - 1);
    }
  });
  document.addEventListener('pointerleave', () => { S.mouse.x = -1; S.mouse.nx = 0; S.mouse.ny = 0; });
  canvas.addEventListener('click', (e) => {
    if (S.mode === 'idle') {
      const i = pick(e.clientX, e.clientY);
      if (i >= 0) launch(i);
    }
  });
  backBtn.addEventListener('click', goHome);
  navLeft.addEventListener('click', () => hop(-1));
  navRight.addEventListener('click', () => hop(1));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'ArrowDown') { goHome(); return; }
    if (e.key === 'ArrowLeft') { hop(-1); return; }
    if (e.key === 'ArrowRight') { hop(1); return; }
    const n = parseInt(e.key, 10);
    const hit = planets.findIndex((p) => p.num === n);
    if (hit >= 0 && S.mode === 'idle' && S.reveal > 0.9) launch(hit);
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      resetDust();
      caption.render();
      if (S.panelOpen) drawPanelFrame(S.target);
      if (S.mode === 'docked') { S.camTw = null; const v = viewFor(S.target); S.camBase = v.pos; S.camFwd = v.fwd; }
    }, 120);
  });

  /* ------------------------------------------------------------------ */
  /* loop                                                               */
  /* ------------------------------------------------------------------ */
  let last = 0, slowFrames = 0;
  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    update(dt);
    render();
    updateLabels();
    updateHud();
    // adaptive quality: if we can't hold ~30fps, use bigger characters
    if (dt > 0.034) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 90 && G.quality < 2) { G.quality++; slowFrames = 0; resize(); }
    requestAnimationFrame(frame);
  }

  async function boot() {
    try {
      await Promise.race([document.fonts.load(`16px "JetBrains Mono"`), new Promise((r) => setTimeout(r, 1500))]);
    } catch (e) { /* fall back to system mono */ }
    try { resize(); } catch (e) { fail(e.message); return; }
    document.body.classList.remove('booting');
    caption.render();
    caption.loadPortrait();
    if (SIM) { document.body.classList.add('sim'); caption.show(); } else setTimeout(() => { if (S.mode === 'idle') caption.show(); }, 1300);

    if (SIM) {
      // debug: ?sim=<seconds>&go=<planet index>&hover=<planet index>
      const go = params.has('go') ? parseInt(params.get('go'), 10) : -1;
      const hv = params.has('hover') ? parseInt(params.get('hover'), 10) : -1;
      const secs = parseFloat(params.get('sim')) || 0;
      S.reveal = 1.2;
      if (hv >= 0) S.labelHover = hv;
      if (params.has('mx')) { S.mouse.nx = S.mouse.sx = parseFloat(params.get('mx')); S.mouse.ny = S.mouse.sy = parseFloat(params.get('my') || '0'); }
      for (let i = 0; i < 30; i++) update(1 / 60);
      if (go >= 0) launch(go);
      const back = params.has('back') ? parseFloat(params.get('back')) : -1;
      let minClear = Infinity, minAt = '', camClear = Infinity, camAt = '';
      for (let tt = 0; tt < secs; tt += 1 / 60) {
        if (back >= 0 && tt >= back && S.mode === 'docked') goHome();
        if (params.has('hop') && !S.__hopped && tt >= parseFloat(params.get('hop')) && S.mode === 'docked') { S.__hopped = true; hop(parseInt(params.get('dir') || '1', 10)); }
        update(1 / 60);
        planets.forEach((pl) => {
          const c = len(sub(S.cam, pl.pos)) - pl.r * (1 + 0.1 * pl.hover);
          if (c < camClear) { camClear = c; camAt = `${S.mode}@${tt.toFixed(2)} ${pl.id}`; }
        });
        if (S.ship.on > 0.5 && S.mode !== 'idle') {
          planets.forEach((pl) => {
            const c = len(sub(S.ship.pos, pl.pos)) - pl.r * (1 + 0.1 * pl.hover);
            if (c < minClear) { minClear = c; minAt = `${S.mode}@${tt.toFixed(2)} ${pl.id}`; }
          });
        }
      }
      window.__minClear = `minClear ${minClear.toFixed(1)} (${minAt}) camClear ${camClear.toFixed(1)} (${camAt})`;
      render();
      updateLabels();
      updateHud();
      window.__ready = true;
      debugEl.hidden = false; debugEl.textContent = `${window.__minClear || ''} vw ${innerWidth}x${innerHeight} canvas ${canvas.width}x${canvas.height} dpr ${G.dpr} grid ${G.cols}x${G.rows}`;
      window.addEventListener('resize', () => setTimeout(() => { render(); debugEl.textContent += ` | resized ${innerWidth}x${innerHeight}`; }, 200));
      return;
    }
    requestAnimationFrame(frame);

    const hash = location.hash.slice(1);
    const hi = planets.findIndex((p) => p.id === hash);
    if (hi >= 0) setTimeout(() => launch(hi), 1900);
  }
  boot();
})();
