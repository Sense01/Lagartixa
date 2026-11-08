# O teu próprio proxy (Cloudflare Worker, grátis)

Os proxies públicos (allorigins, codetabs, corsproxy.io) caem com frequência e muitos sites bloqueiam-nos.
Um Worker teu é mais rápido e estável. Demora ~5 minutos:

1. Cria conta em <https://dash.cloudflare.com> (grátis).
2. **Workers & Pages → Create → Create Worker** → dá um nome (ex.: `crawler-proxy`) → **Deploy**.
3. **Edit code**, apaga tudo, cola o conteúdo de `cloudflare-worker.js`.
4. Em `ALLOWED_ORIGINS`, troca `https://SEU-UTILIZADOR.github.io` pelo endereço do teu GitHub Pages
   (só o domínio, sem `/repositorio`). → **Deploy**.
5. Na app, em **O meu proxy**, escreve:
   `https://crawler-proxy.<a-tua-conta>.workers.dev/?url={url}`
   e deixa o modo **Automático** (o teu proxy é tentado primeiro) ou escolhe **Só o meu proxy**.

Teste rápido no browser: `https://crawler-proxy.<a-tua-conta>.workers.dev/?url=https://example.com`

> Nota: alguns sites grandes (ex.: com proteção anti-bot Akamai/Cloudflare) também podem bloquear
> os servidores da Cloudflare. Se isso acontecer, o erro aparece na tabela e no log.
