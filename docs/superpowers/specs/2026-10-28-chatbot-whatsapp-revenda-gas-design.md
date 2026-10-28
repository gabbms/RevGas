# Chatbot de pedidos de gás pelo WhatsApp — Design

Data: 2026-10-28
Status: rascunho para aprovação

## 1. Intenção e porquê

Um revendedor de gás (GLP) atende os pedidos dos clientes **manualmente pelo WhatsApp**: alguém da revenda lê e responde cada mensagem. O objetivo é colocar uma IA nesse WhatsApp para que o cliente consiga pedir gás de forma rápida e natural, a qualquer momento, e para que a revenda pare de ficar presa respondendo mensagem.

O revendedor **usa o software de gestão RevGás** (revgas.com, da Tartigrado Tecnologia, com app do entregador, emissão de nota e mapa dos entregadores), mas **não usa** o recurso de venda pelo WhatsApp da RevGás. Este projeto é um bot próprio, **independente da RevGás na v1**, preparado para integrar com ela no futuro.

### Como é o sucesso
- O cliente pede gás em poucas mensagens, escrevendo do jeito dele ou mandando áudio.
- O pedido chega **correto e completo** para o entregador: produto, endereço, pagamento e troco.
- O dono gasta **menos** tempo com o WhatsApp do que hoje, e não mais.
- Os clientes recompram pelo bot quando recebem o lembrete.

### Anti-objetivos: o projeto fracassa, mesmo funcionando, se:
- **O bot parece robótico**, com menu engessado que irrita o cliente e faz ele voltar a ligar.
- **Chega pedido errado** ao entregador (endereço, quantidade ou troco errado).
- **A IA inventa coisas**: promete preço, prazo, promoção ou regra que não existe.
- **Dá trabalho ao dono**: ele precisa vigiar o bot ou mexer em coisas complicadas.

## 2. Escopo da v1

### Dentro
1. **Receber pedido de gás P13** (só P13 por enquanto; outros produtos ficam para depois).
2. **Tirar dúvidas** sobre preço, horário, bairros atendidos, formas de pagamento e Gás do Povo, respondendo **só com dados configurados pelo dono**.
3. **Status da entrega em etapas, sem mapa**: recebido → saiu para entrega → entregue, com aviso ao cliente em cada mudança.
4. **Lembrete de recompra** baseado no histórico de cada cliente.
5. **Pedidos pelo programa Gás do Povo** (detalhes na seção 5).
6. **Entender áudio**: o áudio do cliente é transcrito e tratado como texto.
7. **Alerta ao dono** quando o bot não souber resolver ou houver reclamação.
8. **Painel web simples para o dono**: pedidos do dia, clientes, alertas, **conversas (chat)** e configurações.
9. **O dono pode assumir uma conversa** pelo painel, pausando o bot só para aquele cliente (seção 4.4).

### Fora (por enquanto)
- Mapa ao vivo do entregador, estilo iFood (pode vir numa fase 2).
- Integração com a API da RevGás (fase futura; ver seção 8).
- Outros produtos (P45, P20, água, acessórios).
- Pagamento online confirmado automaticamente (o Pix antecipado na v1 é só o bot enviar a chave, sem confirmar o pagamento).
- Validar o benefício do Gás do Povo (isso só é possível na maquininha da Caixa).
- Várias unidades ou lojas.
- Importar histórico antigo de clientes e pedidos. A v1 começa do zero, mas o modelo de dados deve permitir uma importação futura (por exemplo, de planilha exportada da RevGás), porque o dono ainda não sabe se esse histórico existe.

## 3. Pessoas envolvidas

- **Cliente**: pessoa física ou pequeno comércio que pede P13 pelo WhatsApp. Muitos pedem por áudio, e parte deles é beneficiária do Gás do Povo.
- **Dono**: recebe alertas, acompanha os pedidos e ajusta as configurações no painel. Não é técnico.
- **Entregadores**: recebem os pedidos num **grupo de WhatsApp** (ou no WhatsApp individual do dono, conforme configuração) e respondem para atualizar o status. Continuam usando o app da RevGás para registrar a venda e emitir nota, como já fazem hoje.

## 4. Como funciona

### 4.1 Conversa de pedido
Os mockups estão em `.superpowers/brainstorm/` (arquivo `fluxo-pedido.html`). O dono aceitou esse fluxo como base para a v1 e quer ir melhorando depois.

- O bot conversa de forma **natural** (IA), sem obrigar menu. Para facilitar, oferece opções numeradas ou botões quando ajuda (forma de pagamento, por exemplo).
- **Cliente que já pediu antes**: o bot oferece "o de sempre" com o último endereço.
- **Cliente novo**: o bot pergunta nome e endereço completo (rua, número, complemento ou referência, bairro) e confere se o bairro está na área atendida.
- **Preço**: há **um preço único do P13 (recarga, com troca do botijão vazio)**, que vale para qualquer forma de pagamento e já inclui a entrega. Há também um **preço de botijão completo** (casco + gás) para quem não tem vazio para trocar. Os dois são configurados no painel.
  - Cliente novo: o bot pergunta se ele tem o botijão vazio para trocar. Cliente que já pediu: o bot assume troca, a menos que o cliente diga o contrário. (Decisão minha.)
  - Gás do Povo sempre é recarga, com troca. Quem não tem vazio paga o casco à parte, pelo preço do casco (= botijão completo − recarga). (Decisão minha; o dono pode corrigir.)
- **Quantidade**: de 1 a 3 botijões por pedido pelo bot. Acima disso, o bot cria o pedido e alerta o dono. (Decisão minha.)
- **Pagamento**: dinheiro (pergunta se precisa de troco e para quanto), cartão na maquininha, Pix na entrega, Pix antecipado ou Gás do Povo.
- **Pix antecipado**: o bot envia a chave Pix configurada, e o pedido **vai na hora** para os entregadores, marcado "Pix antecipado – conferir". Se o cliente mandar o comprovante (imagem ou PDF) no chat, o bot repassa junto do pedido. Ninguém confirma o pagamento automaticamente na v1.
- **Antes de criar o pedido**, o bot sempre mostra um **resumo** (produto, troca ou completo, quantidade, valor total, endereço, pagamento e troco) e pede confirmação explícita. O pedido só é criado depois do "sim". O mockup pula esse passo, mas vale o documento.
- **Alterar ou cancelar depois de confirmar** (decisão minha): enquanto o pedido estiver "recebido", o bot aplica a mudança (endereço, pagamento, troco, quantidade) ou o cancelamento e manda uma **mensagem de correção** para o destino dos pedidos, citando o pedido original. Se o pedido já "saiu", o bot não altera: alerta o dono e avisa o entregador daquele pedido.
- Depois da confirmação, o bot envia o número do pedido e a previsão de entrega configurada.
- **Fora do horário de atendimento**, o bot avisa o horário e oferece registrar o pedido para quando a revenda abrir. Se aceitar, o pedido fica marcado como "agendado para abertura" e é enviado **automaticamente** aos entregadores quando a revenda abre. (Decisão minha.)

### 4.2 Pedido para os entregadores
- Depois de confirmado, o pedido vai como mensagem para o **destino configurado** (grupo dos entregadores ou WhatsApp do dono), com número, produto, valor, pagamento/troco, nome, telefone e endereço com referência.
- Os entregadores **respondem à mensagem do pedido** com `saiu`, `entregue` ou `problema`, e o bot entende variações livres ("saindo", "entreguei", "cliente não atende"). O status é atualizado e o cliente recebe o aviso.
- Quando possível, a resposta "saiu" registra quem saiu (pelo número do entregador que respondeu).
- `problema` gera um alerta para o dono.
- O dono também pode mudar o status pelo painel.

> Restrição técnica a verificar (a cargo do builder): a API oficial do WhatsApp tem limitações para participar de **grupos**. Se o bot não puder ler as respostas num grupo, a alternativa aceitável é mandar o pedido individualmente para cada entregador cadastrado (ou para o dono), e cada um responde no privado. O comportamento esperado é o mesmo: o entregador responde com uma palavra e o status atualiza.

### 4.3 Status para o cliente
- Etapas: **recebido → saiu para entrega → entregue** (e **cancelado**, pelo painel).
- O cliente recebe mensagem automática nas mudanças para "saiu" e "entregue".
- Se o cliente perguntar "meu gás já saiu?", o bot responde com o status real do pedido em aberto e a previsão de entrega.

### 4.4 Dúvidas e "não sei"
- O bot responde **apenas** com informações do cadastro do dono (preço, horário, bairros, formas de pagamento, taxa, chave Pix, regras do Gás do Povo). Se a informação não estiver cadastrada, ele diz que vai verificar e **alerta o dono**. Ele nunca inventa.
- **Reclamação ou assunto fora do roteiro**: o bot responde com educação, continua atendendo e **manda um alerta ao dono** com o contexto (cliente, telefone, pedido relacionado, resumo). Por padrão, o bot **não** para de responder.
- Os alertas aparecem no painel e também são enviados ao WhatsApp pessoal do dono, com link para a conversa no painel.
- **O dono assume a conversa pelo painel**: como o número do bot fica na API oficial e não abre no app normal do WhatsApp, o painel tem uma aba **Conversas** com o histórico de cada cliente. Ali o dono pode:
  - **pausar o bot para aquele cliente** e responder pelo painel; as mensagens saem pelo número do bot;
  - **devolver ao bot** quando terminar. O bot também volta sozinho depois de um tempo sem resposta do dono (sugestão: 2 horas; decisão do builder).
  - Enquanto a conversa estiver pausada, o bot não responde, mas avisos automáticos de status do pedido continuam saindo.
- Marcar um alerta como "resolvido" só tira ele da lista; não muda a conversa.

### 4.5 Lembrete de recompra
- Para cada cliente com **2 ou mais pedidos**, o bot calcula o intervalo médio entre as compras e manda o lembrete um pouco antes da data prevista. A margem é decisão do builder, por exemplo 2 a 3 dias antes.
- Clientes com só 1 pedido não recebem lembrete. (Decisão minha; o builder pode propor um prazo padrão configurável.)
- O lembrete oferece "Sim, pode mandar", que inicia o pedido já preenchido com o último endereço e pagamento, e "Ainda não".
- O cliente pode pedir para não receber mais lembretes, e o bot respeita.
- O lembrete tem liga/desliga no painel.
- Lembretes são mensagens enviadas pelo bot primeiro, então usam **modelo de mensagem aprovado pela Meta** e têm custo por mensagem.

### 4.6 Painel do dono
Uma página web simples, que funcione bem no celular, com login.
- **Pedidos de hoje**: lista com status, filtro por status, ação de mudar status e cancelar.
- **Clientes**: nome, telefone, endereço(s), histórico de pedidos e próxima recompra prevista.
- **Alertas**: lista de alertas abertos com o contexto, link para a conversa e a ação "resolvido".
- **Conversas**: histórico por cliente, com as transcrições dos áudios, campo para o dono responder e o botão "pausar bot / devolver ao bot". Precisa funcionar bem no celular. Atualização quase em tempo real é desejável; o builder escolhe a técnica.
- **Configurações**: preço do P13 (recarga), preço do botijão completo, previsão de entrega, horário de funcionamento por dia da semana, bairros atendidos, formas de pagamento aceitas, chave Pix, destino dos pedidos (grupo ou números dos entregadores, WhatsApp do dono para alertas), Gás do Povo (seção 5) e liga/desliga do lembrete.
- O visual é básico na v1. O dono quer melhorar a interface depois.

## 5. Gás do Povo

Programa federal (Caixa) em que famílias do CadÚnico recebem um vale digital que cobre **100% da recarga do P13** em revenda **credenciada**. A validação é feita **na maquininha "Azulzinha" da Caixa**, com o cartão do Bolsa Família ou cartão Caixa com senha, com CPF e código recebido por SMS, ou com código do app Gás do Povo. A taxa de entrega **não** entra na gratuidade.

Ainda não se sabe se a revenda é credenciada, se faz entrega ou só retirada no balcão, nem se cobra taxa. Por isso, tudo fica **configurável**:
- `aceita Gás do Povo`: sim/não. Se não, o bot explica que a revenda não atende pelo programa.
- `modalidade`: entrega em casa ou só retirada na revenda.
- `taxa de entrega Gás do Povo`: valor em R$, podendo ser zero.

Comportamento do bot:
- Reconhece quando o cliente quer pedir pelo Gás do Povo.
- Explica o que ter em mãos (cartão com senha **ou** o celular cadastrado para receber o código, e o botijão vazio) e informa a taxa de entrega, se houver.
- **Nunca pede, recebe nem registra CPF completo, senha ou código de SMS pelo WhatsApp.** Se o cliente mandar o código, o bot orienta a mostrar o código só para o entregador na hora e não guarda essa mensagem.
- O pedido vai para os entregadores marcado como **Gás do Povo**, com o lembrete de levar a Azulzinha.
- **Se a modalidade for "só retirada"** (decisão minha): o bot cria uma **reserva de retirada** com número, explica o endereço e o horário da revenda e o que levar (cartão ou celular e o botijão vazio). A reserva vai para o WhatsApp do dono, não para os entregadores, e aparece no painel com os status recebido → retirado (ou cancelado). O dono marca "retirado" pelo painel. O cliente não recebe aviso de status, só a confirmação da reserva.
- Para "como sei se tenho direito?", indica os canais oficiais: app Meu Social, Disque Social 121, site gasdopovo.caixa.gov.br.
- O bot **não** confirma se o cliente tem direito ao benefício.

## 6. Decisões técnicas (minhas, já que o dono deixou a parte técnica comigo)

- **WhatsApp**: **API oficial do WhatsApp Business (Cloud API da Meta)**. Não usar soluções não oficiais (baseadas no WhatsApp Web), porque o bot envia mensagens proativas (lembretes) e isso leva a banimento de número nessas soluções. O builder pode usar a Cloud API direto ou um provedor oficial (BSP), o que for mais simples.
- **Número**: um **número novo** dedicado ao bot, na API oficial. O dono responde clientes pelo chat do painel (4.4), não pelo app do WhatsApp. O número antigo pode continuar no ar avisando o número novo.
- **IA de conversa**: Claude (API da Anthropic), com **modelo configurável** por variável de ambiente. Padrão **`claude-haiku-5-5`**, por escolha do dono, pelo custo. As alternativas `claude-sonnet-5-5` e `claude-opus-5-5` ficam disponíveis trocando só a configuração, caso as conversas reais mostrem que o Haiku não dá conta. Custo estimado por pedido: ~R$ 0,50 (Opus), ~R$ 0,25 (Sonnet), ~R$ 0,02 (Haiku).
- A IA atua com **ferramentas** (tool use) para consultar a configuração, o cliente e os pedidos, e para criar pedidos. Ela não guarda preço ou regra no prompt de forma fixa: tudo vem do cadastro, para cumprir o "não inventar".
- A **criação do pedido** é validada em código (campos obrigatórios, bairro atendido, horário, forma de pagamento aceita), não só pela IA.
- **Áudio**: a API da Claude não transcreve áudio, então é preciso um serviço separado de transcrição (speech-to-text) com bom suporte a português. A escolha do serviço fica com o builder.
- **Linguagem**: TypeScript (Node.js), um único serviço com o webhook do WhatsApp, a lógica do bot, a tarefa agendada dos lembretes e o painel.
- **Banco de dados**: relacional (PostgreSQL ou SQLite). Fica com o builder, considerando que o volume é pequeno: o número de pedidos por dia ainda é desconhecido; planejar para revenda pequena ou média, até ~100 pedidos/dia.
- **Hospedagem**: um servidor pequeno com HTTPS público (exigência do webhook da Meta), na faixa de R$ 30–60/mês. O provedor fica com o builder.
- **Integração futura com a RevGás**: a parte de "criar pedido / atualizar status" fica isolada num módulo próprio, para que depois dê para trocar o destino "mensagem para entregadores" por "criar pedido na RevGás" sem reescrever a conversa.

## 7. Restrições e cuidados

- **Privacidade (LGPD)**: guardar só o necessário (nome, telefone, endereço, histórico de pedidos). Nunca guardar dados do Gás do Povo além da marcação "pagamento: Gás do Povo". Atender pedido de exclusão de dados.
- **Mensagens proativas** (lembretes, avisos de status fora da janela de 24h) seguem as regras da Meta: modelos aprovados e opt-out. Os lembretes vão só para quem já conversou com o bot e não recusou. Se houver importação de clientes no futuro, ela vai precisar de um passo de consentimento antes de qualquer lembrete.
- **Dono não técnico**: tudo que muda no dia a dia (preço, horário, bairros, taxa) é feito pelo painel, sem mexer em código.
- **Português do Brasil**, tom simpático e direto, sem exagero de emoji.

## 8. Pendências que não bloqueiam a v1

- **Começar cedo**: conta Meta Business da revenda (CNPJ, verificação da empresa) e o número novo para a API oficial. O desenvolvimento pode usar o número de teste da Meta até isso sair.

- Perguntar à RevGás se a API deles permite **criar pedidos e consultar o status das entregas**. Se permitir, entra numa fase seguinte.
- Confirmar com o revendedor: credenciamento no Gás do Povo, modalidade, taxa, volume de pedidos e chave Pix. Tudo isso é configuração, não código.
- Confirmar se a revenda vende outros produtos (P45, água, etc.) para uma próxima versão.

## 9. O que fica com o builder

- O texto exato das mensagens, desde que respeite o tom e os anti-objetivos.
- Banco de dados, provedor de hospedagem, serviço de transcrição e BSP (ou Cloud API direto).
- Como lidar com grupos no WhatsApp oficial (ver a nota em 4.2).
- A margem de dias do lembrete de recompra e o horário de envio, evitando horários inconvenientes.
- O formato de login do painel (um único usuário, o dono, basta na v1).
- Estratégia de testes, incluindo um conjunto de conversas de exemplo para checar que o bot não inventa e que monta pedidos corretos.
