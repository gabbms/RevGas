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
}

type Row = {
  id: number;
  cliente_id: number;
  media_id: string;
  kind: 'image' | 'document';
  recebido_em: string;
  repassado_em: string | null;
};

const fromRow = (r: Row): PendingReceipt => ({
  id: r.id,
  clienteId: r.cliente_id,
  mediaId: r.media_id,
  kind: r.kind,
  recebidoEm: r.recebido_em,
  repassadoEm: r.repassado_em,
});

export function insertPendingReceipt(db: Db, r: Omit<PendingReceipt, 'id' | 'repassadoEm'>): PendingReceipt {
  const info = db
    .prepare('INSERT INTO pending_receipts (cliente_id, media_id, kind, recebido_em) VALUES (?, ?, ?, ?)')
    .run(r.clienteId, r.mediaId, r.kind, r.recebidoEm);
  return { id: Number(info.lastInsertRowid), ...r, repassadoEm: null };
}

/** Todos os comprovantes do cliente, em ordem de chegada. */
export function receiptsFor(db: Db, clienteId: number): PendingReceipt[] {
  return (db.prepare('SELECT * FROM pending_receipts WHERE cliente_id = ? ORDER BY id').all(clienteId) as Row[]).map(fromRow);
}

/** Comprovantes do cliente que ainda esperam o pedido. */
export function pendingReceiptsFor(db: Db, clienteId: number): PendingReceipt[] {
  return receiptsFor(db, clienteId).filter((r) => r.repassadoEm === null);
}

export function markReceiptForwarded(db: Db, id: number, at: Date): void {
  db.prepare('UPDATE pending_receipts SET repassado_em = ? WHERE id = ? AND repassado_em IS NULL').run(at.toISOString(), id);
}
