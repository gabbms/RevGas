-- Cada comprovante pendente pertence a um rascunho (antes do "sim") ou a um pedido agendado.
-- Comprovantes antigos, sem vínculo, nunca mais são repassados.
ALTER TABLE pending_receipts ADD COLUMN rascunho_id INTEGER REFERENCES drafts(id);
ALTER TABLE pending_receipts ADD COLUMN pedido_id INTEGER REFERENCES orders(id);
CREATE INDEX pending_receipts_pedido ON pending_receipts (pedido_id);
