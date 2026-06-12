const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')

let _sb = null
function getSb() {
  if (!_sb) {
    _sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { global: { WebSocket: ws } }
    )
  }
  return _sb
}

// ─── Gerar embedding via OpenAI ───────────────────────────────────────────────
async function gerarEmbedding(texto) {
  const response = await axios.post(
    'https://api.openai.com/v1/embeddings',
    {
      model: 'text-embedding-3-small',  // 1536 dims, barato ($0.02/1M tokens)
      input: texto.substring(0, 8000),  // limite de segurança
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  )
  return response.data.data[0].embedding
}

// ─── Buscar exemplos semanticamente similares para extração ───────────────────
async function buscarExemplosSimilares(texto, tipo, limite) {
  try {
    const embedding = await gerarEmbedding(texto)
    const { data, error } = await getSb().rpc('buscar_exemplos_similares', {
      query_embedding: embedding,
      tipo_filtro: tipo || null,
      limite: limite || 3,
    })
    if (error) throw new Error(error.message)
    const resultados = data || []
    console.log(`RAG: ${resultados.length} exemplos similares para "${texto.substring(0,50)}..."`)
    return resultados
  } catch(e) {
    console.log('RAG buscarExemplosSimilares erro:', e.message)
    return []
  }
}

// ─── Buscar classificações similares para o roteador ─────────────────────────
async function buscarClassificacaoSimilar(texto, limite) {
  try {
    const embedding = await gerarEmbedding(texto)
    const { data, error } = await getSb().rpc('buscar_classificacao_similar', {
      query_embedding: embedding,
      limite: limite || 4,
    })
    if (error) throw new Error(error.message)
    const resultados = data || []
    console.log(`RAG roteador: ${resultados.length} classificações similares`)
    return resultados
  } catch(e) {
    console.log('RAG buscarClassificacaoSimilar erro:', e.message)
    return []
  }
}

// ─── Salvar embedding junto com o exemplo ─────────────────────────────────────
async function salvarEmbedding(tabela, id, texto) {
  try {
    const embedding = await gerarEmbedding(texto)
    await getSb().from(tabela).update({ embedding }).eq('id', id)
    console.log('Embedding salvo:', tabela, id.substring(0,8))
  } catch(e) {
    console.log('Erro ao salvar embedding:', e.message)
  }
}

// ─── Indexar todos os exemplos sem embedding (backfill) ───────────────────────
async function indexarExemplosPendentes() {
  try {
    // bot_exemplos_extracao
    const { data: semEmb1 } = await getSb()
      .from('bot_exemplos_extracao')
      .select('id, transcricao')
      .is('embedding', null)
      .eq('ativo', true)
      .limit(20)

    for (const ex of (semEmb1 || [])) {
      await salvarEmbedding('bot_exemplos_extracao', ex.id, ex.transcricao)
      await new Promise(r => setTimeout(r, 200)) // rate limit
    }

    // bot_exemplos (classificação)
    const { data: semEmb2 } = await getSb()
      .from('bot_exemplos')
      .select('id, transcricao')
      .is('embedding', null)
      .eq('ativo', true)
      .limit(20)

    for (const ex of (semEmb2 || [])) {
      await salvarEmbedding('bot_exemplos', ex.id, ex.transcricao)
      await new Promise(r => setTimeout(r, 200))
    }

    console.log('Indexação concluída')
  } catch(e) {
    console.log('Erro indexação:', e.message)
  }
}

module.exports = {
  gerarEmbedding,
  buscarExemplosSimilares,
  buscarClassificacaoSimilar,
  salvarEmbedding,
  indexarExemplosPendentes,
}
