// The edit: every shot of the trailer as a function of time.
(function () {
  'use strict';
  let GR = null;
  const G = (w, x, z) => (GR ? GR.h(w, x, z) : 0);
  const { smooth, lerp, inOut, outCubic, inCubic, sine, clamp, sat, noise1 } = E;
  const D2R = Math.PI / 180;

  // ------------------------------------------------------------ sky mechanics of the stopped world
  const INC = 30 * D2R, AZ0 = -7 * D2R;
  const PHI0 = 1.85 * D2R;
  function rotY(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c]; }
  function sunPath(phi) { return rotY([Math.cos(phi), Math.sin(phi) * Math.cos(INC), Math.sin(phi) * Math.sin(INC)], AZ0); }
  const SKY_AXIS = V.norm(rotY([0, -Math.sin(INC), Math.cos(INC)], AZ0));

  // ------------------------------------------------------------ state
  function base(scene) {
    return {
      scene, name: '', lt: 0,
      cam: { pos: [0, 10, 0], tar: [0, 10, 10], fov: 35, roll: 0 },
      sun: [1, 0, 0], moon: [0, -1, 0],
      atmo: { sunI: 22, moonI: 0, mie: 1, ray: 1, g: 0.78, tint: [1, 1, 1] },
      sunLight: 3.2, moonLight: 0,
      A: [0, 0, 0, 0], B: [0, 0, 0, 0], C: [-1, 0, 0, 0], D: [0, 0, 0, 0],
      cloud: [0, 2000, 0, 0], fog: [0.0005, 0.01, 0.5, 0],
      trav: { pos: [0, 0, 0], facing: 0, phase: 0, gait: 0, mode: 0 },
      lantern: { off: [-0.27, 0.98, 0.24], I: 0 },
      ambK: 1, flash: 0, flashCol: [0.75, 0.82, 1.0], heat: 0, night: 0, starRot: null,
      grade: {
        exposure: 1, wb: [1, 1, 1], sat: 1, contrast: 1.05, lift: [0, 0, 0], gain: [1, 1, 1], vig: 0.4, grain: 0.035,
        ca: 0.0012, bloom: 0.035, streak: 0.18, streakThresh: 25.0, streakTint: [0.55, 0.75, 1.25], rays: 0, raysThresh: 0.6, raysDensity: 0.95,
      },
      fade: 1, white: 0, planet: null,
    };
  }
  function look(S, pos, tar, fov, roll) { S.cam = { pos, tar, fov, roll: roll || 0 }; }
  function shake(S, T, amp, freq) {
    const n = (o) => noise1(T * freq + o) * amp;
    const d = V.len(V.sub(S.cam.tar, S.cam.pos));
    S.cam.tar = V.add(S.cam.tar, [n(1.3) * d, n(7.1) * d, n(3.7) * d]);
    S.cam.roll += n(11.9) * 0.5;
  }
  function traveler(S, world, x, z, dir, gait, lt, opts) {
    opts = opts || {};
    S.trav.pos = [x, opts.y || 0, z];
    S.trav.facing = Math.atan2(dir[0], dir[1]);
    S.trav.gait = gait;
    S.trav.phase = lt * (gait > 1.5 ? 10.5 : 5.6) + (opts.ph || 0);
    S.trav.mode = opts.y !== undefined ? 2 : 1;
    if (opts.lantern !== undefined) S.lantern.I = opts.lantern;
    if (opts.lanOff) S.lantern.off = opts.lanOff;
  }

  // ------------------------------------------------------------ world presets
  function presetTwilight(S, T) {
    S.sun = sunPath(PHI0);
    S.moon = V.norm([-0.35, 0.42, 0.84]);
    S.atmo = { sunI: 22, moonI: 0.015, mie: 1.0, ray: 1.0, g: 0.75, tint: [1, 0.97, 0.93] };
    S.sunLight = 7.0; S.moonLight = 0.02;
    S.B = [0.55, 0.42, 0, 0];
    S.cloud = [0.47, 2300, 0.2 + T * 0.004, 1];
    S.fog = [0.0002, 0.011, 0.25, 0];
    S.ambK = 1.0;
    Object.assign(S.grade, {
      exposure: 1.0, wb: [1.05, 1, 0.93], sat: 1.08, contrast: 1.1, lift: [0.012, 0.006, 0.022], gain: [1.02, 0.99, 0.96],
      bloom: 0.035, streak: 0.2,
    });
  }
  function presetDesert(S, T) {
    S.sun = E.dirEA(15, 100);
    S.atmo = { sunI: 22, moonI: 0, mie: 0.9, ray: 1.25, g: 0.76, tint: [1.04, 1, 0.93] };
    S.sunLight = 7.5;
    S.cloud = [0.14, 3200, 0.3 + T * 0.003, 0.7];
    S.fog = [0.00025, 0.016, 0.3, 0.2];
    S.heat = 1;
    Object.assign(S.grade, {
      exposure: 0.8, wb: [1.08, 1, 0.88], sat: 1.02, contrast: 1.18, lift: [0.02, 0.012, 0.004], gain: [1.03, 1, 0.95],
      bloom: 0.035, streak: 0.12,
    });
  }
  function presetIce(S, T) {
    S.sun = E.dirEA(-24, -100);
    S.moon = E.dirEA(13, 72);
    S.atmo = { sunI: 22, moonI: 0.5, mie: 1.2, ray: 1, g: 0.8, tint: [1, 1, 1] };
    S.sunLight = 0; S.moonLight = 0.55;
    S.A = [1.0, 0, 0, 0];
    S.C = [0, 0, 0, 0];
    S.D = [0, 0.2, 80, 0];
    S.cloud = [0.33, 2600, T * 0.002, 0.8];
    S.fog = [0.0004, 0.004, 0, 0.5];
    S.night = 1;
    Object.assign(S.grade, {
      exposure: 3.0, wb: [0.86, 0.96, 1.15], sat: 0.95, contrast: 1.12, lift: [0.004, 0.01, 0.025], gain: [0.98, 1, 1.03],
      bloom: 0.04, streak: 0.2,
    });
  }
  function titan(S, x, scale) {
    S.D[2] = x;
    S.C[2] = scale;
    S.C[3] = G('ice', x, 1350) - 0.5 * scale;
  }
  function presetPlanet(S, T) {
    S.planet = { A: [0, 1, 0, 1], B: [1.6, 0, 0, 0], sun0: V.norm([1, 0.06, -0.28]), sunCol: [7, 6.6, 6.2] };
    S.sun = S.planet.sun0;
    Object.assign(S.grade, {
      exposure: 1.0, wb: [1, 1, 1.03], sat: 1.05, contrast: 1.08, lift: [0.004, 0.006, 0.014], bloom: 0.04, streak: 0.2, streakThresh: 20.0,
    });
  }

  // ring spin (integrated so the awakening accelerates smoothly)
  function ringAngles(T) {
    let b = 0.55, c = 0.42;
    // tremor during the build
    const tr = smooth(36.8, 39.5, T) * (T < 40 ? 1 : 0);
    b += tr * 0.012 * Math.sin(T * 37) + smooth(37.0, 39.6, T) * 0.03;
    c += tr * 0.01 * Math.sin(T * 29);
    if (T > 40) {
      const x = T - 40;
      // angular speed ramps from 0 to w over ~3 s, integral computed in closed form-ish
      const ramp = (w, k) => w * (x - (1 - Math.exp(-x / k)) * k);
      b += ramp(0.55, 1.6);
      c += ramp(-0.9, 2.2);
    }
    return [b, c];
  }
  // sun angle of the waking world
  function phiAt(T) {
    const u = smooth(41.0, 47.7, T);
    return PHI0 + (2 * Math.PI + 2.2 * D2R) * u;
  }
  function applyTurningSky(S, T) {
    const phi = phiAt(T);
    S.sun = sunPath(phi);
    S.moon = V.norm(V.mul(sunPath(phi + 0.35), -1));
    S.starRot = E.rotMat(SKY_AXIS, -(phi - PHI0));
    const night = smooth(0.04, -0.14, S.sun[1]);
    S.night = night;
    S.atmo.moonI = 0.35 * night;
    S.moonLight = 0.3 * night;
    S.grade.exposure = lerp(lerp(1.0, 0.42, smooth(0.04, 0.5, S.sun[1])), 3.2, night);
    S.grade.wb = [lerp(1.05, 0.88, night), lerp(1, 0.96, night), lerp(0.93, 1.14, night)];
    S.cloud[2] = 0.2 + T * 0.004 + Math.max(0, T - 41) * Math.max(0, T - 41) * 0.012;
  }

  // ------------------------------------------------------------ shots
  const RC = [0, 96, 0];
  const SHOTS = [
    // 0 — intro: the planet that stopped turning
    { name: 'planet-intro', t0: 0, t1: 4, scene: 'planet', fn(S, u, lt, T) {
      presetPlanet(S, T);
      const p = V.lerp([-0.55, 0.42, 3.35], [-0.38, 0.33, 2.95], sine(u));
      look(S, p, [0.18, 0.02, 0], 30, 0.05);
      S.planet.A = [0, 1, T * 0.01, 1];
      S.fade = smooth(0.15, 2.2, T) * (1 - smooth(3.85, 4.0, T) * 0.0);
    } },
    // 1 — desert, eternal noon
    { name: 'desert', t0: 4, t1: 10, scene: 'desert', fn(S, u, lt, T) {
      presetDesert(S, T);
      const e = inOut(u);
      const x = lerp(-14, -4, u), z = lerp(-30, 40, u);
      const gy = GR ? GR.maxAlong('desert', [x, z - 10], [x, z + 30], 8) : 30;
      const y = gy + lerp(3.5, 17, e);
      look(S, [x, y, z], [30, lerp(y + 8, 48, e), 900], 30, lerp(0.03, -0.01, u));
      shake(S, T, 0.0015, 0.4);
      traveler(S, 'desert', 6, 190 + lt * 1.3, [0.1, 1], 1, lt, { lantern: 0 });
      S.fade = smooth(4.0, 4.5, T) * (1 - smooth(9.75, 10.0, T));
    } },
    // 2 — ice, eternal night
    { name: 'ice', t0: 10, t1: 16, scene: 'ice', fn(S, u, lt, T) {
      presetIce(S, T);
      const z = lerp(-260, -190, u);
      look(S, [8, lerp(3.2, 4.0, u), z], [lerp(-40, -60, u), lerp(80, 260, inOut(u)), 900], 38, 0.0);
      S.D[1] = 0.25;
      S.fog[3] = 0.35;
      S.fade = smooth(10.0, 10.6, T) * (1 - smooth(15.75, 16.0, T));
    } },
    // 3 — twilight belt, a lone traveler at the cliff
    { name: 'twilight-cliff', t0: 16, t1: 22, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const tx = 171, tz = -58;
      const gy = G('twilight', tx, tz);
      traveler(S, 'twilight', tx, tz, [1, -0.12], 0, lt, { lantern: 0.5 });
      const cp = V.lerp([tx - 10, G('twilight', tx - 10, tz + 6) + 1.7, tz + 6], [tx - 8, G('twilight', tx - 8, tz + 4) + 1.5, tz + 4], sine(u));
      look(S, cp, [tx + 60, gy - 2, tz - 14], 30, -0.02);
      shake(S, T, 0.001, 0.5);
      S.fog[3] = 0.25;
      S.fade = smooth(16.0, 16.6, T) * (1 - smooth(21.8, 22.0, T) * 0);
    } },
    // 4a — the machine: telephoto, sun inside the rings
    { name: 'machine-tele', t0: 22, t1: 26, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const cam = V.lerp([-305, 86, 37], [-276, 87.5, 33], sine(u));
      look(S, cam, [0, lerp(86, 90, u), 0], lerp(25, 23, u), 0);
      S.sun = V.norm(V.sub([0, 97, 0], cam));
      S.sun[1] = Math.max(S.sun[1], 0.02);
      S.sun = V.norm(S.sun);
      traveler(S, 'twilight', -150 + lt * 1.3, 4, [1, 0], 1, lt, { lantern: 0.6 });
      S.grade.rays = 0.35;
      S.fade = smooth(22.0, 22.15, T);
    } },
    // 4b — crane up the ring face
    { name: 'machine-crane', t0: 26, t1: 30, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const e = inOut(u);
      traveler(S, 'twilight', -74, 3, [1, -0.05], 0, lt, { lantern: 0.8 });
      look(S, [lerp(-86, -93, e), lerp(39.4, 76, e), lerp(7.5, 11, e)], [0, lerp(50, 94, e), 0], lerp(40, 46, e), lerp(0.02, -0.02, e));
      shake(S, T, 0.0008, 0.6);
      S.grade.exposure = 1.25;
    } },
    // M1 — run across the day
    { name: 'm-desert-run', t0: 30, t1: 31, scene: 'desert', fn(S, u, lt, T) {
      presetDesert(S, T);
      const tx = 40 + lt * 6.5, tz = 260;
      traveler(S, 'desert', tx, tz, [1, 0.05], 2, lt, { lantern: 0 });
      const gy = G('desert', tx, tz);
      look(S, [tx - 3 + lt * 0.5, gy + 1.0, tz - 9], [tx + 2.5, gy + 1.3, tz], 30, 0.04);
      shake(S, T, 0.004, 3.5);
      S.fog[3] = 0.9;
    } },
    // M2 — past the buried giant
    { name: 'm-desert-ring', t0: 31, t1: 32, scene: 'desert', fn(S, u, lt, T) {
      presetDesert(S, T);
      const p = V.lerp([-120, 34, 760], [-60, 40, 800], u);
      look(S, p, [40, 60, 900], 36, lerp(0.1, 0.05, u));
      shake(S, T, 0.002, 2);
    } },
    // M3 — lantern in the blizzard
    { name: 'm-ice-lantern', t0: 32, t1: 33, scene: 'ice', fn(S, u, lt, T) {
      presetIce(S, T);
      const tz = -300 + lt * 1.2, tx = 0;
      traveler(S, 'ice', tx, tz, [0.05, -1], 1, lt, { lantern: 2.2, lanOff: [-0.3, 1.1, 0.3] });
      look(S, [tx - 1.6, 1.5, tz - 5.2 + lt * 0.8], [tx + 0.1, 1.3, tz], 34, -0.03);
      S.A[0] = 0.25; S.moonLight = 0.25; S.atmo.moonI = 0.25;
      S.D[1] = 1.0; S.fog[3] = 0.95; S.fog[0] = 0.004; S.fog[1] = 0.02;
      S.grade.exposure = 2.4;
      shake(S, T, 0.003, 2.5);
    } },
    // M4 — lightning reveals a titan
    { name: 'm-ice-titan', t0: 33, t1: 34, scene: 'ice', fn(S, u, lt, T) {
      presetIce(S, T);
      titan(S, 80, 95);
      look(S, [60, 6, -120], [80, lerp(330, 350, u), 1350], 30, 0.02);
      const f = Math.exp(-Math.max(0, T - 33.25) * 9) * (T > 33.25 ? 1 : 0) + Math.exp(-Math.max(0, T - 33.45) * 12) * (T > 33.45 ? 0.6 : 0);
      S.flash = f * 2.5;
      S.C[0] = f; S.C[1] = f > 0.05 ? 1 : 0; S.D[3] = 3.0;
      S.A[0] = 0.05; S.moonLight = 0.05; S.atmo.moonI = 0.03;
      S.cloud = [0.75, 1500, T * 0.01, 1];
      S.D[1] = 0.8; S.fog[3] = 0.8;
      S.grade.exposure = 1.6;
      S.night = 0.3;
      S.fog[0] = 0.00012;
      shake(S, T, 0.002 + f * 0.01, 3);
    } },
    // M5 — low over the sea toward the cliffs
    { name: 'm-sea', t0: 34, t1: 35, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const p = V.lerp([620, 7, -40], [470, 9, -30], u);
      look(S, p, [0, 70, 0], 34, lerp(-0.08, -0.03, u));
      shake(S, T, 0.002, 2);
    } },
    // M6 — runes wake up
    { name: 'm-runes', t0: 35, t1: 36, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const a = lerp(-2.3, -2.15, u);
      const p = [-6.2, 96 + Math.cos(a) * 50, Math.sin(a) * 50];
      const q = [-2.8, 96 + Math.cos(a + 0.3) * 50, Math.sin(a + 0.3) * 50];
      look(S, p, q, 46, 0.35);
      S.A[2] = lerp(0.6, 0.8, smooth(35.0, 35.9, T));
      S.grade.exposure = 1.7;
      shake(S, T, 0.002, 1.5);
    } },
    // M7 — climbing to the core
    { name: 'm-stairs', t0: 36, t1: 37, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const sx = -60 + lt * 1.3;
      const sy = 38 + 0.3 * (Math.floor((sx + 55 + 11) / 1.1) + 1);
      traveler(S, 'twilight', sx, 0.6, [1, 0], 1, lt, { y: sy, lantern: 2.0, lanOff: [-0.25, 1.95, 0.3] });
      look(S, [sx - 3.4, sy - 0.1, -1.9], [sx + 6, sy + 4.5, 0.7], 42, 0.04);
      S.A[1] = 0.02;
      shake(S, T, 0.002, 1.2);
    } },
    // M8 — the dark core
    { name: 'm-core', t0: 37, t1: 38, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const p = V.lerp([-30, 90, -14], [-24, 92, -11], u);
      look(S, p, [0, 96, 0], 34, -0.06);
      S.A[1] = lerp(0.0, 0.03, u);
      const ang = ringAngles(T); S.B[0] = ang[0]; S.B[1] = ang[1];
      S.grade.exposure = 1.6;
      shake(S, T, 0.002, 1.5);
    } },
    // build — push to the core, the machine trembles
    { name: 'build', t0: 38, t1: 39.6, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const e = inCubic(u);
      const p = V.lerp([-70, 70, -30], [-26, 90, -9], e);
      look(S, p, [0, 96, 0], lerp(40, 30, e), lerp(0.05, -0.08, e));
      S.A[1] = lerp(0.03, 0.22, e);
      const ang = ringAngles(T); S.B[0] = ang[0]; S.B[1] = ang[1];
      S.grade.exposure = 1.5;
      shake(S, T, 0.002 + 0.01 * e, 6);
      S.fade = 1 - smooth(39.45, 39.6, T);
    } },
    { name: 'black', t0: 39.6, t1: 40, scene: 'black', fn(S) { S.fade = 0; } },
    // ignition + time-lapse: the world turns again
    { name: 'timelapse', t0: 40, t1: 48, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const e = sine(u);
      const p = V.lerp([-310, 128, -262], [-262, 116, -214], e);
      look(S, p, V.lerp([60, 76, 40], [60, 80, 40], e), 52, 0.0);
      const x = T - 40;
      S.A[1] = 1; S.A[3] = smooth(0.0, 0.5, x);
      S.C[0] = x;
      S.white = Math.exp(-x * 5) * 0.9;
      S.flash = Math.exp(-x * 3) * 2;
      S.flashCol = [1, 0.85, 0.7];
      const ang = ringAngles(T); S.B[0] = ang[0]; S.B[1] = ang[1];
      applyTurningSky(S, T);
      shake(S, T, 0.006 * Math.exp(-x * 1.5) + 0.0006, 5);
      S.grade.rays = 0.3;
      S.grade.streak = 0.0;
      S.fog[3] = 0;
    } },
    // hero: the first sunrise in a thousand years
    { name: 'hero-sunrise', t0: 48, t1: 52, scene: 'twilight', fn(S, u, lt, T) {
      presetTwilight(S, T);
      const tx = -318, tz = 25;
      traveler(S, 'twilight', tx, tz, [1, -0.07], 0, lt, { lantern: 0.35 });
      const e = sine(u);
      const cx = tx - 7.5 + e * 1.2, cz = tz + 3.4 - e * 0.6;
      look(S, [cx, G('twilight', cx, cz) + 1.3 + e * 0.25, cz], [0, 58 + e * 3, -34], 30, -0.02);
      S.A[1] = 0.22; S.A[3] = 0.55; S.C[0] = 10;
      const ang = ringAngles(T); S.B[0] = ang[0]; S.B[1] = ang[1];
      const phi = 2 * Math.PI + PHI0 + lerp(0.5, 3.2, u) * D2R;
      S.sun = sunPath(phi);
      S.starRot = E.rotMat(SKY_AXIS, -(phi - PHI0));
      S.cloud[2] = 2.1 + T * 0.004;
      S.grade.rays = 0.45;
      S.grade.streak = 0.1;
      S.grade.exposure = 1.2;
      S.grade.wb = [1.08, 1.0, 0.9];
      S.fog[3] = 0.6;
      shake(S, T, 0.0008, 0.5);
      S.fade = 1 - smooth(51.9, 52.0, T) * 0;
    } },
    // title over the planet: sunrise from orbit
    { name: 'title', t0: 52, t1: 60.2, scene: 'planet', fn(S, u, lt, T) {
      presetPlanet(S, T);
      const sun = V.norm([0, 0.22, -1]);
      S.planet.sun0 = V.norm([1, 0.06, -0.28]);
      S.sun = sun;
      S.planet.A = [lerp(0.0, 0.05, u), 1, 0.3 + lt * 0.03, 1.15];
      S.planet.B = [2.2, 0, 0, 0];
      const e = outCubic(smooth(52.0, 58.5, T));
      look(S, [0, lerp(0.3, 0.5, e), 2.6], [0, lerp(1.1, 1.2, e), 0], 30, 0);
      S.grade.streak = 0.05; S.grade.bloom = 0.045;
      S.fade = smooth(52.0, 52.5, T) * (1 - smooth(59.5, 60.2, T));
    } },
    // stinger: the night looks back
    { name: 'stinger', t0: 60.2, t1: 63.4, scene: 'ice', fn(S, u, lt, T) {
      presetIce(S, T);
      titan(S, 0, 100);
      const tz = -30;
      traveler(S, 'ice', 0.6, tz, [0, 1], 0, lt, { lantern: 1.4, lanOff: [-0.28, 1.02, 0.22] });
      look(S, [-1.2, 1.5, tz - 5.5 + u * 0.8], [0, lerp(260, 300, u), 1350], 38, 0.0);
      S.A[0] = 0.04; S.moon = E.dirEA(-10, 70); S.moonLight = 0.02; S.atmo.moonI = 0.02; S.night = 0.5;
      S.D[0] = smooth(62.35, 62.85, T);
      S.D[1] = 0.4; S.fog[3] = 0.3;
      S.grade.exposure = 2.6;
      S.fade = smooth(60.2, 61.3, T);
      shake(S, T, 0.0008 + 0.004 * smooth(62.35, 62.6, T) * (1 - smooth(62.6, 63.2, T)), 4);
    } },
    { name: 'end-black', t0: 63.4, t1: 70, scene: 'black', fn(S) { S.fade = 0; } },
  ];

  const Timeline = (window.Timeline = {
    shots: SHOTS,
    warmTimes: [2, 7, 12, 20, 33.3, 44, 55, 62],
    init(ground) { GR = ground; },
    state(t) {
      let sh = SHOTS[SHOTS.length - 1];
      for (const s of SHOTS) if (t >= s.t0 && t < s.t1) { sh = s; break; }
      const S = base(sh.scene);
      S.name = sh.name;
      S.lt = t - sh.t0;
      const u = clamp((t - sh.t0) / (sh.t1 - sh.t0), 0, 1);
      sh.fn(S, u, S.lt, t);
      return S;
    },
  });
})();
