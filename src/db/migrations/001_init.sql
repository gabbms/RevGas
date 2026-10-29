CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  telefone TEXT NOT NULL UNIQUE,
  nome TEXT,
  endereco_json TEXT,
  lembretes_desativados INTEGER NOT NULL DEFAULT 0,
  bot_pausado_ate TEXT,
  ultima_mensagem_em TEXT,
  ultimo_lembrete_em TEXT,
  criado_em TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES customers(id),
  autor TEXT NOT NULL CHECK (autor IN ('cliente', 'bot', 'dono')),
  tipo TEXT NOT NULL,
  texto TEXT,
  wamid TEXT UNIQUE,
  criado_em TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES customers(id),
  tipo TEXT NOT NULL,
  quantidade INTEGER NOT NULL,
  modo TEXT NOT NULL,
  pagamento TEXT NOT NULL,
  troco_para_centavos INTEGER,
  endereco_json TEXT,
  unitario_centavos INTEGER NOT NULL,
  casco_centavos INTEGER NOT NULL DEFAULT 0,
  taxa_entrega_centavos INTEGER NOT NULL DEFAULT 0,
  total_centavos INTEGER NOT NULL,
  status TEXT NOT NULL,
  entregador_telefone TEXT,
  precisa_revisao INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  enviado_em TEXT,
  saiu_em TEXT,
  finalizado_em TEXT
);

CREATE TABLE order_messages (
  wamid TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  telefone TEXT NOT NULL
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES customers(id),
  payload_json TEXT NOT NULL,
  total_centavos INTEGER NOT NULL,
  criado_em TEXT NOT NULL,
  consumido_em TEXT
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER REFERENCES customers(id),
  pedido_id INTEGER REFERENCES orders(id),
  motivo TEXT NOT NULL,
  resumo TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  resolvido_em TEXT
);

CREATE TABLE contact_windows (
  telefone TEXT PRIMARY KEY,
  ultima_entrada_em TEXT NOT NULL
);

CREATE TABLE inbound_seen (
  wamid TEXT PRIMARY KEY,
  em TEXT NOT NULL
);

CREATE INDEX idx_messages_cliente ON messages(cliente_id, id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_cliente ON orders(cliente_id);
