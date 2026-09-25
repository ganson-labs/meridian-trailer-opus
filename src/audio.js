/*
 * MERIDIAN — trailer score and sound design.
 *
 * Every sound is synthesized at runtime with the Web Audio API: oscillators,
 * procedurally generated noise, a generated reverb impulse response, filters
 * and waveshapers. No samples, no audio files, no libraries.
 *
 *   window.TrailerAudio = { DURATION, create(ctx) -> controller }
 *   controller.start(ctxTime, offset)        realtime, lookahead scheduler
 *   controller.scheduleAll(ctxTime, offset)  offline render (call before startRendering;
 *                                            fed via suspend() points when available)
 *   controller.stop()                        fast fade-out, stops all voices
 *   controller.setVolume(v)                  master volume 0..1
 *   controller.stats()                       voice counters for diagnostics
 *
 * Trailer time T maps to context time ctxTime + (T - offset).
 * Key: D minor, 120 BPM (beat 0.5 s, bar 2 s).
 */
(function (root) {
  'use strict';

  var DURATION = 65.5;
  var LOOKAHEAD = 1.2;
  var TICK_MS = 50;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  function create(ctx) {
    var sr = ctx.sampleRate;
    var nrng = mulberry32(0x5EED01);
    var stats = { alive: 0, alivePeak: 0, sources: 0, spans: [], errors: [] };
    var live = new Set();

    // ------------------------------------------------------------------ buffers
    var XF = 4096;
    function noiseBuffer(kind, seconds, seed) {
      var len = Math.floor(sr * seconds);
      var buf = ctx.createBuffer(2, len, sr);
      for (var ch = 0; ch < 2; ch++) {
        var r = mulberry32(seed + ch * 7919);
        var raw = new Float32Array(len + XF);
        var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, lastIn = 0, lastOut = 0, i;
        var dcK = Math.exp(-2 * Math.PI * 25 / sr);
        for (i = 0; i < len + XF; i++) {
          var w = r() * 2 - 1, y;
          if (kind === 0) {
            y = w * 0.5;
          } else if (kind === 1) {
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
            b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
            y = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
          } else {
            // Brown noise, then a one-pole DC blocker (~25 Hz): no subsonic mud.
            last = (last + 0.02 * w) / 1.02;
            y = (last - lastIn) + dcK * lastOut; lastIn = last; lastOut = y;
            y *= 3.5;
          }
          raw[i] = y;
        }
        // Equal-power crossfade of the tail into the head: seamless loop.
        var d = buf.getChannelData(ch);
        for (i = 0; i < len; i++) d[i] = raw[i];
        for (i = 0; i < XF; i++) {
          var x = (i / XF) * Math.PI / 2;
          d[i] = raw[i] * Math.sin(x) + raw[len + i] * Math.cos(x);
        }
      }
      return buf;
    }

    // Hall reverb: exponentially decaying noise that darkens over time.
    function impulse(seconds, rt60, seed) {
      var len = Math.floor(sr * seconds), buf = ctx.createBuffer(2, len, sr);
      var pre = Math.floor(0.016 * sr);
      for (var ch = 0; ch < 2; ch++) {
        var r = mulberry32(seed + ch * 104729), d = buf.getChannelData(ch), lp = 0, i;
        var k0 = Math.exp(-2 * Math.PI * 11000 / sr);
        for (i = 0; i < len; i++) {
          if (i < pre) { d[i] = 0; continue; }
          var t = (i - pre) / sr, u = t / seconds;
          var fc = 11000 * Math.pow(1300 / 11000, Math.pow(u, 0.6));
          var k = Math.exp(-2 * Math.PI * fc / sr);
          lp += (1 - k) * ((r() * 2 - 1) - lp);
          var comp = Math.pow(((1 + k) / (1 - k)) * ((1 - k0) / (1 + k0)), 0.35);
          var on = Math.min(1, t / 0.025);
          d[i] = lp * comp * on * Math.exp(-6.9 * t / rt60);
        }
        var taps = [0.009, 0.016, 0.023, 0.031, 0.043, 0.056, 0.071];
        for (var j = 0; j < taps.length; j++) {
          var p = pre + Math.floor((taps[j] + r() * 0.004) * sr);
          d[p] += (r() < 0.5 ? -1 : 1) * 0.35 * Math.exp(-j * 0.3);
        }
      }
      return buf;
    }

    function tanhCurve(k) {
      var n = 2048, c = new Float32Array(n), dn = Math.tanh(k);
      for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / dn; }
      return c;
    }
    function safetyCurve() {
      var n = 4096, c = new Float32Array(n), knee = 0.7, ceil = 0.88;
      for (var i = 0; i < n; i++) {
        var x = i / (n - 1) * 2 - 1, ax = Math.abs(x);
        var y = ax <= knee ? ax : knee + (ceil - knee) * Math.tanh((ax - knee) / (ceil - knee));
        c[i] = x < 0 ? -y : y;
      }
      return c;
    }
    function softSaw(nh, roll) {
      var re = new Float32Array(nh + 1), im = new Float32Array(nh + 1);
      for (var n = 1; n <= nh; n++) im[n] = Math.exp(-n / roll) / n;
      return ctx.createPeriodicWave(re, im);
    }

    var WHITE = noiseBuffer(0, 6, 101), PINK = noiseBuffer(1, 6, 202), BROWN = noiseBuffer(2, 6, 303);
    var CURVE_SOFT = tanhCurve(1.5), CURVE_HOT = tanhCurve(3.2), CURVE_GRIT = tanhCurve(5);
    var WAVE_CHOIR = softSaw(40, 14);

    // --------------------------------------------------------------- mix bus
    var volNode = ctx.createGain();
    var fadeNode = ctx.createGain();
    var safety = ctx.createWaveShaper(); safety.curve = safetyCurve(); safety.oversample = '2x';
    var trim = ctx.createGain(); trim.gain.value = 0.9;
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.12;
    var glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -12; glue.knee.value = 6; glue.ratio.value = 2;
    glue.attack.value = 0.03; glue.release.value = 0.3;
    // 4th-order high-pass at 30 Hz: keeps sub weight, drops inaudible rumble.
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.54;
    var hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 30; hp2.Q.value = 1.31;
    var pre = ctx.createGain(); pre.gain.value = 0.6;
    var presence = ctx.createBiquadFilter(); presence.type = 'highshelf'; presence.frequency.value = 2800; presence.gain.value = 4;
    pre.connect(hp); hp.connect(hp2); hp2.connect(presence); presence.connect(glue); glue.connect(lim); lim.connect(trim);
    trim.connect(safety); safety.connect(fadeNode); fadeNode.connect(volNode); volNode.connect(ctx.destination);

    function busTo(g, dest) { var n = ctx.createGain(); n.gain.value = g; n.connect(dest); return n; }
    var NORMAL = { music: 0.62, sfx: 0.65, amb: 0.9, verb: 0.75 };
    var busMusic = busTo(NORMAL.music, pre);
    var busSfx = busTo(NORMAL.sfx, pre);
    var busAmb = busTo(NORMAL.amb, pre);
    var busDry = busTo(0.9, pre);
    var drumOut = busTo(0.5, busMusic);
    var drumShaper = ctx.createWaveShaper(); drumShaper.curve = CURVE_SOFT; drumShaper.connect(drumOut);
    var busDrum = busTo(0.85, drumShaper);

    var verbIn = ctx.createGain();
    var verbHP = ctx.createBiquadFilter(); verbHP.type = 'highpass'; verbHP.frequency.value = 170;
    var conv = ctx.createConvolver(); conv.buffer = impulse(4.8, 4.2, 909);
    var verbOut = busTo(NORMAL.verb, pre);
    verbIn.connect(verbHP); verbHP.connect(conv); conv.connect(verbOut);
    var ducked = [[busMusic, 'music'], [busSfx, 'sfx'], [busAmb, 'amb'], [verbOut, 'verb']];

    // ---------------------------------------------------------------- voices
    function Voice() { this.n = []; this.s = []; this.pending = 0; live.add(this); }
    Voice.prototype.add = function (node) { this.n.push(node); return node; };
    Voice.prototype.run = function (src, t0, t1, off) {
      var self = this;
      if (t1 <= t0) t1 = t0 + 0.01;
      this.s.push(src); this.pending++;
      stats.sources++; stats.alive++;
      if (stats.alive > stats.alivePeak) stats.alivePeak = stats.alive;
      stats.spans.push(t0, t1);
      src.onended = function () {
        stats.alive--;
        if (--self.pending === 0) self.dispose();
      };
      if (off != null) src.start(t0, off); else src.start(t0);
      src.stop(t1);
      return src;
    };
    Voice.prototype.halt = function (t) {
      for (var i = 0; i < this.s.length; i++) { try { this.s[i].stop(t); } catch (e) { /* already stopped */ } }
    };
    Voice.prototype.dispose = function () {
      live.delete(this);
      var all = this.s.concat(this.n);
      for (var i = 0; i < all.length; i++) { try { all[i].disconnect(); } catch (e) { /* ignore */ } }
      this.s.length = 0; this.n.length = 0;
    };

    function gain(v, g) { var n = ctx.createGain(); n.gain.value = g == null ? 1 : g; return v.add(n); }
    function filt(v, type, f, q) {
      var n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f;
      if (q != null) n.Q.value = q;
      return v.add(n);
    }
    function panner(v, p) { var n = ctx.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return v.add(n); }
    function shaper(v, curve) { var n = ctx.createWaveShaper(); n.curve = curve; return v.add(n); }
    function osc(v, type, f, t0, t1, det) {
      var o = ctx.createOscillator();
      if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
      o.frequency.value = f;
      if (det) o.detune.value = det;
      v.run(o, t0, t1);
      return o;
    }
    function noise(v, buf, t0, t1) {
      var s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      v.run(s, t0, t1, nrng() * (buf.duration - 0.1));
      return s;
    }
    function out(v, node, bus, verb) {
      node.connect(bus);
      if (verb) { var s = gain(v, verb); node.connect(s); s.connect(verbIn); }
    }
    function sv(p, x, t) { p.setValueAtTime(x, t); }
    function lr(p, x, t) { p.linearRampToValueAtTime(x, t); }
    function er(p, x, t) { p.exponentialRampToValueAtTime(Math.max(x, 1e-4), t); }
    function st(p, x, t, tau) { p.setTargetAtTime(x, t, Math.max(tau, 0.001)); }
    // Attack-hold-release envelope on a gain param; hard=true cuts in 10 ms.
    function ahr(p, level, t, att, t1, rel, hard) {
      sv(p, 0, t); lr(p, level, t + att); sv(p, level, Math.max(t1, t + att));
      if (hard) lr(p, 0, Math.max(t1, t + att) + 0.01);
      else st(p, 0, Math.max(t1, t + att), rel / 4);
    }

    // ----------------------------------------------------------- instruments
    // Felt piano: inharmonic additive partials, two-stage decay, hammer noise.
    function piano(t, m, vel, dur, o) {
      o = o || {};
      var v = new Voice(), f = mtof(m);
      var lp = filt(v, 'lowpass', Math.min(9000, f * (2.5 + 5 * vel) + 500), 0.5);
      var body = gain(v, (o.level != null ? o.level : 0.3) * vel);
      var pan = panner(v, clamp((m - 62) / 36, -0.5, 0.5) + (o.pan || 0));
      lp.connect(body); body.connect(pan);
      out(v, pan, o.bus || busMusic, o.verb != null ? o.verb : 0.5);
      var rel = o.rel || 0.4;
      var tauB = clamp(2.8 * Math.pow(262 / f, 0.55), 0.6, 7);
      var ts = Math.max(t + dur, t + 0.3);
      var stopT = Math.min(t + tauB * 6, ts + rel * 2) + 0.05;
      var np = f > 1400 ? 3 : f > 700 ? 5 : 8;
      for (var n = 1; n <= np; n++) {
        var fn = f * n * Math.sqrt(1 + 0.00035 * n * n);
        if (fn > 14000) break;
        var amp = Math.pow(n, -1.45) * (n === 1 ? 1 : 0.55 + 0.45 * vel);
        var tau = tauB / (1 + 0.8 * (n - 1));
        var g = gain(v, 0);
        sv(g.gain, 0, t); lr(g.gain, amp, t + 0.005);
        st(g.gain, amp * 0.5, t + 0.005, 0.1);
        st(g.gain, 0, t + 0.28, tau);
        st(g.gain, 0, ts, rel / 3);
        var no = n <= 2 ? 2 : 1;
        for (var k = 0; k < no; k++) osc(v, 'sine', fn, t, stopT, no === 2 ? (k ? 1.4 : -1.4) : 0).connect(g);
        g.connect(lp);
      }
      var hn = noise(v, WHITE, t, t + 0.06);
      var hb = filt(v, 'bandpass', Math.min(6000, f * 3), 0.8), hg = gain(v, 0);
      sv(hg.gain, 0.09 * vel, t); st(hg.gain, 0, t, 0.01);
      hn.connect(hb); hb.connect(hg); hg.connect(lp);
    }

    // Warm pad: three detuned sawtooth layers (L/C/R) through swept lowpass.
    function pad(t, dur, notes, o) {
      o = o || {};
      var v = new Voice();
      var lvl = (o.level || 0.1) / Math.sqrt(notes.length * 3);
      var att = Math.min(o.att || 1.5, dur), rel = o.rel || 1.5;
      var c0 = o.c0 || 200, c1 = o.c1 || 1400, c2 = o.c2 || 700;
      var amp = gain(v, 0);
      ahr(amp.gain, lvl, t, att, t + dur, rel, o.hard);
      var stopT = t + dur + (o.hard ? 0.05 : rel * 1.3);
      out(v, amp, busMusic, o.verb != null ? o.verb : 0.45);
      var sides = [-0.65, 0, 0.65], dets = [-11, 0, 10];
      for (var s = 0; s < 3; s++) {
        var lp = filt(v, 'lowpass', c0, o.q || 0.7), pn = panner(v, sides[s] * (o.width || 1));
        lp.connect(pn); pn.connect(amp);
        sv(lp.frequency, c0, t); er(lp.frequency, c1, t + att); er(lp.frequency, c2, stopT);
        for (var i = 0; i < notes.length; i++) {
          osc(v, o.shape || 'sawtooth', mtof(notes[i]), t, stopT, dets[s] + (nrng() - 0.5) * 5).connect(lp);
        }
      }
    }

    // Choir "aah": soft saws with ensemble vibrato through vowel formants.
    var FORMANTS = [[800, 6, 3.0], [1150, 7, 1.9], [2900, 9, 1.9], [3900, 11, 1.0]];
    function choir(t, dur, notes, o) {
      o = o || {};
      var v = new Voice();
      var lvl = (o.level || 0.15) / Math.sqrt(notes.length * 3);
      var att = Math.min(o.att || 0.6, dur), rel = o.rel || 1.2;
      var amp = gain(v, 0);
      ahr(amp.gain, lvl, t, att, t + dur, rel, o.hard);
      var stopT = t + dur + (o.hard ? 0.05 : rel * 1.3);
      out(v, amp, busMusic, o.verb != null ? o.verb : 0.6);
      var ins = [];
      for (var s = 0; s < 2; s++) {
        var inp = gain(v, 1), pn = panner(v, s ? 0.55 : -0.55);
        for (var j = 0; j < FORMANTS.length; j++) {
          var bp = filt(v, 'bandpass', FORMANTS[j][0] * (s ? 1.03 : 0.97), FORMANTS[j][1]);
          var fg = gain(v, FORMANTS[j][2]);
          inp.connect(bp); bp.connect(fg); fg.connect(pn);
        }
        var blp = filt(v, 'lowpass', 650, 0.7), bg = gain(v, 0.35);
        inp.connect(blp); blp.connect(bg); bg.connect(pn);
        pn.connect(amp);
        ins.push(inp);
      }
      var lfo = [];
      for (var k = 0; k < 3; k++) {
        var l = osc(v, 'sine', 4.6 + k * 0.55 + nrng() * 0.2, t, stopT);
        var lg = gain(v, 0); sv(lg.gain, 0, t); lr(lg.gain, 11, t + Math.min(0.9, dur));
        l.connect(lg); lfo.push(lg);
      }
      var dets = [-13, 0, 12];
      for (var i = 0; i < notes.length; i++) {
        for (k = 0; k < 3; k++) {
          var o1 = osc(v, WAVE_CHOIR, mtof(notes[i]), t, stopT, dets[k] + (nrng() - 0.5) * 6);
          lfo[k].connect(o1.detune);
          o1.connect(ins[(i + k) % 2]);
        }
      }
      var br = noise(v, PINK, t, stopT), brg = gain(v, 0.12);
      br.connect(brg); brg.connect(ins[0]); brg.connect(ins[1]);
    }

    // Staccato string note (ostinato).
    function strNote(t, m, vel, len, o) {
      o = o || {};
      var v = new Voice(), f = mtof(m);
      var lp = filt(v, 'lowpass', 500, 1.1), amp = gain(v, 0), pn = panner(v, o.pan || 0);
      sv(lp.frequency, 500, t); er(lp.frequency, 800 + 4200 * vel, t + 0.015); er(lp.frequency, 1100 + 2400 * vel, t + len + 0.1);
      var level = (o.level || 0.1) * vel;
      sv(amp.gain, 0, t); lr(amp.gain, level, t + 0.006);
      st(amp.gain, level * 0.55, t + 0.012, 0.06);
      st(amp.gain, 0, t + len, 0.025);
      var stopT = t + len + 0.2;
      osc(v, 'sawtooth', f, t, stopT, -8).connect(lp);
      osc(v, 'sawtooth', f, t, stopT, 8).connect(lp);
      lp.connect(amp); amp.connect(pn);
      out(v, pn, busMusic, 0.22);
    }

    // Legato line: cello / brass-string lead with delayed vibrato.
    function line(t, dur, m, o) {
      o = o || {};
      var v = new Voice(), f = mtof(m);
      var att = o.att || 0.25, rel = o.rel || 0.6;
      var amp = gain(v, 0);
      ahr(amp.gain, o.level || 0.1, t, att, t + dur, rel);
      var stopT = t + dur + rel * 1.3;
      var lp = filt(v, 'lowpass', o.cut || 1400, 0.9);
      var bump = filt(v, 'peaking', o.bump || 900, 1.2); bump.gain.value = 3;
      lp.connect(bump); bump.connect(amp);
      out(v, amp, busMusic, o.verb != null ? o.verb : 0.45);
      var lfo = osc(v, 'sine', 5.2 + nrng() * 0.4, t, stopT), lg = gain(v, 0);
      sv(lg.gain, 0, t); lr(lg.gain, o.vib || 12, t + Math.min(0.7, dur)); lfo.connect(lg);
      var dets = [-7, 7];
      for (var i = 0; i < 2; i++) {
        var o1 = osc(v, 'sawtooth', f, t, stopT, dets[i]); lg.connect(o1.detune);
        var pg = panner(v, i ? 0.3 : -0.3); o1.connect(pg); pg.connect(lp);
      }
      if (o.oct) {
        var o2 = osc(v, 'sawtooth', f / 2, t, stopT, 3); lg.connect(o2.detune);
        var og = gain(v, o.oct); o2.connect(og); og.connect(lp);
      }
    }

    // Taiko family: pitch-dropping body + membrane mode + skin noise + beater click.
    var DRUMS = {
      big:  { f0: 130, f1: 50, tau: 0.5, skin: 300, sg: 0.9, sd: 0.08, m2: 0.5 },
      low:  { f0: 170, f1: 68, tau: 0.3, skin: 450, sg: 1.0, sd: 0.05, m2: 0.35 },
      high: { f0: 330, f1: 178, tau: 0.12, skin: 1150, sg: 1.2, sd: 0.035, m2: 0.25 },
      rim:  { f0: 620, f1: 430, tau: 0.04, skin: 2500, sg: 1.0, sd: 0.02, m2: 0.1 }
    };
    function drum(t, vel, kind, o) {
      o = o || {};
      var P = DRUMS[kind], v = new Voice();
      var amp = gain(v, vel * (o.level || 1)), pn = panner(v, o.pan != null ? o.pan : (nrng() - 0.5) * 0.5);
      amp.connect(pn);
      out(v, pn, busDrum, o.verb != null ? o.verb : 0.3);
      var stopT = t + P.tau * 5.5 + 0.05;
      var b = osc(v, 'sine', P.f0, t, stopT), bg = gain(v, 0);
      sv(b.frequency, P.f0, t); er(b.frequency, P.f1 * 1.2, t + 0.05); er(b.frequency, P.f1, t + 0.45);
      sv(bg.gain, 0, t); lr(bg.gain, 1, t + 0.002); st(bg.gain, 0, t + 0.004, P.tau);
      b.connect(bg); bg.connect(amp);
      var b2 = osc(v, 'sine', P.f0 * 1.52, t, t + P.tau * 3), b2g = gain(v, 0);
      sv(b2.frequency, P.f0 * 1.52, t); er(b2.frequency, P.f1 * 1.55, t + 0.08);
      sv(b2g.gain, 0, t); lr(b2g.gain, P.m2, t + 0.002); st(b2g.gain, 0, t + 0.004, P.tau * 0.35);
      b2.connect(b2g); b2g.connect(amp);
      var sk = noise(v, WHITE, t, t + P.sd * 7), skf = filt(v, 'bandpass', P.skin, 0.9), skg = gain(v, 0);
      sv(skg.gain, P.sg, t); st(skg.gain, 0, t + 0.001, P.sd);
      sk.connect(skf); skf.connect(skg); skg.connect(amp);
      var cl = noise(v, WHITE, t, t + 0.04), clf = filt(v, 'highpass', 3000, 0.7), clg = gain(v, 0);
      sv(clg.gain, 0.3, t); st(clg.gain, 0, t + 0.001, 0.005);
      cl.connect(clf); clf.connect(clg); clg.connect(amp);
    }

    // Cinematic impact: sub drop + boom + crack + crash + inharmonic metal ring.
    var METAL = [1, 1.483, 2.117, 2.654, 3.301, 4.187, 5.66];
    function impact(t, size, o) {
      o = o || {};
      var v = new Voice(), s = size;
      var amp = gain(v, o.gain || 1), dest = amp;
      if (o.lp) { var olp = filt(v, 'lowpass', o.lp, 0.7); amp.connect(olp); dest = olp; }
      out(v, dest, o.bus || busSfx, o.verb != null ? o.verb : 0.55);
      var len = 1.0 + 3.0 * Math.min(1, s);
      var sub = osc(v, 'sine', o.f0 || 95, t, t + len), sg = gain(v, 0);
      sv(sub.frequency, o.f0 || 95, t); er(sub.frequency, o.f1 || 35, t + 0.3 + 1.2 * s);
      sv(sg.gain, 0, t); lr(sg.gain, 0.6 * Math.min(s, 1), t + 0.004); st(sg.gain, 0, t + 0.01, 0.3 + 0.4 * Math.min(s, 1.2));
      sub.connect(sg); sg.connect(amp);
      var bm = noise(v, BROWN, t, t + len), bf = filt(v, 'lowpass', 150, 0.8), bgn = gain(v, 0);
      sv(bgn.gain, 0.7 * s, t); st(bgn.gain, 0, t + 0.002, 0.2 + 0.35 * s);
      bm.connect(bf); bf.connect(bgn); bgn.connect(amp);
      var ck = o.crack != null ? o.crack : 1;
      if (ck > 0) {
        var cn = noise(v, WHITE, t, t + 0.4), cf = filt(v, 'highpass', 1100, 0.7), cg = gain(v, 0);
        sv(cg.gain, 0.5 * s * ck, t); st(cg.gain, 0, t + 0.001, 0.05);
        cn.connect(cf); cf.connect(cg); cg.connect(amp);
      }
      var cr = o.crash != null ? o.crash : 1;
      if (cr > 0) {
        var xtau = 0.35 + 0.7 * s;
        var xn = noise(v, WHITE, t, t + 5.5 * xtau), xf = filt(v, 'bandpass', 4800, 0.5), xg = gain(v, 0);
        sv(xg.gain, 0.22 * s * cr, t); st(xg.gain, 0, t + 0.002, xtau);
        xn.connect(xf); xf.connect(xg); xg.connect(amp);
      }
      var mt = o.metal != null ? o.metal : 1;
      if (mt > 0) {
        var mb = o.mb || 130;
        for (var i = 0, nm = s < 0.5 ? 4 : METAL.length; i < nm; i++) {
          var mtau = (0.5 + 0.6 * s) / (1 + i * 0.25);
          var mo = osc(v, 'sine', mb * METAL[i], t, t + 5.5 * mtau), mg = gain(v, 0);
          sv(mg.gain, 0, t); lr(mg.gain, 0.06 * s * mt / (1 + i * 0.35), t + 0.003);
          st(mg.gain, 0, t + 0.004, mtau);
          mo.connect(mg); mg.connect(amp);
        }
      }
    }

    // BRAAM: stacked low saws/squares, saturated, filter blooms open then closes.
    function braam(t, dur, notes, level, o) {
      o = o || {};
      var v = new Voice(), rel = o.rel || 1.5;
      var sum = gain(v, 1 / Math.sqrt(notes.length * 2.5));
      var sh = shaper(v, CURVE_HOT);
      var lp = filt(v, 'lowpass', 110, o.q || 3);
      var bump = filt(v, 'peaking', 650, 1); bump.gain.value = 4;
      var amp = gain(v, 0);
      sum.connect(sh); sh.connect(lp); lp.connect(bump); bump.connect(amp);
      out(v, amp, busMusic, o.verb != null ? o.verb : 0.5);
      var stopT = t + dur + rel * 1.4;
      sv(lp.frequency, 110, t); er(lp.frequency, o.peak || 2600, t + 0.07);
      er(lp.frequency, o.mid || 800, t + 0.6); er(lp.frequency, 200, stopT);
      sv(amp.gain, 0, t); lr(amp.gain, level, t + 0.012);
      st(amp.gain, level * 0.6, t + 0.1, 0.5);
      st(amp.gain, 0, t + dur, rel / 4);
      for (var i = 0; i < notes.length; i++) {
        var f = mtof(notes[i]);
        if (notes[i] < 33) {
          // Sub-octave notes: one quiet saw; the sine sub below carries the weight.
          var ls = osc(v, 'sawtooth', f, t, stopT, 0), lsg = gain(v, 0.35);
          ls.connect(lsg); lsg.connect(sum);
          continue;
        }
        osc(v, 'sawtooth', f, t, stopT, -7).connect(sum);
        osc(v, 'sawtooth', f, t, stopT, 7).connect(sum);
        if (notes[i] < 46) {
          var sq = osc(v, 'square', f, t, stopT, 0), sqg = gain(v, 0.45);
          sq.connect(sqg); sqg.connect(sum);
        }
      }
      var lo = mtof(notes[0]); while (lo > 50) lo /= 2;
      var sub = osc(v, 'sine', lo, t, stopT), subg = gain(v, 0);
      sv(subg.gain, 0, t); lr(subg.gain, level * 0.45, t + 0.02); st(subg.gain, 0, t + dur, rel / 4);
      sub.connect(subg); subg.connect(busMusic);
    }

    // Riser: noise band sweeping up + rising detuned saws + accelerating tremolo, hard cut.
    function riser(t0, t1, level, o) {
      o = o || {};
      var v = new Voice(), stopT = t1 + 0.03;
      var amp = gain(v, 0);
      sv(amp.gain, 1e-4, t0); er(amp.gain, level, t1); lr(amp.gain, 0, t1 + 0.012);
      out(v, amp, o.bus || busSfx, o.verb != null ? o.verb : 0.25);
      var trem = gain(v, 0.7), tl = osc(v, 'sine', 5, t0, stopT), tlg = gain(v, 0.3);
      er(tl.frequency, 5, t0); er(tl.frequency, 24, t1);
      tl.connect(tlg); tlg.connect(trem.gain); trem.connect(amp);
      var n = noise(v, WHITE, t0, stopT), nf = filt(v, 'bandpass', 300, 2.2), ng = gain(v, 1.3);
      sv(nf.frequency, 300, t0); er(nf.frequency, 7500, t1);
      n.connect(nf); nf.connect(ng); ng.connect(trem);
      var tlp = filt(v, 'lowpass', 400, 2), tg = gain(v, 0.3);
      sv(tlp.frequency, 400, t0); er(tlp.frequency, 6000, t1);
      tlp.connect(tg); tg.connect(trem);
      var m0 = mtof(o.m0 || 43), m1 = mtof(o.m1 || 79), dets = [-18, 0, 17];
      for (var i = 0; i < 3; i++) {
        var so = osc(v, 'sawtooth', m0, t0, stopT, dets[i]);
        sv(so.frequency, m0, t0); er(so.frequency, m1, t1);
        so.connect(tlp);
      }
    }

    // Reverse "suck-back": exponentially swelling noise + reversed chord, cut dead.
    function suck(t0, t1, level) {
      var v = new Voice(), stopT = t1 + 0.02;
      var amp = gain(v, 0);
      sv(amp.gain, 1e-4, t0); er(amp.gain, level, t1 - 0.004); lr(amp.gain, 0, t1);
      out(v, amp, busDry, 0);
      var n = noise(v, PINK, t0, stopT), nf = filt(v, 'lowpass', 300, 0.8);
      sv(nf.frequency, 300, t0); er(nf.frequency, 9000, t1);
      n.connect(nf); nf.connect(amp);
      var h = noise(v, WHITE, t0, stopT), hf = filt(v, 'highpass', 4000, 0.6), hg = gain(v, 0.6);
      h.connect(hf); hf.connect(hg); hg.connect(amp);
      var cl = filt(v, 'lowpass', 2500, 0.7), cg = gain(v, 0.25);
      cl.connect(cg); cg.connect(amp);
      [62, 69, 74].forEach(function (m) { osc(v, 'sawtooth', mtof(m), t0, stopT, (nrng() - 0.5) * 12).connect(cl); });
    }

    // Whoosh ending on a picture cut at tc.
    function whoosh(tc, level, o) {
      o = o || {};
      var v = new Voice(), d = o.dur || 0.45, dir = o.dir || 1;
      var t0 = tc - d * 0.75, t2 = tc + d * 0.5, stopT = t2 + 0.1;
      var amp = gain(v, 0), pn = panner(v, -0.8 * dir);
      sv(amp.gain, 1e-4, t0); er(amp.gain, level, tc - 0.015); er(amp.gain, 1e-4, t2);
      sv(pn.pan, -0.8 * dir, t0); lr(pn.pan, 0.8 * dir, t2);
      amp.connect(pn);
      out(v, pn, busSfx, 0.15);
      var n = noise(v, PINK, t0, stopT), nf = filt(v, 'bandpass', 350, 1.3), ng = gain(v, 2.2);
      sv(nf.frequency, 350, t0); er(nf.frequency, o.peak || 2600, tc); er(nf.frequency, 500, t2);
      n.connect(nf); nf.connect(ng); ng.connect(amp);
      var lo = osc(v, 'sine', 150, t0, stopT), lg = gain(v, 0.5);
      sv(lo.frequency, 160, t0); er(lo.frequency, 55, t2);
      lo.connect(lg); lg.connect(amp);
    }

    // Wind beds, with deterministic random gusts.
    var WINDS = {
      cold:   { layers: [[1, 'bandpass', 520, 1.4, 1.6], [2, 'lowpass', 230, 0.7, 0.5], [1, 'bandpass', 1400, 6, 1.6]], move: 0.45, step: 0.9 },
      desert: { layers: [[0, 'bandpass', 3400, 0.7, 0.5], [1, 'bandpass', 950, 0.9, 0.7], [2, 'lowpass', 320, 0.7, 0.45], [0, 'highpass', 6500, 0.7, 0.25]], move: 0.5, step: 0.65, gust: true },
      ice:    { layers: [[1, 'bandpass', 640, 14, 4.5], [1, 'bandpass', 980, 16, 3.6], [1, 'bandpass', 720, 1.0, 0.7], [2, 'lowpass', 260, 0.7, 0.5]], move: 0.3, step: 1.0 },
      coast:  { layers: [[1, 'bandpass', 800, 0.8, 0.7], [1, 'bandpass', 2400, 3, 0.8]], move: 0.4, step: 1.1 },
      faint:  { layers: [[1, 'bandpass', 430, 2, 1.2], [2, 'lowpass', 180, 0.7, 0.5], [1, 'bandpass', 1200, 9, 1.8]], move: 0.35, step: 1.2 }
    };
    function wind(t0, t1, kind, level, rng, o) {
      o = o || {};
      var cfg = WINDS[kind], v = new Voice();
      var fin = o.fin != null ? o.fin : 0.15, fout = o.fout != null ? o.fout : 0.15;
      var master = gain(v, 0);
      sv(master.gain, 0, t0); lr(master.gain, level, t0 + fin);
      sv(master.gain, level, Math.max(t0 + fin, t1 - fout)); lr(master.gain, 0, t1);
      out(v, master, busAmb, o.verb != null ? o.verb : 0.15);
      var bufs = [WHITE, PINK, BROWN];
      for (var i = 0; i < cfg.layers.length; i++) {
        var L = cfg.layers[i];
        var src = noise(v, bufs[L[0]], t0, t1 + 0.02);
        var f = filt(v, L[1], L[2], L[3]), g = gain(v, L[4] * 0.6), pn = panner(v, i % 2 ? 0.5 : -0.5);
        src.connect(f); f.connect(g); g.connect(pn); pn.connect(master);
        for (var tt = t0; tt < t1; tt += cfg.step * (0.6 + 0.8 * rng())) {
          st(f.frequency, L[2] * (1 + cfg.move * (rng() * 2 - 1)), tt, cfg.step * 0.4);
          var gg = 0.35 + 0.65 * rng();
          if (cfg.gust) gg = gg * gg * 1.4;
          st(g.gain, L[4] * gg, tt, cfg.step * 0.3);
          if (L[3] > 5) st(pn.pan, rng() * 1.6 - 0.8, tt, cfg.step * 0.5);
        }
      }
    }

    // Ocean: low wash + wave surges (opening lowpass) + foam hiss after each crest.
    function ocean(t0, t1, level, rng) {
      var v = new Voice();
      var master = gain(v, 0);
      sv(master.gain, 0, t0); lr(master.gain, level, t0 + 0.2);
      sv(master.gain, level, t1 - 0.15); lr(master.gain, 0, t1);
      out(v, master, busAmb, 0.2);
      var stopT = t1 + 0.02;
      var w = noise(v, BROWN, t0, stopT), wf = filt(v, 'lowpass', 320, 0.7), wg = gain(v, 0.45);
      w.connect(wf); wf.connect(wg); wg.connect(master);
      var s = noise(v, BROWN, t0, stopT), sf = filt(v, 'lowpass', 400, 0.9), sg = gain(v, 0.3);
      s.connect(sf); sf.connect(sg); sg.connect(master);
      var fm = noise(v, WHITE, t0, stopT), ff = filt(v, 'bandpass', 3800, 0.45), fg = gain(v, 0.02), fp = panner(v, 0.3);
      fm.connect(ff); ff.connect(fg); fg.connect(fp); fp.connect(master);
      var t = t0;
      while (t < t1) {
        var crest = t + 1.0 + 0.4 * rng();
        st(sf.frequency, 1300 + 400 * rng(), t, 0.35); st(sf.frequency, 320, crest, 0.6);
        st(sg.gain, 1.0 * (0.7 + 0.3 * rng()), t, 0.4); st(sg.gain, 0.2, crest, 0.7);
        st(fg.gain, 0.9, crest - 0.1, 0.07); st(fg.gain, 0.03, crest + 0.2, 0.55);
        st(fp.pan, rng() * 1.2 - 0.6, t, 0.8);
        t += 2.6 + 1.2 * rng();
      }
    }

    // Thunder: crackling multi-burst crack, ripping mid, long bumpy rumble.
    function thunder(t, level, rng) {
      var v = new Voice(), stopT = t + 5.8;
      var amp = gain(v, level), pn = panner(v, (rng() - 0.5) * 0.6);
      amp.connect(pn); out(v, pn, busSfx, 0.45);
      var c = noise(v, WHITE, t, t + 1), cf = filt(v, 'highpass', 600, 0.7), cg = gain(v, 0);
      sv(cg.gain, 0, t);
      var tt = t;
      for (var i = 0; i < 6; i++) {
        tt += 0.012 + rng() * 0.02;
        sv(cg.gain, (i === 5 ? 1.2 : 0.4 + 0.5 * rng()), tt); st(cg.gain, 0, tt + 0.001, i === 5 ? 0.12 : 0.012);
      }
      c.connect(cf); cf.connect(cg); cg.connect(amp);
      var rp = noise(v, WHITE, t, t + 2), rf = filt(v, 'bandpass', 2000, 0.6), rg = gain(v, 0);
      sv(rg.gain, 0, t); lr(rg.gain, 0.5, t + 0.06);
      for (tt = t + 0.1; tt < t + 1.4; tt += 0.04 + 0.08 * rng()) st(rg.gain, (0.1 + 0.4 * rng()) * Math.exp(-(tt - t) / 0.4), tt, 0.02);
      st(rg.gain, 0, t + 1.4, 0.1);
      rp.connect(rf); rf.connect(rg); rg.connect(amp);
      var r = noise(v, BROWN, t, stopT), rlf = filt(v, 'lowpass', 170, 0.8), rlg = gain(v, 0);
      sv(rlg.gain, 0, t); lr(rlg.gain, 1.2, t + 0.25);
      for (tt = t + 0.3; tt < t + 3.8; tt += 0.15 + 0.35 * rng()) st(rlg.gain, (0.5 + 0.8 * rng()) * Math.exp(-(tt - t) / 1.3), tt, 0.08);
      st(rlg.gain, 0, t + 3.8, 0.35);
      r.connect(rlf); rlf.connect(rlg); rlg.connect(amp);
    }

    // Machine groan: low FM drone with metallic stick-slip creaks.
    function groan(t, dur, level, rng, o) {
      o = o || {};
      var v = new Voice(), stopT = t + dur + (o.hard ? 0.05 : 1.2);
      var amp = gain(v, 0);
      ahr(amp.gain, level, t, 0.3, t + dur, 1.0, o.hard);
      out(v, amp, busSfx, 0.55);
      var f0 = o.f || 52;
      var car = osc(v, 'sawtooth', f0, t, stopT);
      sv(car.frequency, f0, t); lr(car.frequency, f0 * 0.85, t + dur);
      var mod = osc(v, 'sine', f0 * 1.37, t, stopT), mg = gain(v, 0);
      sv(mod.frequency, f0 * 1.37, t); lr(mod.frequency, f0 * 1.37 * 0.85, t + dur);
      sv(mg.gain, 0, t); lr(mg.gain, f0 * 2.2, t + dur * 0.4); lr(mg.gain, f0 * 0.8, t + dur);
      mod.connect(mg); mg.connect(car.frequency);
      var sh = shaper(v, CURVE_GRIT), bp = filt(v, 'bandpass', 160, 1.8), cg = gain(v, 1.2);
      sv(bp.frequency, 160, t); er(bp.frequency, 480, t + dur * 0.45); er(bp.frequency, 150, t + dur + 0.5);
      car.connect(sh); sh.connect(bp); bp.connect(cg); cg.connect(amp);
      var cr = noise(v, WHITE, t, stopT), gate = gain(v, 0), csum = gain(v, 1);
      [311, 467, 733, 1029].forEach(function (fr, i) {
        var b = filt(v, 'bandpass', fr, 30 + i * 6), bg = gain(v, 7);
        sv(b.frequency, fr, t); lr(b.frequency, fr * (1.1 + 0.05 * i), t + dur);
        cr.connect(b); b.connect(bg); bg.connect(csum);
      });
      for (var tt = t + 0.1; tt < t + dur; tt += 0.03 + 0.09 * rng()) st(gate.gain, rng() < 0.5 ? 0.05 : 0.4 + 0.6 * rng(), tt, 0.008);
      st(gate.gain, 0, t + dur, 0.05);
      csum.connect(gate); gate.connect(amp);
    }

    // Clock / gear tick.
    function tick(t, alt, vel) {
      var v = new Voice(), amp = gain(v, vel), pn = panner(v, alt ? 0.25 : -0.25);
      amp.connect(pn); out(v, pn, busSfx, 0.25);
      var n = noise(v, WHITE, t, t + 0.06), nf = filt(v, 'bandpass', alt ? 3600 : 2500, 5), ng = gain(v, 0);
      sv(ng.gain, 1.6, t); st(ng.gain, 0, t + 0.001, 0.006);
      n.connect(nf); nf.connect(ng); ng.connect(amp);
      var s = osc(v, 'sine', alt ? 2300 : 1700, t, t + 0.1), sg = gain(v, 0);
      sv(sg.gain, 0.15, t); st(sg.gain, 0, t + 0.001, 0.015);
      s.connect(sg); sg.connect(amp);
      var c = osc(v, 'sine', alt ? 140 : 105, t, t + 0.12), cg = gain(v, 0);
      sv(cg.gain, 0.5, t); st(cg.gain, 0, t + 0.001, 0.025);
      c.connect(cg); cg.connect(amp);
    }

    // Monster growl: wobbling low saws through opening vowel formants + rumble.
    function growl(t0, t1, level, rng) {
      var v = new Voice(), stopT = t1 + 0.05;
      var amp = gain(v, 0);
      sv(amp.gain, 1e-4, t0); er(amp.gain, level, t1 - 0.01); lr(amp.gain, 0, t1 + 0.01);
      out(v, amp, busSfx, 0.35);
      var sum = gain(v, 0.5), sh = shaper(v, CURVE_GRIT);
      var l1 = osc(v, 'sine', 6.5, t0, stopT), l1g = gain(v, 3);
      var l2 = osc(v, 'sine', 0.9, t0, stopT), l2g = gain(v, 2.5);
      er(l1.frequency, 6.5, t0); er(l1.frequency, 11, t1);
      l1.connect(l1g); l2.connect(l2g);
      [43.6, 44.9, 87.5].forEach(function (f) {
        var o1 = osc(v, 'sawtooth', f, t0, stopT);
        l1g.connect(o1.frequency); l2g.connect(o1.frequency);
        o1.connect(sum);
      });
      sum.connect(sh);
      [[260, 520, 5, 2.4], [620, 1000, 7, 2.0], [1300, 1500, 9, 1.0]].forEach(function (F) {
        var b = filt(v, 'bandpass', F[0], F[2]), bg = gain(v, F[3]);
        sv(b.frequency, F[0], t0); er(b.frequency, F[1], t1);
        sh.connect(b); b.connect(bg); bg.connect(amp);
      });
      var r = noise(v, BROWN, t0, stopT), rf = filt(v, 'lowpass', 90, 0.8), rg = gain(v, 1.0);
      r.connect(rf); rf.connect(rg); rg.connect(amp);
    }

    // Heartbeat: lub-dub low thumps.
    function heart(t, vel) {
      var v = new Voice(), amp = gain(v, vel);
      out(v, amp, busSfx, 0.2);
      [[0, 1], [0.28, 0.65]].forEach(function (b) {
        var tt = t + b[0];
        var s = osc(v, 'sine', 70, tt, tt + 0.8), sg = gain(v, 0);
        sv(s.frequency, 72, tt); er(s.frequency, 38, tt + 0.12);
        sv(sg.gain, 0, tt); lr(sg.gain, b[1], tt + 0.005); st(sg.gain, 0, tt + 0.008, 0.1);
        s.connect(sg); sg.connect(amp);
        var n = noise(v, BROWN, tt, tt + 0.5), nf = filt(v, 'lowpass', 140, 0.8), ng = gain(v, 0);
        sv(ng.gain, b[1] * 0.6, tt); st(ng.gain, 0, tt + 0.002, 0.07);
        n.connect(nf); nf.connect(ng); ng.connect(amp);
      });
    }

    // Crystalline FM bell (ratio 3.5).
    function sparkle(t, m, vel, pan, o) {
      o = o || {};
      var v = new Voice(), f = mtof(m), stopT = t + (o.len || 3.2);
      var amp = gain(v, 0), pn = panner(v, pan || 0);
      sv(amp.gain, 0, t); lr(amp.gain, vel * (o.level || 0.1), t + 0.003); st(amp.gain, 0, t + 0.004, o.tau || 0.5);
      amp.connect(pn); out(v, pn, busMusic, o.verb != null ? o.verb : 0.7);
      var c = osc(v, 'sine', f, t, stopT), md = osc(v, 'sine', f * 3.5, t, stopT), mg = gain(v, 0);
      sv(mg.gain, f * 2.2, t); er(mg.gain, f * 0.08, t + 0.7);
      md.connect(mg); mg.connect(c.frequency); c.connect(amp);
      var p2 = osc(v, 'sine', f * 2.756, t, t + 1.2), p2g = gain(v, 0);
      sv(p2g.gain, 0.25, t); st(p2g.gain, 0, t + 0.002, 0.2);
      p2.connect(p2g); p2g.connect(amp);
    }

    // Deep drone on D.
    function drone(t0, t1, level, o) {
      o = o || {};
      var v = new Voice(), fin = o.fin || 3, fout = o.fout || 2.5, stopT = t1 + 0.05;
      var amp = gain(v, 0);
      sv(amp.gain, 0, t0); lr(amp.gain, level, t0 + fin); sv(amp.gain, level, t1 - fout); lr(amp.gain, 0, t1);
      out(v, amp, busMusic, 0.3);
      [[36.71, 0.3], [73.42, 0.5]].forEach(function (p) {
        var s = osc(v, 'sine', p[0], t0, stopT), g = gain(v, p[1]); s.connect(g); g.connect(amp);
      });
      var lp = filt(v, 'lowpass', 170, 1.6), lg = gain(v, 0.45);
      var lfo = osc(v, 'sine', 0.13, t0, stopT), lfg = gain(v, 70);
      lfo.connect(lfg); lfg.connect(lp.frequency);
      [[73.42, 4], [73.42, -5], [110, 3]].forEach(function (p, i) {
        osc(v, 'sawtooth', p[0], t0, stopT, p[1]).connect(i === 2 ? lg : lp);
      });
      lp.connect(lg); lg.connect(amp);
    }

    // Cymbal crash (forward) and reverse-cymbal swell.
    function crash(t, level, decay) {
      var v = new Voice(), stopT = t + decay * 5;
      var amp = gain(v, level); out(v, amp, busSfx, 0.35);
      [[-0.5, 4200, 1], [0.5, 8800, 0.7]].forEach(function (p) {
        var n = noise(v, WHITE, t, stopT), f = filt(v, 'highpass', p[1], 0.5), g = gain(v, 0), pn = panner(v, p[0]);
        sv(g.gain, p[2], t); st(g.gain, 0, t + 0.002, decay);
        n.connect(f); f.connect(g); g.connect(pn); pn.connect(amp);
      });
    }
    function swell(t0, t1, level) {
      var v = new Voice(), stopT = t1 + 0.03;
      var amp = gain(v, 0);
      sv(amp.gain, 1e-4, t0); er(amp.gain, level, t1 - 0.005); lr(amp.gain, 0, t1 + 0.01);
      out(v, amp, busSfx, 0.3);
      var n = noise(v, WHITE, t0, stopT), f = filt(v, 'highpass', 3500, 0.5);
      n.connect(f); f.connect(amp);
      var p = noise(v, PINK, t0, stopT), pf = filt(v, 'lowpass', 800, 0.7), pg = gain(v, 0.8);
      sv(pf.frequency, 800, t0); er(pf.frequency, 12000, t1);
      p.connect(pf); pf.connect(pg); pg.connect(amp);
    }

    // Horror screech: chaotic high FM + dissonant tremolo cluster.
    function screech(t, level) {
      var v = new Voice(), stopT = t + 3.5;
      var amp = gain(v, level); out(v, amp, busSfx, 0.6);
      [[1500, 900, 1.0], [2130, 1400, 0.6]].forEach(function (p) {
        var c = osc(v, 'sine', p[0], t, stopT), m = osc(v, 'sine', p[0] * 1.414, t, stopT), mg = gain(v, 0);
        sv(c.frequency, p[0], t); er(c.frequency, p[1], t + 1.4);
        sv(m.frequency, p[0] * 1.414, t); er(m.frequency, p[1] * 1.414, t + 1.4);
        sv(mg.gain, p[0] * 2.5, t); er(mg.gain, p[0] * 0.4, t + 1.5);
        m.connect(mg); mg.connect(c.frequency);
        var bp = filt(v, 'bandpass', 1900, 1.2), g = gain(v, 0);
        sv(g.gain, 0, t); lr(g.gain, 0.5 * p[2], t + 0.01); st(g.gain, 0, t + 0.05, 0.45);
        c.connect(bp); bp.connect(g); g.connect(amp);
      });
      var cl = filt(v, 'lowpass', 5000, 0.7), tr = gain(v, 0.5), tl = osc(v, 'square', 11, t, stopT), tg = gain(v, 0.5);
      tl.connect(tg); tg.connect(tr.gain);
      var cg = gain(v, 0);
      sv(cg.gain, 0, t); lr(cg.gain, 0.12, t + 0.02); st(cg.gain, 0, t + 0.1, 0.6);
      [86, 87, 92].forEach(function (m) { osc(v, 'sawtooth', mtof(m), t, stopT, (nrng() - 0.5) * 20).connect(cl); });
      cl.connect(tr); tr.connect(cg); cg.connect(amp);
    }

    // Duck everything but the dry bus (for the pre-hit silence).
    function duck(t, restoreAt) {
      ducked.forEach(function (d) {
        st(d[0].gain, 0, t, 0.006);
        st(d[0].gain, NORMAL[d[1]], restoreAt, 0.004);
      });
    }

    // ----------------------------------------------------------------- score
    function buildScore() {
      var ev = [];
      function at(t, fn) { ev.push({ t: t, fn: fn, i: ev.length }); }

      var CH = {
        Dm: { pad: [38, 45, 50, 53, 57], root: 50, third: 3, top: 10 },
        Bb: { pad: [34, 41, 46, 50, 53], root: 46, third: 4, top: 11 },
        F:  { pad: [29, 36, 41, 45, 48], root: 41, third: 4, top: 11 },
        C:  { pad: [36, 43, 48, 52, 55], root: 48, third: 4, top: 10 },
        Gm: { pad: [31, 38, 43, 46, 50], root: 43, third: 3, top: 10 },
        A:  { pad: [33, 40, 45, 49, 52], root: 45, third: 4, top: 10 },
        D:  { pad: [38, 45, 50, 54, 57], root: 50, third: 4, top: 11 }
      };
      function voiceUp(notes) { return notes.map(function (m) { return m + 12; }); }

      // Piano phrase: [time, midi, (hold)] with sustain-pedal legato.
      function phrase(notes, vel, o) {
        notes.forEach(function (n, i) {
          var next = i + 1 < notes.length ? notes[i + 1][0] : n[0] + 1.5;
          var hold = n[2] != null ? n[2] : next - n[0] + 0.6;
          var vv = vel * (0.9 + 0.2 * ((i * 37) % 7) / 7);
          at(n[0], function (a) { piano(a, n[1], vv, hold, o); });
        });
      }
      // Ostinato: steps per bar (8 or 16) over a chord map.
      var P8 = [0, 0, 12, 0, 7, 0, 12, 'top'];
      var P16 = [0, 12, 7, 12, 0, 12, 'top', 12, 0, 12, 7, 12, 'third', 12, 7, 12];
      function ostinato(t0, t1, chords, steps, v0, v1, octs, o) {
        o = o || {};
        var dt = 2 / steps, pat = steps === 16 ? P16 : P8;
        for (var k = 0, t = t0; t < t1 - 1e-6; k++, t = t0 + k * dt) {
          var ch = null;
          for (var j = 0; j < chords.length; j++) if (t >= chords[j][0] - 1e-6) ch = CH[chords[j][1]];
          var p = pat[k % steps];
          var iv = p === 'top' ? ch.top : p === 'third' ? ch.third + 12 : p;
          var u = (t - t0) / (t1 - t0);
          var vel = (v0 + (v1 - v0) * u) * (k % 4 === 0 ? 1.0 : 0.78);
          (function (tt, m, vv) {
            at(tt, function (a) {
              octs.forEach(function (oc, i) {
                strNote(a, m + oc, vv * (i ? 0.8 : 1), o.len || dt * 0.7, { level: o.level || 0.1, pan: i ? -0.35 : 0.35 });
              });
            });
          })(t, ch.root + iv, vel);
        }
      }
      // Taiko groove for one bar starting at t (16th grid).
      var LOW = [[0, 1.0], [3, 0.65], [6, 0.8], [8, 0.85], [10, 0.75], [13, 0.6]];
      var HIGH = [[4, 0.5], [8, 0.7], [12, 0.6], [14, 0.7], [15, 0.85]];
      var GHOST = [[1, 0.3], [2, 0.25], [5, 0.3], [7, 0.35], [9, 0.3], [11, 0.35]];
      function groove(t, level, skipDown) {
        LOW.forEach(function (h) { if (!(skipDown && h[0] === 0)) at(t + h[0] * 0.125, function (a) { drum(a, h[1] * level, 'low'); }); });
        HIGH.forEach(function (h) { at(t + h[0] * 0.125, function (a) { drum(a, h[1] * level, 'high'); }); });
        GHOST.forEach(function (h) { at(t + h[0] * 0.125, function (a) { drum(a, h[1] * level, 'rim', { level: 0.6, verb: 0.15 }); }); });
      }

      // ===== 0–4 INTRO: planet in space
      at(0.0, function (a, r) { wind(a, a + 4.15, 'cold', 0.32, r, { fin: 2.8, fout: 0.2 }); });
      at(0.0, function (a) { drone(a, a + 11.0, 0.16, { fin: 3.0, fout: 3.5 }); });
      at(0.8, function (a) { impact(a, 0.3, { crack: 0, crash: 0.12, metal: 0.3, verb: 0.9, lp: 380, gain: 0.35 }); });
      at(2.0, function (a) { piano(a, 50, 0.5, 3.2, { verb: 0.65, level: 0.12 }); });
      at(2.03, function (a) { piano(a, 62, 0.35, 3.2, { verb: 0.65, level: 0.12 }); });
      at(3.8, function (a) { whoosh(a + 0.2, 0.22, { dur: 0.9, dir: 1, peak: 1800 }); });

      // ===== 4–10 DESERT: eternal noon
      at(3.95, function (a, r) { wind(a, a + 6.15, 'desert', 0.26, r, { fin: 0.1, fout: 0.15 }); });
      at(4.0, function (a) { pad(a, 6.3, CH.Dm.pad, { level: 0.08, att: 2.5, rel: 2.0, c0: 180, c1: 1100, c2: 600 }); });
      phrase([[4.5, 69], [5.0, 74], [5.5, 76], [6.0, 77, 1.6], [7.5, 76], [8.0, 74], [8.5, 72], [9.0, 74, 1.8]], 0.55, { level: 0.19 });
      at(4.5, function (a) { piano(a, 38, 0.45, 3.4, { verb: 0.55, level: 0.19 }); piano(a + 0.01, 50, 0.3, 3.4, { level: 0.19 }); });
      at(8.0, function (a) { piano(a, 45, 0.4, 2.0, { level: 0.19 }); });

      // ===== 10–16 ICE NIGHT: frozen sea, aurora
      at(9.8, function (a) { whoosh(a + 0.2, 0.1, { dur: 0.6, dir: -1, peak: 1500 }); });
      at(9.95, function (a, r) { wind(a, a + 6.15, 'ice', 0.34, r, { fin: 0.12, fout: 0.15, verb: 0.25 }); });
      at(10.0, function (a) { pad(a, 6.3, CH.Bb.pad, { level: 0.1, att: 1.4, rel: 2.0, c0: 300, c1: 1500, c2: 700 }); });
      phrase([[10.5, 69], [11.0, 74], [11.5, 76], [12.0, 77, 1.6], [13.5, 74], [14.0, 70], [14.5, 69, 1.8]], 0.52, { verb: 0.6, level: 0.21 });
      [[10.5, 81], [11.0, 86], [11.5, 88], [12.0, 89]].forEach(function (n) {
        at(n[0] + 0.005, function (a) { sparkle(a, n[1], 0.45, 0.2, { level: 0.08, tau: 0.9 }); });
      });
      at(10.5, function (a) { piano(a, 34, 0.45, 3.2, { level: 0.2 }); piano(a + 0.01, 46, 0.3, 3.2, { level: 0.2 }); });
      at(14.0, function (a) { piano(a, 41, 0.4, 2.2, { level: 0.2 }); });
      [[10.3, 98, -0.6], [11.25, 93, 0.5], [12.7, 101, -0.3], [13.2, 94, 0.7], [14.3, 98, -0.7], [15.1, 89, 0.4], [15.55, 105, -0.2]].forEach(function (s) {
        at(s[0], function (a) { sparkle(a, s[1], 0.6, s[2], { level: 0.06 }); });
      });

      // ===== 16–22 TWILIGHT: coast at eternal sunset
      at(15.8, function (a) { whoosh(a + 0.2, 0.1, { dur: 0.7, dir: 1, peak: 1600 }); });
      at(15.95, function (a, r) { ocean(a, a + 6.15, 0.3, r); });
      at(15.95, function (a, r) { wind(a, a + 6.15, 'coast', 0.14, r, { fin: 0.12, fout: 0.15 }); });
      at(16.0, function (a) { pad(a, 3.1, CH.F.pad, { level: 0.11, att: 0.8, rel: 1.2, c0: 250, c1: 1300, c2: 900 }); });
      at(19.0, function (a) { pad(a, 3.2, CH.C.pad, { level: 0.11, att: 0.6, rel: 1.0, c0: 300, c1: 1400, c2: 700 }); });
      at(16.0, function (a) { line(a, 3.0, 41, { level: 0.08, cut: 900, att: 0.6 }); });
      at(19.0, function (a) { line(a, 1.5, 43, { level: 0.08, cut: 900, att: 0.3 }); });
      at(20.5, function (a) { line(a, 1.6, 40, { level: 0.08, cut: 900, att: 0.3 }); });
      phrase([[16.5, 72], [17.0, 77], [17.5, 79], [18.0, 81, 1.6], [19.5, 79], [20.0, 76], [20.5, 74], [21.0, 72, 1.2]], 0.58, { level: 0.22 });

      // ===== 22–30 MACHINE REVEAL
      at(21.75, function (a) { whoosh(a + 0.25, 0.25, { dur: 0.7, dir: -1 }); });
      at(22.0, function (a) { impact(a, 0.45, { crack: 0.3, metal: 1.3, mb: 70, crash: 0.5 }); });
      [[22, 0.75], [24, 0.82], [26, 0.9], [28, 1.0]].forEach(function (d) {
        at(d[0], function (a) { drum(a, d[1], 'big', { pan: 0, verb: 0.4 }); });
      });
      [[28.5, 0.8], [29.0, 0.85], [29.5, 0.95]].forEach(function (d) {
        at(d[0], function (a) { drum(a, d[1], 'low', { pan: 0 }); });
      });
      [[29.25, 0.5], [29.625, 0.55], [29.75, 0.7], [29.875, 0.85]].forEach(function (d) {
        at(d[0], function (a) { drum(a, d[1], 'high'); });
      });
      ostinato(22, 26, [[22, 'Dm']], 8, 0.35, 0.6, [0]);
      ostinato(26, 30, [[26, 'Bb']], 8, 0.6, 0.9, [0, -12]);
      at(22.0, function (a) { pad(a, 4.1, CH.Dm.pad, { level: 0.08, att: 1.0, rel: 0.8 }); });
      at(26.0, function (a) { pad(a, 4.0, CH.Bb.pad, { level: 0.12, att: 0.8, rel: 0.4, c1: 1800, c2: 1600 }); });
      at(26.0, function (a) { choir(a, 4.0, voiceUp(CH.Bb.pad), { level: 0.1, att: 2.5, rel: 0.3 }); });
      at(22.0, function (a) { drone(a, a + 8.1, 0.2, { fin: 1.0, fout: 0.1 }); });
      at(23.0, function (a, r) { groan(a, 2.4, 0.3, r); impact(a, 0.25, { crack: 0.4, metal: 1.6, mb: 88, crash: 0.1, verb: 0.7 }); });
      at(25.5, function (a, r) { groan(a, 2.5, 0.33, r, { f: 46 }); impact(a, 0.25, { crack: 0.4, metal: 1.6, mb: 77, crash: 0.1, verb: 0.7 }); });
      at(28.0, function (a) { riser(a, a + 2.0, 0.42, { m0: 43, m1: 79 }); });

      // ===== 30–38 MONTAGE (cuts every second)
      var MCH = [[30, 'Dm'], [32, 'Bb'], [34, 'Gm'], [36, 'A']];
      [30, 32, 34, 36].forEach(function (t) { groove(t, 1.0); });
      ostinato(30, 38, MCH, 16, 0.75, 0.95, [0, -12], { level: 0.1 });
      MCH.forEach(function (c) {
        at(c[0], function (a) { choir(a, 2.05, voiceUp(CH[c[1]].pad), { level: 0.28, att: 0.25, rel: 0.6 }); });
        at(c[0], function (a) { pad(a, 2.05, CH[c[1]].pad, { level: 0.12, att: 0.2, rel: 0.6, c0: 400, c1: 2200, c2: 1200 }); });
      });
      at(30.0, function (a) { impact(a, 1.0, { mb: 110 }); braam(a, 1.2, [26, 38, 45, 50], 0.5, { rel: 1.2 }); crash(a, 0.3, 1.2); });
      at(32.0, function (a) { impact(a, 0.85, { mb: 97 }); braam(a, 1.0, [34, 41, 46], 0.45, { rel: 1.0 }); });
      at(34.0, function (a) { braam(a, 0.6, [31, 38, 43], 0.3, { rel: 0.8, peak: 1800 }); });
      at(35.0, function (a) { impact(a, 0.85, { mb: 120 }); braam(a, 0.9, [31, 38, 43, 50], 0.45, { rel: 1.0 }); crash(a, 0.25, 1.0); });
      at(36.0, function (a) { braam(a, 0.6, [33, 40, 45], 0.3, { rel: 0.8, peak: 1800 }); });
      [31, 33, 34, 36, 37].forEach(function (t) {
        at(t, function (a) { impact(a, 0.35, { crash: 0.5, metal: 0.5, crack: 0.8, mb: 150 + (t % 3) * 20 }); });
      });
      [31, 32, 33, 34, 35, 36, 37, 38].forEach(function (t, i) {
        at(t - 0.4, function (a) { whoosh(a + 0.4, 0.28, { dur: 0.5, dir: i % 2 ? -1 : 1 }); });
      });
      at(33.25, function (a, r) { thunder(a, 0.95, r); });
      [74, 77, 79, 81, 84, 86, 89, 91, 93, 98].forEach(function (m, i) {
        at(35.0 + i * 0.09, function (a) { sparkle(a, m, 0.8, i % 2 ? 0.6 : -0.6, { level: 0.1, tau: 0.6 }); });
      });

      // ===== 38–39.55 BUILD, then silence
      var tr = 38.0, kr = 0;
      while (tr < 39.5) {
        (function (t, k) {
          var u = (t - 38) / 1.5;
          at(t, function (a) { drum(a, 0.35 + 0.65 * Math.pow(u, 1.2), k % 2 ? 'high' : 'low', { verb: 0.2 }); });
        })(tr, kr++);
        tr += 0.25 * Math.pow(0.16, (tr - 38) / 1.5);
      }
      at(38.0, function (a) { riser(a, a + 1.55, 0.5, { m0: 45, m1: 81 }); });
      at(38.0, function (a) { choir(a, 1.55, voiceUp(CH.A.pad), { level: 0.26, att: 1.4, hard: true }); });
      at(38.0, function (a) { pad(a, 1.55, CH.A.pad, { level: 0.14, att: 1.2, hard: true, c0: 400, c1: 3000 }); });
      ostinato(38, 39.5, [[38, 'A']], 16, 0.6, 1.0, [0, -12], { level: 0.09 });
      at(38.1, function (a, r) { groan(a, 1.45, 0.45, r, { f: 58, hard: true }); });
      at(39.0, function (a) { suck(a, a + 0.95, 0.3); });
      at(39.55, function (a) { duck(a, a + 0.435); });

      // ===== 40 IGNITION
      at(40.0, function (a) {
        braam(a, 3.0, [26, 38, 45, 50, 53], 0.85, { rel: 2.5, peak: 3200 });
        impact(a, 1.5, { mb: 62 });
        crash(a, 0.45, 2.0);
        drum(a, 1.0, 'big', { pan: 0, verb: 0.5 });
      });

      // ===== 40–48 TIME-LAPSE: the world turns again
      var TCH = [[40, 'Dm'], [42, 'Bb'], [44, 'F'], [46, 'C']];
      TCH.forEach(function (c, i) {
        at(c[0], function (a) { choir(a, 2.05, voiceUp(CH[c[1]].pad), { level: 0.24, att: i ? 0.2 : 0.5, rel: 0.6 }); });
        at(c[0], function (a) { pad(a, 2.05, CH[c[1]].pad, { level: 0.13, att: 0.3, rel: 0.6, c0: 500, c1: 2500, c2: 1400 }); });
      });
      ostinato(40, 48, TCH, 16, 0.8, 0.95, [0, -12], { level: 0.085 });
      [40, 42, 44, 46].forEach(function (t, i) { groove(t, 0.9 + i * 0.03, t === 40); });
      [42, 44, 46].forEach(function (t) { at(t, function (a) { drum(a, 0.95, 'big', { pan: 0, verb: 0.4 }); }); });
      [[40.0, 69, 0.5], [40.5, 74, 0.5], [41.0, 76, 1.0], [42.0, 77, 2.0], [44.0, 77, 0.5], [44.5, 79, 0.5], [45.0, 81, 1.0], [46.0, 79, 2.0]].forEach(function (n) {
        at(n[0], function (a) { line(a, n[2] - 0.02, n[1], { level: 0.11, cut: 2600, att: 0.05, rel: 0.25, oct: 0.6, verb: 0.5 }); });
      });
      at(44.0, function (a) { braam(a, 1.6, [29, 41, 48, 53], 0.5, { rel: 1.2 }); impact(a, 0.6, { crack: 0.5, mb: 90 }); });
      var tk = 41.5, kk = 0;
      while (tk < 47.5) {
        (function (t, k) {
          at(t, function (a) { tick(a, k % 2 === 1, 0.35 + 0.25 * ((t - 41.5) / 6)); });
        })(tk, kk++);
        tk += 0.5 * Math.pow(0.07, (tk - 41.5) / 6);
      }
      at(46.4, function (a) { swell(a, a + 1.6, 0.4); });

      // ===== 48–52 HERO SUNRISE: D major
      at(48.0, function (a) {
        impact(a, 0.9, { crack: 0.3, metal: 0.6, mb: 73 });
        crash(a, 0.4, 2.2);
        drum(a, 1.0, 'big', { pan: 0, verb: 0.5 });
        braam(a, 2.0, [26, 38, 45, 50, 54], 0.4, { rel: 1.5, peak: 1800, mid: 900 });
      });
      at(48.0, function (a) { choir(a, 4.0, voiceUp(CH.D.pad), { level: 0.26, att: 0.3, rel: 0.4 }); });
      at(48.0, function (a) { choir(a, 4.0, [74, 78, 81], { level: 0.12, att: 0.6, rel: 0.4 }); });
      at(48.0, function (a) { pad(a, 4.0, CH.D.pad, { level: 0.15, att: 0.3, rel: 0.4, c0: 600, c1: 3000, c2: 2000 }); });
      ostinato(48, 52, [[48, 'D']], 8, 0.7, 0.9, [0, -12], { level: 0.1 });
      phrase([[48.0, 69], [48.5, 74], [49.0, 76], [49.5, 78, 1.5], [51.0, 81, 1.0]], 0.9, { level: 0.36 });
      phrase([[48.0, 81], [48.5, 86], [49.0, 88], [49.5, 90, 1.5], [51.0, 93, 1.0]], 0.5, { level: 0.25 });
      [[48.0, 69, 0.5], [48.5, 74, 0.5], [49.0, 76, 0.5], [49.5, 78, 1.5], [51.0, 81, 0.98]].forEach(function (n) {
        at(n[0], function (a) { line(a, n[2] - 0.02, n[1], { level: 0.1, cut: 3000, att: 0.05, rel: 0.25, oct: 0.6 }); });
      });
      [[48.5, 0.6], [49.0, 0.6], [49.5, 0.7], [50.0, 0.8], [50.5, 0.7]].forEach(function (d) {
        at(d[0], function (a) { drum(a, d[1], 'low'); });
      });
      at(50.3, function (a) { swell(a, a + 1.7, 0.4); });
      [[51.0, 0.8], [51.25, 0.87], [51.5, 0.93], [51.75, 1.0]].forEach(function (d) {
        at(d[0], function (a) { drum(a, d[1], 'big', { pan: 0 }); });
      });
      at(51.0, function (a) { riser(a, a + 0.86, 0.45, { m0: 50, m1: 86 }); });
      at(51.86, function (a) { duck(a, a + 0.135); });

      // ===== 52 TITLE: MERIDIAN
      at(52.0, function (a) {
        impact(a, 1.4, { mb: 55 });
        braam(a, 1.6, [26, 38, 45, 50], 0.9, { rel: 2.4, peak: 2800 });
        crash(a, 0.45, 3.0);
        drum(a, 1.0, 'big', { pan: 0, verb: 0.6 });
      });
      at(52.3, function (a) { pad(a, 7.2, [50, 57, 62, 66, 69, 74, 78], { level: 0.13, att: 2.2, rel: 0.8, c0: 500, c1: 2600, c2: 1200 }); });
      at(52.3, function (a) { choir(a, 7.0, [62, 66, 69, 74], { level: 0.07, att: 2.5, rel: 1.0 }); });
      phrase([[54.0, 69], [54.5, 74], [55.0, 76], [55.5, 78, 1.1], [56.5, 76], [57.0, 73], [57.5, 74, 2.0]], 0.55, { verb: 0.65 });
      at(54.0, function (a) { piano(a, 38, 0.4, 3.3); piano(a + 0.01, 50, 0.3, 3.3); });
      at(57.5, function (a) { piano(a, 26, 0.45, 2.0); piano(a + 0.01, 38, 0.35, 2.0); piano(a + 0.02, 62, 0.25, 2.0); });
      [[55.5, 90, -0.4], [55.62, 93, 0.3], [55.74, 98, -0.1], [57.5, 86, 0.4]].forEach(function (s) {
        at(s[0], function (a) { sparkle(a, s[1], 0.6, s[2], { level: 0.06, tau: 0.8 }); });
      });

      // ===== 60.2–63.4 STINGER
      at(60.2, function (a, r) { wind(a, a + 3.3, 'faint', 0.26, r, { fin: 0.9, fout: 0.1 }); });
      at(61.0, function (a) { heart(a, 0.4); });
      at(61.8, function (a) { heart(a, 0.55); });
      at(61.0, function (a, r) { growl(a, a + 1.4, 0.8, r); });
      at(62.4, function (a) {
        braam(a, 1.0, [26, 32, 38, 44, 50], 1.0, { rel: 1.8, peak: 4200, q: 4 });
        impact(a, 1.3, { metal: 1.6, mb: 97 });
        screech(a, 0.55);
        crash(a, 0.3, 1.6);
      });

      ev.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
      return ev;
    }

    var events = buildScore();

    // ------------------------------------------------------------- scheduler
    var base = 0, idx = 0, timer = null;
    function runEvent(e) {
      try { e.fn(base + e.t, mulberry32(0x9E3779B1 ^ (e.i * 2654435761))); }
      catch (err) { stats.errors.push(String(err && err.stack || err)); if (root.console) console.error(err); }
    }
    function pump() {
      var horizon = ctx.currentTime - base + LOOKAHEAD;
      while (idx < events.length && events[idx].t <= horizon) runEvent(events[idx++]);
      if (idx >= events.length && timer) { clearInterval(timer); timer = null; }
    }
    function haltAll(t) { live.forEach(function (v) { v.halt(t); }); }
    function reset(ctxTime, offset) {
      if (timer) { clearInterval(timer); timer = null; }
      var now = ctx.currentTime;
      haltAll(now + 0.03);
      offset = offset || 0;
      base = ctxTime - offset;
      idx = 0;
      while (idx < events.length && events[idx].t < offset - 1e-6) idx++;
      fadeNode.gain.cancelScheduledValues(now);
      fadeNode.gain.setValueAtTime(fadeNode.gain.value, now);
      fadeNode.gain.linearRampToValueAtTime(1, Math.max(now + 0.03, ctxTime));
      ducked.forEach(function (d) {
        d[0].gain.cancelScheduledValues(now);
        d[0].gain.setValueAtTime(NORMAL[d[1]], now);
      });
      // Clean end: fade the last of the stinger tail.
      var endA = base + DURATION - 0.9;
      if (endA > now) {
        fadeNode.gain.setValueAtTime(1, endA);
        fadeNode.gain.linearRampToValueAtTime(0, base + DURATION);
      }
    }

    return {
      start: function (ctxTime, offset) {
        reset(ctxTime, offset);
        pump();
        if (idx < events.length) timer = setInterval(pump, TICK_MS);
      },
      // Offline: if the context supports suspend(), feed events through the
      // same lookahead window at suspend points (identical output, but far
      // fewer idle nodes in the graph, so rendering is ~5x faster).
      scheduleAll: function (ctxTime, offset) {
        reset(ctxTime, offset);
        var progressive = false;
        if (typeof ctx.suspend === 'function' && typeof ctx.startRendering === 'function' && ctx.length) {
          try {
            var endT = ctx.length / sr;
            for (var q = Math.max(0.5, ctx.currentTime + 0.5); q < endT - 0.01; q += 0.5) {
              ctx.suspend(q).then(function () { pump(); ctx.resume(); });
            }
            progressive = true;
          } catch (e) { progressive = false; }
        }
        pump();
        if (!progressive) while (idx < events.length) runEvent(events[idx++]);
      },
      stop: function () {
        if (timer) { clearInterval(timer); timer = null; }
        var now = ctx.currentTime;
        fadeNode.gain.cancelScheduledValues(now);
        fadeNode.gain.setValueAtTime(fadeNode.gain.value, now);
        fadeNode.gain.linearRampToValueAtTime(0, now + 0.3);
        haltAll(now + 0.35);
        idx = events.length;
      },
      setVolume: function (x) {
        volNode.gain.setTargetAtTime(clamp(x, 0, 1), ctx.currentTime, 0.05);
      },
      stats: function () {
        // Exact peak of simultaneously scheduled sources, from start/stop spans.
        var pts = [], sp = stats.spans;
        for (var i = 0; i < sp.length; i += 2) { pts.push([sp[i], 1]); pts.push([sp[i + 1], -1]); }
        pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var cur = 0, peak = 0, peakAt = 0;
        for (i = 0; i < pts.length; i++) { cur += pts[i][1]; if (cur > peak) { peak = cur; peakAt = pts[i][0] - base; } }
        return {
          events: events.length, scheduled: idx, sources: stats.sources,
          alive: stats.alive, alivePeak: stats.alivePeak,
          spanPeak: peak, spanPeakAt: +peakAt.toFixed(2), liveVoices: live.size,
          errors: stats.errors.slice()
        };
      }
    };
  }

  root.TrailerAudio = { DURATION: DURATION, create: create };
})(typeof window !== 'undefined' ? window : globalThis);
