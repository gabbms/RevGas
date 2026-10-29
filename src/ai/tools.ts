import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js';
import { z } from 'zod';
import { createToolHandlers, type ToolContext } from './tool-handlers.js';

const AddressSchema = z
  .object({
    rua: z.string().min(1).describe('Nome da rua, avenida ou travessa, como o cliente informou.'),
    numero: z.string().min(1).describe('Número da casa ou prédio. Use "s/n" se o cliente disser que não tem número.'),
    bairro: z.string().min(1).describe('Bairro do endereço de entrega.'),
    complemento: z.string().optional().describe('Complemento, como apartamento, bloco ou casa dos fundos.'),
    referencia: z.string().optional().describe('Ponto de referência para o entregador achar o endereço.'),
  })
  .describe('Endereço de entrega.');

const orderFields = {
  quantidade: z.number().int().min(1).describe('Quantidade de botijões P13.'),
  modo: z
    .enum(['troca', 'completo'])
    .describe('"troca" quando o cliente entrega o botijão vazio; "completo" quando ele não tem vazio e leva o casco junto.'),
  pagamento: z
    .enum(['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'])
    .describe(
      'Forma de pagamento: dinheiro, cartao (maquininha), pix_entrega (Pix na hora da entrega), pix_antecipado (Pix antes da entrega) ou gas_do_povo.',
    ),
  trocoParaCentavos: z
    .number()
    .int()
    .optional()
    .describe('Só para dinheiro: valor da nota para o troco, em centavos (R$ 200,00 = 20000). Omita se não precisa de troco.'),
  endereco: AddressSchema.optional().describe(
    'Endereço de entrega. Omita para usar o endereço salvo do cliente.',
  ),
};

const OrderRequestSchema = z.object(orderFields);
const OrderChangesSchema = z.object(orderFields).partial().describe('Só os campos que o cliente quer mudar.');

const numeroPedido = z.number().int().describe('Número do pedido, como aparece em consultar_cliente.');

/**
 * Ferramentas da IA. A lista e a ordem são fixas: mudar invalida o cache do prompt.
 */
export function buildTools(ctx: ToolContext): BetaRunnableTool[] {
  const h = createToolHandlers(ctx);
  const json = (v: unknown): string => JSON.stringify(v);

  return [
    betaZodTool({
      name: 'consultar_loja',
      description:
        'Consulta os dados cadastrados da loja: preços, horário, se está aberta agora, bairros atendidos, formas de pagamento, chave Pix e regras do Gás do Povo. Use sempre que precisar de alguma dessas informações; não responda de memória.',
      inputSchema: z.object({}),
      run: async () => json(await h.consultarLoja()),
    }),
    betaZodTool({
      name: 'consultar_cliente',
      description:
        'Consulta o cliente desta conversa: nome, endereço salvo, se já pediu antes, último pedido, pedidos em aberto com status e se os lembretes estão desativados.',
      inputSchema: z.object({}),
      run: async () => json(await h.consultarCliente()),
    }),
    betaZodTool({
      name: 'salvar_cliente',
      description: 'Salva o nome e/ou o endereço que o cliente informou.',
      inputSchema: z.object({
        nome: z.string().min(1).optional().describe('Nome do cliente.'),
        endereco: AddressSchema.optional(),
      }),
      run: async (i) => json(await h.salvarCliente(i)),
    }),
    betaZodTool({
      name: 'preparar_pedido',
      description:
        'Valida o pedido com as configurações da loja e devolve o resumo e o total. Não cria o pedido. Mostre o resumo ao cliente e peça confirmação. Se vier "erros", explique ao cliente e não invente valores.',
      inputSchema: OrderRequestSchema,
      run: async (i) => json(await h.prepararPedido(i)),
    }),
    betaZodTool({
      name: 'confirmar_pedido',
      description:
        "Cria o pedido a partir do rascunho do preparar_pedido. Só chame depois que o cliente respondeu 'sim' ao resumo do preparar_pedido. Se vier erro 'preco_mudou', mostre o novo resumo e peça confirmação de novo.",
      inputSchema: z.object({
        rascunhoId: z.number().int().describe('O rascunhoId devolvido pelo preparar_pedido.'),
      }),
      run: async (i) => json(await h.confirmarPedido(i)),
    }),
    betaZodTool({
      name: 'alterar_pedido',
      description:
        'Altera um pedido já confirmado do cliente (quantidade, troca/completo, pagamento, troco ou endereço). Se vier motivo "ja_saiu", avise que o pedido já saiu e que o dono foi avisado.',
      inputSchema: z.object({ numero: numeroPedido, mudancas: OrderChangesSchema }),
      run: async (i) => json(await h.alterarPedido(i)),
    }),
    betaZodTool({
      name: 'cancelar_pedido',
      description:
        'Cancela um pedido do cliente. Só chame quando o cliente pedir claramente para cancelar. Se vier motivo "ja_saiu", avise que o pedido já saiu e que o dono foi avisado.',
      inputSchema: z.object({ numero: numeroPedido }),
      run: async (i) => json(await h.cancelarPedido(i)),
    }),
    betaZodTool({
      name: 'alertar_dono',
      description:
        'Avisa o dono da loja. Use quando a informação pedida não estiver cadastrada, em reclamações ou em qualquer assunto fora do roteiro. Continue atendendo o cliente depois.',
      inputSchema: z.object({
        motivo: z.string().min(1).describe('Motivo curto do alerta, por exemplo "Reclamação de atraso".'),
        resumo: z.string().describe('Resumo do contexto para o dono entender sem ler a conversa toda. Nunca inclua CPF, senha ou código SMS.'),
      }),
      run: async (i) => json(await h.alertarDono(i)),
    }),
    betaZodTool({
      name: 'desativar_lembretes',
      description: 'Desativa os lembretes de recompra deste cliente. Use quando ele pedir para não receber mais lembretes.',
      inputSchema: z.object({}),
      run: async () => json(await h.desativarLembretes()),
    }),
  ];
}
