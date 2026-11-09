/**
 * Fundo "seda líquida": fitas brilhantes que se dobram e fluem devagar.
 * A superfície é um campo de alturas animado; a luz (difusa + reflexo especular)
 * dá o aspeto de seda/vidro preto. Modo claro = exatamente o inverso.
 * Sem WebGL → fallback em CSS (.blobs).
 */
(() => {
  const META = { dark: '#000000', light: '#f2f2f4' };
  const root = document.documentElement;
  const canvas = document.getElementById('bg');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let darkTarget = 1;
  let darkShown = null;
  let redraw = () => {};

  function initialTheme() {
    let saved;
    try { saved = localStorage.getItem('crawler-theme'); } catch {}
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setTheme(name, save = true) {
    const t = name === 'light' ? 'light' : 'dark';
    root.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[t]);
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.setAttribute('aria-pressed', t === 'light');
      btn.title = t === 'light' ? 'Mudar para modo escuro' : 'Mudar para modo claro';
    }
    if (save) try { localStorage.setItem('crawler-theme', t); } catch {}
    darkTarget = t === 'dark' ? 1 : 0;
    if (darkShown == null) darkShown = darkTarget;
    redraw();
  }

  document.getElementById('themeToggle')?.addEventListener('click', () =>
    setTheme(root.dataset.theme === 'light' ? 'dark' : 'light')
  );
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
    let saved; try { saved = localStorage.getItem('crawler-theme'); } catch {}
    if (!saved) setTheme(e.matches ? 'light' : 'dark', false);
  });

  const gl = canvas && canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) {
    root.classList.add('no-webgl');
    setTheme(initialTheme(), false);
    return;
  }
  const hasDeriv = !!gl.getExtension('OES_standard_derivatives');

  const vert = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;
  const frag = `
    ${hasDeriv ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIV 1' : ''}
    precision highp float;
    uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uDark;

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
      for (int i = 0; i < 4; i++){ v += a * noise(p); p = R * p * 2.0 + 0.17; a *= 0.5; }
      return v;
    }

    // coordenada "ao longo" das fitas: diagonais largas, curvadas por ruído lento
    float ribbonCoord(vec2 p, float t){
      vec2 q = p + 0.5 * vec2(fbm(p * 0.6 + vec2(0.0, t)), fbm(p * 0.6 + vec2(4.7, -t))) - 0.25;
      q += uMouse * 0.05;
      float across = dot(q, vec2(-0.5, 0.86));
      float bend = fbm(q * 0.5 + vec2(t * 0.5, -t * 0.3)) * 2.6;
      return across * 3.4 + bend * 1.3 + sin(dot(q, vec2(0.86, 0.5)) * 1.6 + t * 1.3) * 0.45 + t * 0.6;
    }

    void main(){
      vec2 uv = gl_FragCoord.xy / uRes;
      vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y * 1.5;
      float t = uTime * 0.05;

      float s = ribbonCoord(p, t);
      #ifdef HAS_DERIV
        vec2 gs = vec2(dFdx(s), dFdy(s)) * uRes.y / 1.5;
      #else
        float e = 1.5 / uRes.y;
        vec2 gs = vec2(ribbonCoord(p + vec2(e, 0.0), t) - s, ribbonCoord(p + vec2(0.0, e), t) - s) / e;
      #endif

      // cada fita é um "tubo" de seda: perfil arredondado, vinco escuro entre fitas
      float band = floor(s);
      float x = fract(s) * 2.0 - 1.0;
      float prof = sqrt(max(1.0 - x * x, 0.0));
      float amp = 0.55 + 0.45 * hash(vec2(band, 3.1));        // fitas com relevos diferentes
      float dhds = -x / sqrt(1.0 - x * x + 0.04) * amp;
      vec2 g = dhds * gs * 0.22;
      vec3 N = normalize(vec3(-g, 1.0));

      vec3 L = normalize(vec3(-0.5, 0.7, 0.55));
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float ndh = max(dot(N, H), 0.0);
      float diff = max(dot(N, L), 0.0);
      float spec = pow(ndh, 80.0);          // reflexo fino e intenso
      float sheen = pow(ndh, 10.0);         // brilho largo
      float fres = pow(1.0 - N.z, 3.0);     // borda das fitas

      float shade = 0.01 + 0.07 * diff * diff + 0.75 * spec + 0.22 * sheen + 0.35 * fres;
      shade *= mix(0.25, 1.0, smoothstep(0.0, 0.45, prof));     // vinco escuro entre fitas
      shade *= 0.6 + 0.4 * hash(vec2(band, 7.7));                // umas fitas mais claras que outras
      float vig = smoothstep(1.4, 0.2, length(uv - vec2(0.5, 0.6)));
      shade *= 0.45 + 0.55 * vig;
      shade = clamp(shade, 0.0, 1.0);

      vec3 darkCol = vec3(shade) * vec3(0.97, 0.98, 1.02);
      vec3 lightCol = vec3(1.0) - vec3(shade) * 0.82 * vec3(1.02, 1.01, 0.98) - 0.03;  // o inverso
      vec3 col = mix(lightCol, darkCol, uDark);
      col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;   // dithering (evita "degraus")
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
    root.classList.add('no-webgl');
    setTheme(initialTheme(), false);
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
  ['uRes', 'uTime', 'uMouse', 'uDark'].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));

  function resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 2) * (innerWidth > 1400 ? 0.5 : 0.65);
    const w = Math.max(1, Math.round(innerWidth * scale));
    const h = Math.max(1, Math.round(innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
    mouse.ty = (0.5 - e.clientY / innerHeight) * 2;
  }, { passive: true });

  let prevNow = 0;
  function draw(now, k) {
    resize();
    // transição pelo tempo (~0,6 s), igual em qualquer aparelho
    const dt = prevNow ? Math.min((now - prevNow) / 1000, 0.25) : 1;
    prevNow = now;
    darkShown += (darkTarget - darkShown) * (k ?? 1 - Math.exp(-dt * 6));
    mouse.x += (mouse.tx - mouse.x) * 0.03;
    mouse.y += (mouse.ty - mouse.y) * 0.03;
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, reduceMotion ? 40 : now / 1000);
    gl.uniform2f(U.uMouse, mouse.x, mouse.y);
    gl.uniform1f(U.uDark, darkShown);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  setTheme(initialTheme(), false);

  if (reduceMotion) {
    redraw = () => draw(0, 1);
    redraw();
    addEventListener('resize', redraw);
    return;
  }

  let raf = 0, last = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < 22) return;   // ~45 fps
    last = now;
    draw(now);
  }
  raf = requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(loop);
  });
})();
