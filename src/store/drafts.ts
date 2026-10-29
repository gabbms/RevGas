import type { Db } from '../db/connection.js';
import type { OrderRequest } from '../domain/order-validation.js';

/** Condições da loja que o resumo mostrou ao cliente, além do total. */
export interface DraftConditions {
  agendado: boolean;
  /** Chave Pix mostrada no resumo (só no Pix antecipado; senão null). */
  chavePix: string | null;
}

export interface Draft {
  id: number;
  clienteId: number;
  request: OrderRequest;
  /** null em rascunhos gravados antes de as condições existirem. */
  condicoes: DraftConditions | null;
  totalCentavos: number;
  criadoEm: string;
  /** Quando a resposta com o resumo foi enviada ao cliente. */
  apresentadoEm: string | null;
  consumidoEm: string | null;
  /** Preenchido quando um resumo mais novo do mesmo cliente tomou o lugar deste. */
  substituidoEm: string | null;
}

type Row = {
  id: number;
  cliente_id: number;
  payload_json: string;
  total_centavos: number;
  criado_em: string;
  apresentado_em: string | null;
  consumido_em: string | null;
  substituido_em: string | null;
};

type Payload = { request: OrderRequest; condicoes: DraftConditions };

function parsePayload(json: string): { request: OrderRequest; condicoes: DraftConditions | null } {
  const p = JSON.parse(json) as Payload | OrderRequest;
  // Formato antigo: o payload era o próprio OrderRequest.
  if ('request' in p) return { request: p.request, condicoes: p.condicoes ?? null };
  return { request: p, condicoes: null };
}

const fromRow = (r: Row): Draft => ({
  id: r.id,
  clienteId: r.cliente_id,
  ...parsePayload(r.payload_json),
  totalCentavos: r.total_centavos,
  criadoEm: r.criado_em,
  apresentadoEm: r.apresentado_em,
  consumidoEm: r.consumido_em,
  substituidoEm: r.substituido_em,
});

const RECENT_DRAFT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function createDraft(
  db: Db,
  clienteId: number,
  request: OrderRequest,
  totalCentavos: number,
  now: Date,
  condicoes: DraftConditions = { agendado: false, chavePix: null },
): Draft {
  const payload: Payload = { request, condicoes };
  const info = db
    .prepare('INSERT INTO drafts (cliente_id, payload_json, total_centavos, criado_em) VALUES (?, ?, ?, ?)')
    .run(clienteId, JSON.stringify(payload), totalCentavos, now.toISOString());
  return getDraft(db, Number(info.lastInsertRowid))!;
}

export function getDraft(db: Db, id: number): Draft | null {
  const r = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function consumeDraft(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE drafts SET consumido_em = ? WHERE id = ? AND consumido_em IS NULL').run(now.toISOString(), id);
}

/** Tira de uso todos os rascunhos abertos do cliente (um resumo novo vai tomar o lugar deles). */
export function supersedeOpenDrafts(db: Db, clienteId: number, now: Date): void {
  const at = now.toISOString();
  db.prepare(
    'UPDATE drafts SET consumido_em = ?, substituido_em = ? WHERE cliente_id = ? AND consumido_em IS NULL',
  ).run(at, at, clienteId);
}

/** Rascunho aberto (não consumido nem substituído) mais recente do cliente. */
export function latestOpenDraft(db: Db, clienteId: number): Draft | null {
  const r = db
    .prepare(
      'SELECT * FROM drafts WHERE cliente_id = ? AND consumido_em IS NULL AND substituido_em IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(clienteId) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Marca como apresentados os rascunhos abertos do cliente; chamado logo depois de a resposta sair. */
export function markDraftsPresented(db: Db, clienteId: number, at: Date): void {
  db.prepare(
    'UPDATE drafts SET apresentado_em = ? WHERE cliente_id = ? AND consumido_em IS NULL AND apresentado_em IS NULL',
  ).run(at.toISOString(), clienteId);
}

/** Há rascunho aberto (não consumido nem substituído), de até 2h, com este pagamento? */
function hasRecentOpenDraftPaidWith(db: Db, clienteId: number, pagamento: OrderRequest['pagamento'], now: Date): boolean {
  const since = new Date(now.getTime() - RECENT_DRAFT_WINDOW_MS).toISOString();
  const rows = db
    .prepare('SELECT * FROM drafts WHERE cliente_id = ? AND consumido_em IS NULL AND criado_em >= ?')
    .all(clienteId, since) as Row[];
  return rows.some((r) => fromRow(r).request.pagamento === pagamento);
}

/** Há rascunho não consumido, de até 2h, pago com Gás do Povo? */
export function hasRecentGasDoPovoDraft(db: Db, clienteId: number, now: Date): boolean {
  return hasRecentOpenDraftPaidWith(db, clienteId, 'gas_do_povo', now);
}

/** Há rascunho não consumido, de até 2h, com Pix antecipado? (o comprovante pode chegar antes do "sim") */
export function hasRecentPixAntecipadoDraft(db: Db, clienteId: number, now: Date): boolean {
  return hasRecentOpenDraftPaidWith(db, clienteId, 'pix_antecipado', now);
}
