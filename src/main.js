// Bootstrap, render pipeline, audio-synced clock, controls.
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const PARAM = {
    t: parseFloat(qs.get('t') || '0') || 0,
    freeze: qs.has('freeze'),
    mute: qs.has('mute') || qs.has('freeze'),
    debug: qs.has('debug'),
    scale: qs.has('scale') ? parseFloat(qs.get('scale')) : 0,
    bench: qs.has('bench'),
    cam: qs.has('cam') ? qs.get('cam').split(',').map(Number) : null,
    ov: qs.has('ov') ? qs.get('ov').split(',').map((kv) => { const [k, v] = kv.split(':'); return [k, parseFloat(v)]; }) : null,
  };
  const END = 65.5;
  const canvas = document.getElementById('c');
  const gate = document.getElementById('gate');
  const hud = document.getElementById('hud');
  const textCanvas = document.createElement('canvas');
  const tctx = textCanvas.getContext('2d');
  let gl;
  // GPU resets are rare but must not end the show: restart from the same moment.
  function restartAt(t) {
    const n = parseInt(qs.get('retry') || '0', 10);
    if (n >= 3) return false;
    qs.set('retry', String(n + 1));
    qs.set('t', Math.max(0, t).toFixed(2));
    location.replace(location.pathname + '?' + qs.toString());
    return true;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    console.log('CONTEXT LOST at', Math.round(performance.now()));
    e.preventDefault();
    if (Clock.ctl) Clock.ctl.stop();
    setTimeout(() => restartAt(Clock.vt), 300);
  });
  try { gl = GLX.init(canvas); } catch (e) { fatal(e.message); return; }

  function fatal(msg) {
    gate.style.display = 'flex';
    gate.style.whiteSpace = 'pre-wrap';
    gate.style.textTransform = 'none';
    gate.style.letterSpacing = '0';
    gate.style.font = '13px monospace';
    gate.textContent = msg;
    console.error(msg);
    document.title = 'error';
  }

  // ---------------------------------------------------------------- programs
  const P = {
    sky: GLX.program(gl, SH.skyLut, 'sky'),
    planet: GLX.program(gl, SH.buildPlanet(), 'planet'),
    twilight: GLX.program(gl, SH.buildWorld('twilight'), 'twilight'),
    desert: GLX.program(gl, SH.buildWorld('desert'), 'desert'),
    ice: GLX.program(gl, SH.buildWorld('ice'), 'ice'),
    probe_twilight: GLX.program(gl, SH.buildProbe('twilight'), 'probe_twilight'),
    probe_desert: GLX.program(gl, SH.buildProbe('desert'), 'probe_desert'),
    probe_ice: GLX.program(gl, SH.buildProbe('ice'), 'probe_ice'),
    down: GLX.program(gl, SH.down, 'down'),
    up: GLX.program(gl, SH.up, 'up'),
    streakPre: GLX.program(gl, SH.streakPre, 'streakPre'),
    streakBlur: GLX.program(gl, SH.streakBlur, 'streakBlur'),
    rays: GLX.program(gl, SH.rays, 'rays'),
    composite: GLX.program(gl, SH.composite, 'composite'),
  };

  // ---------------------------------------------------------------- ground probe
  const PROBE_N = 256;
  const Ground = (window.Ground = {
    boxes: { twilight: [-1700, -1200, 900, 1200], desert: [-700, -300, 700, 1500], ice: [-1600, -400, 1600, 2600] },
    data: {},
    h(world, x, z) {
      const g = this.data[world];
      if (!g) return 0;
      const b = this.boxes[world];
      const fx = E.clamp(((x - b[0]) / (b[2] - b[0])) * (PROBE_N - 1), 0, PROBE_N - 1.001);
      const fz = E.clamp(((z - b[1]) / (b[3] - b[1])) * (PROBE_N - 1), 0, PROBE_N - 1.001);
      const ix = Math.floor(fx), iz = Math.floor(fz), ux = fx - ix, uz = fz - iz;
      const at = (i, j) => g[(j * PROBE_N + i) * 4];
      return (at(ix, iz) * (1 - ux) + at(ix + 1, iz) * ux) * (1 - uz) + (at(ix, iz + 1) * (1 - ux) + at(ix + 1, iz + 1) * ux) * uz;
    },
    // max ground height along a segment (for safe camera heights)
    maxAlong(world, a, b, n) {
      let m = -1e9;
      for (let i = 0; i <= n; i++) { const t = i / n; m = Math.max(m, this.h(world, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)); }
      return m;
    },
  });
  function runProbes() {
    const rt = GLX.target(gl, PROBE_N, PROBE_N, { f32: true });
    for (const w of ['twilight', 'desert', 'ice']) {
      GLX.draw(gl, P['probe_' + w], rt, { uRes: [PROBE_N, PROBE_N], uBox: Ground.boxes[w] });
      const buf = new Float32Array(PROBE_N * PROBE_N * 4);
      gl.readPixels(0, 0, PROBE_N, PROBE_N, gl.RGBA, gl.FLOAT, buf);
      Ground.data[w] = buf;
    }
    GLX.free(gl, rt);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------------------------------------------------------------- targets
  let T = null; // render targets
  let rect = [0, 0, 1, 1];
  let scale = PARAM.scale || 0.85;
  let textTex = null, blankTex = null;
  const sky = { t: null };

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.round(window.innerWidth * dpr));
    const H = Math.max(2, Math.round(window.innerHeight * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const A = 2.39;
    let rw, rh;
    if (W / H > A) { rh = H; rw = Math.round(H * A); } else { rw = W; rh = Math.round(W / A); }
    rect = [Math.round((W - rw) / 2), Math.round((H - rh) / 2), rw, rh];
    if (textCanvas.width !== rw || textCanvas.height !== rh) { textCanvas.width = rw; textCanvas.height = rh; }
  }

  function buildTargets() {
    if (T) { for (const k in T) if (Array.isArray(T[k])) T[k].forEach((x) => GLX.free(gl, x)); else GLX.free(gl, T[k]); }
    const w = Math.max(64, Math.round(rect[2] * scale)), h = Math.max(32, Math.round(rect[3] * scale));
    T = { hdr: GLX.target(gl, w, h), mips: [] };
    let mw = w, mh = h;
    for (let i = 0; i < 6; i++) { mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1); T.mips.push(GLX.target(gl, mw, mh)); }
    const sw = Math.max(8, w >> 2), sh = Math.max(4, h >> 3);
    T.streakA = GLX.target(gl, sw, sh);
    T.streakB = GLX.target(gl, sw, sh);
    T.rays = GLX.target(gl, Math.max(8, w >> 2), Math.max(8, h >> 2));
    T.w = w; T.h = h; T.scale = scale;
    if (!sky.t) sky.t = GLX.target(gl, 256, 128, { repeatS: true });
  }

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ---------------------------------------------------------------- clock
  const Clock = {
    ctx: null, ctl: null, startCtx: 0, offset: PARAM.t, vt: PARAM.t, last: performance.now(), paused: false,
    audioTime() {
      const c = this.ctx;
      if (!c || c.state !== 'running') return null;
      let ct;
      if (c.getOutputTimestamp) {
        const ts = c.getOutputTimestamp();
        if (ts.contextTime > 0 && ts.performanceTime > 0) ct = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      if (ct === undefined) ct = c.currentTime - (c.outputLatency || c.baseLatency || 0);
      return ct - this.startCtx + this.offset;
    },
    now() {
      const pn = performance.now();
      let dt = (pn - this.last) / 1000;
      this.last = pn;
      if (PARAM.freeze) return this.vt;
      if (this.paused) dt = 0;
      this.vt += Math.min(dt, 0.1);
      const at = this.audioTime();
      if (at !== null && !this.paused) {
        const err = at - this.vt;
        if (Math.abs(err) > 0.25) this.vt = at; else this.vt += err * 0.1;
      }
      return this.vt;
    },
  };

  async function startAudio() {
    if (PARAM.mute || !window.TrailerAudio) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      let ctx;
      try { ctx = new AC({ sampleRate: 48000, latencyHint: 'playback' }); } catch (_) { ctx = new AC({ latencyHint: 'playback' }); }
      if (ctx.state !== 'running') {
        await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
      }
      if (ctx.state !== 'running') { ctx.close(); return false; }
      Clock.ctx = ctx;
      Clock.ctl = TrailerAudio.create(ctx);
      Clock.startCtx = ctx.currentTime + 0.25;
      Clock.ctl.start(Clock.startCtx, PARAM.t);
      Clock.vt = PARAM.t - 0.25;
      Clock.last = performance.now();
      return true;
    } catch (e) {
      console.error('audio', e);
      return true;
    }
  }

  // ---------------------------------------------------------------- frame
  const I3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  let frameTimes = [], lastFrame = 0, lastAdapt = 0, frames = 0;
  let textWasActive = false;

  function renderWorld(S, t) {
    const at = S.atmo;
    GLX.draw(gl, P.sky, sky.t, {
      uSunDir: S.sun, uMoonDir: S.moon, uSunI: at.sunI, uMoonI: at.moonI, uMie: at.mie, uRay: at.ray,
      uMieG: at.g, uAlt: 100, uTint: at.tint,
    });
    const tr = E.transmittance(S.sun, at.ray, at.mie, 100);
    const trm = E.transmittance(S.moon, at.ray, at.mie, 100);
    const sunCol = tr.map((v, i) => v * S.sunLight * at.tint[i]);
    const moonCol = trm.map((v, i) => v * S.moonLight * [0.72, 0.84, 1.0][i]);
    GLX.draw(gl, P[S.scene], T.hdr, {
      uRes: [T.w, T.h], uTime: t, uShotT: S.lt,
      uCamPos: S.cam.pos, uCamTar: S.cam.tar, uFov: S.cam.fov, uRoll: S.cam.roll || 0,
      uSky: sky.t.tex, uSunDir: S.sun, uSunCol: sunCol, uMoonDir: S.moon, uMoonCol: moonCol,
      uStarRot: S.starRot || I3, uNight: S.night,
      uA: S.A, uB: S.B, uC: S.C, uD: S.D, uCloud: S.cloud, uFog: S.fog,
      uTravPos: S.trav.pos, uTrav: [S.trav.facing, S.trav.phase, S.trav.gait, S.trav.mode],
      uLanternOff: S.lantern.off, uLanternI: S.lantern.I, uAmbK: S.ambK,
      uFlash: S.flash, uFlashCol: S.flashCol, uHeat: S.heat,
    });
  }

  function renderPlanet(S, t) {
    GLX.draw(gl, P.planet, T.hdr, {
      uRes: [T.w, T.h], uTime: t, uShotT: S.lt,
      uCamPos: S.cam.pos, uCamTar: S.cam.tar, uFov: S.cam.fov, uRoll: S.cam.roll || 0,
      uSunDir: S.sun, uSunCol: S.planet.sunCol, uMoonDir: [0, -1, 0], uMoonCol: [0, 0, 0],
      uStarRot: S.starRot || I3, uNight: 1,
      uA: S.planet.A, uB: S.planet.B, uSun0: S.planet.sun0, uSky: sky.t.tex,
    });
  }

  function post(S, t, textActive, textGlow) {
    const G = S.grade;
    // bloom chain
    let src = T.hdr;
    for (let i = 0; i < T.mips.length; i++) {
      const dst = T.mips[i];
      GLX.draw(gl, P.down, dst, {
        uRes: [dst.w, dst.h], uSrc: src.tex, uSrcTexel: [1 / src.w, 1 / src.h], uFirst: i === 0 ? 1 : 0,
        uText: textActive ? textTex : blankTex, uTextGlow: textGlow,
      });
      src = dst;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = T.mips.length - 2; i >= 0; i--) {
      const s = T.mips[i + 1], dst = T.mips[i];
      GLX.draw(gl, P.up, dst, { uRes: [dst.w, dst.h], uSrc: s.tex, uSrcTexel: [1 / s.w, 1 / s.h] });
    }
    gl.disable(gl.BLEND);
    // anamorphic streak
    if (G.streak > 0) {
      GLX.draw(gl, P.streakPre, T.streakA, { uRes: [T.streakA.w, T.streakA.h], uSrc: T.mips[1].tex, uThresh: G.streakThresh });
      let a = T.streakA, b = T.streakB;
      for (const st of [1, 3, 9, 27]) {
        GLX.draw(gl, P.streakBlur, b, { uRes: [b.w, b.h], uSrc: a.tex, uSrcTexel: [1 / a.w, 1 / a.h], uStep: st });
        const tmp = a; a = b; b = tmp;
      }
      T.streakOut = a;
    } else T.streakOut = T.streakA;
    // god rays
    if (G.rays > 0 && S.sunUV) {
      GLX.draw(gl, P.rays, T.rays, {
        uRes: [T.rays.w, T.rays.h], uSrc: T.hdr.tex, uSunUV: S.sunUV, uThresh: G.raysThresh, uCap: 4.0,
        uDensity: G.raysDensity, uDecay: 0.972, uAspect: T.w / T.h,
      });
    }
    // composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    GLX.draw(gl, P.composite, null, {
      uHdr: T.hdr.tex, uBloom: T.mips[0].tex, uStreak: T.streakOut.tex, uRays: T.rays.tex,
      uText: textActive ? textTex : blankTex, uRect: rect,
      uExposure: G.exposure, uBloomK: G.bloom, uStreakK: G.streak, uRaysK: G.rays > 0 && S.sunUV ? G.rays : 0,
      uCA: G.ca, uGrain: G.grain, uVig: G.vig, uFade: S.fade, uWhite: S.white, uSat: G.sat, uContrast: G.contrast,
      uTime: t, uWB: G.wb, uLift: G.lift, uGain: G.gain, uStreakTint: G.streakTint,
    }, rect);
  }

  function sunScreenUV(S) {
    const f = V.norm(V.sub(S.cam.tar, S.cam.pos));
    let r = V.norm(V.cross(f, [0, 1, 0]));
    let u = V.cross(r, f);
    const roll = S.cam.roll || 0;
    const r2 = V.add(V.mul(r, Math.cos(roll)), V.mul(u, Math.sin(roll)));
    u = V.cross(r2, f); r = r2;
    const d = S.sunScreenDir || S.sun;
    const z = V.dot(d, f);
    if (z <= 0.05) return null;
    const fl = 1 / Math.tan((S.cam.fov * Math.PI) / 360);
    const aspect = rect[2] / rect[3];
    const x = (V.dot(d, r) / z) * fl, y = (V.dot(d, u) / z) * fl;
    return [0.5 + x / aspect / 2, 0.5 + y / 2];
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dtms = lastFrame ? now - lastFrame : 16;
    lastFrame = now;
    let t = Clock.now();
    layout();
    if (!T || T.w !== Math.max(64, Math.round(rect[2] * scale)) || T.h !== Math.max(32, Math.round(rect[3] * scale))) buildTargets();

    if (t >= END) {
      if (PARAM.bench) bench(t, dtms, { name: 'end' });
      drawEnd(t);
      return;
    }
    const benchT0 = performance.now();
    const S = Timeline.state(Math.max(0, t));
    if (PARAM.ov) for (const [k, v] of PARAM.ov) { const ks = k.split('.'); let o = S; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; }
    if (PARAM.cam) S.cam = { pos: PARAM.cam.slice(0, 3), tar: PARAM.cam.slice(3, 6), fov: PARAM.cam[6] || 40, roll: 0 };
    S.sunUV = S.grade.rays > 0 ? sunScreenUV(S) : null;
    if (S.scene === 'black') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.hdr.fb);
      gl.viewport(0, 0, T.w, T.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else if (S.scene === 'planet') renderPlanet(S, t);
    else renderWorld(S, t);

    const tx = Titles.draw(tctx, t, textCanvas.width, textCanvas.height);
    if (tx.active) {
      gl.bindTexture(gl.TEXTURE_2D, textTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    textWasActive = tx.active;
    post(S, t, tx.active, tx.glow);
    let gpuMs = dtms;
    if (PARAM.bench) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, benchPx); gpuMs = performance.now() - benchT0; }

    frames++;
    if (frames === 3) document.title = 'MERIDIAN';
    if (frames === 3 && PARAM.freeze) document.title = 'READY';
    // adaptive resolution
    if (!PARAM.scale && !PARAM.freeze) {
      frameTimes.push(dtms);
      if (frameTimes.length > 40) frameTimes.shift();
      if (now - lastAdapt > 700 && frameTimes.length >= 20) {
        const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        let ns = scale;
        if (avg > 18.5) ns = Math.max(0.45, scale * (avg > 30 ? 0.8 : 0.9));
        else if (avg < 10.5) ns = Math.min(1, scale * 1.06);
        if (Math.abs(ns - scale) > 0.01) { scale = ns; frameTimes = []; }
        lastAdapt = now;
      }
    }
    if (PARAM.debug) {
      hud.style.display = 'block';
      hud.textContent = `t ${t.toFixed(2)}  ${S.name || ''}\n${(1000 / dtms).toFixed(0)} fps  scale ${scale.toFixed(2)}  ${T.w}x${T.h}`;
    }
    if (PARAM.bench) bench(t, gpuMs, S);
  }

  const benchStats = {};
  const benchPx = new Uint8Array(4);
  let benchLast = -1;
  function bench(t, dtms, S) {
    if (Math.floor(t / 3) !== benchLast) { benchLast = Math.floor(t / 3); console.log('BT', t.toFixed(2), S.name, dtms.toFixed(1), 'ms', T.w + 'x' + T.h); }
    const k = S.name || S.scene;
    (benchStats[k] = benchStats[k] || []).push(dtms);
    if (t >= END && !benchStats.done) {
      benchStats.done = true;
      for (const n in benchStats) if (n !== 'done') {
        const a = benchStats[n].slice(3).sort((x, y) => x - y);
        if (a.length) console.log('BENCH', n.padEnd(16), 'median', a[a.length >> 1].toFixed(1), 'p90', a[Math.floor(a.length * 0.9)].toFixed(1), 'n', a.length);
      }
      console.log('BENCH_DONE scale', scale.toFixed(2), T.w + 'x' + T.h);
    }
  }

  function drawEnd(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const a = E.smooth(END + 0.8, END + 2.2, t);
    gate.style.display = 'flex';
    gate.style.opacity = a.toFixed(3);
    gate.textContent = 'R — смотреть ещё раз   ·   Esc — выход';
  }

  // ---------------------------------------------------------------- controls
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { try { window.close(); } catch (_) {} }
    else if (e.code === 'KeyR') { location.search = ''; location.reload(); }
    else if (e.code === 'KeyD') { PARAM.debug = !PARAM.debug; hud.style.display = PARAM.debug ? 'block' : 'none'; }
    else if (e.code === 'KeyF') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    else if (e.code === 'Space' && Clock.ctx) {
      if (Clock.paused) { Clock.ctx.resume(); Clock.paused = false; } else { Clock.ctx.suspend(); Clock.paused = true; }
    }
  });

  // ---------------------------------------------------------------- boot
  function waitCompile() {
    return new Promise((resolve, reject) => {
      const names = Object.keys(P);
      const tick = () => {
        try {
          if (names.every((n) => GLX.ready(P[n]))) { names.forEach((n) => GLX.finish(P[n])); resolve(); }
          else setTimeout(tick, 30);
        } catch (e) { reject(e); }
      };
      tick();
    });
  }

  async function boot() {
    gate.style.display = 'flex';
    gate.textContent = 'MERIDIAN';
    gate.style.opacity = '0.35';
    layout();
    const t0 = performance.now();
    try { await waitCompile(); } catch (e) {
      const emptyLog = /:\s*$/.test(String(e.message).split(String.fromCharCode(10))[0]);
      if ((gl.isContextLost() || emptyLog) && restartAt(PARAM.t)) return;
      fatal(e.message + (gl.isContextLost() ? ' [context lost]' : '')); return;
    }
    console.log('compiled ms', Math.round(performance.now() - t0));
    runProbes();
    buildTargets();
    textTex = makeTex();
    blankTex = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    Timeline.init(Ground);
    // warm-up: draw each heavy program once at tiny size so drivers finish compiling before playback
    const warm = GLX.target(gl, 16, 8);
    const saved = T.hdr; T.hdr = warm; const sw = T.w, sh = T.h; T.w = 16; T.h = 8;
    for (const tt of Timeline.warmTimes) {
      const S = Timeline.state(tt);
      if (S.scene === 'planet') renderPlanet(S, tt); else if (S.scene !== 'black') renderWorld(S, tt);
    }
    gl.finish();
    T.hdr = saved; T.w = sw; T.h = sh; GLX.free(gl, warm);
    console.log('compile+warm ms', Math.round(performance.now() - t0));
    gate.style.display = 'none';
    gate.style.opacity = '1';
    let ok = await startAudio();
    if (!ok) {
      gate.style.display = 'flex';
      gate.textContent = 'Нажмите, чтобы начать';
      await new Promise((r) => {
        const go = () => { window.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go); r(); };
        window.addEventListener('pointerdown', go);
        window.addEventListener('keydown', go);
      });
      gate.style.display = 'none';
      await startAudio();
    }
    Clock.last = performance.now();
    requestAnimationFrame(frame);
  }
  boot();
})();
