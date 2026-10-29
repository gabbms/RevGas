import { z } from 'zod';

const optionalText = z.string().min(1).optional();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().min(1).default('data/revgas.db'),
  PUBLIC_URL: z.string().min(1),
  WA_TOKEN: z.string().min(1),
  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(1),
  WA_GRAPH_VERSION: z.string().min(1).default('v23.0'),
  WA_TPL_PEDIDO: optionalText,
  WA_TPL_STATUS: optionalText,
  WA_TPL_ALERTA: optionalText,
  WA_TPL_LEMBRETE: optionalText,
  ANTHROPIC_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  OPENAI_API_KEY: z.string().min(1),
  TRANSCRIBE_MODEL: z.string().min(1).default('whisper-1'),
  PANEL_PASSWORD: z.string().min(12),
  SESSION_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof EnvSchema>;

/** Valida as variáveis de ambiente; lança ZodError se faltar algo obrigatório. */
export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  // Variável vazia (ex.: "WA_TPL_PEDIDO=" no .env) conta como ausente.
  const cleaned = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ''));
  return EnvSchema.parse(cleaned);
}

export type TemplateVar = 'WA_TPL_PEDIDO' | 'WA_TPL_ALERTA' | 'WA_TPL_STATUS' | 'WA_TPL_LEMBRETE';

/** Efeito, em linguagem simples, de rodar sem cada modelo (a Meta só aceita texto livre em até 24h da última mensagem da pessoa). */
const TEMPLATE_EFFECTS: { variavel: TemplateVar; efeito: string }[] = [
  {
    variavel: 'WA_TPL_PEDIDO',
    efeito:
      'Sem o modelo de pedido, os pedidos só chegam aos entregadores (ou a você) se eles tiverem falado com o bot nas últimas 24h.',
  },
  {
    variavel: 'WA_TPL_ALERTA',
    efeito: 'Sem o modelo de alerta, avisos ao seu WhatsApp só chegam se você tiver falado com o bot nas últimas 24h.',
  },
  {
    variavel: 'WA_TPL_STATUS',
    efeito:
      'Sem o modelo de status, o cliente só fica sabendo que o gás saiu ou foi entregue se tiver falado com o bot nas últimas 24h.',
  },
  {
    variavel: 'WA_TPL_LEMBRETE',
    efeito: 'Sem o modelo de lembrete, o lembrete de recompra só sai para quem falou com o bot nas últimas 24h.',
  },
];

/** Modelos de mensagem não configurados, do mais para o menos importante. */
export function missingTemplates(env: Env): { variavel: TemplateVar; efeito: string }[] {
  return TEMPLATE_EFFECTS.filter((t) => !env[t.variavel]);
}

/** Avisa no boot cada modelo ausente (uma linha por modelo). */
export function warnMissingTemplates(env: Env, warn: (msg: string) => void = console.warn): void {
  for (const t of missingTemplates(env)) warn(`aviso: ${t.variavel} não configurado. ${t.efeito}`);
}
