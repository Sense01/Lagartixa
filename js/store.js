/* =========================================================
   Dados guardados no aparelho (localStorage)
   - histórico de preços por produto
   - lista de produtos seguidos
   - pesquisas guardadas
   - cache das avaliações de negócio
   ========================================================= */

const Store = (() => {
  // prefixo opcional (a página de testes usa outro, para não mexer nos teus dados)
  const P = (typeof window !== 'undefined' && window.STORE_PREFIX) || '';
  const K = {
    history: P + 'crawler-history',
    watch: P + 'crawler-watch',
    searches: P + 'crawler-searches',
  };
  const MAX_POINTS = 90;       // pontos de histórico por produto
  const MAX_PRODUCTS = 3000;   // produtos no histórico (os mais antigos saem)
  const listeners = {};

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // armazenamento cheio: corta o histórico e tenta outra vez
      if (key !== K.history) { pruneHistory(Math.floor(MAX_PRODUCTS / 2)); try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch {} }
      console.warn('Armazenamento cheio:', e);
      return false;
    }
  }
  function emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
  function on(ev, fn) { (listeners[ev] ||= []).push(fn); }

  /* ---------- identidade do produto ---------- */

  const TRACKING = /^(utm_|srsltid|gclid|fbclid|mc_|_ga|ref$|sc_|cmp)/i;

  /** chave estável de um produto numa loja: host + caminho (+ query relevante) */
  function itemKey(urlOrItem) {
    const raw = typeof urlOrItem === 'string' ? urlOrItem : urlOrItem?.url;
    try {
      const u = new URL(raw);
      [...u.searchParams.keys()].forEach((k) => TRACKING.test(k) && u.searchParams.delete(k));
      u.searchParams.sort();
      const q = u.searchParams.toString();
      return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '')).toLowerCase();
    } catch { return String(raw || '').toLowerCase(); }
  }

  /** identidade do produto independente da loja (para comparar lojas) */
  function productIdentity(it) {
    if (!it) return null;
    const ean = String(it.ean || '').replace(/\D/g, '');
    if ([8, 12, 13, 14].includes(ean.length)) return 'ean:' + ean.replace(/^0+(?=\d{12,})/, '');
    const text = `${it.brand || ''} ${it.name || ''}`;
    if (/\blego\b/i.test(text)) {
      const m = text.match(/\((\d{4,6})\)/) || text.match(/\b(\d{5})\b/) || text.match(/(?:ref\.?|set|n\.?º?)\s*(\d{4,6})\b/i);
      if (m) return 'lego:' + m[1];
    }
    const mpn = String(it.mpn || '').trim();
    if (mpn.length >= 4 && it.brand) return `mpn:${it.brand.toLowerCase()}:${mpn.toLowerCase()}`;
    return null;
  }

  /* ---------- histórico de preços ---------- */

  let historyCache = null;
  const history = () => (historyCache ||= read(K.history, {}));
  const saveHistory = debounce(() => write(K.history, history()), 300);

  function pruneHistory(keep = MAX_PRODUCTS) {
    const h = history();
    const keys = Object.keys(h);
    if (keys.length <= keep) return;
    keys.sort((a, b) => (h[b].seen || 0) - (h[a].seen || 0)).slice(keep).forEach((k) => delete h[k]);
    write(K.history, h);
  }

  /**
   * Regista o preço visto agora. Devolve a análise em relação ao histórico ANTERIOR:
   * { prev, prevDate, change, changePct, min, max, points, isLowest }
   */
  function recordPrice(it) {
    if (!it?.url || it.price == null) return null;
    const key = itemKey(it);
    const h = history();
    const e = h[key] || { pts: [] };
    const day = today();
    const before = e.pts.filter((p) => p[0] !== day);   // pontos de dias anteriores
    const last = e.pts[e.pts.length - 1];
    if (last && last[0] === day) last[1] = it.price; else e.pts.push([day, it.price]);
    if (e.pts.length > MAX_POINTS) e.pts.splice(0, e.pts.length - MAX_POINTS);
    Object.assign(e, {
      n: it.name, u: it.url, i: it.image || e.i || '', s: hostOf(it.url),
      id: productIdentity(it) || e.id || null, av: it.availability || null, seen: Date.now(),
    });
    h[key] = e;
    saveHistory();
    if (Object.keys(h).length > MAX_PRODUCTS * 1.1) pruneHistory();
    return analyse(before, it.price);
  }

  function analyse(before, price) {
    if (!before.length) return { points: 1, isNew: true };
    const prevPt = before[before.length - 1];
    const all = [...before.map((p) => p[1]), price];
    const min = Math.min(...all), max = Math.max(...all);
    const change = Math.round((price - prevPt[1]) * 100) / 100;
    return {
      prev: prevPt[1], prevDate: prevPt[0], change,
      changePct: prevPt[1] ? Math.round((change / prevPt[1]) * 100) : 0,
      min, max, points: before.length + 1,
      isLowest: before.length >= 2 && price <= Math.min(...before.map((p) => p[1])),
    };
  }

  function getHistory(urlOrItem) { return history()[itemKey(urlOrItem)] || null; }

  /** o mesmo produto visto noutras lojas (pela identidade) */
  function otherStores(it) {
    const id = productIdentity(it);
    if (!id) return [];
    const myHost = hostOf(it.url);
    const out = [];
    for (const [key, e] of Object.entries(history())) {
      if (e.id !== id || e.s === myHost || !e.pts.length) continue;
      const lastPt = e.pts[e.pts.length - 1];
      out.push({ key, store: e.s, url: e.u, name: e.n, price: lastPt[1], date: lastPt[0], av: e.av });
    }
    return out.sort((a, b) => a.price - b.price);
  }

  function historyStats(urlOrItem) {
    const e = getHistory(urlOrItem);
    if (!e || !e.pts.length) return null;
    const ps = e.pts.map((p) => p[1]);
    return { min: Math.min(...ps), max: Math.max(...ps), points: ps.length, since: e.pts[0][0] };
  }

  /* ---------- produtos seguidos ---------- */

  const watchList = () => read(K.watch, []);
  const isWatched = (it) => watchList().some((w) => w.key === itemKey(it));

  function toggleWatch(it) {
    const list = watchList();
    const key = itemKey(it);
    const i = list.findIndex((w) => w.key === key);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({
      key, url: it.url, name: it.name, brand: it.brand || '', image: it.image || '', store: hostOf(it.url),
      price: it.price, target: null, id: productIdentity(it), addedAt: Date.now(),
    });
    write(K.watch, list);
    emit('watch');
    return i < 0;
  }

  function updateWatch(key, patch) {
    const list = watchList();
    const w = list.find((x) => x.key === key);
    if (!w) return;
    Object.assign(w, patch);
    write(K.watch, list);
    emit('watch');
  }

  function removeWatch(key) {
    write(K.watch, watchList().filter((w) => w.key !== key));
    emit('watch');
  }

  /* ---------- pesquisas guardadas ---------- */

  const searches = () => read(K.searches, []);

  function saveSearch(name, config) {
    const list = searches();
    const existing = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { config, updatedAt: Date.now() });
    else list.unshift({ id: 's' + Date.now().toString(36), name, config, monitor: false, createdAt: Date.now() });
    write(K.searches, list);
    emit('searches');
  }

  function updateSearch(id, patch) {
    const list = searches();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    write(K.searches, list);
    emit('searches');
  }

  function removeSearch(id) {
    write(K.searches, searches().filter((s) => s.id !== id));
    emit('searches');
  }

  /* ---------- cache de avaliações ---------- */

  const dealKey = (it) => `${P}deal:${itemKey(it)}|${it.price}`;
  function getDeal(it, maxAgeMs = 24 * 3600e3) {
    const d = read(dealKey(it), null);
    return d && Date.now() - Date.parse(d.checkedAt) < maxAgeMs ? d : null;
  }
  const setDeal = (it, d) => { write(dealKey(it), d); emit('deal'); };

  /** só para testes: esquece a cache em memória */
  function _reset() { historyCache = null; }

  return {
    on, itemKey, productIdentity, _reset,
    recordPrice, getHistory, historyStats, otherStores, history,
    watchList, isWatched, toggleWatch, updateWatch, removeWatch,
    searches, saveSearch, updateSearch, removeSearch,
    getDeal, setDeal,
  };
})();
