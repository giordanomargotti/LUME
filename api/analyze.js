// api/analyze.js
// Serverless function eseguita su Vercel
// Riceve dati + profilo utente, costruisce prompt SCOPE, chiama Claude
// La API key sta solo qui — mai esposta al browser

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { dataProfile, ruolo, argomento, section } = req.body

  if (!dataProfile || !ruolo || !argomento || !section) {
    return res.status(400).json({ error: 'Parametri mancanti' })
  }

  // ── TONE: cambia in base al ruolo ────────────────────
  const toneMap = {
    'data_analyst':      'Usa linguaggio tecnico, includi metriche precise e metodologie statistiche dove pertinenti. Non semplificare.',
    'middle_management': 'Bilancia insight tecnici con implicazioni di business. Sii concreto, evita gergo eccessivo.',
    'team_leader':       'Focalizzati su implicazioni operative e azioni concrete che il team può intraprendere subito.',
    'sales_manager':     'Prioritizza insight commerciali e azioni immediate sulle vendite. Pensa in termini di pipeline e revenue.',
  }
  const tone = toneMap[ruolo] || 'Sii chiaro e diretto.'

  // ── FOCUS: cambia in base all'argomento ──────────────
  const focusMap = {
    'crm':        'Cerca pattern su retention, frequenza acquisti, segmentazione clienti, churn, lifetime value.',
    'sales':      'Cerca pattern su performance per venditore/regione/prodotto, conversion rate, sconti, ciclo di vendita.',
    'finance':    'Cerca pattern su margini, costi, variazioni budget vs actual, anomalie contabili, concentrazioni di rischio.',
    'operations': 'Cerca pattern su efficienza processi, tempi di esecuzione, colli di bottiglia, qualità output.',
    'marketing':  'Cerca pattern su CAC, ROAS, conversion funnel, performance per canale, anomalie di campagna.',
    'other':      'Identifica i pattern più rilevanti emergenti dai dati.',
  }
  const focus = focusMap[argomento] || focusMap.other

  // ── PROMPT SCOPE per ogni sezione ────────────────────
  const scopePrompts = {
    S: `Sei Lume, uno strumento di analisi dati AI per professionisti italiani.
Stai analizzando dati per un utente con ruolo: ${ruolo}, ambito: ${argomento}.

${tone}
${focus}

DATI RICEVUTI:
${dataProfile}

COMPITO — SEZIONE S · SITUAZIONE
Descrivi in modo chiaro e diretto:
1. Cosa contiene questo dataset (cosa misurano i dati, periodo coperto se deducibile)
2. Qualità dei dati (completezza, eventuali colonne problematiche)
3. Una frase finale di sintesi su cosa rappresentano questi dati nel contesto del suo lavoro

VINCOLI:
- Italiano, massimo 150 parole
- Niente elenchi puntati generici
- Scrivi come un consulente che ha appena letto il file e fa un brief al cliente
- Sii specifico sui numeri quando possibile`,

    C: `Sei Lume, uno strumento di analisi dati AI.
Profilo utente: ruolo ${ruolo}, ambito ${argomento}.

${tone}
${focus}

DATI:
${dataProfile}

COMPITO — SEZIONE C · CRITICITÀ
Identifica le 3 criticità più importanti emerse dai dati:
- Anomalie statistiche o outlier significativi
- Pattern negativi (cali, concentrazioni di rischio, valori anomali)
- Incoerenze, valori mancanti critici, segnali d'allarme

Per ogni criticità: nome breve, descrizione concreta con numeri, impatto potenziale sul business.

VINCOLI:
- Italiano, massimo 200 parole
- Sii specifico sui numeri (es. "il 23% dei clienti...", non "molti clienti...")
- Una criticità per paragrafo, separati`,

    O: `Sei Lume, uno strumento di analisi dati AI.
Profilo utente: ruolo ${ruolo}, ambito ${argomento}.

${tone}
${focus}

DATI:
${dataProfile}

COMPITO — SEZIONE O · OPPORTUNITÀ
Identifica 3 opportunità concrete che emergono da questi dati:
- Segmenti, prodotti o canali con performance positive da espandere
- Correlazioni interessanti che suggeriscono leve d'azione
- Aree di crescita o ottimizzazione visibili nei numeri

VINCOLI:
- Italiano, massimo 200 parole
- Sii ottimista ma sempre ancorato ai dati
- Niente generico ("aumentare le vendite") — solo opportunità specifiche
- Una opportunità per paragrafo`,

    P: `Sei Lume, uno strumento di analisi dati AI.
Profilo utente: ruolo ${ruolo}, ambito ${argomento}.

${tone}
${focus}

DATI:
${dataProfile}

COMPITO — SEZIONE P · PRIORITÀ
Elenca le 3 azioni concrete e prioritarie che l'utente dovrebbe intraprendere
basandosi sull'analisi. Ogni azione deve essere:
- Specifica (NO "migliorare le vendite", SI "contattare i 18 clienti del segmento Enterprise senza acquisti negli ultimi 60 giorni")
- Fattibile entro 2 settimane
- Direttamente collegata a un dato visibile nel dataset

VINCOLI:
- Italiano, massimo 180 parole
- Numera le 3 azioni (1, 2, 3)
- Ogni azione: cosa fare, perché (riferimento ai dati), cosa ti aspetti come risultato`,

    E: `Sei Lume, uno strumento di analisi dati AI.
Profilo utente: ruolo ${ruolo}, ambito ${argomento}.

${tone}
${focus}

DATI:
${dataProfile}

COMPITO — SEZIONE E · ESPOSIZIONE AL RISCHIO
Identifica i principali rischi e limitazioni:
- Cosa questi dati NON dicono (limiti del dataset)
- Rischi nascosti dietro i pattern rilevati
- Assunzioni che l'utente NON dovrebbe fare basandosi solo su questi dati

VINCOLI:
- Italiano, massimo 150 parole
- Sii onesto sui limiti — questo crea fiducia e professionalità
- Niente generalità — riferimenti specifici a colonne o dati visibili`,
  }

  const prompt = scopePrompts[section]
  if (!prompt) {
    return res.status(400).json({ error: 'Sezione non valida (usa S, C, O, P, E)' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Claude API error:', response.status, errText)
      return res.status(500).json({ error: `Claude API ${response.status}: ${errText.slice(0,200)}` })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || 'Nessun risultato.'

    return res.status(200).json({ result: text })

  } catch (err) {
    console.error('Errore handler:', err)
    return res.status(500).json({ error: 'Errore: ' + err.message })
  }
}
