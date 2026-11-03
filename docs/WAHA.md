# Testar o bot com WAHA (WhatsApp não oficial)

> **Só para testes e demonstração.** O WAHA liga um número de WhatsApp comum (como o WhatsApp Web). Isso viola os termos do WhatsApp e **o número pode ser banido**. Use um **chip reserva**, nunca o seu número pessoal nem o da revenda. Em produção, use a API oficial da Meta (`WA_PROVIDER=meta`, que é o padrão).

## Como funciona

```
Celular com o chip ←→ WhatsApp ←→ WAHA (Docker, porta 3001)
                                        ↕ (webhook e API, na sua máquina)
                                  Bot (npm run dev, porta 3000) ←→ Painel
```

O bot escolhe o canal pela variável `WA_PROVIDER`. Para voltar à Meta, basta trocar para `meta`: nada mais muda.

Com o WAHA não existem a janela de 24 horas nem os modelos de mensagem (`WA_TPL_*`). O bot manda texto livre a qualquer hora.

O compose usa o engine **GOWS**, porque é ele que envia o menu "Clica aqui" (lista). Botões Sim/Não não existem no WAHA: nesses casos o bot também usa o menu. Se a lista falhar, as opções saem numeradas no texto. Trocar de engine exige escanear o QR de novo.

## O que você precisa

- Docker Desktop instalado e aberto (ícone da baleia ativo).
- Um chip reserva com WhatsApp instalado em um celular.
- O projeto rodando com `npm run dev`.

## Passo a passo

### 1. Gerar dois segredos
Cada um é um texto aleatório e longo. No PowerShell, rode duas vezes:
```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```
Anote os dois resultados. Um será a chave da API do WAHA, o outro será o segredo do webhook.

### 2. Editar o `.env`
Troque/adicione estas linhas (as da Meta podem ficar como estão, são ignoradas):
```
WA_PROVIDER=waha
WAHA_URL=http://localhost:3001
WAHA_API_KEY=<primeiro texto>
WAHA_WEBHOOK_SECRET=<segundo texto>
WAHA_SESSION=default
```
Não compartilhe esses valores nem o `.env`.

### 3. Subir o WAHA
No PowerShell, dentro da pasta do projeto (use aspas por causa do acento):
```powershell
cd "C:\Users\Gabriel\Desktop\Rev-Gás"
docker compose up -d
```
Na primeira vez ele baixa a imagem (alguns minutos). Confira com `docker ps`: deve aparecer `revgas-waha`.

### 4. Ligar o chip por QR code
1. Abra http://localhost:3001/dashboard. Usuário: `admin`. Senha: o valor de `WAHA_API_KEY`.
2. Na sessão `default`, clique em **Start** se ela estiver parada, depois em **QR**.
3. No celular com o chip: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → aponte para o QR.
4. A sessão deve ficar com o status **WORKING**.

### 5. Reiniciar o bot
Pare o `npm run dev` (Ctrl+C) e rode de novo. Deve aparecer o aviso:
`aviso: WA_PROVIDER=waha usa WhatsApp não oficial...`

### 6. Testar
De **outro celular** (o seu), mande "oi" para o número do chip. O bot deve responder.
Confira também o painel em http://localhost:3000/painel/conversas.

No painel, em **Configurações**, o campo **Seu WhatsApp** deve ter o seu número pessoal (55 + DDD + número), para receber pedidos e alertas.

## Cuidados para não ser banido
- Teste só com você e com poucas pessoas que saibam do teste.
- Não mande mensagens em massa nem para quem não esperava.
- Não deixe o lembrete de recompra disparar para contatos reais nesta fase.
- Se o número cair, é só trocar o chip e escanear de novo.

## Comandos úteis
| Comando | O que faz |
|---|---|
| `docker compose up -d` | liga o WAHA |
| `docker compose down` | desliga (a sessão do WhatsApp é mantida) |
| `docker compose logs -f waha` | mostra o que o WAHA está fazendo |
| `docker compose pull` e `docker compose up -d` | atualiza o WAHA |

A sessão fica na pasta `.waha/` (fora do Git). Apagá-la desconecta o chip e pede novo QR.

## Problemas comuns
- **O bot não recebe nada:** veja `docker compose logs -f waha`. O WAHA precisa alcançar `host.docker.internal:3000`. Confirme que o bot está rodando e que `WAHA_WEBHOOK_SECRET` é o mesmo nos dois lados (o bot responde 401 se for diferente).
- **Contatos `@lid`:** o WhatsApp novo identifica alguns contatos por um código (`...@lid`) em vez do telefone. O bot pergunta ao WAHA qual é o telefone. Se aparecer no terminal "não achei o telefone do contato", a mensagem foi descartada: confirme que a sessão está WORKING.
- **Áudio ou comprovante não são entendidos:** o WAHA precisa baixar a mídia (`WHATSAPP_DOWNLOAD_MEDIA=true`, já configurado no compose).
- **Erro 401 ao enviar:** `WAHA_API_KEY` no `.env` diferente da usada ao subir o WAHA. Rode `docker compose up -d` de novo depois de editar o `.env`.
- **Número do 9º dígito:** o bot pergunta ao WAHA qual é o endereço certo do contato antes de enviar.

## Voltar para a API oficial da Meta
1. No `.env`: `WA_PROVIDER=meta` e preencha `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` e os `WA_TPL_*`.
2. Configure o webhook na Meta (veja `docs/GUIA-DE-TESTE.md`).
3. `docker compose down` para desligar o WAHA.
