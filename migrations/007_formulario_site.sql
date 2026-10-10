-- Formulário do site: consentimento de contato pelo WhatsApp gravado no lead
-- e fluxo de boas-vindas do ManyChat (modelo aprovado do WhatsApp).

ALTER TABLE leads
  ADD COLUMN consent_text text,          -- texto exato que o cliente aceitou
  ADD COLUMN consent_at   timestamptz,   -- data/hora do aceite
  ADD COLUMN consent_ip   text,          -- IP de quem enviou o formulário
  ADD COLUMN welcome_sent_at timestamptz; -- quando o SDR mandou a boas-vindas pelo ManyChat

INSERT INTO settings (key, value) VALUES ('manychat_flow_boas_vindas', '')
ON CONFLICT (key) DO NOTHING;
