const axios = require('axios')

const SYSTEM_PROMPT = `Você é um especialista em pecuária bovina brasileira, responsável por processar dados do mapa de rebanho do Grupo Ricci.

Receberá um texto transcrito de um áudio — pode conter ERROS DE TRANSCRIÇÃO (letras trocadas, palavras deformadas). Use contexto e similaridade fonética para interpretar corretamente.

Extraia os dados e retorne APENAS JSON válido (sem markdown, sem explicações).

## MAPEAMENTO DE CATEGORIAS — seja tolerante a erros de transcrição
MACHOS (sexo: "M"):
- 1.1 Bezerros 0-8m    | bezerro, bezerrin, bezero, terneiro, macho novo, bezerro macho, bezerro de leite
- 1.2 Bezerros 8-12m   | bezerro desmamado, macho desmamado, garrote jovem
- 1.3 Garrotes 13-24m  | garrote, novilho, boi jovem, garrote médio, garrote de recria, garote
- 1.4 Garrotes PO      | garrote PO, garrote puro origem, garrote de raça
- 1.5 Bois 25-36m      | boi, boj, boy, boi gordo, boi de engorda, boj dengorda, boi dengorda, boj de engorda, engorda, macho adulto, novilho adulto, boi recria
- 1.6 Bois +36m        | boi velho, boi adulto, boi de corte, boi pesado, boi grande
- 1.7 Touros PO        | touro, reprodutor, touro de raça, touro PO, pai, toro, tourro

FÊMEAS (sexo: "F"):
- 2.1 Bezerras 0-2m    | bezerra, bezerrinha, fêmea nova, bezerra de leite, terneira
- 2.2 Bezerras 3-8m    | bezerra média, bezerra crescida, fêmea jovem, bezerra grande
- 2.3 Bezerras 9-12m   | bezerra desmamada, fêmea desmamada, bezerra de recria
- 2.4 Novilhas 13-24m  | novilha, novilha jovem, fêmea de recria, novilha de cria, novilha recria
- 2.5 Novilhas PO      | novilha PO, novilha puro origem, novilha de raça
- 2.6 Vacas solteiras  | vaca solteira, vaca falhada, vaca vazia, vaca sem bezerro, vaca seca, vaca solteira
- 2.7 Vacas paridas    | vaca parida, vaca com bezerro, vaca de cria, vaca amamentando, vaca lactante
- 2.8 Vacas PO         | vaca PO, vaca puro origem, vaca de raça, matriz PO

## REGRAS CRÍTICAS
1. "boj", "boy", "boj dengorda", "boi dengorda", "boj de engorda" = categoria 1.5 (bois de engorda) — NÃO é nome de lote
2. Se o texto parece uma categoria de animal (boi, vaca, bezerro, garrote, novilha, touro e variações) → é categoria, NÃO lote
3. Lote/pasto = palavras como "pasto", "curral", "retiro", "lote A", "fazenda X", nome geográfico
4. Mês por nome (janeiro=1...) ou número. Ano com 4 dígitos.
5. Números por extenso: "duzentos e cinquenta" = 250, "trezentos e oitenta e dois" = 382
6. "existência" ou "cabeças" ou "total" = existencia_atual
7. "anterior" ou "mês passado" = existencia_anterior
8. Valores negativos → use 0
9. Se existencia_atual ausente → calcule: anterior + entradas - saídas
10. "vaca" sem qualificação → 2.6. "vaca com bezerro" / "vaca parida" → 2.7
11. Se o texto mencionar APENAS categoria e número sem mês → mes: null, ano: null

## FORMATO DE SAÍDA
{
  "mes": null,
  "ano": null,
  "fazenda": "Grupo Ricci",
  "lote_nome": null,
  "lote_pasto": null,
  "lote_finalidade": null,
  "lote_raca": null,
  "categorias": [
    {
      "item": "1.5",
      "discriminacao": "Bois 25 a 36 meses",
      "sexo": "M",
      "existencia_anterior": 0,
      "existencia_atual": 0,
      "entrada_compra": 0,
      "entrada_mudanca_cat": 0,
      "entrada_desmama": 0,
      "entrada_nascimento": 0,
      "entrada_transferencia": 0,
      "saida_abate": 0,
      "saida_venda": 0,
      "saida_morte": 0,
      "saida_desmama": 0,
      "saida_mudanca_cat": 0,
      "saida_transferencia": 0
    }
  ],
  "animais": [],
  "observacoes": null
}`

async function chamarGroq(mensagens, maxTokens) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: mensagens,
      temperature: 0.05,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens || 4000,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  )
  return JSON.parse(response.data.choices[0].message.content)
}

async function extrairDadosRebanho(texto) {
  const dados = await chamarGroq([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Texto transcrito do áudio (pode ter erros de transcrição):\n\n"${texto}"` },
  ], 4000)

  dados.categorias = (dados.categorias || []).map((cat) => {
    const et = (cat.entrada_compra||0)+(cat.entrada_mudanca_cat||0)+
               (cat.entrada_desmama||0)+(cat.entrada_nascimento||0)+(cat.entrada_transferencia||0)
    const st = (cat.saida_abate||0)+(cat.saida_venda||0)+(cat.saida_morte||0)+
               (cat.saida_desmama||0)+(cat.saida_mudanca_cat||0)+(cat.saida_transferencia||0)
    const ea = Math.max(0, cat.existencia_atual != null ? cat.existencia_atual :
               (cat.existencia_anterior||0)+et-st)
    return { ...cat, existencia_anterior: cat.existencia_anterior||0,
             existencia_atual: ea, entrada_total: et, saida_total: st,
             indice_mortalidade: ea > 0 ? (cat.saida_morte||0)/ea : 0 }
  })

  dados.animais = dados.animais || []
  console.log('Extraído: mes=' + dados.mes + ' ano=' + dados.ano + ' cats=' + dados.categorias.length + ' lote=' + dados.lote_nome)
  return dados
}

async function extrairComplemento(resposta, dadosAtuais, etapa) {
  const catAtual = (dadosAtuais.categorias || [])
    .filter(c => c.existencia_atual > 0)
    .map(c => `${c.item} ${c.discriminacao}: ${c.existencia_atual} cab.`)
    .join(', ') || 'nenhuma'

  const contextos = {
    periodo: 'O fazendeiro informa o período (mês e ano) do mapa. Extraia mes (1-12) e ano (4 dígitos). Retorne: { "mes": N, "ano": NNNN, "categorias": [] }',
    existencia: `O fazendeiro informa quantas cabeças tem por categoria. Categorias já registradas: ${catAtual}. Extraia categorias com existencia_atual.`,
    movimentacoes: `O fazendeiro informa movimentações do mês (nascimentos, mortes, compras, vendas). Categorias: ${catAtual}. Extraia os números para as categorias corretas.`,
    lote: 'O fazendeiro informa o nome do lote ou pasto. Retorne: { "lote_nome": "...", "lote_pasto": "...", "categorias": [] }',
  }

  const prompt = `${contextos[etapa] || 'Extraia dados de rebanho.'}

Texto (pode ter erros de transcrição): "${resposta}"

Retorne APENAS JSON válido. Se não encontrar nada relevante, retorne { "categorias": [] }.`

  try {
    const resultado = await chamarGroq([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], 2000)
    console.log('Complemento etapa=' + etapa + ':', JSON.stringify(resultado).substring(0, 100))
    return resultado
  } catch (e) {
    console.error('Erro extrairComplemento:', e.message)
    return { categorias: [] }
  }
}

function gerarResumoWhatsApp(dados) {
  const meses = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
  const totalAtual    = dados.categorias.reduce((s,c) => s+(c.existencia_atual||0), 0)
  const totalAnterior = dados.categorias.reduce((s,c) => s+(c.existencia_anterior||0), 0)
  const totalNasc     = dados.categorias.reduce((s,c) => s+(c.entrada_nascimento||0), 0)
  const totalMortes   = dados.categorias.reduce((s,c) => s+(c.saida_morte||0), 0)
  const totalVendas   = dados.categorias.reduce((s,c) => s+(c.saida_venda||0), 0)
  const totalCompras  = dados.categorias.reduce((s,c) => s+(c.entrada_compra||0), 0)
  const machos  = dados.categorias.filter(c=>c.sexo==='M').reduce((s,c)=>s+(c.existencia_atual||0),0)
  const femeas  = dados.categorias.filter(c=>c.sexo==='F').reduce((s,c)=>s+(c.existencia_atual||0),0)
  const mortPct = totalAtual>0 ? ((totalMortes/totalAtual)*100).toFixed(3) : '0.000'
  const periodo = dados.mes && dados.ano ? `${meses[dados.mes]}/${dados.ano}` : 'período informado'
  const loteInfo = dados.lote_nome ? `\n*Lote:* ${dados.lote_nome}${dados.lote_pasto?' — '+dados.lote_pasto:''}` : ''
  const linhasCat = dados.categorias.filter(c=>c.existencia_atual>0)
    .map(c=>`  ${c.item} ${c.discriminacao}: *${c.existencia_atual}*`).join('\n')
  const animaisInfo = dados.animais?.length > 0 ? `\n*Animais individuais:* ${dados.animais.length}` : ''
  const obs = dados.observacoes ? `\n\n⚠️ _${dados.observacoes}_` : ''

  return `*Mapa de Rebanho — ${dados.fazenda||'Grupo Ricci'}*
*${periodo}*${loteInfo}

*Total: ${totalAtual.toLocaleString('pt-BR')} cabeças*
  Machos: ${machos.toLocaleString('pt-BR')} | Fêmeas: ${femeas.toLocaleString('pt-BR')}

*Por categoria:*
${linhasCat||'  (nenhuma)'}

*Movimentação:*
  Exist. anterior: ${totalAnterior.toLocaleString('pt-BR')}
  Nascimentos: ${totalNasc} | Compras: ${totalCompras}
  Vendas: ${totalVendas} | Mortes: ${totalMortes}

*Mortalidade:* ${mortPct}%${animaisInfo}${obs}

_Dados salvos no sistema._ ✅`
}

module.exports = { extrairDadosRebanho, extrairComplemento, gerarResumoWhatsApp }
