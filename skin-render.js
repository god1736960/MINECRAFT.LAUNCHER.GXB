// =====================================================================
// skin-render.js  —  Visor 3D de skin + capa en WebGL REAL (motor nuevo)
// ---------------------------------------------------------------------
// Reemplaza el viejo "cubo" hecho con <div> + CSS (que se deformaba en
// ciertos angulos por no tener profundidad real). Esto usa WebGL con
// Z-buffer: cada cara ocupa su sitio y NUNCA se solapa ni flota, se mire
// desde donde se mire. Sin librerias externas, 100% offline.
// API global:  window.SkinView.init(canvas)
//              window.SkinView.setSkin(dataURL, slim)
//              window.SkinView.setCape(dataURL | null)
//              window.SkinView.setRotation(rx, ry)   (grados)
//              window.SkinView.resize()
// =====================================================================
(function () {
  'use strict';

  // ----------------------- Mini algebra 4x4 -------------------------
  function ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  function mul(a, b) {
    var o = new Array(16);
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] +
                       a[1 * 4 + r] * b[c * 4 + 1] +
                       a[2 * 4 + r] * b[c * 4 + 2] +
                       a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function perspective(fovyDeg, aspect, near, far) {
    var f = 1 / Math.tan((fovyDeg * Math.PI / 180) / 2);
    var nf = 1 / (near - far);
    return [ f / aspect,0,0,0,  0,f,0,0,
             0,0,(far + near) * nf,-1,  0,0,2 * far * near * nf,0 ];
  }
  function translate(x, y, z) { var m = ident(); m[12]=x; m[13]=y; m[14]=z; return m; }
  function rotX(deg) { var a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; }
  function rotY(deg) { var a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }

  // ----------------------- Estado del modulo ------------------------
  var gl = null, canvas = null, prog = null;
  var uMVP = null, aPos = null, aUV = null, uTex = null;
  var bodyBuf = { buf: null, uv: null, n: 0, tex: null };
  var capeBuf = { buf: null, uv: null, n: 0, tex: null };
  var rotX_ = 0, rotY_ = 22;      // angulos de camara (arrastre)
  var raf = 0, dirty = true;

  // ----------------------- Shaders ----------------------------------
  var VS =
    'attribute vec3 aPos; attribute vec2 aUV;' +
    'uniform mat4 uMVP; varying vec2 vUV;' +
    'void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 1.0); }';
  var FS =
    'precision mediump float; varying vec2 vUV; uniform sampler2D uTex;' +
    'void main(){ vec4 c = texture2D(uTex, vUV);' +
    ' if (c.a < 0.5) discard; gl_FragColor = c; }';

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('shader', gl.getShaderInfoLog(s)); return null;
    }
    return s;
  }

  // ----------------------- Textura (NEAREST, pixel art) -------------
  function makeTexture(img) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // =================================================================
  // GEOMETRIA  (continua en la 2a parte)
  // =================================================================
  // Empuja un triangulo-vertice (posicion + uv) a los arrays.
  function pv(pos, uv, p, u, v) { pos.push(p[0], p[1], p[2]); uv.push(u, v); }

  // Pinta una cara (quad) con 2 triangulos. corners = [UL,UR,LL,LR].
  // region = [ru, rv, rw, rh] en pixeles de textura (origen arriba-izq).
  function face(pos, uv, corners, region, tw, th) {
    var ru = region[0], rv = region[1], rw = region[2], rh = region[3];
    var uL = ru / tw, uR = (ru + rw) / tw, vT = rv / th, vB = (rv + rh) / th;
    var UL = corners[0], UR = corners[1], LL = corners[2], LR = corners[3];
    pv(pos, uv, UL, uL, vT); pv(pos, uv, LL, uL, vB); pv(pos, uv, LR, uR, vB);
    pv(pos, uv, UL, uL, vT); pv(pos, uv, LR, uR, vB); pv(pos, uv, UR, uR, vT);
  }

  // Caja: g = geometria {x0,y0,z0,x1,y1,z1}; t = textura {u,v,w,h,d,tw,th}.
  // El "net" de Minecraft deriva las 6 regiones a partir de (u,v,w,h,d).
  function addBox(pos, uv, g, t) {
    var x0=g.x0,y0=g.y0,z0=g.z0, x1=g.x1,y1=g.y1,z1=g.z1;
    var u=t.u,v=t.v,w=t.w,h=t.h,d=t.d, tw=t.tw, th=t.th;
    var top    = [u + d,         v,       w, d];
    var bottom = [u + d + w,     v,       w, d];
    var left   = [u,             v + d,   d, h];
    var front  = [u + d,         v + d,   w, h];
    var right  = [u + d + w,     v + d,   d, h];
    var back   = [u + d + w + d, v + d,   w, h];
    // +Z (frente)
    face(pos, uv, [[x0,y1,z1],[x1,y1,z1],[x0,y0,z1],[x1,y0,z1]], front, tw, th);
    // -Z (espalda)
    face(pos, uv, [[x1,y1,z0],[x0,y1,z0],[x1,y0,z0],[x0,y0,z0]], back, tw, th);
    // +X (costado)
    face(pos, uv, [[x1,y1,z0],[x1,y1,z1],[x1,y0,z0],[x1,y0,z1]], left, tw, th);
    // -X (costado)
    face(pos, uv, [[x0,y1,z1],[x0,y1,z0],[x0,y0,z1],[x0,y0,z0]], right, tw, th);
    // +Y (arriba)
    face(pos, uv, [[x0,y1,z0],[x1,y1,z0],[x0,y1,z1],[x1,y1,z1]], top, tw, th);
    // -Y (abajo)
    face(pos, uv, [[x0,y0,z1],[x1,y0,z1],[x0,y0,z0],[x1,y0,z0]], bottom, tw, th);
  }

  function g6(x0,y0,z0,x1,y1,z1){ return {x0:x0,y0:y0,z0:z0,x1:x1,y1:y1,z1:z1}; }
  function expand(g, m){ return g6(g.x0-m,g.y0-m,g.z0-m, g.x1+m,g.y1+m,g.z1+m); }

  // --------- Construye la malla del cuerpo segun ancho de brazo -----
  // aw = ancho de brazo (4 normal, 3 slim). overlay = capa exterior.
  function buildBody(aw, overlay, tw, th) {
    var pos = [], uv = [];
    var OV = 0.5; // margen de la 2a capa (sombrero/chaqueta/mangas)
    // Geometrias base
    var head = g6(-4,24,-4,  4,32,4);
    var body = g6(-4,12,-2,  4,24,2);
    var rArm = g6(-4-aw,12,-2,  -4,24,2);
    var lArm = g6(4,12,-2,  4+aw,24,2);
    var rLeg = g6(-4,0,-2,  0,12,2);
    var lLeg = g6(0,0,-2,  4,12,2);
    // Base layer
    addBox(pos, uv, head, {u:0, v:0,  w:8,h:8,d:8, tw:tw,th:th});
    addBox(pos, uv, body, {u:16,v:16, w:8,h:12,d:4, tw:tw,th:th});
    addBox(pos, uv, rArm, {u:40,v:16, w:aw,h:12,d:4, tw:tw,th:th});
    addBox(pos, uv, rLeg, {u:0, v:16, w:4,h:12,d:4, tw:tw,th:th});
    if (overlay) {
      // Brazo y pierna izquierdos + capas exteriores (solo skins 64x64)
      addBox(pos, uv, lArm, {u:32,v:48, w:aw,h:12,d:4, tw:tw,th:th});
      addBox(pos, uv, lLeg, {u:16,v:48, w:4,h:12,d:4, tw:tw,th:th});
      addBox(pos, uv, expand(head,OV), {u:32,v:0,  w:8,h:8,d:8, tw:tw,th:th});   // sombrero
      addBox(pos, uv, expand(body,OV), {u:16,v:32, w:8,h:12,d:4, tw:tw,th:th});  // chaqueta
      addBox(pos, uv, expand(rArm,OV), {u:40,v:32, w:aw,h:12,d:4, tw:tw,th:th}); // manga der
      addBox(pos, uv, expand(lArm,OV), {u:48,v:48, w:aw,h:12,d:4, tw:tw,th:th}); // manga izq
      addBox(pos, uv, expand(rLeg,OV), {u:0, v:32, w:4,h:12,d:4, tw:tw,th:th});  // pernera der
      addBox(pos, uv, expand(lLeg,OV), {u:0, v:48, w:4,h:12,d:4, tw:tw,th:th});  // pernera izq
    } else {
      // Skin antigua 64x32: brazo/pierna izq = espejo del derecho
      addBox(pos, uv, lArm, {u:40,v:16, w:aw,h:12,d:4, tw:tw,th:th});
      addBox(pos, uv, lLeg, {u:0, v:16, w:4,h:12,d:4, tw:tw,th:th});
    }
    return { pos: pos, uv: uv };
  }

  // --------- Construye la malla de la capa (10x16x1) ----------------
  // Caja a la espalda; cara exterior (-Z) con el diseno grande (1,1).
  function buildCape(tw, th) {
    var pos = [], uv = [];
    var x0=-5,x1=5, y0=8,y1=24, z0=-3.0,z1=-2.0; // detras del torso
    var fOut=[1,1,10,16], fIn=[12,1,10,16];
    var rT=[1,0,10,1], rB=[11,0,10,1], rL=[0,1,1,16], rR=[11,1,1,16];
    // -Z exterior (visible desde atras)
    face(pos, uv, [[x1,y1,z0],[x0,y1,z0],[x1,y0,z0],[x0,y0,z0]], fOut, tw, th);
    // +Z interior (hacia el cuerpo)
    face(pos, uv, [[x0,y1,z1],[x1,y1,z1],[x0,y0,z1],[x1,y0,z1]], fIn, tw, th);
    // +X / -X cantos
    face(pos, uv, [[x1,y1,z0],[x1,y1,z1],[x1,y0,z0],[x1,y0,z1]], rR, tw, th);
    face(pos, uv, [[x0,y1,z1],[x0,y1,z0],[x0,y0,z1],[x0,y0,z0]], rL, tw, th);
    // arriba / abajo
    face(pos, uv, [[x0,y1,z0],[x1,y1,z0],[x0,y1,z1],[x1,y1,z1]], rT, tw, th);
    face(pos, uv, [[x0,y0,z1],[x1,y0,z1],[x0,y0,z0],[x1,y0,z0]], rB, tw, th);
    return { pos: pos, uv: uv };
  }

  function upload(target, mesh) {
    if (!target.buf) target.buf = gl.createBuffer();
    if (!target.uv) target.uv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.pos), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.uv), gl.STATIC_DRAW);
    target.n = mesh.pos.length / 3;
  }

  // =================================================================
  // DIBUJADO
  // =================================================================
  function drawMesh(target, mvp) {
    if (!target.n || !target.tex) return;
    gl.uniformMatrix4fv(uMVP, false, new Float32Array(mvp));
    gl.bindBuffer(gl.ARRAY_BUFFER, target.buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.uv);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, target.n);
  }

  function render() {
    raf = 0;
    if (!gl) return;
    var w = canvas.width, h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    var proj = perspective(38, w / h, 1, 1000);
    // vista: alejar, girar segun arrastre, y centrar el modelo (y:-16)
    // (-96 en Z = camara mas lejos: el personaje entra COMPLETO en el visor
    //  sin tener que desplazarse con las flechas)
    var view = mul(translate(0, 0, -96), mul(rotX(rotX_), rotY(rotY_)));
    var mv = mul(view, translate(0, -16, 0));
    var mvp = mul(proj, mv);
    drawMesh(bodyBuf, mvp);
    // capa con ligera inclinacion hacia atras desde los hombros
    var pivotY = 24;
    var tilt = mul(translate(0, pivotY, -2),
                   mul(rotX(10), translate(0, -pivotY, 2)));
    drawMesh(capeBuf, mul(mvp, tilt));
  }
  function requestDraw() { if (!raf) raf = requestAnimationFrame(render); }

  // =================================================================
  // API PUBLICA
  // =================================================================
  function sizeCanvas() {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  var SkinView = {
    init: function (cv) {
      canvas = cv;
      gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: false,
        antialias: true, preserveDrawingBuffer: false });
      if (!gl) { console.error('WebGL no disponible'); return false; }
      var vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      aPos = gl.getAttribLocation(prog, 'aPos');
      aUV  = gl.getAttribLocation(prog, 'aUV');
      uMVP = gl.getUniformLocation(prog, 'uMVP');
      uTex = gl.getUniformLocation(prog, 'uTex');
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);         // sin descarte: Z-buffer resuelve todo
      sizeCanvas();
      window.addEventListener('resize', function () { sizeCanvas(); requestDraw(); });
      return true;
    },
    setSkin: function (dataURL, slim) {
      if (!gl || !dataURL) return;
      var img = new Image();
      img.onload = function () {
        var tw = img.width || 64, th = img.height || 64;
        var overlay = th >= 64;          // 64x64 => 2a capa + miembros izq
        var aw = slim ? 3 : 4;
        upload(bodyBuf, buildBody(aw, overlay, tw, th));
        if (bodyBuf.tex) gl.deleteTexture(bodyBuf.tex);
        bodyBuf.tex = makeTexture(img);
        requestDraw();
      };
      img.src = dataURL;
    },
    setCape: function (dataURL) {
      if (!gl) return;
      if (!dataURL) {
        if (capeBuf.tex) { gl.deleteTexture(capeBuf.tex); capeBuf.tex = null; }
        capeBuf.n = 0; requestDraw(); return;
      }
      var img = new Image();
      img.onload = function () {
        var tw = img.width || 64, th = img.height || 32;
        upload(capeBuf, buildCape(tw, th));
        if (capeBuf.tex) gl.deleteTexture(capeBuf.tex);
        capeBuf.tex = makeTexture(img);
        requestDraw();
      };
      img.src = dataURL;
    },
    setRotation: function (rx, ry) { rotX_ = rx; rotY_ = ry; requestDraw(); },
    resize: function () { sizeCanvas(); requestDraw(); }
  };

  window.SkinView = SkinView;
})();
