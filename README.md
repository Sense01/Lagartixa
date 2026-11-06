# Web Crawler App

Dás palavras-chave e uma lista de sites; o crawler (Playwright + Chromium) percorre as páginas,
destaca os resultados a amarelo, e vês tudo ao vivo no browser (com um cursor vermelho a mover-se
e a fazer scroll). No fim recebes uma notificação.

## Como correr
```bash
npm install
npx playwright install --with-deps chromium
npm start
# abre http://localhost:3000
```

## Notificações
- **No browser:** aceita o pedido de permissão ao clicar em "Iniciar".
- **No telemóvel (mesmo com o separador fechado):** instala a app ntfy, subscreve um tópico secreto e corre com
  `NTFY_TOPIC=o-teu-topico npm start`.

## Correr no GitHub (Codespaces)
Abre o repositório num Codespace, corre os comandos acima e abre a porta 3000 (separador "Ports").

## Notas
- Respeita o `robots.txt` e faz pausa entre páginas. Usa só em sites onde isso é permitido.
- Só segue links do mesmo domínio de cada site.

## Pôr online (Render, via Docker)
1. Faz push do projeto para um repositório GitHub.
2. Em render.com: New > Web Service > liga o repositório > Runtime: Docker.
3. Em Environment define `APP_PASSWORD` (obrigatório, para ninguém mais usar a app) e, opcionalmente, `NTFY_TOPIC`.
4. Deploy. A app fica em `https://<nome>.onrender.com` (utilizador: qualquer um; palavra-passe: `APP_PASSWORD`).
