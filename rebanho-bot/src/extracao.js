const axios = require('axios')

const SYSTEM_PROMPT = `Você é um especialista em pecuária bovina brasileira, responsável por processar dados do mapa de rebanho do Grupo Ricci.

Receberá um texto transcrito de um áudio. Extraia os dados e retorne APENAS JSON válido (sem markdown, sem explicações).

## MAPEAMENTO DE CATEGORIAS
Use estas categorias padrão e reconheça TODAS as variações de fala:

MACHOS (sexo: "M"):
- 1.1 | Bezerros 0 a 8 meses     | bezerro, bezerra macho, terneiro, garrote novo, macho novo, bezerro de leite
- 1.2 | Bezerros 8 a 12 meses    | bezerro desmamado, macho desmamado, garrote jovem
- 1.3 | Garrotes 13 a 24 meses   | garrote, novilho, garrote médio, boi jovem, macho jovem, garrote de recria
- 1.4 | Garrotes PO 13-24 meses  | garrote puro origem, garrote PO, garrote de raça
- 1.5 | Bois 25 a 36 meses       | boi, boi gordo, boi de engorda, macho adulto jovem, novilho adulto
- 1.6 | Bois acima de 36 meses   | boi velho, boi adulto, boi de corte, boi pesado
- 1.7 | Touros PO acima 25 meses | touro, reprodutor, touro de raça, touro PO, pai, sêmen

FÊMEAS (sexo: "F"):
- 2.1 | Bezerras 0 a 2 meses     | bezerra, bezerrinha, fêmea nova, bezerra de leite, terneira
- 2.2 | Bezerras 3 a 8 meses     | bezerra média, bezerra crescida, fêmea jovem
- 2.3 | Bezerras 9 a 12 meses    | bezerra desmamada, fêmea desmamada, bezerra de recria
- 2.4 | Novilhas 13 a 24 meses   | novilha, novilha jovem, fêmea de recria, novilha de cria
- 2.5 | Novilhas PO 13-24 meses  | novilha puro origem, novilha PO, novilha de raça
- 2.6 | Vacas solteiras +25 meses | vaca solteira, vaca falhada, vaca vazia, vaca sem bezerro, vaca seca
- 2.7 | Vacas paridas +25 meses  | vaca parida, vaca com bezerro, vaca de cria, vaca amamentando, vaca lactante
- 2.8 | Vacas PO +25 meses       | vaca puro origem, vaca PO, vaca de raça, matriz PO

## REGRAS DE EXTRAÇÃO
1. Identifique o MÊS por nome (janeiro=1, fevereiro=2, etc.) ou número
2. Identifique o ANO mencionado ou use o ano atual
3. Para cada animal mencionado, mapeie para a categoria mais próxima da tabela acima
4. Se o fazendeiro disser apenas "vaca" sem qualificação → use 2.6 (solteira)
5. Se disser "vaca com bezerro" ou "vaca parida" → use 2.7
6. Se disser "bezerro" sem sexo definido → crie entrada para 1.1 (macho) e 2.1 (fêmea) se ambos mencionados
7. Números por extenso: "trezentos e oitenta e dois" = 382
8. "Existência" ou "cabeças" ou "total" = existencia_atual
9. "Anterior" ou "mês passado" = existencia_anterior
10. Se existencia_atual não mencionada mas existencia_anterior e movimentações sim, calcule: anterior + entradas - saídas

## VALIDAÇÕES OBRIGATÓRIAS
- existencia_atual >= 0
- Todos os campos numéricos >= 0
- Se existencia_atual < existencia_anterior + entradas - saídas, ajuste saída_morte ou adicione observação
- sexo deve ser exatamente "M" ou "F"

## FORMATO DE SAÍDA
{
  "mes": <1-12 ou null>,
  "ano": <4 dígitos ou null>,
  "fazenda": "<nome ou 'Grupo Ricci'>",
  "categorias": [
    {
      "item": "1.1",
      "discriminacao": "Bezerros 0 a 8 meses",
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
  "observacoes": "<inconsistências encontradas ou null>"
}`

async function extrairDadosRebanho(texto) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Texto transcrito do áudio:\n\n"${texto}"` },
      ],
      temperature: 0.05,
      response_format: { type: 'json_object' },
      max_tokens: 4000,
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

  // Calcular totais e validar cada categoria
  dados.categorias = (dados.categorias || []).map((cat) => {
    const entrada_total =
      (cat.entrada_compra || 0) + (cat.entrada_mudanca_cat || 0) +
      (cat.entrada_desmama || 0) + (cat.entrada_nascimento || 0) +
      (cat.entrada_transferencia || 0)

    const saida_total =
      (cat.saida_abate || 0) + (cat.saida_venda || 0) +
      (cat.saida_morte || 0) + (cat.saida_desmama || 0) +
      (cat.saida_mudanca_cat || 0) + (cat.saida_transferencia || 0)

    const existencia_atual = Math.max(0,
      cat.existencia_atual ||
      (cat.existencia_anterior || 0) + entrada_total - saida_total
    )

    const indice_mortalidade =
      existencia_atual > 0 ? (cat.saida_morte || 0) / existencia_atual : 0

    return {
      ...cat,
      existencia_anterior: cat.existencia_anterior || 0,
      existencia_atual,
      entrada_total,
      saida_total,
      indice_mortalidade,
    }
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
  const periodo = dados.mes && dados.ano ? `${meses[dados.mes]}/${dados.ano}` : 'período informado'

  // Linhas de detalhe por categoria
  const linhasCat = dados.categorias
    .filter(c => c.existencia_atual > 0)
    .map(c => `  ${c.item} ${c.discriminacao}: *${c.existencia_atual}*`)
    .join('\n')

  const obs = dados.observacoes ? `\n\n⚠️ _${dados.observacoes}_` : ''

  return `*Mapa de Rebanho - ${dados.fazenda || 'Grupo Ricci'}*
*${periodo}*

*Total: ${totalAtual.toLocaleString('pt-BR')} cabeças*
  Machos: ${machos.toLocaleString('pt-BR')} | Fêmeas: ${femeas.toLocaleString('pt-BR')}

*Por categoria:*
${linhasCat || '  (nenhuma categoria identificada)'}

*Movimentação:*
  Exist. anterior: ${totalAnterior.toLocaleString('pt-BR')}
  Nascimentos: ${totalNasc} | Compras: ${totalCompras}
  Vendas: ${totalVendas} | Mortes: ${totalMortes}

*Mortalidade:* ${mortalidadePct}%${obs}

_✅ Dados salvos no sistema._`
}

module.exports = { extrairDadosRebanho, gerarResumoWhatsApp }
