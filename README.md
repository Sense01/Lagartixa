# 🕷️ Web Crawler (GitHub Pages)

Crawler que corre inteiramente no browser — HTML, CSS e JavaScript puros, sem build nem backend.

## Funcionalidades

- Um ou vários sites de partida (um por linha)
- Pesquisa de palavras-chave/expressões: contagem por página, trechos com a palavra destacada,
  resumo por palavra (clicar filtra a tabela), opções "palavra inteira" e "maiúsculas/minúsculas"
- Link direto com parâmetros: `?site=example.com&kw=preço,promoção`
- Ícone para o iPhone: Safari → Partilhar → **Adicionar ao ecrã principal** (abre como app, em ecrã inteiro)
- Crawl em largura (BFS) a partir dos sites indicados
- Limites de páginas, profundidade, pedidos em paralelo e pausa entre pedidos
- Restrição ao mesmo domínio (opcional)
- Respeita `robots.txt` (grupo `User-agent: *`), `rel="nofollow"` e `<meta name="robots" content="nofollow">`
- Extrai: título, meta description, H1, canonical, nº de imagens, nº de palavras, links
- Filtro de resultados, exportação para JSON e CSV
- Definições guardadas no browser (localStorage)

## Publicar no GitHub Pages

1. Cria um repositório e coloca lá o conteúdo todo desta pasta (incluindo `icons/`, `manifest.json`
   e `apple-touch-icon.png`) na raiz.
2. Em **Settings → Pages**, escolhe **Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Passado um minuto, o site fica em `https://<utilizador>.github.io/<repositório>/`.

Para testar localmente: `python3 -m http.server` na pasta e abre `http://localhost:8000`.

## Porque é que há um proxy CORS?

O GitHub Pages só serve ficheiros estáticos, e o browser bloqueia (CORS) pedidos `fetch` a outros
domínios que não o permitam explicitamente. Por isso os pedidos passam por um proxy CORS público
(allorigins, corsproxy.io, codetabs).

Os proxies públicos são práticos para testar, mas têm limites de pedidos e podem falhar. Para uso sério,
cria o teu próprio proxy — por exemplo um Cloudflare Worker gratuito — e escolhe **Personalizado…**
com algo como `https://meu-proxy.workers.dev/?url={url}`.

## Estrutura

| Ficheiro     | Conteúdo                                  |
|--------------|-------------------------------------------|
| `index.html` | Interface                                 |
| `style.css`  | Estilos                                   |
| `crawler.js` | Classe `Crawler` (fila, fetch, parsing, robots.txt) |
| `app.js`     | Ligação entre a interface e o crawler     |
| `manifest.json`, `apple-touch-icon.png`, `icons/` | Logo e modo app (iPhone / Android) |
