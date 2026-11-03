# RevGás – chatbot de pedidos de gás pelo WhatsApp

Bot com IA para os clientes de uma revenda de gás (que usa o software RevGás) pedirem botijão pelo WhatsApp. Os pedidos vão aos entregadores pelo WhatsApp; o dono acompanha tudo num painel web.

- Por quê e como foi decidido: `docs/superpowers/specs/2026-10-28-chatbot-whatsapp-revenda-gas-design.md` (fonte de verdade do comportamento).
- Como foi construído, tarefa a tarefa: `docs/superpowers/plans/2026-10-28-chatbot-whatsapp-revenda-gas.md`.
- Implantação (Meta, variáveis, VPS): `README.md`. Teste passo a passo para iniciantes: `docs/GUIA-DE-TESTE.md`. Teste sem a Meta, com WAHA: `docs/WAHA.md`. Ligar e desligar no dia a dia: `docs/COMO-RODAR.md`. **Vai contribuir? Leia `docs/CONTRIBUINDO.md`.**

## Comandos

```bash
npm install
npm test                 # vitest: WhatsApp e IA falsos, sem custo
npx tsc --noEmit         # checagem de tipos
npm run dev              # sobe com .env (tsx watch); painel em http://localhost:3000/painel
npx tsx scripts/eval-conversas.ts   # 6 conversas com o Claude REAL; precisa de ANTHROPIC_API_KEY
npm run build && npm start          # produção (dist/)
```

Rode `npm test` e `npx tsc --noEmit` antes de todo commit (o GitHub roda os dois em todo PR). Mudou o prompt ou as ferramentas da IA (`src/ai/`)? Rode também o eval. Os testes não precisam de `.env` nem de internet.

## Stack

Node 22+, TypeScript strict ESM (NodeNext, imports com `.js`), Fastify 5, better-sqlite3, zod 4, vitest, painel com eta + htmx. IA: Anthropic SDK com `toolRunner` (modelo em `AI_MODEL`, padrão `claude-haiku-5-5`). WhatsApp: dois canais escolhidos por `WA_PROVIDER`: `meta` (Cloud API oficial, o de produção) e `waha` (não oficial, só teste e demonstração). Áudio: transcrição compatível com a OpenAI, configurável (`TRANSCRIBE_URL`/`TRANSCRIBE_MODEL`/`TRANSCRIBE_API_KEY`); hoje Groq (`whisper-large-v3-turbo`), padrão OpenAI `whisper-1`.

## Mapa do código (`src/`)

- `inbound/` – webhook → roteador (dedupe, debounce, cliente × equipe), mídia (áudio, comprovante Pix).
- `ai/` – agente, prompt e ferramentas (`preparar_pedido`, `confirmar_pedido`, `alterar_pedido`...).
- `orders/` – criação/alteração/cancelamento, despacho aos entregadores, respostas da equipe.
- `domain/` – regras puras (preço, horário, validação, redação de dados sensíveis). Sem I/O.
- `store/` – acesso ao SQLite. `db/migrations/` – SQL numerado; nova migração = novo arquivo + entrada em `MIGRATIONS` em `db/connection.ts`. Nunca edite uma migração já publicada.
- `whatsapp/waha.ts` – canal WAHA (não oficial), escolhido por `WA_PROVIDER=waha`; sem janela de 24 h nem modelos. Só para teste/demonstração, nunca produção. Precisa do engine GOWS para enviar lista.
- Opções para tocar: a ferramenta `mostrar_opcoes` leva a mensagem do turno e as opções; `sendChoices` vira botões ou lista na Meta e lista no WAHA, e o outbox cai para texto numerado se falhar.
- `panel/`, `jobs/` (lembretes, liberação de agendados), `whatsapp/` (API, outbox com janela de 24 h, templates).

## Regras que o código não mostra sozinho

- **Preço, horários, bairros, pagamentos e chave Pix vêm só do painel** (tabela de settings). Nunca no código nem no prompt. A IA não pode inventar valores.
- **Confirmação é garantida em código, não pelo modelo.** Cada `preparar_pedido` substitui os rascunhos anteriores; o "sim" só vale para o resumo mais recente, já apresentado ao cliente, e cuja resposta repetiu o total formatado. Não afrouxe isso.
- **O modelo só vê o histórico como texto**, sem as ferramentas dos turnos anteriores. Por isso o agente injeta o aviso "Resumo aguardando confirmação: rascunhoId N" (`openDraftNote` em `ai/agent.ts`). Sem ele, o "sim" do cliente faz o modelo preparar o pedido de novo em ciclo. Não remova.
- **O resumo do pedido é montado em código** (`buildSummary` em `ai/tool-handlers.ts`, com emojis e `*negrito*`) e o modelo só o copia dentro de `mostrar_opcoes`. Valores e total nunca saem do modelo.
- **Dados sensíveis:** CPF e código SMS do Gás do Povo são apagados antes de gravar ou mandar ao modelo (`domain/redact.ts`). O contexto Gás do Povo vem só de rascunho/pedido aberto, não de menção, para não apagar número de casa.
- **Comprovante Pix** enviado antes do despacho fica ligado ao rascunho ou pedido agendado (`store/receipts.ts`) e só vai para esse pedido.
- Fora da janela de 24 h, a Meta só aceita modelos aprovados (`WA_TPL_*`); o outbox cuida disso.
- Textos ao cliente e à equipe em português do Brasil, tom de atendente de revenda (curto, sem formalidade).
- Comentários e mensagens de commit em português; commits no estilo `fix: ...` / `feat: ...`.

## Não commitar

`.env` (segredos), `data/` (banco com dados de clientes), `opencode.json` (config local), `.superpowers/` (rascunhos de trabalho).

## Windows

O caminho do projeto tem acento (`Rev-Gás`): use aspas no PowerShell (`cd "C:\...\Rev-Gás"`).

## Situação (2026-11-03)

- Bot completo e testado de ponta a ponta com WAHA (GOWS) e um chip de teste: conversa, menus com opções, pedido, aviso ao dono, "saiu/entregue" por mensagem, áudio (Groq). Eval com o Claude real passa. 424 testes (o painel novo está num branch, ver abaixo).
- **A API oficial da Meta está bloqueada**: erro 130497 (conta restrita para o Brasil) por falta de verificação do negócio (exige CNPJ). Até lá, WAHA só para teste e demonstração; o número pode ser banido.
- **Painel novo ("ÍRIS", modelo em protótipo do Claude Design) em migração** no branch `feat/painel-iris`: Central e Pedidos (quadro com painel lateral) estão prontas; Conversas, Clientes, Alertas e Configurações ainda usam o layout antigo, já com as cores novas. Entregadores, Estoque e "Novo pedido" da referência ficaram para depois (não existem no projeto). Não mexa no painel sem combinar.
- Ainda não testado com WAHA: foto de comprovante Pix.
- Antes de ir ao ar: conta Meta verificada, 4 modelos de mensagem aprovados (PEDIDO e ALERTA obrigatórios), número definitivo, VPS com HTTPS e backup do banco.
