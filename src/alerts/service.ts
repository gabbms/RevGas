import type { Db } from '../db/connection.js';
import type { StoreSettings } from '../store/settings.js';
import { getCustomer } from '../store/customers.js';
import { insertAlert, listOpenAlerts, resolveAlert, type Alert } from '../store/alerts.js';
import type { createOutbox } from '../whatsapp/outbox.js';

export type { Alert };

export function createAlertService(d: {
  db: Db;
  outbox: ReturnType<typeof createOutbox>;
  settings: () => StoreSettings;
  /** URL pública do painel; a barra final é ignorada. */
  publicUrl: string;
  templateAlerta?: string;
  clock: () => Date;
}) {
  const baseUrl = d.publicUrl.replace(/\/+$/, '');

  async function create(a: { clienteId?: number; pedidoId?: number; motivo: string; resumo: string }): Promise<Alert> {
    const alert = insertAlert(
      d.db,
      { clienteId: a.clienteId ?? null, pedidoId: a.pedidoId ?? null, motivo: a.motivo, resumo: a.resumo },
      d.clock(),
    );

    const dono = d.settings().telefoneDono;
    if (dono.trim() === '') return alert;

    try {
      const rest: string[] = [];
      if (a.resumo.trim() !== '') rest.push(a.resumo);
      if (a.clienteId !== undefined) {
        const c = getCustomer(d.db, a.clienteId);
        if (c) rest.push(`Cliente: ${c.nome ? `${c.nome} (${c.telefone})` : c.telefone}`);
      }
      if (a.pedidoId !== undefined) rest.push(`Pedido #${a.pedidoId}`);
      if (a.clienteId !== undefined) rest.push(`${baseUrl}/painel/conversas/${a.clienteId}`);

      const texto = [`⚠️ ${a.motivo}`, ...rest].join('\n');
      const parametros = [a.motivo, rest.join(' | ').replace(/\s*\n\s*/g, ' ')];
      const result = await d.outbox.send({
        telefone: dono,
        texto,
        ...(d.templateAlerta ? { template: { nome: d.templateAlerta, parametros } } : {}),
      });
      if (!result.ok) console.error('alertas: falha ao avisar o dono', alert.id, result.motivo);
    } catch (err) {
      console.error('alertas: erro ao avisar o dono', alert.id, err instanceof Error ? err.name : 'erro');
    }
    return alert;
  }

  return {
    create,
    listOpen: (): Alert[] => listOpenAlerts(d.db),
    resolve: (id: number): void => resolveAlert(d.db, id, d.clock()),
  };
}

export type AlertService = ReturnType<typeof createAlertService>;
