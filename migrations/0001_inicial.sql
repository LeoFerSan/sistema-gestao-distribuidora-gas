-- MOS Campinho · esquema inicial (MVP)
-- Datas em milissegundos desde 1970 (UTC).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('fundadora','ceo','atendimento')),
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  pass_iter     INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  must_change   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- SHA-256 do token; o token em si só existe no cookie
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  user_id  INTEGER,
  username TEXT,
  action   TEXT NOT NULL,
  detail   TEXT,
  ip       TEXT
);

CREATE TABLE stock (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  full_qty   INTEGER NOT NULL DEFAULT 0,
  empty_qty  INTEGER,                    -- NULL = item sem vasilhame (acessório)
  min_qty    INTEGER,                    -- NULL = mínimo ainda não definido
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  stock_key      TEXT REFERENCES stock(key),   -- NULL = sob encomenda
  returns_empty  INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE riders (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name    TEXT NOT NULL,
  phone          TEXT,
  address        TEXT NOT NULL,
  distance       TEXT NOT NULL CHECK (distance IN ('perto','medio','longe')),
  payment        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('recebido','preparo','rota','entregue','cancelado')),
  rider          TEXT,
  created_at     INTEGER NOT NULL,
  stage_at       INTEGER NOT NULL,
  done_at        INTEGER,
  cancel_reason  TEXT,
  created_by     INTEGER REFERENCES users(id)
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);

CREATE TABLE order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  product_code  TEXT NOT NULL REFERENCES products(code),
  qty           INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX idx_items_order ON order_items(order_id);

CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  at         INTEGER NOT NULL,
  user_id    INTEGER,
  user_name  TEXT,
  message    TEXT NOT NULL
);
CREATE INDEX idx_events_order ON order_events(order_id);

-- Toda movimentação de estoque fica registrada (M0: registrar os fatos).
CREATE TABLE stock_moves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  stock_key    TEXT NOT NULL REFERENCES stock(key),
  delta_full   INTEGER NOT NULL DEFAULT 0,
  delta_empty  INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL,
  order_id     INTEGER REFERENCES orders(id),
  user_id      INTEGER
);

-- ---------- Dados de partida (referências do MOS, M5) ----------
INSERT INTO stock (key, name, full_qty, empty_qty, min_qty, sort) VALUES
  ('P13',  'GLP P13',          300, 160, 100, 1),
  ('P20',  'GLP P20',           10,   5,   3, 2),
  ('P45',  'GLP P45',           10,  10,   5, 3),
  ('AGUA', 'Água galão 20 L',    0,   0, NULL, 4),
  ('REG',  'Regulador',          0, NULL, NULL, 5),
  ('MANG', 'Mangueira',          0, NULL, NULL, 6);

INSERT INTO products (code, label, stock_key, returns_empty, sort) VALUES
  ('P13T', 'P13 (troca)',                 'P13',  1, 1),
  ('P13C', 'P13 completo (+ vasilhame)',  'P13',  0, 2),
  ('P20T', 'P20 (troca)',                 'P20',  1, 3),
  ('P45T', 'P45 (troca)',                 'P45',  1, 4),
  ('P5E',  'P5 (sob encomenda)',          NULL,   0, 5),
  ('AG20', 'Água 20 L (troca)',           'AGUA', 1, 6),
  ('REG',  'Regulador',                   'REG',  0, 7),
  ('MANG', 'Mangueira',                   'MANG', 0, 8);

INSERT INTO riders (name) VALUES ('Moto 01'), ('Moto 02'), ('Moto 03');
