const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── Buscar ou criar lote ─────────────────────────────────────────────────────
async function buscarOuCriarLote(fazenda, loteNome, loteExtra = {}) {
  const nome = loteNome || 'Geral'

  const { data: existente } = await supabase
    .from('lotes').select('id, nome').eq('fazenda', fazenda).eq('nome', nome).single()

  if (existente) return existente.id

  const { data: novo, error } = await supabase
    .from('lotes')
    .insert({
      fazenda,
      nome,
      pasto:       loteExtra.pasto || null,
      finalidade:  loteExtra.finalidade || 'misto',
      raca:        loteExtra.raca || null,
    })
    .select('id').single()

  if (error) {
    console.error('Erro ao criar lote:', error.message)
    const { data: geral } = await supabase
      .from('lotes').select('id').eq('fazenda', fazenda).eq('nome', 'Geral').single()
    return geral?.id || null
  }
  console.log(`Lote criado: ${nome}`)
  return novo.id
}

// ─── Salvar animais individuais ───────────────────────────────────────────────
async function salvarAnimais(fazenda, animais, loteId) {
  if (!animais || animais.length === 0) return 0
  let salvos = 0

  for (const animal of animais) {
    if (!animal.brinco && !animal.chip) continue

    const { data: animalSalvo, error: errAnimal } = await supabase
      .from('animais')
      .upsert({
        fazenda,
        brinco:    animal.brinco || null,
        chip:      animal.chip || null,
        sexo:      animal.sexo || null,
        raca:      animal.raca || null,
        categoria: animal.categoria || null,
        lote_id:   loteId || null,
        status:    animal.evento === 'venda' ? 'vendido' :
                   animal.evento === 'morte' ? 'morto' : 'ativo',
      }, { onConflict: 'fazenda,brinco', ignoreDuplicates: false })
      .select('id').single()

    if (errAnimal) { console.error('Erro animal:', errAnimal.message); continue }

    if (animal.evento && loteId) {
      const tipoMap = {
        nascimento:    'entrada_nascimento',
        compra:        'entrada_compra',
        transferencia: 'entrada_transferencia',
        venda:         'saida_venda',
        morte:         'saida_morte',
        pesagem:       'pesagem',
      }
      const tipo = tipoMap[animal.evento] || 'entrada_compra'
      await supabase.from('movimentacoes_lote').insert({
        fazenda,
        lote_id:   loteId,
        animal_id: animalSalvo?.id || null,
        tipo,
        peso:      animal.peso || null,
        observacoes: animal.observacoes || null,
      })
    }
    salvos++
  }
  return salvos
}

// ─── Salvar rebanho principal ─────────────────────────────────────────────────
async function salvarRebanho(dados, transcricao, whatsappDe) {
  const { dia, mes, ano, fazenda = 'Grupo Ricci', categorias = [], animais = [] } = dados

  if (!mes || !ano) {
    throw new Error('Mês e ano não identificados. Por favor, mencione o período.')
  }

  // 1. Resolver lote
  const loteId = await buscarOuCriarLote(fazenda, dados.lote_nome, {
    pasto:      dados.lote_pasto,
    finalidade: dados.lote_finalidade,
    raca:       dados.lote_raca,
  })

  // 2. Upsert registro mensal (com dia)
  const { data: mensal, error: errMensal } = await supabase
    .from('rebanho_mensal')
    .upsert(
      { dia: dia || null, mes, ano, fazenda, transcricao, whatsapp_de: whatsappDe, lote_id: loteId },
      { onConflict: 'mes,ano,fazenda', ignoreDuplicates: false }
    )
    .select('id').single()

  if (errMensal) throw new Error(`Erro ao salvar registro mensal: ${errMensal.message}`)

  const rebanhoId = mensal.id

  // 3. Buscar categorias existentes
  const { data: catExistentes } = await supabase
    .from('rebanho_categoria').select('*').eq('rebanho_id', rebanhoId)

  const existentesMap = {}
  ;(catExistentes || []).forEach(c => { existentesMap[c.item] = c })

  // 4. Acumular/inserir categorias
  for (const cat of categorias) {
    const existente = existentesMap[cat.item]
    if (existente) {
      await supabase.from('rebanho_categoria').update({
        existencia_anterior: cat.existencia_anterior || existente.existencia_anterior,
        existencia_atual:    Math.max(cat.existencia_atual || 0, existente.existencia_atual || 0),
        entrada_compra:        (existente.entrada_compra || 0)        + (cat.entrada_compra || 0),
        entrada_mudanca_cat:   (existente.entrada_mudanca_cat || 0)   + (cat.entrada_mudanca_cat || 0),
        entrada_desmama:       (existente.entrada_desmama || 0)       + (cat.entrada_desmama || 0),
        entrada_nascimento:    (existente.entrada_nascimento || 0)    + (cat.entrada_nascimento || 0),
        entrada_transferencia: (existente.entrada_transferencia || 0) + (cat.entrada_transferencia || 0),
        entrada_total:         (existente.entrada_total || 0)         + (cat.entrada_total || 0),
        saida_abate:           (existente.saida_abate || 0)           + (cat.saida_abate || 0),
        saida_venda:           (existente.saida_venda || 0)           + (cat.saida_venda || 0),
        saida_morte:           (existente.saida_morte || 0)           + (cat.saida_morte || 0),
        saida_desmama:         (existente.saida_desmama || 0)         + (cat.saida_desmama || 0),
        saida_mudanca_cat:     (existente.saida_mudanca_cat || 0)     + (cat.saida_mudanca_cat || 0),
        saida_transferencia:   (existente.saida_transferencia || 0)   + (cat.saida_transferencia || 0),
        saida_total:           (existente.saida_total || 0)           + (cat.saida_total || 0),
        indice_mortalidade:    cat.indice_mortalidade || existente.indice_mortalidade,
      }).eq('id', existente.id)
    } else {
      await supabase.from('rebanho_categoria').insert({
        rebanho_id: rebanhoId,
        item: cat.item, discriminacao: cat.discriminacao, sexo: cat.sexo,
        existencia_anterior:   cat.existencia_anterior || 0,
        existencia_atual:      cat.existencia_atual || 0,
        entrada_compra:        cat.entrada_compra || 0,
        entrada_mudanca_cat:   cat.entrada_mudanca_cat || 0,
        entrada_desmama:       cat.entrada_desmama || 0,
        entrada_nascimento:    cat.entrada_nascimento || 0,
        entrada_transferencia: cat.entrada_transferencia || 0,
        entrada_total:         cat.entrada_total || 0,
        saida_abate:           cat.saida_abate || 0,
        saida_venda:           cat.saida_venda || 0,
        saida_morte:           cat.saida_morte || 0,
        saida_desmama:         cat.saida_desmama || 0,
        saida_mudanca_cat:     cat.saida_mudanca_cat || 0,
        saida_transferencia:   cat.saida_transferencia || 0,
        saida_total:           cat.saida_total || 0,
        indice_mortalidade:    cat.indice_mortalidade || 0,
      })
    }
  }

  // 5. Salvar animais individuais
  const animaisSalvos = await salvarAnimais(fazenda, animais, loteId)

  console.log(`Salvo: ${dia||'--'}/${mes}/${ano} | lote: ${dados.lote_nome || 'Geral'} | cats: ${categorias.length} | animais: ${animaisSalvos}`)
  return { id: rebanhoId, dia, mes, ano, fazenda, loteId, totalCategorias: categorias.length, animaisSalvos }
}

async function buscarResumoMensal(limite = 12) {
  const { data, error } = await supabase
    .from('vw_resumo_mensal').select('*').limit(limite)
  if (error) throw new Error(`Erro ao buscar resumo: ${error.message}`)
  return data
}

async function buscarResumoPorLote(fazenda = 'Grupo Ricci') {
  const { data, error } = await supabase
    .from('vw_resumo_lote').select('*').eq('fazenda', fazenda)
  if (error) throw new Error(`Erro ao buscar lotes: ${error.message}`)
  return data
}

module.exports = { salvarRebanho, buscarResumoMensal, buscarResumoPorLote }
