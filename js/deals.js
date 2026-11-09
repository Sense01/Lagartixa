/* =========================================================
   "É bom negócio?" — IA com pesquisa web, através do teu Worker
   ========================================================= */

function workerBase() {
  const tpl = $('customProxy').value.trim();
  if (!tpl) return null;
  try { return new URL(tpl.replace('{url}', 'x').replace('{rawurl}', 'x')).origin; } catch { return null; }
}

const VERDICTS = {
  bom: ['Bom negócio', 'v-bom'],
  razoavel: ['Preço normal', 'v-razoavel'],
  caro: ['Caro', 'v-caro'],
  incerto: ['Sem certeza', 'v-incerto'],
};
const verdictKey = (v) => String(v || 'incerto').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function dealHtml(d) {
  if (d.loading) return `<div class="deal-box loading">🔎 A pesquisar preços na web…</div>`;
  if (d.error) return `<div class="deal-box v-caro">⚠️ ${esc(d.error)}</div>`;
  const [label, cls] = VERDICTS[verdictKey(d.verdict)] || VERDICTS.incerto;
  const nums = [
    d.typicalPrice != null && `típico <b>${fmtPrice(+d.typicalPrice)}</b>`,
    d.lowestPrice != null && `mais baixo <b>${fmtPrice(+d.lowestPrice)}</b>`,
    d.rrp != null && `PVP <b>${fmtPrice(+d.rrp)}</b>`,
  ].filter(Boolean).join(' · ');
  const src = (d.sources || []).slice(0, 3).map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(hostOf(s.url) || s.url)}</a>`).join(' ');
  return `<div class="deal-box ${cls}">
      <div class="deal-head"><span class="verdict">${label}</span>${d.score != null ? `<span class="score">${Math.round(d.score)}/100</span>` : ''}</div>
      ${nums ? `<div class="deal-nums">${nums}</div>` : ''}
      ${d.summary ? `<div class="deal-sum">${esc(d.summary)}</div>` : ''}
      ${src ? `<div class="deal-src">${src}</div>` : ''}
    </div>`;
}

async function evaluateDeal(it, { force = false } = {}) {
  const base = workerBase();
  if (!base) {
    it.deal = { error: 'Configura "O meu proxy" (o teu Worker) para usar esta função' };
    refreshCard(it);
    return it.deal;
  }
  if (!force) {
    const saved = Store.getDeal(it);
    if (saved) { it.deal = saved; refreshCard(it); return saved; }
  }
  it.deal = { loading: true };
  refreshCard(it);
  try {
    const name = it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? `${it.brand} ${it.name}` : it.name;
    const res = await fetch(base + '/deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, price: it.price, oldPrice: it.oldPrice, currency: 'EUR',
        store: hostOf(it.url), country: countryOf(it.url),
        ean: it.ean || undefined,
        history: Store.historyStats(it) || undefined,   // o teu próprio histórico de preços
        otherStores: Store.otherStores(it).slice(0, 3).map((o) => ({ store: o.store, price: o.price, date: o.date })),
      }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    it.deal = data;
    Store.setDeal(it, data);
  } catch (e) {
    it.deal = { error: /Failed to fetch|Load failed|NetworkError/.test(e.message)
      ? 'O Worker não respondeu — confirma que tem a versão nova (com /deal)' : e.message };
  }
  refreshCard(it);
  return it.deal;
}

async function autoEvaluateDeals() {
  const top = items.filter((it) => it.price != null && !it.deal && it.availability !== 'out')
    .sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1)).slice(0, 10);
  if (!top.length) return;
  toast(`💡 A avaliar ${top.length} produto(s)…`);
  let good = 0, done = 0;
  for (const it of top) {
    const d = await evaluateDeal(it);
    if (d?.error) { if (/proxy|Worker|API_KEY|chave|autorizada|limite/i.test(d.error)) break; continue; }
    done++;
    if (verdictKey(d?.verdict) === 'bom') good++;
  }
  if ($('itemSort').value === 'deal') renderItems();
  if (done) notifyLocal('Avaliação concluída', good ? `${good} bom(ns) negócio(s) entre ${done} produto(s)` : `Nenhum bom negócio claro entre ${done} produto(s)`);
}
