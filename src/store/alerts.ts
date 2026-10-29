import type { Db } from '../db/connection.js';

export interface Alert {
  id: number;
  clienteId: number | null;
  pedidoId: number | null;
  motivo: string;
  resumo: string;
  criadoEm: string;
  resolvidoEm: string | null;
}

type Row = {
  id: number;
  cliente_id: number | null;
  pedido_id: number | null;
  motivo: string;
  resumo: string;
  criado_em: string;
  resolvido_em: string | null;
};

function fromRow(r: Row): Alert {
  return {
    id: r.id,
    clienteId: r.cliente_id,
    pedidoId: r.pedido_id,
    motivo: r.motivo,
    resumo: r.resumo,
    criadoEm: r.criado_em,
    resolvidoEm: r.resolvido_em,
  };
}

export function insertAlert(
  db: Db,
  a: { clienteId: number | null; pedidoId: number | null; motivo: string; resumo: string },
  now: Date,
): Alert {
  const info = db
    .prepare('INSERT INTO alerts (cliente_id, pedido_id, motivo, resumo, criado_em) VALUES (?, ?, ?, ?, ?)')
    .run(a.clienteId, a.pedidoId, a.motivo, a.resumo, now.toISOString());
  return fromRow(db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(info.lastInsertRowid)) as Row);
}

/** Alertas não resolvidos, do mais novo para o mais antigo. */
export function listOpenAlerts(db: Db): Alert[] {
  return (
    db.prepare('SELECT * FROM alerts WHERE resolvido_em IS NULL ORDER BY criado_em DESC, id DESC').all() as Row[]
  ).map(fromRow);
}

export function resolveAlert(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE alerts SET resolvido_em = ? WHERE id = ? AND resolvido_em IS NULL').run(now.toISOString(), id);
}
