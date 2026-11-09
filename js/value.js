/* =========================================================
   "Melhores negócios": quanto abaixo da média está cada produto.
   Compara o preço com a melhor referência disponível, por esta ordem de confiança:
     1. o mesmo produto noutras lojas (encontrado agora ou no histórico)  -> média dessas lojas
     2. o preço típico encontrado pela IA (💡)
     3. o histórico de preços deste produto nesta loja                     -> média
     4. o preço antigo/PVPR anunciado pela própria loja
     5. produtos semelhantes desta pesquisa (mesmo tipo, ex. "monitor led") -> mediana (o menos fiável)
   ========================================================= */

const Value = (() => {
  const BASIS = {
    lojas: { w: 1, min: 8, label: (n) => `média de ${n} loja${n > 1 ? 's' : ''}` },
    ia: { w: 1, min: 8, label: () => 'preço típico (IA)' },
    historico: { w: 0.9, min: 8, label: (n) => `média do teu histórico (${n} registos)` },
    pvpr: { w: 0.6, min: 15, label: () => 'preço antigo anunciado pela loja' },
    semelhantes: { w: 0.15, min: Infinity, weak: true, label: (n) => `estimativa: mediana de ${n} produtos parecidos` },
  };
  const STOP = new Set(['de', 'da', 'do', 'para', 'com', 'e', 'the', 'pour', 'avec', 'et', 'en', 'a', 'o', 'le', 'la']);

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /** tamanho/capacidade no nome (27", 27 polegadas, 1TB, 500GB, 65W…): produtos so sao parecidos se coincidir */
  function sizeKey(name) {
    const n = String(name || '').toLowerCase();
    const m = n.match(/(\d{2}(?:[.,]\d)?)\s*(?:"|''|\u201d|pol|polegadas|inch)/) || n.match(/\b(\d+(?:[.,]\d+)?)\s*(tb|gb|mah|w|l|kg|cm|mm|hz)\b/);
    return m ? (m[1] + (m[2] || 'in')).replace(',', '.') : '';
  }

  /** tipo do produto: as duas primeiras palavras do nome ("MONITOR LED GAMING AOC…" -> "monitor led") */
  function typeKey(name) {
    const words = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
    return words.length >= 2 ? words.slice(0, 2).join(' ') : '';
  }

  /**
   * deps (para testes): { identity(it), otherStores(it), history(it) -> [precos], deal(it) }
   * devolve Map(item -> { ref, pct, basis, n, label, score, good })
   */
  function analyze(list, deps = {}) {
    const identity = deps.identity || ((it) => Store.productIdentity(it));
    const others = deps.otherStores || ((it) => Store.otherStores(it));
    const hist = deps.history || ((it) => (Store.getHistory(it)?.pts || []).map((p) => p[1]));
    const dealOf = deps.deal || ((it) => (it.deal && !it.deal.error && !it.deal.loading ? it.deal : null));
    const priced = list.filter((it) => it.price > 0);

    // mesmo produto encontrado agora noutras lojas
    const byId = new Map();
    for (const it of priced) {
      const id = identity(it);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(it);
    }
    // produtos semelhantes (mesmo tipo) desta pesquisa
    const byType = new Map();
    for (const it of priced) {
      const k = typeKey(it.name);
      const sz = sizeKey(it.name);
      if (!k || !sz) continue;          // sem tamanho no nome nao da para comparar com seguranca
      const key = k + '|' + sz;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(it.price);
    }

    const out = new Map();
    for (const it of priced) {
      const cands = [];
      const host = hostOf(it.url);
      // 1. outras lojas: agora + historico (o preco mais recente de cada loja)
      const stores = new Map();
      const id = identity(it);
      if (id) {
        for (const o of byId.get(id) || []) if (hostOf(o.url) !== host) stores.set(hostOf(o.url), o.price);
        for (const o of others(it) || []) if (o.store !== host && !stores.has(o.store)) stores.set(o.store, o.price);
      }
      if (stores.size) cands.push({ basis: 'lojas', ref: mean([...stores.values()]), n: stores.size });
      // 2. IA
      const d = dealOf(it);
      const typical = d && +d.typicalPrice > 0 ? +d.typicalPrice : null;
      if (typical) cands.push({ basis: 'ia', ref: typical, n: 1 });
      // 3. historico deste produto (sem contar o preco de hoje)
      const h = (hist(it) || []).filter((x) => x > 0);
      const past = h.length > 1 ? h.slice(0, -1) : [];
      if (past.length >= 2) cands.push({ basis: 'historico', ref: mean(past), n: past.length });
      // 4. PVPR / preco antigo da propria loja
      if (it.oldPrice > it.price) cands.push({ basis: 'pvpr', ref: it.oldPrice, n: 1 });

      // 5. semelhantes (o mesmo tipo nao e o mesmo produto: referencia mais fraca) (pelo menos 4 do mesmo tipo, sem contar este)
      const k = typeKey(it.name), sz = sizeKey(it.name);
      const peers = k && sz ? (byType.get(k + '|' + sz) || []) : [];
      if (peers.length >= 5) {
        const rest = [...peers]; rest.splice(rest.indexOf(it.price), 1);
        cands.push({ basis: 'semelhantes', ref: median(rest), n: rest.length });
      }
      const best = cands[0];   // ja estao por ordem de confianca
      if (!best || !(best.ref > 0)) { out.set(it, null); continue; }
      const pct = Math.round((best.ref - it.price) / best.ref * 100);
      const B = BASIS[best.basis];
      const aiGood = d && /^bom/i.test(String(d.verdict || ''));
      out.set(it, {
        ref: Math.round(best.ref * 100) / 100, pct, basis: best.basis, n: best.n,
        label: B.label(best.n),
        score: pct * B.w,
        good: aiGood || (!B.weak && pct >= B.min),
        weak: !!B.weak,
      });
    }
    return out;
  }

  // cache: recalculada quando muda a lista de produtos ou chega uma avaliacao da IA
  let cache = null, cacheKey = '';
  function info(it) {
    const key = `${items.length}|${items.reduce((s, x) => s + (x.deal && !x.deal.loading ? 1 : 0), 0)}|${Value._v}`;
    if (!cache || key !== cacheKey) { cache = analyze(items); cacheKey = key; }
    return cache.get(it) || null;
  }

  function html(it) {
    if (it.deal?.loading) return `<div class="value v-flat">📊 <b>a comparar preços na web…</b></div>`;
    const v = info(it);
    if (!v) return '';
    const cls = v.weak ? 'v-flat v-weak' : v.pct >= BASIS[v.basis].min ? 'v-up' : v.pct <= -5 ? 'v-down' : 'v-flat';
    const txt = v.pct > 0 ? `${v.pct}% abaixo` : v.pct < 0 ? `${-v.pct}% acima` : 'igual';
    return `<div class="value ${cls}" title="Comparado com ${esc(v.label)}">📊 <b>${txt}</b> <small>${esc(v.label)}: ${fmtPrice(v.ref)}</small></div>`;
  }

  /** candidatos para a IA avaliar sozinha: sem referencia boa (so PVPR, estimativa ou nada), os mais promissores primeiro */
  function needsAi(list, max = 12) {
    const V = analyze(list);
    return list
      .filter((it) => it.price > 0 && it.availability !== 'out' && !it.deal)
      .filter((it) => { const v = V.get(it); return !v || ['pvpr', 'semelhantes'].includes(v.basis); })
      .sort((a, b) => ((V.get(b)?.pct ?? 0) + (b.discount ?? 0)) - ((V.get(a)?.pct ?? 0) + (a.discount ?? 0)))
      .slice(0, max);
  }

  return { analyze, info, html, typeKey, sizeKey, needsAi, BASIS, _v: 0 };
})();
