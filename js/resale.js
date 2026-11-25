/* =========================================================
   Revenda (simples): se comprares aqui e revenderes, quanto sobra?
   lucro = preço de revenda − comissão da plataforma − portes e embalagem − preço de compra
   Duas suposições apenas (comissão e custos por venda); o preço de revenda de cada produto
   vem do teu valor, da IA, de outra loja ou do preço antigo — e podes corrigi-lo.
   ========================================================= */

const Resale = (() => {
  const P = (typeof window !== 'undefined' && window.STORE_PREFIX) || '';
  const K_PARAMS = P + 'crawler-resale';
  const K_MANUAL = P + 'crawler-resale-prices';
  const K_EXTRA = P + 'crawler-resale-extra';             // contas feitas à mão
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const DEFAULTS = {
    feePct: 12,     // comissão da plataforma onde vendes (%)
    costs: 6,       // portes de envio + embalagem, por venda (€)
  };
  const num = (v, d = 0) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : d; };
  const round2 = (v) => Math.round(v * 100) / 100;
  const params = () => ({ ...DEFAULTS, ...load(K_PARAMS, {}) });

  const manual = () => load(K_MANUAL, {});
  function setManual(it, v) {
    const m = manual();
    if (v == null || v === '') delete m[Store.itemKey(it)]; else m[Store.itemKey(it)] = num(v, null);
    save(K_MANUAL, m);
  }

  /** a que preço se revende, e de onde vem esse valor */
  function marketPrice(it, extra = {}) {
    const m = (extra.manual || manual())[Store.itemKey(it)];
    if (m != null && m > 0) return { value: m, label: 'o teu valor' };
    const d = extra.deal !== undefined ? extra.deal : Store.getDeal(it, 7 * 24 * 3600e3);
    if (d && !d.error) {
      // o mais baixo da concorrência é o preço realista para vender (o "típico" é otimista)
      const comp = [d.lowestPrice, d.typicalPrice].map((x) => num(x, null)).filter((x) => x > 0);
      if (comp.length) return { value: Math.min(...comp), label: 'noutras lojas (IA)' };
    }
    const others = (extra.others || Store.otherStores(it)).map((o) => o.price).filter((x) => x > it.price);
    if (others.length) return { value: Math.min(...others), label: 'noutra loja' };
    if (it.oldPrice > it.price) return { value: it.oldPrice, label: 'preço antigo (otimista)' };
    return { value: null, label: '' };
  }

  /** contas de uma venda */
  function profit(buy, sell, p = DEFAULTS) {
    if (!(buy > 0) || !(sell > 0)) return null;
    const fee = sell * p.feePct / 100;
    const net = sell - fee - p.costs - buy;
    return { fee: round2(fee), net: round2(net), roi: Math.round(net / buy * 100) };
  }

  function rows() {
    const p = params(), man = manual();
    const own = load(K_EXTRA, []).map((e) => ({ it: { name: e.name, url: e.url, price: e.buy, own: true }, mk: { value: e.sell, label: 'conta tua' } }));
    const found = items.filter((it) => it.price > 0 && it.availability !== 'out').map((it) => ({ it, mk: marketPrice(it, { manual: man }) }));
    return [...own, ...found].map((r) => ({ ...r, calc: profit(r.it.price, r.mk.value, p) }))
      .sort((a, b) => (b.calc?.net ?? -1e9) - (a.calc?.net ?? -1e9));
  }

  /* ---------- interface ---------- */

  const rowHtml = ({ it, mk, calc }, i) => `
    <div class="rs-tr ${!calc ? 'rs-na' : calc.net > 0 ? 'rs-good' : 'rs-bad'}">
      ${it.own
        ? `<span class="rs-name">${esc(it.name)}<small><button type="button" class="rs-del" data-del="${esc(it.url)}">remover</button></small></span>`
        : `<a class="rs-name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name || it.url)}<small>${esc(hostOf(it.url))}</small></a>`}
      <span class="rs-buy">${fmtPrice(it.price)}</span>
      <span class="rs-mk"><input type="number" step="any" min="0" data-i="${i}" placeholder="vendo a…" aria-label="Preço de revenda" value="${mk.value != null ? round2(mk.value) : ''}"><small>${esc(mk.label)}</small></span>
      <span class="rs-net">${calc ? `${calc.net > 0 ? '+' : ''}${fmtPrice(calc.net)}` : '—'}</span>
    </div>`;

  let lastRows = [];
  function render() {
    if (!$('resalePanel')) return;
    const p = params();
    $('rsFee').value = p.feePct;
    $('rsCosts').value = p.costs;
    lastRows = rows();
    const withRef = lastRows.filter((r) => r.calc), noRef = lastRows.filter((r) => !r.calc);
    const good = withRef.filter((r) => r.calc.net > 0);
    const best = good[0];
    $('rsSummary').innerHTML = !lastRows.length
      ? 'Faz uma pesquisa e os produtos aparecem aqui. Também podes fazer uma conta à mão em baixo.'
      : good.length
        ? `<b>${good.length} de ${withRef.length}</b> produto${withRef.length > 1 ? 's' : ''} ${good.length > 1 ? 'dão' : 'dá'} lucro. ` +
          `O melhor: comprar a ${fmtPrice(best.it.price)} e revender a ${fmtPrice(best.mk.value)} deixa <b class="rs-plus">${fmtPrice(best.calc.net)}</b>.`
        : withRef.length ? 'Com estes custos, <b>nenhum produto dá lucro</b> a revender.' : 'Ainda não há preços de revenda para comparar.';
    $('rsTable').innerHTML = withRef.length
      ? `<div class="rs-table"><div class="rs-tr rs-th"><span>Produto</span><span>Compro</span><span>Revendo</span><span>Sobra</span></div>${withRef.slice(0, 40).map((r) => rowHtml(r, lastRows.indexOf(r))).join('')}</div>`
      : '';
    $('rsNoRef').classList.toggle('hidden', !noRef.length);
    $('rsNoRefText').textContent = `${noRef.length} produto${noRef.length > 1 ? 's' : ''} sem preço de revenda.`;
  }
  const renderSoon = debounce(render, 300);

  /** pede à IA o preço noutras lojas para os produtos sem referência (ou só com o preço antigo) */
  let fetching = false;
  async function fetchPrices() {
    if (fetching) return;
    const todo = lastRows.filter((r) => !r.it.own && (!r.calc || r.mk.label.startsWith('preço antigo')))
      .sort((a, b) => (b.it.discount ?? -1) - (a.it.discount ?? -1)).slice(0, 10).map((r) => r.it);
    if (!todo.length) return toast('Todos os produtos já têm um preço de revenda', 3000);
    if (typeof evaluateDeal !== 'function' || !workerBase()) return toast('Configura o teu Worker (Opções avançadas) para usar a IA', 4000);
    fetching = true;
    const btn = $('rsFetch'); btn.disabled = true;
    let done = 0, failed = '';
    for (const it of todo) {
      btn.textContent = `💡 ${done + 1} de ${todo.length}…`;
      const d = await evaluateDeal(it, { retry: false });
      if (d?.error) { failed = d.error; break; }
      done++;
      render();
    }
    btn.disabled = false; btn.textContent = '💡 Pedir preços à IA'; fetching = false;
    render();
    toast(done ? `💡 ${done} preço(s) de revenda obtidos` : `Não foi possível: ${failed}`, 4000);
  }

  function init() {
    if (!$('resalePanel')) return;
    const setParam = (k, v) => { save(K_PARAMS, { ...params(), [k]: num(v, DEFAULTS[k]) }); renderSoon(); };
    $('rsFee').addEventListener('input', (e) => setParam('feePct', e.target.value));
    $('rsCosts').addEventListener('input', (e) => setParam('costs', e.target.value));
    $('rsTable').addEventListener('change', (e) => {
      const i = e.target.dataset.i;
      if (i == null) return;
      const row = lastRows[+i];
      if (row.it.own) save(K_EXTRA, load(K_EXTRA, []).map((x) => (x.url === row.it.url ? { ...x, sell: num(e.target.value, x.sell) } : x)));
      else setManual(row.it, e.target.value);
      render();
    });
    $('rsTable').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      save(K_EXTRA, load(K_EXTRA, []).filter((x) => x.url !== del.dataset.del));
      render();
    });
    $('rsAdd').addEventListener('submit', (e) => {
      e.preventDefault();
      const buy = num($('rsAddBuy').value, 0), sell = num($('rsAddSell').value, 0);
      if (!(buy > 0) || !(sell > 0)) return;
      save(K_EXTRA, [...load(K_EXTRA, []), { name: $('rsAddName').value.trim() || 'Conta à mão', buy, sell, url: 'manual:' + Date.now() }]);
      // a resposta aparece logo ao lado do formulário (e a conta fica na lista)
      const c = profit(buy, sell, params());
      $('rsCalc').innerHTML = `${c.net > 0 ? 'Sobram' : 'Perdes'} <b class="${c.net > 0 ? 'rs-plus' : 'rs-minus'}">${fmtPrice(Math.abs(c.net))}</b> (comissão ${fmtPrice(c.fee)}, portes e embalagem ${fmtPrice(params().costs)}).`;
      $('rsAdd').reset();
      render();
    });
    $('goResale')?.addEventListener('click', () => Sheets.open('resale'));
    $('rsFetch').addEventListener('click', fetchPrices);
    Store.on('deal', renderSoon);
    render();
  }

  return { DEFAULTS, marketPrice, profit, render, renderSoon, init, params };
})();
