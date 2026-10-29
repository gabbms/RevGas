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
  PANEL_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof EnvSchema>;

/** Valida as variáveis de ambiente; lança ZodError se faltar algo obrigatório. */
export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  // Variável vazia (ex.: "WA_TPL_PEDIDO=" no .env) conta como ausente.
  const cleaned = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ''));
  return EnvSchema.parse(cleaned);
}
