/* =========================================================
   Alertas automáticos (o Worker verifica de hora a hora e envia push)
   ========================================================= */

const Monitor = (() => {
  let lastState = null;

  async function call(path, opts = {}) {
    const base = workerBase();
    if (!base) throw new Error('Configura "O meu proxy" (o teu Worker) primeiro');
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || data.error) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.setup = data.setup;
      throw err;
    }
    return data;
  }

  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

  function payload() {
    return {
      watch: Store.watchList().map((w) => ({ key: w.key, url: w.url, name: w.name, image: w.image, store: w.store, target: w.target, price: w.price })),
      searches: Store.searches().filter((s) => s.monitor).map((s) => ({ id: s.id, name: s.name, config: s.config })),
      alertMinBelow: Math.max(0, Math.min(90, +($('monBelow')?.value || 0))),
    };
  }

  async function sync() {
    if (!workerBase()) return;
    try {
      const st = await call('/sync', { method: 'POST', body: payload() });
      render(st);
    } catch (e) {
      render(null, e);
    }
  }
  const scheduleSync = debounce(sync, 1500);

  async function refresh() {
    if (!workerBase()) return render(null, new Error('Configura "O meu proxy" (o teu Worker) para usar alertas automáticos'));
    try {
      const st = await call('/state');
      if (st.alertMinBelow != null && $('monBelow') && document.activeElement !== $('monBelow')) $('monBelow').value = st.alertMinBelow;
      render(st);
    } catch (e) { render(null, e); }
    pullHistory();
  }

  /** junta ao historico local os precos que o Worker guardou de hora a hora (pesquisas com 🔔 e produtos seguidos) */
  const K_PULL = (window.STORE_PREFIX || '') + 'crawler-histpull';
  async function pullHistory() {
    if (!workerBase()) return 0;
    let since = '';
    try { since = localStorage.getItem(K_PULL) || ''; } catch {}
    try {
      const data = await call('/history' + (since ? `?since=${since}` : ''));
      const n = Store.importHistory(data.items || {});
      try { localStorage.setItem(K_PULL, today()); } catch {}
      if (n) { Value._v++; if (typeof renderItems === 'function' && items.length) renderItems(); }
      return n;
    } catch { return 0; }   // Worker antigo (sem /history): ignora
  }

  function urlB64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    if (isIOS() && !isStandalone()) {
      return toast('No iPhone, primeiro adiciona a app ao ecrã principal (Partilhar → Adicionar ao ecrã principal) e abre-a pelo ícone.', 8000);
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Este browser não suporta notificações push.', 6000);
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Sem autorização para notificações — ativa-as nas definições do aparelho.', 6000);
    try {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await call('/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options?.applicationServerKey) {
        const cur = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (cur !== publicKey) { await sub.unsubscribe(); sub = null; }
      }
      sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
      const st = await call('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: navigator.userAgent.slice(0, 120) } });
      render(st);
      toast('🔔 Notificações ativadas neste aparelho');
    } catch (e) {
      toast('Não foi possível ativar: ' + e.message, 7000);
      render(lastState, e);
    }
  }

  async function test() {
    try {
      const r = await call('/push/test', { method: 'POST', body: {} });
      toast(r.sent ? `Enviada para ${r.sent} aparelho(s)` : 'Nenhum aparelho com notificações ativas', 5000);
    } catch (e) { toast(e.message, 6000); }
  }

  async function runNow() {
    const btn = $('monRun');
    btn.disabled = true;
    btn.textContent = '⏳ A verificar…';
    try {
      const r = await call('/run', { method: 'POST', body: payload() });
      render(r.state);
      toast(r.summary || 'Verificação concluída', 6000);
    } catch (e) { toast(e.message, 7000); render(lastState, e); }
    btn.disabled = false;
    btn.textContent = '▶ Verificar agora';
  }

  function render(st, err) {
    if (st) lastState = st;
    const s = st || lastState;
    const box = $('monStatus');
    if (err && !s) {
      box.innerHTML = `<div class="mon-warn">⚠️ ${esc(err.message)}${err.setup ? `<br><small>${esc(err.setup)}</small>` : ''}</div>`;
      $('monAlerts').innerHTML = '';
      return;
    }
    if (!s) return;
    const monitored = (s.searches || []).length;
    box.innerHTML = `
      <div class="mon-grid">
        <div><b>${s.subscriptions ?? 0}</b><small>aparelho(s) com push</small></div>
        <div><b>${(s.watch || []).length}</b><small>produto(s) seguidos</small></div>
        <div><b>${monitored}</b><small>pesquisa(s) monitorizadas</small></div>
        <div><b>${s.lastRun ? fmtDateTime(s.lastRun) : '—'}</b><small>última verificação${s.cron ? '' : ' (sem cron)'}</small></div>
      </div>
      ${err ? `<div class="mon-warn">⚠️ ${esc(err.message)}</div>` : ''}
      ${!s.cron && s.lastRun == null ? '<div class="mon-hint">Para verificar sozinho de hora a hora, ativa o Cron Trigger no Worker (ver worker/README.md).</div>' : ''}
      ${isIOS() && !isStandalone() ? '<div class="mon-hint">No iPhone, as notificações só funcionam com a app adicionada ao ecrã principal.</div>' : ''}`;
    const alerts = s.alerts || [];
    $('monAlerts').innerHTML = alerts.length
      ? alerts.slice(0, 20).map((a) => `<a class="alert-row" href="${esc(a.url || '#')}" target="_blank" rel="noopener">
          <span class="a-ic">${a.kind === 'drop' ? '↓' : a.kind === 'target' ? '🎯' : a.kind === 'stock' ? '📦' : '🆕'}</span>
          <span class="a-txt"><b>${esc(String(a.title).replace(/^[^\p{L}\p{N}]+\s*/u, ''))}</b><small>${esc(a.body)}</small></span>
          <small class="a-t">${fmtDateTime(a.t)}</small></a>`).join('')
      : '<div class="mon-hint">Ainda sem alertas. Segue produtos (☆ Seguir) ou ativa 🔔 numa pesquisa guardada.</div>';
  }

  $('monEnable').addEventListener('click', enablePush);
  $('monTest').addEventListener('click', test);
  $('monRun').addEventListener('click', runNow);
  $('monitorPanel').addEventListener('toggle', (e) => { if (e.target.open) refresh(); }, true);

  if ($('monBelow')) $('monBelow').addEventListener('change', () => scheduleSync());

  return { sync, scheduleSync, refresh, render, pullHistory };
})();
