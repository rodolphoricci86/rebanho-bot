const OpenAI = require('openai')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { toFile } = require('openai')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function transcreverAudio(mediaUrl, accountSid, authToken) {
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`)

  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: accountSid, password: authToken },
    timeout: 30000,
  })

  fs.writeFileSync(tmpPath, response.data)
  console.log(`Audio salvo: ${tmpPath} (${response.data.byteLength} bytes)`)

  const audioBuffer = fs.readFileSync(tmpPath)
  const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' })

  const transcricao = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'pt',
    response_format: 'text',
  })

  try { fs.unlinkSync(tmpPath) } catch (_) {}
  return transcricao
}

module.exports = { transcreverAudio }
