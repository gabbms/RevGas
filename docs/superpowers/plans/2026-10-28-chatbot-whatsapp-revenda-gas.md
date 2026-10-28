# Chatbot de pedidos de gás pelo WhatsApp — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um serviço único em Node/TypeScript que atende clientes de uma revenda de gás pelo WhatsApp oficial com IA (Claude Haiku 5.5): recebe pedidos de P13, avisa os entregadores, acompanha o status, manda lembretes de recompra e oferece um painel web para o dono.

**Architecture:** Fastify recebe o webhook da Cloud API da Meta e serve o painel (HTML renderizado no servidor + htmx). As mensagens de cliente passam por um roteador (dedupe → redação de dados sensíveis → armazenamento → debounce por cliente) e chegam a um agente Claude com ferramentas. Preço, regras e pedidos vivem só em código e no banco SQLite, nunca no prompt. A criação e o despacho de pedidos ficam isolados atrás de `OrderDispatcher`, para que no futuro dê para trocar o destino pela RevGás.

**Tech Stack:** Node 22+, TypeScript (strict, ESM), Fastify 5, better-sqlite3, zod, `@anthropic-ai/sdk` (tool runner beta + `betaZodTool`), @fastify/view + eta, @fastify/cookie, @fastify/formbody, @fastify/static, htmx (CDN), vitest. Transcrição: API de transcrição da OpenAI via `fetch` (atrás da interface `Transcriber`).

**Spec:** `docs/superpowers/specs/2026-10-28-chatbot-whatsapp-revenda-gas-design.md`

## Global Constraints

- Todo texto visto por cliente, entregador ou dono é **português do Brasil**, num tom simpático e direto, sem exagero de emoji.
- Dinheiro é sempre **inteiro em centavos** no código e no banco. A exibição é `R$ 115,00`, via `formatBRL`.
- O modelo vem de `AI_MODEL`, com padrão **`claude-haiku-5-5`**. Nenhum outro arquivo fixa o ID do modelo. O esforço vem de `AI_EFFORT`, com padrão `medium`.
- Preço, horário, bairros, pagamentos, chave Pix e regras do Gás do Povo vêm **só** de `StoreSettings`. O prompt não contém nenhum valor.
- Só a **Cloud API oficial da Meta**. Mensagens fora da janela de 24h saem por modelo aprovado (`pt_BR`).
- **Nunca** armazenar nem mandar ao modelo um CPF, uma senha ou um código SMS do Gás do Povo (ver `redactSensitive`).
- Os campos de domínio ficam em português (`quantidade`, `pagamento`, `endereco`), igual ao spec e aos esquemas das ferramentas. Funções e módulos ficam em inglês.
- O fuso horário vem de `StoreSettings.fuso`, com padrão `America/Sao_Paulo`. Datas são guardadas como ISO UTC.
- Os testes usam `vitest` com SQLite `:memory:` e fakes de `WhatsAppApi`. Nenhum teste automatizado chama a Meta, a Anthropic ou a OpenAI.

## Review Focus

1. **Cliente manda várias mensagens seguidas** ("oi" / "manda um gás" / áudio) → uma só resposta coerente, processada em ordem → teste em Task 6 (`debouncer agrupa e serializa`).
2. **A Meta reenvia o mesmo webhook** → a mensagem é processada uma única vez → teste em Task 6 (`ignora wamid repetido`).
3. **Mensagem para quem está fora da janela de 24h** (entregador no primeiro pedido do dia, dono respondendo pelo painel, aviso de status de pedido agendado) → usa o modelo quando existe; sem modelo, falha explícita, nunca silenciosa → testes em Task 4 e Task 15.
4. **"Sim" chega depois de o preço mudar no painel, ou o modelo tenta confirmar no mesmo turno do resumo** → a confirmação é recusada e um novo resumo é apresentado → teste em Task 10.
5. **Cliente do Gás do Povo manda CPF ou o código SMS no chat** → o dado é mascarado antes de ser gravado e antes de chegar ao modelo → testes em Task 6.

---

## Estrutura de arquivos

```
package.json · tsconfig.json · vitest.config.ts · .env.example · README.md
src/
  main.ts                      wiring + listen
  server.ts                    buildApp(deps) — webhook + painel
  config/env.ts                loadEnv()
  db/connection.ts             openDb(path) + migrações
  db/migrations/001_init.sql
  domain/types.ts              tipos de domínio compartilhados
  domain/phone.ts              normalizePhone, samePhone
  domain/money.ts              formatBRL
  domain/hours.ts              isOpen, nextOpening, formatHorarios, localDateKey
  domain/pricing.ts            quote
  domain/order-validation.ts   validateOrderRequest
  domain/redact.ts             redactSensitive
  domain/staff-replies.ts      parseStaffReply
  domain/reminders.ts          nextReorderDate, dueForReminder
  store/settings.ts · customers.ts · messages.ts · orders.ts · drafts.ts · alerts.ts
  whatsapp/api.ts              createWhatsAppApi
  whatsapp/outbox.ts           janela 24h + fallback de modelo
  whatsapp/webhook.ts          verifySignature, parseWebhook
  inbound/debouncer.ts         createKeyedDebouncer
  inbound/router.ts            createInboundRouter
  inbound/media.ts             áudio + comprovante
  orders/dispatcher.ts         OrderDispatcher + WhatsApp
  orders/service.ts            createOrderService
  orders/staff.ts              handleStaffMessage
  alerts/service.ts            createAlertService
  ai/prompt.ts · ai/tool-handlers.ts · ai/tools.ts · ai/agent.ts
  audio/transcriber.ts
  jobs/scheduler.ts
  panel/auth.ts · panel/routes-orders.ts · panel/routes-customers.ts · panel/routes-conversations.ts · panel/routes-config.ts
  panel/views/*.eta · panel/public/style.css
scripts/eval-conversas.ts
tests/ (espelha src/)
```

---

### Task 1: Projeto, ambiente, banco e configurações da loja

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config/env.ts`, `src/db/connection.ts`, `src/db/migrations/001_init.sql`, `src/domain/types.ts`, `src/domain/phone.ts`, `src/store/settings.ts`
- Test: `tests/store/settings.test.ts`, `tests/domain/phone.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `PaymentMethod = 'dinheiro'|'cartao'|'pix_entrega'|'pix_antecipado'|'gas_do_povo'`; `CylinderMode = 'troca'|'completo'`; `OrderKind = 'entrega'|'retirada'`; `OrderStatus = 'agendado'|'recebido'|'saiu'|'entregue'|'retirado'|'cancelado'`; `Address { rua: string; numero: string; complemento?: string; referencia?: string; bairro: string }`; `WeekdayKey = 'dom'|'seg'|'ter'|'qua'|'qui'|'sex'|'sab'`.
  - `loadEnv(src = process.env): Env`, validado com zod. Campos: `PORT`(3000), `DB_PATH`('data/revgas.db'), `PUBLIC_URL`, `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_GRAPH_VERSION`('v23.0'), `WA_TPL_PEDIDO`, `WA_TPL_STATUS`, `WA_TPL_ALERTA`, `WA_TPL_LEMBRETE` (os quatro opcionais), `ANTHROPIC_API_KEY`, `AI_MODEL`('claude-haiku-5-5'), `AI_EFFORT`('low'|'medium'|'high', padrão 'medium'), `OPENAI_API_KEY`, `TRANSCRIBE_MODEL`('whisper-1'), `PANEL_PASSWORD`, `SESSION_SECRET`(≥32 chars).
  - `openDb(path: string): Database` (better-sqlite3), que aplica `001_init.sql` uma única vez (`PRAGMA user_version`) e liga `foreign_keys`.
  - `normalizePhone(input: string): string`: só dígitos; com 10–11 dígitos, prefixa `55`. `samePhone(a, b): boolean` considera iguais números brasileiros com e sem o 9º dígito (`5586999991234` ≡ `558699991234`).
  - `StoreSettingsSchema` (zod) e `type StoreSettings` com: `nomeLoja`, `enderecoLoja`, `precoRecargaCentavos`, `precoCompletoCentavos`, `previsaoEntregaMin`, `horarios: Record<WeekdayKey, {abre:'HH:MM'; fecha:'HH:MM'} | null>`, `bairros: string[]`, `pagamentos: PaymentMethod[]`, `chavePix: string|null`, `telefoneDono: string`, `entregadores: {nome: string; telefone: string}[]`, `destinoPedidos: 'entregadores'|'dono'`, `gasDoPovo: {aceita: boolean; modalidade: 'entrega'|'retirada'; taxaEntregaCentavos: number}`, `lembretesAtivos: boolean`, `fuso: string`.
  - `getSettings(db): StoreSettings`: devolve `DEFAULT_SETTINGS` (preços 0, pagamentos `['dinheiro','cartao','pix_entrega']`, seg–sáb 07:00–20:00, dom 08:00–13:00, `lembretesAtivos: true`, `gasDoPovo.aceita: false`, fuso `America/Sao_Paulo`) se nada estiver salvo.
  - `updateSettings(db, s: StoreSettings): StoreSettings`: valida e lança `ZodError` se inválido. Telefones são normalizados ao salvar.
- Schema SQL (`001_init.sql`), tudo `INTEGER`/`TEXT`:
  - `settings(id=1, json)`
  - `customers(id PK, telefone UNIQUE, nome, endereco_json, lembretes_desativados DEFAULT 0, bot_pausado_ate, ultima_mensagem_em, ultimo_lembrete_em, criado_em)`
  - `messages(id PK, cliente_id FK, autor CHECK IN('cliente','bot','dono'), tipo, texto, wamid UNIQUE NULL, criado_em)`
  - `orders(id PK AUTOINCREMENT, cliente_id FK, tipo, quantidade, modo, pagamento, troco_para_centavos, endereco_json, unitario_centavos, casco_centavos, taxa_entrega_centavos, total_centavos, status, entregador_telefone, precisa_revisao, criado_em, enviado_em, saiu_em, finalizado_em)`
  - `order_messages(wamid PK, order_id FK, telefone)`
  - `drafts(id PK, cliente_id FK, payload_json, total_centavos, criado_em, consumido_em)`
  - `alerts(id PK, cliente_id NULL, pedido_id NULL, motivo, resumo, criado_em, resolvido_em)`
  - `contact_windows(telefone PK, ultima_entrada_em)`
  - `inbound_seen(wamid PK, em)`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/store/settings.test.ts
test('getSettings devolve padrões quando vazio', () => {
  const db = openDb(':memory:');
  const s = getSettings(db);
  expect(s.precoRecargaCentavos).toBe(0);
  expect(s.horarios.dom).toEqual({ abre: '08:00', fecha: '13:00' });
  expect(s.fuso).toBe('America/Sao_Paulo');
});
test('updateSettings persiste e normaliza telefones', () => {
  const db = openDb(':memory:');
  const s = { ...getSettings(db), precoRecargaCentavos: 11500, telefoneDono: '(86) 99999-1234' };
  updateSettings(db, s);
  expect(getSettings(db).telefoneDono).toBe('5586999991234');
});
test('updateSettings rejeita preço negativo e abre >= fecha', () => {
  const db = openDb(':memory:');
  expect(() => updateSettings(db, { ...getSettings(db), precoRecargaCentavos: -1 })).toThrow();
  expect(() => updateSettings(db, { ...getSettings(db), horarios: { ...getSettings(db).horarios, seg: { abre: '20:00', fecha: '07:00' } } })).toThrow();
});
// tests/domain/phone.test.ts
test('samePhone com e sem nono dígito', () => {
  expect(samePhone('5586999991234', '558699991234')).toBe(true);
  expect(samePhone('5586999991234', '5586999991235')).toBe(false);
});
```

- [ ] **Step 2: Run `npx vitest run tests/store tests/domain/phone.test.ts`** → FAIL (módulos inexistentes)
- [ ] **Step 3: Implement** os arquivos acima. Adicionar os scripts `test` (`vitest run`), `dev` (`tsx watch src/main.ts`), `build` (`tsc`) e `start` (`node dist/main.js`) ao `package.json`. Usar a versão do zod que o `@anthropic-ai/sdk` aceita como peer.
- [ ] **Step 4: Run `npx vitest run`** → PASS
- [ ] **Step 5: Commit** `feat: projeto base, banco e configurações da loja`

---

### Task 2: Horários de funcionamento

**Files:**
- Create: `src/domain/hours.ts`, `src/domain/money.ts`
- Test: `tests/domain/hours.test.ts`

**Interfaces:**
- Consumes: `StoreSettings`
- Produces: `isOpen(s, now: Date): boolean`; `nextOpening(s, now: Date): Date | null` (próxima abertura nos 7 dias seguintes, `null` se todos os dias estiverem fechados); `formatHorarios(s): string` (ex.: `"Seg a Sáb 07:00–20:00 · Dom 08:00–13:00"`, agrupando dias iguais e consecutivos); `localDateKey(now, fuso): string` (`YYYY-MM-DD` local); `localHour(now, fuso): number`; `formatBRL(cents: number): string` (`11500 → "R$ 115,00"`, usar `Intl.NumberFormat('pt-BR')` e trocar o NBSP por espaço comum). Cálculo local com `Intl.DateTimeFormat` no `s.fuso`; `fecha` é exclusivo.

- [ ] **Step 1: Write the failing tests**

```ts
const s = { ...DEFAULT_SETTINGS }; // seg–sáb 07–20, dom 08–13, fuso SP (UTC-3)
test('aberto segunda 10h local', () => expect(isOpen(s, new Date('2026-11-02T13:00:00Z'))).toBe(true));
test('fechado segunda 20h local (fecha exclusivo)', () => expect(isOpen(s, new Date('2026-11-02T23:00:00Z'))).toBe(false));
test('domingo 14h fechado; próxima abertura segunda 07h', () => {
  const now = new Date('2026-11-01T17:00:00Z');
  expect(isOpen(s, now)).toBe(false);
  expect(nextOpening(s, now)?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
});
test('formatHorarios agrupa', () => expect(formatHorarios(s)).toBe('Seg a Sáb 07:00–20:00 · Dom 08:00–13:00'));
test('formatBRL', () => expect(formatBRL(11500)).toBe('R$ 115,00'));
```

- [ ] **Step 2: Run `npx vitest run tests/domain/hours.test.ts`** → FAIL
- [ ] **Step 3: Implement** `hours.ts` e `money.ts`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: horários de funcionamento e formatação de dinheiro`

---

### Task 3: Preço e validação do pedido

**Files:**
- Create: `src/domain/pricing.ts`, `src/domain/order-validation.ts`
- Test: `tests/domain/pricing.test.ts`, `tests/domain/order-validation.test.ts`

**Interfaces:**
- Consumes: `StoreSettings`, `isOpen`, `formatBRL`
- Produces:
  - `QuoteInput { quantidade: number; modo: CylinderMode; pagamento: PaymentMethod }`
  - `Quote { unitarioCentavos; cascoCentavos; taxaEntregaCentavos; totalCentavos }`
  - `quote(s, q): Quote`. Regras do spec:
    - Fora do Gás do Povo: unitário = `troca ? precoRecarga : precoCompleto`; taxa 0; casco 0; total = qtd × unitário.
    - Gás do Povo: unitário 0; casco por unidade = `modo==='completo' ? precoCompleto − precoRecarga : 0`; taxa = `gasDoPovo.taxaEntregaCentavos` uma vez por pedido, só se `modalidade==='entrega'`; total = qtd × casco + taxa.
  - `OrderRequest { quantidade: number; modo: CylinderMode; pagamento: PaymentMethod; trocoParaCentavos?: number; endereco?: Address }`
  - `ValidationResult = { ok: true; tipo: OrderKind; quote: Quote; agendado: boolean; precisaRevisao: boolean } | { ok: false; erros: string[] }`
  - `validateOrderRequest(s, req, now): ValidationResult`. Erros em PT, um por regra violada:
    - quantidade não inteira ou < 1;
    - preço não configurado (recarga 0, ou completo 0 quando for necessário);
    - pagamento fora de `s.pagamentos`, ou Gás do Povo com `aceita=false`;
    - para entrega, falta rua, número ou bairro;
    - bairro fora de `s.bairros` (comparar sem acento e sem diferenciar maiúsculas);
    - em dinheiro, `trocoParaCentavos` menor que o total;
    - Pix antecipado sem `chavePix`.
  - `tipo` é `'retirada'` só no Gás do Povo com `modalidade==='retirada'`; nesse caso o endereço não é exigido. `agendado = tipo==='entrega' && !isOpen(s, now)`. `precisaRevisao = quantidade > 3`.
  - `normalizeText(s: string): string` (minúsculas, sem acento, espaços colapsados), exportado para Tasks 6 e 8.

- [ ] **Step 1: Write the failing tests**

```ts
const s = { ...DEFAULT_SETTINGS, precoRecargaCentavos: 11500, precoCompletoCentavos: 32000, bairros: ['Centro', 'Fátima'],
  pagamentos: ['dinheiro','cartao','pix_entrega','pix_antecipado','gas_do_povo'], chavePix: 'x',
  gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 } } as StoreSettings;
test('2 troca dinheiro', () => expect(quote(s, { quantidade: 2, modo: 'troca', pagamento: 'dinheiro' }).totalCentavos).toBe(23000));
test('1 completo', () => expect(quote(s, { quantidade: 1, modo: 'completo', pagamento: 'cartao' }).totalCentavos).toBe(32000));
test('gás do povo troca = só taxa', () => expect(quote(s, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }).totalCentavos).toBe(500));
test('gás do povo sem vazio paga casco', () => expect(quote(s, { quantidade: 1, modo: 'completo', pagamento: 'gas_do_povo' })).toMatchObject({ cascoCentavos: 20500, totalCentavos: 21000 }));
test('gás do povo retirada sem taxa', () => {
  const r = { ...s, gasDoPovo: { ...s.gasDoPovo, modalidade: 'retirada' as const } };
  expect(quote(r, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' }).totalCentavos).toBe(0);
});
const end = { rua: 'Rua A', numero: '10', bairro: 'fatima' };
const segunda10h = new Date('2026-11-02T13:00:00Z');
test('bairro sem acento é aceito', () => expect(validateOrderRequest(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end }, segunda10h).ok).toBe(true));
test('bairro fora da área', () => expect(validateOrderRequest(s, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: { ...end, bairro: 'Dirceu' } }, segunda10h)).toMatchObject({ ok: false }));
test('troco menor que total', () => expect(validateOrderRequest(s, { quantidade: 1, modo: 'troca', pagamento: 'dinheiro', trocoParaCentavos: 10000, endereco: end }, segunda10h)).toMatchObject({ ok: false }));
test('preço não configurado', () => expect(validateOrderRequest({ ...s, precoRecargaCentavos: 0 }, { quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end }, segunda10h)).toMatchObject({ ok: false }));
test('fora do horário vira agendado; 4 botijões precisa revisão', () => {
  const r = validateOrderRequest(s, { quantidade: 4, modo: 'troca', pagamento: 'cartao', endereco: end }, new Date('2026-11-02T23:30:00Z'));
  expect(r).toMatchObject({ ok: true, agendado: true, precisaRevisao: true });
});
test('gás do povo recusado quando loja não aceita', () => expect(validateOrderRequest({ ...s, gasDoPovo: { ...s.gasDoPovo, aceita: false } }, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo', endereco: end }, segunda10h)).toMatchObject({ ok: false }));
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `pricing.ts` e `order-validation.ts`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: cálculo de preço e validação de pedido`

---

### Task 4: Cliente da Cloud API e outbox com janela de 24h

**Files:**
- Create: `src/whatsapp/api.ts`, `src/whatsapp/outbox.ts`
- Test: `tests/whatsapp/api.test.ts`, `tests/whatsapp/outbox.test.ts`, `tests/fakes/fake-whatsapp.ts`

**Interfaces:**
- Produces:
  - `interface WhatsAppApi { sendText(to: string, body: string): Promise<{ wamid: string }>; sendTemplate(to: string, name: string, params: string[]): Promise<{ wamid: string }>; sendMedia(to: string, kind: 'image'|'document', mediaId: string, caption?: string): Promise<{ wamid: string }>; uploadMedia(data: Buffer, mime: string): Promise<string>; downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> }`
  - `createWhatsAppApi(o: { token: string; phoneNumberId: string; graphVersion: string; fetch?: typeof fetch }): WhatsAppApi`
    - POST `https://graph.facebook.com/{v}/{phoneNumberId}/messages` com `Authorization: Bearer`.
    - Template com `language: { code: 'pt_BR' }` e um componente `body` com os parâmetros `type: 'text'`.
    - Os parâmetros passam por `sanitizeTemplateParam`: troca `\n` por ` · ` e colapsa espaços repetidos.
    - Download: GET `/{v}/{mediaId}` para obter a `url`, depois GET da `url` com o mesmo token.
    - Upload: POST `/{phoneNumberId}/media` em multipart.
    - Resposta não-2xx lança `WhatsAppApiError(status, body)`.
  - `type OutgoingMessage = { telefone: string; texto: string; template?: { nome: string; parametros: string[] } }`
  - `type SendResult = { ok: true; wamid: string; via: 'texto'|'template' } | { ok: false; motivo: 'fora_da_janela'|'erro_api'; detalhe?: string }`
  - `createOutbox(db, api: WhatsAppApi, clock: () => Date)` → `{ registerInbound(telefone: string, at: Date): void; windowOpen(telefone: string, now?: Date): boolean; send(m: OutgoingMessage): Promise<SendResult> }`
    - Janela aberta quando `ultima_entrada_em` foi há menos de 24h (usa `samePhone`); nesse caso manda `sendText`.
    - Janela fechada com `template` (e nome do modelo não vazio): manda `sendTemplate`.
    - Janela fechada sem modelo: `{ok:false, motivo:'fora_da_janela'}`.
    - `WhatsAppApiError` vira `erro_api`. `send` nunca lança.
  - `FakeWhatsApp implements WhatsAppApi`, que registra `sent: {to, kind, body|name, params}[]` e devolve wamids `wamid.N`.

- [ ] **Step 1: Write the failing tests**

```ts
test('sendText monta requisição da Cloud API', async () => {
  const calls: any[] = [];
  const api = createWhatsAppApi({ token: 't', phoneNumberId: 'PN', graphVersion: 'v23.0',
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(String(init!.body)) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })); } });
  expect(await api.sendText('5586999991234', 'oi')).toEqual({ wamid: 'wamid.1' });
  expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/PN/messages');
  expect(calls[0].body).toEqual({ messaging_product: 'whatsapp', to: '5586999991234', type: 'text', text: { body: 'oi' } });
});
test('parâmetro de template sem quebra de linha', async () => { /* sendTemplate com 'a\nb' → body.template.components[0].parameters[0].text === 'a · b' */ });
test('janela aberta → texto', async () => {
  const fake = new FakeWhatsApp(); const now = new Date('2026-11-02T13:00:00Z');
  const ob = createOutbox(openDb(':memory:'), fake, () => now);
  ob.registerInbound('5586999991234', new Date(now.getTime() - 60_000));
  expect(await ob.send({ telefone: '558699991234', texto: 'oi', template: { nome: 'x', parametros: [] } })).toMatchObject({ ok: true, via: 'texto' });
});
test('janela fechada com modelo → template', async () => { /* sem registerInbound → via 'template', fake.sent[0].kind === 'template' */ });
test('janela fechada sem modelo → fora_da_janela', async () => { /* expect({ ok: false, motivo: 'fora_da_janela' }) e fake.sent vazio */ });
test('erro da API vira erro_api', async () => { /* fake que lança WhatsAppApiError → { ok:false, motivo:'erro_api' } */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `api.ts`, `outbox.ts`, `fake-whatsapp.ts`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: cliente da Cloud API e outbox com janela de 24h`

---

### Task 5: Webhook da Meta e servidor

**Files:**
- Create: `src/whatsapp/webhook.ts`, `src/server.ts`
- Test: `tests/whatsapp/webhook.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Produces:
  - `verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`: compara `sha256=` + HMAC-SHA256 hex em tempo constante.
  - `type InboundContent = { tipo: 'texto'|'botao'; texto: string } | { tipo: 'audio'; mediaId: string; mime: string } | { tipo: 'imagem'|'documento'; mediaId: string; mime: string; legenda?: string } | { tipo: 'outro' }`
  - `type InboundEvent = { wamid: string; de: string; nomePerfil?: string; em: Date; respostaA?: string; conteudo: InboundContent }`
  - `parseWebhook(payload: unknown): InboundEvent[]`:
    - lê `entry[].changes[].value.messages[]`;
    - `nomePerfil` vem de `value.contacts[0].profile.name`;
    - `respostaA` vem de `context.id`;
    - `interactive.button_reply.title` e `button.text` viram `botao`;
    - `timestamp` (segundos) vira `em`;
    - ignora `statuses`;
    - payload inválido devolve `[]`.
  - `interface AppDeps { env: Env; onInbound(events: InboundEvent[]): Promise<void>; registerPanel?(app: FastifyInstance): Promise<void> }`
  - `buildApp(deps): Promise<FastifyInstance>`:
    - `GET /webhook`: com `hub.mode=subscribe` e `hub.verify_token===WA_VERIFY_TOKEN`, responde 200 com `hub.challenge` em texto puro; senão 403.
    - `POST /webhook`: guarda o body cru com um `addContentTypeParser('application/json', { parseAs: 'buffer' })`; assinatura inválida → 401; senão responde 200 imediatamente e chama `onInbound` sem `await`, capturando e logando erros.
    - `GET /healthz` → 200.

- [ ] **Step 1: Write the failing tests**

```ts
test('parseWebhook texto, áudio, resposta e botão', () => {
  const ev = parseWebhook(fixture('webhook-texto-audio.json')); // fixture com 1 texto (context.id='wamid.P'), 1 audio, 1 button
  expect(ev.map(e => e.conteudo.tipo)).toEqual(['texto', 'audio', 'botao']);
  expect(ev[0]).toMatchObject({ de: '5586999991234', respostaA: 'wamid.P', nomePerfil: 'Maria' });
});
test('statuses são ignorados e payload inválido dá []', () => { expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]); expect(parseWebhook(null)).toEqual([]); });
test('verificação GET', async () => { /* app.inject GET /webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42 → 200 '42'; token errado → 403 */ });
test('POST com assinatura inválida → 401; válida → 200 e onInbound chamado', async () => { /* assina fixture com WA_APP_SECRET */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `webhook.ts` e `server.ts`. Criar a fixture `tests/fixtures/webhook-texto-audio.json` no formato real da Cloud API.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: webhook da Meta com verificação de assinatura`

---

### Task 6: Roteador de entrada (dedupe, redação, clientes, mensagens, pausa, debounce)

**Files:**
- Create: `src/domain/redact.ts`, `src/store/customers.ts`, `src/store/messages.ts`, `src/store/drafts.ts`, `src/inbound/debouncer.ts`, `src/inbound/router.ts`
- Test: `tests/domain/redact.test.ts`, `tests/inbound/debouncer.test.ts`, `tests/inbound/router.test.ts`

**Interfaces:**
- Consumes: `InboundEvent`, `createOutbox().registerInbound`, `getSettings`, `samePhone`, `normalizeText`
- Produces:
  - `redactSensitive(texto: string, o: { contextoGasDoPovo: boolean }): { texto: string; removido: boolean }`:
    - um CPF (`\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b`) vira `[CPF removido]`;
    - se `contextoGasDoPovo` e a mensagem inteira for `^\s*\d{4,8}\s*$`, ela vira `[código removido]`.
  - `Customer { id: number; telefone: string; nome: string|null; endereco: Address|null; lembretesDesativados: boolean; botPausadoAte: string|null; ultimaMensagemEm: string|null; ultimoLembreteEm: string|null; criadoEm: string }`
  - `customers.ts`: `upsertCustomerByPhone(db, telefone, now: Date): Customer`; `getCustomer(db, id): Customer|null`; `getCustomerByPhone(db, telefone): Customer|null` (usa `samePhone`); `updateCustomer(db, id, patch: Partial<Pick<Customer,'nome'|'endereco'|'lembretesDesativados'|'botPausadoAte'|'ultimaMensagemEm'|'ultimoLembreteEm'>>): Customer`; `listCustomers(db): Customer[]`.
  - `StoredMessage { id; clienteId; autor: 'cliente'|'bot'|'dono'; tipo: 'texto'|'audio'|'imagem'|'documento'|'botao'|'sistema'; texto: string; wamid: string|null; criadoEm: string }`
  - `messages.ts`: `insertMessage(db, m: Omit<StoredMessage,'id'>): StoredMessage`; `recentMessages(db, clienteId, since: Date, limit = 40): StoredMessage[]` (em ordem cronológica); `lastCustomerMessageAt(db, clienteId): Date|null`.
  - `drafts.ts`: `Draft { id; clienteId; request: OrderRequest; totalCentavos; criadoEm: string; consumidoEm: string|null }`; `createDraft(db, clienteId, request, totalCentavos, now): Draft`; `getDraft(db, id): Draft|null`; `consumeDraft(db, id, now): void`; `hasRecentGasDoPovoDraft(db, clienteId, now): boolean` (rascunho não consumido de até 2h com `pagamento==='gas_do_povo'`).
  - `createKeyedDebouncer(ms: number)` → `{ schedule(key: string, fn: () => Promise<void>): void; idle(): Promise<void> }`:
    - agenda `fn` para `ms` após o último `schedule` da mesma chave;
    - se `fn` daquela chave estiver rodando, roda de novo uma única vez quando ela terminar;
    - chaves diferentes rodam em paralelo.
  - `interface RouterDeps { db; outbox; clock: () => Date; isStaff(telefone: string): boolean; handleStaff(ev: InboundEvent): Promise<void>; contentToText(ev: InboundEvent, c: Customer): Promise<{ tipo: StoredMessage['tipo']; texto: string } | null>; onCustomerTurn(clienteId: number): Promise<void>; hasGasDoPovoContext(clienteId: number): boolean; debounceMs: number }`
  - `createInboundRouter(deps)` → `{ handle(events: InboundEvent[]): Promise<void>; idle(): Promise<void> }`. Ordem, por evento:
    1. ignora `wamid` já em `inbound_seen` (e grava o novo);
    2. `outbox.registerInbound(ev.de, ev.em)`;
    3. se `isStaff(ev.de)`, chama `handleStaff(ev)` e para;
    4. `upsertCustomerByPhone`, gravando `nome = nomePerfil` só se o nome ainda for nulo;
    5. `contentToText`; `null` para aqui;
    6. `redactSensitive` com `hasGasDoPovoContext`;
    7. `insertMessage(autor 'cliente', wamid)` e `ultimaMensagemEm`;
    8. se `botPausadoAte > now`, para;
    9. senão `debouncer.schedule(String(clienteId), () => onCustomerTurn(clienteId))`.
  - `defaultContentToText(ev)`: `texto`/`botao` → o próprio texto; `audio` → `[áudio]`; `imagem`/`documento` → `[imagem] legenda` / `[documento] legenda`; `outro` → `[mensagem não suportada]`. A Task 12 substitui áudio e mídia.

- [ ] **Step 1: Write the failing tests**

```ts
test('CPF sempre mascarado', () => expect(redactSensitive('meu cpf é 123.456.789-09', { contextoGasDoPovo: false }).texto).toBe('meu cpf é [CPF removido]'));
test('código só em contexto Gás do Povo', () => {
  expect(redactSensitive('482913', { contextoGasDoPovo: true }).texto).toBe('[código removido]');
  expect(redactSensitive('482913', { contextoGasDoPovo: false }).texto).toBe('482913');
  expect(redactSensitive('troco pra 200', { contextoGasDoPovo: true }).texto).toBe('troco pra 200');
});
test('debouncer agrupa e serializa', async () => {
  vi.useFakeTimers(); const d = createKeyedDebouncer(2000); const runs: number[] = [];
  d.schedule('1', async () => { runs.push(Date.now()); }); vi.advanceTimersByTime(1000);
  d.schedule('1', async () => { runs.push(Date.now()); }); vi.advanceTimersByTime(2000);
  await d.idle(); expect(runs).toHaveLength(1);
});
test('ignora wamid repetido', async () => { /* handle([ev, ev]) → 1 mensagem gravada, onCustomerTurn chamado 1x após idle() */ });
test('entregador vai para handleStaff e não vira cliente', async () => { /* isStaff=true → handleStaff chamado, listCustomers vazio */ });
test('bot pausado só grava', async () => { /* botPausadoAte = now+1h → mensagem gravada, onCustomerTurn não chamado */ });
test('código SMS mascarado antes de gravar', async () => { /* hasGasDoPovoContext=true, texto '482913' → messages[0].texto === '[código removido]' */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** os arquivos acima
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: roteador de entrada com dedupe, redação e debounce`

---

### Task 7: Alertas ao dono

**Files:**
- Create: `src/store/alerts.ts`, `src/alerts/service.ts`
- Test: `tests/alerts/service.test.ts`

**Interfaces:**
- Consumes: `outbox.send`, `getSettings`, `getCustomer`
- Produces:
  - `Alert { id; clienteId: number|null; pedidoId: number|null; motivo: string; resumo: string; criadoEm: string; resolvidoEm: string|null }`
  - `createAlertService(d: { db; outbox; settings: () => StoreSettings; publicUrl: string; templateAlerta?: string; clock })` → `{ create(a: { clienteId?: number; pedidoId?: number; motivo: string; resumo: string }): Promise<Alert>; listOpen(): Alert[]; resolve(id: number): void }`
  - `create` grava o alerta e, se `telefoneDono` existir, envia ao dono: `⚠️ {motivo}\n{resumo}\nCliente: {nome} ({telefone})\nPedido #{pedidoId}\n{publicUrl}/painel/conversas/{clienteId}`, omitindo as linhas sem dado. O modelo de fallback recebe `[motivo, resumo + cliente + link]`. Falha de envio não impede a gravação.

- [ ] **Step 1: Write the failing tests**: `create grava e envia ao dono com link` (`fake.sent[0].body` contém `/painel/conversas/1`); `sem telefoneDono só grava`; `resolve tira da listOpen`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: alertas ao dono`

---

### Task 8: Pedidos — serviço, despacho e avisos

**Files:**
- Create: `src/store/orders.ts`, `src/orders/dispatcher.ts`, `src/orders/service.ts`
- Test: `tests/orders/service.test.ts`, `tests/orders/dispatcher.test.ts`

**Interfaces:**
- Consumes: `validateOrderRequest`, `OrderRequest`, `AlertService`, `outbox`, `getCustomer`, `formatBRL`
- Produces:
  - `Order { id; clienteId; tipo: OrderKind; quantidade; modo; pagamento; trocoParaCentavos: number|null; endereco: Address|null; unitarioCentavos; cascoCentavos; taxaEntregaCentavos; totalCentavos; status: OrderStatus; entregadorTelefone: string|null; precisaRevisao: boolean; criadoEm; enviadoEm: string|null; saiuEm: string|null; finalizadoEm: string|null }`
  - `store/orders.ts`: `insertOrder`, `getOrder(db, id)`, `updateOrder(db, id, patch)`, `listOrdersByLocalDay(db, dayKey, fuso)`, `openOrdersFor(db, clienteId)` (status ∈ agendado, recebido, saiu), `deliveredOrderDates(db, clienteId): Date[]`, `recordOrderMessage(db, wamid, orderId, telefone)`, `orderByMessage(db, wamid): Order|null`, `orderRecipients(db, orderId): string[]` (telefones distintos em `order_messages`), `activeOrdersSentTo(db, telefone): Order[]` (status ∈ recebido, saiu, com `order_messages` para esse telefone).
  - `type AlertService = ReturnType<typeof createAlertService>` (Task 7) e `type OrderService = ReturnType<typeof createOrderService>`, ambos exportados.
  - `interface OrderDispatcher { novo(o: Order, c: Customer): Promise<void>; correcao(o: Order, c: Customer, descricao: string): Promise<void>; cancelamento(o: Order, c: Customer): Promise<void>; avisoEntregador(o: Order, texto: string): Promise<void> }`
  - `formatOrderForStaff(o, c, s): string`, no layout do mockup:
    - `🆕 PEDIDO #N`;
    - quantidade + `P13 troca`/`P13 completo` · total;
    - linha de pagamento: `💵 Dinheiro – troco p/ R$ X` / `💳 Cartão` / `Pix na entrega` / `⚠️ PIX ANTECIPADO – CONFERIR` / `🔵 GÁS DO POVO – levar a Azulzinha`;
    - `⚠️ REVISAR: N botijões`, quando `precisaRevisao`;
    - nome · telefone;
    - endereço com complemento e referência (na retirada: `RETIRADA NA LOJA`);
    - rodapé: `Responda esta mensagem com: saiu · entregue · problema` (na retirada: `Marque "retirado" no painel`).
  - `createWhatsAppDispatcher(d: { db; outbox; settings: () => StoreSettings; templatePedido?: string })`:
    - destinatários: se `destinoPedidos==='dono'`, ou o pedido for retirada, ou não houver entregadores → `[telefoneDono]`; senão os telefones dos entregadores;
    - cada envio bem-sucedido chama `recordOrderMessage`;
    - modelo de fallback com parâmetros `[formatOrderForStaff em uma linha]`;
    - `correcao` começa com `✏️ CORREÇÃO DO PEDIDO #N: {descricao}` + o pedido atualizado; `cancelamento` é `❌ PEDIDO #N CANCELADO`;
    - `avisoEntregador` vai para `entregadorTelefone` ou, se não houver, para todos os destinatários do pedido.
  - `createOrderService(d: { db; dispatcher: OrderDispatcher; alerts: AlertService; outbox; settings: () => StoreSettings; clock; templateStatus?: string })` → `OrderService`:
    - `create(clienteId, req: OrderRequest): Promise<{ ok: true; order: Order } | { ok: false; erros: string[] }>`: valida de novo. Status `agendado` se `agendado`, senão `recebido` + `dispatcher.novo` + `enviadoEm`. `precisaRevisao` gera o alerta "Pedido com N botijões".
    - `change(orderId, patch: Partial<OrderRequest>): Promise<{ ok: true; order: Order } | { ok: false; erros: string[] } | { ok: false; motivo: 'ja_saiu'|'finalizado' }>`: só em agendado/recebido. Revalida com o merge, recalcula valores e, se já tinha sido enviado, chama `dispatcher.correcao` com a descrição das mudanças. Pedido em `saiu` → `ja_saiu`, alerta ao dono e `avisoEntregador`.
    - `cancel(orderId, por: 'cliente'|'dono'): Promise<{ ok: true } | { ok: false; motivo: 'ja_saiu'|'finalizado' }>`: o cliente só cancela em agendado/recebido (em `saiu`, alerta + `avisoEntregador`); o dono cancela qualquer status não final. Chama `dispatcher.cancelamento` se o pedido já tinha sido enviado.
    - `setStatus(orderId, status: 'saiu'|'entregue'|'retirado', entregadorTelefone?: string): Promise<Order>`. Transições válidas: recebido→saiu; recebido|saiu→entregue (entrega); recebido→retirado (retirada). Qualquer outra lança `InvalidTransitionError`. Em `saiu`/`entregue`, avisa o cliente via `outbox.send` com o modelo de status (`[nome ou "cliente", frase]`) e grava a mensagem `autor 'bot'`, mesmo com o bot pausado. `saiu` inclui o nome do entregador se o telefone bater com `s.entregadores`. A retirada não notifica o cliente.
    - `releaseScheduled(now): Promise<number>`: se `isOpen`, cada pedido `agendado` vira `recebido` + `novo`.
    - `openOrdersFor(clienteId): Order[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('create envia a cada entregador e registra wamids', async () => { /* 2 entregadores → fake.sent 2 textos contendo 'PEDIDO #1' e 'Responda esta mensagem'; orderByMessage('wamid.1').id === 1 */ });
test('fora do horário fica agendado e não envia', async () => { /* status 'agendado', fake.sent vazio */ });
test('releaseScheduled envia ao abrir', async () => { /* agendado → releaseScheduled(segunda 10h) → 1, status 'recebido' */ });
test('pix antecipado e gás do povo aparecem na mensagem', () => { /* formatOrderForStaff contém 'PIX ANTECIPADO – CONFERIR' / 'levar a Azulzinha' */ });
test('retirada vai só para o dono', async () => { /* gasDoPovo.modalidade='retirada' → único destinatário telefoneDono, texto contém 'RETIRADA NA LOJA' */ });
test('change em recebido manda correção', async () => { /* change(id,{ trocoParaCentavos: 5000 }) → texto 'CORREÇÃO DO PEDIDO #1' */ });
test('change em saiu recusa e alerta', async () => { /* motivo 'ja_saiu', alerts.listOpen() length 1 */ });
test('saiu avisa cliente com nome do entregador; transição inválida lança', async () => { /* setStatus saiu com telefone do João → mensagem ao cliente contém 'João'; setStatus(entregue) de cancelado → InvalidTransitionError */ });
test('4 botijões gera alerta', async () => { /* alerts.listOpen()[0].motivo contém '4 botijões' */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: serviço de pedidos com despacho aos entregadores`

---

### Task 9: Respostas dos entregadores

**Files:**
- Create: `src/domain/staff-replies.ts`, `src/orders/staff.ts`
- Test: `tests/domain/staff-replies.test.ts`, `tests/orders/staff.test.ts`

**Interfaces:**
- Consumes: `InboundEvent`, `OrderService`, `orderByMessage`, `activeOrdersSentTo`, `AlertService`, `outbox`
- Produces:
  - `parseStaffReply(texto: string): 'saiu'|'entregue'|'problema'|null`. Usa `normalizeText` e testa nesta ordem:
    - problema: `problema`, `nao atende`, `ninguem`, `nao encontr`, `endereco errado`, `cancel`, `nao tem ninguem`;
    - entregue: `entreg`, `feito`, `finalizado`;
    - saiu: `saiu`, `saindo`, `a caminho`, `indo`, `sai agora`, `rota`.
  - `isStaffPhone(s: StoreSettings, telefone): boolean`: entregador ou dono.
  - `createStaffHandler(d: { db; orders: OrderService; alerts: AlertService; outbox; settings })` → `(ev: InboundEvent) => Promise<void>`:
    - pedido-alvo: `orderByMessage(ev.respostaA)`; senão, se `activeOrdersSentTo(ev.de)` tiver exatamente 1, esse;
    - nenhum alvo, ou mais de um → responde `Responda (deslizando) a mensagem do pedido com: saiu, entregue ou problema.`;
    - `parse === null` → mesma orientação;
    - saiu → `setStatus('saiu', ev.de)`, responde `👍 #N saiu com {nome}. Cliente avisado.`;
    - entregue → `setStatus('entregue')` (`'retirado'` se for retirada), responde `✅ #N entregue.`;
    - problema → `alerts.create({ pedidoId, clienteId, motivo: 'Problema na entrega', resumo: texto do entregador })`, responde `Avisei o dono sobre o #N.`;
    - `InvalidTransitionError` → `Pedido #N está {status}.`

- [ ] **Step 1: Write the failing tests**

```ts
test.each([['Saindo agora', 'saiu'], ['entreguei', 'entregue'], ['cliente não atende', 'problema'], ['bom dia', null]])('%s → %s', (t, r) => expect(parseStaffReply(t)).toBe(r));
test('resposta citando a mensagem atualiza o pedido certo', async () => { /* 2 pedidos ativos, respostaA = wamid do #2 → #2 'saiu' */ });
test('sem citação e 2 pedidos ativos pede para citar', async () => { /* nenhum status muda, resposta contém 'Responda' */ });
test('problema gera alerta', async () => { /* alerts.listOpen()[0].pedidoId === id */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: entregadores atualizam status respondendo a mensagem`

---

### Task 10: Ferramentas da IA

**Files:**
- Create: `src/ai/tool-handlers.ts`, `src/ai/tools.ts`
- Test: `tests/ai/tool-handlers.test.ts`

**Interfaces:**
- Consumes: `getSettings`, `isOpen`, `nextOpening`, `formatHorarios`, `formatBRL`, `validateOrderRequest`, `drafts.*`, `customers.*`, `OrderService`, `AlertService`
- Produces:
  - `ToolContext { db; clienteId: number; settings: () => StoreSettings; orders: OrderService; alerts: AlertService; clock: () => Date; ultimaMensagemClienteEm: Date }`
  - `createToolHandlers(ctx)`. Todas as funções devolvem objetos serializáveis, e todos os valores em dinheiro saem formatados com `formatBRL`.
    - `consultarLoja()`. Devolve: `{ nomeLoja, enderecoLoja, agora: 'seg 02/11 10:00', abertaAgora, horarios, proximaAbertura?, precoRecarga, precoCompleto, previsaoEntregaMin, bairros, pagamentos: string[], chavePix?, gasDoPovo: { aceita, modalidade, taxaEntrega } }`.
      - Os rótulos de pagamento são `Dinheiro`, `Cartão (maquininha)`, `Pix na entrega`, `Pix antecipado`, `Gás do Povo`.
      - `chavePix` só aparece se `pix_antecipado` for aceito.
      - Preço igual a 0 sai como `'não cadastrado'`.
    - `consultarCliente()`. Devolve: `{ nome, endereco, jaPediuAntes, ultimoPedido?: { quantidade, modo, pagamento, trocoPara? }, pedidosEmAberto: { numero, status, tipo, criadoEm, previsaoEntregaMin }[], lembretesDesativados }`.
    - `salvarCliente(i: { nome?: string; endereco?: Address })`. Devolve `{ ok: true }`.
    - `prepararPedido(req: OrderRequest)`.
      - Se a entrega vier sem `endereco`, usa o endereço salvo do cliente.
      - Válido: `createDraft` e devolve `{ rascunhoId, tipo, agendado, proximaAbertura?, resumo: string[], total }`.
      - O `resumo` traz: quantidade + troca/completo; casco; taxa; total; endereço; pagamento; troco; `Chave Pix: …` quando for Pix antecipado.
      - Inválido: devolve `{ erros }`.
    - `confirmarPedido(i: { rascunhoId: number })`. Recusa com `{ erro: string }` quando:
      - o rascunho é de outro cliente, já foi consumido ou tem mais de 2h;
      - o rascunho foi criado depois de `ultimaMensagemClienteEm`, com a mensagem de erro `'mostre o resumo e espere o cliente confirmar'`.
      - Revalida com as configurações atuais. Se o total mudou, devolve `{ erro: 'preco_mudou', novoRascunho: <saída de prepararPedido> }`.
      - Senão chama `orders.create`, `consumeDraft` e salva o endereço no cliente se ele não tiver nenhum. Devolve `{ numero, status, tipo, previsaoEntregaMin, agendado, proximaAbertura? }`.
    - `alterarPedido(i: { numero: number; mudancas: Partial<OrderRequest> })`: o pedido precisa ser do cliente. Mapeia o retorno de `orders.change` para `{ ok, resumo? , erros?, motivo? }`.
    - `cancelarPedido(i: { numero: number })`: o pedido precisa ser do cliente. Chama `orders.cancel(…, 'cliente')`.
    - `alertarDono(i: { motivo: string; resumo: string })`: chama `alerts.create` com o `clienteId`. Devolve `{ ok: true }`.
    - `desativarLembretes()`.
  - `buildTools(ctx): BetaRunnableTool[]`. Cada handler vira um `betaZodTool` (`@anthropic-ai/sdk/helpers/beta/zod`) com `run: async (i) => JSON.stringify(await h(i))`.
    - Nomes: `consultar_loja`, `consultar_cliente`, `salvar_cliente`, `preparar_pedido`, `confirmar_pedido`, `alterar_pedido`, `cancelar_pedido`, `alertar_dono`, `desativar_lembretes`.
    - Descrições em PT. A de `confirmar_pedido` diz: "Só chame depois que o cliente respondeu 'sim' ao resumo do preparar_pedido."
    - A lista e a ordem das ferramentas são fixas, para não quebrar o cache.

- [ ] **Step 1: Write the failing tests**

```ts
test('confirmar no mesmo turno do resumo é recusado', async () => {
  const h = createToolHandlers({ ...ctx, ultimaMensagemClienteEm: new Date('2026-11-02T13:00:00Z'), clock: () => new Date('2026-11-02T13:00:05Z') });
  const p = await h.prepararPedido({ quantidade: 1, modo: 'troca', pagamento: 'cartao', endereco: end });
  expect(await h.confirmarPedido({ rascunhoId: p.rascunhoId })).toMatchObject({ erro: expect.stringContaining('espere o cliente') });
});
test('confirmar no turno seguinte cria pedido', async () => { /* rascunho criado 13:00:05, novo ctx com ultimaMensagemClienteEm 13:01 → { numero: 1, status: 'recebido' } */ });
test('preço mudou entre resumo e sim', async () => { /* updateSettings precoRecarga 12000 antes do confirmar → erro 'preco_mudou' + novoRascunho.total 'R$ 120,00' */ });
test('consultarLoja não inventa preço não cadastrado', async () => { /* precoRecarga 0 → precoRecarga === 'não cadastrado' */ });
test('prepararPedido usa endereço salvo', async () => { /* cliente com endereço, req sem endereco → resumo contém a rua salva */ });
test('cancelar pedido de outro cliente é recusado', async () => { /* { ok:false } e pedido segue 'recebido' */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `tool-handlers.ts` e `tools.ts`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: ferramentas da IA com confirmação garantida em código`

---

### Task 11: Agente de conversa

**Files:**
- Create: `src/ai/prompt.ts`, `src/ai/agent.ts`
- Test: `tests/ai/agent.test.ts`

**Interfaces:**
- Consumes: `recentMessages`, `lastCustomerMessageAt`, `buildTools`, `outbox`, `insertMessage`, `AlertService`
- Produces:
  - `SYSTEM_PROMPT: string`, estático, sem datas nem valores. Precisa dizer:
    - quem o bot é: o atendente da revenda no WhatsApp, em PT-BR, natural, frases curtas, poucos emojis, sem menu obrigatório, com opções numeradas quando ajudam (pagamento);
    - que preço, horário, bairros, pagamento, Pix e Gás do Povo vêm **só** de `consultar_loja`, e que, se a informação não existir, ele diz que vai verificar e chama `alertar_dono`;
    - o fluxo do pedido: chamar `consultar_cliente` no começo; para cliente que já pediu, oferecer "o de sempre"; para cliente novo, pedir nome e endereço completo e perguntar se tem botijão vazio; perguntar o pagamento (e o troco, se for dinheiro); `preparar_pedido` → mostrar o resumo → esperar o "sim" → `confirmar_pedido`; informar o número e a previsão (ou a abertura, se agendado);
    - o Gás do Povo: o que ter em mãos, a taxa, nunca pedir CPF, senha ou código e, se o cliente mandar, orientar a mostrar só ao entregador; os canais oficiais (app Meu Social, Disque Social 121, gasdopovo.caixa.gov.br); nunca dizer se a pessoa tem direito;
    - status: consultar e responder com o status real;
    - reclamações: ser educado, chamar `alertar_dono` e continuar atendendo;
    - pedido para parar os lembretes: `desativar_lembretes`;
    - mensagens marcadas `(mensagem do dono da revenda)` foram escritas pelo dono e devem ser respeitadas;
    - nunca prometer promoção, prazo ou regra fora dos dados.
  - `buildHistory(msgs: StoredMessage[]): Anthropic.Beta.BetaMessageParam[]`:
    - cliente → `user`; bot → `assistant`; dono → `assistant` com o prefixo `(mensagem do dono da revenda) `; `sistema` → `user` entre colchetes;
    - junta mensagens consecutivas do mesmo papel com `\n`;
    - se a primeira for `assistant`, insere antes um `user` `[conversa iniciada pela revenda]`;
    - se a última não for `user`, devolve `[]` (não há nada a responder).
  - `extractReply(m: Anthropic.Beta.BetaMessage): string | null`: junta os blocos `text`; `null` se vazio ou se `stop_reason === 'refusal'`.
  - `createAgent(d: { client: Anthropic; model: string; effort: 'low'|'medium'|'high'; db; makeContext(clienteId: number): ToolContext; clock })` → `{ reply(clienteId: number): Promise<string | null> }`. Chama `client.beta.messages.toolRunner({ model, max_tokens: 16000, system: SYSTEM_PROMPT, tools: buildTools(ctx), messages: buildHistory(recentMessages(db, clienteId, now − 24h)), output_config: { effort }, cache_control: { type: 'ephemeral' }, max_iterations: 10 })` e devolve `extractReply`. Sem `temperature` e sem `thinking: disabled`.
  - `createCustomerTurnHandler(d: { db; agent; outbox; alerts; clock })` → `(clienteId) => Promise<void>`:
    - com resposta: `outbox.send({ telefone, texto })` + `insertMessage(autor 'bot')`;
    - resposta `null` ou exceção da API: envia `Desculpa, tive um probleminha aqui. Já avisei a revenda e logo alguém te responde.` + `alerts.create({ motivo: 'Bot não conseguiu responder', … })`, no máximo uma vez a cada 10 min por cliente.

- [ ] **Step 1: Write the failing tests**

```ts
test('buildHistory junta, marca dono e começa com user', () => {
  const h = buildHistory([m('bot', 'Lembrete...'), m('cliente', 'sim'), m('cliente', 'pode mandar'), m('dono', 'Oi, aqui é o Zé')]);
  expect(h).toEqual([]); // termina em assistant → nada a responder
  const h2 = buildHistory([m('bot', 'Lembrete...'), m('cliente', 'sim'), m('cliente', 'pode mandar')]);
  expect(h2[0]).toEqual({ role: 'user', content: '[conversa iniciada pela revenda]' });
  expect(h2.at(-1)).toEqual({ role: 'user', content: 'sim\npode mandar' });
});
test('extractReply ignora refusal', () => { /* stop_reason 'refusal' → null */ });
test('turno com falha avisa cliente e alerta dono uma vez', async () => { /* agent.reply lança 2x em 5 min → desculpa enviada nas 2 vezes, alerts.listOpen() length 1 */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `prompt.ts` e `agent.ts`. Verificar no SDK instalado o nome exato da opção de limite de iterações do `toolRunner` (`max_iterations`).
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: agente Claude de atendimento`

---

### Task 12: Áudio e comprovante Pix

**Files:**
- Create: `src/audio/transcriber.ts`, `src/inbound/media.ts`
- Test: `tests/audio/transcriber.test.ts`, `tests/inbound/media.test.ts`

**Interfaces:**
- Consumes: `WhatsAppApi.downloadMedia/uploadMedia/sendMedia`, `openOrdersFor`, `orderRecipients`, `defaultContentToText`
- Produces:
  - `interface Transcriber { transcribe(audio: Buffer, mime: string): Promise<string> }`
  - `createOpenAITranscriber(o: { apiKey: string; model: string; fetch?: typeof fetch }): Transcriber`: POST multipart em `https://api.openai.com/v1/audio/transcriptions` com `file`, `model` e `language=pt`. Devolve `.text`. Status não-2xx lança.
  - `createContentToText(d: { db; api: WhatsAppApi; transcriber: Transcriber; outbox })` → a função `contentToText` do `RouterDeps`:
    - **áudio**: baixa e transcreve → `{ tipo: 'audio', texto }`. Se falhar, envia ao cliente `Não consegui ouvir seu áudio 😕 Pode escrever pra mim?`, grava `[áudio não transcrito]` e devolve `null` (sem turno da IA).
    - **imagem/documento** com pedido em aberto `pix_antecipado`: baixa, faz `uploadMedia` e `sendMedia` para cada destinatário do pedido, com a legenda `Comprovante Pix do pedido #N`. Devolve `{ tipo, texto: '[cliente enviou comprovante Pix; repassado ao pedido #N]' }`.
    - **demais**: `defaultContentToText`.

- [ ] **Step 1: Write the failing tests**: `transcriber envia multipart com language=pt`; `áudio vira texto transcrito`; `falha na transcrição pede para escrever e devolve null`; `comprovante é repassado aos destinatários do pedido pix_antecipado` (`fake.sent` com `kind 'image'` e legenda `#1`).
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: transcrição de áudio e repasse de comprovante Pix`

---

### Task 13: Lembretes de recompra e tarefas agendadas

**Files:**
- Create: `src/domain/reminders.ts`, `src/jobs/scheduler.ts`
- Test: `tests/domain/reminders.test.ts`, `tests/jobs/scheduler.test.ts`

**Interfaces:**
- Consumes: `deliveredOrderDates`, `openOrdersFor`, `listCustomers`, `updateCustomer`, `outbox`, `insertMessage`, `OrderService.releaseScheduled`, `isOpen`, `localHour`, `formatBRL`
- Produces:
  - `nextReorderDate(datas: Date[]): Date | null`: com ≥2 datas, devolve a última + a média dos intervalos; senão `null`.
  - `dueForReminder(i: { entregas: Date[]; ultimoLembreteEm: Date | null; temPedidoAberto: boolean; lembretesDesativados: boolean }, now: Date, margemDias = 2): boolean`. É `true` só se não estiver desativado, não houver pedido aberto, houver ≥2 entregas, `now ≥ próxima − margemDias` e `ultimoLembreteEm` for nulo ou anterior à última entrega.
  - `REMINDER_TEXT(nome: string|null, preco: string): string` = `Oi{, nome}! Pelo seu histórico, seu gás deve estar acabando nos próximos dias 🔥 Quer que eu já mande um P13 ({preco})? Responda "sim" que eu preparo o pedido.`
  - `runReminderJob(d: { db; outbox; settings; templateLembrete?: string; clock }): Promise<number>`:
    - só roda se `lembretesAtivos`, `isOpen` e a hora local estiver entre 9 e 11;
    - para cada cliente com `dueForReminder`: envia o texto com o modelo (`[nome ou 'tudo bem', preço]`), grava `autor 'bot'` com o texto e atualiza `ultimoLembreteEm`;
    - envio que falhar não atualiza nada;
    - devolve quantos lembretes enviou.
  - `startScheduler(d: { orders: OrderService; reminders: () => Promise<number>; clock; intervalMs = 60_000 }): () => void`: a cada intervalo, chama `orders.releaseScheduled(now)` e `reminders()`, captura erros e devolve uma função de parada.

- [ ] **Step 1: Write the failing tests**

```ts
test('próxima recompra pela média', () => expect(nextReorderDate([d('2026-09-01'), d('2026-10-01'), d('2026-10-29')])?.toISOString().slice(0, 10)).toBe('2026-11-28'));
test('1 entrega não gera lembrete', () => expect(dueForReminder({ entregas: [d('2026-10-01')], ultimoLembreteEm: null, temPedidoAberto: false, lembretesDesativados: false }, d('2026-11-30'))).toBe(false));
test('dentro da margem gera; já lembrado neste ciclo não', () => { /* entregas 09-01, 10-01 → próxima 10-31; now 10-29 → true; ultimoLembreteEm 10-29 → false */ });
test('job respeita janela das 9–11 e desligado', async () => { /* 14h local → 0; lembretesAtivos false → 0; 10h → 1 e fake.sent[0] template quando janela fechada */ });
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: lembretes de recompra e tarefas agendadas`

---

### Task 14: Painel — login, pedidos de hoje e alertas

**Files:**
- Create: `src/panel/auth.ts`, `src/panel/routes-orders.ts`, `src/panel/views/layout.eta`, `login.eta`, `pedidos.eta`, `alertas.eta`, `src/panel/public/style.css`
- Modify: `src/server.ts` (registra o painel via `registerPanel`)
- Test: `tests/panel/orders.test.ts`

**Interfaces:**
- Consumes: `OrderService`, `listOrdersByLocalDay`, `AlertService`, `getCustomer`, `formatBRL`
- Produces:
  - `PanelDeps { db; env: Env; orders: OrderService; alerts: AlertService; outbox; settings: () => StoreSettings; clock }`
  - `registerPanel(app, deps)`. Registra @fastify/view (eta), formbody, cookie e static (`/static`), e as rotas:
    - `GET /login` e `POST /login`: compara `PANEL_PASSWORD` com `timingSafeEqual`. Certo → cookie assinado `sessao` (httpOnly, sameSite lax, 30 dias) e redireciona para `/painel/pedidos`. Errado → 401 com a página de login e um erro.
    - `POST /logout`.
    - Toda rota `/painel/*` sem sessão válida redireciona (302) para `/login`.
  - `GET /painel/pedidos?status=`: pedidos do dia local, do mais novo ao mais antigo. Mostra número, cliente, pagamento, total, status (cor por status) e o selo "Pix conferir" / "Gás do Povo" / "Revisar". Cada linha tem formulários para `saiu`/`entregue`/`retirado` (conforme o tipo) e `cancelar`. A lista é atualizada por htmx a cada 10s.
  - `POST /painel/pedidos/:id/status` (`status=saiu|entregue|retirado|cancelado`): cancelado → `orders.cancel(id, 'dono')`; o resto → `setStatus`; `InvalidTransitionError` → mensagem de erro. Redireciona de volta.
  - `GET /painel/alertas`: alertas abertos com motivo, resumo, data, link `/painel/conversas/:clienteId` e botão "Resolvido". `POST /painel/alertas/:id/resolver`.
  - O layout tem a navegação (Pedidos · Clientes · Conversas · Alertas (n) · Configurações), CSS simples que funciona bem no celular e htmx por CDN.

- [ ] **Step 1: Write the failing tests**: `sem sessão redireciona para /login`; `senha errada → 401`; `login certo → cookie e lista mostra '#1'`; `POST status saiu atualiza o pedido`; `transição inválida mostra erro e não muda status`; `resolver tira alerta da lista`. Usar `app.inject` e um helper `login(app)`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: painel com login, pedidos do dia e alertas`

---

### Task 15: Painel — clientes, conversas e configurações

**Files:**
- Create: `src/panel/routes-customers.ts`, `src/panel/routes-conversations.ts`, `src/panel/routes-config.ts`, as views `clientes.eta`, `cliente.eta`, `conversas.eta`, `conversa.eta`, `conversa-mensagens.eta`, `config.eta`
- Modify: `src/store/customers.ts` (+ `deleteCustomerData`), `src/panel/auth.ts` (registra as novas rotas)
- Test: `tests/panel/customers.test.ts`, `tests/panel/conversations.test.ts`, `tests/panel/config.test.ts`

**Interfaces:**
- Consumes: `PanelDeps`, `listCustomers`, `getCustomer`, `updateCustomer`, `recentMessages`, `insertMessage`, `deliveredOrderDates`, `nextReorderDate`, `outbox`, `getSettings`, `updateSettings`
- Produces:
  - `deleteCustomerData(db, id): void` (LGPD): apaga mensagens, rascunhos e alertas do cliente. Nos pedidos, zera `endereco_json`. No cliente, troca o telefone por `excluido-{id}` e zera nome e endereço.
  - `GET /painel/clientes` (busca por nome/telefone); `GET /painel/clientes/:id` (dados, endereço, histórico de pedidos, próxima recompra prevista, lembretes ligados/desligados); `POST /painel/clientes/:id/excluir` (confirmação no form).
  - `GET /painel/conversas`: clientes ordenados pela última mensagem, com o indicador "bot pausado".
  - `GET /painel/conversas/:id`: histórico (cliente/bot/dono com cores diferentes, transcrição de áudio marcada 🎤), botões "Pausar bot" / "Devolver ao bot" e campo de resposta. A área de mensagens (`GET /painel/conversas/:id/mensagens`, fragmento) é atualizada por htmx a cada 5s.
  - `POST /painel/conversas/:id/responder` (`texto`): `outbox.send({ telefone, texto })` sem modelo.
    - `fora_da_janela` → mostra `O cliente não fala com o bot há mais de 24h. O WhatsApp só permite responder depois que ele mandar uma mensagem.` e não grava nada.
    - Sucesso → `insertMessage(autor 'dono')` e `botPausadoAte = now + 2h`.
  - `POST /painel/conversas/:id/pausar` → `botPausadoAte = now + 2h`; `POST /painel/conversas/:id/devolver` → `null`.
  - `GET/POST /painel/config`: formulário com todos os campos de `StoreSettings`.
    - Preços em reais (`115,00`), convertidos para centavos.
    - Horários: um par abre/fecha por dia, com a opção "fechado".
    - Bairros: um por linha.
    - Entregadores: `Nome; telefone`, um por linha.
    - Pagamentos: checkboxes.
    - Gás do Povo: aceita, modalidade e taxa.
    - Lembretes ligados/desligados.
    - Erro de validação → mostra as mensagens e mantém o que foi digitado. Sucesso → `Configurações salvas`.

- [ ] **Step 1: Write the failing tests**: `responder dentro da janela envia, grava autor dono e pausa 2h`; `responder fora da janela mostra aviso e não grava`; `devolver ao bot zera pausa`; `config salva preço '115,00' como 11500 e bairros por linha`; `config inválida (abre>fecha) mostra erro sem salvar`; `excluir cliente apaga mensagens e anonimiza`; `cliente mostra próxima recompra`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: painel com clientes, conversas e configurações`

---

### Task 16: Wiring, README e roteiro de conversas de teste

**Files:**
- Create: `src/main.ts`, `README.md`, `scripts/eval-conversas.ts`
- Test: `tests/main.test.ts`

**Interfaces:**
- Consumes: tudo acima
- Produces:
  - `createAppContext(env: Env, overrides?: { api?: WhatsAppApi; anthropic?: Anthropic; transcriber?: Transcriber; clock?: () => Date })`: monta db → outbox → alerts → dispatcher → orders → staff handler → agent → turn handler → router (`debounceMs: 2500`, `isStaff` via `isStaffPhone`, `hasGasDoPovoContext` = rascunho recente do Gás do Povo **ou** pedido aberto com `gas_do_povo`). Devolve `{ app, stopScheduler }`.
  - `main.ts`: `loadEnv()`, `createAppContext`, `startScheduler`, `app.listen({ port, host: '0.0.0.0' })`, encerramento limpo no SIGTERM.
  - `README.md` (PT):
    - passo a passo da Meta: app, número de teste, número definitivo, webhook (`/webhook`), verify token, app secret, token permanente de usuário de sistema;
    - os **4 modelos de mensagem** para submeter (nome sugerido, categoria Utilidade, texto com `{{1}}`/`{{2}}`): `pedido_novo` (entregadores), `status_pedido` (cliente), `alerta_dono`, `lembrete_recompra` (Marketing, com o botão de resposta rápida "Sim, pode mandar");
    - variáveis de ambiente; como rodar (`npm run dev`, `npm test`); como trocar o modelo (`AI_MODEL`); deploy em VPS pequena com HTTPS (Caddy) e backup do arquivo SQLite.
  - `scripts/eval-conversas.ts` (`npx tsx scripts/eval-conversas.ts`): roda cenários com **Claude real**, banco `:memory:`, `FakeWhatsApp` e relógio fixo numa segunda às 10h. Imprime as conversas e marca PASSOU/FALHOU em cada verificação. Cenários:
    1. cliente novo pede "manda um gás", dá endereço no Centro e paga em dinheiro com troco para 200 → 1 pedido, total = preço configurado, troco 20000;
    2. cliente antigo diz "o de sempre" → o resumo usa o endereço salvo;
    3. preço não cadastrado + "quanto tá o gás?" → nenhum valor em R$ inventado na resposta + 1 alerta;
    4. bairro fora da área → nenhum pedido criado;
    5. Gás do Povo com o cliente mandando "482913" → o modelo nunca recebe o código (verificar as mensagens gravadas) e a resposta orienta a mostrar o código ao entregador;
    6. reclamação de atraso → alerta criado e o bot continua respondendo.

- [ ] **Step 1: Write the failing test**: `createAppContext sobe e responde /healthz`; `fluxo ponta a ponta com fakes` (agent falso que devolve um texto fixo → webhook assinado → `FakeWhatsApp.sent` contém a resposta depois de `router.idle()`).
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `main.ts`, `README.md`, `scripts/eval-conversas.ts`
- [ ] **Step 4: Run `npx vitest run` e `npx tsc --noEmit`** → tudo PASS, sem erros de tipo
- [ ] **Step 5: Run `npx tsx scripts/eval-conversas.ts`** com `ANTHROPIC_API_KEY` (custo de centavos com o Haiku) → os 6 cenários PASSOU. Uma falha aqui é ajustada no `SYSTEM_PROMPT` ou nas descrições das ferramentas, não nos testes.
- [ ] **Step 6: Commit** `feat: wiring, README de implantação e roteiro de conversas de teste`
