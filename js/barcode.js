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

  /** procura um código em várias linhas de uma imagem (ImageData), na horizontal e na vertical */
  function decodeImageData({ data, width, height }) {
    const lum = (i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    const votes = new Map();
    const vote = (c) => { if (!c) return null; const n = (votes.get(c) || 0) + 1; votes.set(c, n); return n >= 2 ? c : null; };
    const rows = 24;
    for (const vertical of [false, true]) {
      const lines = vertical ? width : height, len = vertical ? height : width;
      const row = new Float32Array(len);
      for (let k = 1; k <= rows; k++) {
        const y = Math.floor((lines * k) / (rows + 1));
        // média de 5 linhas vizinhas: tira o ruído da foto sem esbater as barras (que são verticais)
        for (let x = 0; x < len; x++) {
          let sum = 0, n = 0;
          for (let dy = -2; dy <= 2; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= lines) continue;
            sum += lum(4 * (vertical ? x * width + yy : yy * width + x)); n++;
          }
          row[x] = sum / n;
        }
        const hit = vote(scanLine(row));
        if (hit) return hit;
      }
    }
    // só uma linha leu: aceita (o dígito de controlo já confirmou)
    return votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  }

  /* ---------- fontes de imagem ---------- */
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  function frameData(src, w, h, maxW = 1280) {
    const scale = Math.min(1, maxW / w);
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  const native = typeof window !== 'undefined' && 'BarcodeDetector' in window
    ? (() => { try { return new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); } catch { return null; } })()
    : null;

  async function detect(src, w, h) {
    if (native) {
      try {
        const found = await native.detect(src);
        const code = found.map((b) => b.rawValue).find(validGtin);
        if (code) return code;
      } catch { /* cai para o descodificador próprio */ }
    }
    return decodeImageData(frameData(src, w, h));
  }

  async function decodeFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await detect(img, img.naturalWidth, img.naturalHeight);
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
        if (code) { stopCamera(); onCode(code); }
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

  async function onlinePrices(ean, price, country) {
    const base = workerBase();
    if (!base) throw new Error('Configura "O meu proxy" (o teu Worker) para procurar preços online');
    const res = await fetch(base + '/deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerHeaders() },
      body: JSON.stringify({ ean, price: price || undefined, country, currency: 'EUR' }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    // "Faltam name/price" = o Worker antigo, que ainda não conhece a pesquisa só com o código
    if (/Faltam name\/price/.test(data.error || '') || (res.ok && !Array.isArray(data.prices))) {
      throw new Error('O teu Worker ainda é a versão antiga: cola o worker/cloudflare-worker.js novo na Cloudflare (Edit code → colar → Deploy) e tenta de novo.');
    }
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (!Array.isArray(data.prices)) throw new Error('O Worker é de uma versão antiga: cola o worker/cloudflare-worker.js novo na Cloudflare e faz Deploy');
    return data;
  }

  /* ---------- folha "Ler código" ---------- */
  function initUi() {
    if (!$('scanPanel')) return;
    const SETTINGS = 'crawler-scan';
    try { const s = JSON.parse(localStorage.getItem(SETTINGS)) || {}; if (s.country) $('scanCountry').value = s.country; } catch {}
    const status = (html) => { $('scanStatus').innerHTML = html; };

    async function lookup(code) {
      code = String(code).replace(/\D/g, '');
      if (!validGtin(code)) { status('⚠️ Este número não é um EAN válido (8, 12 ou 13 dígitos, com o último a confirmar).'); return; }
      $('scanEan').value = code;
      navigator.vibrate?.(60);
      const price = numOrNull($('scanPrice').value);
      const country = $('scanCountry').value;
      try { localStorage.setItem(SETTINGS, JSON.stringify({ country })); } catch {}
      const local = localPrices(code);
      const localHtml = local.length
        ? `<h3>No teu histórico</h3>${local.slice(0, 8).map((o) => `<a class="cmp-row" href="${esc(o.url)}" target="_blank" rel="noopener"><span>${esc(o.store)}<small>${esc(o.name || '')} · ${fmtDate(o.date)}${o.av === 'out' ? ' · esgotado' : ''}</small></span><b>${fmtPrice(o.price)}</b></a>`).join('')}`
        : '';
      status(`<div class="scan-code">EAN <b>${code}</b>${price ? ` · na loja: <b>${fmtPrice(price)}</b>` : ''}</div>${localHtml}<div class="deal-box loading">🔎 A procurar este produto e os preços noutras lojas…</div>`);
      $('scanResult').scrollIntoView?.({ block: 'nearest' });
      try {
        const d = await onlinePrices(code, price, country);
        const cheaper = price && d.lowestPrice != null && d.lowestPrice < price ? ` · <b class="scan-save">${fmtPrice(price - d.lowestPrice)} mais barato online</b>` : '';
        status(`<div class="scan-code">${d.productName ? `<b>${esc(d.productName)}</b><br>` : ''}EAN ${code}${price ? ` · na loja: <b>${fmtPrice(price)}</b>` : ''}${cheaper}</div>
          ${localHtml}
          ${d.prices.length ? '' : '<p class="empty">A IA não encontrou preços com link para este código.</p>'}
          ${dealHtml(d)}`);
      } catch (e) {
        status(`<div class="scan-code">EAN <b>${code}</b></div>${localHtml}<div class="deal-box v-caro">⚠️ ${esc(e.message)}</div>`);
      }
    }

    $('scanCam').addEventListener('click', async () => {
      if (!navigator.mediaDevices?.getUserMedia) return $('scanFile').click();
      $('scanVideoWrap').classList.remove('hidden');
      status('Aponta a câmara ao código de barras, na horizontal e bem iluminado.');
      try {
        await startCamera($('scanVideo'), (code) => { $('scanVideoWrap').classList.add('hidden'); lookup(code); });
      } catch (e) {
        $('scanVideoWrap').classList.add('hidden');
        status(`⚠️ Não deu para abrir a câmara (${esc(e.name === 'NotAllowedError' ? 'permissão recusada' : e.message)}). Usa <b>Tirar foto</b> ou escreve o número.`);
      }
    });
    $('scanStop').addEventListener('click', () => { stopCamera(); $('scanVideoWrap').classList.add('hidden'); status(''); });
    $('scanPhoto').addEventListener('click', () => $('scanFile').click());
    $('scanFile').addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      status('🔎 A ler o código na foto…');
      const code = await decodeFile(f).catch(() => null);
      if (code) lookup(code);
      else status('⚠️ Não encontrei um código de barras na foto. Tira outra mais perto, na horizontal e sem reflexos, ou escreve o número.');
    });
    $('scanForm').addEventListener('submit', (e) => { e.preventDefault(); lookup($('scanEan').value); });
    // a câmara desliga-se quando a folha fecha
    document.addEventListener('sheet', (e) => { if (e.detail !== 'scan') { stopCamera(); $('scanVideoWrap').classList.add('hidden'); } });
    new MutationObserver(() => { if ($('scanPanel').classList.contains('hidden')) { stopCamera(); $('scanVideoWrap').classList.add('hidden'); } })
      .observe($('scanPanel'), { attributes: true, attributeFilter: ['class'] });
  }

  return { validGtin, decodeImageData, scanLine, decodeFile, localPrices, initUi, hasNative: !!native };
})();
