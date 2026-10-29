-- Comprovantes Pix que chegaram antes de o pedido ir aos entregadores; repassados no despacho.
CREATE TABLE pending_receipts (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES customers(id),
  media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document')),
  recebido_em TEXT NOT NULL,
  repassado_em TEXT
);
CREATE INDEX pending_receipts_cliente ON pending_receipts (cliente_id, repassado_em);
