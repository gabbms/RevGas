import type { StoreSettings } from '../store/settings.js';
import type { CylinderMode, PaymentMethod } from './types.js';

export interface QuoteInput {
  quantidade: number;
  modo: CylinderMode;
  pagamento: PaymentMethod;
}

export interface Quote {
  unitarioCentavos: number;
  cascoCentavos: number;
  taxaEntregaCentavos: number;
  totalCentavos: number;
}

export function quote(s: StoreSettings, q: QuoteInput): Quote {
  if (q.pagamento !== 'gas_do_povo') {
    const unitarioCentavos = q.modo === 'troca' ? s.precoRecargaCentavos : s.precoCompletoCentavos;
    return {
      unitarioCentavos,
      cascoCentavos: 0,
      taxaEntregaCentavos: 0,
      totalCentavos: q.quantidade * unitarioCentavos,
    };
  }
  const cascoCentavos = q.modo === 'completo' ? s.precoCompletoCentavos - s.precoRecargaCentavos : 0;
  const taxaEntregaCentavos = s.gasDoPovo.modalidade === 'entrega' ? s.gasDoPovo.taxaEntregaCentavos : 0;
  return {
    unitarioCentavos: 0,
    cascoCentavos,
    taxaEntregaCentavos,
    totalCentavos: q.quantidade * cascoCentavos + taxaEntregaCentavos,
  };
}
