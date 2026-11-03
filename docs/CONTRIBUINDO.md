# Como contribuir

Guia curto para quem vai ajudar no projeto, sozinho ou com o Claude Code. Para entender o produto, leia o `CLAUDE.md` (mapa do código e regras) e a especificação em `docs/superpowers/specs/`.

## 1. Preparar o computador

Precisa de: **Git**, **Node 22 ou mais novo** (`node --version`) e, se for usar IA, o **Claude Code**. Docker só é necessário para o WAHA (veja `docs/WAHA.md`), não para testes.

```bash
git clone https://github.com/gabbms/RevGas.git
cd RevGas
npm install
npm test            # tem que passar sem nenhuma chave e sem internet
npx tsc --noEmit    # checagem de tipos
```

No Windows, se a pasta tiver acento (`Rev-Gás`), use aspas no PowerShell.

Se `npm test` passa, você já pode trabalhar. **Você não precisa de `.env` para a maioria das tarefas.**

## 2. Usando o Claude Code

1. Abra o terminal **dentro da pasta do projeto** e rode `claude`.
2. Ele lê o `CLAUDE.md` sozinho. Não precisa configurar skills nem plugins.
3. O que **não** vem junto: as conversas e decisões anteriores de quem criou o projeto. Se algo importante não está no `CLAUDE.md` ou em `docs/`, a IA não sabe. **Se você descobrir algo que ela deveria saber, registre no `CLAUDE.md`** no mesmo PR.
4. Cuidado com sugestões da IA que "melhoram" as regras sensíveis listadas em "Regras que o código não mostra sozinho" do `CLAUDE.md`: confirmação do pedido, valores vindos só do painel, dados sensíveis, resumo montado em código. Revise essas partes com atenção.

## 3. Segredos: nunca no Git, nunca no chat

- O `.env`, a pasta `data/` (banco com dados reais de clientes) e `.waha/` (sessão do WhatsApp) **não vão para o Git** e não devem ser enviados a ninguém.
- Para rodar o bot localmente: `cp .env.example .env` e preencha com **as suas próprias chaves** (Anthropic; Groq ou OpenAI para áudio). Elas custam poucos dólares.
- Precisa de uma chave de outra pessoa? Peça por um gerenciador de senhas, nunca por WhatsApp, e-mail ou issue. Se uma chave vazar, gere outra na hora.
- Para ver o painel com dados de exemplo, sem tocar em nada real: `npx tsx scripts/painel-demo.ts`.
- **Um chip de WhatsApp só liga em um computador por vez.** Se você escanear o QR do chip de outra pessoa, derruba a sessão dela. Cada um usa o seu chip de teste, ou só um roda o bot.

## 4. Fluxo de trabalho

```
main  ──●────────●──────────●──  (sempre estável)
         \      /  \        /
          tarefa     tarefa      (branch curto, vira PR)
```

1. **Parta do `main` atualizado:** `git switch main && git pull`.
2. **Crie um branch por tarefa**, curto e com nome claro: `git switch -c fix/audio-groq` ou `feat/painel-clientes`.
3. **Commits pequenos**, em português, no estilo `feat: ...` / `fix: ...` / `docs: ...`.
4. **Antes de abrir o PR:** `npm test` e `npx tsc --noEmit`. Mudou o prompt ou as ferramentas da IA (`src/ai/`)? Rode também `npx tsx --env-file=.env scripts/eval-conversas.ts` (usa o Claude de verdade).
5. **Abra um Pull Request** no GitHub. O GitHub roda os testes sozinho, e outra pessoa revisa antes de juntar.
6. **Nada de push direto no `main`** e nada de `git push --force` em branch compartilhado.

## 5. Quem mexe em quê

Para evitar conflitos, combine antes de mexer na mesma área:

| Área | Pastas |
|---|---|
| Bot (conversa, IA) | `src/ai/`, `src/inbound/`, `src/whatsapp/` |
| Pedidos e entregas | `src/orders/`, `src/domain/`, `src/store/` |
| Painel | `src/panel/`, `tests/panel/` |

O painel está em **redesenho** (branch `feat/painel-iris`): não mexa nele sem falar com quem está migrando as telas.

## 6. Regras de código

- TypeScript estrito, ESM com imports terminando em `.js`. Comentários e textos ao cliente em português do Brasil.
- Preço, horário, bairros, formas de pagamento e chave Pix vêm **só do painel** (tabela de settings). Nunca no código nem no prompt.
- Migração de banco já publicada nunca se edita: crie uma nova (veja `CLAUDE.md`).
- Toda mudança de comportamento vem com teste. Os testes usam WhatsApp e IA falsos (`tests/fakes/`).
