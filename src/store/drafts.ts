import type { Db } from '../db/connection.js';
import type { OrderRequest } from '../domain/order-validation.js';

export interface Draft {
  id: number;
  clienteId: number;
  request: OrderRequest;
  totalCentavos: number;
  criadoEm: string;
  consumidoEm: string | null;
}

type Row = {
  id: number;
  cliente_id: number;
  payload_json: string;
  total_centavos: number;
  criado_em: string;
  consumido_em: string | null;
};

const fromRow = (r: Row): Draft => ({
  id: r.id,
  clienteId: r.cliente_id,
  request: JSON.parse(r.payload_json) as OrderRequest,
  totalCentavos: r.total_centavos,
  criadoEm: r.criado_em,
  consumidoEm: r.consumido_em,
});

const GAS_DO_POVO_WINDOW_MS = 2 * 60 * 60 * 1000;

export function createDraft(db: Db, clienteId: number, request: OrderRequest, totalCentavos: number, now: Date): Draft {
  const info = db
    .prepare('INSERT INTO drafts (cliente_id, payload_json, total_centavos, criado_em) VALUES (?, ?, ?, ?)')
    .run(clienteId, JSON.stringify(request), totalCentavos, now.toISOString());
  return getDraft(db, Number(info.lastInsertRowid))!;
}

export function getDraft(db: Db, id: number): Draft | null {
  const r = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function consumeDraft(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE drafts SET consumido_em = ? WHERE id = ? AND consumido_em IS NULL').run(now.toISOString(), id);
}

/** Há rascunho não consumido, de até 2h, pago com Gás do Povo? */
export function hasRecentGasDoPovoDraft(db: Db, clienteId: number, now: Date): boolean {
  const since = new Date(now.getTime() - GAS_DO_POVO_WINDOW_MS).toISOString();
  const rows = db
    .prepare('SELECT * FROM drafts WHERE cliente_id = ? AND consumido_em IS NULL AND criado_em >= ?')
    .all(clienteId, since) as Row[];
  return rows.some((r) => fromRow(r).request.pagamento === 'gas_do_povo');
}
