# Chatbot de pedidos de gás pelo WhatsApp

Guia de implantação para quem vai colocar o bot no ar. O dono da revenda só usa o painel; tudo aqui é com o desenvolvedor.

## 1. O que é

Um serviço Node.js/TypeScript único que:

- recebe mensagens pelo webhook da **Cloud API oficial do WhatsApp (Meta)**;
- conversa com o cliente usando o Claude (Anthropic), com ferramentas para consultar a loja, o cliente e os pedidos;
- transcreve áudios (OpenAI) e trata o texto como mensagem normal;
- manda o pedido confirmado aos entregadores (ou ao dono) e repassa `saiu` / `entregue` / `problema` ao cliente;
- envia lembretes de recompra e alertas ao dono;
- serve um painel web (login por senha) com pedidos do dia, clientes, conversas, alertas e configurações.

Banco: SQLite em um único arquivo. Preço, horários, bairros, pagamentos, chave Pix e regras do Gás do Povo vêm só do painel; nada disso fica no código nem no prompt.

## 2. Requisitos

- Node.js **22 ou mais novo** (desenvolvido e testado no 24).
- Conta Meta Business com acesso à WhatsApp Cloud API e um número dedicado ao bot.
- Chave da API da Anthropic e chave da API da OpenAI (só para transcrição de áudio, modelo `whisper-1`).
- Um domínio com HTTPS público (a Meta só chama webhooks HTTPS).

## 3. Como rodar e testar

```bash
npm install
cp .env.example .env      # preencha os valores (seção 4)
npm run dev               # tsx watch, lê o .env; sobe em http://localhost:3000
npm test                  # vitest; nenhum teste chama Meta, Anthropic ou OpenAI
npx tsc --noEmit          # checagem de tipos
```

Produção:

```bash
npm run build             # gera dist/ (copia migrações, views e CSS)
npm start                 # node dist/main.js (lê só variáveis de ambiente, não o .env)
```

O endpoint `GET /healthz` responde `{"ok":true}`.

### Roteiro de conversas com o Claude real

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/eval-conversas.ts
```

Roda 6 cenários (pedido novo com troco, "o de sempre", preço não cadastrado, bairro fora da área, código do Gás do Povo, reclamação de atraso) contra o modelo real, com banco em memória, WhatsApp falso e relógio fixo numa segunda às 10h. Imprime cada conversa e marca PASSOU/FALHOU. Custa centavos com o Haiku. Rode de novo sempre que mudar o prompt, as ferramentas ou o modelo (`AI_MODEL`).

## 4. Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | não | `3000` | Porta HTTP. |
| `DB_PATH` | não | `data/revgas.db` | Arquivo SQLite (a pasta é criada se não existir). |
| `PUBLIC_URL` | sim | | URL pública, ex.: `https://bot.suarevenda.com.br`. Vai nos links dos alertas e decide o cookie `secure` do painel. |
| `WA_TOKEN` | sim | | Token permanente do usuário de sistema (seção 5). |
| `WA_PHONE_NUMBER_ID` | sim | | ID do número de telefone (não é o telefone). |
| `WA_APP_SECRET` | sim | | Segredo do app Meta; valida a assinatura `X-Hub-Signature-256` do webhook. |
| `WA_VERIFY_TOKEN` | sim | | Texto qualquer que você inventa; a Meta o devolve na verificação do webhook. |
| `WA_GRAPH_VERSION` | não | `v23.0` | Versão da Graph API. |
| `WA_TPL_PEDIDO` | **sim, em produção** | | Nome do modelo `aviso_pedido` aprovado. Sem ele, o pedido só chega a entregador ou dono que falou com o bot nas últimas 24 h. |
| `WA_TPL_STATUS` | fortemente recomendada | | Nome do modelo `status_pedido`. Sem ele, o cliente só recebe "saiu"/"entregue" se falou com o bot nas últimas 24 h. |
| `WA_TPL_ALERTA` | **sim, em produção** | | Nome do modelo `alerta_dono`. Sem ele, os alertas só chegam ao dono se ele falou com o bot nas últimas 24 h. |
| `WA_TPL_LEMBRETE` | fortemente recomendada | | Nome do modelo `lembrete_recompra`. Sem ele, quase nenhum lembrete de recompra sai. |
| `ANTHROPIC_API_KEY` | sim | | Chave da API da Anthropic. |
| `AI_MODEL` | não | `claude-haiku-5-5` | Modelo de conversa (seção 7). |
| `AI_EFFORT` | não | `medium` | `low`, `medium` ou `high`. |
| `OPENAI_API_KEY` | sim | | Transcrição de áudio. |
| `TRANSCRIBE_MODEL` | não | `whisper-1` | Modelo de transcrição. |
| `PANEL_PASSWORD` | sim | | Senha única do painel (o dono), com 12 caracteres ou mais. Depois de 5 senhas erradas em 15 minutos, o mesmo IP fica bloqueado até a janela passar. |
| `SESSION_SECRET` | sim | | String aleatória com 32 caracteres ou mais; assina o cookie de sessão. |

Variável vazia conta como ausente. Sem os `WA_TPL_*`, o bot só consegue escrever dentro da janela de 24 horas de quem falou por último com ele; os modelos cobrem o resto (seção 6). O app sobe sem eles (útil no desenvolvimento), mas avisa no log, para cada modelo ausente, o que deixa de funcionar, e a página **Configurações** do painel mostra o mesmo aviso ao dono.

Chamadas à Meta e à OpenAI abortam após 20 s e a Anthropic após 60 s (com 2 novas tentativas).

## 5. Passo a passo na Meta

1. Em [developers.facebook.com](https://developers.facebook.com), crie um **app** do tipo Empresa e adicione o produto **WhatsApp**. Vincule ao Meta Business da revenda (comece cedo a verificação da empresa, que pede CNPJ).
2. **Número de teste**: em *WhatsApp > Configuração da API* a Meta já dá um número de teste. Cadastre seu celular como destinatário e use `WA_PHONE_NUMBER_ID` desse número para desenvolver. O token temporário dura 24 h; serve só para os primeiros testes.
3. **Número definitivo**: em *Números de telefone > Adicionar*, cadastre um número novo dedicado ao bot. Ele não pode estar ativo no app WhatsApp normal. Anote o novo *Phone number ID* e troque no `.env`.
4. **Webhook**: em *WhatsApp > Configuração*, clique em *Editar* no Webhook.
   - URL de callback: `https://SEU-DOMINIO/webhook`
   - Token de verificação: o mesmo valor de `WA_VERIFY_TOKEN`.
   - O serviço precisa estar no ar antes de clicar em *Verificar e salvar*.
   - Depois assine o campo **messages**.
5. **App secret**: *Configurações do app > Básico > Chave secreta do app*. É o `WA_APP_SECRET`. Sem a assinatura correta o webhook responde 401.
6. **Token permanente**: em *Business Settings > Usuários > Usuários do sistema*, crie um usuário (Admin), atribua o app e a conta do WhatsApp Business com controle total, e gere um token com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`, sem expiração. É o `WA_TOKEN`.
7. **Modelos de mensagem**: submeta os 4 modelos da seção 6 em *WhatsApp > Modelos de mensagem*, idioma **Português (BR)**. Quando forem aprovados, coloque os nomes nas variáveis `WA_TPL_*`.
8. **Entregadores e dono precisam falar com o bot primeiro** (ou receber por modelo): a API só aceita texto livre dentro de 24 h da última mensagem da pessoa. Peça a cada um para mandar um "oi" ao número do bot; os `WA_TPL_*` cobrem o resto.

Observação: a Cloud API não participa de grupos. O pedido vai individualmente para cada entregador cadastrado (ou para o dono, conforme a configuração), e cada um responde no privado.

## 6. Modelos de mensagem

Todos em português (BR). O código manda sempre o corpo (`body`) com parâmetros de texto; quebras de linha e espaços repetidos são trocados por ` · ` ou espaço antes do envio (a Meta rejeita quebras em parâmetros). A Meta também rejeita modelo que começa ou termina com variável, por isso o texto sugerido tem frase antes e depois.

| Variável | Nome sugerido | Categoria |
|---|---|---|
| `WA_TPL_PEDIDO` | `aviso_pedido` | Utilidade |
| `WA_TPL_STATUS` | `status_pedido` | Utilidade |
| `WA_TPL_ALERTA` | `alerta_dono` | Utilidade |
| `WA_TPL_LEMBRETE` | `lembrete_recompra` | Marketing |

### `aviso_pedido` (entregadores e dono)

Parâmetros, nesta ordem:
- `{{1}}`: a mensagem completa em uma linha, com as linhas originais unidas por ` | `. Num pedido novo: número, quantidade e valor, pagamento e troco, cliente, endereço (ou `RETIRADA NA LOJA`) e a instrução de resposta. Numa correção ou cancelamento: o aviso correspondente.

Texto sugerido:

```
Aviso de pedido: {{1}} (mensagem automática do bot de pedidos)
```

O mesmo modelo serve para pedido novo, retirada, correção e cancelamento, por isso o texto fixo é neutro: não diga "novo pedido" nem "para entrega" nele. A instrução de resposta já vem dentro do `{{1}}` quando se aplica. A frase depois da variável existe porque a Meta rejeita modelo que termina com variável.

### `status_pedido` (cliente)

Parâmetros:
- `{{1}}`: nome do cliente (ou `cliente` se não houver nome).
- `{{2}}`: frase do status, ex.: `seu gás saiu para entrega com João. Chega em poucos minutos.` ou `seu pedido foi entregue. Obrigado! Quando precisar de novo, é só chamar aqui.`

Texto sugerido:

```
Olá, {{1}}! Atualização do seu pedido: {{2}} Qualquer dúvida, é só responder esta mensagem.
```

### `alerta_dono` (dono)

Parâmetros:
- `{{1}}`: motivo do alerta (ex.: `Problema na entrega`).
- `{{2}}`: detalhes unidos por ` | `: resumo, `Cliente: nome (telefone)`, `Pedido #N` e o link da conversa no painel (quando houver cada parte).

Texto sugerido:

```
Alerta do bot de pedidos: {{1}}. Detalhes: {{2}} (mensagem automática, não precisa responder)
```

### `lembrete_recompra` (cliente, Marketing)

Parâmetros:
- `{{1}}`: nome do cliente (ou `tudo bem` se não houver nome, para a frase "Oi, tudo bem!").
- `{{2}}`: preço da recarga já formatado, ex.: `R$ 115,00`.

Texto sugerido:

```
Oi, {{1}}! Pelo seu histórico, seu gás deve estar acabando nos próximos dias. Quer que eu já mande um P13 por {{2}}? Toque no botão abaixo e eu preparo o pedido.
```

Botões (resposta rápida): **Sim, pode mandar** e **Ainda não**. O toque chega ao bot como uma mensagem de texto com o rótulo do botão, e a IA segue o fluxo a partir daí (inclusive "não quero mais lembretes").

## 7. Trocar o modelo de IA

O modelo vem de `AI_MODEL`; nenhum outro arquivo fixa o ID.

| Modelo | Quando usar | Custo aproximado por pedido |
|---|---|---|
| `claude-haiku-5-5` (padrão) | Uso normal, mais barato | ~R$ 0,02 |
| `claude-sonnet-5-5` | Se o Haiku errar em conversas reais | ~R$ 0,25 |
| `claude-opus-5-5` | Caso extremo | ~R$ 0,50 |

(Valores estimativos do projeto; confira a tabela de preços da Anthropic.) Para trocar: altere `AI_MODEL` no `.env`, reinicie o serviço e rode `npx tsx scripts/eval-conversas.ts` para conferir os 6 cenários. `AI_EFFORT` (`low`/`medium`/`high`) controla o quanto o modelo raciocina; mais alto custa mais e demora mais.

## 8. Implantação em VPS (Caddy + systemd)

Uma VPS pequena (1 vCPU, 1 GB) basta. Exemplo para Ubuntu/Debian com o domínio `bot.suarevenda.com.br` apontando para o IP da VPS.

### Aplicação

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin revgas
# instale Node 22+ (NodeSource ou nvm do usuário revgas)
sudo -u revgas git clone <repositorio> /opt/revgas
cd /opt/revgas && sudo -u revgas npm ci && sudo -u revgas npm run build
sudo install -m 600 -o revgas /dev/null /etc/revgas.env   # preencha com as variáveis da seção 4
```

`/etc/revgas.env` usa o formato `CHAVE=valor`, uma por linha, sem aspas. Use `DB_PATH=/var/lib/revgas/revgas.db` e `PORT=3000`.

### systemd: `/etc/systemd/system/revgas.service`

```ini
[Unit]
Description=Chatbot de pedidos de gas
After=network-online.target
Wants=network-online.target

[Service]
User=revgas
WorkingDirectory=/opt/revgas
EnvironmentFile=/etc/revgas.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
StateDirectory=revgas
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now revgas
journalctl -u revgas -f
```

`NODE_ENV=production` liga o log de requisições (método, URL e status; nunca o corpo das mensagens). No `systemctl stop`/`restart` o serviço recebe SIGTERM, para as tarefas agendadas, fecha o servidor e o banco e sai.

### Caddy (HTTPS automático): `/etc/caddy/Caddyfile`

```
bot.suarevenda.com.br {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
curl https://bot.suarevenda.com.br/healthz
```

Abra só as portas 80 e 443 no firewall; a 3000 fica restrita ao localhost.

### Backup do SQLite

O banco usa modo WAL; **não copie o arquivo com `cp` com o serviço rodando**. Use o backup online do SQLite:

```bash
# /etc/cron.d/revgas-backup  (todo dia às 3h; mantém 14 dias)
0 3 * * * revgas sqlite3 /var/lib/revgas/revgas.db ".backup '/var/backups/revgas/revgas-$(date +\%F).db'" && find /var/backups/revgas -name 'revgas-*.db' -mtime +14 -delete
```

Crie `/var/backups/revgas` com dono `revgas` e envie as cópias para fora da VPS (rclone, S3 ou outro disco). O arquivo contém telefones, endereços e conversas dos clientes: trate como dado pessoal (LGPD) e proteja o acesso.

## 9. Primeiros passos no painel

Acesse `https://SEU-DOMINIO/login` com `PANEL_PASSWORD`. Antes de ligar o número definitivo, em **Configurações**:

1. **Preços** da recarga (P13 com troca) e do botijão completo. Com preço zero o bot não informa valor e avisa o dono.
2. **Horários** de funcionamento por dia. Pedidos fora do horário ficam agendados para a abertura.
3. **Bairros atendidos**. Bairro fora da lista não gera pedido.
4. **Formas de pagamento** aceitas e a chave Pix (necessária para o Pix antecipado).
5. **Telefone do dono** (recebe os alertas) e **entregadores** (nome e telefone com DDI+DDD, ex.: `5586999990000`), mais o destino dos pedidos (entregadores ou só o dono).
6. **Gás do Povo**: se a revenda aceita, a modalidade (entrega ou retirada) e a taxa.
7. Previsão de entrega e o liga/desliga dos lembretes.

Depois faça um pedido de teste de ponta a ponta com o número de teste da Meta (pedido, `saiu`, `entregue`) e só então troque para o número definitivo. Para assumir uma conversa, use a aba **Conversas** (pausa o bot só para aquele cliente).

## 10. Limitações conhecidas da v1

- Sem mapa nem rastreamento ao vivo do entregador; o status é em etapas (recebido, saiu, entregue).
- Sem integração com a RevGás: o entregador continua registrando a venda e emitindo nota por lá.
- Sem confirmação automática de Pix: o bot manda a chave e repassa o comprovante, mas quem confere é uma pessoa.
- O bot não valida o direito ao Gás do Povo (só a maquininha da Caixa valida).
- Uma única instância: o estado de debounce das mensagens e a trava de confirmação ficam em memória, e o SQLite é um arquivo local. Não rode duas réplicas.
- Só botijão P13; sem outros produtos nem várias lojas.
- Sem grupos de WhatsApp (limite da Cloud API): os pedidos vão para cada entregador no privado.
- Histórico de clientes e pedidos começa do zero (sem importação).
