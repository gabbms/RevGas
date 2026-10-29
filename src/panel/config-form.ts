import { normalizePhone } from '../domain/phone.js';
import type { PaymentMethod, WeekdayKey } from '../domain/types.js';
import { StoreSettingsSchema, type StoreSettings } from '../store/settings.js';

export const DIAS: { id: WeekdayKey; rotulo: string }[] = [
  { id: 'seg', rotulo: 'Segunda' },
  { id: 'ter', rotulo: 'Terça' },
  { id: 'qua', rotulo: 'Quarta' },
  { id: 'qui', rotulo: 'Quinta' },
  { id: 'sex', rotulo: 'Sexta' },
  { id: 'sab', rotulo: 'Sábado' },
  { id: 'dom', rotulo: 'Domingo' },
];

/** Formas de pagamento marcáveis. "Gás do Povo" não entra: vem da seção própria (ver `parseConfigForm`). */
export const PAGAMENTOS: { id: PaymentMethod; rotulo: string }[] = [
  { id: 'dinheiro', rotulo: 'Dinheiro' },
  { id: 'cartao', rotulo: 'Cartão' },
  { id: 'pix_entrega', rotulo: 'Pix na entrega' },
  { id: 'pix_antecipado', rotulo: 'Pix antecipado (o cliente paga antes)' },
];

/** O que o formulário mostra: texto de cada campo, `'on'` para checkbox marcada, lista para os pagamentos. */
export type FormValues = Record<string, string | string[]>;
export type FormErrors = Record<string, string[]>;

export type ParsedForm =
  | { ok: true; settings: StoreSettings }
  | { ok: false; erros: FormErrors; valores: FormValues };

const MIN_DIGITOS_TELEFONE = 10;

const formatReais = (centavos: number): string =>
  `${Math.floor(centavos / 100)},${String(centavos % 100).padStart(2, '0')}`;

const linhas = (texto: string): string[] =>
  texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** Reais digitados (`115,00`, `115`, `115.00`, `R$ 115,00`) para centavos; null se não for um valor válido. */
export function parseReais(texto: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(texto.replace(/^R\$/i, '').replace(/\s/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

export function settingsToForm(s: StoreSettings): FormValues {
  const v: FormValues = {
    nomeLoja: s.nomeLoja,
    enderecoLoja: s.enderecoLoja,
    precoRecarga: formatReais(s.precoRecargaCentavos),
    precoCompleto: formatReais(s.precoCompletoCentavos),
    previsaoEntregaMin: String(s.previsaoEntregaMin),
    bairros: s.bairros.join('\n'),
    pagamentos: s.pagamentos.filter((p) => p !== 'gas_do_povo'),
    chavePix: s.chavePix ?? '',
    telefoneDono: s.telefoneDono,
    entregadores: s.entregadores.map((e) => `${e.nome}; ${e.telefone}`).join('\n'),
    destinoPedidos: s.destinoPedidos,
    gdpModalidade: s.gasDoPovo.modalidade,
    gdpTaxa: formatReais(s.gasDoPovo.taxaEntregaCentavos),
    fuso: s.fuso,
  };
  if (s.gasDoPovo.aceita) v.gdpAceita = 'on';
  if (s.lembretesAtivos) v.lembretesAtivos = 'on';
  for (const { id } of DIAS) {
    const h = s.horarios[id];
    if (h) {
      v[`${id}_abre`] = h.abre;
      v[`${id}_fecha`] = h.fecha;
    } else {
      v[`${id}_fechado`] = 'on';
      v[`${id}_abre`] = '';
      v[`${id}_fecha`] = '';
    }
  }
  return v;
}

function bodyToValues(body: Record<string, unknown>): FormValues {
  const v: FormValues = {};
  for (const [k, raw] of Object.entries(body)) {
    if (k === 'pagamentos') v[k] = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === 'string');
    else if (typeof raw === 'string') v[k] = raw;
  }
  if (!Array.isArray(v.pagamentos)) v.pagamentos = [];
  return v;
}

const text = (v: FormValues, k: string): string => {
  const x = v[k];
  return typeof x === 'string' ? x.trim() : '';
};

// Mensagens em PT-BR para os erros do zod (o texto padrão do zod é em inglês).
const MENSAGEM: Record<string, string> = {
  nomeLoja: 'Informe o nome da loja.',
  enderecoLoja: 'Endereço inválido.',
  precoRecarga: 'Digite o preço em reais, por exemplo 115,00.',
  precoCompleto: 'Digite o preço em reais, por exemplo 320,00.',
  previsaoEntregaMin: 'Informe a previsão de entrega em minutos (um número maior que zero).',
  bairros: 'Confira a lista de bairros.',
  pagamentos: 'Confira as formas de pagamento.',
  chavePix: 'Confira a chave Pix.',
  telefoneDono: 'Confira o telefone do dono.',
  entregadores: 'Confira a lista de entregadores.',
  destinoPedidos: 'Escolha para onde vão os pedidos.',
  gdpModalidade: 'Escolha entrega ou retirada para o Gás do Povo.',
  gdpTaxa: 'Digite a taxa em reais, por exemplo 5,00.',
  fuso: 'Fuso horário inválido.',
};

const CAMPO_DO_ZOD: Record<string, string> = {
  precoRecargaCentavos: 'precoRecarga',
  precoCompletoCentavos: 'precoCompleto',
};

function add(erros: FormErrors, campo: string, msg: string): void {
  const l = (erros[campo] ??= []);
  if (!l.includes(msg)) l.push(msg);
}

/** Lê o formulário de configurações. Em caso de erro devolve as mensagens por campo e o que foi digitado. */
export function parseConfigForm(body: Record<string, unknown>): ParsedForm {
  const v = bodyToValues(body);
  const erros: FormErrors = {};

  const reais = (campo: string, rotulo: string): number => {
    const t = text(v, campo);
    const c = parseReais(t);
    if (c !== null) return c;
    add(erros, campo, t.startsWith('-') ? `${rotulo} não pode ser negativo.` : MENSAGEM[campo]!);
    return 0;
  };
  const precoRecargaCentavos = reais('precoRecarga', 'O preço');
  const precoCompletoCentavos = reais('precoCompleto', 'O preço');
  const taxaEntregaCentavos = text(v, 'gdpTaxa') === '' ? 0 : reais('gdpTaxa', 'A taxa');

  const bairros = [...new Set(linhas(String(v.bairros ?? '')))];

  const entregadores: StoreSettings['entregadores'] = [];
  linhas(String(v.entregadores ?? '')).forEach((linha, i) => {
    const partes = linha.split(';').map((p) => p.trim());
    const [nome, telefone] = partes;
    if (partes.length !== 2 || !nome || !telefone) {
      add(erros, 'entregadores', `Linha ${i + 1}: use o formato Nome; telefone (por exemplo João; 86 99999-0000).`);
    } else if (telefone.replace(/\D/g, '').length < MIN_DIGITOS_TELEFONE) {
      add(erros, 'entregadores', `Linha ${i + 1}: o telefone precisa ter DDD e pelo menos 10 números.`);
    } else {
      entregadores.push({ nome, telefone });
    }
  });

  const telefoneDono = text(v, 'telefoneDono');
  if (telefoneDono !== '' && normalizePhone(telefoneDono).length < MIN_DIGITOS_TELEFONE) {
    add(erros, 'telefoneDono', 'O telefone precisa ter DDD e pelo menos 10 números.');
  }

  const gdpAceita = v.gdpAceita === 'on';
  const marcados = (v.pagamentos as string[]).filter((p) => PAGAMENTOS.some((x) => x.id === p)) as PaymentMethod[];
  // O bot só aceita Gás do Povo se a seção própria E a forma de pagamento estiverem ligadas: uma só caixa liga as duas.
  const pagamentos = [...new Set<PaymentMethod>([...marcados, ...(gdpAceita ? (['gas_do_povo'] as const) : [])])];

  const chavePix = text(v, 'chavePix');
  if (pagamentos.includes('pix_antecipado') && chavePix === '') {
    add(erros, 'chavePix', 'Informe a chave Pix para aceitar Pix antecipado.');
  }

  const horarios = {} as StoreSettings['horarios'];
  for (const { id } of DIAS) {
    horarios[id] = v[`${id}_fechado`] === 'on' ? null : { abre: text(v, `${id}_abre`), fecha: text(v, `${id}_fecha`) };
  }

  const candidato = {
    nomeLoja: text(v, 'nomeLoja'),
    enderecoLoja: text(v, 'enderecoLoja'),
    precoRecargaCentavos,
    precoCompletoCentavos,
    previsaoEntregaMin: Number(text(v, 'previsaoEntregaMin') || 'NaN'),
    horarios,
    bairros,
    pagamentos,
    chavePix: chavePix === '' ? null : chavePix,
    telefoneDono,
    entregadores,
    destinoPedidos: text(v, 'destinoPedidos'),
    gasDoPovo: { aceita: gdpAceita, modalidade: text(v, 'gdpModalidade'), taxaEntregaCentavos },
    lembretesAtivos: v.lembretesAtivos === 'on',
    fuso: text(v, 'fuso'),
  };

  const r = StoreSettingsSchema.safeParse(candidato);
  if (!r.success) {
    for (const issue of r.error.issues) {
      const [raiz, sub] = issue.path;
      if (raiz === 'horarios' && typeof sub === 'string') {
        add(erros, sub, issue.message);
      } else if (raiz === 'gasDoPovo') {
        const campo = sub === 'modalidade' ? 'gdpModalidade' : 'gdpTaxa';
        if (!erros[campo]) add(erros, campo, MENSAGEM[campo]!);
      } else if (typeof raiz === 'string') {
        const campo = CAMPO_DO_ZOD[raiz] ?? raiz;
        // Preços e linhas já validados acima têm mensagem própria; não repete.
        if (erros[campo]) continue;
        add(erros, campo, raiz === 'fuso' ? issue.message : (MENSAGEM[campo] ?? 'Valor inválido.'));
      }
    }
  }

  if (!r.success || Object.keys(erros).length > 0) return { ok: false, erros, valores: v };
  return { ok: true, settings: r.data };
}
