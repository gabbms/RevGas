export type PaymentMethod = 'dinheiro' | 'cartao' | 'pix_entrega' | 'pix_antecipado' | 'gas_do_povo';
export type CylinderMode = 'troca' | 'completo';
export type OrderKind = 'entrega' | 'retirada';
export type OrderStatus = 'agendado' | 'recebido' | 'saiu' | 'entregue' | 'retirado' | 'cancelado';
export type WeekdayKey = 'dom' | 'seg' | 'ter' | 'qua' | 'qui' | 'sex' | 'sab';

export interface Address {
  rua: string;
  numero: string;
  complemento?: string;
  referencia?: string;
  bairro: string;
}
