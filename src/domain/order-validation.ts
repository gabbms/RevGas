import type { StoreSettings } from '../store/settings.js';
import { isOpen } from './hours.js';
import { formatBRL } from './money.js';
import { quote, type Quote } from './pricing.js';
import type { Address, CylinderMode, OrderKind, PaymentMethod } from './types.js';

export interface OrderRequest {
  quantidade: number;
  modo: CylinderMode;
  pagamento: PaymentMethod;
  trocoParaCentavos?: number;
  endereco?: Address;
}

export type ValidationResult =
  | { ok: true; tipo: OrderKind; quote: Quote; agendado: boolean; precisaRevisao: boolean }
  | { ok: false; erros: string[] };

/** Minúsculas, sem acento, espaços colapsados. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateOrderRequest(s: StoreSettings, req: OrderRequest, now: Date): ValidationResult {
  const erros: string[] = [];
  const gdp = req.pagamento === 'gas_do_povo';
  const tipo: OrderKind = gdp && s.gasDoPovo.modalidade === 'retirada' ? 'retirada' : 'entrega';

  if (!Number.isInteger(req.quantidade) || req.quantidade < 1) {
    erros.push('A quantidade de botijões precisa ser um número inteiro de pelo menos 1.');
  }

  if (s.precoRecargaCentavos <= 0) {
    erros.push('O preço da recarga ainda não está configurado na loja.');
  }
  if (req.modo === 'completo' && s.precoCompletoCentavos <= 0) {
    erros.push('O preço do botijão completo ainda não está configurado na loja.');
  } else if (
    gdp &&
    req.modo === 'completo' &&
    s.precoCompletoCentavos > 0 &&
    s.precoCompletoCentavos < s.precoRecargaCentavos
  ) {
    erros.push('O preço do botijão completo configurado é menor que o da recarga; não dá para calcular o casco.');
  }

  if (gdp) {
    if (!s.gasDoPovo.aceita || !s.pagamentos.includes('gas_do_povo')) {
      erros.push('A loja não está aceitando o Gás do Povo no momento.');
    }
  } else if (!s.pagamentos.includes(req.pagamento)) {
    erros.push('Essa forma de pagamento não é aceita pela loja.');
  }

  if (tipo === 'entrega') {
    const e = req.endereco;
    if (!e?.rua?.trim()) erros.push('Falta a rua do endereço de entrega.');
    if (!e?.numero?.trim()) erros.push('Falta o número do endereço de entrega.');
    if (!e?.bairro?.trim()) {
      erros.push('Falta o bairro do endereço de entrega.');
    } else if (!s.bairros.some((b) => normalizeText(b) === normalizeText(e.bairro))) {
      erros.push(`Não entregamos no bairro ${e.bairro.trim()}. Bairros atendidos: ${s.bairros.join(', ')}.`);
    }
  }

  if (req.pagamento === 'pix_antecipado' && !s.chavePix) {
    erros.push('A chave Pix da loja não está configurada, então não dá para pagar com Pix antecipado.');
  }

  // O total só é confiável se quantidade e preços estão válidos.
  const q = erros.length === 0 ? quote(s, req) : null;
  if (q && req.pagamento === 'dinheiro' && req.trocoParaCentavos !== undefined && req.trocoParaCentavos < q.totalCentavos) {
    erros.push(`O troco precisa ser para pelo menos ${formatBRL(q.totalCentavos)}, que é o total do pedido.`);
  }

  if (!q || erros.length > 0) return { ok: false, erros };

  return {
    ok: true,
    tipo,
    quote: q,
    agendado: tipo === 'entrega' && !isOpen(s, now),
    precisaRevisao: req.quantidade > 3,
  };
}
