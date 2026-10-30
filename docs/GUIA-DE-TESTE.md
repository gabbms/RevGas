# Guia de teste do chatbot (para rodar na sua máquina)

Escrito para quem nunca subiu um servidor. Cada etapa diz **o que é**, **por que precisa** e **o comando exato**.
Faça na ordem: cada etapa só depende das anteriores, e você pode parar em qualquer uma.

| Etapa | O que prova | Custo | Tempo |
|---|---|---|---|
| 1. Testes automáticos | A lógica do código está certa | R$ 0 | 5 min |
| 2. Teste com o Claude real | A IA conversa e monta pedidos direito | centavos | 15 min |
| 3. Rodar o bot e abrir o painel | O sistema sobe e você consegue configurá-lo | R$ 0 | 20 min |
| 4. WhatsApp de verdade | Mensagens reais indo e voltando | R$ 0 (número de teste da Meta) | 1–2 h |
| 5. Servidor de produção | Bot no ar 24 h | de R$ 0 a ~R$ 30/mês | depende |

---

## Etapa 0 – Preparar a máquina

### O que você precisa ter instalado

1. **Node.js 22 ou mais novo.** É o programa que executa o código do bot. Na sua máquina já está o 24, então está pronto.
2. **Git.** Já instalado (você já deu push).

Para conferir, abra o **PowerShell** (tecla Windows, digite "PowerShell", Enter) e rode:

```powershell
node -v
git --version
```

Se aparecer um número de versão nos dois (ex.: `v24.22.1`), está tudo certo.

### Baixar o código atualizado

No PowerShell, entre na pasta do projeto (as aspas são necessárias por causa do acento em "Gás"):

```powershell
cd "C:\Users\Gabriel\Desktop\Rev-Gás"
git checkout main
git pull
```

- `cd` = "entrar numa pasta".
- `git checkout main` = trocar para o branch principal.
- `git pull` = baixar o que mudou no GitHub (o merge que você fez).

### Instalar as dependências

```powershell
npm install
```

O `npm` vem junto com o Node. Esse comando lê o arquivo `package.json` e baixa para a pasta `node_modules` todas as bibliotecas que o bot usa. Só precisa repetir se o `package.json` mudar.

---

## Etapa 1 – Testes automáticos (`npm test`)

```powershell
npm test
```

**O que acontece:** o vitest roda 352 testes. Cada teste simula uma situação (cliente pede gás, entregador responde "saiu", comprovante Pix chega...) usando um WhatsApp falso e uma IA falsa, e confere o resultado. Nada é enviado de verdade e nada é cobrado.

**Resultado esperado**, no final:

```
 Test Files  31 passed (31)
      Tests  352 passed (352)
```

**Se algum teste falhar:** copie a mensagem de erro e me mande.

Para conferir também se o TypeScript (a linguagem do código) está sem erros de tipo:

```powershell
npx tsc --noEmit
```

Sem nenhuma saída = sem erros.

---

## Etapa 2 – Teste com o Claude real

Os testes da etapa 1 usam uma IA **falsa**. Aqui o bot conversa com o Claude de verdade, em 6 conversas ensaiadas. Ele confere, por exemplo, que a IA não inventa preço, monta o pedido certo e não guarda o código do Gás do Povo.

### 2.1 Pegar a chave de API da Anthropic

A **chave de API** é uma senha longa que identifica a sua conta quando o bot chama o Claude. É cobrado por uso.

1. Acesse **https://console.anthropic.com** e crie uma conta (ou entre). Atenção: é um site diferente do claude.ai (o chat).
2. Vá em **Settings → Billing** (Configurações → Cobrança) e adicione um cartão. Coloque um valor pequeno de crédito, como US$ 5. Isso dura muito tempo com o Haiku.
3. Vá em **Settings → API Keys** → **Create Key**. Dê um nome (ex.: `revgas-teste`).
4. **Copie a chave agora** (começa com `sk-ant-...`). Ela só aparece uma vez.

> **Cuidado:** a chave é como uma senha de cartão. Nunca cole em chat, e-mail, print ou no GitHub. Se vazar, apague a chave no console e crie outra.

### 2.2 Rodar o roteiro

No PowerShell, na pasta do projeto:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-COLE-SUA-CHAVE-AQUI"
npx tsx scripts/eval-conversas.ts
```

- A primeira linha guarda a chave **só nessa janela do PowerShell** (some quando você fechar). Por isso é seguro: nada fica salvo em arquivo.
- A segunda roda o roteiro.

**Resultado esperado:** para cada um dos 6 cenários, a conversa completa (CLIENTE / BOT) e linhas `PASSOU` ou `FALHOU` por verificação. No fim: `Todos os cenários PASSARAM.` ou `N verificação(ões) FALHARAM.` Se algo falhar, me mande a saída completa que eu ajusto o prompt da IA.

---

## Etapa 3 – Rodar o bot e abrir o painel

Ainda sem WhatsApp. Aqui você só vê o sistema subir e entra no painel que o dono da revenda usará.

### 3.1 Criar o arquivo `.env`

O `.env` guarda as configurações e senhas. O git **ignora** esse arquivo de propósito, então ele nunca vai para o GitHub.

```powershell
Copy-Item .env.example .env
notepad .env
```

No Bloco de Notas, preencha **estes** campos por enquanto (os do WhatsApp ficam para a etapa 4, mas o bot exige que não estejam vazios, então use valores provisórios):

```ini
PORT=3000
DB_PATH=data/revgas.db
PUBLIC_URL=http://localhost:3000

WA_TOKEN=provisorio
WA_PHONE_NUMBER_ID=provisorio
WA_APP_SECRET=provisorio
WA_VERIFY_TOKEN=revgas-verifica-123

ANTHROPIC_API_KEY=sk-ant-SUA-CHAVE
AI_MODEL=claude-haiku-5-5
AI_EFFORT=medium

OPENAI_API_KEY=provisorio

PANEL_PASSWORD=uma-senha-com-12-ou-mais-caracteres
SESSION_SECRET=troque-por-uma-string-aleatoria-com-32-caracteres-ou-mais-1234
```

Regras: `PANEL_PASSWORD` tem no mínimo 12 caracteres e `SESSION_SECRET` no mínimo 32. Não use espaços nem aspas nos valores. `OPENAI_API_KEY` só importa para áudios (veja o fim da etapa 4).

### 3.2 Subir o bot

```powershell
npm run dev
```

Deve aparecer algo como `Server listening at http://0.0.0.0:3000`, mais alguns avisos amarelos sobre modelos de mensagem ausentes (`WA_TPL_*`). Esses avisos são normais nesta fase. O terminal fica "preso" rodando; **não feche**. Para parar: `Ctrl + C`.

### 3.3 Abrir o painel

No navegador: **http://localhost:3000/painel**. Entre com a `PANEL_PASSWORD`. (`localhost` significa "esta própria máquina".)

Em **Configurações**, preencha o que o bot precisa para vender:
- preço da recarga e do botijão completo;
- horários de funcionamento;
- bairros atendidos e taxa de entrega;
- formas de pagamento aceitas e a chave Pix;
- **entregadores** (nome e telefone com DDI+DDD, ex.: `5586999990000`). Use o seu próprio número para ver o pedido chegar.

Sem isso o bot não tem preço para informar e vai chamar o dono em vez de vender.

---

## Etapa 4 – WhatsApp de verdade

Aqui entram três conceitos novos. Primeiro eles, depois o passo a passo.

### 4.1 O que é um "webhook" e por que precisa de túnel

Quando um cliente manda mensagem, **a Meta (dona do WhatsApp) é quem recebe**. Para o seu bot saber, a Meta faz uma chamada HTTP para um endereço seu, o **webhook**: "chegou isto, processa".

O problema: o seu PC fica atrás do roteador de casa, **sem endereço público**. A Meta não consegue chamar `localhost:3000`, porque `localhost` só existe dentro da sua máquina. Além disso, a Meta só aceita endereços **HTTPS**.

### 4.2 O que é ngrok / Cloudflare Tunnel

São serviços de **túnel**: um programa na sua máquina abre uma ligação com a internet e ganha um endereço público HTTPS (ex.: `https://abc-123.ngrok-free.app`). Tudo que chegar nesse endereço é repassado para o `localhost:3000` do seu PC.

```
Meta ──https──► endereço público do túnel ──► seu PC (localhost:3000)
```

- **ngrok**: o mais simples para começar. Conta grátis; o grátis dá **um endereço fixo** (domínio estático) por conta.
- **Cloudflare Tunnel**: grátis, mas para ter um endereço fixo exige um domínio próprio. Para começar, o modo "quick tunnel" dá um endereço aleatório que **muda a cada vez que você roda**.

**Recomendação para testar: ngrok.** Só serve para teste: se você desligar o PC, o bot sai do ar. Para operar de verdade use a etapa 5.

### 4.3 Instalar e abrir o túnel (ngrok)

1. Crie uma conta grátis em **https://ngrok.com**.
2. Baixe o ngrok para Windows pela página de download, ou no PowerShell: `winget install ngrok.ngrok`.
3. No painel do ngrok, copie o seu **authtoken** e rode uma vez:
   ```powershell
   ngrok config add-authtoken SEU_TOKEN
   ```
4. Com o bot rodando (`npm run dev` em uma janela), abra **outra** janela do PowerShell e rode:
   ```powershell
   ngrok http 3000
   ```
5. Vai aparecer uma linha `Forwarding https://alguma-coisa.ngrok-free.app -> http://localhost:3000`. Esse `https://...` é o seu endereço público. Deixe essa janela aberta.
6. Edite o `.env`: `PUBLIC_URL=https://alguma-coisa.ngrok-free.app`. Pare o bot (`Ctrl+C`) e rode `npm run dev` de novo.

### 4.4 Configurar a Meta (WhatsApp Cloud API)

O README tem o detalhe completo na seção 5. O caminho mínimo para teste:

1. Acesse **https://developers.facebook.com**, entre com sua conta Facebook e crie um **app** do tipo **Empresa**.
2. Dentro do app, adicione o produto **WhatsApp**.
3. Em **WhatsApp → Configuração da API** a Meta já entrega um **número de teste** grátis. Anote:
   - **Phone number ID** → `WA_PHONE_NUMBER_ID` no `.env`;
   - **Token de acesso temporário** → `WA_TOKEN` no `.env` (dura 24 h; amanhã gere outro).
4. Na mesma tela, em "Para", **cadastre o seu celular** como destinatário (a Meta manda um código de confirmação). O número de teste só conversa com até 5 números cadastrados. Cadastre também o celular que fará o papel de entregador.
5. Em **Configurações do app → Básico**, copie a **Chave secreta do app** → `WA_APP_SECRET` no `.env`.
6. Reinicie o bot (`Ctrl+C`, `npm run dev`) para ele ler o `.env` novo.
7. Em **WhatsApp → Configuração → Webhook → Editar**:
   - URL de callback: `https://alguma-coisa.ngrok-free.app/webhook`
   - Token de verificação: o mesmo valor de `WA_VERIFY_TOKEN` do `.env` (`revgas-verifica-123`)
   - Clique em **Verificar e salvar**. Se der erro, o bot não está rodando, o túnel não está aberto, ou o token está diferente.
   - Depois, em "Campos do webhook", clique em **Gerenciar** e **assine o campo `messages`**.

### 4.5 Testar uma conversa

Do seu celular, mande uma mensagem ao **número de teste** da Meta. Um roteiro bom:

1. "Oi, quero um gás" → o bot deve pedir o que falta (endereço, forma de pagamento) sem inventar preço.
2. Responda os dados e **confirme** o resumo com "sim". O pedido deve chegar ao celular que você cadastrou como entregador.
3. No celular do entregador, responda "saiu" e depois "entregue". O cliente deve receber os avisos.
4. Peça outro gás, escolha **Pix antecipado**, mande uma foto qualquer como comprovante. Ela deve chegar ao entregador.
5. Peça para **cancelar** um pedido, mande "quero falar com uma pessoa" (deve gerar alerta no painel), mande um **áudio**.
6. Olhe o painel (`/painel/pedidos`, `/painel/conversas`, `/painel/alertas`) e veja tudo registrado.

Observações importantes:
- O **primeiro contato** de cada telefone precisa partir dele: mande um "oi" do celular do entregador também. A Meta só deixa o bot escrever texto livre até 24 h depois da última mensagem da pessoa; fora disso exige "modelos" aprovados (README, seção 6), que você só precisa criar na etapa de produção.
- **Áudio** exige a `OPENAI_API_KEY` verdadeira (https://platform.openai.com/api-keys, com crédito pequeno). Sem ela, o bot pede para o cliente escrever. É opcional para o teste.

---

## Etapa 5 – Colocar no ar de verdade (servidor)

### Você precisa pagar uma VM?

**Para testar: não.** Seu PC + ngrok basta.
**Para operar: sim, de alguma forma**, porque o bot precisa estar ligado 24 h para receber pedidos, e o seu PC desliga. As opções, da mais simples à mais barata:

| Opção | Preço aproximado | Observação |
|---|---|---|
| **VPS pequena** (Hetzner, DigitalOcean, Contabo, Hostinger VPS, Locaweb) | R$ 20–40/mês | Você controla tudo. 1 GB de RAM e 1 vCPU bastam para uma revenda. Recomendado. |
| **Railway / Render / Fly.io** | US$ 5–10/mês | Mais fácil de configurar, mas precisa de disco persistente para o arquivo do banco (SQLite). |
| **PC da revenda ligado 24 h + Cloudflare Tunnel** | R$ 0 + energia | Funciona, mas cai se faltar luz ou internet. Só para começar. |

> Os preços mudam; confira nos sites. O bot é leve: **o custo grande é a IA** (centavos por conversa com o Haiku), não o servidor.

### O que é uma VPS

Um computador alugado, sempre ligado, num datacenter, com endereço de internet fixo. Você entra nele por **SSH** (um terminal remoto) e instala o bot como no seu PC.

### Resumo dos passos numa VPS (Ubuntu)

1. **Contratar** uma VPS com Ubuntu 24.04 e anotar o IP e a senha/chave.
2. **Domínio**: ter um domínio (ex.: `bot.suarevenda.com.br`, ~R$ 40/ano no Registro.br) apontando para o IP da VPS (registro `A` no DNS).
3. **Entrar**: `ssh root@IP_DA_VPS`.
4. **Instalar o Node 22+**, o git e um proxy HTTPS (o **Caddy** gera o certificado HTTPS sozinho).
5. **Baixar o código**: `git clone https://github.com/gabbms/RevGas.git`, depois `npm install` e `npm run build`.
6. **Criar o `.env`** com as chaves definitivas e `PUBLIC_URL=https://bot.suarevenda.com.br`.
7. **Manter rodando** com `pm2` ou `systemd`, para o bot reiniciar sozinho se cair: `npm run start` roda a versão de produção.
8. **Caddy** repassa `https://bot.suarevenda.com.br` para `localhost:3000`.
9. Na Meta: número definitivo, token permanente (usuário do sistema), os 4 modelos de mensagem aprovados e o webhook apontando para o domínio. Tudo detalhado no README, seções 5 e 6.
10. **Backup**: copie o arquivo `data/revgas.db` todo dia (ele tem clientes, pedidos e conversas).

Este roteiro é um resumo. Os comandos completos (Caddy + systemd) estão no `README.md`, seção 8.

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `npm` ou `node` "não é reconhecido" | Node não instalado ou terminal aberto antes da instalação. Feche e abra o PowerShell. |
| O bot fecha logo ao subir com erro de variável | Alguma variável do `.env` vazia, ou `PANEL_PASSWORD` com menos de 12 / `SESSION_SECRET` com menos de 32 caracteres. |
| Meta recusa "Verificar e salvar" | Bot parado, túnel fechado, `WA_VERIFY_TOKEN` diferente, ou URL sem `/webhook` no fim. |
| Mensagens chegam e o bot não responde | `WA_APP_SECRET` errado (o webhook responde 401), campo `messages` não assinado, ou `WA_TOKEN` temporário expirado (24 h). |
| Link do ngrok mudou | No plano grátis o endereço pode mudar; atualize `PUBLIC_URL` e o webhook na Meta. |
| Pedido não chega ao entregador | O entregador nunca mandou mensagem ao número do bot (janela de 24 h), ou o telefone está sem DDI/DDD (`5586...`). |
| Login do painel bloqueado | 5 senhas erradas em 15 min; espere 15 minutos. |
| Painel não abre pelo link do ngrok | `PUBLIC_URL` precisa ser exatamente o endereço `https://` do túnel. |

## Segurança

- **Nunca** coloque o `.env`, a chave da Anthropic, o token da Meta ou o app secret no GitHub, em prints ou em chats. O `.gitignore` já protege o `.env`.
- O token temporário da Meta expira em 24 h: é normal, só gerar outro.
- Para o teste, use só o seu celular e o de uma pessoa de confiança. Antes de abrir para clientes reais, rode a etapa 2 e faça o roteiro da etapa 4.5 inteiro.
