-- Aba Vendas: frete, pagamento, aprovação do cliente e dados da empresa para o PDF "Resumo do pedido".

ALTER TABLE sales
  ADD COLUMN shipping_service  text,                 -- transportadora/serviço (ex.: Correios PAC)
  ADD COLUMN shipping_price    numeric(10,2),        -- frete cobrado do cliente
  ADD COLUMN shipping_days     integer CHECK (shipping_days >= 0), -- prazo estimado de entrega (dias úteis)
  ADD COLUMN shipping_cep      text,                 -- CEP de destino (só dígitos)
  ADD COLUMN tracking_code     text,                 -- código de rastreio (preenchido depois)
  ADD COLUMN shipping_cost     numeric(10,2),        -- custo real do frete para a empresa (só Admin)
  ADD COLUMN unit_price        numeric(10,2),        -- valor unitário do produto
  ADD COLUMN discount          numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN payment_method    text CHECK (payment_method IN ('pix', 'cartao', 'boleto', 'outra')),
  ADD COLUMN installments      integer NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 24),
  ADD COLUMN interest_free     boolean NOT NULL DEFAULT true,
  ADD COLUMN installment_value numeric(10,2),
  ADD COLUMN down_payment      numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN total             numeric(10,2),        -- produtos + frete - desconto
  ADD COLUMN payment_status    text NOT NULL DEFAULT 'pendente' CHECK (payment_status IN ('pendente', 'pago')),
  ADD COLUMN customer_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_at       timestamptz,
  ADD COLUMN approved_by       integer REFERENCES users(id);

-- As vendas que já estavam no painel da produção continuam lá (registradas como aprovadas na atualização).
UPDATE sales SET customer_approved = true, approved_at = created_at;

INSERT INTO settings (key, value) VALUES
  ('frete_cep_origem', ''),
  ('empresa_nome', 'Brindes DoBoni'),
  ('empresa_cnpj', ''),
  ('empresa_telefone', ''),
  ('empresa_email', ''),
  ('empresa_site', 'brindesdoboni.com'),
  ('empresa_endereco', '')
ON CONFLICT (key) DO NOTHING;
