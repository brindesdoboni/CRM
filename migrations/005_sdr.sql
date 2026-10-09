-- D4-6: SDR (perguntas e pontuação), áudios padrão, recontato agendado com consentimento, configurações.

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('sdr_nota_quente', '60'),
  ('sdr_nota_morno', '35'),
  ('limite_atacado', '20'),
  ('whatsapp_comercial', ''),
  ('sdr_mensagem_varejo', 'Para quantidades menores, o jeito mais rápido é comprar pelo nosso site ou pela Shopee. Já te mando o link!'),
  ('manychat_flow_recontato', '');

-- Perguntas de qualificação. options: [{"texto": "Empresa", "pontos": 25}, ...]
CREATE TABLE sdr_questions (
  id         serial PRIMARY KEY,
  key        text NOT NULL UNIQUE,  -- nome do campo que o ManyChat envia
  question   text NOT NULL,
  options    jsonb NOT NULL DEFAULT '[]'::jsonb,
  position   integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sdr_questions (key, question, options, position) VALUES
  ('tipo', 'É para empresa, evento ou uso pessoal?',
   '[{"texto":"Empresa","pontos":25},{"texto":"Evento","pontos":20},{"texto":"Pessoal","pontos":5}]', 1),
  ('quantidade_faixa', 'Quantas unidades você precisa?',
   '[{"texto":"Menos de 20","pontos":0,"varejo":true},{"texto":"20 a 99","pontos":20},{"texto":"100 a 499","pontos":30},{"texto":"500 ou mais","pontos":35}]', 2),
  ('prazo', 'Para quando você precisa?',
   '[{"texto":"Até 7 dias","pontos":20},{"texto":"Até 30 dias","pontos":15},{"texto":"Mais de 30 dias","pontos":5},{"texto":"Só pesquisando","pontos":0}]', 3),
  ('arte', 'Você já tem a arte ou o logo?',
   '[{"texto":"Sim","pontos":10},{"texto":"Preciso de ajuda","pontos":5},{"texto":"Não","pontos":0}]', 4),
  ('produto', 'Qual produto você procura?', '[]', 5);

ALTER TABLE leads ADD COLUMN classification text;          -- quente, morno, frio, varejo
ALTER TABLE leads ADD COLUMN opt_out_at timestamptz;       -- cliente pediu para não ser chamado

ALTER TABLE files DROP CONSTRAINT files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ('print_lead', 'arte_venda', 'audio_sdr'));

-- Áudios padrão que o SDR manda (o ManyChat busca pelo link público)
CREATE TABLE sdr_audios (
  id           serial PRIMARY KEY,
  title        text NOT NULL,
  when_to_use  text,
  transcript   text,
  file_id      integer REFERENCES files(id),
  public_token text NOT NULL UNIQUE,
  position     integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Recontato agendado: só com consentimento do cliente registrado
CREATE TABLE recontacts (
  id           serial PRIMARY KEY,
  lead_id      integer NOT NULL REFERENCES leads(id),
  due_date     date NOT NULL,
  note         text,
  consent_text text NOT NULL,       -- o que o cliente disse/autorizou
  status       text NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado', 'feito', 'cancelado')),
  sent_auto_at timestamptz,         -- quando o SDR chamou sozinho (ManyChat)
  notified_at  timestamptz,         -- quando o comercial foi avisado
  done_at      timestamptz,
  done_by      integer REFERENCES users(id),
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recontacts_due_idx ON recontacts (status, due_date);
