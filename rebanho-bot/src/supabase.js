const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function salvarRebanho(dados, transcricao, whatsappDe) {
  const { mes, ano, fazenda = 'Grupo Ricci', categorias = [] } = dados

  if (!mes || !ano) {
    throw new Error('Mês e ano não identificados no áudio. Por favor, mencione o período.')
  }

  // 1. Upsert do registro mensal principal
  const { data: mensal, error: errMensal } = await supabase
    .from('rebanho_mensal')
    .upsert(
      { mes, ano, fazenda, transcricao, whatsapp_de: whatsappDe },
      { onConflict: 'mes,ano,fazenda', ignoreDuplicates: false }
    )
    .select('id')
    .single()

  if (errMensal) throw new Error(`Erro ao salvar registro mensal: ${errMensal.message}`)

  const rebanhoId = mensal.id

  // 2. Buscar categorias existentes para o mesmo mês
  const { data: catExistentes } = await supabase
    .from('rebanho_categoria')
    .select('*')
    .eq('rebanho_id', rebanhoId)

  const existentesMap = {}
  ;(catExistentes || []).forEach(c => { existentesMap[c.item] = c })

  // 3. Para cada categoria nova: se já existe, ACUMULA; se não existe, INSERE
  for (const cat of categorias) {
    const existente = existentesMap[cat.item]

    if (existente) {
      // Acumular: somar entradas e saídas, usar maior existência_atual
      const { error } = await supabase
        .from('rebanho_categoria')
        .update({
          existencia_anterior: cat.existencia_anterior || existente.existencia_anterior,
          existencia_atual: Math.max(cat.existencia_atual || 0, existente.existencia_atual || 0),
          entrada_compra:        (existente.entrada_compra || 0) + (cat.entrada_compra || 0),
          entrada_mudanca_cat:   (existente.entrada_mudanca_cat || 0) + (cat.entrada_mudanca_cat || 0),
          entrada_desmama:       (existente.entrada_desmama || 0) + (cat.entrada_desmama || 0),
          entrada_nascimento:    (existente.entrada_nascimento || 0) + (cat.entrada_nascimento || 0),
          entrada_transferencia: (existente.entrada_transferencia || 0) + (cat.entrada_transferencia || 0),
          entrada_total:         (existente.entrada_total || 0) + (cat.entrada_total || 0),
          saida_abate:           (existente.saida_abate || 0) + (cat.saida_abate || 0),
          saida_venda:           (existente.saida_venda || 0) + (cat.saida_venda || 0),
          saida_morte:           (existente.saida_morte || 0) + (cat.saida_morte || 0),
          saida_desmama:         (existente.saida_desmama || 0) + (cat.saida_desmama || 0),
          saida_mudanca_cat:     (existente.saida_mudanca_cat || 0) + (cat.saida_mudanca_cat || 0),
          saida_transferencia:   (existente.saida_transferencia || 0) + (cat.saida_transferencia || 0),
          saida_total:           (existente.saida_total || 0) + (cat.saida_total || 0),
          indice_mortalidade:    cat.indice_mortalidade || existente.indice_mortalidade,
        })
        .eq('id', existente.id)

      if (error) console.error(`Erro ao atualizar categoria ${cat.item}:`, error.message)
    } else {
      // Nova categoria — inserir
      const { error } = await supabase
        .from('rebanho_categoria')
        .insert({
          rebanho_id: rebanhoId,
          item: cat.item,
          discriminacao: cat.discriminacao,
          sexo: cat.sexo,
          existencia_anterior: cat.existencia_anterior || 0,
          existencia_atual: cat.existencia_atual || 0,
          entrada_compra: cat.entrada_compra || 0,
          entrada_mudanca_cat: cat.entrada_mudanca_cat || 0,
          entrada_desmama: cat.entrada_desmama || 0,
          entrada_nascimento: cat.entrada_nascimento || 0,
          entrada_transferencia: cat.entrada_transferencia || 0,
          entrada_total: cat.entrada_total || 0,
          saida_abate: cat.saida_abate || 0,
          saida_venda: cat.saida_venda || 0,
          saida_morte: cat.saida_morte || 0,
          saida_desmama: cat.saida_desmama || 0,
          saida_mudanca_cat: cat.saida_mudanca_cat || 0,
          saida_transferencia: cat.saida_transferencia || 0,
          saida_total: cat.saida_total || 0,
          indice_mortalidade: cat.indice_mortalidade || 0,
        })

      if (error) console.error(`Erro ao inserir categoria ${cat.item}:`, error.message)
    }
  }

  const totalCategorias = categorias.length
  console.log(`Salvo: ${mes}/${ano} - ${totalCategorias} categorias processadas`)
  return { id: rebanhoId, mes, ano, fazenda, totalCategorias }
}

async function buscarResumoMensal(limite = 12) {
  const { data, error } = await supabase
    .from('vw_resumo_mensal')
    .select('*')
    .limit(limite)

  if (error) throw new Error(`Erro ao buscar resumo: ${error.message}`)
  return data
}

module.exports = { salvarRebanho, buscarResumoMensal }
