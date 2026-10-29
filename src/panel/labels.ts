import type { OrderStatus, PaymentMethod } from '../domain/types.js';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  agendado: 'Agendado',
  recebido: 'Aguardando',
  saiu: 'Saiu',
  entregue: 'Entregue',
  retirado: 'Retirado',
  cancelado: 'Cancelado',
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  dinheiro: 'Dinheiro',
  cartao: 'Cartão',
  pix_entrega: 'Pix na entrega',
  pix_antecipado: 'Pix antecipado',
  gas_do_povo: 'Gás do Povo',
};
