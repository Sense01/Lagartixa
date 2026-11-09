# 🕷️ Web Crawler (GitHub Pages)

Caçador de produtos e promoções que corre no browser (HTML, CSS e JavaScript puros, sem build),
com um Worker da Cloudflare para ler as lojas, avaliar negócios e enviar alertas para o iPhone.

## Funcionalidades

**Lojas (📚)**
- **Diretório de lojas testadas** (`data/sites.json`): 61 lojas PT/FR com estado verificado (✅ funciona / ⚠️ parcial / ⛔ bloqueia),
  categoria, método de leitura, notas sobre o `robots.txt` e endereços de partida prontos — carrega em **Usar** (ou **＋** para juntar várias lojas).
- **Verificador de compatibilidade**: cola o endereço de qualquer loja e a app testa, através do teu Worker, o `robots.txt`,
  bloqueios/captchas, páginas só com JavaScript, o método de leitura e quantos produtos com preço encontra. As lojas testadas ficam
  no teu diretório pessoal. **🔍 Testar agora** volta a confirmar qualquer loja da lista.

**Pesquisar**
- Um ou vários sites, palavras-chave, preço mínimo/máximo e desconto mínimo.
- **Pesquisas guardadas** (💾): repete uma pesquisa com um toque; ativa 🔔 para alertas automáticos.
- **Ficar dentro da secção**: ao começar em `/componentes/` só segue links dessa secção.
- Lê produtos de: **Lidl** (API de pesquisa), lojas **PrestaShop** (JSON), **JSON-LD** (schema.org)
  e deteção automática em HTML (ex.: Globaldata, Coolmatica).
- Respeita `robots.txt` e deteta bloqueios/captchas (sem os contornar).

**Produtos**
- Cartões com foto, preço, preço antigo, desconto, **stock** (esgotado / por encomenda) e captura da página.
- **Histórico de preços** guardado no aparelho: "↓ 2,08 € (-19%) desde 06/11", mini-gráfico e 🏆 mínimo histórico.
- **Comparação entre lojas**: o mesmo produto (nº do set LEGO, EAN ou referência) noutras lojas — onde é mais barato.
- Ordenar por **melhores negócios**, maior desconto, maior descida, preço; filtros
  **só bons negócios**, **esconder esgotados**, **só preços que desceram**.
- **💡 É bom negócio?** — IA com pesquisa web (Groq/xAI/Anthropic) dá veredicto, preço típico, mais baixo e PVP;
  usa também o teu histórico e os preços vistos noutras lojas.
- 📸 cartão PNG do produto (no iPhone abre a folha de partilha para guardar nas Fotografias).

**Seguir e alertas**
- **☆ Seguir** produtos, com **preço-alvo** ("avisar abaixo de X €") e botão para atualizar preços.
- **Alertas automáticos**: o Worker verifica de hora a hora e envia **notificações push** (descida,
  preço-alvo, regresso ao stock, produto novo) — mesmo com a app fechada.

**Outros**: modo escuro/claro com fundo de seda animado, exportação JSON/CSV, ícone e modo app no iPhone.

## Publicar

1. Coloca o conteúdo desta pasta na raiz de um repositório → **Settings → Pages → Deploy from a branch** (`main`, `/ (root)`).
2. Configura o Worker: ver [`worker/README.md`](worker/README.md) (código, chave da IA, KV, Cron, notificações).
3. No iPhone: Safari → Partilhar → **Adicionar ao ecrã principal**.

Testar localmente: `python3 -m http.server 8000` e abrir `http://localhost:8000`.

## Estrutura

| Ficheiro | Conteúdo |
|---|---|
| `index.html`, `style.css`, `bg.js` | Interface, estilos (vidro, temas) e fundo animado (WebGL) |
| `js/util.js` | Utilitários partilhados (formatação, toast, mini-gráfico) |
| `js/store.js` | Dados no aparelho: histórico de preços, seguidos, pesquisas, identidade dos produtos |
| `js/extract-lite.js` | Extração de produtos sem DOM — **partilhado com o Worker** |
| `js/crawler.js` | Motor do crawler: fila, proxies, robots.txt, Lidl, PrestaShop, JSON-LD, HTML |
| `js/items.js` | Cartões, filtros, ordenação, comparação entre lojas, cartão PNG |
| `js/deals.js` | "É bom negócio?" |
| `js/watch.js` | Produtos seguidos e preço-alvo |
| `js/monitor.js` | Alertas automáticos e notificações push |
| `js/sites.js` | Diretório de lojas e verificador de compatibilidade |
| `data/sites.json` | Base de dados das lojas (verificada em 09/11/2026) |
| `js/app.js` | Definições, pesquisas guardadas, execução, tabela, exportação |
| `sw.js`, `manifest.json`, `icons/` | Service worker (push), modo app e ícones |
| `worker/` | Worker da Cloudflare (`src/main.js` → `cloudflare-worker.js`) |
| `tools/build_worker.py` | Gera o ficheiro único do Worker (ASCII) |
| `tests/` | Testes: `tests/index.html` (browser) e `node tests/worker.test.mjs` |

## Testes

- **No browser**: abre `tests/index.html` (também funciona no GitHub Pages em `/tests/`) — 41 testes do crawler,
  extração (Globaldata, PrestaShop, Lidl, JSON-LD), stock, bloqueios, histórico, comparação, verificador de lojas e validação
  da base de dados (incluindo que nenhum endereço usa caminhos proibidos pelo `robots.txt`). Usa dados isolados.
- **Worker**: `node tests/worker.test.mjs` — 25 testes (encriptação push RFC 8291, VAPID, verificação automática,
  robots.txt, limites, segurança).

## Atualizar a base de dados de lojas

Edita `data/sites.json` (cada loja: `id`, `name`, `domain`, `country`, `categories`, `status` = `ok`/`partial`/`blocked`,
`method`, `starts` = [{`label`, `url`}], `notes`). Corre `tests/index.html` para validar o ficheiro.
