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

## Decisões arquiteturais registradas em sessão

### [2026-06-15] Fluxo guiado de registro com menu de movimentação

**Percepção captada (usuários na ponta)**
Peões têm dificuldade em fazer o agente entender as categorias de movimentação. O fluxo livre por áudio gera confusão e erros de extração porque o operador não sabe o que informar nem em qual ordem.

**Diagnóstico técnico**
O fluxo atual começa com áudio livre → agentRoteador tenta inferir intenção → agentExtração tenta capturar tudo de uma vez. Quando o áudio é ambíguo ou incompleto, o agente erra a categoria ou pede complemento de forma pouco clara. O operador não tem cadência — não sabe o que o bot espera em cada momento.

**Roteiro validado pelo arquiteto**
```
1. Usuário: qualquer saudação
2. Bot: menu fixo → "O que deseja registrar?"
        [1] Nascimentos  [2] Mortes  [3] Compras  [4] Vendas  [5] Fechamento mensal
3. Usuário: digita o número ou toca no botão
4. Bot: "Qual Fazenda/Retiro e data da movimentação?"
5. Usuário: áudio com local e data
6. Bot: "Agora informe as quantidades por categoria"
7. Usuário: áudio com categorias e quantidades
8. Bot: confirmação detalhada por categoria (destaca categorias com valor = 0)
9. Usuário: confirma ou corrige
10. Bot: "Registrado com sucesso ✅"
```

**Camadas afetadas**
| Arquivo | O que muda |
|---|---|
| `server.js` | Adicionar etapa `menu_inicial` antes de qualquer processamento. Detectar saudação → responder com menu numerado. Adicionar etapas `local_data` e `categorias` ao fluxo de sessão. |
| `server.js` | Função `gerarPergunta()` recebe duas novas etapas: `local_data` e `categorias`. |
| `server.js` | Função `setSessao()` passa a armazenar `tipo_movimentacao` escolhido no menu. |
| `extracao.js` | `extrairMovimentacaoMultipla()` recebe o `tipo_movimentacao` como contexto fixo — não precisa mais inferir do áudio, só extrair quantidades. |
| `server.js` | Confirmação final deve listar TODAS as categorias da movimentação escolhida, marcando com `⚠️` as que ficaram com valor 0. |

**O que os programadores devem implementar**

1. **Detecção de saudação** (`server.js`, webhook POST, bloco sem sessão ativa)
   - Se a mensagem não tiver mídia e o texto for uma saudação (`oi`, `olá`, `bom dia`, `boa tarde`, `boa noite`, `boa`, `oi tudo`, `e ai`, ou qualquer texto curto ≤ 15 chars sem número), responder com o menu e criar sessão na etapa `menu_inicial`.

2. **Menu numerado** — resposta em texto WhatsApp formatado:
   ```
   Olá! 👋 O que deseja registrar hoje?
   
   1️⃣ Nascimentos
   2️⃣ Mortes
   3️⃣ Compras
   4️⃣ Vendas
   5️⃣ Fechamento mensal
   
   Responda com o número da opção.
   ```

3. **Etapa `menu_inicial`** (`server.js`)
   - Recebe número 1–5 → mapeia para `tipo_movimentacao` (`nascimento | morte | compra | venda | mapa`)
   - Avança sessão para etapa `local_data`
   - Responde: *"Qual Fazenda/Retiro e a data em que ocorreu?"*

4. **Etapa `local_data`** (`server.js`)
   - Aceita texto ou áudio
   - Extrai fazenda/lote e data via GPT (reutilizar prompt de extração existente, passando `tipo_movimentacao` no contexto)
   - Avança para etapa `categorias`
   - Responde: *"Agora me informe as quantidades por categoria. Pode enviar um áudio."*

5. **Etapa `categorias`** (`server.js` + `extracao.js`)
   - Aceita texto ou áudio
   - Chama `extrairMovimentacaoMultipla()` passando `tipo_movimentacao` como contexto fixo no system prompt — o agente não precisa mais adivinhar o tipo
   - Avança para etapa `confirmacao`

6. **Confirmação enriquecida** (`server.js`, função `gerarResumoConfirmacao`)
   - Listar todas as categorias relevantes para o `tipo_movimentacao`
   - Marcar com `⚠️ 0` as que não foram informadas
   - Manter o padrão atual de *sim/não*

**Impacto esperado**
- Elimina erros de roteamento do `agentRoteador` para movimentações (tipo já vem fixo do menu)
- Reduz tokens e latência: GPT não precisa inferir tipo, só extrair quantidades
- Operador tem cadência clara — sabe exatamente o que o bot espera em cada etapa

---

### [2026-06-15] Peso obrigatório para movimentações de curral

**Percepção captada (usuários na ponta)**
Movimentações que ocorrem no curral — compra, venda e troca de categoria — exigem obrigatoriamente o registro do peso do lote. Hoje o campo `peso` existe no banco mas não é cobrado do operador em nenhuma etapa do fluxo.

**Diagnóstico técnico**
O campo `peso` já existe na tabela `movimentacoes_lote` e no objeto extraído pelo GPT (`peso_total`, `peso_medio` em `extracao.js`). Porém:
- Não há validação de obrigatoriedade por tipo de movimentação
- O fluxo de sessão não tem etapa dedicada para captura de peso
- A confirmação final não alerta quando peso está ausente para esses tipos

**Tipos de movimentação que exigem peso obrigatório**
| Tipo interno | Label exibido |
|---|---|
| `entrada_compra` | Compra |
| `saida_venda` | Venda |
| `mudanca_categoria` | Troca de categoria |

> Nascimentos, mortes e transferências de pasto **não** exigem peso.

**Camadas afetadas**
| Arquivo | O que muda |
|---|---|
| `server.js` | Após etapa `categorias`, verificar se `tipo_movimentacao` exige peso. Se sim, adicionar etapa `peso_lote` antes de avançar para `confirmacao`. |
| `server.js` | Nova etapa `peso_lote`: bot pergunta peso total e/ou peso médio. Aceita áudio ou texto. |
| `extracao.js` | Criar função `extrairPeso(texto)` — extrai `peso_total` (kg), `peso_medio` (kg/cabeça) e `unidade` (kg ou arroba). Converter arrobas para kg automaticamente (1 arroba = 15 kg). |
| `server.js` | Na confirmação final, se `tipo_movimentacao` exige peso e `peso` estiver null → bloquear salvamento com `⚠️ Peso obrigatório para este tipo de movimentação.` |
| `server.js` | Função `gerarResumoConfirmacao()` deve exibir peso total e peso médio quando presentes. |

**O que os programadores devem implementar**

1. **Constante de tipos que exigem peso** (`server.js`)
   ```js
   const TIPOS_EXIGEM_PESO = ['entrada_compra', 'saida_venda', 'mudanca_categoria']
   ```

2. **Etapa `peso_lote`** (`server.js`)
   - Inserir no fluxo após `categorias`, antes de `confirmacao`
   - Só ativada se `TIPOS_EXIGEM_PESO.includes(tipo_movimentacao)`
   - Mensagem ao operador:
     ```
     ⚖️ Informe o peso do lote.
     Exemplo: "450 arrobas" ou "6.750 kg" ou "peso médio 15 arrobas por cabeça"
     ```
   - Aceita áudio ou texto
   - Chama `extrairPeso(texto)` → salva `peso_total_kg` e `peso_medio_kg` na sessão

3. **Função `extrairPeso(texto)`** (`extracao.js`)
   - Prompt GPT focado exclusivamente em extrair peso
   - Retorna: `{ peso_total_kg, peso_medio_kg, unidade_original }`
   - Conversão automática: arrobas × 15 = kg
   - Se não identificar → retorna `null` (bot repergunta)

4. **Bloqueio na confirmação** (`server.js`)
   - Se `TIPOS_EXIGEM_PESO.includes(tipo)` e `peso_total_kg` é null → não avançar para salvamento
   - Responder: `⚠️ Peso obrigatório para Compra/Venda/Troca de categoria. Informe o peso para continuar.`
   - Voltar para etapa `peso_lote`

5. **Exibição na confirmação** (`server.js`, `gerarResumoConfirmacao`)
   - Adicionar linha:
     ```
     ⚖️ Peso total: 6.750 kg | Peso médio: 15 kg/cabeça
     ```

**Impacto esperado**
- Garante integridade do dado de peso para movimentações financeiras (compra/venda)
- Operador não consegue finalizar sem informar o peso — dado crítico para precificação
- Conversão automática de arrobas elimina erro de unidade

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

## Contexto de trabalho colaborativo

### Papel do Rodolpho Ricci
Arquiteto de Soluções — capta percepções dos usuários na ponta (peões de campo), traduz as dificuldades para a equipe técnica e retorna à ponta para implementar as melhorias validadas.

### Padrão de comunicação entre arquiteto e programadores
Toda decisão, percepção ou melhoria registrada nas sessões com Claude segue obrigatoriamente este formato:

- **Percepção captada** — o que o usuário/peão sentiu ou relatou
- **Diagnóstico** — o problema traduzido em termos técnicos
- **Camadas afetadas** — quais arquivos e tabelas precisam ser tocados
- **O que os programadores devem fazer** — instrução clara e direta

### Registro de sessões
Todas as conclusões e decisões arquiteturais são commitadas neste arquivo (`CLAUDE.md`) ao final de cada sessão ou quando uma decisão relevante for tomada.

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
