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

// ─── Buscar dados históricos para análise ─────────────────────────────────────
async function buscarDadosAnalise(fazenda, meses) {
  const { data } = await getSb()
    .from('vw_resumo_mensal')
    .select('*')
    .eq('fazenda', fazenda || 'Grupo Ricci')
    .order('ano', { ascending: false })
    .order('mes', { ascending: false })
    .limit(meses || 12)
  return data || []
}

// ─── Detectar anomalias via regras + LLM ─────────────────────────────────────
async function detectarAnomalias(fazenda) {
  const dados = await buscarDadosAnalise(fazenda, 12)
  if (dados.length < 2) return []

  const anomalias = []

  // ── Regras determinísticas ──────────────────────────────────────────────────

  for (let i = 0; i < dados.length; i++) {
    const d = dados[i]
    const ant = dados[i + 1]

    // 1. Mortalidade alta (> 2%)
    const mort = parseFloat(d.mortalidade_pct) || 0
    if (mort > 2) {
      anomalias.push({
        tipo: 'mortalidade_alta',
        severidade: mort > 5 ? 'critica' : 'alta',
        mes: d.mes, ano: d.ano,
        valor: mort.toFixed(3) + '%',
        msg: `Mortalidade de ${mort.toFixed(3)}% em ${d.mes}/${d.ano} — acima do limite de 2%`,
      })
    }

    // 2. Queda brusca do rebanho sem vendas registradas
    if (ant) {
      const variacaoRebanho = d.total_rebanho - ant.total_rebanho
      const totalSaidas = (d.total_vendas || 0) + (d.total_mortes || 0)
      if (variacaoRebanho < -50 && totalSaidas < Math.abs(variacaoRebanho) * 0.5) {
        anomalias.push({
          tipo: 'queda_sem_justificativa',
          severidade: 'alta',
          mes: d.mes, ano: d.ano,
          valor: variacaoRebanho,
          msg: `Queda de ${Math.abs(variacaoRebanho)} cabeças em ${d.mes}/${d.ano} sem vendas/mortes suficientes registradas`,
        })
      }

      // 3. Crescimento anormal (> 20% sem compras)
      const crescimento = ((d.total_rebanho - ant.total_rebanho) / ant.total_rebanho * 100)
      if (crescimento > 20 && (d.total_compras || 0) < 10) {
        anomalias.push({
          tipo: 'crescimento_anormal',
          severidade: 'media',
          mes: d.mes, ano: d.ano,
          valor: crescimento.toFixed(1) + '%',
          msg: `Crescimento de ${crescimento.toFixed(1)}% em ${d.mes}/${d.ano} sem compras registradas — possível erro de lançamento`,
        })
      }
    }

    // 4. Gap de meses sem registro
    if (ant) {
      const diffMeses = (d.ano - ant.ano) * 12 + (d.mes - ant.mes)
      if (Math.abs(diffMeses) > 2) {
        anomalias.push({
          tipo: 'gap_registro',
          severidade: 'media',
          mes: d.mes, ano: d.ano,
          valor: Math.abs(diffMeses) + ' meses',
          msg: `Gap de ${Math.abs(diffMeses)} meses sem registro entre ${ant.mes}/${ant.ano} e ${d.mes}/${d.ano}`,
        })
      }
    }

    // 5. Proporção M/F muito desequilibrada (> 90% de um sexo)
    if (d.total_rebanho > 100) {
      const pctMachos = d.total_machos / d.total_rebanho * 100
      if (pctMachos > 90 || pctMachos < 10) {
        anomalias.push({
          tipo: 'desequilibrio_sexo',
          severidade: 'baixa',
          mes: d.mes, ano: d.ano,
          valor: pctMachos.toFixed(1) + '% machos',
          msg: `Proporção incomum: ${pctMachos.toFixed(1)}% machos em ${d.mes}/${d.ano} — verificar se dados estão completos`,
        })
      }
    }
  }

  // ── Análise LLM para padrões complexos ─────────────────────────────────────
  try {
    const axios = require('axios')
    const resumo = dados.slice(0, 6).map(d =>
      d.mes + '/' + d.ano + ': total=' + d.total_rebanho +
      ' M=' + d.total_machos + ' F=' + d.total_femeas +
      ' nasc=' + d.total_nascimentos + ' mort=' + d.total_mortes +
      ' venda=' + d.total_vendas + ' mortalidade=' + parseFloat(d.mortalidade_pct).toFixed(3) + '%'
    ).join('\n')

    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: 'Você é um especialista em pecuária bovina. Analise os dados do rebanho e identifique anomalias, tendências preocupantes ou inconsistências. Responda em JSON: {"anomalias": [{"tipo": "string", "severidade": "baixa|media|alta|critica", "msg": "string"}]}. Se não houver anomalias, retorne {"anomalias": []}. Seja conciso.'
        },
        {
          role: 'user',
          content: 'Dados do rebanho (últimos 6 meses):\n' + resumo
        }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    })

    const txt = resp.data.choices[0].message.content.trim().replace(/```json|```/g, '')
    const parsed = JSON.parse(txt)
    if (parsed.anomalias && parsed.anomalias.length > 0) {
      parsed.anomalias.forEach(a => {
        a.fonte = 'llm'
        anomalias.push(a)
      })
    }
  } catch(e) {
    console.log('Agente anomalias LLM erro:', e.message)
  }

  // Ordenar por severidade
  const ordem = { critica: 0, alta: 1, media: 2, baixa: 3 }
  anomalias.sort((a, b) => (ordem[a.severidade] || 3) - (ordem[b.severidade] || 3))

  console.log('Anomalias detectadas:', anomalias.length)
  return anomalias
}

// ─── Salvar anomalias detectadas ──────────────────────────────────────────────
async function salvarAnomalias(fazenda, anomalias) {
  if (!anomalias.length) return
  try {
    await getSb().from('bot_anomalias').upsert(
      anomalias.map(a => ({
        fazenda: fazenda || 'Grupo Ricci',
        tipo: a.tipo,
        severidade: a.severidade,
        mes: a.mes || null,
        ano: a.ano || null,
        mensagem: a.msg,
        detectado_em: new Date().toISOString(),
        resolvido: false,
      })),
      { onConflict: 'fazenda,tipo,mes,ano', ignoreDuplicates: false }
    )
  } catch(e) {
    console.log('Erro ao salvar anomalias:', e.message)
  }
}

// ─── Executar análise completa ─────────────────────────────────────────────────
async function analisarRebanho(fazenda) {
  const anomalias = await detectarAnomalias(fazenda)
  await salvarAnomalias(fazenda, anomalias)
  return anomalias
}

module.exports = { detectarAnomalias, analisarRebanho }
