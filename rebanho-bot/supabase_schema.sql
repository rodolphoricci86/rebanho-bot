-- ============================================================
-- Schema: Mapa de Rebanho Bovino - Grupo Ricci
-- Executar no SQL Editor do Supabase
-- ============================================================

-- Tabela principal de registros mensais
CREATE TABLE IF NOT EXISTS rebanho_mensal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mes             INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  ano             INTEGER NOT NULL,
  fazenda         TEXT DEFAULT 'Grupo Ricci',
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW(),
  transcricao     TEXT,              -- texto bruto do áudio
  whatsapp_de     TEXT,              -- número que enviou
  UNIQUE (mes, ano, fazenda)
);

-- Tabela de categorias do rebanho (uma linha por categoria por mês)
CREATE TABLE IF NOT EXISTS rebanho_categoria (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rebanho_id              UUID REFERENCES rebanho_mensal(id) ON DELETE CASCADE,
  item                    TEXT NOT NULL,       -- ex: "1.1", "2.4"
  discriminacao           TEXT NOT NULL,       -- ex: "Bezerros 0 a 8 meses"
  sexo                    TEXT CHECK (sexo IN ('M','F')),

  -- Existências
  existencia_anterior     INTEGER DEFAULT 0,
  existencia_atual        INTEGER DEFAULT 0,

  -- Entradas
  entrada_compra          INTEGER DEFAULT 0,
  entrada_mudanca_cat     INTEGER DEFAULT 0,
  entrada_desmama         INTEGER DEFAULT 0,
  entrada_nascimento      INTEGER DEFAULT 0,
  entrada_transferencia   INTEGER DEFAULT 0,
  entrada_total           INTEGER DEFAULT 0,

  -- Saídas
  saida_abate             INTEGER DEFAULT 0,
  saida_venda             INTEGER DEFAULT 0,
  saida_morte             INTEGER DEFAULT 0,
  saida_desmama           INTEGER DEFAULT 0,
  saida_mudanca_cat       INTEGER DEFAULT 0,
  saida_transferencia     INTEGER DEFAULT 0,
  saida_total             INTEGER DEFAULT 0,

  -- Índice
  indice_mortalidade      NUMERIC(10,8) DEFAULT 0,

  criado_em               TIMESTAMPTZ DEFAULT NOW()
);

-- View: resumo mensal agregado
CREATE OR REPLACE VIEW vw_resumo_mensal AS
SELECT
  m.id,
  m.mes,
  m.ano,
  m.fazenda,
  m.criado_em,
  SUM(CASE WHEN c.sexo = 'M' THEN c.existencia_atual ELSE 0 END) AS total_machos,
  SUM(CASE WHEN c.sexo = 'F' THEN c.existencia_atual ELSE 0 END) AS total_femeas,
  SUM(c.existencia_atual)      AS total_rebanho,
  SUM(c.entrada_nascimento)    AS total_nascimentos,
  SUM(c.saida_morte)           AS total_mortes,
  SUM(c.saida_venda)           AS total_vendas,
  SUM(c.entrada_compra)        AS total_compras,
  ROUND(
    CASE WHEN SUM(c.existencia_atual) > 0
    THEN SUM(c.saida_morte)::NUMERIC / SUM(c.existencia_atual) * 100
    ELSE 0 END, 4
  ) AS mortalidade_pct
FROM rebanho_mensal m
JOIN rebanho_categoria c ON c.rebanho_id = m.id
GROUP BY m.id, m.mes, m.ano, m.fazenda, m.criado_em
ORDER BY m.ano DESC, m.mes DESC;

-- Trigger: atualiza timestamp
CREATE OR REPLACE FUNCTION update_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN NEW.atualizado_em = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rebanho_mensal_update
  BEFORE UPDATE ON rebanho_mensal
  FOR EACH ROW EXECUTE FUNCTION update_atualizado_em();

-- Habilitar RLS (Row Level Security) - opcional mas recomendado
ALTER TABLE rebanho_mensal    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rebanho_categoria ENABLE ROW LEVEL SECURITY;

-- Policy: service_role tem acesso total (backend usa service key)
CREATE POLICY "service_role_all" ON rebanho_mensal
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON rebanho_categoria
  FOR ALL USING (auth.role() = 'service_role');
