-- Quando o resumo do rascunho chegou ao cliente, e se ele foi trocado por um resumo mais novo.
ALTER TABLE drafts ADD COLUMN apresentado_em TEXT;
ALTER TABLE drafts ADD COLUMN substituido_em TEXT;
