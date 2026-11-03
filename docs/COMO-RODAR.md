# Como ligar e desligar o bot (modo WAHA, no seu computador)

Use estes passos toda vez que for testar. O computador precisa estar ligado e com internet, e o celular do chip do bot também.

## Ligar

### 1. Abrir o Docker Desktop
Menu Iniciar → **Docker Desktop**. Espere o ícone da baleia parar de se mexer e a janela mostrar "Engine running" (1 a 2 minutos).

Se ele abrir sozinho com o Windows, só confira que está pronto.

### 2. Abrir um PowerShell na pasta do projeto
```powershell
cd "C:\Users\Gabriel\Desktop\Rev-Gás"
```
As aspas são necessárias por causa do acento em "Gás".

### 3. Ligar o WAHA (o WhatsApp)
```powershell
docker compose up -d
```
Confira com `docker ps`: deve aparecer `revgas-waha` com status "Up".

O WAHA guarda a sessão do WhatsApp, então **não precisa escanear o QR de novo**. Para ter certeza, abra http://localhost:3001/dashboard (usuário `admin`, senha: o `WAHA_API_KEY` do `.env`). A sessão `default` deve estar **WORKING**.
- Se estiver **SCAN_QR_CODE**, a sessão caiu: escaneie o QR de novo (WhatsApp Business no celular do chip → Aparelhos conectados → Conectar um aparelho).
- Se estiver **STOPPED**, clique em Start.

### 4. Ligar o bot
```powershell
npm run dev
```
**Deixe esta janela aberta.** Fechar a janela desliga o bot. Deve aparecer o aviso `WA_PROVIDER=waha usa WhatsApp não oficial...`. Isso é normal. Os avisos `WA_TPL_*` só aparecem no modo Meta.

### 5. Abrir o painel
http://localhost:3000/painel (senha: a `PANEL_PASSWORD` do `.env`).

### 6. Testar
De **outro celular** (não o seu de dono), mande "oi" para o número do chip. O bot deve responder.

> O celular de dono (o número em **Seu WhatsApp**, nas Configurações) não pode ser usado como cliente: o bot o trata como equipe.

## Opcional: ngrok
Só é necessário para abrir o painel ou os links dos alertas **fora do computador** (por exemplo, pelo celular, via o endereço do `PUBLIC_URL` do `.env`). O WAHA não precisa dele.
```powershell
ngrok http 3000
```
Se o endereço `https://...ngrok-free.dev` mudar, atualize o `PUBLIC_URL` no `.env` e reinicie o bot.

## Desligar
1. No terminal do bot: **Ctrl+C**.
2. (Opcional) Desligar o WAHA: `docker compose down`. A sessão do WhatsApp é mantida.
3. (Opcional) Fechar o Docker Desktop para liberar memória.

## Depois de mudar o `.env`
O bot só lê o `.env` quando liga. Pare com Ctrl+C e rode `npm run dev` de novo. Se mudou algo do WAHA (`WAHA_API_KEY` ou `WAHA_WEBHOOK_SECRET`), rode também `docker compose up -d`.

## Não deu certo?
| Sintoma | O que fazer |
|---|---|
| `failed to connect to the docker API` | O Docker Desktop não está aberto. Faça o passo 1. |
| `docker ps` não mostra `revgas-waha` | Rode `docker compose up -d` de novo. |
| O bot não responde e a sessão está WORKING | Veja o terminal do bot e `docker compose logs -f waha`. |
| Sessão SCAN_QR_CODE | Escaneie o QR de novo no dashboard do WAHA. |
| O bot responde "Responda a mensagem do pedido com: saiu, entregue..." | Você escreveu do número de dono. Use outro celular como cliente. |
| `Port 3000 already in use` | Já há um bot rodando. Feche a outra janela do `npm run dev`. |
| O bot não entende áudio | Confira `TRANSCRIBE_*` no `.env` e reinicie o bot. |

## Atualizar o código (outro computador ou depois de mudanças no GitHub)
```powershell
git pull
npm install
```
