import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { crawl } from './crawler.js';

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let running = null;

// Notificação push opcional (funciona mesmo com o separador fechado): https://ntfy.sh
async function pushNotify(title, body) {
  if (!process.env.NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: encodeURIComponent(title) },
      body,
    });
  } catch {}
}

wss.on('connection', (ws) => {
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'stop') return running?.abort();
    if (msg.type !== 'start') return;
    if (running) return send({ type: 'error', message: 'Já existe uma pesquisa em curso.' });

    const c = msg.config || {};
    const keywords = (c.keywords || []).map((k) => String(k).trim()).filter(Boolean);
    const sites = (c.sites || []).filter((s) => /^https?:\/\//i.test(s));
    if (!keywords.length || !sites.length)
      return send({ type: 'error', message: 'Indica palavras-chave e sites (com http/https).' });

    running = new AbortController();
    try {
      const out = await crawl(
        { keywords, sites, maxPages: Math.min(+c.maxPages || 10, 50), delay: Math.max(+c.delay || 1000, 500) },
        send,
        running.signal
      );
      const summary = `${out.results.length} página(s) com resultados em ${out.visited} visitada(s).`;
      send({ type: 'done', ...out, summary });
      await pushNotify('Pesquisa concluída', summary);
    } catch (e) {
      send({ type: 'error', message: e.message });
    } finally {
      running = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`App em http://localhost:${PORT}`));
