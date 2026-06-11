require('dotenv').config()

const express = require('express')
const twilio = require('twilio')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const { transcreverAudio } = require('./transcricao')
const { extrairDadosRebanho, extrairComplemento, gerarResumoWhatsApp } = require('./extracao')
const { salvarRebanho, buscarResumoMensal, buscarResumoPorLote } = require('./supabase')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(express.static(path.join(__dirname)))

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── Sessões multi-etapa ──────────────────────────────────────────────────────
// Estrutura: { dados, etapa, ts }
// Etapas: 'periodo' | 'lote' | 'movimentacoes' | 'confirmacao'
const sessoes = {}
const TTL = 15 * 60 * 1000

function setSessao(de, dados, etapa) {
  sessoes[de] = { dados, etapa, ts: Date.now() }
  setTimeout(() => { delete sessoes[de] }, TTL)
}

function limparSessao(de) { delete sessoes[de] }

// ─── Análise do que está faltando ─────────────────────────────────────────────
function analisarFaltando(dados) {
  const faltando = []

  if (!dados.mes || !dados.ano) faltando.push('periodo')

  const temCategorias = dados.categorias && dados.categorias.length > 0
  const temExistencia = temCategorias && dados.categorias.some(c => c.existencia_atual > 0)
  if (!temExistencia) faltando.push('existencia')

  const temMovim = temCategorias && dados.categorias.some(c =>
    (c.entrada_nascimento || 0) + (c.saida_morte || 0) +
    (c.saida_venda || 0) + (c.entrada_compra || 0) > 0
  )
  if (temCategorias && !temMovim) faltando.push('movimentacoes')

  return faltando
}

// ─── Gerador de perguntas ─────────────────────────────────────────────────────
function gerarPergunta(etapa, dados) {
  const meses = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

  if (etapa === 'periodo') {
    return `_Não identifiquei a data nos dados._\n\n📅 *Para qual data é este mapa? (dia, mês e ano)*\nEx: *15 de março de 2026* ou *15/03/2026*`
  }

  if (etapa === 'existencia') {
    return `_Não identifiquei a existência atual dos animais._\n\n🐄 *Quantas cabeças tem ao todo?*\nOu envie um novo áudio com os totais por categoria.`
  }

  if (etapa === 'movimentacoes') {
    const periodo = dados.mes ? `${meses[dados.mes]}/${dados.ano}` : 'este mês'
    const total = dados.categorias?.reduce((s, c) => s + (c.existencia_atual || 0), 0) || 0
    return `✅ *Captei ${total} cabeças em ${periodo}.*\n\n📋 *Houve movimentações neste mês?*\nNascimentos, mortes, compras ou vendas?\n\nResponda com os números ou *não* se não houver.`
  }

  return ''
}

// ─── Resumo para confirmação ──────────────────────────────────────────────────
function gerarResumoConfirmacao(dados) {
  const meses = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

  const total = dados.categorias?.reduce((s, c) => s + (c.existencia_atual || 0), 0) || 0
  const machos = dados.categorias?.filter(c => c.sexo==='M').reduce((s,c) => s+(c.existencia_atual||0), 0) || 0
  const femeas = dados.categorias?.filter(c => c.sexo==='F').reduce((s,c) => s+(c.existencia_atual||0), 0) || 0
  const nasc  = dados.categorias?.reduce((s,c) => s+(c.entrada_nascimento||0), 0) || 0
  const mortes = dados.categorias?.reduce((s,c) => s+(c.saida_morte||0), 0) || 0
  const vendas = dados.categorias?.reduce((s,c) => s+(c.saida_venda||0), 0) || 0
  const compras = dados.categorias?.reduce((s,c) => s+(c.entrada_compra||0), 0) || 0
  const periodo = dados.mes ? `${meses[dados.mes]}/${dados.ano}` : '—'
  const lote = dados.lote_nome ? `\n*Lote:* ${dados.lote_nome}` : ''

  const linhasCat = (dados.categorias || [])
    .filter(c => c.existencia_atual > 0)
    .map(c => `  • ${c.item} ${c.discriminacao}: ${c.existencia_atual}`)
    .join('\n')

  return `📋 *Confira os dados antes de salvar:*

*Período:* ${periodo}${lote}
*Total:* ${total} cabeças (M: ${machos} | F: ${femeas})

*Por categoria:*
${linhasCat || '  (nenhuma)'}

*Movimentações:*
  Nascimentos: ${nasc} | Compras: ${compras}
  Vendas: ${vendas} | Mortes: ${mortes}

Está correto? Responda *sim* para salvar ou *não* para corrigir.`
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
function validarTwilio(req, res, next) {
  // if (!twilio.validateRequest(...)) return res.status(403).send('Forbidden')
  next()
}

function responderWhatsApp(res, msg) {
  const twiml = new twilio.twiml.MessagingResponse()
  twiml.message(msg)
  res.type('text/xml').send(twiml.toString())
}

app.post('/webhook/whatsapp', validarTwilio, async (req, res) => {
  const { From: de, Body: corpo, NumMedia: numMedia,
    MediaUrl0: mediaUrl, MediaContentType0: mediaType } = req.body

  console.log(`Msg ${de} | mídia:${numMedia} | tipo:${mediaType}`)

  try {
    const sessao = sessoes[de]

    // ── Sessão ativa: processar resposta ──
    if (sessao) {
      const { dados, etapa } = sessao
      const temAudio = parseInt(numMedia) > 0 && mediaType?.startsWith('audio')

      if (temAudio) {
        responderWhatsApp(res, '_Ouvindo seu áudio..._')
        transcreverAudio(mediaUrl, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
          .then(txt => {
            console.log('Áudio em sessão (' + etapa + '):', txt.substring(0, 100))
            return tratarRespostaSessao(de, txt, dados, etapa)
          })
          .catch(err => enviarMensagem(de, 'Erro: ' + err.message))
        return
      }

      const resposta = (corpo || '').trim().toLowerCase()

      // CONFIRMAÇÃO
      if (etapa === 'confirmacao') {
        if (resposta === 'sim' || resposta === 's' || resposta === 'yes') {
          limparSessao(de)
          responderWhatsApp(res, '_Salvando..._')
          finalizarSalvamento(de, dados).catch(err =>
            enviarMensagem(de, `Erro ao salvar: ${err.message}`))
        } else if (resposta === 'não' || resposta === 'nao' || resposta === 'n') {
          limparSessao(de)
          responderWhatsApp(res, '_Ok! Envie um novo áudio com os dados corrigidos._')
        } else {
          responderWhatsApp(res, `_Responda *sim* para salvar ou *não* para corrigir._`)
        }
        return
      }

      // MOVIMENTAÇÕES: aceitar "não" ou processar resposta
      if (etapa === 'movimentacoes') {
        dados._movPerguntada = true
        if (resposta === 'não' || resposta === 'nao' || resposta === 'n' || resposta === 'nenhuma') {
          // Sem movimentações — ir para confirmação
          setSessao(de, dados, 'confirmacao')
          responderWhatsApp(res, gerarResumoConfirmacao(dados))
        } else {
          // Tentar extrair movimentações do texto/áudio
          responderWhatsApp(res, '_Processando movimentações..._')
          processarComplemento(de, corpo, dados, 'movimentacoes').catch(err =>
            enviarMensagem(de, `Erro: ${err.message}`))
        }
        return
      }

      // PERÍODO, EXISTÊNCIA, LOTE: sempre tentar extrair do texto
      responderWhatsApp(res, '_Processando..._')
      processarComplemento(de, corpo, dados, etapa).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Áudio novo ──
    if (parseInt(numMedia) > 0 && mediaType?.startsWith('audio')) {
      responderWhatsApp(res, '_Recebi seu áudio! Transcrevendo e processando..._')
      processarAudio(de, mediaUrl).catch(err => {
        console.error('Erro áudio:', err)
        enviarMensagem(de, `Erro: ${err.message}. Tente novamente.`)
      })
      return
    }

    // ── Texto longo novo ──
    if (corpo && corpo.trim().length > 20) {
      responderWhatsApp(res, '_Processando..._')
      processarTexto(de, corpo).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Comandos ──
    const cmd = (corpo || '').trim().toLowerCase()
    if (cmd === 'resumo') {
      const r = await buscarResumoMensal(3)
      return responderWhatsApp(res, formatarResumoRapido(r))
    }
    if (cmd === 'lotes') {
      const l = await buscarResumoPorLote()
      return responderWhatsApp(res, formatarLotes(l))
    }
    if (cmd === 'cancelar' || cmd === 'cancel') {
      limparSessao(de)
      return responderWhatsApp(res, '_Operação cancelada._')
    }

    // Verificar cadastro do usuário
    const usuario = await obterOuCriarUsuario(de)
    const ehNovo = !usuario.nome

    if (ehNovo) {
      responderWhatsApp(res,
        `*Olá! Sou o assistente de rebanho do Grupo Ricci.* 🐄\n\nVou te conhecer melhor em algumas perguntas rápidas — mas você já pode enviar áudios com dados do rebanho a qualquer momento!`)
      perguntarProximoCadastro(de)
      return
    }

    responderWhatsApp(res,
      `*Olá${usuario.nome ? ', ' + usuario.nome.split(' ')[0] : ''}! Sou o assistente de rebanho do Grupo Ricci.* 🐄\n\nEnvie um *áudio* com os dados do mapa de rebanho.\n\nComandos:\n- *resumo* — últimos 3 meses\n- *lotes* — resumo por lote\n- *cancelar* — cancela operação em andamento`)
  } catch (err) {
    console.error('Erro webhook:', err)
    responderWhatsApp(res, 'Erro inesperado. Tente novamente.')
  }
})

// ─── Usuários e onboarding progressivo ────────────────────────────────────────
const CAMPOS_CADASTRO = [
  { campo: 'nome',        pergunta: '👋 Antes de continuar, como é seu *nome*?' },
  { campo: 'funcao',      pergunta: '💼 Qual sua *função* na fazenda? (peão, gerente, veterinário...)' },
  { campo: 'fazenda',     pergunta: '🏡 Em qual *fazenda ou unidade* você trabalha?' },
  { campo: 'lotes_cuida', pergunta: '🐄 Quais *lotes ou pastos* você cuida? (pode listar vários)' },
]

async function obterOuCriarUsuario(whatsapp) {
  const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsapp).single()
  if (data) return data
  const { data: novo } = await supabase.from('usuarios')
    .insert({ whatsapp }).select('*').single()
  return novo || { whatsapp }
}

async function salvarCampoUsuario(whatsapp, campo, valor) {
  await supabase.from('usuarios')
    .update({ [campo]: valor, atualizado_em: new Date() })
    .eq('whatsapp', whatsapp)
}

async function incrementarEnvios(whatsapp) {
  const { data } = await supabase.from('usuarios').select('total_envios').eq('whatsapp', whatsapp).single()
  await supabase.from('usuarios')
    .update({ total_envios: ((data?.total_envios) || 0) + 1 })
    .eq('whatsapp', whatsapp)
}

function proximoCampoCadastro(usuario) {
  for (const c of CAMPOS_CADASTRO) {
    if (!usuario[c.campo]) return c
  }
  return null
}

async function perguntarProximoCadastro(de) {
  const usuario = await obterOuCriarUsuario(de)
  const proximo = proximoCampoCadastro(usuario)
  if (!proximo) return false
  setSessao(de, { _cadastro: true }, 'cadastro_' + proximo.campo)
  await enviarMensagem(de, proximo.pergunta)
  return true
}

// ─── Tratar resposta dentro de sessão (texto ou áudio transcrito) ────────────
async function tratarRespostaSessao(de, textoResposta, dados, etapa) {
  const resposta = (textoResposta || '').trim().toLowerCase()

  // Etapas de cadastro progressivo
  if (etapa.startsWith('cadastro_')) {
    const campo = etapa.replace('cadastro_', '')
    const valor = (textoResposta || '').trim()
    limparSessao(de)
    if (valor.length > 1) {
      await salvarCampoUsuario(de, campo, valor)
      const labels = { nome: 'Nome', funcao: 'Função', fazenda: 'Fazenda', lotes_cuida: 'Lotes' }
      await enviarMensagem(de, `✅ ${labels[campo] || campo} registrado: *${valor}*\n\n_Pode enviar seus áudios normalmente!_`)
    }
    return
  }

  if (etapa === 'confirmacao') {
    if (['sim','s','yes','ok','confirmo','correto'].includes(resposta)) {
      limparSessao(de)
      await finalizarSalvamento(de, dados)
    } else if (['não','nao','n','errado'].includes(resposta)) {
      limparSessao(de)
      await enviarMensagem(de, '_Ok! Envie um novo áudio com os dados corrigidos._')
    } else {
      await enviarMensagem(de, '_Responda *sim* para salvar ou *não* para corrigir._')
    }
    return
  }

  if (etapa === 'movimentacoes') {
    dados._movPerguntada = true
    if (['não','nao','n','nenhuma','nenhum'].includes(resposta)) {
      setSessao(de, dados, 'confirmacao')
      await enviarMensagem(de, gerarResumoConfirmacao(dados))
      return
    }
    await processarComplemento(de, textoResposta, dados, 'movimentacoes')
    return
  }

  await processarComplemento(de, textoResposta, dados, etapa)
}

// ─── Processamento principal ──────────────────────────────────────────────────
async function processarAudio(de, mediaUrl) {
  const texto = await transcreverAudio(mediaUrl,
    process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  console.log('Transcrição:', texto.substring(0, 150))
  await processarTexto(de, texto)
}

async function processarTexto(de, texto) {
  const dados = await extrairDadosRebanho(texto)
  await avancarFluxo(de, dados)
}

// ─── Processar complemento (resposta a uma pergunta) ─────────────────────────
async function processarComplemento(de, resposta, dadosAtuais, etapa) {
  const complemento = await extrairComplemento(resposta, dadosAtuais, etapa)
  const dadosMerge = mesclarDados(dadosAtuais, complemento)
  await avancarFluxo(de, dadosMerge)
}

// ─── Avançar no fluxo verificando o que falta ────────────────────────────────
async function avancarFluxo(de, dados) {
  const faltando = analisarFaltando(dados)

  // Verificar campos obrigatórios em ordem
  for (const campo of ['periodo', 'existencia']) {
    if (faltando.includes(campo)) {
      setSessao(de, dados, campo)
      await enviarMensagem(de, gerarPergunta(campo, dados))
      return
    }
  }

  // Verificar movimentações (opcional mas importante)
  if (faltando.includes('movimentacoes') && !dados._movPerguntada) {
    setSessao(de, dados, 'movimentacoes')
    await enviarMensagem(de, gerarPergunta('movimentacoes', dados))
    return
  }

  // Tudo ok — ir para confirmação
  setSessao(de, dados, 'confirmacao')
  await enviarMensagem(de, gerarResumoConfirmacao(dados))
}

// ─── Mesclar dados extraídos ──────────────────────────────────────────────────
function mesclarDados(base, complemento) {
  const merged = { ...base }

  if (complemento.mes && !base.mes) merged.mes = complemento.mes
  if (complemento.ano && !base.ano) merged.ano = complemento.ano
  if (complemento.lote_nome && !base.lote_nome) merged.lote_nome = complemento.lote_nome
  if (complemento.lote_pasto && !base.lote_pasto) merged.lote_pasto = complemento.lote_pasto

  // Mesclar categorias
  const catMap = {}
  ;(base.categorias || []).forEach(c => { catMap[c.item] = { ...c } })

  ;(complemento.categorias || []).forEach(c => {
    if (catMap[c.item]) {
      // Atualizar campos que vieram zerados
      const campos = ['existencia_atual','existencia_anterior','entrada_nascimento',
        'entrada_compra','saida_morte','saida_venda','saida_desmama',
        'entrada_desmama','entrada_transferencia','saida_transferencia']
      campos.forEach(f => {
        if ((catMap[c.item][f] || 0) === 0 && (c[f] || 0) > 0) {
          catMap[c.item][f] = c[f]
        }
      })
    } else {
      catMap[c.item] = { ...c }
    }
  })

  merged.categorias = Object.values(catMap)

  // Recalcular totais
  merged.categorias = merged.categorias.map(cat => {
    const et = (cat.entrada_compra||0)+(cat.entrada_mudanca_cat||0)+
               (cat.entrada_desmama||0)+(cat.entrada_nascimento||0)+(cat.entrada_transferencia||0)
    const st = (cat.saida_abate||0)+(cat.saida_venda||0)+(cat.saida_morte||0)+
               (cat.saida_desmama||0)+(cat.saida_mudanca_cat||0)+(cat.saida_transferencia||0)
    const ea = Math.max(0, cat.existencia_atual || (cat.existencia_anterior||0)+et-st)
    return { ...cat, entrada_total: et, saida_total: st, existencia_atual: ea,
             indice_mortalidade: ea > 0 ? (cat.saida_morte||0)/ea : 0 }
  })

  return merged
}

// ─── Salvar após confirmação ──────────────────────────────────────────────────
async function finalizarSalvamento(de, dados) {
  const salvo = await salvarRebanho(dados, '', de)
  const resumo = gerarResumoWhatsApp(dados)
  await enviarMensagem(de, resumo)
  console.log(`Salvo: ${salvo.mes}/${salvo.ano} | ${salvo.totalCategorias} cats`)
  incrementarEnvios(de).catch(() => {})
  // Onboarding progressivo: perguntar um campo pendente após cada envio
  setTimeout(() => { perguntarProximoCadastro(de).catch(() => {}) }, 2000)
}

async function enviarMensagem(para, mensagem) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: para,
    body: mensagem,
  })
}

function formatarResumoRapido(meses) {
  if (!meses?.length) return 'Nenhum dado encontrado ainda.'
  const n = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
  return '*Resumo dos últimos meses:*\n\n' +
    meses.map(m => `*${n[m.mes]}/${m.ano}:* ${Number(m.total_rebanho).toLocaleString('pt-BR')} cab. | Nasc: ${m.total_nascimentos} | Mort: ${m.mortalidade_pct}%`).join('\n')
}

function formatarLotes(lotes) {
  if (!lotes?.length) return 'Nenhum lote cadastrado ainda.'
  return '*Resumo por Lote:*\n\n' + lotes.map(l =>
    `*${l.lote_nome}*\n  ${l.total_ativo} ativos | ${l.machos}M ${l.femeas}F | Mort: ${l.mortalidade_pct||0}%`
  ).join('\n\n')
}

// ─── APIs ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')))
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))

app.get('/api/resumo', async (req, res) => {
  try {
    res.json({ ok: true, data: await buscarResumoMensal(parseInt(req.query.meses||'12')) })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/categorias', async (req, res) => {
  try {
    const { mes, ano, fazenda='Grupo Ricci' } = req.query
    if (!mes||!ano) return res.status(400).json({ ok: false, error: 'mes e ano obrigatórios' })
    const { data: mensal } = await supabase.from('rebanho_mensal').select('id')
      .eq('mes',mes).eq('ano',ano).eq('fazenda',fazenda).single()
    if (!mensal) return res.json({ ok: true, data: [] })
    const { data, error } = await supabase.from('rebanho_categoria').select('*')
      .eq('rebanho_id', mensal.id).order('item')
    if (error) throw new Error(error.message)
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/lotes', async (req, res) => {
  try {
    res.json({ ok: true, data: await buscarResumoPorLote(req.query.fazenda||'Grupo Ricci') })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/animais', async (req, res) => {
  try {
    const { lote_id, fazenda='Grupo Ricci', status='ativo' } = req.query
    let q = supabase.from('animais').select('*, lotes(nome)').eq('fazenda',fazenda).eq('status',status).order('brinco')
    if (lote_id) q = q.eq('lote_id', lote_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`))
