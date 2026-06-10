const axios = require('axios')

const SYSTEM_PROMPT = `Você é um assistente especializado em pecuária bovina.
Receberá um texto transcrito de um áudio enviado por um fazendeiro com dados do rebanho mensal.
Extraia os dados e retorne APENAS um JSON válido (sem markdown, sem explicações) no formato abaixo.
Se um campo não for mencionado, use 0. Se mês/ano não forem mencionados, use null.

{
  "mes": <número 1-12 ou null>,
  "ano": <ano com 4 dígitos ou null>,
  "fazenda": "<nome da fazenda ou 'Grupo Ricci'>",
  "categorias": [
    {
      "item": "<código ex: 1.1>",
      "discriminacao": "<descrição da categoria>",
      "sexo": "<M ou F>",
      "existencia_anterior": <número>,
      "existencia_atual": <número>,
      "entrada_compra": <número>,
      "entrada_mudanca_cat": <número>,
      "entrada_desmama": <número>,
      "entrada_nascimento": <número>,
      "entrada_transferencia": <número>,
      "saida_abate": <número>,
      "saida_venda": <número>,
      "saida_morte": <número>,
      "saida_desmama": <número>,
      "saida_mudanca_cat": <número>,
      "saida_transferencia": <número>
    }
  ],
  "observacoes": "<observações livres mencionadas ou null>"
}

Categorias padrão do mapa de rebanho:
1.1 Bezerros 0-8 meses (M), 1.2 Bezerros 8-12 meses (M), 1.3 Garrotes 13-24 meses (M),
1.5 Bois 25-36 meses (M), 1.7 Touros PO acima 25 meses (M),
2.1 Bezerras 0-2 meses (F), 2.2 Bezerras 3-8 meses (F), 2.3 Bezerras 9-12 meses (F),
2.4 Novilhas 13-24 meses (F), 2.6 Vacas solteiras acima 25 meses (F),
2.7 Vacas paridas acima 25 meses (F)`

async function extrairDadosRebanho(texto) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Texto transcrito:\n\n${texto}` },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  )

  const dados = JSON.parse(response.data.choices[0].message.content)

  dados.categorias = (dados.categorias || []).map((cat) => {
    const entrada_total =
      (cat.entrada_compra || 0) + (cat.entrada_mudanca_cat || 0) +
      (cat.entrada_desmama || 0) + (cat.entrada_nascimento || 0) +
      (cat.entrada_transferencia || 0)

    const saida_total =
      (cat.saida_abate || 0) + (cat.saida_venda || 0) +
      (cat.saida_morte || 0) + (cat.saida_desmama || 0) +
      (cat.saida_mudanca_cat || 0) + (cat.saida_transferencia || 0)

    const existencia_atual = cat.existencia_atual ||
      (cat.existencia_anterior || 0) + entrada_total - saida_total

    const indice_mortalidade =
      existencia_atual > 0 ? (cat.saida_morte || 0) / existencia_atual : 0

    return { ...cat, entrada_total, saida_total, existencia_atual, indice_mortalidade }
  })

  return dados
}

function gerarResumoWhatsApp(dados) {
  const meses = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

  const totalAtual = dados.categorias.reduce((s, c) => s + (c.existencia_atual || 0), 0)
  const totalAnterior = dados.categorias.reduce((s, c) => s + (c.existencia_anterior || 0), 0)
  const totalNasc = dados.categorias.reduce((s, c) => s + (c.entrada_nascimento || 0), 0)
  const totalMortes = dados.categorias.reduce((s, c) => s + (c.saida_morte || 0), 0)
  const totalVendas = dados.categorias.reduce((s, c) => s + (c.saida_venda || 0), 0)
  const totalCompras = dados.categorias.reduce((s, c) => s + (c.entrada_compra || 0), 0)
  const machos = dados.categorias.filter(c => c.sexo === 'M').reduce((s, c) => s + (c.existencia_atual || 0), 0)
  const femeas = dados.categorias.filter(c => c.sexo === 'F').reduce((s, c) => s + (c.existencia_atual || 0), 0)
  const mortalidadePct = totalAtual > 0 ? ((totalMortes / totalAtual) * 100).toFixed(3) : '0.000'
  const periodo = dados.mes && dados.ano ? `${meses[dados.mes]}/${dados.ano}` : 'periodo informado'

  return `*Mapa de Rebanho - ${dados.fazenda || 'Grupo Ricci'}*
*${periodo}*

*Rebanho atual:* ${totalAtual.toLocaleString('pt-BR')} cabecas
  - Machos: ${machos.toLocaleString('pt-BR')}
  - Femeas: ${femeas.toLocaleString('pt-BR')}

*Movimentacao:*
  - Existencia anterior: ${totalAnterior.toLocaleString('pt-BR')}
  - Nascimentos: ${totalNasc}
  - Compras: ${totalCompras}
  - Vendas: ${totalVendas}
  - Mortes: ${totalMortes}

*Mortalidade:* ${mortalidadePct}%

_Dados registrados com sucesso no sistema._`
}

module.exports = { extrairDadosRebanho, gerarResumoWhatsApp }
