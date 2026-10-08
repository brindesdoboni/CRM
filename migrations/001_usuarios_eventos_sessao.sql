-- Etapa 1: usuários, perfis, histórico (eventos) e sessões de login.

CREATE TABLE users (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'lead', 'financeiro', 'producao')),
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Histórico de tudo que é importante: quem fez, o quê e quando.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  user_id     integer REFERENCES users(id),
  entity_type text NOT NULL,          -- ex.: 'user', 'lead', 'pedido'
  entity_id   text,                   -- id do registro afetado
  action      text NOT NULL,          -- ex.: 'login', 'criado', 'etapa_alterada'
  description text,                   -- frase legível em português
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_entity_idx ON events (entity_type, entity_id, created_at DESC);
CREATE INDEX events_user_idx ON events (user_id, created_at DESC);

-- Sessões de login (formato exigido pelo connect-pg-simple)
CREATE TABLE session (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);
