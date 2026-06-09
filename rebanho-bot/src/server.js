require('dotenv').config()

const express = require('express')
const twilio = require('twilio')
const path = require('path')
const { transcreverAudio } = require('./transcricao')
const { extrairDadosRebanho, gerarResumoWhatsApp } = require('./extracao')
const { salvarRebanho, buscarResumoMensal } = require('./supabase')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(express.static(path.join(__dirname)))

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

function validarTwilio(req, res, next) {
  const assinatura = req.headers['x-twilio-signature']
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const valido = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    assinatura,
    url,
    req.body
  )
  if (!valido) return res.status(403).send('Forbidden')
  next()
}

function responderWhatsApp(res, mensagem) {
  const twiml = new twilio.twiml.MessagingResponse()
  twiml.message(mensagem)
  res.type('text/xml').send(twiml.toString())
}

app.post('/webhook/whatsapp', validarTwilio, async (req, res) => {
  const { From: de, Body: corpo, NumMedia: numMedia,
    MediaUrl0: mediaUrl, MediaContentType0: mediaType } = req.body

  console.log(`Mensagem de ${de} | Mídia: ${numMedia} | Tipo: ${mediaType}`)

  try {
    if (parseInt(numMedia) > 0 && mediaType?.startsWith('audio')) {
      responderWhatsApp(res, '_Recebi seu áudio! Transcrevendo e processando os dados..._')
      processarAudio(de, mediaUrl).catch((err) => {
        console.error('Erro:', err)
        enviarMensagem(de, `Erro ao processar: ${err.message}. Tente novamente.`)
      })
      return
    }

    if (corpo && corpo.trim().length > 20) {
      responderWhatsApp(res, '_Recebi seus dados! Processando..._')
      processarTexto(de, corpo).catch((err) => {
        enviarMensagem(de, `Erro ao processar: ${err.message}. Tente novamente.`)
      })
      return
    }

    const cmd = (corpo || '').trim().toLowerCase()
    if (cmd === 'resumo' || cmd === 'relatorio') {
      const resumo = await buscarResumoMensal(3)
      return responderWhatsApp(res, formatarResumoRapido(resumo))
    }

    responderWhatsApp(res,
      `*Olá! Sou o assistente de rebanho do Grupo Ricci.*\n\nEnvie um *áudio* com os dados do mapa de rebanho do mês.\n\nComandos:\n- *resumo* — últimos 3 meses`)
  } catch (err) {
    console.error('Erro webhook:', err)
    responderWhatsApp(res, 'Ocorreu um erro inesperado. Tente novamente.')
  }
})

async function processarAudio(de, mediaUrl) {
  const texto = await transcreverAudio(mediaUrl,
    process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  await processarTexto(de, texto)
}

async function processarTexto(de, texto) {
  const dados = await extrairDadosRebanho(texto)
  const salvo = await salvarRebanho(dados, texto, de)
  console.log(`Salvo: ${salvo.mes}/${salvo.ano}, ${salvo.totalCategorias} categorias`)
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
  if (!meses || meses.length === 0) return 'Nenhum dado encontrado ainda.'
  const nomes = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
  const linhas = meses.map(m =>
    `*${nomes[m.mes]}/${m.ano}:* ${Number(m.total_rebanho).toLocaleString('pt-BR')} cab. | Nasc: ${m.total_nascimentos} | Mort: ${m.mortalidade_pct}%`)
  return `*Resumo dos últimos meses:*\n\n${linhas.join('\n')}`
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')))
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))
app.get('/api/resumo', async (req, res) => {
  try {
    const data = await buscarResumoMensal(parseInt(req.query.meses || '12'))
    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`))
