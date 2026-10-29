import type { Db } from '../db/connection.js';

export interface StoredMessage {
  id: number;
  clienteId: number;
  autor: 'cliente' | 'bot' | 'dono';
  tipo: 'texto' | 'audio' | 'imagem' | 'documento' | 'botao' | 'sistema';
  texto: string;
  wamid: string | null;
  criadoEm: string;
}

type Row = {
  id: number;
  cliente_id: number;
  autor: StoredMessage['autor'];
  tipo: StoredMessage['tipo'];
  texto: string | null;
  wamid: string | null;
  criado_em: string;
};

const fromRow = (r: Row): StoredMessage => ({
  id: r.id,
  clienteId: r.cliente_id,
  autor: r.autor,
  tipo: r.tipo,
  texto: r.texto ?? '',
  wamid: r.wamid,
  criadoEm: r.criado_em,
});

export function insertMessage(db: Db, m: Omit<StoredMessage, 'id'>): StoredMessage {
  const info = db
    .prepare('INSERT INTO messages (cliente_id, autor, tipo, texto, wamid, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
    .run(m.clienteId, m.autor, m.tipo, m.texto, m.wamid, m.criadoEm);
  return { id: Number(info.lastInsertRowid), ...m };
}

/** Últimas `limit` mensagens desde `since`, em ordem cronológica. */
export function recentMessages(db: Db, clienteId: number, since: Date, limit = 40): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE cliente_id = ? AND criado_em >= ? ORDER BY id DESC LIMIT ?')
    .all(clienteId, since.toISOString(), limit) as Row[];
  return rows.reverse().map(fromRow);
}

export function lastCustomerMessageAt(db: Db, clienteId: number): Date | null {
  const r = db
    .prepare("SELECT MAX(criado_em) AS t FROM messages WHERE cliente_id = ? AND autor = 'cliente'")
    .get(clienteId) as { t: string | null };
  return r.t ? new Date(r.t) : null;
}

/** Horário da última mensagem de cada cliente (quem nunca falou não aparece). */
export function lastMessageTimes(db: Db): Map<number, string> {
  const rows = db.prepare('SELECT cliente_id, MAX(criado_em) AS t FROM messages GROUP BY cliente_id').all() as {
    cliente_id: number;
    t: string;
  }[];
  return new Map(rows.map((r) => [r.cliente_id, r.t]));
}
