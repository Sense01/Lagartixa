# O teu Worker (Cloudflare, plano grátis)

O Worker faz três coisas para a app:

1. **Proxy** — lê as páginas das lojas (o browser sozinho não pode, por causa do CORS).
2. **"É bom negócio?"** — uma IA com pesquisa web avalia o preço de um produto.
3. **Alertas automáticos** — de hora a hora verifica os produtos que segues e as pesquisas com 🔔,
   e envia notificações para o iPhone, mesmo com a app fechada.

> `cloudflare-worker.js` é gerado a partir de `src/main.js` + `../js/extract-lite.js`.
> Se mudares o código, edita `src/main.js` e corre `python3 tools/build_worker.py` na raiz do projeto.

---

## 1. Código

Cloudflare → **Workers & Pages** → **crawler-proxy** → **Edit code** (na versão **Latest**) →
apaga tudo, cola o conteúdo de `cloudflare-worker.js` → **Deploy**.

No topo do código, `ALLOWED_ORIGINS` tem de incluir o endereço do teu GitHub Pages
(só o domínio, sem barra no fim — ex.: `https://sense01.github.io`).

## 2. Chave da IA (para "É bom negócio?")

**Settings → Variables and Secrets → + Add** → Type **Secret**, Name **`AI_API_KEY`**, Value = a tua chave → **Deploy**.

| A chave começa por | Fornecedor | Onde se cria |
|---|---|---|
| `gsk_` | Groq (`gpt-oss-120b` + pesquisa no browser) | console.groq.com → API Keys |
| `xai-` | xAI Grok | console.x.ai |
| `sk-ant-` | Anthropic Claude | console.anthropic.com |

Limite de **60 avaliações por dia** (constante `DEAL_DAILY_LIMIT`) para nunca esgotares a quota.

## 3. Armazenamento KV (para alertas e limite diário)

1. Cloudflare → **Storage & Databases → KV → Create** → nome `crawler` → **Create**.
2. No Worker: **Settings → Bindings → + Add → KV namespace**
   - Variable name: **`CRAWLER_KV`** (exatamente assim)
   - KV namespace: `crawler`
3. **Deploy**.

## 4. Verificação automática (Cron)

No Worker: **Settings → Triggers → Cron Triggers → + Add** → expressão **`0 * * * *`** (de hora a hora) → **Add / Deploy**.

## 5. Notificações no iPhone

1. Abre a app no Safari → Partilhar → **Adicionar ao ecrã principal** (obrigatório no iOS para push).
2. Abre a app **pelo ícone** → painel **🔔 Alertas automáticos** → **Ativar notificações neste aparelho** → Permitir.
3. Carrega em **Enviar teste**: deve chegar uma notificação "As notificações estão a funcionar!".

Depois é só **☆ Seguir** produtos (podes definir "Avisar abaixo de X €") e/ou ativar **🔔** numa pesquisa guardada.

### Que alertas recebo

| Alerta | Quando |
|---|---|
| ↓ Descida | um produto seguido (ou de uma pesquisa com 🔔) ficou mais barato |
| 🎯 Alvo | um produto seguido chegou ao teu preço-alvo |
| 📦 Stock | um produto seguido que estava esgotado voltou |
| 🆕 Novo | apareceu um produto novo numa pesquisa com 🔔 (a 1.ª verificação só regista o que já existe) |

Se houver mais de 3 alertas de uma vez, chega uma notificação-resumo.

## Limites do plano grátis (já respeitados pelo código)

- 100 000 pedidos/dia ao Worker.
- **50 sub-pedidos por execução**: cada verificação faz no máximo ~38 pedidos às lojas
  (até 25 produtos seguidos + até 3 sites por pesquisa), o resto fica para as notificações.
- KV: 1000 escritas/dia — cada verificação faz 1 escrita (24/dia) + 1 por avaliação de negócio.
- O Worker respeita o `robots.txt` de cada loja e ignora páginas com captcha/bloqueio.

## Testes

Na raiz do projeto: `node tests/worker.test.mjs` (25 testes: push, VAPID, verificação, limites, segurança).
