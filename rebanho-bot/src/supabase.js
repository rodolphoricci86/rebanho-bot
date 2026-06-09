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

  await supabase.from('rebanho_categoria').delete().eq('rebanho_id', rebanhoId)

  if (categorias.length > 0) {
    const rows = categorias.map((cat) => ({
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
    }))

    const { error: errCat } = await supabase.from('rebanho_categoria').insert(rows)
    if (errCat) throw new Error(`Erro ao salvar categorias: ${errCat.message}`)
  }

  return { id: rebanhoId, mes, ano, fazenda, totalCategorias: categorias.length }
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
