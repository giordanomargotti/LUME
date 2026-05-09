// api/comment.js
// ═══════════════════════════════════════════════════════════════
// LUME — Fase 3: Il Compositore
// Genera un commento AI breve (60-80 parole) su un'analisi che
// l'utente ha prodotto manualmente (grafico, pivot, analisi statistica)
// e ha deciso di aggiungere al report finale.
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { type, title, notes, snapshot, ruolo, argomento } = req.body
  if (!type || !title || !snapshot) {
    return res.status(400).json({ error: 'Parametri mancanti' })
  }

  const prompt = buildCommentPrompt(type, title, notes, snapshot, ruolo, argomento)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: 'Sei un consulente data analyst italiano. Generi commenti professionali brevi e specifici. Restituisci ESCLUSIVAMENTE testo, niente JSON, niente markdown, niente backtick.',
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Comment API error:', response.status, errText)
      return res.status(500).json({ error: `Claude API ${response.status}` })
    }

    const data = await response.json()
    const text = (data.content?.[0]?.text || '').trim()

    return res.status(200).json({ comment: text })

  } catch (err) {
    console.error('Comment handler error:', err)
    return res.status(500).json({ error: 'Errore: ' + err.message })
  }
}

function buildCommentPrompt(type, title, notes, snapshot, ruolo, argomento) {
  const noteSection = notes
    ? `\n\nNOTE DELL'UTENTE (importanti, da includere nel ragionamento):\n${notes}`
    : ''

  const profileLine = (ruolo || argomento)
    ? `\nProfilo utente: ruolo ${ruolo || '—'}, ambito ${argomento || '—'}`
    : ''

  return `Un utente ha prodotto un'analisi manuale e l'ha aggiunta al suo report.${profileLine}

TIPO DI ANALISI: ${type}
TITOLO DATO DALL'UTENTE: ${title}${noteSection}

DATI/RISULTATI DELL'ANALISI:
${snapshot}

═══════════════════════════════════════════════════════════
COMPITO
═══════════════════════════════════════════════════════════

Scrivi un commento professionale di 60-80 parole che interpreti l'analisi.

REGOLE:
- Italiano professionale, niente anglicismi non necessari
- Sii specifico sui numeri visibili (es. "Il Nord-Ovest concentra il 38%...")
- Niente cliché ("è importante notare..."), solo insight
- Se ci sono note dell'utente, integra il loro ragionamento
- Tono: bilanciato, adatto sia a uso operativo sia a condivisione con direzione
- NESSUNA frase generica, sempre ancorato ai dati specifici
- NON ripetere il titolo nel commento
- Niente formattazione (no markdown, no asterischi, no liste)

Restituisci SOLO il testo del commento, niente altro.`
}
