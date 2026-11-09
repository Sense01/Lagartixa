/* =========================================================
   Simulador de revenda: comprar barato aqui, revender noutro sitio.
   - lucro liquido por produto (comissoes, portes, embalagem, IVA, devolucoes)
   - simulacao de Monte Carlo de varios meses (capital reinvestido)
   Os valores de partida sao suposicoes: cada um ajusta-os a sua plataforma.
   ========================================================= */

const Resale = (() => {
  const K_PARAMS = (window.STORE_PREFIX || '') + 'crawler-resale';
  const K_MANUAL = (window.STORE_PREFIX || '') + 'crawler-resale-prices';

  const DEFAULTS = {
    feePct: 10,        // comissao da plataforma de venda (%)
    feeFixed: 0.5,     // taxa fixa por venda (EUR)
    shipIn: 0,         // portes para receber a compra (EUR)
    shipOut: 5,        // portes de envio ao comprador, se fores tu a pagar (EUR)
    packaging: 1,      // embalagem (EUR)
    vat: 'none',       // 'none' (particular, venda ocasional) | 'normal' (IVA 23%) | 'margin' (regime da margem)
    vatRate: 23,
    returnPct: 5,      // % de vendas devolvidas
    quickSalePct: 10,  // vendes X% abaixo do preco de mercado para vender depressa
    sellProb: 60,      // probabilidade de vender um artigo em cada mes (%)
    priceVol: 12,      // incerteza do preco de venda (desvio, %)
    budget: 500,       // capital inicial (EUR)
    months: 6,
    dealsAgain: 40,    // % das oportunidades que voltam a aparecer em cada mes
    minRoi: 10,        // so compra se o retorno esperado for >= X%
  };

  const num = (v, d = 0) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : d; };
  const round2 = (v) => Math.round(v * 100) / 100;

  function params() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(K_PARAMS) || '{}'); } catch {}
    return { ...DEFAULTS, ...p };
  }
  function saveParams(p) { try { localStorage.setItem(K_PARAMS, JSON.stringify(p)); } catch {} }
  function manual() { try { return JSON.parse(localStorage.getItem(K_MANUAL) || '{}'); } catch { return {}; } }
  function setManual(it, v) {
    const m = manual();
    if (v == null || v === '') delete m[Store.itemKey(it)]; else m[Store.itemKey(it)] = num(v, null);
    try { localStorage.setItem(K_MANUAL, JSON.stringify(m)); } catch {}
  }

  /** preco a que se consegue revender (antes do desconto para venda rapida) e de onde vem */
  function marketPrice(it, extra = {}) {
    const m = (extra.manual || manual())[Store.itemKey(it)];
    if (m != null && m > 0) return { value: m, source: 'manual', label: 'o teu valor' };
    const d = extra.deal !== undefined ? extra.deal : Store.getDeal(it, 7 * 24 * 3600e3);
    if (d && !d.error) {
      // o mais baixo da concorrencia e o preco realista para vender (o "tipico" e otimista)
      const comp = [d.lowestPrice, d.typicalPrice].map((x) => num(x, null)).filter((x) => x > 0);
      if (comp.length) return { value: Math.min(...comp), source: 'ia', label: 'IA: preço noutras lojas' };
    }
    const others = (extra.others || Store.otherStores(it)).map((o) => o.price).filter((x) => x > it.price);
    if (others.length) return { value: Math.min(...others), source: 'lojas', label: 'outra loja (histórico)' };
    if (it.oldPrice > it.price) return { value: it.oldPrice, source: 'antigo', label: 'preço antigo/PVPR (otimista)' };
    const h = extra.history !== undefined ? extra.history : Store.historyStats(it);
    if (h && h.max > it.price) return { value: h.max, source: 'historico', label: 'máximo do histórico' };
    return { value: null, source: null, label: 'sem referência' };
  }

  /** contas de uma venda: devolve as parcelas e o lucro esperado */
  function profit(buy, market, p = DEFAULTS) {
    if (!(buy > 0) || !(market > 0)) return null;
    const sale = market * (1 - p.quickSalePct / 100);
    const fees = sale * p.feePct / 100 + p.feeFixed;
    const r = p.vatRate / 100;
    let vat = 0;
    if (p.vat === 'normal') vat = (sale - sale / (1 + r)) - (buy - buy / (1 + r));   // IVA liquidado - IVA dedutivel
    else if (p.vat === 'margin') vat = Math.max(0, sale - buy) * r / (1 + r);       // so sobre a margem
    const returns = p.returnPct / 100 * (2 * p.shipOut + p.packaging);              // custo esperado das devolucoes
    const costs = buy + p.shipIn + p.shipOut + p.packaging;
    const net = sale - fees - costs - vat - returns;
    const invested = buy + p.shipIn;
    return {
      sale: round2(sale), fees: round2(fees), vat: round2(vat), returns: round2(returns),
      ship: round2(p.shipIn + p.shipOut), packaging: round2(p.packaging),
      net: round2(net), roi: round2(net / invested * 100), invested: round2(invested),
    };
  }

  /* ---------- Monte Carlo ---------- */

  function rng(seed) {   // mulberry32: resultados repetiveis com a mesma semente
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

  /**
   * cands: [{ buy, market }]. Cada mes: algumas oportunidades reaparecem e compra-se 1 unidade das que
   * tem retorno >= minRoi enquanto houver dinheiro; cada artigo em stock vende com probabilidade sellProb.
   * O stock que sobra no fim e avaliado ao preco de custo (conservador).
   */
  function simulate(cands, p = DEFAULTS, { runs = 2000, seed = 42 } = {}) {
    const rand = rng(seed);
    const pool = cands
      .map((c) => ({ ...c, calc: profit(c.buy, c.market, p) }))
      .filter((c) => c.calc && c.calc.roi >= p.minRoi)
      .sort((a, b) => b.calc.roi - a.calc.roi);
    const months = Math.max(1, Math.round(p.months));
    const equity = Array.from({ length: months + 1 }, () => []);
    const finals = [], soldN = [], boughtN = [], returnedN = [];
    const r = p.vatRate / 100;
    for (let run = 0; run < runs; run++) {
      let cash = p.budget, sold = 0, bought = 0, returned = 0;
      let stock = [];
      equity[0].push(p.budget);
      for (let m = 1; m <= months; m++) {
        for (const c of pool) {
          if (m > 1 && rand() * 100 >= p.dealsAgain) continue;      // a promocao pode nao voltar
          const cost = c.buy + p.shipIn;
          if (cash < cost) continue;
          cash -= cost; bought++;
          stock.push(c);
        }
        const left = [];
        for (const c of stock) {
          if (rand() * 100 >= p.sellProb) { left.push(c); continue; }
          const sale = Math.max(0, c.calc.sale * (1 + gauss(rand) * p.priceVol / 100));
          if (rand() * 100 < p.returnPct) {                         // devolvido: perde portes e embalagem, volta ao stock
            cash -= 2 * p.shipOut + p.packaging; returned++; left.push(c); continue;
          }
          let vat = 0;
          if (p.vat === 'normal') vat = (sale - sale / (1 + r)) - (c.buy - c.buy / (1 + r));
          else if (p.vat === 'margin') vat = Math.max(0, sale - c.buy) * r / (1 + r);
          cash += sale - (sale * p.feePct / 100 + p.feeFixed) - p.shipOut - p.packaging - vat;
          sold++;
        }
        stock = left;
        equity[m].push(cash + stock.reduce((s, c) => s + c.buy + p.shipIn, 0));
      }
      finals.push(equity[months][equity[months].length - 1] - p.budget);
      soldN.push(sold); boughtN.push(bought); returnedN.push(returned);
    }
    const sortN = (a) => [...a].sort((x, y) => x - y);
    const fs = sortN(finals);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    return {
      pool: pool.length,
      runs,
      bands: equity.map((col) => { const s = sortN(col); return { p10: pct(s, 0.1), p50: pct(s, 0.5), p90: pct(s, 0.9) }; }),
      profit: { p10: round2(pct(fs, 0.1)), p50: round2(pct(fs, 0.5)), p90: round2(pct(fs, 0.9)), mean: round2(avg(fs)) },
      probLoss: round2(fs.filter((x) => x < 0).length / fs.length * 100),
      roi: round2(pct(fs, 0.5) / p.budget * 100),
      sold: round2(avg(soldN)), bought: round2(avg(boughtN)), returned: round2(avg(returnedN)),
    };
  }

  /* ---------- interface ---------- */

  const FIELDS = [
    ['budget', 'Capital inicial', '€'], ['months', 'Meses', ''], ['minRoi', 'Comprar só com retorno ≥', '%'],
    ['feePct', 'Comissão da plataforma', '%'], ['feeFixed', 'Taxa fixa por venda', '€'], ['quickSalePct', 'Vender abaixo do mercado', '%'],
    ['shipIn', 'Portes da compra', '€'], ['shipOut', 'Portes de envio (pagos por ti)', '€'], ['packaging', 'Embalagem', '€'],
    ['returnPct', 'Devoluções', '%'], ['sellProb', 'Probabilidade de vender por mês', '%'], ['priceVol', 'Incerteza do preço de venda', '%'],
    ['dealsAgain', 'Promoções que voltam cada mês', '%'],
  ];

  function rows() {
    const p = params();
    const man = manual();
    return items
      .filter((it) => it.price > 0 && it.availability !== 'out')
      .map((it) => { const mk = marketPrice(it, { manual: man }); return { it, mk, calc: profit(it.price, mk.value, p) }; })
      .sort((a, b) => (b.calc?.roi ?? -1e9) - (a.calc?.roi ?? -1e9));
  }

  function paramsHtml(p) {
    return FIELDS.map(([k, label, unit]) => `<label class="rs-f"><span>${label}</span>
      <span class="rs-in"><input type="number" step="any" min="0" data-k="${k}" value="${esc(String(p[k]))}">${unit ? `<i>${unit}</i>` : ''}</span></label>`).join('') +
      `<label class="rs-f"><span>IVA</span><select data-k="vat">
        <option value="none"${p.vat === 'none' ? ' selected' : ''}>Particular, venda ocasional (sem IVA)</option>
        <option value="margin"${p.vat === 'margin' ? ' selected' : ''}>Regime da margem (usados)</option>
        <option value="normal"${p.vat === 'normal' ? ' selected' : ''}>IVA normal (${p.vatRate}%)</option></select></label>`;
  }

  function tableHtml(list) {
    if (!list.length) return '<p class="empty">Faz uma pesquisa primeiro: os produtos encontrados aparecem aqui.</p>';
    const show = list.slice(0, 40);
    return `<div class="rs-table"><div class="rs-tr rs-th"><span>Produto</span><span>Compra</span><span>Revenda</span><span>Lucro</span><span>Retorno</span></div>` +
      show.map(({ it, mk, calc }, i) => {
        const cls = !calc ? 'rs-na' : calc.net <= 0 ? 'rs-bad' : calc.roi >= params().minRoi ? 'rs-good' : 'rs-meh';
        const tip = calc ? `Venda ${fmtPrice(calc.sale)} − comissões ${fmtPrice(calc.fees)} − portes ${fmtPrice(calc.ship)} − embalagem ${fmtPrice(calc.packaging)}${calc.vat ? ` − IVA ${fmtPrice(calc.vat)}` : ''} − devoluções ${fmtPrice(calc.returns)} − compra ${fmtPrice(it.price)}` : 'Escreve o preço a que achas que vendes';
        return `<div class="rs-tr ${cls}" title="${esc(tip)}">
          <a class="rs-name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name || it.url)}<small>${esc(hostOf(it.url))}</small></a>
          <span>${fmtPrice(it.price)}</span>
          <span class="rs-mk"><input type="number" step="any" min="0" data-i="${i}" placeholder="?" value="${mk.value != null ? round2(mk.value) : ''}"><small>${esc(mk.label)}</small></span>
          <span class="rs-net">${calc ? fmtPrice(calc.net) : '—'}</span>
          <span>${calc ? `${calc.roi > 0 ? '+' : ''}${Math.round(calc.roi)}%` : '—'}</span>
        </div>`;
      }).join('') + `</div>${list.length > show.length ? `<p class="rs-more">+${list.length - show.length} produtos com menor retorno</p>` : ''}`;
  }

  function chartSvg(bands, budget, width = 640) {
    const W = Math.max(280, Math.round(width)), H = W < 500 ? 180 : 230, L = 52, R = 30, T = 12, B = 26;
    const all = bands.flatMap((b) => [b.p10, b.p90]).concat(budget);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (i) => L + (W - L - R) * (bands.length > 1 ? i / (bands.length - 1) : 0);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const line = (k) => bands.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b[k]).toFixed(1)}`).join('');
    const area = bands.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.p90).toFixed(1)}`).join('') +
      bands.slice().reverse().map((b, j) => `L${x(bands.length - 1 - j).toFixed(1)},${y(b.p10).toFixed(1)}`).join('') + 'Z';
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    return `<svg class="rs-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Capital ao longo dos meses">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="rs-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="rs-ax">${Math.round(v)} €</text>`).join('')}
      <line x1="${L}" x2="${W - R}" y1="${y(budget)}" y2="${y(budget)}" class="rs-base"/>
      <path d="${area}" class="rs-band"/><path d="${line('p50')}" class="rs-line"/>
      ${bands.map((b, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="rs-ax">${i ? (W < 500 ? i : `mês ${i}`) : (W < 500 ? '0' : 'início')}</text>`).join('')}
    </svg>`;
  }

  function resultHtml(res, p) {
    if (!res.pool) return `<div class="rs-res rs-warn">Nenhum produto tem retorno ≥ ${p.minRoi}% com estas contas — com estes custos, comprar para revender não compensa. Experimenta mudar os custos, o preço de revenda ou o retorno mínimo.</div>`;
    const tone = res.profit.p50 <= 0 ? 'rs-warn' : res.probLoss > 20 ? 'rs-mid' : 'rs-ok';
    const verdict = res.profit.p50 <= 0 ? 'Com estas suposições, a ideia <b>não é rentável</b>.'
      : res.probLoss > 20 ? 'Pode dar lucro, mas com <b>risco alto</b> de perder dinheiro.'
      : 'Com estas suposições, a ideia <b>parece rentável</b>.';
    return `<div class="rs-res ${tone}">
      <p class="rs-verdict">${verdict}</p>
      <div class="rs-tiles">
        <div><b>${fmtPrice(res.profit.p50)}</b><span>lucro provável em ${p.months} meses</span></div>
        <div><b>${res.roi > 0 ? '+' : ''}${Math.round(res.roi)}%</b><span>retorno sobre ${fmtPrice(p.budget)}</span></div>
        <div><b>${Math.round(res.probLoss)}%</b><span>dos cenários perdem dinheiro</span></div>
        <div><b>${fmtPrice(res.profit.p10)} a ${fmtPrice(res.profit.p90)}</b><span>intervalo de 80% dos cenários</span></div>
      </div>
      ${chartSvg(res.bands, p.budget, ($('rsResult')?.clientWidth || 672) - 34)}
      <p class="rs-foot">${res.runs.toLocaleString('pt-PT')} cenários · ${res.pool} ${res.pool === 1 ? 'oportunidade usada' : 'oportunidades usadas'} · em média ${Math.round(res.bought)} compras, ${Math.round(res.sold)} vendas e ${Math.round(res.returned)} devoluções.
      Linha = cenário mediano; faixa = 80% dos cenários; tracejado = capital inicial. O stock por vender no fim conta ao preço de custo.
      Estimativa simplificada, não é aconselhamento fiscal ou financeiro.</p>
    </div>`;
  }

  let lastRows = [];
  function render() {
    const panel = $('resalePanel');
    if (!panel) return;
    panel.classList.toggle('hidden', !items.length);
    if (!items.length) return;
    const p = params();
    if (!$('rsParams').dataset.ready) { $('rsParams').innerHTML = paramsHtml(p); $('rsParams').dataset.ready = '1'; }
    lastRows = rows();
    $('rsTable').innerHTML = tableHtml(lastRows);
    const good = lastRows.filter((r) => r.calc && r.calc.roi >= p.minRoi);
    const noRef = lastRows.filter((r) => !r.calc).length;
    $('rsSummary').textContent = `${good.length} de ${lastRows.length} produtos com retorno ≥ ${p.minRoi}%` +
      (noRef ? ` · ${noRef} sem preço de revenda (escreve-o ou usa 💡 Negócio?)` : '');
  }
  const renderSoon = debounce(render, 300);

  function run() {
    const p = params();
    const cands = lastRows.filter((r) => r.calc).map((r) => ({ buy: r.it.price, market: r.mk.value }));
    $('rsResult').innerHTML = '<div class="rs-res">⏳ A simular…</div>';
    setTimeout(() => { $('rsResult').innerHTML = resultHtml(simulate(cands, p, { runs: 2000, seed: Date.now() % 1e9 }), p); }, 30);
  }

  function init() {
    if (!$('resalePanel')) return;
    $('rsParams').addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const p = params();
      p[k] = k === 'vat' ? e.target.value : num(e.target.value, DEFAULTS[k]);
      saveParams(p);
      renderSoon();
    });
    $('rsTable').addEventListener('change', (e) => {
      const i = e.target.dataset.i;
      if (i == null) return;
      setManual(lastRows[+i].it, e.target.value);
      render();
    });
    $('rsRun').addEventListener('click', run);
    $('rsReset').addEventListener('click', () => {
      saveParams({ ...DEFAULTS });
      $('rsParams').dataset.ready = '';
      render();
      toast('Valores de partida repostos', 2500);
    });
    Store.on('deal', renderSoon);
  }

  return { DEFAULTS, marketPrice, profit, simulate, render, renderSoon, init, params };
})();
