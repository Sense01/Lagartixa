# 🕷️ Web Crawler (GitHub Pages)

Crawler que corre inteiramente no browser — HTML, CSS e JavaScript puros, sem build nem backend.

## Funcionalidades

- **Sites e palavras-chave**: um ou vários sites (um por linha) e palavras/expressões a procurar,
  com contagem por página, trechos destacados e resumo por palavra.
- **Produtos, preços e descontos**: deteta produtos e filtra por **preço mínimo/máximo** e **desconto mínimo (%)**.
  - **Lidl** (todas as lojas `lidl.xx`): as páginas `/q/query/…` e `/q/search?…` carregam os produtos por JavaScript,
    por isso a app usa diretamente a API de pesquisa do Lidl (nome, marca, preço, preço antigo, % desconto, imagem).
  - Outros sites: dados estruturados **JSON-LD (schema.org Product)** e, se não houver, heurística no HTML.
- **Screenshot por produto**: captura da página de cada produto (WordPress mShots ou thum.io, grátis)
  e botão **📸 Guardar** que gera um cartão PNG (foto, preço, desconto) — no iPhone abre a folha de partilha
  para guardar nas Fotografias.
- **Notificação quando termina** + som + vibração + número no ícone da app.
- **Proxies com troca automática**: se um proxy falhar, tenta o seguinte. Suporta o teu próprio proxy (ver `worker/`).
- Exportação: JSON (páginas + produtos), CSV de páginas, CSV de produtos.
- Fundo fluido animado, interface em vidro, 4 paletas de cor, ícone para iPhone.
- Link com parâmetros: `?site=lidl.fr&kw=parkside&max=150&desc=20`

## Publicar no GitHub Pages

1. Coloca o conteúdo desta pasta na raiz de um repositório.
2. **Settings → Pages → Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. O site fica em `https://<utilizador>.github.io/<repositório>/`.

Testar localmente: `python3 -m http.server` e abrir `http://localhost:8000`.

## No iPhone

1. Abre o site no **Safari** → Partilhar → **Adicionar ao ecrã principal**.
2. Abre a app pelo ícone e carrega em **Iniciar** — na primeira vez pede autorização para notificações.

Limitações do iOS (são regras da Apple para apps web):
- Notificações só funcionam com a app **instalada no ecrã principal** (iOS 16.4 ou superior).
- O iOS **pausa** apps web em segundo plano: o crawling só avança com a app aberta. A notificação é útil
  quando a app está aberta noutro separador/janela ou com o ecrã ligado.

## Erro "Failed to fetch" / "Todos os proxies falharam"

Significa que os proxies públicos estão em baixo ou o site os bloqueia. Solução recomendada:
cria o teu proxy grátis no Cloudflare — instruções em [`worker/README.md`](worker/README.md).

## Estrutura

| Ficheiro | Conteúdo |
|---|---|
| `index.html` | Interface |
| `style.css` | Estilos (vidro, animações, responsivo) |
| `bg.js` | Fundo fluido animado (WebGL, com fallback em CSS) e paletas de cor |
| `crawler.js` | Motor: fila, proxies, robots.txt, extração de produtos/preços, API do Lidl |
| `app.js` | Interface, galeria de produtos, screenshots, notificações, exportação |
| `sw.js` | Service worker (necessário para notificações) |
| `manifest.json`, `apple-touch-icon.png`, `icons/` | Logo e modo app |
| `worker/` | Proxy próprio para Cloudflare Workers |
