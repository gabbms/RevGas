import type { Db } from '../db/connection.js';
import { normalizePhone, samePhone } from '../domain/phone.js';
import type { Address } from '../domain/types.js';

export interface Customer {
  id: number;
  telefone: string;
  nome: string | null;
  endereco: Address | null;
  lembretesDesativados: boolean;
  botPausadoAte: string | null;
  ultimaMensagemEm: string | null;
  ultimoLembreteEm: string | null;
  criadoEm: string;
}

type Row = {
  id: number;
  telefone: string;
  nome: string | null;
  endereco_json: string | null;
  lembretes_desativados: number;
  bot_pausado_ate: string | null;
  ultima_mensagem_em: string | null;
  ultimo_lembrete_em: string | null;
  criado_em: string;
};

function fromRow(r: Row): Customer {
  return {
    id: r.id,
    telefone: r.telefone,
    nome: r.nome,
    endereco: r.endereco_json ? (JSON.parse(r.endereco_json) as Address) : null,
    lembretesDesativados: r.lembretes_desativados === 1,
    botPausadoAte: r.bot_pausado_ate,
    ultimaMensagemEm: r.ultima_mensagem_em,
    ultimoLembreteEm: r.ultimo_lembrete_em,
    criadoEm: r.criado_em,
  };
}

export function getCustomer(db: Db, id: number): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Busca exata pelo telefone normalizado; senão, tolera a variante com/sem o 9º dígito. */
export function getCustomerByPhone(db: Db, telefone: string): Customer | null {
  const exact = db.prepare('SELECT * FROM customers WHERE telefone = ?').get(normalizePhone(telefone)) as Row | undefined;
  if (exact) return fromRow(exact);
  const rows = db.prepare('SELECT * FROM customers').all() as Row[];
  const found = rows.find((r) => samePhone(r.telefone, telefone));
  return found ? fromRow(found) : null;
}

export function upsertCustomerByPhone(db: Db, telefone: string, now: Date): Customer {
  const existing = getCustomerByPhone(db, telefone);
  if (existing) return existing;
  const info = db
    .prepare('INSERT INTO customers (telefone, criado_em) VALUES (?, ?)')
    .run(normalizePhone(telefone), now.toISOString());
  return getCustomer(db, Number(info.lastInsertRowid))!;
}

export type CustomerPatch = Partial<
  Pick<Customer, 'nome' | 'endereco' | 'lembretesDesativados' | 'botPausadoAte' | 'ultimaMensagemEm' | 'ultimoLembreteEm'>
>;

const COLUMNS: Record<keyof CustomerPatch, string> = {
  nome: 'nome',
  endereco: 'endereco_json',
  lembretesDesativados: 'lembretes_desativados',
  botPausadoAte: 'bot_pausado_ate',
  ultimaMensagemEm: 'ultima_mensagem_em',
  ultimoLembreteEm: 'ultimo_lembrete_em',
};

export function updateCustomer(db: Db, id: number, patch: CustomerPatch): Customer {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of Object.keys(COLUMNS) as (keyof CustomerPatch)[]) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const v = patch[key];
    sets.push(`${COLUMNS[key]} = ?`);
    if (key === 'endereco') values.push(v === null ? null : JSON.stringify(v));
    else if (key === 'lembretesDesativados') values.push(v ? 1 : 0);
    else values.push(v as string | null);
  }
  if (sets.length > 0) db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const c = getCustomer(db, id);
  if (!c) throw new Error(`cliente ${id} não existe`);
  return c;
}

export function listCustomers(db: Db): Customer[] {
  return (db.prepare('SELECT * FROM customers ORDER BY id').all() as Row[]).map(fromRow);
}

/**
 * Exclusão de dados (LGPD), numa transação: apaga mensagens, rascunhos, alertas e comprovantes pendentes, zera o endereço dos
 * pedidos e anonimiza o cliente. As linhas de `order_messages` ficam: guardam telefones de entregadores.
 */
export function deleteCustomerData(db: Db, id: number): void {
  db.transaction(() => {
    const c = db.prepare('SELECT telefone FROM customers WHERE id = ?').get(id) as { telefone: string } | undefined;
    if (!c) return;
    db.prepare('DELETE FROM messages WHERE cliente_id = ?').run(id);
    // Os comprovantes antes dos rascunhos: apontam para eles.
    db.prepare('DELETE FROM pending_receipts WHERE cliente_id = ?').run(id);
    db.prepare('DELETE FROM drafts WHERE cliente_id = ?').run(id);
    db.prepare('DELETE FROM alerts WHERE cliente_id = ?').run(id);
    db.prepare('DELETE FROM contact_windows WHERE telefone = ?').run(c.telefone);
    db.prepare('UPDATE orders SET endereco_json = NULL WHERE cliente_id = ?').run(id);
    db.prepare(
      `UPDATE customers SET telefone = ?, nome = NULL, endereco_json = NULL, lembretes_desativados = 1,
         bot_pausado_ate = NULL WHERE id = ?`,
    ).run(`excluido-${id}`, id);
  })();
}
