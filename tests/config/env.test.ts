import { describe, expect, test, vi } from 'vitest';
import { loadEnv, missingTemplates, warnMissingTemplates } from '../../src/config/env.js';

const base = {
  PUBLIC_URL: 'https://exemplo.com',
  WA_TOKEN: 't',
  WA_PHONE_NUMBER_ID: '1',
  WA_APP_SECRET: 's',
  WA_VERIFY_TOKEN: 'v',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  PANEL_PASSWORD: 'senha-longa-12',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  test('aplica padrões', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe('data/revgas.db');
    expect(env.AI_MODEL).toBe('claude-haiku-5-5');
    expect(env.AI_EFFORT).toBe('medium');
    expect(env.WA_GRAPH_VERSION).toBe('v23.0');
    expect(env.TRANSCRIBE_MODEL).toBe('whisper-1');
    expect(env.WA_TPL_PEDIDO).toBeUndefined();
  });

  test('rejeita SESSION_SECRET curto e variável obrigatória ausente', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'curto' })).toThrow();
    expect(() => loadEnv({ ...base, WA_TOKEN: undefined })).toThrow();
  });

  test('PANEL_PASSWORD precisa de 12 caracteres ou mais', () => {
    expect(() => loadEnv({ ...base, PANEL_PASSWORD: '12345678901' })).toThrow();
    expect(loadEnv({ ...base, PANEL_PASSWORD: '123456789012' }).PANEL_PASSWORD).toBe('123456789012');
  });

  test('string vazia em modelo opcional conta como ausente', () => {
    expect(loadEnv({ ...base, WA_TPL_PEDIDO: '' }).WA_TPL_PEDIDO).toBeUndefined();
  });
});

describe('modelos de mensagem ausentes', () => {
  test('lista os ausentes na ordem de importância, com o efeito', () => {
    const env = loadEnv({ ...base, WA_TPL_STATUS: 'status_pedido' });
    expect(missingTemplates(env).map((m) => m.variavel)).toEqual(['WA_TPL_PEDIDO', 'WA_TPL_ALERTA', 'WA_TPL_LEMBRETE']);
    expect(missingTemplates(env).every((m) => m.efeito.includes('24h'))).toBe(true);
  });

  test('warnMissingTemplates avisa uma linha por modelo ausente', () => {
    const warn = vi.fn();
    warnMissingTemplates(loadEnv({ ...base, WA_TPL_PEDIDO: 'a', WA_TPL_ALERTA: 'b' }), warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain('WA_TPL_STATUS');
    expect(warn.mock.calls[1]![0]).toContain('WA_TPL_LEMBRETE');
    const nada = vi.fn();
    warnMissingTemplates(loadEnv({ ...base, WA_TPL_PEDIDO: 'a', WA_TPL_ALERTA: 'b', WA_TPL_STATUS: 'c', WA_TPL_LEMBRETE: 'd' }), nada);
    expect(nada).not.toHaveBeenCalled();
  });

  describe('provedor WAHA', () => {
    const { WA_TOKEN: _t, WA_PHONE_NUMBER_ID: _p, WA_APP_SECRET: _a, WA_VERIFY_TOKEN: _v, ...semMeta } = base;
    const waha = { ...semMeta, WA_PROVIDER: 'waha', WAHA_URL: 'http://localhost:3001', WAHA_WEBHOOK_SECRET: 'seg' };

    test('não exige as variáveis da Meta, só as do WAHA', () => {
      const env = loadEnv(waha);
      expect(env.WA_PROVIDER).toBe('waha');
      expect(env.WAHA_SESSION).toBe('default');
      expect(() => loadEnv({ ...waha, WAHA_URL: undefined })).toThrow();
      expect(() => loadEnv({ ...waha, WAHA_WEBHOOK_SECRET: undefined })).toThrow();
    });

    test('o padrão continua sendo a Meta, que exige as próprias variáveis', () => {
      expect(loadEnv(base).WA_PROVIDER).toBe('meta');
      expect(() => loadEnv(semMeta)).toThrow();
      expect(() => loadEnv({ ...base, WA_PROVIDER: 'outro' })).toThrow();
    });
  });

  describe('transcrição de áudio', () => {
    const { OPENAI_API_KEY: _o, ...semOpenai } = { ...base, OPENAI_API_KEY: 'k' };

    test('precisa de OPENAI_API_KEY ou de TRANSCRIBE_API_KEY', () => {
      expect(() => loadEnv(semOpenai)).toThrow();
      expect(loadEnv({ ...semOpenai, TRANSCRIBE_API_KEY: 'g' }).TRANSCRIBE_API_KEY).toBe('g');
      expect(loadEnv({ ...semOpenai, OPENAI_API_KEY: 'k' }).OPENAI_API_KEY).toBe('k');
    });

    test('endereço do provedor é opcional', () => {
      expect(loadEnv(base).TRANSCRIBE_URL).toBeUndefined();
      expect(loadEnv({ ...base, TRANSCRIBE_URL: 'https://api.groq.com/openai/v1/audio/transcriptions' }).TRANSCRIBE_URL).toContain('groq');
    });
  });
});
