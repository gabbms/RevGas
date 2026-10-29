import type { Db } from '../db/connection.js';
import { localDateKey } from '../domain/hours.js';
import { samePhone } from '../domain/phone.js';
import type { Address, CylinderMode, OrderKind, OrderStatus, PaymentMethod } from '../domain/types.js';

export interface Order {
  id: number;
  clienteId: number;
  tipo: OrderKind;
  quantidade: number;
  modo: CylinderMode;
  pagamento: PaymentMethod;
  trocoParaCentavos: number | null;
  endereco: Address | null;
  unitarioCentavos: number;
  cascoCentavos: number;
  taxaEntregaCentavos: number;
  totalCentavos: number;
  status: OrderStatus;
  entregadorTelefone: string | null;
  precisaRevisao: boolean;
  criadoEm: string;
  enviadoEm: string | null;
  saiuEm: string | null;
  finalizadoEm: string | null;
}

type Row = {
  id: number;
  cliente_id: number;
  tipo: OrderKind;
  quantidade: number;
  modo: CylinderMode;
  pagamento: PaymentMethod;
  troco_para_centavos: number | null;
  endereco_json: string | null;
  unitario_centavos: number;
  casco_centavos: number;
  taxa_entrega_centavos: number;
  total_centavos: number;
  status: OrderStatus;
  entregador_telefone: string | null;
  precisa_revisao: number;
  criado_em: string;
  enviado_em: string | null;
  saiu_em: string | null;
  finalizado_em: string | null;
};

function fromRow(r: Row): Order {
  return {
    id: r.id,
    clienteId: r.cliente_id,
    tipo: r.tipo,
    quantidade: r.quantidade,
    modo: r.modo,
    pagamento: r.pagamento,
    trocoParaCentavos: r.troco_para_centavos,
    endereco: r.endereco_json ? (JSON.parse(r.endereco_json) as Address) : null,
    unitarioCentavos: r.unitario_centavos,
    cascoCentavos: r.casco_centavos,
    taxaEntregaCentavos: r.taxa_entrega_centavos,
    totalCentavos: r.total_centavos,
    status: r.status,
    entregadorTelefone: r.entregador_telefone,
    precisaRevisao: r.precisa_revisao === 1,
    criadoEm: r.criado_em,
    enviadoEm: r.enviado_em,
    saiuEm: r.saiu_em,
    finalizadoEm: r.finalizado_em,
  };
}

export type OrderPatch = Partial<Omit<Order, 'id' | 'clienteId' | 'criadoEm'>>;

const COLUMNS: Record<keyof OrderPatch, string> = {
  tipo: 'tipo',
  quantidade: 'quantidade',
  modo: 'modo',
  pagamento: 'pagamento',
  trocoParaCentavos: 'troco_para_centavos',
  endereco: 'endereco_json',
  unitarioCentavos: 'unitario_centavos',
  cascoCentavos: 'casco_centavos',
  taxaEntregaCentavos: 'taxa_entrega_centavos',
  totalCentavos: 'total_centavos',
  status: 'status',
  entregadorTelefone: 'entregador_telefone',
  precisaRevisao: 'precisa_revisao',
  enviadoEm: 'enviado_em',
  saiuEm: 'saiu_em',
  finalizadoEm: 'finalizado_em',
};

function toColumnValue(key: keyof OrderPatch, v: unknown): string | number | null {
  if (v === null) return null;
  if (key === 'endereco') return JSON.stringify(v);
  if (key === 'precisaRevisao') return v ? 1 : 0;
  return v as string | number;
}

export function insertOrder(db: Db, o: Omit<Order, 'id'>): Order {
  const info = db
    .prepare(
      `INSERT INTO orders (cliente_id, tipo, quantidade, modo, pagamento, troco_para_centavos, endereco_json,
         unitario_centavos, casco_centavos, taxa_entrega_centavos, total_centavos, status, entregador_telefone,
         precisa_revisao, criado_em, enviado_em, saiu_em, finalizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.clienteId,
      o.tipo,
      o.quantidade,
      o.modo,
      o.pagamento,
      o.trocoParaCentavos,
      o.endereco ? JSON.stringify(o.endereco) : null,
      o.unitarioCentavos,
      o.cascoCentavos,
      o.taxaEntregaCentavos,
      o.totalCentavos,
      o.status,
      o.entregadorTelefone,
      o.precisaRevisao ? 1 : 0,
      o.criadoEm,
      o.enviadoEm,
      o.saiuEm,
      o.finalizadoEm,
    );
  return getOrder(db, Number(info.lastInsertRowid))!;
}

export function getOrder(db: Db, id: number): Order | null {
  const r = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function updateOrder(db: Db, id: number, patch: OrderPatch): Order {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of Object.keys(COLUMNS) as (keyof OrderPatch)[]) {
    if (!(key in patch) || patch[key] === undefined) continue;
    sets.push(`${COLUMNS[key]} = ?`);
    values.push(toColumnValue(key, patch[key]));
  }
  if (sets.length > 0) db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  const o = getOrder(db, id);
  if (!o) throw new Error(`pedido ${id} não existe`);
  return o;
}

/** Pedidos criados no dia local `dayKey` (AAAA-MM-DD) do fuso dado, em ordem de criação. */
export function listOrdersByLocalDay(db: Db, dayKey: string, fuso: string): Order[] {
  // Margem de um dia para cada lado em UTC; o filtro exato é feito pelo dia local.
  const day = new Date(`${dayKey}T00:00:00Z`).getTime();
  const from = new Date(day - 86_400_000).toISOString();
  const to = new Date(day + 2 * 86_400_000).toISOString();
  const rows = db
    .prepare('SELECT * FROM orders WHERE criado_em >= ? AND criado_em < ? ORDER BY id')
    .all(from, to) as Row[];
  return rows.filter((r) => localDateKey(new Date(r.criado_em), fuso) === dayKey).map(fromRow);
}

export function openOrdersFor(db: Db, clienteId: number): Order[] {
  const rows = db
    .prepare("SELECT * FROM orders WHERE cliente_id = ? AND status IN ('agendado', 'recebido', 'saiu') ORDER BY id")
    .all(clienteId) as Row[];
  return rows.map(fromRow);
}

/** Pedido mais recente do cliente que não foi cancelado ("o de sempre"). */
export function lastOrderFor(db: Db, clienteId: number): Order | null {
  const r = db
    .prepare("SELECT * FROM orders WHERE cliente_id = ? AND status != 'cancelado' ORDER BY id DESC LIMIT 1")
    .get(clienteId) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Datas das compras concluídas (entregues ou retiradas), da mais antiga para a mais nova. */
export function deliveredOrderDates(db: Db, clienteId: number): Date[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(finalizado_em, criado_em) AS em FROM orders
       WHERE cliente_id = ? AND status IN ('entregue', 'retirado') ORDER BY em, id`,
    )
    .all(clienteId) as { em: string }[];
  return rows.map((r) => new Date(r.em));
}

export function recordOrderMessage(db: Db, wamid: string, orderId: number, telefone: string): void {
  db.prepare('INSERT OR IGNORE INTO order_messages (wamid, order_id, telefone) VALUES (?, ?, ?)').run(
    wamid,
    orderId,
    telefone,
  );
}

export function orderByMessage(db: Db, wamid: string): Order | null {
  const r = db
    .prepare('SELECT o.* FROM orders o JOIN order_messages m ON m.order_id = o.id WHERE m.wamid = ?')
    .get(wamid) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Telefones distintos que receberam alguma mensagem deste pedido, na ordem do primeiro envio. */
export function orderRecipients(db: Db, orderId: number): string[] {
  const rows = db
    .prepare('SELECT telefone FROM order_messages WHERE order_id = ? GROUP BY telefone ORDER BY MIN(rowid)')
    .all(orderId) as { telefone: string }[];
  return rows.map((r) => r.telefone);
}

/** Quantas mensagens deste pedido foram entregues à API (todas as de equipe). */
export function countOrderMessages(db: Db, orderId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM order_messages WHERE order_id = ?').get(orderId) as { n: number }).n;
}

/** Esquece quem recebeu o pedido (usado quando o pedido muda de destino). */
export function forgetOrderMessages(db: Db, orderId: number): void {
  db.prepare('DELETE FROM order_messages WHERE order_id = ?').run(orderId);
}

/** Pedidos em recebido/saiu que tiveram mensagem enviada a este telefone (tolera o 9º dígito). */
export function activeOrdersSentTo(db: Db, telefone: string): Order[] {
  const pairs = db
    .prepare(
      `SELECT DISTINCT m.order_id AS id, m.telefone FROM order_messages m JOIN orders o ON o.id = m.order_id
       WHERE o.status IN ('recebido', 'saiu')`,
    )
    .all() as { id: number; telefone: string }[];
  const ids = [...new Set(pairs.filter((p) => samePhone(p.telefone, telefone)).map((p) => p.id))].sort((a, b) => a - b);
  return ids.map((id) => getOrder(db, id)!);
}
