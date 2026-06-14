const axios = require('axios')
const fs = require('fs')
const path = require('path')
const os = require('os')
const FormData = require('form-data')

async function transcreverAudio(mediaUrl, accountSid, authToken, tentativa = 1) {
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`)

  // 1. Baixar audio do Twilio
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: accountSid, password: authToken },
    timeout: 30000,
  })

  fs.writeFileSync(tmpPath, response.data)
  console.log(`Audio salvo: ${tmpPath} (${response.data.byteLength} bytes)`)

  // 2. Transcrever com OpenAI Whisper (com retry em 429)
  const form = new FormData()
  form.append('file', fs.createReadStream(tmpPath), {
    filename: 'audio.ogg',
    contentType: 'audio/ogg',
  })
  form.append('model', 'whisper-1')
  form.append('language', 'pt')
  form.append('response_format', 'text')

  try {
    const whisperResponse = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60000,
      }
    )
    try { fs.unlinkSync(tmpPath) } catch (_) {}
    console.log('Transcricao:', String(whisperResponse.data).substring(0, 100))
    return whisperResponse.data
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch (_) {}
    if (err.response?.status === 429 && tentativa < 4) {
      const espera = tentativa * 5000
      console.log(`Whisper 429 - tentativa ${tentativa}/3, aguardando ${espera/1000}s...`)
      await new Promise(r => setTimeout(r, espera))
      return transcreverAudio(mediaUrl, accountSid, authToken, tentativa + 1)
    }
    const status = err.response?.status
    const detail = err.response?.data ? JSON.stringify(err.response.data).substring(0,100) : err.message
    console.log(`[ERRO] Whisper: status=${status} | ${detail}`)
    throw new Error(`Whisper ${status||'timeout'}: ${detail}`)
  }
}

module.exports = { transcreverAudio }
