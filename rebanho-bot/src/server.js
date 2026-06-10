require('dotenv').config()

const express = require('express')
const twilio = require('twilio')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const { transcreverAudio } = require('./transcricao')
const { extrairDadosRebanho, gerarResumoWhatsApp } = require('./extracao')
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

// ─── Sessões em memória ───────────────────────────────────────────────────────
// Aguardando período:  { texto, dados, ts }
// Aguardando lote:     { texto, dados, ts }
const sessoesPeriodo = {}
const sessoesLote    = {}

const SESSION_TTL = 10 * 60 * 1000 // 10 minutos

function limparSessao(mapa, chave) {
  setTimeout(() => { delete mapa[chave] }, SESSION_TTL)
}

function validarTwilio(req, res, next) {
  const assinatura = req.headers['x-twilio-signature']
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const valido = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN, assinatura, url, req.body
  )
  // if (!valido) return res.status(403).send('Forbidden')
  next()
}

function responderWhatsApp(res, mensagem) {
  const twiml = new twilio.twiml.MessagingResponse()
  twiml.message(mensagem)
  res.type('text/xml').send(twiml.toString())
}

// ─── Webhook principal ────────────────────────────────────────────────────────
app.post('/webhook/whatsapp', validarTwilio, async (req, res) => {
  const { From: de, Body: corpo, NumMedia: numMedia,
    MediaUrl0: mediaUrl, MediaContentType0: mediaType } = req.body

  console.log(`Msg de ${de} | Mídia: ${numMedia} | Tipo: ${mediaType}`)

  try {
    // ── Sessão aguardando PERÍODO ──
    if (sessoesPeriodo[de]) {
      const { texto } = sessoesPeriodo[de]
      delete sessoesPeriodo[de]
      responderWhatsApp(res, '_Entendido! Processando com o período informado..._')
      processarTexto(de, `${(corpo||'').trim()}. ${texto}`).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Sessão aguardando LOTE ──
    if (sessoesLote[de]) {
      const { dados } = sessoesLote[de]
      delete sessoesLote[de]
      dados.lote_nome = (corpo || '').trim()
      responderWhatsApp(res, `_Lote "${dados.lote_nome}" registrado! Salvando..._`)
      finalizarSalvamento(de, dados).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Áudio ──
    if (parseInt(numMedia) > 0 && mediaType?.startsWith('audio')) {
      responderWhatsApp(res, '_Recebi seu áudio! Transcrevendo e processando..._')
      processarAudio(de, mediaUrl).catch(err => {
        console.error('Erro:', err)
        enviarMensagem(de, `Erro ao processar: ${err.message}. Tente novamente.`)
      })
      return
    }

    // ── Texto longo ──
    if (corpo && corpo.trim().length > 20) {
      responderWhatsApp(res, '_Processando seus dados..._')
      processarTexto(de, corpo).catch(err =>
        enviarMensagem(de, `Erro: ${err.message}`))
      return
    }

    // ── Comandos ──
    const cmd = (corpo || '').trim().toLowerCase()
    if (cmd === 'resumo') {
      const resumo = await buscarResumoMensal(3)
      return responderWhatsApp(res, formatarResumoRapido(resumo))
    }
    if (cmd === 'lotes') {
      const lotes = await buscarResumoPorLote()
      return responderWhatsApp(res, formatarLotes(lotes))
    }

    responderWhatsApp(res,
      `*Olá! Sou o assistente de rebanho do Grupo Ricci.* 🐄\n\nEnvie um *áudio* com os dados do mapa de rebanho.\n\nComandos:\n- *resumo* — últimos 3 meses\n- *lotes* — resumo por lote`)
  } catch (err) {
    console.error('Erro webhook:', err)
    responderWhatsApp(res, 'Erro inesperado. Tente novamente.')
  }
})

// ─── Processamento ────────────────────────────────────────────────────────────
async function processarAudio(de, mediaUrl) {
  const texto = await transcreverAudio(mediaUrl,
    process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  console.log('Transcrição:', texto.substring(0, 150))
  await processarTexto(de, texto)
}

async function processarTexto(de, texto) {
  const dados = await extrairDadosRebanho(texto)

  // Sem período → perguntar
  if (!dados.mes || !dados.ano) {
    sessoesPeriodo[de] = { texto, ts: Date.now() }
    limparSessao(sessoesPeriodo, de)
    await enviarMensagem(de,
      `_Não identifiquei o período nos dados._\n\n📅 *Para qual mês e ano é este mapa?*\n\nEx: *março de 2026* ou *03/2026*`)
    return
  }

  await finalizarSalvamento(de, dados)
}

async function finalizarSalvamento(de, dados) {
  // Sem lote → usar "Geral" automaticamente (não interrompe o fluxo)
  // Se quiser perguntar o lote, descomente o bloco abaixo:
  /*
  if (!dados.lote_nome) {
    sessoesLote[de] = { dados, ts: Date.now() }
    limparSessao(sessoesLote, de)
    await enviarMensagem(de,
      `_Dados recebidos! Mas não identifiquei o lote._\n\n🐄 *Qual o lote ou pasto desses animais?*\n\nEx: *Pasto Norte*, *Lote A*, *Curral 2*\n\nOu responda *Geral* para usar o lote padrão.`)
    return
  }
  */

  const salvo = await salvarRebanho(dados, '', de)
  console.log(`Salvo: ${salvo.mes}/${salvo.ano} | lote: ${dados.lote_nome || 'Geral'} | cats: ${salvo.totalCategorias}`)
  const resumo = gerarResumoWhatsApp(dados)
  await enviarMensagem(de, resumo)
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
  return `*Resumo dos últimos meses:*\n\n` +
    meses.map(m => `*${n[m.mes]}/${m.ano}:* ${Number(m.total_rebanho).toLocaleString('pt-BR')} cab. | Nasc: ${m.total_nascimentos} | Mort: ${m.mortalidade_pct}%`).join('\n')
}

function formatarLotes(lotes) {
  if (!lotes?.length) return 'Nenhum lote cadastrado ainda.'
  const linhas = lotes.map(l =>
    `*${l.lote_nome}* (${l.finalidade || 'misto'})\n  ${l.total_ativo} ativos | ${l.machos}M ${l.femeas}F | Mort: ${l.mortalidade_pct || 0}%${l.ocupacao_pct ? ' | Ocup: ' + l.ocupacao_pct + '%' : ''}`
  )
  return `*Resumo por Lote:*\n\n` + linhas.join('\n\n')
}

// ─── APIs ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')))
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))

app.get('/api/resumo', async (req, res) => {
  try {
    const data = await buscarResumoMensal(parseInt(req.query.meses || '12'))
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/categorias', async (req, res) => {
  try {
    const { mes, ano, fazenda = 'Grupo Ricci' } = req.query
    if (!mes || !ano) return res.status(400).json({ ok: false, error: 'mes e ano obrigatórios' })
    const { data: mensal } = await supabase
      .from('rebanho_mensal').select('id').eq('mes', mes).eq('ano', ano).eq('fazenda', fazenda).single()
    if (!mensal) return res.json({ ok: true, data: [] })
    const { data, error } = await supabase
      .from('rebanho_categoria').select('*').eq('rebanho_id', mensal.id).order('item')
    if (error) throw new Error(error.message)
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/lotes', async (req, res) => {
  try {
    const { fazenda = 'Grupo Ricci' } = req.query
    const data = await buscarResumoPorLote(fazenda)
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

app.get('/api/animais', async (req, res) => {
  try {
    const { lote_id, fazenda = 'Grupo Ricci', status = 'ativo' } = req.query
    let query = supabase.from('animais').select('*, lotes(nome)').eq('fazenda', fazenda).eq('status', status).order('brinco')
    if (lote_id) query = query.eq('lote_id', lote_id)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    res.json({ ok: true, data })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`))
