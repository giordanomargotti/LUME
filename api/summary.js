// api/summary.js
// ═══════════════════════════════════════════════════════════════
// LUME — Fase 1: Il Benvenuto
// Riassunto narrativo automatico generato da Claude al caricamento file
// Output: 1 frase narrativa + 2-3 alert sintetici (cluster, anomalie, correlazioni)
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { dataProfile, inferentialResults, ruolo, argomento } = req.body
  if (!dataProfile) return res.status(400).json({ error: 'Profilo dati mancante' })

  const prompt = buildSummaryPrompt(dataProfile, inferentialResults, ruolo, argomento)

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
        max_tokens: 600,
        system: 'Sei un generatore di brevi riassunti dati per professionisti italiani. Restituisci ESCLUSIVAMENTE JSON valido che inizia con { e finisce con }. Mai testo prima, mai testo dopo, mai backtick.',
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Summary API error:', response.status, errText)
      return res.status(500).json({ error: `Claude API ${response.status}` })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    // Parsing robusto (3 strategie come in analyze.js)
    let parsed = null
    try { parsed = JSON.parse(text.trim()) } catch(e) {}

    if (!parsed) {
      try {
        let t = text.trim()
        if (t.startsWith('```')) t = t.replace(/^```(json)?/, '').replace(/```$/, '').trim()
        parsed = JSON.parse(t)
      } catch(e) {}
    }

    if (!parsed) {
      try {
        const start = text.indexOf('{')
        if (start >= 0) {
          let depth = 0, end = -1, inStr = false, escape = false
          for (let i = start; i < text.length; i++) {
            const c = text[i]
            if (escape) { escape = false; continue }
            if (c === '\\') { escape = true; continue }
            if (c === '"') { inStr = !inStr; continue }
            if (inStr) continue
            if (c === '{') depth++
            if (c === '}') { depth--; if (depth === 0) { end = i; break } }
          }
          if (end > start) parsed = JSON.parse(text.slice(start, end + 1))
        }
      } catch(e) {}
    }

    if (!parsed) {
      console.error('Summary parse failed. Raw:', text.slice(0, 400))
      return res.status(500).json({ error: 'Risposta non parsabile' })
    }

    return res.status(200).json({ summary: parsed })

  } catch (err) {
    console.error('Summary handler error:', err)
    return res.status(500).json({ error: 'Errore: ' + err.message })
  }
}

function buildSummaryPrompt(dataProfile, inferentialResults, ruolo, argomento) {
  return `Sei un consulente data analyst. Un utente ha appena caricato un file dati. Devi accoglierlo con un riassunto BREVE e UTILE.

═══════════════════════════════════════════════════════════
PROFILO UTENTE (per calibrare il tono)
═══════════════════════════════════════════════════════════

Ruolo: ${ruolo || 'non specificato'}
Ambito di analisi: ${argomento || 'non specificato'}

═══════════════════════════════════════════════════════════
DATI CARICATI
═══════════════════════════════════════════════════════════

${dataProfile}

ANALISI INFERENZIALE GIÀ ESEGUITA:
${inferentialResults || 'Non disponibile'}

═══════════════════════════════════════════════════════════
COMPITO
═══════════════════════════════════════════════════════════

Genera un riassunto di benvenuto in formato JSON con questa struttura ESATTA:

{
  "narrative": "string — UNA SOLA FRASE di 25-40 parole che descrive cosa contengono i dati in modo umano e contestuale. Italiano professionale. Niente cliché. Sii specifico sui numeri. Esempio: 'Hai caricato 16 mesi di transazioni di vendita per un totale di €1,72M, distribuite su 5 regioni e 12 categorie di prodotto.'",
  
  "alerts": [
    {
      "type": "warning | insight | info",
      "icon": "⚠ | 💡 | 📊 | ✓",
      "text": "string — frase di 8-15 parole con un fatto specifico dai dati"
    }
  ]
}

REGOLE:
- "narrative": esattamente 1 frase, niente paragrafi
- "alerts": minimo 2, massimo 3
- "warning": per anomalie/outlier rilevati (icon ⚠)
- "insight": per pattern interessanti emersi dall'analisi inferenziale (icon 💡)
- "info": per fatti positivi sui dati (icon ✓ per completezza, 📊 per cluster)
- Italiano professionale, niente anglicismi
- Numeri formato italiano (1.000,50 mai 1,000.50, valuta con €)
- Sii specifico: "17 valori anomali nello sconto" SI, "alcuni outlier" NO
- Adatta il tono al ruolo dell'utente (più executive per manager, più operativo per specialist)

ESEMPIO OUTPUT ATTESO:

{
  "narrative": "Hai caricato 16 mesi di transazioni di vendita per un totale di €1,72M, distribuite su 5 regioni e 12 categorie di prodotto. I dati sono completi e ben strutturati per l'analisi.",
  "alerts": [
    {
      "type": "warning",
      "icon": "⚠",
      "text": "17 valori anomali rilevati nella colonna Sconto (>40%)"
    },
    {
      "type": "insight",
      "icon": "💡",
      "text": "Forte correlazione tra Quantità e Sconto (r=0,72)"
    },
    {
      "type": "info",
      "icon": "📊",
      "text": "3 cluster di clienti distinti identificati nei dati"
    }
  ]
}

Restituisci SOLO il JSON, niente altro.`
}
