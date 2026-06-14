require('dotenv').config()
// v1781208033558

const express = require('express')
const twilio = require('twilio')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const { transcreverAudio } = require('./transcricao')
const { extrairDadosRebanho, extrairComplemento, extrairMovimentacao, extrairMovimentacaoMultipla, detectarTipoRegistro, agentRoteador, agentConsulta, salvarExemploConfirmado, gerarResumoWhatsApp } = require('./extracao')
let _rag = null
function getRag() { if (!_rag) _rag = require('./rag'); return _rag }
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
  const temMovimentacao = temCategorias && dados.categorias.some(c =>
    (c.entrada_nascimento||0)+(c.entrada_compra||0)+(c.saida_morte||0)+
    (c.saida_venda||0)+(c.saida_desmama||0)+(c.entrada_desmama||0) > 0
  )
  if (!temExistencia && !temMovimentacao) faltando.push('existencia')

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
    // Se mes e ano já foram extraídos, pular para próxima etapa
    if (dados.mes && dados.ano) {
      return gerarPerguntaEtapa(dados, 'existencia')
    }
    return `_Não identifiquei a data nos dados._\n\n📅 *Para qual data é este mapa? (dia, mês e ano)*\nEx: *15 de março de 2026* ou *15/03/2026*`
  }

  if (etapa === 'existencia') {
    const temCats = (dados.categorias || []).filter(c => c.existencia_atual > 0)
    const temMov = (dados.categorias || []).filter(c =>
      (c.entrada_nascimento||0)+(c.entrada_compra||0)+(c.saida_morte||0)+(c.saida_venda||0) > 0
    )
    if (temMov.length > 0 && temCats.length === 0) {
      return '_Registrei as movimentações! Mas preciso do total atual._\n\n🐄 *Quantas cabeças tem ao total em cada categoria?*\nSe não souber, responda *0*.'
    }
    const jatem = temCats.length > 0 ? '\n\nJá registrei: ' + temCats.map(c => c.item + ' (' + c.existencia_atual + ')').join(', ') : ''
    return '_Não identifiquei as existências._' + jatem + '\n\n🐄 *Quantas cabeças tem ao total por categoria?*'
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
          if (dados.categorias && dados.categorias.length > 0 && dados._transcricaoOriginal) { salvarExemploConfirmado('mapa', dados._transcricaoOriginal, dados, dados.fazenda).catch(() => {}) }
          comprimirMemoriaUsuario(de).catch(() => {})
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

      // CADASTRO: resposta de texto para campos de onboarding
      if (etapa.startsWith('cadastro_') || etapa === 'movimentacao_campo') {
        responderWhatsApp(res, '_Processando..._')
        tratarRespostaSessao(de, corpo, dados, etapa).catch(err =>
          enviarMensagem(de, 'Erro: ' + err.message))
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
      saudarSeNecessario(de).catch(() => {})
      const logId = await criarLog(de, 'audio', { mediaUrl })
      responderWhatsApp(res, '_Recebi seu áudio! Transcrevendo e processando..._')
      processarAudio(de, mediaUrl, logId).catch(err => {
        console.log('[ERRO] Audio:', err.message, '| status:', err.response?.status, '| detail:', JSON.stringify(err.response?.data||{}).substring(0,80))
        enviarMensagem(de, `Erro: ${err.message}. Tente novamente.`)
      })
      return
    }

    // ── Texto longo novo ──
    if (corpo && corpo.trim().length > 20) {
      const logIdTxt = await criarLog(de, 'texto', { texto: corpo })
      responderWhatsApp(res, '_Processando..._')
      processarTexto(de, corpo, logIdTxt).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Comandos ──
    const correcao = detectarCorrecao(corpo)
    if (correcao && ultimaClassificacao[de]) {
      const ult = ultimaClassificacao[de]
      if (ult.intencao !== correcao.intencao) {
        registrarFeedback(de, ult.transcricao, ult.intencao, correcao.intencao).catch(() => {})
        delete ultimaClassificacao[de]
        return responderWhatsApp(res, '_Entendido! Aprendi com essa correção._ ✅')
      }
    }

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

  // Aprendizado ativo
  if (etapa === 'confirmar_intencao') {
    var txOrig = dados.texto, lidOrig = dados.logId, intOrig = dados.intencao
    var respLower = textoResposta.toLowerCase().trim()
    limparSessao(de)
    if (respLower === 'sim' || respLower === 's') {
      registrarFeedback(de, txOrig, intOrig, intOrig).catch(() => {})
      if (dados.dadosPre) {
        if (intOrig === 'movimentacao') {
          var movsPre = Array.isArray(dados.dadosPre) ? dados.dadosPre : [dados.dadosPre]
          for (var mvp of movsPre) await processarMovimentacao(de, mvp, txOrig)
        } else if (intOrig === 'mapa') {
          // Determinar etapa correta com base nos dados pré-extraídos
          var etapaInicial = (dados.dadosPre.mes && dados.dadosPre.ano) ? 'existencia' : 'periodo'
          setSessao(de, dados.dadosPre, etapaInicial)
          await processarComplemento(de, txOrig, dados.dadosPre, etapaInicial)
        } else { await processarTexto(de, txOrig, lidOrig) }
      } else { await processarTexto(de, txOrig, lidOrig) }
    } else {
      var intCorr = intOrig
      if (respLower.includes('mapa') || respLower.includes('fechamento')) intCorr = 'mapa'
      else if (respLower.includes('movim') || respLower.includes('compra') || respLower.includes('venda') || respLower.includes('morte') || respLower.includes('nasc')) intCorr = 'movimentacao'
      else if (respLower.includes('consul')) intCorr = 'consulta'
      registrarFeedback(de, txOrig, intOrig, intCorr).catch(() => {})
      atualizarLog(lidOrig, { intencao_detectada: intCorr }).catch(() => {})
      if (intCorr === 'movimentacao') { var movs2 = await extrairMovimentacaoMultipla(txOrig); for (var mv of movs2) await processarMovimentacao(de, mv, txOrig) }
      else if (intCorr === 'consulta') { var dr2 = await buscarResumoMensal(6); var ctx3 = await obterMemoriaUsuario(de); await enviarMensagem(de, await agentConsulta(txOrig, dr2, ctx3)) }
      else await processarTexto(de, txOrig, lidOrig)
      await enviarMensagem(de, '_Aprendi com essa correção!_ ✅')
    }
    return
  }

  // Etapa de movimentação com campos faltando
  if (etapa === 'movimentacao_campo') {
    const movDados = dados.mov || {}
    const falt = dados.faltando || []
    const PERGS = {
      tipo: '📋 *Qual o tipo?* (morte, compra, venda, transferência, nascimento)',
      quantidade: '🔢 *Quantos animais?*',
      categoria: '🐄 *Qual a categoria?* (boi, vaca, novilho, bezerra...)',
      data: '📅 *Qual a data?* (dia/mês/ano)'
    }
    const campoAtual = falt[0]
    if (campoAtual === 'quantidade') movDados.quantidade = parseInt(textoResposta) || 0
    else movDados[campoAtual] = textoResposta.trim()
    const faltRest = falt.slice(1)
    if (faltRest.length > 0) {
      setSessao(de, { _movimentacao: true, mov: movDados, faltando: faltRest }, 'movimentacao_campo')
      await enviarMensagem(de, PERGS[faltRest[0]] || 'Informe: ' + faltRest[0])
    } else {
      limparSessao(de)
      await salvarEResponderMovimentacao(de, movDados)
    }
    return
  }

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
    if (['sim','s','yes','ok','confirmo','correto','pode salvar','salvar'].includes(resposta)) {
      limparSessao(de)
      await finalizarSalvamento(de, dados)
      return
    }
    if (['não','nao','n','errado','cancela','cancelar'].includes(resposta)) {
      limparSessao(de)
      await enviarMensagem(de, '_Ok! Envie um novo áudio com os dados corrigidos._')
      return
    }
    // Resposta longa = correção! Extrair e mesclar
    if (resposta.length > 10) {
      await enviarMensagem(de, '_Aplicando correção..._')
      const complemento = await extrairComplemento(textoResposta, dados, 'movimentacoes')
      const dadosCorrigidos = mesclarDados(dados, complemento)
      setSessao(de, dadosCorrigidos, 'confirmacao')
      await enviarMensagem(de, gerarResumoConfirmacao(dadosCorrigidos))
      return
    }
    await enviarMensagem(de, '_Responda *sim* para salvar, *não* para cancelar, ou fale a correção (ex: "morreram três")._')
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
async function processarAudio(de, mediaUrl, logId) {
  const texto = await transcreverAudio(mediaUrl,
    process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  console.log('Transcrição:', texto.substring(0, 150))
  await processarTexto(de, texto)
}

async function processarTexto(de, texto, logId) {
  // Detectar se é movimentação pontual ou mapa mensal
  const sessaoAtiva2 = sessoes[de]
  const jaTemSessao = sessaoAtiva2 && sessaoAtiva2.dados && !sessaoAtiva2.dados._cadastro

  if (!jaTemSessao) {
    const ctx = await obterMemoriaUsuario(de)
    const exemplos = await buscarExemplosFewShot(6)
    const rota = await agentRoteador(texto, ctx, exemplos)
    ultimaClassificacao[de] = { intencao: rota.intencao, transcricao: texto }
    atualizarLog(logId, { intencao_detectada: rota.intencao, confianca: rota.confianca, status: 'processando', modelo_usado: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001' }).catch(() => {})

    // APRENDIZADO ATIVO — limiar dinâmico da tabela configuracoes
    var confiancaRota = rota.confianca || 1
    var limiarConfianca = parseFloat(process.env.CFG_LIMIAR_CONFIANCA || '0.7')
    if (confiancaRota < limiarConfianca) {
      var LABELS = { mapa:'fechamento mensal', movimentacao:'movimentação pontual', consulta:'consulta', cadastro:'cadastro' }
      // Pré-extrair para não reextrair após confirmação
      var dadosPre = null
      try {
        if (rota.intencao === 'mapa') { dadosPre = await extrairDadosRebanho(texto); dadosPre._transcricaoOriginal = texto }
        else if (rota.intencao === 'movimentacao') { dadosPre = await extrairMovimentacaoMultipla(texto) }
      } catch(e) { console.log('[WARN] Pré-extração:', e.message) }
      setSessao(de, { _pendente: true, texto: texto, logId: logId, intencao: rota.intencao, dadosPre: dadosPre }, 'confirmar_intencao')
      await enviarMensagem(de, '_Identifiquei como *' + (LABELS[rota.intencao]||rota.intencao) + '* (' + Math.round(confiancaRota*100) + '% de certeza)._\n\n✅ *sim* — confirmar\n❌ *não* — corrija: mapa, movimentação ou consulta')
      return
    }

    if (rota.intencao === 'movimentacao') {
      console.log('Roteador → MOVIMENTAÇÃO')
      const movs = await extrairMovimentacaoMultipla(texto)
      for (const mov of movs) { await processarMovimentacao(de, mov, texto) }
      return
    }
    if (rota.intencao === 'consulta') {
      const dr = await buscarResumoMensal(6)
      await enviarMensagem(de, await agentConsulta(texto, dr))
      return
    }
    console.log('Roteador → MAPA')
  }

  const dados = await extrairDadosRebanho(texto)
  dados._transcricaoOriginal = texto

  // Se há sessão ativa com dados do mesmo período, mesclar em vez de descartar
  const sessaoAtiva = sessaoAtiva2
  if (sessaoAtiva && sessaoAtiva.dados && !sessaoAtiva.dados._cadastro) {
    const dadosBase = sessaoAtiva.dados
    const mesmoMes = (!dados.mes && !dados.ano) ||
                     (!dadosBase.mes && !dadosBase.ano) ||
                     (dados.mes === dadosBase.mes && dados.ano === dadosBase.ano)
    if (mesmoMes) {
      console.log("Mesclando novo áudio com sessão existente (" + sessaoAtiva.etapa + ")")
      const dadosMerge = mesclarDados(dadosBase, dados)
      dadosMerge._movPerguntada = dadosBase._movPerguntada
      await avancarFluxo(de, dadosMerge)
      return
    }
  }

  await avancarFluxo(de, dados)
}

// ─── Processar complemento (resposta a uma pergunta) ─────────────────────────
async function processarComplemento(de, resposta, dadosAtuais, etapa) {
  const complemento = await extrairComplemento(resposta, dadosAtuais, etapa)
  const dadosMerge = mesclarDados(dadosAtuais, complemento)
  // Preservar flags de controle de fluxo
  dadosMerge._movPerguntada = dadosAtuais._movPerguntada
  dadosMerge._existPerguntada = dadosAtuais._existPerguntada
  await avancarFluxo(de, dadosMerge)
}

// ─── Avançar no fluxo verificando o que falta ────────────────────────────────
async function avancarFluxo(de, dados) {
  const faltando = analisarFaltando(dados)

  // Verificar período (sempre obrigatório)
  if (faltando.includes('periodo')) {
    setSessao(de, dados, 'periodo')
    await enviarMensagem(de, gerarPergunta('periodo', dados))
    return
  }

  // Verificar existência — apenas uma vez (flag _existPerguntada)
  if (faltando.includes('existencia') && !dados._existPerguntada) {
    dados._existPerguntada = true
    setSessao(de, dados, 'existencia')
    await enviarMensagem(de, gerarPergunta('existencia', dados))
    return
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

  merged.mes = complemento.mes || base.mes || null
  merged.ano = complemento.ano || base.ano || null
  merged.dia = complemento.dia || base.dia || null
  if (complemento.lote_nome) merged.lote_nome = complemento.lote_nome
  if (complemento.lote_pasto) merged.lote_pasto = complemento.lote_pasto
  if (complemento.fazenda && complemento.fazenda !== 'Grupo Ricci') merged.fazenda = complemento.fazenda

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



// ════════════════════════════════════════════════════════════════════════════════
// MEMÓRIA DE CONTEXTO
// ════════════════════════════════════════════════════════════════════════════════

async function obterContextoUsuario(whatsapp) {
  try {
    const usuario = await obterOuCriarUsuario(whatsapp)
    const historico = JSON.parse(usuario.contexto_json || '[]')
    return {
      nome: usuario.nome, funcao: usuario.funcao,
      fazenda: usuario.fazenda, lotes: usuario.lotes_cuida,
      historico: historico.slice(0,3),
      ultimaFazenda: historico[0]?.fazenda || usuario.fazenda || 'Grupo Ricci',
    }
  } catch(e) { return { fazenda: 'Grupo Ricci', historico: [] } }
}

async function atualizarContextoUsuario(whatsapp, dados) {
  try {
    const usuario = await obterOuCriarUsuario(whatsapp)
    const historico = JSON.parse(usuario.contexto_json || '[]')
    historico.unshift({ ts: new Date().toISOString(), tipo: dados._tipoRegistro || 'mapa', fazenda: dados.fazenda, mes: dados.mes, ano: dados.ano })
    const updates = {
      ultima_atividade: new Date().toISOString(),
      total_envios: (usuario.total_envios || 0) + 1,
      contexto_json: JSON.stringify(historico.slice(0,10)),
    }
    if (dados.fazenda && dados.fazenda !== 'Grupo Ricci') updates.fazenda = dados.fazenda
    await supabase.from('usuarios').update(updates).eq('whatsapp', whatsapp)
  } catch(e) { console.log('[WARN] contexto:', e.message) }
}



// ════════════════════════════════════════════════════════════════════════════════
// FEEDBACK LOOP
// ════════════════════════════════════════════════════════════════════════════════

const ultimaClassificacao = {}

async function registrarFeedback(whatsapp, transcricao, intencaoBot, intencaoCorreta) {
  try {
    await supabase.from('bot_feedback').insert({ whatsapp, transcricao, intencao_bot: intencaoBot, intencao_correta: intencaoCorreta })
    const { data: novoEx } = await supabase.from('bot_exemplos').insert({ transcricao, intencao: intencaoCorreta, fonte: 'feedback' }).select('id').single()
    console.log('Feedback:', intencaoBot, '->', intencaoCorreta)
    // Gerar embedding RAG para o novo exemplo
    if (novoEx?.id) getRag().salvarEmbedding('bot_exemplos', novoEx.id, transcricao).catch(() => {})
  } catch(e) { console.log('[WARN] feedback:', e.message) }
}

async function buscarExemplosFewShot(limite) {
  try {
    const { data } = await supabase.from('bot_exemplos').select('transcricao, intencao').eq('ativo', true).order('criado_em', { ascending: false }).limit(limite || 6)
    return data || []
  } catch(e) { return [] }
}

function detectarCorrecao(texto) {
  const lower = (texto || '').toLowerCase().trim()
  if (/era.*(movimenta|mapa|consulta)/i.test(lower) || /isso.*[eé].*(movimenta|mapa|consulta)/i.test(lower)) {
    const m = lower.match(/(movimenta[cç][aã]o|mapa|consulta|compra|venda|morte|nascimento)/)
    if (m) {
      const p = m[1]
      if (p === 'mapa') return { intencao: 'mapa' }
      if (p === 'consulta') return { intencao: 'consulta' }
      return { intencao: 'movimentacao' }
    }
  }
  return null
}


// ════════════════════════════════════════════════════════════════════════════════
// MEMÓRIA LONGA COM COMPRESSÃO
// ════════════════════════════════════════════════════════════════════════════════

async function comprimirMemoriaUsuario(whatsapp) {
  try {
    const usuario = await obterOuCriarUsuario(whatsapp)
    const historico = JSON.parse(usuario.contexto_json || '[]')
    if (historico.length < 5) return usuario.memoria_comprimida || null
    const axios = require('axios')
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini', max_tokens: 200,
      messages: [
        { role: 'system', content: 'Crie um resumo compacto (máximo 150 palavras) do perfil deste usuário de sistema de gestão de rebanho bovino. Seja direto e factual.' },
        { role: 'user', content: 'Nome: ' + (usuario.nome||'?') + '\nFunção: ' + (usuario.funcao||'?') + '\nFazenda: ' + (usuario.fazenda||'Grupo Ricci') + '\nLotes: ' + (usuario.lotes_cuida||'?') + '\nTotal envios: ' + (usuario.total_envios||0) + '\nHistórico: ' + JSON.stringify(historico.slice(0,8)) }
      ]
    }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    const memoria = resp.data.choices[0].message.content.trim()
    await supabase.from('usuarios').update({ memoria_comprimida: memoria, memoria_atualizada_em: new Date().toISOString() }).eq('whatsapp', whatsapp)
    console.log('Memória comprimida:', whatsapp, memoria.length + ' chars')
    return memoria
  } catch(e) { console.log('[WARN] memória:', e.message); return null }
}

async function obterMemoriaUsuario(whatsapp) {
  try {
    const usuario = await obterOuCriarUsuario(whatsapp)
    const historico = JSON.parse(usuario.contexto_json || '[]')
    const agora = new Date()
    const ultimaAtt = usuario.memoria_atualizada_em ? new Date(usuario.memoria_atualizada_em) : null
    const horas = ultimaAtt ? (agora - ultimaAtt) / 3600000 : 999
    if (historico.length >= 5 && horas > 24) comprimirMemoriaUsuario(whatsapp).catch(() => {})
    return {
      nome: usuario.nome, funcao: usuario.funcao,
      fazenda: usuario.fazenda, lotes: usuario.lotes_cuida,
      resumo: usuario.memoria_comprimida || null,
      historico: historico.slice(0, 3),
      ultimaFazenda: historico[0]?.fazenda || usuario.fazenda || 'Grupo Ricci',
    }
  } catch(e) { return { fazenda: 'Grupo Ricci', historico: [] } }
}

// ─── Saudação personalizada ────────────────────────────────────────────────────
const ultimaSaudacao = {} // cache em memória: { whatsapp: Date }

async function saudarSeNecessario(de) {
  try {
    const agora = new Date()
    const ultima = ultimaSaudacao[de]

    // Só saudar uma vez a cada 6 horas
    if (ultima && (agora - ultima) < 6 * 60 * 60 * 1000) return

    ultimaSaudacao[de] = agora

    const ctx = await obterContextoUsuario(de)
    if (!ctx.nome) return // sem nome cadastrado, não saudar

    const hora = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })
    const h = parseInt(hora)
    const periodo = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'

    let msg = '*' + periodo + ', ' + ctx.nome.split(' ')[0] + '!* 👋'

    if (ctx.historico && ctx.historico.length > 0) {
      const ult = ctx.historico[0]
      const meses = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
      if (ult.tipo === 'mapa' && ult.mes && ult.ano) {
        msg += '\nÚltimo registro: mapa de ' + meses[ult.mes] + '/' + ult.ano
      } else if (ult.tipo === 'movimentacao') {
        msg += '\nÚltimo registro: movimentação em ' + (ult.fazenda || ctx.fazenda || 'Grupo Ricci')
      }
    }

    msg += '\n\n_Pode enviar o áudio quando quiser._'
    await enviarMensagem(de, msg)
  } catch(e) {
    console.log('[WARN] saudação:', e.message)
  }
}


// ═══════════════════════════════════════════════════════════════
// LOG DE MENSAGENS
// ═══════════════════════════════════════════════════════════════

async function criarLog(whatsapp, tipo, dados) {
  try {
    const { data } = await supabase.from('bot_logs').insert({ whatsapp, tipo, texto_original: dados.texto||null, media_url: dados.mediaUrl||null, status: 'recebido', recebido_em: new Date().toISOString() }).select('id').single()
    return data?.id || null
  } catch(e) { return null }
}

async function atualizarLog(logId, updates) {
  if (!logId) return
  try { await supabase.from('bot_logs').update({ ...updates, processado_em: new Date().toISOString() }).eq('id', logId) } catch(e) {}
}

// ─── Processar movimentação pontual ──────────────────────────────────────────
async function processarMovimentacao(de, mov, textoOriginal) {
  const faltando = []
  if (!mov.tipo) faltando.push('tipo')
  if (!mov.quantidade || mov.quantidade === 0) faltando.push('quantidade')
  if (!mov.categoria) faltando.push('categoria')
  if (!mov.data_mov && !mov.mes) faltando.push('data')

  if (faltando.length > 0) {
    const PERGUNTAS = {
      tipo:       '📋 *Qual o tipo de movimentação?*\nEx: morte, compra, venda, transferência, nascimento',
      quantidade: '🔢 *Quantos animais foram movimentados?*',
      categoria:  '🐄 *Qual a categoria dos animais?*\nEx: boi, vaca, novilho, bezerra...',
      data:       '📅 *Qual a data da movimentação?* (dia/mês/ano)',
    }
    setSessao(de, { _movimentacao: true, mov, faltando }, 'movimentacao_campo')
    await enviarMensagem(de, '_Registrei a movimentação! Alguns dados ficaram faltando._\n\n' + PERGUNTAS[faltando[0]])
    return
  }
  await salvarEResponderMovimentacao(de, mov)
}

async function salvarEResponderMovimentacao(de, mov) {
  try {
    const tipoMap = {
      entrada_compra: 'entrada_compra', saida_venda: 'saida_venda',
      transferencia: 'entrada_transferencia', saida_morte: 'saida_morte',
      entrada_nascimento: 'entrada_nascimento', entrada_desmama: 'entrada_desmama',
      saida_desmama: 'saida_desmama', pesagem: 'pesagem',
    }
    const tipo = tipoMap[mov.tipo] || mov.tipo || 'entrada_compra'
    let dataIso = null
    if (mov.dia && mov.mes && mov.ano) {
      dataIso = mov.ano + '-' + String(mov.mes).padStart(2,'0') + '-' + String(mov.dia).padStart(2,'0')
    }
    await supabase.from('movimentacoes_lote').insert({
      fazenda:        mov.fazenda || 'Grupo Ricci',
      tipo,
      data_mov:       dataIso || new Date().toISOString().substring(0, 10),
      quantidade:     mov.quantidade || 1,
      peso:           mov.peso || null,
      valor:          mov.valor || null,
      categoria:      mov.categoria || null,
      categoria_item: mov.categoria_item || null,
      sexo:           mov.sexo || null,
      responsavel:    mov.responsavel || null,
      ocorrencia:     mov.ocorrencia || null,
      motivo:         mov.motivo || null,
      lote_origem:    mov.origem || null,
      lote_destino:   mov.destino || null,
      observacoes:    [mov.brincos && 'Brincos: '+mov.brincos].filter(Boolean).join(' | ') || null,
      whatsapp_de: de,
    })

    const tipoLabel = {
      entrada_compra: 'Compra', saida_venda: 'Venda',
      transferencia: 'Transferência', saida_morte: 'Morte',
      entrada_nascimento: 'Nascimento', entrada_desmama: 'Desmama', pesagem: 'Pesagem',
    }[mov.tipo] || mov.tipo || '—'

    const dataStr = mov.dia ? mov.dia + '/' + mov.mes + '/' + mov.ano : 'hoje'

    await enviarMensagem(de,
      '*Movimentação registrada!* ✅\n\n' +
      '*Tipo:* '       + tipoLabel + '\n' +
      '*Data:* '       + dataStr   + '\n' +
      '*Quantidade:* ' + (mov.quantidade || '?') + ' cabeças\n' +
      '*Categoria:* '  + (mov.categoria  || '?') + '\n' +
      (mov.origem      ? '*Origem:* '      + mov.origem      + '\n' : '') +
      (mov.destino     ? '*Destino:* '     + mov.destino     + '\n' : '') +
      (mov.responsavel ? '*Responsável:* ' + mov.responsavel + '\n' : '') +
      (mov.ocorrencia  ? '\n⚠️ *Ocorrência:* ' + mov.ocorrencia : '')
    )
  } catch(err) {
    console.error('Erro ao salvar movimentação:', err.message)
    await enviarMensagem(de, 'Erro ao salvar movimentação: ' + err.message)
  }
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
  try {
    return await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: para,
      body: mensagem,
    })
  } catch (err) {
    console.log('[ERRO] Twilio:', err.message, '| status:', err.response?.status, '| detail:', JSON.stringify(err.response?.data||{}).substring(0,80))
    return null
  }
}

// Segurança global: nunca derrubar o processo por promise rejeitada
process.on('unhandledRejection', (err) => {
  console.error('UnhandledRejection:', err?.message || err)
})
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err?.message || err)
})

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


app.get('/api/resumo/dias', async (req, res) => {
  try {
    const { mes, ano, fazenda = 'Grupo Ricci' } = req.query
    if (!mes || !ano) return res.status(400).json({ ok: false, error: 'mes e ano obrigatorios' })
    const { data, error } = await supabase
      .from('vw_resumo_mensal')
      .select('*')
      .eq('mes', mes)
      .eq('ano', ano)
      .eq('fazenda', fazenda)
      .order('dia', { ascending: true, nullsFirst: false })
    if (error) throw new Error(error.message)
    res.json({ ok: true, data: data || [] })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})


app.get('/api/movimentacoes', async (req, res) => {
  try {
    const { limite = 50, fazenda = 'Grupo Ricci' } = req.query
    const { data, error } = await supabase
      .from('movimentacoes_lote')
      .select('*')
      .eq('fazenda', fazenda)
      .order('data_mov', { ascending: false, nullsFirst: false })
      .limit(parseInt(limite))
    if (error) throw new Error(error.message)
    res.json({ ok: true, data: data || [] })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})


app.post('/api/busca', async (req, res) => {
  try {
    const { query } = req.body
    if (!query) return res.status(400).json({ ok: false, error: 'query obrigatória' })
    const rag = require('./rag')
    const embedding = await rag.gerarEmbedding(query)
    const [r1, r2] = await Promise.all([
      supabase.rpc('buscar_exemplos_similares', { query_embedding: embedding, tipo_filtro: null, limite: 5 }),
      supabase.rpc('buscar_classificacao_similar', { query_embedding: embedding, limite: 3 }),
    ])
    const { agentConsulta } = require('./extracao')
    const dadosRebanho = await buscarResumoMensal(12)
    const resposta = await agentConsulta(query, dadosRebanho)
    res.json({ ok: true, resposta, exemplos_similares: r1.data || [], classificacoes: r2.data || [] })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})


app.get('/api/anomalias', async (req, res) => {
  try {
    const { fazenda = 'Grupo Ricci', forcar = 'false' } = req.query
    const { analisarRebanho } = require('./anomalias')
    if (forcar === 'true') {
      const anomalias = await analisarRebanho(fazenda)
      return res.json({ ok: true, data: anomalias })
    }
    const { data } = await supabase.from('bot_anomalias').select('*').eq('fazenda', fazenda).eq('resolvido', false).order('detectado_em', { ascending: false })
    res.json({ ok: true, data: data || [] })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})


app.get('/api/logs', async (req, res) => {
  try {
    const { limite = 50, status } = req.query
    let q = supabase.from('bot_logs').select('id,whatsapp,tipo,transcricao,texto_original,intencao_detectada,confianca,status,erro,salvo,recebido_em').order('recebido_em', { ascending: false }).limit(parseInt(limite))
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    res.json({ ok: true, data: data || [] })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/qualidade', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vw_qualidade_bot').select('*').limit(30)
    if (error) throw new Error(error.message)
    res.json({ ok: true, data: data || [] })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})


app.get('/api/exportar-finetuning', async (req, res) => {
  try {
    const { minimo = 10 } = req.query
    const { data: exemplos } = await supabase.from('bot_exemplos_extracao').select('transcricao, saida_json, tipo').eq('ativo', true).not('saida_json', 'is', null).order('criado_em', { ascending: false }).limit(500)
    if (!exemplos || exemplos.length < parseInt(minimo)) return res.json({ ok: false, error: 'Poucos exemplos (' + (exemplos?.length||0) + '). Minimo: ' + minimo })
    const SYSTEM_MAPA = 'Você é especialista em pecuária. Extraia dados do mapa de rebanho do texto e retorne APENAS JSON válido.'
    const SYSTEM_MOV  = 'Você é especialista em pecuária. Extraia dados de movimentação do texto e retorne APENAS JSON válido como array.'
    const linhas = exemplos.map(function(ex) {
      return JSON.stringify({ messages: [{ role:'system', content: ex.tipo==='movimentacao'?SYSTEM_MOV:SYSTEM_MAPA }, { role:'user', content:'Texto: "'+ex.transcricao+'"' }, { role:'assistant', content: JSON.stringify(ex.saida_json) }] })
    })
    const porTipo = {}; exemplos.forEach(function(e) { porTipo[e.tipo]=(porTipo[e.tipo]||0)+1 })
    res.setHeader('Content-Type','application/jsonl')
    res.setHeader('Content-Disposition','attachment; filename="finetuning_'+new Date().toISOString().substring(0,10)+'.jsonl"')
    res.setHeader('X-Total-Exemplos', exemplos.length)
    res.setHeader('X-Por-Tipo', JSON.stringify(porTipo))
    res.send(linhas.join('\n'))
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/exportar-finetuning/stats', async (req, res) => {
  try {
    const { data: exemplos } = await supabase.from('bot_exemplos_extracao').select('tipo, fonte').eq('ativo', true)
    const stats = { total: exemplos?.length||0, por_tipo:{}, por_fonte:{}, pronto:false, recomendacao:'' }
    ;(exemplos||[]).forEach(function(e) { stats.por_tipo[e.tipo]=(stats.por_tipo[e.tipo]||0)+1; stats.por_fonte[e.fonte]=(stats.por_fonte[e.fonte]||0)+1 })
    stats.pronto = stats.total >= 10
    if (stats.total < 10) stats.recomendacao = 'Precisa de mais '+(10-stats.total)+' exemplos. Continue confirmando com "sim" no bot.'
    else if (stats.total < 50) stats.recomendacao = stats.total+' exemplos — fine-tuning básico possível. Ideal: 50+.'
    else stats.recomendacao = stats.total+' exemplos — pronto para fine-tuning de qualidade!'
    res.json({ ok: true, data: stats })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})


// ─── Agente de Logs — busca e analisa logs do Fly.io automaticamente ──────────
let _agenteLogs = null
function getAgenteLogs() {
  if (!_agenteLogs) _agenteLogs = require('./agente_logs')
  return _agenteLogs
}

// Endpoint para execução manual e consulta de insights
app.get('/api/insights', async (req, res) => {
  try {
    const { data } = await supabase
      .from('bot_insights')
      .select('*')
      .order('detectado_em', { ascending: false })
    res.json({ ok: true, data: data || [] })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/insights/executar', async (req, res) => {
  try {
    const resultado = await getAgenteLogs().executarCiclo({ limite: 200 })
    res.json({ ok: true, ...resultado })
  } catch(err) { res.status(500).json({ ok: false, error: err.message }) }
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
app.listen(PORT, () => {
  console.log(`Servidor na porta ${PORT}`)
  supabase.from('configuracoes').select('chave, valor').then(({ data }) => {
    if (data) data.forEach(c => { process.env['CFG_'+c.chave.toUpperCase()] = c.valor })
    console.log('Configurações carregadas:', (data||[]).length)
  }).catch(() => {})
  setTimeout(() => {
    getRag().indexarExemplosPendentes().catch(e => console.log('RAG indexação:', e.message))
    setTimeout(function() { require('./anomalias').analisarRebanho('Grupo Ricci').catch(function(){}) }, 20000)
    // Agente de logs — primeira execução após 30s
    setTimeout(function() {
      getAgenteLogs().executarCiclo({ limite: 200 }).catch(e => console.log('AgenteLogs startup:', e.message))
    }, 30000)
  }, 10000)

  // Agente de logs — ciclo a cada 10 minutos
  setInterval(function() {
    getAgenteLogs().executarCiclo({ limite: 200 }).catch(e => console.log('AgenteLogs cron:', e.message))
  }, 10 * 60 * 1000)
})
