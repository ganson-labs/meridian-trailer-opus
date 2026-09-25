// WebGL2 helpers: programs with parallel compilation, float render targets, uniform setters.
(function () {
  'use strict';
  const GLX = (window.GLX = {});

  GLX.VERT = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

  GLX.init = function (canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: false,
    });
    if (!gl) throw new Error('WebGL2 недоступен');
    GLX.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    GLX.parallel = gl.getExtension('KHR_parallel_shader_compile');
    GLX.vao = gl.createVertexArray();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    GLX.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    console.log('GPU', GLX.renderer);
    return gl;
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  function numbered(src) {
    return src.split('\n').map((l, i) => String(i + 1).padStart(4) + ': ' + l).join('\n');
  }

  // Starts compilation; call GLX.finish(prog) once GLX.ready(prog) is true.
  GLX.program = function (gl, fsSrc, name) {
    const vs = compile(gl, gl.VERTEX_SHADER, GLX.VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    return { gl, p, vs, fs, name, src: fsSrc, u: null, done: false };
  };

  GLX.ready = function (prog) {
    if (prog.done || !GLX.parallel) return true;
    return prog.gl.getProgramParameter(prog.p, GLX.parallel.COMPLETION_STATUS_KHR);
  };

  GLX.finish = function (prog) {
    if (prog.done) return prog;
    const gl = prog.gl;
    if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(prog.fs) || '';
      const m = /ERROR: 0:(\d+)/.exec(log);
      let ctx = '';
      if (m) {
        const ln = +m[1];
        ctx = numbered(prog.src).split('\n').slice(Math.max(0, ln - 4), ln + 2).join('\n');
      }
      throw new Error('Шейдер ' + prog.name + ':\n' + log + '\n' + ctx + '\n' + gl.getProgramInfoLog(prog.p));
    }
    prog.u = setters(gl, prog.p);
    prog.done = true;
    return prog;
  };

  function setters(gl, p) {
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    const out = {};
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      const t = info.type;
      let f;
      switch (t) {
        case gl.FLOAT: f = info.size > 1 ? (v) => gl.uniform1fv(loc, v) : (v) => gl.uniform1f(loc, v); break;
        case gl.FLOAT_VEC2: f = (v) => gl.uniform2fv(loc, v); break;
        case gl.FLOAT_VEC3: f = (v) => gl.uniform3fv(loc, v); break;
        case gl.FLOAT_VEC4: f = (v) => gl.uniform4fv(loc, v); break;
        case gl.FLOAT_MAT3: f = (v) => gl.uniformMatrix3fv(loc, false, v); break;
        case gl.INT: case gl.BOOL: f = (v) => gl.uniform1i(loc, v); break;
        case gl.SAMPLER_2D: {
          const u = unit++;
          f = (tex) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, u); };
          break;
        }
        default: f = () => {};
      }
      out[name] = f;
    }
    return out;
  }

  GLX.target = function (gl, w, h, opts) {
    opts = opts || {};
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f32 = opts.f32 && GLX.floatRT;
    const internal = GLX.floatRT ? (f32 ? gl.RGBA32F : gl.RGBA16F) : gl.RGBA8;
    const type = GLX.floatRT ? (f32 ? gl.FLOAT : gl.HALF_FLOAT) : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    const filt = opts.nearest || f32 ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.repeatS ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  };

  GLX.free = function (gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  };

  // Draw a fullscreen triangle into target (null = canvas with given viewport).
  GLX.draw = function (gl, prog, target, uniforms, viewport) {
    gl.useProgram(prog.p);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    }
    const u = prog.u;
    for (const k in uniforms) if (u[k]) u[k](uniforms[k]);
    gl.bindVertexArray(GLX.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
})();
