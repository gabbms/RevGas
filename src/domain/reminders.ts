import type { Db } from '../db/connection.js';
import { listCustomers, updateCustomer } from '../store/customers.js';
import { insertMessage } from '../store/messages.js';
import { deliveredOrderDates, openOrdersFor } from '../store/orders.js';
import type { StoreSettings } from '../store/settings.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import { localHour, isOpen } from './hours.js';
import { formatBRL } from './money.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Última entrega + média dos intervalos entre entregas. Precisa de pelo menos 2 datas. */
export function nextReorderDate(datas: Date[]): Date | null {
  if (datas.length < 2) return null;
  const t = datas.map((x) => x.getTime()).sort((a, b) => a - b);
  const first = t[0]!;
  const last = t[t.length - 1]!;
  const mean = (last - first) / (t.length - 1);
  return new Date(last + mean);
}

export interface ReminderInput {
  entregas: Date[];
  ultimoLembreteEm: Date | null;
  temPedidoAberto: boolean;
  lembretesDesativados: boolean;
}

export function dueForReminder(i: ReminderInput, now: Date, margemDias = 2): boolean {
  if (i.lembretesDesativados || i.temPedidoAberto) return false;
  const next = nextReorderDate(i.entregas);
  if (!next) return false;
  if (now.getTime() < next.getTime() - margemDias * DAY_MS) return false;
  const ultimaEntrega = Math.max(...i.entregas.map((x) => x.getTime()));
  return i.ultimoLembreteEm === null || i.ultimoLembreteEm.getTime() < ultimaEntrega;
}

export const REMINDER_TEXT = (nome: string | null, preco: string): string =>
  `Oi${nome ? `, ${nome}` : ''}! Pelo seu histórico, seu gás deve estar acabando nos próximos dias 🔥 Quer que eu já mande um P13 (${preco})? Responda "sim" que eu preparo o pedido.`;

export interface ReminderJobDeps {
  db: Db;
  outbox: Pick<ReturnType<typeof createOutbox>, 'send'>;
  settings: () => StoreSettings;
  templateLembrete?: string;
  clock: () => Date;
}

export async function runReminderJob(d: ReminderJobDeps): Promise<number> {
  const now = d.clock();
  const s = d.settings();
  if (!s.lembretesAtivos || s.precoRecargaCentavos <= 0 || !isOpen(s, now)) return 0;
  const hora = localHour(now, s.fuso);
  if (hora < 9 || hora >= 11) return 0;

  const preco = formatBRL(s.precoRecargaCentavos);
  let enviados = 0;
  for (const c of listCustomers(d.db)) {
    if (c.telefone.startsWith('excluido-') || c.ultimaMensagemEm === null) continue;
    const due = dueForReminder(
      {
        entregas: deliveredOrderDates(d.db, c.id),
        ultimoLembreteEm: c.ultimoLembreteEm ? new Date(c.ultimoLembreteEm) : null,
        temPedidoAberto: openOrdersFor(d.db, c.id).length > 0,
        lembretesDesativados: c.lembretesDesativados,
      },
      now,
    );
    if (!due) continue;
    const texto = REMINDER_TEXT(c.nome, preco);
    const r = await d.outbox.send({
      telefone: c.telefone,
      texto,
      ...(d.templateLembrete ? { template: { nome: d.templateLembrete, parametros: [c.nome ?? 'tudo bem', preco] } } : {}),
    });
    if (!r.ok) continue;
    insertMessage(d.db, { clienteId: c.id, autor: 'bot', tipo: 'texto', texto, wamid: r.wamid, criadoEm: now.toISOString() });
    updateCustomer(d.db, c.id, { ultimoLembreteEm: now.toISOString() });
    enviados++;
  }
  return enviados;
}
