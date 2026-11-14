/* =========================================================
   Leitor de códigos de barras (EAN-13, EAN-8, UPC-A)
   Câmara ao vivo, foto ou número escrito à mão → preços noutras lojas.

   - Usa o BarcodeDetector do browser quando existe (Chrome/Android).
   - Senão (ex.: Safari no iPhone) usa o descodificador abaixo, sem bibliotecas externas.
   - Os preços vêm do teu histórico (o mesmo EAN visto noutras lojas)
     e da IA do Worker (/deal só com o EAN), sempre com link para a página.
   ========================================================= */

const Barcode = (() => {
  /* ---------- dígito de controlo ---------- */
  function validGtin(code) {
    code = String(code || '').replace(/\D/g, '');
    if (![8, 12, 13, 14].includes(code.length)) return false;
    const d = [...code].map(Number);
    const check = d.pop();
    const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === check;
  }

  /* ---------- descodificador EAN/UPC a partir de uma linha de píxeis ---------- */
  // larguras (em módulos) de cada dígito no conjunto L; R = L com as cores trocadas (mesmas larguras); G = L ao contrário
  const L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map((s) => [...s].map(Number));
  const G = L.map((w) => [...w].reverse());
  // paridade dos 6 primeiros dígitos (L/G) -> primeiro dígito do EAN-13
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  /** dígito mais parecido com 4 larguras medidas (normalizadas para 7 módulos) */
  function matchDigit(runs, tables) {
    const total = runs[0] + runs[1] + runs[2] + runs[3];
    const n = runs.map((r) => (r * 7) / total);
    let best = null;
    for (const [set, table] of tables) {
      table.forEach((w, digit) => {
        const err = Math.abs(n[0] - w[0]) + Math.abs(n[1] - w[1]) + Math.abs(n[2] - w[2]) + Math.abs(n[3] - w[3]);
        if (!best || err < best.err) best = { digit, set, err };
      });
    }
    return best && best.err < 2.2 ? best : null;
  }

  const guardOk = (runs, i, n, unit) => {
    for (let k = 0; k < n; k++) if (Math.abs(runs[i + k] / unit - 1) > 0.75) return false;
    return true;
  };

  /** tenta ler EAN-13/UPC-A (59 barras/espaços) ou EAN-8 (43) a partir das larguras, começando numa barra */
  function decodeRuns(runs, startsDark) {
    const out = [];
    for (let i = startsDark ? 0 : 1; i < runs.length; i += 2) {
      for (const [count, modules, half] of [[59, 95, 6], [43, 67, 4]]) {
        if (i + count > runs.length) continue;
        const slice = runs.slice(i, i + count);
        const unit = slice.reduce((a, b) => a + b, 0) / modules;
        // zona de silêncio antes da primeira barra (pelo menos ~5 módulos de branco)
        if (i > 0 && runs[i - 1] < unit * 4) continue;
        if (!guardOk(slice, 0, 3, unit) || !guardOk(slice, 3 + half * 4, 5, unit) || !guardOk(slice, count - 3, 3, unit)) continue;
        const left = [], right = [];
        let ok = true;
        for (let d = 0; d < half && ok; d++) {
          const m = matchDigit(slice.slice(3 + d * 4, 7 + d * 4), count === 59 ? [['L', L], ['G', G]] : [['L', L]]);
          if (!m) ok = false; else left.push(m);
        }
        const r0 = 3 + half * 4 + 5;
        for (let d = 0; d < half && ok; d++) {
          const m = matchDigit(slice.slice(r0 + d * 4, r0 + 4 + d * 4), [['R', L]]);
          if (!m) ok = false; else right.push(m);
        }
        if (!ok) continue;
        let code;
        if (count === 59) {
          const first = PARITY.indexOf(left.map((m) => m.set).join(''));
          if (first < 0) continue;
          code = first + left.map((m) => m.digit).join('') + right.map((m) => m.digit).join('');
        } else code = left.map((m) => m.digit).join('') + right.map((m) => m.digit).join('');
        if (validGtin(code)) out.push(code);
      }
    }
    return out;
  }

  /** larguras das zonas escuras/claras de uma linha de cinzentos (limiar = meio entre o mais claro e o mais escuro) */
  function runsOf(gray, threshold) {
    const runs = [];
    let dark = gray[0] < threshold, len = 0;
    const startsDark = dark;
    for (const g of gray) {
      const d = g < threshold;
      if (d === dark) len++; else { runs.push(len); len = 1; dark = d; }
    }
    runs.push(len);
    return { runs, startsDark };
  }

  function scanLine(gray) {
    let min = 255, max = 0;
    for (const g of gray) { if (g < min) min = g; if (g > max) max = g; }
    if (max - min < 40) return null;                       // linha sem contraste
    for (const t of [0.5, 0.4, 0.6]) {
      const { runs, startsDark } = runsOf(gray, min + (max - min) * t);
      if (runs.length < 45) continue;
      const fwd = decodeRuns(runs, startsDark);
      if (fwd.length) return fwd[0];
      const rev = runs.slice().reverse();                  // código de pernas para o ar
      const back = decodeRuns(rev, (runs.length % 2 === 1) === startsDark);
      if (back.length) return back[0];
    }
    return null;
  }

  /** procura um código em várias linhas de uma imagem (ImageData), na horizontal e na vertical (rápido: câmara ao vivo) */
  function decodeImageData(img) { return deepScan(img, { angles: [0, 90], spacing: 0, rows: 24 }); }

  /**
   * Procura exaustiva: linhas em vários ângulos (código torto), muitas posições e amostragem
   * entre píxeis (funciona como zoom em códigos pequenos). Para fotos, onde há tempo.
   */
  function exhaustiveScan(img) {
    const angles = [];
    for (let a = -85; a <= 90; a += 5) angles.push(a);
    return deepScan(img, { angles, spacing: 5, step: 0.5 });
  }

  function deepScan({ data, width, height }, { angles, spacing, rows = 24, step = 1, deadline = Infinity }) {
    // cinzentos uma vez
    const gray = new Float32Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    const at = (x, y) => {                                  // bilinear: amostras entre píxeis
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) return -1;
      const fx = x - x0, fy = y - y0, i = y0 * width + x0;
      return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + width] * (1 - fx) + gray[i + width + 1] * fx) * fy;
    };
    const votes = new Map();
    const t0 = Date.now();
    const cx = width / 2, cy = height / 2, diag = Math.hypot(width, height);
    const buf = new Float32Array(Math.ceil(diag / step) + 2);
    for (const deg of angles) {
      const r = (deg * Math.PI) / 180, dx = Math.cos(r), dy = Math.sin(r), nx = -dy, ny = dx;   // direção da linha e perpendicular
      const n = spacing ? Math.floor(diag / spacing) : rows;
      for (let k = 0; k < n; k++) {
        if (Date.now() - t0 > deadline) break;
        const off = spacing ? (k - n / 2) * spacing : (((k + 1) / (rows + 1)) - 0.5) * (Math.abs(dx) > Math.abs(dy) ? height : width);
        const ox = cx + nx * off, oy = cy + ny * off;
        // percorre a linha inteira; média de 5 amostras na perpendicular (tira ruído sem esbater as barras)
        let len = 0;
        for (let t = -diag / 2; t <= diag / 2; t += step) {
          const px = ox + dx * t, py = oy + dy * t;
          let sum = 0, c = 0;
          for (let o = -2; o <= 2; o++) { const v = at(px + nx * o, py + ny * o); if (v >= 0) { sum += v; c++; } }
          if (c) buf[len++] = sum / c; else if (len) break;
        }
        if (len < 60) continue;
        const code = scanLine(buf.subarray(0, len));
        if (code) {
          const v = (votes.get(code) || 0) + 1;
          votes.set(code, v);
          if (v >= 2) return code;
        }
      }
    }
    // só uma linha leu: aceita (o dígito de controlo já confirmou)
    return votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  }

  /* ---------- fontes de imagem ---------- */
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  function frameData(src, w, h, maxW = 1280) {
    const scale = Math.min(1, maxW / Math.max(w, h));
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);   // maxW = lado maior
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  const native = typeof window !== 'undefined' && 'BarcodeDetector' in window
    ? (() => { try { return new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); } catch { return null; } })()
    : null;

  async function detect(src, w, h, maxW = 1280) {
    if (native) {
      try {
        const found = await native.detect(src);
        const code = found.map((b) => b.rawValue).find(validGtin);
        if (code) return code;
      } catch { /* cai para o descodificador próprio */ }
    }
    return decodeImageData(frameData(src, w, h, maxW));
  }

  async function decodeFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // 1) rápido; 2) procura exaustiva (ângulos, zoom) na foto; 3) com mais resolução se a foto for grande
      const w = img.naturalWidth, h = img.naturalHeight;
      return (await detect(img, w, h)) ||
        exhaustiveScan(frameData(img, w, h, 1400)) ||
        (Math.max(w, h) > 1500 ? exhaustiveScan(frameData(img, w, h, 2400)) : null);
    } finally { URL.revokeObjectURL(url); }
  }

  /* ---------- câmara ao vivo ---------- */
  let stream = null, timer = null;
  async function startCamera(video, onCode) {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    let busy = false;
    timer = setInterval(async () => {
      if (busy || !video.videoWidth) return;
      busy = true;
      try {
        const code = await detect(video, video.videoWidth, video.videoHeight);
        if (code) { const frame = await photoDataUrl(video, video.videoWidth, video.videoHeight); stopCamera(); onCode(code, frame); }
      } finally { busy = false; }
    }, 250);
  }
  function stopCamera() {
    clearInterval(timer); timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  /* ---------- preços ---------- */
  /** o mesmo EAN no teu histórico e nesta pesquisa */
  function localPrices(ean) {
    const id = LiteX.productIdentity({ ean });
    const out = Store.otherStores({ ean, url: 'scan:' + ean });
    for (const it of items) {
      if (it.price != null && Store.productIdentity(it) === id && !out.some((o) => o.url === it.url)) {
        out.push({ store: hostOf(it.url), url: it.url, name: it.name, price: it.price, date: today(), av: it.availability });
      }
    }
    return out.sort((a, b) => a.price - b.price);
  }

  async function workerPost(path, body) {
    const base = workerBase();
    if (!base) throw new Error('Configura "O meu proxy" (o teu Worker) para procurar preços online');
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...workerHeaders() }, body: JSON.stringify(body) });
  }

  /** preços online: pelo EAN, ou pelo nome lido na foto ({ name }) */
  async function onlinePrices(ean, price, country, name) {
    const res = await workerPost('/deal', name
      ? { name, ean: ean || undefined, lookup: true, price: price || undefined, country, currency: 'EUR' }
      : { ean, price: price || undefined, country, currency: 'EUR' });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    // "Faltam name/price" = o Worker antigo, que ainda não conhece a pesquisa só com o código
    if (/Faltam name\/price/.test(data.error || '') || (res.ok && !Array.isArray(data.prices))) {
      throw new Error('O teu Worker ainda é a versão antiga: cola o worker/cloudflare-worker.js novo na Cloudflare (Edit code → colar → Deploy) e tenta de novo.');
    }
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (!Array.isArray(data.prices)) throw new Error('O Worker é de uma versão antiga: cola o worker/cloudflare-worker.js novo na Cloudflare e faz Deploy');
    return data;
  }

  /** foto -> JPEG pequeno (a IA lê a etiqueta: nome, EAN e preço) */
  async function photoDataUrl(src, w, h) {
    const c = document.createElement('canvas');
    const k = Math.min(1, 1280 / Math.max(w, h));
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }
  async function fileDataUrl(file) {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return await photoDataUrl(img, img.naturalWidth, img.naturalHeight); }
    finally { URL.revokeObjectURL(url); }
  }
  async function identify(image) {
    const res = await workerPost('/identify', { image });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (res.status === 404 || /So GET|Use \?url/.test(data.error || '')) throw new Error('o teu Worker ainda não lê fotos (atualiza-o)');
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ---------- folha "Ler código" ---------- */
  function initUi() {
    if (!$('scanPanel')) return;
    const SETTINGS = 'crawler-scan';
    try { const s = JSON.parse(localStorage.getItem(SETTINGS)) || {}; if (s.country) $('scanCountry').value = s.country; } catch {}
    const status = (html) => { $('scanStatus').innerHTML = html; };

    const localHtmlOf = (code) => {
      const local = code ? localPrices(code) : [];
      return local.length
        ? `<h3>No teu histórico</h3>${local.slice(0, 8).map((o) => `<a class="cmp-row" href="${esc(o.url)}" target="_blank" rel="noopener"><span>${esc(o.store)}<small>${esc(o.name || '')} · ${fmtDate(o.date)}${o.av === 'out' ? ' · esgotado' : ''}</small></span><b>${fmtPrice(o.price)}</b></a>`).join('')}`
        : '';
    };
    const head = ({ name, code, price, note }) => `<div class="scan-code">${name ? `<b>${esc(name)}</b><br>` : ''}${code ? `EAN ${code}` : ''}${price ? `${code ? ' · ' : ''}na loja: <b>${fmtPrice(price)}</b>` : ''}${note || ''}</div>`;

    /** preços do produto: pelo código; se a IA não o reconhecer e houver foto, lê a etiqueta e procura pelo nome */
    async function lookup(code, { photo = null } = {}) {
      code = code ? String(code).replace(/\D/g, '') : '';
      if (code && !validGtin(code)) { status('⚠️ Este número não é um EAN válido (8, 12 ou 13 dígitos, com o último a confirmar).'); return; }
      if (!code && !photo) return;
      if (code) { $('scanEan').value = code; navigator.vibrate?.(60); }
      let price = numOrNull($('scanPrice').value);
      const country = $('scanCountry').value;
      try { localStorage.setItem(SETTINGS, JSON.stringify({ country })); } catch {}
      const localHtml = localHtmlOf(code);
      $('scanResult').scrollIntoView?.({ block: 'nearest' });
      let d = null, name = null, err = null;
      if (code) {
        status(`${head({ code, price })}${localHtml}<div class="deal-box loading">🔎 A procurar este produto e os preços noutras lojas…</div>`);
        try { d = await onlinePrices(code, price, country); name = d.productName; } catch (e) { err = e; }
      }
      // código interno da loja (a IA não o conhece) ou nenhum código na foto: ler a etiqueta
      if (photo && (!d || !d.productName || !d.prices.length) && !/antiga|Worker/.test(err?.message || '')) {
        status(`${head({ code, price })}${localHtml}<div class="deal-box loading">🔎 ${code ? 'Este código não diz que produto é — ' : ''}a ler a etiqueta da foto…</div>`);
        try {
          const id = await identify(photo);
          if (id.name) {
            name = id.name;
            if (!price && id.price) { price = id.price; $('scanPrice').value = id.price; }
            status(`${head({ name, code, price, note: '<br><small>lido na foto</small>' })}${localHtml}<div class="deal-box loading">🔎 A procurar os preços de ${esc(name)} noutras lojas…</div>`);
            d = await onlinePrices(id.ean || (code && d?.productName ? code : ''), price, country, name);
            err = null;
          } else if (!d) err = new Error('Não consegui ler o produto na foto. Tira outra com o nome ou o código bem visíveis, ou escreve o número.');
        } catch (e) { err = d ? null : e; }
      }
      if (!d) { status(`${head({ code, price })}${localHtml}<div class="deal-box v-caro">⚠️ ${esc(err?.message || 'Sem resultado')}</div>`); return; }
      const cheaper = price && d.lowestPrice != null && d.lowestPrice < price ? ` · <b class="scan-save">${fmtPrice(price - d.lowestPrice)} mais barato online</b>` : '';
      status(`${head({ name: name || d.productName, code, price, note: cheaper })}
        ${localHtml}
        ${d.prices.length ? '' : '<p class="empty">A IA não encontrou preços com link para este produto.</p>'}
        ${dealHtml(d)}`);
    }

    $('scanCam').addEventListener('click', async () => {
      if (!navigator.mediaDevices?.getUserMedia) return $('scanFile').click();
      $('scanVideoWrap').classList.remove('hidden');
      status('Aponta a câmara ao código de barras, na horizontal e bem iluminado.');
      try {
        await startCamera($('scanVideo'), async (code, frame) => { $('scanVideoWrap').classList.add('hidden'); lookup(code, { photo: frame }); });
      } catch (e) {
        $('scanVideoWrap').classList.add('hidden');
        status(`⚠️ Não deu para abrir a câmara (${esc(e.name === 'NotAllowedError' ? 'permissão recusada' : e.message)}). Usa <b>Tirar foto</b> ou escreve o número.`);
      }
    });
    $('scanStop').addEventListener('click', () => { stopCamera(); $('scanVideoWrap').classList.add('hidden'); status(''); });
    $('scanPhoto').addEventListener('click', () => $('scanFile').click());
    $('scanPick').addEventListener('click', () => $('scanGallery').click());
    const onFile = async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      status('🔎 A procurar o código de barras na foto (em vários ângulos e com zoom)…');
      const [code, photo] = await Promise.all([decodeFile(f).catch(() => null), fileDataUrl(f).catch(() => null)]);
      if (code || photo) lookup(code, { photo });
      else status('⚠️ Não consegui abrir esta foto. Tenta outra, ou escreve o número.');
    };
    $('scanFile').addEventListener('change', onFile);
    $('scanGallery').addEventListener('change', onFile);
    $('scanForm').addEventListener('submit', (e) => { e.preventDefault(); lookup($('scanEan').value); });
    // a câmara desliga-se quando a folha fecha
    document.addEventListener('sheet', (e) => { if (e.detail !== 'scan') { stopCamera(); $('scanVideoWrap').classList.add('hidden'); } });
    new MutationObserver(() => { if ($('scanPanel').classList.contains('hidden')) { stopCamera(); $('scanVideoWrap').classList.add('hidden'); } })
      .observe($('scanPanel'), { attributes: true, attributeFilter: ['class'] });
  }

  return { validGtin, decodeImageData, exhaustiveScan, scanLine, decodeFile, localPrices, initUi, hasNative: !!native };
})();
