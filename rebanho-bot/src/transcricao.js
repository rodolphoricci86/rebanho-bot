const OpenAI = require('openai')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const os = require('os')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function transcreverAudio(mediaUrl, accountSid, authToken) {
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`)

  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: accountSid, password: authToken },
  })

  fs.writeFileSync(tmpPath, response.data)

  const transcricao = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tmpPath),
    model: 'whisper-1',
    language: 'pt',
    response_format: 'text',
  })

  fs.unlinkSync(tmpPath)
  return transcricao
}

module.exports = { transcreverAudio }
