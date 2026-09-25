// CPU-side helpers: vectors, easing, sun transmittance (matches the GLSL atmosphere constants).
(function () {
  'use strict';
  const V = (window.V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  });

  const E = (window.E = {
    clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
    sat: (x) => Math.min(1, Math.max(0, x)),
    smooth: (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
    lerp: (a, b, t) => a + (b - a) * t,
    inOut: (t) => { t = Math.min(1, Math.max(0, t)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outCubic: (t) => { t = Math.min(1, Math.max(0, t)); return 1 - Math.pow(1 - t, 3); },
    inCubic: (t) => { t = Math.min(1, Math.max(0, t)); return t * t * t; },
    sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t))),
    // smooth value noise for camera shake
    noise1: (x) => {
      const i = Math.floor(x), f = x - i;
      const h = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
      const u = f * f * (3 - 2 * f);
      return h(i) * (1 - u) + h(i + 1) * u - 0.5;
    },
  });

  E.dirEA = (elDeg, azDeg) => {
    const el = (elDeg * Math.PI) / 180, az = (azDeg * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  };

  // Rotation matrix (column-major mat3 for GLSL) around unit axis k by angle a.
  E.rotMat = (k, a) => {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = k;
    return new Float32Array([
      t * x * x + c, t * x * y + s * z, t * x * z - s * y,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c,
    ]);
  };

  const RE = 6360e3, RA = 6420e3, HR = 7994, HM = 1200;
  const BR = [5.5e-6, 13.0e-6, 22.4e-6], BM = 21e-6;
  function raySphere(ro, rd, r) {
    const b = V.dot(ro, rd), c = V.dot(ro, ro) - r * r, d = b * b - c;
    if (d < 0) return null;
    const s = Math.sqrt(d);
    return [-b - s, -b + s];
  }
  // Transmittance of sunlight reaching the ground for a light direction.
  E.transmittance = (dir, ray, mie, alt) => {
    const d = V.norm([dir[0], Math.max(dir[1], 0.002), dir[2]]);
    const ro = [0, RE + (alt || 100), 0];
    const ta = raySphere(ro, d, RA);
    const N = 40, ds = ta[1] / N;
    let odR = 0, odM = 0;
    for (let i = 0; i < N; i++) {
      const p = V.add(ro, V.mul(d, (i + 0.5) * ds));
      const h = V.len(p) - RE;
      odR += Math.exp(-h / HR) * ds;
      odM += Math.exp(-h / HM) * ds;
    }
    const horizon = E.smooth(-0.012, 0.006, dir[1]);
    return BR.map((b) => Math.exp(-(b * ray * odR + BM * 1.1 * mie * odM)) * horizon);
  };
})();
