-- D1-2: perfil Comercial (Laura), origens, clientes, leads, arquivos, avisos (sininho)
-- e vendas para a produção (painel da Jô) com checklist.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'comercial', 'lead', 'financeiro', 'producao'));

-- Origens (lista editável em Cadastros e configurações)
CREATE TABLE origins (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX origins_name_unique ON origins (lower(name));
INSERT INTO origins (name, position) VALUES
  ('Prospecção', 1), ('Site Brindes DoBoni', 2), ('WhatsApp', 3), ('Instagram', 4), ('TikTok', 5),
  ('Shopee – Lucmarix', 6), ('Shopee – Bexlu', 7), ('Shopee – JL Imports', 8), ('Shopee – Brindes Bexlu', 9),
  ('Outras lojas', 10);

-- Cliente único: a chave é o telefone (só dígitos, com DDD)
CREATE TABLE customers (
  id         serial PRIMARY KEY,
  phone      text NOT NULL UNIQUE,
  name       text,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Arquivos (print do lead, arte da venda) guardados no próprio banco
CREATE TABLE files (
  id         serial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('print_lead', 'arte_venda')),
  filename   text NOT NULL,
  mime       text NOT NULL,
  size       integer NOT NULL,
  data       bytea NOT NULL,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id            serial PRIMARY KEY,
  customer_id   integer NOT NULL REFERENCES customers(id),
  origin_id     integer NOT NULL REFERENCES origins(id),
  channel       text NOT NULL DEFAULT 'manual',   -- manual, site, instagram, whatsapp (webhooks nas próximas etapas)
  stage         text NOT NULL DEFAULT 'novo_lead',
  product       text,
  quantity      integer,
  notes         text,
  print_file_id integer REFERENCES files(id),
  lost_reason   text,
  score         integer,                          -- pontuação do SDR (próximas etapas)
  data          jsonb NOT NULL DEFAULT '{}'::jsonb, -- respostas de qualificação etc.
  assigned_to   integer REFERENCES users(id),
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_created_idx ON leads (created_at DESC);
CREATE INDEX leads_customer_idx ON leads (customer_id);
CREATE INDEX leads_creator_idx ON leads (created_by, created_at DESC);

-- Avisos internos (sininho)
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id),
  title      text NOT NULL,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

-- Vendas enviadas para a produção (painel da Jô)
CREATE TABLE sales (
  id            serial PRIMARY KEY,
  code          text NOT NULL,
  customer_id   integer REFERENCES customers(id),
  customer_name text NOT NULL,
  lead_id       integer REFERENCES leads(id),
  origin_id     integer NOT NULL REFERENCES origins(id),
  product       text NOT NULL,
  product_code  text,
  color         text,
  quantity      integer NOT NULL CHECK (quantity > 0),
  font          text,
  names         text,          -- um nome por linha
  art_file_id   integer REFERENCES files(id),
  notes         text,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando', 'em_producao', 'pausada', 'concluida')),
  pause_reason  text,
  weight_kg     numeric(8,3),
  height_cm     numeric(8,1),
  width_cm      numeric(8,1),
  length_cm     numeric(8,1),
  completed_at  timestamptz,
  completed_by  integer REFERENCES users(id),
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_code_unique ON sales (lower(code));
CREATE INDEX sales_status_due_idx ON sales (status, due_date);

-- Checklist da produção: cada item grava quem marcou e quando
CREATE TABLE sale_checklist (
  sale_id integer NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item    integer NOT NULL CHECK (item BETWEEN 1 AND 9),
  done_by integer NOT NULL REFERENCES users(id),
  done_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id, item)
);
