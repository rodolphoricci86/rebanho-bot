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
    // Tentar buscar o lote "Geral" como fallback
    const { data: geral } = await supabase
      .from('lotes').select('id').eq('fazenda', fazenda).eq('nome', 'Geral').single()
    return geral?.id || null
  }
  console.log(`Lote criado: ${nome}`)
  return novo.id
