-- D3: integrações que mandam leads para o CRM (formulário do site, ManyChat etc.).
-- Cada uma tem sua chave secreta; guardamos só o hash dela.
CREATE TABLE integrations (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('site', 'instagram', 'whatsapp', 'manychat', 'outro')),
  origin_id    integer NOT NULL REFERENCES origins(id),
  token_hash   text NOT NULL UNIQUE,
  token_hint   text NOT NULL,         -- últimos 4 caracteres, para reconhecer a chave
  active       boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN integration_id integer REFERENCES integrations(id);
ALTER TABLE leads ADD COLUMN last_contact_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customers ADD COLUMN email text;

