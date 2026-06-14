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

// ─── Buscar logs do Fly.io via API ───────────────────────────────────────────
async function buscarLogsFly(limite) {
  try {
    const resp = await axios.get(
      `https://api.machines.dev/v1/apps/${process.env.FLY_APP_NAME || 'rebanho-bot-ricci'}/logs`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLY_API_TOKEN}`,
          Accept: 'application/json',
        },
        params: { limit: limite || 100 },
        timeout: 15000,
      }
    )
    return resp.data || []
  } catch(e) {
    console.log('[agenteLogs] Erro ao buscar logs Fly.io:', e.message)
    return []
  }
}

// ─── Parsear uma linha de log ─────────────────────────────────────────────────
function parsearLog(linha) {
  const msg = linha.message || linha.msg || ''
  const ts  = linha.timestamp || linha.ts || new Date().toISOString()

  // Classificar tipo de log
  let tipo = 'info'
  let relevante = false
  let dadosExtras = {}

  if (/erro|error|exception|falhou|failed|crash/i.test(msg)) {
    tipo = 'erro'
    relevante = true
  } else if (/Roteador:|Detectado:|Transcri[cç][aã]o:/i.test(msg)) {
    tipo = 'fluxo'
    relevante = true

    // Extrair confiança
    const confMatch = msg.match(/\((\d+)%\s*de certeza\)/)
    if (confMatch) dadosExtras.confianca = parseInt(confMatch[1]) / 100

    // Extrair intenção
    const intMatch = msg.match(/Roteador [→>] (\w+)/i)
    if (intMatch) dadosExtras.intencao = intMatch[1].toLowerCase()

    // Extrair transcrição
    const transcMatch = msg.match(/Transcri[cç][aã]o:\s*(.+)/)
    if (transcMatch) dadosExtras.transcricao = transcMatch[1].substring(0, 200)

    // Extrair dados extraídos
    const extMatch = msg.match(/Extraído: (.+)/)
    if (extMatch) dadosExtras.extracao = extMatch[1]
  } else if (/Salvo:|resultado salvo/i.test(msg)) {
    tipo = 'sucesso'
    relevante = true
  } else if (/fallback|parse.*error|JSON.*invalid|invalid.*JSON/i.test(msg)) {
    tipo = 'parse_error'
    relevante = true
  } else if (/Whisper|429|rate limit/i.test(msg)) {
    tipo = 'rate_limit'
    relevante = true
  }

  return { ts, msg, tipo, relevante, dadosExtras }
}

// ─── Analisar padrões nos logs e extrair insights ────────────────────────────
function analisarPadroes(logsProcessados) {
  const insights = []

  const erros = logsProcessados.filter(l => l.tipo === 'erro')
  const parseErros = logsProcessados.filter(l => l.tipo === 'parse_error')
  const baixaConfianca = logsProcessados.filter(l =>
    l.dadosExtras.confianca && l.dadosExtras.confianca < 0.7
  )
  const fluxos = logsProcessados.filter(l => l.tipo === 'fluxo')

  if (erros.length > 0) {
    insights.push({
      tipo: 'erros_recentes',
      count: erros.length,
      msgs: erros.slice(0,3).map(l => l.msg.substring(0,100)),
      prioridade: 'alta'
    })
  }

  if (parseErros.length > 0) {
    insights.push({
      tipo: 'parse_errors',
      count: parseErros.length,
      msgs: parseErros.slice(0,3).map(l => l.msg.substring(0,100)),
      prioridade: 'alta',
      acao: 'Prompt do roteador precisa de ajuste — GPT retornando JSON malformado'
    })
  }

  if (baixaConfianca.length > 0) {
    const intencoes = {}
    baixaConfianca.forEach(l => {
      const int = l.dadosExtras.intencao || 'desconhecido'
      intencoes[int] = (intencoes[int] || 0) + 1
    })
    insights.push({
      tipo: 'baixa_confianca',
      count: baixaConfianca.length,
      intencoes,
      prioridade: 'media',
      acao: 'Adicionar mais exemplos few-shot para as intenções com baixa confiança'
    })
  }

  if (fluxos.length > 0) {
    const intencoesTotal = {}
    fluxos.forEach(l => {
      const int = l.dadosExtras.intencao || 'desconhecido'
      intencoesTotal[int] = (intencoesTotal[int] || 0) + 1
    })
    insights.push({
      tipo: 'distribuicao_intencoes',
      distribuicao: intencoesTotal,
      prioridade: 'baixa'
    })
  }

  return insights
}

// ─── Salvar insights no Supabase ─────────────────────────────────────────────
async function salvarInsights(insights) {
  if (!insights.length) return
  try {
    for (const insight of insights) {
      await getSb().from('bot_insights').upsert({
        tipo: insight.tipo,
        dados: insight,
        prioridade: insight.prioridade,
        detectado_em: new Date().toISOString(),
        processado: false,
      }, { onConflict: 'tipo' })
    }
    console.log('[agenteLogs] Insights salvos:', insights.length)
  } catch(e) {
    console.log('[agenteLogs] Erro ao salvar insights:', e.message)
  }
}

// ─── Salvar logs brutos relevantes ───────────────────────────────────────────
async function salvarLogsBrutos(logsProcessados) {
  const relevantes = logsProcessados.filter(l => l.relevante)
  if (!relevantes.length) return
  try {
    // Salvar em lote
    const registros = relevantes.map(l => ({
      tipo: l.tipo,
      mensagem: l.msg.substring(0, 500),
      dados_extras: l.dadosExtras,
      timestamp_fly: l.ts,
      processado: false,
      criado_em: new Date().toISOString(),
    }))
    await getSb().from('bot_logs_fly').insert(registros)
    console.log('[agenteLogs] Logs brutos salvos:', registros.length)
  } catch(e) {
    console.log('[agenteLogs] Erro ao salvar logs brutos:', e.message)
  }
}

// ─── Aplicar ações automáticas com base nos insights ─────────────────────────
async function aplicarAcoesAutomaticas(insights) {
  for (const insight of insights) {

    // Parse errors → salvar transcrições problemáticas como exemplos negativos
    if (insight.tipo === 'parse_errors' && insight.count >= 3) {
      console.log('[agenteLogs] AÇÃO: Parse errors frequentes — marcando para revisão do prompt')
      await getSb().from('bot_alertas').insert({
        tipo: 'parse_error_frequente',
        mensagem: `${insight.count} parse errors detectados nos logs recentes. Revisar prompt do agentRoteador.`,
        dados: insight,
        criado_em: new Date().toISOString(),
      }).catch(() => {})
    }

    // Baixa confiança frequente → disparar indexação de novos exemplos RAG
    if (insight.tipo === 'baixa_confianca' && insight.count >= 5) {
      console.log('[agenteLogs] AÇÃO: Baixa confiança frequente — disparando indexação RAG')
      try {
        const rag = require('./rag')
        await rag.indexarExemplosPendentes()
      } catch(e) {
        console.log('[agenteLogs] Erro indexação RAG:', e.message)
      }
    }
  }
}

// ─── Ciclo principal do agente ────────────────────────────────────────────────
async function executarCiclo(opcoes) {
  const limite = (opcoes && opcoes.limite) || 200
  console.log('[agenteLogs] Iniciando ciclo — buscando últimos', limite, 'logs do Fly.io')

  // 1. Buscar logs
  const logsRaw = await buscarLogsFly(limite)
  if (!logsRaw.length) {
    console.log('[agenteLogs] Nenhum log retornado')
    return { insights: [], logsProcessados: 0 }
  }

  // 2. Parsear
  const logsProcessados = logsRaw.map(parsearLog)
  console.log('[agenteLogs] Logs parseados:', logsProcessados.length,
    '| relevantes:', logsProcessados.filter(l => l.relevante).length)

  // 3. Analisar padrões
  const insights = analisarPadroes(logsProcessados)
  console.log('[agenteLogs] Insights gerados:', insights.length)

  // 4. Salvar tudo
  await Promise.all([
    salvarLogsBrutos(logsProcessados),
    salvarInsights(insights),
    aplicarAcoesAutomaticas(insights),
  ])

  return { insights, logsProcessados: logsProcessados.length }
}


async function autoAjustarLimiar() {
  try {
    const { data: feedbacks } = await getSb().from('bot_feedback').select('intencao_bot, intencao_correta').gte('corrigido_em', new Date(Date.now() - 48*60*60*1000).toISOString()).limit(50)
    const { data: logs } = await getSb().from('bot_logs').select('confianca').gte('recebido_em', new Date(Date.now() - 48*60*60*1000).toISOString()).not('confianca', 'is', null).limit(100)
    if (!logs || logs.length < 10) { console.log('[agenteLogs] Poucos dados para auto-ajuste'); return }
    const { data: cfg } = await getSb().from('configuracoes').select('valor').eq('chave', 'limiar_confianca').single()
    const limiarAtual = parseFloat(cfg?.valor || '0.7')
    const totalLogs = logs.length
    const baixaConf = logs.filter(l => l.confianca < limiarAtual).length
    const pctBaixaConf = baixaConf / totalLogs
    const totalFeedbacks = feedbacks?.length || 0
    const erros = feedbacks?.filter(f => f.intencao_bot !== f.intencao_correta).length || 0
    const taxaErro = totalFeedbacks > 0 ? erros / totalFeedbacks : 0
    console.log('[agenteLogs] Limiar: ' + limiarAtual + ' | baixaConf: ' + (pctBaixaConf*100).toFixed(0) + '% | taxaErro: ' + (taxaErro*100).toFixed(0) + '%')
    let novoLimiar = limiarAtual, motivo = ''
    if (pctBaixaConf > 0.4 && taxaErro < 0.1) { novoLimiar = Math.max(0.5, limiarAtual - 0.05); motivo = 'Perguntando demais (' + (pctBaixaConf*100).toFixed(0) + '%) com erro baixo' }
    else if (taxaErro > 0.25) { novoLimiar = Math.min(0.85, limiarAtual + 0.05); motivo = 'Taxa de erro alta (' + (taxaErro*100).toFixed(0) + '%)' }
    else { console.log('[agenteLogs] Limiar equilibrado'); return }
    if (novoLimiar !== limiarAtual) {
      await getSb().from('configuracoes').upsert({ chave: 'limiar_confianca', valor: novoLimiar.toFixed(2), descricao: 'Auto-ajustado: ' + motivo, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
      await getSb().from('bot_insights').upsert({ tipo: 'limiar_ajustado', dados: { limiar_anterior: limiarAtual, limiar_novo: novoLimiar, motivo, pctBaixaConf, taxaErro }, prioridade: 'media', detectado_em: new Date().toISOString(), processado: false }, { onConflict: 'tipo' })
      console.log('[agenteLogs] Limiar ajustado: ' + limiarAtual + ' → ' + novoLimiar + ' | ' + motivo)
    }
  } catch(e) { console.log('[agenteLogs] Erro auto-ajuste:', e.message) }
}

module.exports = { executarCiclo, buscarLogsFly, parsearLog, analisarPadroes }
