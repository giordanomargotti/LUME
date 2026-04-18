// api/analyze.js
// Questa funzione gira su Vercel come serverless function
// L'utente non vede mai la API key di Claude — sta solo qui sul server

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { dataProfile, settore, ruolo, businessUnit, section } = req.body

  if (!dataProfile) {
    return res.status(400).json({ error: 'Dati mancanti' })
  }

  // ── COSTRUZIONE PROMPT SCOPE ──────────────────────────
  // Il profilo utente modifica tono e focus
  const toneMap = {
    'data_analyst':      'Usa linguaggio tecnico, includi metriche precise e metodologie statistiche.',
    'middle_management': 'Bilancia insight tecnici con implicazioni business. Sii concreto.',
    'team_leader':       'Focalizzati su implicazioni operative e azioni per il team.',
    'sales_manager':     'Prioritizza insight commerciali e azioni immediate sulle vendite.',
  }

  const tone = toneMap[ruolo] || 'Sii chiaro e diretto.'

  // Prompt per ogni sezione SCOPE
  const scopePrompts = {
    S: `Sei Lume, uno strumento di analisi dati AI per professionisti.
Analizza questo dataset per un utente che lavora in: ${settore} · ruolo: ${ruolo} · area: ${businessUnit}.
${tone}

DATI RICEVUTI:
${dataProfile}

SEZIONE S — SITUAZIONE
Descrivi in modo chiaro e diretto:
1. Cosa contiene questo dataset (cosa misurano i dati, periodo coperto se deducibile)
2. Qualità dei dati (completezza, anomalie evidenti, colonne problematiche)
3. Una frase di sintesi su cosa rappresentano questi dati nel contesto aziendale

Rispondi in italiano. Massimo 150 parole. Niente elenchi puntati generici — scrivi come un consulente che ha appena letto il file.`,

    C: `Sei Lume, uno strumento di analisi dati AI.
Contesto utente: ${settore} · ${ruolo} · ${businessUnit}.
${tone}

DATI:
${dataProfile}

SEZIONE C — CRITICITÀ
Identifica le 3 criticità più importanti nei dati:
- Valori anomali o outlier significativi
- Pattern negativi (cali, concentrazioni di rischio, valori mancanti critici)
- Incoerenze o segnali d'allarme

Per ogni criticità: nome breve, descrizione concreta, impatto potenziale sul business.
Italiano. Massimo 180 parole. Sii specifico sui numeri dove possibile.`,

    O: `Sei Lume, uno strumento di analisi dati AI.
Contesto utente: ${settore} · ${ruolo} · ${businessUnit}.
${tone}

DATI:
${dataProfile}

SEZIONE O — OPPORTUNITÀ
Identifica 3 opportunità concrete che emergono da questi dati:
- Segmenti o pattern positivi da sfruttare
- Correlazioni interessanti
- Aree di crescita o ottimizzazione visibili nei numeri

Sii ottimista ma ancorato ai dati. Niente generico. Italiano. Max 180 parole.`,

    P: `Sei Lume, uno strumento di analisi dati AI.
Contesto utente: ${settore} · ${ruolo} · ${businessUnit}.
${tone}

DATI:
${dataProfile}

SEZIONE P — PRIORITÀ
Elenca le 3 azioni concrete e prioritarie che questo utente dovrebbe intraprendere
basandosi sull'analisi dei dati. Ogni azione deve essere:
- Specifica (non "migliorare le vendite" ma "contattare i clienti nel cluster X che non acquistano da 60gg")
- Fattibile entro 2 settimane
- Collegata direttamente a un dato visibile

Italiano. Max 160 parole. Scrivi come se fossi il suo consulente.`,

    E: `Sei Lume, uno strumento di analisi dati AI.
Contesto utente: ${settore} · ${ruolo} · ${businessUnit}.
${tone}

DATI:
${dataProfile}

SEZIONE E — ESPOSIZIONE AL RISCHIO
Identifica i principali rischi e limitazioni dell'analisi:
- Cosa questi dati NON dicono (limiti del dataset)
- Rischi nascosti nei pattern rilevati
- Assunzioni che l'utente non dovrebbe fare

Sii onesto sui limiti. Questo crea fiducia. Italiano. Max 150 parole.`,
  }

  const prompt = scopePrompts[section]
  if (!prompt) {
    return res.status(400).json({ error: 'Sezione non valida' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY, // La key sta solo qui — mai esposta al browser
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    const data = await response.json()
    const text = data.content?.[0]?.text || 'Nessun risultato.'

    return res.status(200).json({ result: text })

  } catch (err) {
    console.error('Claude API error:', err)
    return res.status(500).json({ error: 'Errore nella chiamata AI.' })
  }
}
