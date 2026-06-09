# Rebanho Bot — Grupo Ricci

Bot WhatsApp para registro e análise do mapa de rebanho bovino via áudio.

## Arquitetura

```
Fazendeiro (áudio) → WhatsApp → Twilio → Webhook (Railway)
                                              ↓
                                    Whisper (transcrição)
                                              ↓
                                    GPT-4o (extração)
                                              ↓
                                    Supabase (persistência)
                                              ↓
                              Dashboard web + Resposta WhatsApp
```

## Pré-requisitos

- Conta [Twilio](https://twilio.com) com WhatsApp Business habilitado
- Conta [OpenAI](https://platform.openai.com) com acesso à API
- Conta [Supabase](https://supabase.com)
- Conta [Railway](https://railway.app)
- Node.js 18+

---

## Passo 1 — Supabase

1. Crie um projeto em https://supabase.com
2. Vá em **SQL Editor** e execute o arquivo `supabase_schema.sql`
3. Anote:
   - `SUPABASE_URL` → Settings → API → Project URL
   - `SUPABASE_SERVICE_KEY` → Settings → API → service_role key

---

## Passo 2 — Twilio

1. Crie conta em https://twilio.com
2. Vá em **Messaging → Try it out → Send a WhatsApp message**
3. Para **sandbox** (testes): siga as instruções de opt-in
4. Para **produção**:
   - Vá em **Messaging → Senders → WhatsApp Senders**
   - Clique em **Connect a WhatsApp Sender**
   - Siga o processo de aprovação Meta (~1-2 dias úteis)
5. Anote:
   - `TWILIO_ACCOUNT_SID` → Console Dashboard
   - `TWILIO_AUTH_TOKEN` → Console Dashboard
   - `TWILIO_WHATSAPP_NUMBER` → ex: `whatsapp:+14155238886`

---

## Passo 3 — Deploy no Railway

1. Instale o Railway CLI:
   ```bash
   npm install -g @railway/cli
   ```

2. Faça login:
   ```bash
   railway login
   ```

3. Na pasta do projeto:
   ```bash
   railway init
   railway up
   ```

4. Configure as variáveis de ambiente no painel Railway
   (ou via CLI):
   ```bash
   railway variables set TWILIO_ACCOUNT_SID=ACxxx
   railway variables set TWILIO_AUTH_TOKEN=xxx
   railway variables set TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
   railway variables set OPENAI_API_KEY=sk-xxx
   railway variables set SUPABASE_URL=https://xxx.supabase.co
   railway variables set SUPABASE_SERVICE_KEY=eyxxx
   ```

5. Pegue a URL do serviço:
   ```
   https://rebanho-bot.up.railway.app
   ```

---

## Passo 4 — Configurar Webhook no Twilio

1. No Twilio Console → **Messaging → Settings → WhatsApp sandbox settings**
   (ou na configuração do número em produção)
2. Em **"When a message comes in"**, cole:
   ```
   https://rebanho-bot.up.railway.app/webhook/whatsapp
   ```
3. Método: **HTTP POST**
4. Salve.

---

## Passo 5 — Testar

Envie uma mensagem de áudio para o número WhatsApp do Twilio com algo como:

> "Mapa de rebanho de março de 2026. Bezerros de zero a oito meses,
> existência anterior trezentos e setenta e cinco, nascimentos nove,
> existência atual trezentos e oitenta e dois. Vacas paridas existência
> atual setecentos e trinta e três..."

O bot vai:
1. Transcrever o áudio
2. Extrair os dados por categoria
3. Salvar no Supabase
4. Responder com o resumo no próprio WhatsApp

---

## Dashboard

Acesse em: `https://rebanho-bot.up.railway.app`

---

## Estrutura do Projeto

```
rebanho-bot/
├── src/
│   ├── server.js        ← Servidor Express + webhook
│   ├── transcricao.js   ← Download áudio + Whisper
│   ├── extracao.js      ← GPT-4o extração de dados
│   ├── supabase.js      ← Persistência
│   └── dashboard.html   ← Dashboard web
├── supabase_schema.sql  ← Criar tabelas
├── .env.example         ← Variáveis necessárias
└── package.json
```

---

## Endpoints

| Método | Rota                 | Descrição                     |
|--------|----------------------|-------------------------------|
| POST   | /webhook/whatsapp    | Recebe mensagens do Twilio    |
| GET    | /api/resumo          | JSON dos dados para dashboard |
| GET    | /                    | Dashboard web                 |
| GET    | /health              | Health check                  |

## Dúvidas comuns

**O bot não responde ao áudio:**
Verifique se `TWILIO_AUTH_TOKEN` está correto — a validação de assinatura
rejeita requisições com token errado.

**"Mês e ano não identificados":**
O fazendeiro precisa mencionar o período no áudio, ex: "março de 2026".

**Timeout na transcrição:**
Áudios muito longos (>5min) podem demorar. O Railway não tem limite de
timeout para servidores contínuos.
