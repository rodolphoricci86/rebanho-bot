const axios = require('axios')
const fs = require('fs')
const path = require('path')
const os = require('os')
const FormData = require('form-data')

async function transcreverAudio(mediaUrl, accountSid, authToken) {
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`)

  // 1. Baixar audio do Twilio
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: accountSid, password: authToken },
    timeout: 30000,
  })

  fs.writeFileSync(tmpPath, response.data)
  console.log(`Audio salvo: ${tmpPath} (${response.data.byteLength} bytes)`)

  // 2. Transcrever com OpenAI Whisper
  const form = new FormData()
  form.append('file', fs.createReadStream(tmpPath), {
    filename: 'audio.ogg',
    contentType: 'audio/ogg',
  })
  form.append('model', 'whisper-1')
  form.append('language', 'pt')
  form.append('response_format', 'text')

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
}

module.exports = { transcreverAudio }
