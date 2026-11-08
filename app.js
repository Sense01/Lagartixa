const $ = (id) => document.getElementById(id);

let crawler = null;
let results = [];
let kwFilter = null; // palavra-chave selecionada no resumo

/* ---------- proxy personalizado ---------- */
$('proxy').addEventListener('change', () => {
  $('customProxyWrap').classList.toggle('hidden', $('proxy').value !== 'custom');
});

/* ---------- guardar/carregar definições ---------- */
const FIELDS = ['sites', 'keywords', 'maxPages', 'maxDepth', 'concurrency', 'delay', 'proxy', 'customProxy'];
const CHECKS = ['sameDomain', 'respectRobots', 'stripQuery', 'wholeWord', 'caseSensitive'];

function saveSettings() {
  const s = {};
  FIELDS.forEach((f) => (s[f] = $(f).value));
  CHECKS.forEach((c) => (s[c] = $(c).checked));
  try { localStorage.setItem('crawler-settings', JSON.stringify(s)); } catch {}
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('crawler-settings') || '{}');
    FIELDS.forEach((f) => s[f] != null && ($(f).value = s[f]));
    CHECKS.forEach((c) => s[c] != null && ($(c).checked = s[c]));
  } catch {}
  // permite links do tipo ?site=example.com&kw=preço,promoção
  const p = new URLSearchParams(location.search);
  if (p.get('site')) $('sites').value = p.getAll('site').join('\n');
  if (p.get('kw')) $('keywords').value = p.getAll('kw').join('\n');
  $('proxy').dispatchEvent(new Event('change'));
}
loadSettings();

const splitList = (txt, re) => txt.split(re).map((s) => s.trim()).filter(Boolean);

/* ---------- UI ---------- */
function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

function statusClass(s) {
  if (typeof s !== 'number') return 's-err';
  if (s < 300) return 's-ok';
  if (s < 400) return 's-redirect';
  return 's-err';
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function keywordCell(r) {
  const hits = r.keywordHits || {};
  const kws = Object.keys(hits);
  if (!kws.length) return '';
  const tags = kws.map((k) => `<span class="tag">${esc(k)} × ${hits[k]}</span>`).join('');
  const snips = kws
    .flatMap((k) => (r.keywordSnippets[k] || []).map(
      (s) => `<p class="snip">${esc(s.before)}<mark>${esc(s.match)}</mark>${esc(s.after)}</p>`
    ))
    .join('');
  return `<details><summary>${tags}</summary>${snips}</details>`;
}

function addRow(r, i) {
  const tr = document.createElement('tr');
  tr.dataset.search = `${r.url} ${r.title} ${r.status}`.toLowerCase();
  tr.dataset.kws = JSON.stringify(Object.keys(r.keywordHits || {}));
  tr.innerHTML = `
    <td class="num">${i}</td>
    <td class="url"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
    <td class="${statusClass(r.status)}">${esc(r.status)}${r.error && typeof r.status !== 'number' ? ' — ' + esc(r.error) : ''}</td>
    <td>${esc(r.title)}</td>
    <td class="kw">${keywordCell(r)}</td>
    <td class="num">${r.depth}</td>
    <td class="num">${r.links?.length ?? 0}</td>
    <td class="num">${r.ms || ''}</td>`;
  applyFilter(tr);
  $('results').appendChild(tr);
}

function renderKeywordSummary(s) {
  const kws = Object.keys(s.keywordTotals || {});
  $('kwPanel').classList.toggle('hidden', !kws.length);
  $('kwSummary').innerHTML = kws
    .map((k) => {
      const n = s.keywordTotals[k];
      const cls = ['kw-card', n ? '' : 'zero', kwFilter === k ? 'active' : ''].join(' ');
      return `<div class="${cls}" data-kw="${esc(k)}">
        <b>${esc(k)}</b><small>${n} ocorrências · ${s.keywordPages[k]} páginas</small></div>`;
    })
    .join('');
}

$('kwSummary').addEventListener('click', (e) => {
  const card = e.target.closest('.kw-card');
  if (!card) return;
  kwFilter = kwFilter === card.dataset.kw ? null : card.dataset.kw;
  if (crawler) renderKeywordSummary(crawler.stats());
  refilter();
});

function updateStats(s, state) {
  $('statCrawled').textContent = s.crawled;
  $('statQueued').textContent = s.queued;
  $('statMatches').textContent = s.matches;
  $('statErrors').textContent = s.errors;
  $('statLinks').textContent = s.links;
  if (state) $('statStatus').textContent = state;
  renderKeywordSummary(s);
}

function applyFilter(tr) {
  const q = $('filter').value.trim().toLowerCase();
  const kws = JSON.parse(tr.dataset.kws);
  const show =
    (!q || tr.dataset.search.includes(q)) &&
    (!$('onlyMatches').checked || kws.length > 0) &&
    (!kwFilter || kws.includes(kwFilter));
  tr.style.display = show ? '' : 'none';
}
const refilter = () => document.querySelectorAll('#results tr').forEach(applyFilter);
$('filter').addEventListener('input', refilter);
$('onlyMatches').addEventListener('change', refilter);

function setRunning(on) {
  $('startBtn').disabled = on;
  $('stopBtn').disabled = !on;
  $('exportJson').disabled = on || !results.length;
  $('exportCsv').disabled = on || !results.length;
  document.querySelectorAll('#config input, #config select, #config textarea').forEach((el) => (el.disabled = on));
}

/* ---------- iniciar / parar ---------- */
$('config').addEventListener('submit', async (e) => {
  e.preventDefault();
  saveSettings();

  const proxy = $('proxy').value === 'custom' ? $('customProxy').value.trim() : $('proxy').value;
  if (proxy !== '{url}' && !proxy.includes('{url}')) {
    alert('O proxy tem de conter o marcador {url}.');
    return;
  }

  results = [];
  kwFilter = null;
  $('results').innerHTML = '';
  $('log').textContent = '';

  crawler = new Crawler({
    startUrls: splitList($('sites').value, /[\n\s,]+/),
    keywords: splitList($('keywords').value, /[\n,;]+/),
    wholeWord: $('wholeWord').checked,
    caseSensitive: $('caseSensitive').checked,
    maxPages: +$('maxPages').value,
    maxDepth: +$('maxDepth').value,
    concurrency: +$('concurrency').value,
    delay: +$('delay').value,
    proxy,
    sameDomain: $('sameDomain').checked,
    respectRobots: $('respectRobots').checked,
    stripQuery: $('stripQuery').checked,
  });

  crawler.onResult = (r, i) => { results.push(r); addRow(r, i); };
  crawler.onLog = log;
  crawler.onProgress = (s) => updateStats(s, 'a correr');

  setRunning(true);
  updateStats(crawler.stats(), 'a correr');
  try {
    await crawler.start();
    updateStats(crawler.stats(), 'concluído');
  } catch (err) {
    log('Erro: ' + err.message);
    updateStats(crawler.stats(), 'erro');
  }
  setRunning(false);
});

$('stopBtn').addEventListener('click', () => {
  crawler?.stop();
  updateStats(crawler.stats(), 'parado');
});

/* ---------- exportar ---------- */
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

$('exportJson').addEventListener('click', () => {
  download(`crawl-${stamp()}.json`, JSON.stringify(results, null, 2), 'application/json');
});

$('exportCsv').addEventListener('click', () => {
  const kws = Object.keys(crawler?.keywordTotals || {});
  const cols = ['url', 'status', 'title', 'description', 'depth', 'from', 'ms', 'wordCount', 'images', 'canonical', 'error'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [...cols, 'links', 'keywordTotal', ...kws.map((k) => `kw:${k}`)];
  const rows = results.map((r) =>
    [
      ...cols.map((c) => r[c]),
      r.links?.length ?? 0,
      r.keywordTotal ?? 0,
      ...kws.map((k) => r.keywordHits?.[k] ?? 0),
    ].map(cell).join(',')
  );
  download(`crawl-${stamp()}.csv`, '﻿' + [header.map(cell).join(','), ...rows].join('\n'), 'text/csv');
});
