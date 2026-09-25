// Trailer typography drawn with Canvas 2D every frame; composited (and bloomed) by the GL pipeline.
(function () {
  'use strict';
  const { smooth, clamp, outCubic } = E;
  const FONT = "'Bahnschrift', 'Segoe UI', 'Arial', sans-serif";

  const CUES = [
    { t0: 0.9, t1: 3.75, style: 'narr', lines: ['ТЫСЯЧУ ЛЕТ НАЗАД МИР ОСТАНОВИЛСЯ'] },
    { t0: 5.0, t1: 9.5, style: 'narr', lines: ['ОДНА ЕГО СТОРОНА СГОРАЕТ ПОД ВЕЧНЫМ СОЛНЦЕМ'] },
    { t0: 11.0, t1: 15.5, style: 'narr', lines: ['ДРУГАЯ — ЗАМЕРЗАЕТ В ВЕЧНОЙ НОЧИ'] },
    { t0: 17.0, t1: 21.6, style: 'narr', lines: ['МЕЖДУ НИМИ — ПОЛОСА СУМЕРЕК', 'И ПОСЛЕДНИЕ ИЗ НАС'] },
    { t0: 23.0, t1: 27.7, style: 'narr', lines: ['НО ДРЕВНИЕ МАШИНЫ ПОМНЯТ,', 'КАК ВРАЩАТЬ МИР'] },
    { t0: 30.03, t1: 30.97, style: 'flash', lines: ['ПЕРЕСЕКИ ДЕНЬ'] },
    { t0: 32.03, t1: 32.97, style: 'flash', lines: ['ПЕРЕЖИВИ НОЧЬ'] },
    { t0: 35.03, t1: 35.97, style: 'flash', lines: ['РАЗБУДИ МАШИНЫ'] },
    { t0: 48.7, t1: 51.75, style: 'narr', lines: ['ВЕРНИ МИРУ РАССВЕТ'], big: true },
    { t0: 52.2, t1: 59.7, style: 'title' },
    { t0: 55.4, t1: 59.7, style: 'cta', lines: ['ПРЕДЗАКАЗ ОТКРЫТ', 'ВЕСНА 2027'] },
  ];

  function envelope(t, t0, t1, fin, fout) {
    return smooth(t0, t0 + fin, t) * (1 - smooth(t1 - fout, t1, t));
  }

  function narr(ctx, cue, t, W, H) {
    const a = envelope(t, cue.t0, cue.t1, 0.7, 0.6);
    if (a <= 0) return 0;
    const p = (t - cue.t0) / (cue.t1 - cue.t0);
    const size = Math.round(H * (cue.big ? 0.05 : 0.036));
    ctx.font = `300 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const track = size * (0.2 + 0.1 * p);
    ctx.letterSpacing = track.toFixed(1) + 'px';
    const blur = (1 - smooth(cue.t0, cue.t0 + 0.8, t)) * 6 + smooth(cue.t1 - 0.6, cue.t1, t) * 4;
    ctx.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : 'none';
    const cy = cue.big ? H * 0.5 : H * 0.8;
    const lh = size * 1.75;
    cue.lines.forEach((ln, i) => {
      const la = cue.lines.length > 1 && i > 0 ? a * smooth(cue.t0 + 0.6, cue.t0 + 1.4, t) : a;
      ctx.fillStyle = `rgba(236,228,214,${(la * 0.95).toFixed(3)})`;
      ctx.fillText(ln, W / 2 + track / 2, cy + (i - (cue.lines.length - 1) / 2) * lh);
    });
    ctx.filter = 'none';
    return a * 0.12;
  }

  function flash(ctx, cue, t, W, H) {
    const a = envelope(t, cue.t0, cue.t1, 0.06, 0.1);
    if (a <= 0) return 0;
    const p = (t - cue.t0) / (cue.t1 - cue.t0);
    const size = Math.round(H * 0.105 * (1.06 - 0.06 * outCubic(p * 2)));
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const track = size * 0.12;
    ctx.letterSpacing = track.toFixed(1) + 'px';
    ctx.fillStyle = `rgba(255,246,232,${a.toFixed(3)})`;
    ctx.fillText(cue.lines[0], W / 2 + track / 2, H * 0.5);
    return a * 0.35;
  }

  function cta(ctx, cue, t, W, H) {
    const a = envelope(t, cue.t0, cue.t1, 0.9, 0.5);
    if (a <= 0) return 0;
    const size = Math.round(H * 0.03);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${size}px ${FONT}`;
    ctx.letterSpacing = (size * 0.45).toFixed(1) + 'px';
    ctx.fillStyle = `rgba(240,226,200,${(a * 0.95).toFixed(3)})`;
    ctx.fillText(cue.lines[0], W / 2 + size * 0.22, H * 0.78);
    const b = a * smooth(cue.t0 + 0.6, cue.t0 + 1.5, t);
    ctx.font = `300 ${Math.round(size * 0.8)}px ${FONT}`;
    ctx.letterSpacing = (size * 0.6).toFixed(1) + 'px';
    ctx.fillStyle = `rgba(210,200,185,${(b * 0.8).toFixed(3)})`;
    ctx.fillText(cue.lines[1], W / 2 + size * 0.3, H * 0.78 + size * 1.7);
    return a * 0.05;
  }

  // ---------------------------------------------------------------- MERIDIAN logotype (hand-built glyphs)
  // Glyphs in cap-height units, y up. Each: width + list of strokes (polylines or arcs).
  const GL = {
    M: { w: 1.0, s: [{ p: [[0, 0], [0, 1], [0.5, 0.36], [1, 1], [1, 0]] }] },
    E: { w: 0.74, s: [{ p: [[0.74, 1], [0, 1], [0, 0], [0.74, 0]] }, { p: [[0, 0.5], [0.58, 0.5]] }] },
    R: { w: 0.8, s: [{ p: [[0, 0], [0, 1], [0.5, 1]] }, { arc: [0.5, 0.75, 0.25, 90, -90] }, { p: [[0.5, 0.5], [0, 0.5]] }, { p: [[0.4, 0.5], [0.8, 0]] }] },
    I: { w: 0, meridian: true },
    D: { w: 0.9, s: [{ p: [[0.4, 0], [0, 0], [0, 1], [0.4, 1]] }, { arc: [0.4, 0.5, 0.5, 90, -90] }] },
    A: { w: 1.0, s: [{ p: [[0, 0], [0.5, 1], [1, 0]] }, { p: [[0.27, 0.42], [0.73, 0.42]] }] },
    N: { w: 0.92, s: [{ p: [[0, 0], [0, 1], [0.92, 0], [0.92, 1]] }] },
  };
  const WORD = 'MERIDIAN';
  const GAP = 0.6;
  const layoutW = (() => { let w = 0; for (let i = 0; i < WORD.length; i++) w += GL[WORD[i]].w + (i ? GAP : 0); return w; })();

  function strokeGlyph(ctx, g, ox, oy, H) {
    for (const s of g.s) {
      ctx.beginPath();
      if (s.p) {
        s.p.forEach((pt, i) => { const x = ox + pt[0] * H, y = oy - pt[1] * H; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      } else {
        const [cx, cy, r, a0, a1] = s.arc;
        ctx.arc(ox + cx * H, oy - cy * H, r * H, (-a0 * Math.PI) / 180, (-a1 * Math.PI) / 180, false);
      }
      ctx.stroke();
    }
  }

  function title(ctx, cue, t, W, H) {
    const a = 1 - smooth(cue.t1 - 0.7, cue.t1, t);
    if (t < cue.t0 || a <= 0) return 0;
    const cap = H * 0.13;
    const cx = W / 2, base = H * 0.36 + cap / 2;
    const x0 = cx - (layoutW * cap) / 2;
    const lw = Math.max(2, cap * 0.068);
    // horizon line born from a point of light
    const hl = outCubic(smooth(cue.t0, cue.t0 + 1.4, t));
    const hy = base + cap * 0.42;
    const halfW = (layoutW * cap * 0.72) * hl;
    const grad = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    grad.addColorStop(0, 'rgba(255,200,140,0)');
    grad.addColorStop(0.5, `rgba(255,236,210,${(0.95 * a).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,200,140,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - halfW, hy - lw * 0.35, halfW * 2, lw * 0.7);
    // letters rise out of the horizon, from the centre outward
    ctx.lineWidth = lw;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    let ox = x0;
    const n = WORD.length;
    for (let i = 0; i < n; i++) {
      const g = GL[WORD[i]];
      const order = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const st = cue.t0 + 0.5 + order * 0.7;
      const k = outCubic(smooth(st, st + 1.1, t));
      if (k > 0) {
        const rise = (1 - k) * cap * 0.35;
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox - cap, base - cap * 1.6, g.w * cap + cap * 2, cap * 1.6 + lw * 0.5);
        ctx.clip();
        const sweep = Math.exp(-Math.pow((t - (cue.t0 + 2.2) - (ox - x0) / (layoutW * cap) * 1.2) * 3.2, 2));
        const c = `rgba(${255},${Math.round(238 + 10 * sweep)},${Math.round(218 + 30 * sweep)},${(a * k).toFixed(3)})`;
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
        if (g.meridian) {
          const top = base + rise - cap * (1 + 0.55 * k), bot = base + rise + cap * 0.0;
          const mg = ctx.createLinearGradient(0, top, 0, bot);
          mg.addColorStop(0, 'rgba(255,230,200,0)');
          mg.addColorStop(0.3, c);
          mg.addColorStop(1, c);
          ctx.fillStyle = mg;
          ctx.fillRect(ox - lw / 2, top, lw, bot - top);
        } else strokeGlyph(ctx, g, ox, base + rise, cap);
        ctx.restore();
      }
      ox += g.w * cap + GAP * cap;
    }
    return 0.28 * a + 0.4 * Math.exp(-Math.pow((t - cue.t0 - 0.3) * 2, 2));
  }

  const Titles = (window.Titles = {
    cues: CUES,
    draw(ctx, t, W, H) {
      let glow = 0, any = false;
      for (const c of CUES) if (t >= c.t0 - 0.05 && t <= c.t1 + 0.05) any = true;
      if (!any) {
        if (this._dirty) { ctx.clearRect(0, 0, W, H); this._dirty = false; }
        return { active: false, glow: 0 };
      }
      ctx.clearRect(0, 0, W, H);
      this._dirty = true;
      for (const c of CUES) {
        if (t < c.t0 - 0.05 || t > c.t1 + 0.05) continue;
        if (c.style === 'narr') glow += narr(ctx, c, t, W, H);
        else if (c.style === 'flash') glow += flash(ctx, c, t, W, H);
        else if (c.style === 'cta') glow += cta(ctx, c, t, W, H);
        else if (c.style === 'title') glow += title(ctx, c, t, W, H);
      }
      return { active: true, glow };
    },
  });
})();
