/**
 * Fundo "vivo": gradiente fluido animado em WebGL (ruído com domain warping).
 * Renderiza numa resolução reduzida (é suave por natureza) para poupar bateria.
 * Sem WebGL → fica o fallback em CSS (.blobs).
 */
(() => {
  const PALETTES = {
    aurora: ['#060816', '#3a1fd1', '#16b8ff', '#c03cff', '#ff7ac8'],
    sunset: ['#12060f', '#d1361f', '#ff9f43', '#b5179e', '#ffd166'],
    ocean:  ['#020c14', '#0a4bd6', '#00d4c8', '#3a7bff', '#9bf6ff'],
    mint:   ['#04120c', '#0f8a5f', '#3ef0a0', '#1e6bff', '#d6ff7a'],
  };

  const canvas = document.getElementById('bg');
  const gl = canvas && (canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

  function setPalette(name) {
    const p = PALETTES[name] ? name : 'aurora';
    document.documentElement.dataset.palette = p;
    document.querySelectorAll('.palette button').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
    try { localStorage.setItem('crawler-palette', p); } catch {}
    current = PALETTES[p].map(hex);
    if (reduceMotion) draw(performance.now());
  }

  let current = PALETTES.aurora.map(hex);
  let shown = current.map((c) => c.slice()); // cores interpoladas (transição suave)

  document.querySelectorAll('.palette button').forEach((b) =>
    b.addEventListener('click', () => setPalette(b.dataset.p))
  );

  if (!gl) {
    document.documentElement.classList.add('no-webgl');
    let saved; try { saved = localStorage.getItem('crawler-palette'); } catch {}
    setPalette(saved);
    return;
  }

  const vert = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
  const frag = `
    precision mediump float;
    uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;
    uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform vec3 c4;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                 mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
      for (int i = 0; i < 5; i++){ v += a * noise(p); p = R * p * 2.0 + 0.17; a *= 0.5; }
      return v;
    }
    void main(){
      vec2 uv = gl_FragCoord.xy / uRes;
      vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 1.4;
      float t = uTime * 0.045;

      vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
      vec2 w = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 1.4 + uMouse * 0.35),
                    fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 1.1));
      float f = fbm(p + 3.2 * w);

      vec3 col = c0;
      col = mix(col, c1, smoothstep(0.25, 0.85, f));
      col = mix(col, c2, smoothstep(0.35, 1.0, length(q)) * 0.75);
      col = mix(col, c3, smoothstep(0.45, 0.95, w.x) * 0.65);
      col = mix(col, c4, smoothstep(0.7, 1.0, f * w.y * 1.6) * 0.55);

      // vinheta + escurecer ligeiramente para o texto se ler bem
      float v = smoothstep(1.25, 0.25, length(uv - 0.5));
      col = mix(c0, col, 0.35 + 0.65 * v) * 0.88;
      // dithering para evitar "banding"
      col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
      gl_FragColor = vec4(col, 1.0);
    }`;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, vert));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) {
    console.warn('Fundo WebGL indisponível:', e);
    document.documentElement.classList.add('no-webgl');
    return;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ['uRes', 'uTime', 'uMouse', 'c0', 'c1', 'c2', 'c3', 'c4'].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));

  const SCALE = 0.35; // fração da resolução do ecrã
  function resize() {
    const w = Math.max(1, Math.round(innerWidth * SCALE));
    const h = Math.max(1, Math.round(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  // o rato/dedo "empurra" o fluido suavemente
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
    mouse.ty = (0.5 - e.clientY / innerHeight) * 2;
  }, { passive: true });

  function draw(now) {
    resize();
    for (let i = 0; i < 5; i++)
      for (let k = 0; k < 3; k++) shown[i][k] += (current[i][k] - shown[i][k]) * 0.04;
    mouse.x += (mouse.tx - mouse.x) * 0.03;
    mouse.y += (mouse.ty - mouse.y) * 0.03;

    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, reduceMotion ? 20 : now / 1000);
    gl.uniform2f(U.uMouse, mouse.x, mouse.y);
    ['c0', 'c1', 'c2', 'c3', 'c4'].forEach((n, i) => gl.uniform3fv(U[n], shown[i]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let raf = 0;
  function loop(now) {
    draw(now);
    raf = requestAnimationFrame(loop);
  }

  let saved; try { saved = localStorage.getItem('crawler-palette'); } catch {}
  setPalette(saved);
  shown = current.map((c) => c.slice());

  if (reduceMotion) {
    draw(0);
    addEventListener('resize', () => draw(0));
  } else {
    raf = requestAnimationFrame(loop);
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(loop);
    });
  }
})();
