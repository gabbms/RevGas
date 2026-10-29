import type { Db } from '../db/connection.js';

/** Comprovante Pix que chegou antes de o pedido ir aos entregadores (mídia já reenviada à Meta). */
export interface PendingReceipt {
  id: number;
  clienteId: number;
  /** Id da mídia no nosso número (upload feito ao receber), pronto para `sendMedia`. */
  mediaId: string;
  kind: 'image' | 'document';
  recebidoEm: string;
  /** Quando o despacho do pedido tratou o comprovante; null enquanto espera o pedido. */
  repassadoEm: string | null;
  /** Rascunho Pix aberto quando o comprovante chegou (antes do "sim"). */
  rascunhoId: number | null;
  /** Pedido a que o comprovante pertence: o agendado, ou o criado a partir do rascunho. */
  pedidoId: number | null;
}

type Row = {
  id: number;
  cliente_id: number;
  media_id: string;
  kind: 'image' | 'document';
  recebido_em: string;
  repassado_em: string | null;
  rascunho_id: number | null;
  pedido_id: number | null;
};

const fromRow = (r: Row): PendingReceipt => ({
  id: r.id,
  clienteId: r.cliente_id,
  mediaId: r.media_id,
  kind: r.kind,
  recebidoEm: r.recebido_em,
  repassadoEm: r.repassado_em,
  rascunhoId: r.rascunho_id,
  pedidoId: r.pedido_id,
});

/** Guarda o comprovante ligado a um rascunho ou a um pedido agendado (exatamente um dos dois). */
export function insertPendingReceipt(db: Db, r: Omit<PendingReceipt, 'id' | 'repassadoEm'>): PendingReceipt {
  if ((r.rascunhoId === null) === (r.pedidoId === null)) throw new Error('comprovante precisa de rascunho ou pedido');
  const info = db
    .prepare(
      'INSERT INTO pending_receipts (cliente_id, media_id, kind, recebido_em, rascunho_id, pedido_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(r.clienteId, r.mediaId, r.kind, r.recebidoEm, r.rascunhoId, r.pedidoId);
  return { id: Number(info.lastInsertRowid), ...r, repassadoEm: null };
}

/** Todos os comprovantes do cliente, em ordem de chegada. */
export function receiptsFor(db: Db, clienteId: number): PendingReceipt[] {
  return (db.prepare('SELECT * FROM pending_receipts WHERE cliente_id = ? ORDER BY id').all(clienteId) as Row[]).map(fromRow);
}

/** Comprovantes do pedido que ainda não foram repassados. */
export function pendingReceiptsForOrder(db: Db, pedidoId: number): PendingReceipt[] {
  return (
    db.prepare('SELECT * FROM pending_receipts WHERE pedido_id = ? AND repassado_em IS NULL ORDER BY id').all(pedidoId) as Row[]
  ).map(fromRow);
}

/**
 * Pedido criado a partir do rascunho aberto do cliente: os comprovantes desse rascunho passam ao pedido.
 * Comprovantes de rascunhos substituídos ou consumidos ficam onde estão e não são repassados.
 */
export function attachOpenDraftReceipts(db: Db, clienteId: number, pedidoId: number): void {
  db.prepare(
    `UPDATE pending_receipts SET pedido_id = ?
       WHERE pedido_id IS NULL AND repassado_em IS NULL AND rascunho_id = (
         SELECT id FROM drafts WHERE cliente_id = ? AND consumido_em IS NULL AND substituido_em IS NULL ORDER BY id DESC LIMIT 1
       )`,
  ).run(pedidoId, clienteId);
}

/**
 * Resumo novo com Pix antecipado (ex.: o cliente mudou a quantidade depois de pagar): os comprovantes
 * recentes dos rascunhos anteriores passam ao rascunho novo. Os de mais de `maxAgeMs` ficam para trás.
 */
export function moveReceiptsToDraft(db: Db, clienteId: number, rascunhoId: number, now: Date, maxAgeMs: number): void {
  const since = new Date(now.getTime() - maxAgeMs).toISOString();
  db.prepare(
    `UPDATE pending_receipts SET rascunho_id = ?
       WHERE cliente_id = ? AND pedido_id IS NULL AND repassado_em IS NULL AND rascunho_id IS NOT NULL AND recebido_em >= ?`,
  ).run(rascunhoId, clienteId, since);
}

export function markReceiptForwarded(db: Db, id: number, at: Date): void {
  db.prepare('UPDATE pending_receipts SET repassado_em = ? WHERE id = ? AND repassado_em IS NULL').run(at.toISOString(), id);
}
