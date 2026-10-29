import type { Db } from '../db/connection.js';
import { normalizePhone, samePhone } from '../domain/phone.js';
import type { WhatsAppApi } from './api.js';

export type OutgoingMessage = { telefone: string; texto: string; template?: { nome: string; parametros: string[] } };
export type SendResult =
  | { ok: true; wamid: string; via: 'texto' | 'template' }
  | { ok: false; motivo: 'fora_da_janela' | 'erro_api'; detalhe?: string };

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function createOutbox(db: Db, api: WhatsAppApi, clock: () => Date) {
  function windowOpen(telefone: string, now: Date = clock()): boolean {
    const rows = db.prepare('SELECT telefone, ultima_entrada_em FROM contact_windows').all() as {
      telefone: string;
      ultima_entrada_em: string;
    }[];
    const row = rows.find((r) => samePhone(r.telefone, telefone));
    return !!row && now.getTime() - new Date(row.ultima_entrada_em).getTime() < WINDOW_MS;
  }

  function registerInbound(telefone: string, at: Date): void {
    const phone = normalizePhone(telefone);
    // Mantém sempre a entrada mais recente.
    db.prepare(
      `INSERT INTO contact_windows (telefone, ultima_entrada_em) VALUES (?, ?)
       ON CONFLICT(telefone) DO UPDATE SET ultima_entrada_em = excluded.ultima_entrada_em
       WHERE excluded.ultima_entrada_em > contact_windows.ultima_entrada_em`,
    ).run(phone, at.toISOString());
  }

  async function send(m: OutgoingMessage): Promise<SendResult> {
    try {
      if (windowOpen(m.telefone)) {
        const { wamid } = await api.sendText(m.telefone, m.texto);
        return { ok: true, wamid, via: 'texto' };
      }
      if (m.template && m.template.nome.trim() !== '') {
        const { wamid } = await api.sendTemplate(m.telefone, m.template.nome, m.template.parametros);
        return { ok: true, wamid, via: 'template' };
      }
      return { ok: false, motivo: 'fora_da_janela' };
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      return { ok: false, motivo: 'erro_api', detalhe };
    }
  }

  return { registerInbound, windowOpen, send };
}
