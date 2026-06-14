# CLAUDE.md — Rebanho Bot · Grupo Ricci

> Leia este arquivo no início de cada sessão. Ele contém tudo que você precisa saber sobre o projeto sem perguntar nada ao usuário.

---

## Visão geral

Bot WhatsApp para registro de mapas de rebanho bovino do Grupo Ricci. Peões de campo enviam áudios descrevendo fechamentos mensais, movimentações e consultas. O bot transcreve, extrai dados estruturados com GPT, confirma com o usuário e salva no banco. Com o tempo, aprende com as confirmações e melhora automaticamente.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| WhatsApp | Twilio Sandbox — `+1 415 523 8886` · código `join bent-darkness` |
| Transcrição | OpenAI Whisper-1 |
| Extração / agentes | OpenAI GPT-4o-mini |
| Banco | Supabase — `gboefoghltmientdqfkn.supabase.co` |
| Backend | Node.js Express · Fly.io São Paulo · `rebanho-bot-ricci.fly.dev` |
| Código | GitHub `rafaelcoda/rebanho-bot` · branch `main` · subpasta `rebanho-bot/src/` |

---

## Variáveis de ambiente (Fly.io secrets)

```
TWILIO_ACCOUNT_SID=AC4a1d655c2dc4a00ccc29db4deb6dec12
TWILIO_AUTH_TOKEN=dd6c85e2a7845159872fe1a8edaabeb7
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
OPENAI_API_KEY=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
SUPABASE_URL=https://gboefoghltmientdqfkn.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlib2Vmb2dobHRtaWVudGRxZmtuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTA0MTk5MSwiZXhwIjoyMDk2NjE3OTkxfQ.XSlVQCPvUBiiDcbugrDGVf_gK7d98f0gYJVtHjZ97e4
FLY_API_TOKEN=fm2_lJPECAAAAAAAFT+hxBAnxSDo4sBSgYAUqZtIRqbHwrVodHRwczovL2FwaS5mbHkuaW8vdjGUAJLOABo+AR8Lk7lodHRwczovL2FwaS5mbHkuaW8vYWFhL3YxxDx8GnhoUDTdqKtHPZNC5XbBUYV0enazWsWQE34zZW0Ngd7VIYuP9usLe+dMuEV+HJTKdxsRpxRvzlgFd/zETuLwbD1tKbVpbMpT6t/DlZ3GtVKH8ZfTdlolLgQm/pIsD/p3/6/ReW3q//BtwxrzyD818oSPQRHX2rCciwWWl+c6UkQMOqXmzJ+CEHTNNMQgQZ0nnn7LnY8K6bHYOoqjvZyY4DwD0THr8nQV7xc8Qh0=
```

---

## Arquivos principais (`rebanho-bot/src/`)

| Arquivo | Tamanho | Responsabilidade |
|---------|---------|-----------------|
| `server.js` | ~48k | Webhook Twilio, sessões, roteamento, aprendizado ativo, cron |
| `extracao.js` | ~20k | agentRoteador, agentConsulta, extrairDadosRebanho, extrairMovimentacaoMultipla, RAG few-shot |
| `agente_logs.js` | ~10k | Busca logs Fly.io, parseia, detecta padrões, autoAjustarLimiar() |
| `rag.js` | ~4k | gerarEmbedding, buscarExemplosSimilares, buscarClassificacaoSimilar, indexarExemplosPendentes |
| `anomalias.js` | ~7k | detectarAnomalias, analisarRebanho, regras + LLM |
| `supabase.js` | ~8k | cliente Supabase com ws para Node 20, helpers |
| `transcricao.js` | ~2k | Whisper-1, retry em 429 |
| `dashboard.html` | ~44k | KPIs, movimentações, fine-tuning, painel 🧠 Inteligência do Agente |

---

## Deploy

```bash
cd ~/rebanho-bot-flyio
curl -s https://raw.githubusercontent.com/rafaelcoda/rebanho-bot/main/rebanho-bot/src/[arquivo] -o src/[arquivo]
fly deploy --app rebanho-bot-ricci
```

### Webhook Twilio
`https://rebanho-bot-ricci.fly.dev/webhook/whatsapp`

---

## APIs disponíveis

```
GET  /health
GET  /api/resumo?meses=N
GET  /api/categorias
GET  /api/lotes
GET  /api/movimentacoes?limite=N
GET  /api/anomalias
GET  /api/logs?limite=N
GET  /api/qualidade
GET  /api/insights
GET  /api/insights/executar       ← força ciclo do agente_logs
GET  /api/exportar-finetuning
GET  /api/exportar-finetuning/stats
GET  /                             ← dashboard
```

---

## Banco de dados (Supabase)

### Tabelas de negócio
| Tabela | Descrição |
|--------|-----------|
| `rebanho_mensal` | Fechamentos mensais por fazenda/lote. Campos: `id, mes, ano, fazenda, lote_id, dia, existencia_anterior, safra, transcricao, whatsapp_de` |
| `rebanho_categoria` | Categorias do mapa (FK → rebanho_mensal) |
| `lotes` | 279 lotes — Iturama, Aliança, FRG, RIV. Campo `area_hectares` adicionado |
| `movimentacoes_lote` | Compras, vendas, mortes, transferências. Campos próprios: `categoria, categoria_item, sexo, responsavel, ocorrencia, motivo, lote_origem, lote_destino` |
| `animais` | Cadastro individual por brinco |
| `pesagens` | Pesagens dedicadas (separado de movimentacoes_lote) |
| `usuarios` | Contexto por número WhatsApp. `contexto_json, memoria_comprimida` |

### Tabelas do bot
| Tabela | Descrição |
|--------|-----------|
| `bot_logs` | Todas as mensagens. Campos: `tipo, transcricao, intencao_detectada, confianca, status, erro, modelo_usado, latencia_ms` |
| `bot_exemplos_extracao` | Exemplos confirmados com embedding (vector 1536). Base do RAG de extração |
| `bot_exemplos` | Classificações confirmadas com embedding. Base do RAG do roteador |
| `bot_feedback` | Correções do usuário (intencao_bot vs intencao_correta) |
| `bot_anomalias` | 39 anomalias detectadas |
| `bot_logs_fly` | Logs brutos do Fly.io parseados pelo agente |
| `bot_insights` | Padrões detectados com prioridade (alta/media/baixa) |
| `bot_alertas` | Alertas automáticos gerados pelo agente |
| `configuracoes` | Parâmetros dinâmicos sem redeploy |

### Tabela `configuracoes` (valores atuais)
| chave | valor |
|-------|-------|
| `limiar_confianca` | `0.7` (auto-ajustado pelo agente) |
| `intervalo_agente_logs` | `10` (minutos) |
| `fazenda_padrao` | `Grupo Ricci` |
| `whisper_retry_max` | `3` |
| `fine_tuning_minimo` | `50` |

### Views
- `vw_resumo_mensal` — totais calculados por mês/lote
- `vw_qualidade_bot` — KPIs por dia (% sucesso, erros, salvos)
- `vw_inconsistencias` — mapas onde existencia_anterior + entradas - saídas ≠ existencia_atual
- `vw_movimentacoes` — movimentações com nomes de lote via JOIN
- `vw_custo_diario` — custo e latência por modelo

### pgvector
Funções SQL: `buscar_exemplos_similares`, `buscar_classificacao_similar`
Modelo de embedding: OpenAI `text-embedding-3-small` (1536 dims)

---

## Arquitetura dos agentes

### agentRoteador
- Classifica intenção: `mapa | movimentacao | consulta | cadastro`
- Usa RAG (4 exemplos similares) + memória do usuário
- Retorna `{ intencao, confianca, motivo }`
- Limiar de confiança lido de `process.env.CFG_LIMIAR_CONFIANCA` (da tabela `configuracoes`)

### Aprendizado ativo
- Se confiança < limiar → pré-extrai dados → pergunta confirmação ao usuário
- "sim" → usa dados pré-extraídos (sem reprocessar) → salva + gera embedding
- "não/corrige" → registra feedback + reprocessa com intenção correta

### agentConsulta
- Responde perguntas em linguagem natural sobre o rebanho
- Recebe contexto dos últimos 6 meses + memória comprimida do usuário

### agente_logs (ciclo a cada 10 min)
1. Busca logs do Fly.io via `api.machines.dev`
2. Parseia e classifica: `fluxo | erro | parse_error | rate_limit | sucesso`
3. Detecta padrões e salva em `bot_insights`
4. **autoAjustarLimiar()**: analisa taxa de erro vs % de baixa confiança
   - Se perguntando demais (>40%) e erro baixo (<10%) → reduz limiar em 0.05
   - Se erro alto (>25%) → aumenta limiar em 0.05
   - Salva novo valor em `configuracoes`
5. Se parse_errors ≥ 3 → cria alerta em `bot_alertas`
6. Se baixa confiança ≥ 5 → dispara indexação RAG

### Memória do usuário
- Últimos 10 registros em `contexto_json`
- Após 5+ registros: GPT comprime em 150 palavras → `memoria_comprimida`
- Usada no prompt do roteador e do agentConsulta

---

## Fluxo de uma mensagem de áudio

```
Áudio WhatsApp
    ↓
Twilio webhook → server.js
    ↓
Registrar em bot_logs (status: recebido)
    ↓
Whisper-1 → transcrição
    ↓
agentRoteador (GPT + RAG + memória)
    ↓
confiança ≥ limiar?
  ├── SIM → agente especialista (extrair dados)
  │         ↓
  │         Resumo → WhatsApp: "sim/não?"
  │         ↓
  │         "sim" → salvar no banco + gerar embedding
  │
  └── NÃO → pré-extrair dados → perguntar confirmação
            ↓
            "sim" → usar dados pré-extraídos → salvar + embedding
            "não/corrige" → registrar feedback + reprocessar
```

---

## Pendências abertas

### Alta prioridade
- [ ] Painel de qualidade no dashboard (usar `vw_qualidade_bot` e `bot_insights`)
- [ ] Nível 3 do alerta — quando parse_errors ≥ 3, GPT gera novos exemplos few-shot
- [ ] Migrar agentRoteador e agentConsulta de GPT-4o-mini para Claude (Haiku ou Sonnet)

### Médio prazo
- [ ] Agente de previsão — prever mortalidade/variação próximo mês
- [ ] Validação cruzada — existencia_anterior + entradas - saídas = existencia_atual
- [ ] Número brasileiro real no Twilio (migrar do sandbox)
- [ ] Relatório PDF mensal automático

### Refinamentos
- [ ] Comando "status" no WhatsApp
- [ ] Cenários de teste T02-T20 ainda não testados

---

## Como trabalhar neste projeto

1. **Antes de qualquer mudança** — buscar o arquivo atual do GitHub via `urllib.request`
2. **Antes de qualquer SQL** — verificar estrutura real das tabelas via `information_schema` ou endpoint do bot
3. **Ao commitar** — usar o browser (GitHub editor) via `Claude in Chrome`
4. **Após commitar** — sempre orientar o redeploy com o curl + fly deploy
5. **Para diagnosticar** — chamar `/api/insights/executar` e `/api/logs?limite=20`
6. **Nunca hardcodar** limiar de confiança — ler de `process.env.CFG_LIMIAR_CONFIANCA`

---

## Decisões técnicas pendentes

- **GPT-4o-mini vs Claude** para agentRoteador e agentConsulta:
  - Prós Claude: melhor português, domínio pecuária, JSON mais preciso
  - Cons: maior custo, API diferente
  - Whisper-1 fica no OpenAI independente da decisão
