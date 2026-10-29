import { expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { upsertCustomerByPhone } from '../../src/store/customers.js';
import {
  consumeDraft,
  createDraft,
  getDraft,
  markDraftsPresented,
  supersedeOpenDrafts,
} from '../../src/store/drafts.js';
import type { OrderRequest } from '../../src/domain/order-validation.js';

const now = new Date('2026-11-02T13:00:00Z');
const later = new Date('2026-11-02T13:00:10Z');
const req: OrderRequest = { quantidade: 1, modo: 'troca', pagamento: 'cartao' };

function setup() {
  const db = openDb(':memory:');
  const a = upsertCustomerByPhone(db, '5586988887777', now);
  const b = upsertCustomerByPhone(db, '5586977776666', now);
  return { db, a, b };
}

test('guarda request e condições e começa sem apresentação', () => {
  const { db, a } = setup();
  const d = createDraft(db, a.id, req, 11500, now, { agendado: true, chavePix: 'chave' });
  expect(getDraft(db, d.id)).toMatchObject({
    request: req,
    condicoes: { agendado: true, chavePix: 'chave' },
    apresentadoEm: null,
    consumidoEm: null,
    substituidoEm: null,
  });
});

test('lê rascunho no formato antigo (payload = request)', () => {
  const { db, a } = setup();
  db.prepare('INSERT INTO drafts (cliente_id, payload_json, total_centavos, criado_em) VALUES (?, ?, ?, ?)').run(
    a.id,
    JSON.stringify(req),
    11500,
    now.toISOString(),
  );
  expect(getDraft(db, 1)).toMatchObject({ request: req, condicoes: null });
});

test('markDraftsPresented marca só os abertos do cliente sem apresentação', () => {
  const { db, a, b } = setup();
  const d1 = createDraft(db, a.id, req, 11500, now);
  markDraftsPresented(db, a.id, now);
  const d2 = createDraft(db, a.id, req, 11500, now);
  const usado = createDraft(db, a.id, req, 11500, now);
  consumeDraft(db, usado.id, now);
  const outro = createDraft(db, b.id, req, 11500, now);
  markDraftsPresented(db, a.id, later);
  expect(getDraft(db, d1.id)!.apresentadoEm).toBe(now.toISOString());
  expect(getDraft(db, d2.id)!.apresentadoEm).toBe(later.toISOString());
  expect(getDraft(db, usado.id)!.apresentadoEm).toBeNull();
  expect(getDraft(db, outro.id)!.apresentadoEm).toBeNull();
});

test('supersedeOpenDrafts consome e marca como substituídos só os abertos do cliente', () => {
  const { db, a, b } = setup();
  const aberto = createDraft(db, a.id, req, 11500, now);
  const usado = createDraft(db, a.id, req, 11500, now);
  consumeDraft(db, usado.id, now);
  const outro = createDraft(db, b.id, req, 11500, now);
  supersedeOpenDrafts(db, a.id, later);
  expect(getDraft(db, aberto.id)).toMatchObject({ consumidoEm: later.toISOString(), substituidoEm: later.toISOString() });
  expect(getDraft(db, usado.id)).toMatchObject({ consumidoEm: now.toISOString(), substituidoEm: null });
  expect(getDraft(db, outro.id)).toMatchObject({ consumidoEm: null, substituidoEm: null });
});
