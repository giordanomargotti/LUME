// api/analyze.js
// ═══════════════════════════════════════════════════════════════
// LUME — Serverless function per generazione report SCOPE
// ═══════════════════════════════════════════════════════════════
// Riceve: profilo dati + risultati analisi inferenziale + ruolo + argomento
// Restituisce: JSON strutturato con report completo
// La API key Claude è in env variable, mai esposta al browser
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { dataProfile, inferentialResults, ruolo, argomento } = req.body
  if (!dataProfile || !ruolo || !argomento) {
    return res.status(400).json({ error: 'Parametri mancanti' })
  }

  const promptKey = `${ruolo}__${argomento}`
  const scopeBlock = SCOPE_BLOCKS[promptKey]

  if (!scopeBlock) {
    return res.status(400).json({
      error: `Combinazione non disponibile: ${ruolo} × ${argomento}. Disponibili: ${Object.keys(SCOPE_BLOCKS).join(', ')}`
    })
  }

  const fullPrompt = buildPrompt(scopeBlock, dataProfile, inferentialResults || 'Nessuna analisi inferenziale eseguita.')

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5000,
        system: 'Restituisci ESCLUSIVAMENTE JSON valido. Inizia ESATTAMENTE con { e finisci ESATTAMENTE con }. VIETATO: backtick, markdown, ```json, testo introduttivo, spiegazioni. Solo JSON puro. Mantieni la risposta concisa per stare nei token disponibili: ogni sezione narrative max 120 parole, ogni recommendation max 50 parole. Se senti che stai per superare i token, accorcia, NON troncare.',
        messages: [{ role: 'user', content: fullPrompt }]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Claude API error:', response.status, errText)
      return res.status(500).json({ error: `Claude API ${response.status}: ${errText.slice(0, 300)}` })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''
    const stopReason = data.stop_reason || 'unknown'

    // Log per debug nei Vercel Logs
    console.log('=== CLAUDE RESPONSE ===')
    console.log('stop_reason:', stopReason)
    console.log('text length:', text.length)
    console.log('first 300:', text.slice(0, 300))
    console.log('last 300:', text.slice(-300))

    // Parsing JSON robusto - prova più strategie
    let parsed = null
    let parseErrors = []

    // Strategia 1: JSON puro
    try {
      parsed = JSON.parse(text.trim())
    } catch(e) { parseErrors.push('puro: ' + e.message) }

    // Strategia 2: rimuovi backtick markdown
    if (!parsed) {
      try {
        let t = text.trim()
        if (t.startsWith('```')) t = t.replace(/^```(json)?/, '').replace(/```$/, '').trim()
        parsed = JSON.parse(t)
      } catch(e) { parseErrors.push('backtick: ' + e.message) }
    }

    // Strategia 3: estrai primo blocco { ... } bilanciato
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
          if (end > start) {
            parsed = JSON.parse(text.slice(start, end + 1))
          }
        }
      } catch(e) { parseErrors.push('extract: ' + e.message) }
    }

    // Strategia 4: JSON troncato (max_tokens) — chiudi array/oggetti aperti
    if (!parsed) {
      try {
        const start = text.indexOf('{')
        if (start >= 0) {
          // Rimuovi prima eventuali backtick iniziali
          let t = text.slice(start)
          // Trova ultima virgola top-level sicura e chiudi da lì
          let depth = 0, depthArr = 0, inStr = false, escape = false
          let lastSafeComma = -1
          for (let i = 0; i < t.length; i++) {
            const c = t[i]
            if (escape) { escape = false; continue }
            if (c === '\\') { escape = true; continue }
            if (c === '"') { inStr = !inStr; continue }
            if (inStr) continue
            if (c === '{') depth++
            if (c === '}') depth--
            if (c === '[') depthArr++
            if (c === ']') depthArr--
            if (c === ',' && depthArr === 0 && depth === 1) lastSafeComma = i
          }
          if (lastSafeComma > 0 && depth > 0) {
            let fixed = t.slice(0, lastSafeComma)
            for (let k = 0; k < depthArr; k++) fixed += ']'
            for (let k = 0; k < depth; k++) fixed += '}'
            parsed = JSON.parse(fixed)
            console.log('✓ Recovered truncated JSON (strategy 4)')
          }
        }
      } catch(e) { parseErrors.push('truncate-fix: ' + e.message) }
    }

    // Strategia 5: troncatura aggressiva — JSON tagliato a metà stringa
    // Risale fino all'ultima virgola "safe" tra oggetti/array completi
    if (!parsed) {
      try {
        const start = text.indexOf('{')
        if (start >= 0) {
          let t = text.slice(start)
          // Se finiamo dentro una stringa, prova a tagliare PRIMA dell'ultima stringa aperta
          let depth = 0, depthArr = 0, inStr = false, escape = false
          let safePoint = -1  // posizione "sicura" = dopo ogni } o ] top-level

          for (let i = 0; i < t.length; i++) {
            const c = t[i]
            if (escape) { escape = false; continue }
            if (c === '\\') { escape = true; continue }
            if (c === '"') { inStr = !inStr; continue }
            if (inStr) continue
            if (c === '{') depth++
            if (c === '}') depth--
            if (c === '[') depthArr++
            if (c === ']') depthArr--

            // Se siamo in posizione "completa" (oggetto chiuso dentro un array a depth=1)
            if ((c === '}' || c === ']') && depth >= 1 && !inStr) {
              safePoint = i + 1
            }
          }

          if (safePoint > 0) {
            // Taglia al safePoint, chiudi tutto ciò che resta aperto
            let cut = t.slice(0, safePoint)
            // Ricalcola depth dopo il taglio per chiudere correttamente
            let d = 0, dA = 0, ins = false, esc = false
            for (let i = 0; i < cut.length; i++) {
              const c = cut[i]
              if (esc) { esc = false; continue }
              if (c === '\\') { esc = true; continue }
              if (c === '"') { ins = !ins; continue }
              if (ins) continue
              if (c === '{') d++
              if (c === '}') d--
              if (c === '[') dA++
              if (c === ']') dA--
            }
            // Chiudi array/oggetti rimasti aperti
            for (let k = 0; k < dA; k++) cut += ']'
            for (let k = 0; k < d; k++) cut += '}'
            parsed = JSON.parse(cut)
            console.log('✓ Recovered with aggressive truncate (strategy 5)')
          }
        }
      } catch(e) { parseErrors.push('aggressive-truncate: ' + e.message) }
    }

    if (!parsed) {
      console.error('=== PARSE FAILED ===')
      console.error('Errors:', parseErrors)
      console.error('Stop reason:', stopReason)
      console.error('Full raw:', text)
      return res.status(500).json({
        error: 'Risposta AI non parsabile come JSON',
        debug: parseErrors.join(' | '),
        stop_reason: stopReason,
        raw: text.slice(0, 1500)
      })
    }

    return res.status(200).json({ report: parsed })

  } catch (err) {
    console.error('Handler error:', err)
    return res.status(500).json({ error: 'Errore: ' + err.message })
  }
}

function buildPrompt(scopeBlock, dataProfile, inferentialResults) {
  return `Agisci come un consulente esperto di analisi dati con 15 anni di esperienza nel supportare aziende italiane su decisioni data-driven.

═══════════════════════════════════════════════════════════
S — SCOPE
═══════════════════════════════════════════════════════════

${scopeBlock.scope}

═══════════════════════════════════════════════════════════
C — CONTEXT
═══════════════════════════════════════════════════════════

${scopeBlock.context}

DATI DISPONIBILI:
${dataProfile}

ANALISI INFERENZIALE GIÀ ESEGUITA (usala per arricchire i commenti):
${inferentialResults}

PERIODO DI ANALISI:
Adatta automaticamente la dimensione temporale ai dati ricevuti:
- Dati che coprono >2 anni → confronto Year over Year + breakdown trimestrale
- Dati che coprono 6-24 mesi → analisi trimestrale e mensile
- Dati che coprono <6 mesi → analisi mensile e settimanale
Identifica autonomamente la copertura temporale dalla colonna data, se presente.

VINCOLI SUI DATI:
- Lavora SOLO con le colonne effettivamente presenti
- NON inventare valori, NON ipotizzare KPI non calcolabili
- Se una colonna è ambigua, interpreta in modo prudente e dichiaralo
- Se mancano dati per un'analisi richiesta, salta quella sezione e segnalalo in data_quality_notes

═══════════════════════════════════════════════════════════
O — OUTPUT
═══════════════════════════════════════════════════════════

Restituisci ESCLUSIVAMENTE un JSON valido. Niente testo prima, niente markdown, niente backtick. Solo JSON pulito che inizia con { e finisce con }.

Schema obbligatorio:

{
  "title": "string",
  "period_analyzed": "string — es. 'Gen 2024 - Apr 2025' o 'Periodo non determinabile'",
  "executive_summary": "string 100-150 parole — DEVE seguire struttura Minto: AFFERMAZIONE + 3 RAGIONI + IMPLICAZIONE",
  "kpi_cards": [
    { "label": "string", "value": "string formattato", "delta": "string o null", "trend": "up | down | flat", "comment": "string 1 frase argomentativa, non descrittiva" }
  ],
  "sections": [
    {
      "title": "string — affermazione, non descrizione (es. 'Il Sud ha problema di mix, non di skill')",
      "narrative": "string 100-180 parole, pattern AFFERMAZIONE → EVIDENZA → IMPLICAZIONE",
      "chart": {
        "type": "bar | horizontal_bar | grouped_bar | stacked_bar | line | area | dual_axis | pie | donut | scatter | heatmap | treemap",
        "x_axis": "nome esatto colonna",
        "y_axis": "nome esatto colonna numerica (o array di colonne per dual_axis/grouped_bar/stacked_bar)",
        "aggregation": "sum | mean | count | median | min | max",
        "group_by": "nome colonna categoriale o null",
        "value_format": "currency_eur | percentage | number | integer | decimal",
        "sort": "value_desc | value_asc | label_asc | none",
        "limit": "numero massimo di categorie da mostrare (default 12, max 20)",
        "title": "string — DEVE essere l'AFFERMAZIONE che il grafico dimostra, con numero chiave",
        "subtitle": "string 6-12 parole — contestualizza cosa il grafico rivela",
        "insight": "string 1 frase con il take-away principale del grafico",
        "logic": "string 1 frase — perché hai scelto questo tipo di grafico",
        "highlight": {
          "indices": "array di indici (0-based) degli elementi da evidenziare visivamente, oppure null se nessuno",
          "rationale": "string 1 frase — cosa il lettore deve guardare in particolare"
        }
      },
      "key_findings": ["string", "string"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta | media | bassa",
      "title": "string — verbo di azione",
      "action": "string 40-70 parole — pattern SCQA: SITUAZIONE attuale + COMPLICAZIONE rilevata + RISOLUZIONE proposta",
      "data_evidence": "string — l'evidenza numerica specifica che giustifica l'azione",
      "expected_impact": "string — risultato quantificato con orizzonte temporale"
    }
  ],
  "data_quality_notes": ["string"]
}

═══════════════════════════════════════════════════════════
P — PARAMETERS
═══════════════════════════════════════════════════════════

LINGUA: italiano professionale, no anglicismi inutili.
NUMEROSITÀ: 4-6 kpi_cards, 3-5 sections, 3-5 recommendations.
NUMERI: formato italiano (1.000,50), € con simbolo, percentuali con segno (+12,3%), abbreviazioni €1,72M / €847k.

🏛️ STRUTTURA ARGOMENTATIVA (Minto Pyramid):

NON descrivere i dati. ARGOMENTA partendo dalla conclusione.

executive_summary: AFFERMAZIONE netta + 3 RAGIONI che la sostengono + IMPLICAZIONE per chi decide.
❌ "Le vendite hanno totalizzato €1,72M..."
✅ "Performance solida ma esposta: 3 venditori del Nord-Ovest generano il 47%. Tre evidenze: (1)... (2)... (3)... Decisione necessaria: ridurre dipendenza top 3."

section.title: AFFERMAZIONE, non argomento.
❌ "Performance per regione"
✅ "La concentrazione Nord-Ovest è il rischio principale"

section.narrative: pattern AFFERMAZIONE → EVIDENZA numerica → IMPLICAZIONE.

recommendations: pattern SCQA (Situazione attuale + Complicazione + Risoluzione concreta). data_evidence con numero specifico, expected_impact con tempo e magnitudo.

📊 STORYTELLING CON DATI (Knaflic):

Ogni grafico serve UNA tesi specifica, non visualizzazione neutra.

chart.title: TESI del grafico con numero chiave.
❌ "Fatturato per regione"
✅ "Il Nord-Ovest concentra €654K, 3,3x il Sud"

chart.highlight.indices: indici (0-based) degli elementi da evidenziare visivamente. L'app colorerà in arancione gli highlighted e in grigio gli altri.
- Top N dominano → [0, 1, ..., N-1]
- 1 anomalia → [indice anomalo]
- Trend temporale o senza focus → null
- scatter/heatmap/dual_axis → null

Decluttering: max 12 categorie (oltre = "Altro"), max 5 fette per pie/donut, max 5 serie line.
Ordine: sort value_desc per categorie, label_asc per temporali.

🎯 TIPI DI GRAFICO (usa il più informativo):
- bar / horizontal_bar (etichette lunghe o >8 categorie)
- grouped_bar / stacked_bar (multi-dimensione)
- line / area (trend temporali)
- dual_axis (2 metriche scale diverse)
- pie / donut (max 5 fette)
- scatter (correlazioni o cluster)
- heatmap (matrice 2D)
- treemap (composizione disomogenea)

REGOLE TECNICHE:
- 1 grafico per sezione
- Solo colonne effettivamente esistenti
- y_axis può essere array per dual_axis/grouped_bar/stacked_bar

REGOLE CONTENUTO:
- Ogni numero verificabile dai dati
- Niente cliché, solo insight specifici
- Recommendations = AZIONI concrete
- Usa l'analisi inferenziale (cluster/correlazioni/outlier) per arricchire

═══════════════════════════════════════════════════════════
E — EXAMPLE
═══════════════════════════════════════════════════════════

${scopeBlock.example}

═══════════════════════════════════════════════════════════

Genera il report ora. Ricorda: SOLO JSON, niente altro.`
}

// ═══════════════════════════════════════════════════════════════
// I 9 BLOCCHI SCOPE
// ═══════════════════════════════════════════════════════════════
const SCOPE_BLOCKS = {

  'sales_specialist__sales_reporting': {
    scope: `Genera un report completo di SALES REPORTING che possa servire sia per uso operativo (Sales Manager analizza la sua area) sia per condivisione con la direzione (executive summary leggibile in 2 minuti).

Il report deve dare risposte alle 5 domande chiave del Sales Manager:
1. Come stiamo andando? (volumi, valore, trend temporali)
2. Chi vende meglio? (performance per venditore, regione, canale)
3. Cosa vendiamo? (mix prodotti, marginalità, dinamica sconti)
4. A chi vendiamo? (segmenti cliente, tipologia, dimensione)
5. Cosa fare adesso? (azioni prioritarie ancorate ai dati)`,
    context: `PROFILO UTENTE: Sales Specialist/Manager. Il report deve essere usabile sia operativamente sia condivisibile con la direzione.

DATI ATTESI: transazioni di vendita con dimensioni come venditore, regione, prodotto, cliente, importo, sconto, margine, data.`,
    example: `Esempio parziale di output (per calibrare lo stile e l'uso dei nuovi campi grafico):

{
  "title": "Sales Reporting · Performance Commerciale",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "La performance commerciale è solida ma esposta a un rischio strutturale: 3 venditori del Nord-Ovest generano il 47% del fatturato totale (€812k su €1,72M). Tre evidenze sostengono questa tesi: la concentrazione geografica Nord-Ovest è del 38% con gap di 3,3x verso il Sud (1), il Sud sottoperforma per mix prodotto inefficiente non per skill — 78% Software Base vs media 45% (2), il segmento Hardware deteriora il margine complessivo nonostante pesi solo il 5,9% dei volumi (3). Decisione necessaria: ridurre la dipendenza dai top performer Nord-Ovest e riallineare il mix Sud nei prossimi 6 mesi.",
  "sections": [
    {
      "title": "La concentrazione Nord-Ovest è il rischio principale",
      "narrative": "Il Nord-Ovest concentra €654k (38% del totale) grazie a 3 venditori top performer su un totale di 10. Il Sud sottoperforma con €198k nonostante 2 venditori attivi — il ticket medio (€1.850) è il più basso suggerendo problemi di mix prodotto più che di volume. L'analisi cluster mostra che il 60% dei deal Nord-Ovest sono nel cluster ad alto valore (€4.200 medio) mentre il Sud è polarizzato sul cluster low-value. Implicazione: la dipendenza da una sola area geografica espone il business a shock locali e turnover dei top 3.",
      "chart": {
        "type": "horizontal_bar",
        "x_axis": "Importo Netto",
        "y_axis": "Regione",
        "aggregation": "sum",
        "group_by": null,
        "value_format": "currency_eur",
        "sort": "value_desc",
        "limit": 10,
        "title": "Il Nord-Ovest concentra €654K, 3,3x il Sud",
        "subtitle": "Fatturato per regione · gap geografico marcato",
        "insight": "Concentrazione di fatturato nel Nord-Ovest con gap di 3,3x verso le regioni meridionali",
        "logic": "horizontal_bar perché evidenzia il ranking e permette etichette regionali leggibili",
        "highlight": {
          "indices": [0],
          "rationale": "Il Nord-Ovest è IL punto: tutto il messaggio ruota attorno alla sua dominanza"
        }
      },
      "key_findings": ["Nord-Ovest genera 3,3x il Sud con stesso numero venditori", "Ticket medio Sud (€1.850) suggerisce mix prodotto inefficiente"]
    },
    {
      "title": "L'Hardware deteriora il margine nonostante volumi marginali",
      "narrative": "Il Software Pro è la categoria con miglior bilanciamento volumi/margine: 28% del fatturato (€482k) con marginalità 58%. L'Hardware è l'anomalia del portfolio: marginalità del 18% — la più bassa — nonostante rappresenti solo il 5,9% dei volumi. Il Software Enterprise concentra deal di alto valore (€18k medio) ma cicli più lunghi. Implicazione: dismettere o riprezzare Hardware può alzare il margine complessivo dal 56% al 58% senza impatti significativi sul fatturato.",
      "chart": {
        "type": "dual_axis",
        "x_axis": "Categoria",
        "y_axis": ["Importo Netto", "Margine %"],
        "aggregation": "sum",
        "group_by": null,
        "value_format": "currency_eur",
        "sort": "value_desc",
        "limit": 8,
        "title": "Hardware: 5,9% volumi ma margine al 18%",
        "subtitle": "Volumi e marginalità per categoria di prodotto",
        "insight": "L'Hardware deteriora il margine medio nonostante volumi marginali",
        "logic": "dual_axis per confrontare due metriche con scale diverse (€ assoluti vs % marginalità)",
        "highlight": {
          "indices": null,
          "rationale": "dual_axis non supporta highlight diretto; usare colori distinti per le due metriche"
        }
      },
      "key_findings": ["Hardware abbassa margine complessivo dal 58% al 56%", "Software Pro è la sweet-spot del portfolio"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Riallineare mix prodotto Sud",
      "action": "Situazione: il Sud genera €198k con ticket medio €1.850 contro media nazionale di €2.850. Complicazione: il gap non è di volumi (numero deal simile alla media) ma di mix prodotto sbilanciato su entry level. Risoluzione: affiancare ai 2 venditori Sud (Marini, Greco) un sales coach per 4 settimane focalizzato sul cross-sell di Software Pro ed Enterprise, oggi quasi assenti nel loro mix.",
      "data_evidence": "Sud vende 78% Software Base e 0% Enterprise vs media nazionale 45/15%",
      "expected_impact": "Aumento ticket medio Sud da €1.850 a €2.400 in 3 mesi (+30%)"
    }
  ],
  "data_quality_notes": ["30 righe (3,5%) hanno colonna Margine vuota — escluse dall'analisi di marginalità", "17 righe con sconto >40% sono outlier — analizzate separatamente"]
}`
  },

  'sales_specialist__salesman_productivity': {
    scope: `Analizza la PRODUTTIVITÀ DELLA FORZA VENDITA per identificare top performer, sottoperformanti e leve di crescita individuale.

Risposte chiave:
1. Chi sta sopra/sotto la media? (output, ticket medio, win rate)
2. Cosa distingue i top performer? (mix prodotto, segmento, canale)
3. Dove c'è gap tra potenziale e risultato? (territorio sotto-presidiato, prodotti non venduti)
4. Su quali venditori investire? (formazione, affiancamento, riallocazione)
5. Quali pattern emergono nei comportamenti vincenti?`,
    context: `PROFILO UTENTE: Sales Manager che vuole capire dove agire sulla forza vendita.

DATI ATTESI: colonne identificative dei venditori (venditore, agente, sales rep, ID), eventualmente regione/area, fatturato/quantità/deal chiusi, durata trattativa, prodotti.

ATTENZIONE: se mancano colonne identificative dei venditori, segnalalo in data_quality_notes e adatta l'analisi su altre dimensioni (canale, regione, tipologia cliente).`,
    example: `Esempio parziale:

{
  "title": "Salesman Productivity · Analisi Forza Vendita",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "Su 10 venditori attivi, 3 generano il 47% del fatturato totale (€812k). La distribuzione è polarizzata con CV del 38%. Un venditore mostra volumi simili ai top (87 deal) ma fatturato dimezzato (€132k) per mix prodotto polarizzato su entry level...",
  "sections": [
    {
      "title": "Ranking performer per fatturato",
      "narrative": "Il top performer guida con €245k (14% del totale) e ticket medio €2.840, il 53% sopra la media. La fascia centrale (5 venditori) gestisce il 38% del fatturato. Due venditori mostrano gap del -45% rispetto alla media nonostante volumi paragonabili — l'analisi indica un mix prodotto sbilanciato su entry level...",
      "chart": {
        "type": "horizontal_bar",
        "x_axis": "Importo Netto",
        "y_axis": "Venditore",
        "aggregation": "sum",
        "group_by": null,
        "value_format": "currency_eur",
        "sort": "value_desc",
        "limit": 12,
        "title": "Top 3 venditori generano il 47% del fatturato totale",
        "subtitle": "Ranking individuale · concentrazione marcata sui top performer",
        "insight": "Distribuzione polarizzata: 30% del team genera quasi metà del business",
        "logic": "horizontal_bar perché evidenzia il ranking e i nomi dei venditori restano leggibili",
        "highlight": {"indices": [0], "rationale": "Il top del ranking è il punto del messaggio"}
      },
      "key_findings": ["Top 3 venditori (30% headcount) producono 47% fatturato", "Un venditore ha volumi top ma ticket medio del 51% inferiore"]
    },
    {
      "title": "Volumi vs ticket medio · individuare i talenti nascosti",
      "narrative": "Confrontando numero deal e ticket medio emerge una dispersione significativa. Tre profili: top performer (alti volumi, alto ticket), workhorse (alti volumi, ticket medio), specialisti (pochi deal ma ticket elevato). Due venditori del cluster workhorse potrebbero essere riallineati per spostarsi nel cluster top con lavoro su mix prodotto...",
      "chart": {
        "type": "scatter",
        "x_axis": "Numero Deal",
        "y_axis": "Ticket Medio",
        "aggregation": "mean",
        "group_by": null,
        "value_format": "currency_eur",
        "title": "Performance per venditore: 3 cluster naturali",
        "subtitle": "Ogni punto = un venditore · alto a destra = top performer",
        "insight": "Cluster workhorse (alto volume, basso ticket) ha potenziale di crescita non sfruttato",
        "logic": "scatter perché l'incrocio tra due metriche numeriche rivela cluster comportamentali",
        "highlight": null
      },
      "key_findings": ["3 cluster naturali identificati nel team", "Cluster workhorse: 2 venditori con potenziale di upsell"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Cross-sell coaching mirato",
      "action": "Programma di affiancamento di 6 settimane tra venditori workhorse e top performer sul ciclo di vendita prodotti a maggior valore.",
      "data_evidence": "I workhorse vendono 76% prodotti entry vs 42% del top performer",
      "expected_impact": "Allineamento ticket medio a €2.000 entro Q3"
    }
  ],
  "data_quality_notes": ["Tutti i venditori attivi presenti nel dataset"]
}`
  },

  'sales_specialist__customer_profiling': {
    scope: `Profila e segmenta la BASE CLIENTI per personalizzare l'azione commerciale e individuare segmenti ad alto valore.

Risposte chiave:
1. Chi sono i nostri clienti tipo? (segmenti naturali nei dati)
2. Quali clienti generano più valore? (Pareto, top 20%)
3. Comportamenti d'acquisto distintivi? (frequenza, valore, mix)
4. Chi è a rischio churn? (clienti dormienti, in calo)
5. Su quali segmenti puntare in ottica strategica?`,
    context: `PROFILO UTENTE: Sales Manager interessato a capire la composizione della base clienti per orientare campagne, account management e strategie di crescita.

DATI ATTESI: ID cliente, dati anagrafici (tipo, dimensione, settore), date acquisto, importi, prodotti.

Calcola implicitamente metriche RFM (Recency, Frequency, Monetary) se la struttura dati lo permette. Usa il clustering già eseguito per dare nomi narrativi e parlanti ai segmenti (es. "fedeli ad alto valore", "sporadici ma high-spender").`,
    example: `Esempio parziale:

{
  "title": "Customer Profiling · Segmentazione Base Clienti",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "I 320 clienti si distribuiscono in 3 cluster naturali: Big Spender Enterprise (15%, scontrino €4.200), PMI ricorrenti (52%, €1.400 alta frequenza), Spot Startup (33%, €890 bassa frequenza). L'80% del fatturato proviene dal 23% dei clienti — Pareto stretto che richiede focus su account management top...",
  "sections": [
    {
      "title": "Segmenti naturali · matrice frequenza × valore",
      "narrative": "L'analisi cluster ha identificato 3 segmenti distinti per comportamento d'acquisto. Il segmento Big Spender Enterprise genera il 41% del fatturato con scontrino medio €4.200 ma frequenza bassa (2,1 acquisti/anno). Le PMI ricorrenti sono il cuore del business con frequenza elevata (5,8 acquisti/anno) e scontrino €1.400. Le Spot Startup completano la base con basso valore e bassa frequenza...",
      "chart": {
        "type": "scatter",
        "x_axis": "Frequenza Acquisti",
        "y_axis": "Importo Medio",
        "aggregation": "mean",
        "group_by": "Tipo Cliente",
        "value_format": "currency_eur",
        "title": "3 cluster di clienti distinti per comportamento",
        "subtitle": "Ogni punto = un cliente · alto a destra = ad alto valore",
        "insight": "I cluster non si sovrappongono: strategie commerciali ben differenziabili",
        "logic": "scatter perché rivela cluster naturali nell'incrocio tra le 2 metriche RFM principali",
        "highlight": null
      },
      "key_findings": ["Big Spender = 15% clienti ma 41% fatturato", "PMI ricorrenti hanno frequenza 2,8x rispetto agli Enterprise"]
    },
    {
      "title": "Pareto del fatturato cliente",
      "narrative": "L'analisi della concentrazione mostra che il 23% dei clienti (75 su 320) genera l'80% del fatturato. Il top 5% (16 clienti) da solo vale il 38%. Concentrazione di rischio elevata: la perdita di anche solo 5 clienti top impatterebbe il fatturato del 12%...",
      "chart": {
        "type": "bar",
        "x_axis": "Decile Cliente",
        "y_axis": "Fatturato Cumulato",
        "aggregation": "sum",
        "group_by": null,
        "value_format": "currency_eur",
        "sort": "label_asc",
        "limit": 10,
        "title": "Top 10% clienti = €1,1M, il 64% del totale",
        "subtitle": "Pareto stretto · concentrazione di rischio elevata",
        "insight": "Top decile genera valore 6x rispetto al decile mediano",
        "logic": "bar verticali ordinati per decile mostrano l'effetto cumulativo della concentrazione",
        "highlight": {"indices": [0], "rationale": "Il valore dominante è il punto del messaggio"}
      },
      "key_findings": ["80/20 stretto: 23% clienti = 80% fatturato", "Top 5% pesa 38% del business"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Account management dedicato Top 50",
      "action": "Identificare i top 50 clienti per fatturato e assegnare un account manager dedicato con touchpoint mensile e revisione trimestrale.",
      "data_evidence": "Top 50 generano €1,1M (64% fatturato totale)",
      "expected_impact": "Riduzione churn rate top 50 sotto 5% annuo"
    }
  ],
  "data_quality_notes": ["12 clienti senza data acquisto chiara — esclusi dall'analisi RFM"]
}`
  },

  'sales_specialist__sales_forecast': {
    scope: `Costruisci una PREVISIONE VENDITE basata sui pattern storici e identifica scenari futuri realistici.

Risposte chiave:
1. Qual è il trend storico reale? (lineare, stagionale, ciclico)
2. Quale forecast realistico per il prossimo periodo?
3. Quali fattori guidano i risultati? (regione, prodotto, stagionalità)
4. Quali rischi/opportunità nei prossimi mesi?
5. Su che assunzioni si basa la previsione e con quale incertezza?`,
    context: `PROFILO UTENTE: Sales Manager che deve preparare budget e forecast per il prossimo periodo.

DATI ATTESI: necessitano colonna data e valori numerici (importo, quantità). Idealmente almeno 6-12 mesi di storico.

Usa la regressione lineare già calcolata per estrapolare il trend. Identifica stagionalità se i dati coprono >12 mesi. Sii sempre esplicito sull'incertezza: ogni forecast ha margini di errore. NON essere troppo ottimista né troppo pessimista — usa intervalli di confidenza ragionevoli.`,
    example: `Esempio parziale:

{
  "title": "Sales Forecast · Proiezione Performance",
  "period_analyzed": "Gen 2024 - Apr 2025 (16 mesi)",
  "executive_summary": "La regressione su 16 mesi indica un trend di crescita del +3,2% mese su mese (R²=0,68). Estrapolando con questo modello, il prossimo trimestre dovrebbe attestarsi tra €420k (scenario prudente, -10%) e €510k (scenario ottimistico, +10%). Il modello cattura bene il trend ma non eventuali shock esterni o stagionalità inferiori ai 4 mesi...",
  "sections": [
    {
      "title": "Trend storico mensile e proiezione",
      "narrative": "Il fatturato mensile è cresciuto da €78k (inizio periodo) a €112k (fine periodo) con regressione lineare di pendenza positiva. La R² di 0,68 indica un fit discreto ma con variabilità mese su mese del 18%. Q4 storicamente più forte (+22% vs media), suggerendo stagionalità da considerare nel forecast Q4 prossimo...",
      "chart": {
        "type": "area",
        "x_axis": "Mese",
        "y_axis": "Importo Netto",
        "aggregation": "sum",
        "group_by": null,
        "value_format": "currency_eur",
        "sort": "label_asc",
        "limit": 20,
        "title": "Crescita +3,2% mensile · €78k → €112k in 16 mesi",
        "subtitle": "Trend lineare con stagionalità Q4 marcata",
        "insight": "Modello di regressione affidabile (R²=0,68) per orizzonti di 3-6 mesi",
        "logic": "area perché evidenzia il trend di volume cumulato e l'andamento progressivo",
        "highlight": null
      },
      "key_findings": ["Trend +3,2% mensile (R²=0,68)", "Stagionalità Q4 con +22% vs media"]
    },
    {
      "title": "Variabilità per categoria · stabilità del forecast",
      "narrative": "Le categorie principali mostrano diversi livelli di prevedibilità. Software Pro ha il trend più stabile (variabilità mese su mese 12%), mentre Servizi è più volatile (28%). Il forecast aggregato deve pesare diversamente le categorie in base alla loro varianza...",
      "chart": {
        "type": "line",
        "x_axis": "Mese",
        "y_axis": "Importo Netto",
        "aggregation": "sum",
        "group_by": "Categoria",
        "value_format": "currency_eur",
        "sort": "label_asc",
        "limit": 16,
        "title": "Software Pro: 12% variabilità · Servizi: 28%",
        "subtitle": "Confronto stabilità per categoria di prodotto",
        "insight": "Software Pro è la categoria più affidabile per il forecast a breve termine",
        "logic": "line multi-serie permette di confrontare la stabilità delle traiettorie",
        "highlight": null
      },
      "key_findings": ["Software Pro = ancora di stabilità del forecast", "Servizi richiede intervalli di confidenza più ampi"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Validare forecast con sales meeting",
      "action": "Confrontare la previsione modello con le pipeline qualitative dei venditori prima di formalizzare i budget. Includere componente bottom-up per le categorie più volatili.",
      "data_evidence": "Pipeline non presenti nei dati — necessaria validazione bottom-up",
      "expected_impact": "Forecast più accurato con scarto +/- 5% invece di +/- 12%"
    }
  ],
  "data_quality_notes": ["Il modello non cattura shock esterni o stagionalità intra-mensili"]
}`
  },

  'customer_care_specialist__dashboard_kpi': {
    scope: `Genera una DASHBOARD KPI sintetica del customer care con i principali indicatori operativi e di qualità.

Risposte chiave:
1. Volumi gestiti? (ticket totali, per canale, periodo)
2. Tempi di risposta e risoluzione? (SLA rispettati?)
3. Soddisfazione e qualità percepita? (CSAT, NPS, feedback se presenti)
4. Distribuzione carico operatori? (chi gestisce cosa, equilibri)
5. Aree di peggioramento o miglioramento nel tempo?`,
    context: `PROFILO UTENTE: Customer Care Specialist/Manager che monitora performance del servizio.

DATI ATTESI: ID ticket, data apertura/chiusura, canale (mail, chat, telefono), categoria/topic, operatore, stato, tempi di risposta, valutazione utente.

Se mancano alcune colonne, adatta l'analisi alle dimensioni disponibili.`,
    example: `Esempio parziale:

{
  "title": "Dashboard KPI · Customer Care",
  "period_analyzed": "Mar 2024 - Apr 2025",
  "executive_summary": "Nel periodo analizzato sono stati gestiti 1.245 ticket con tempo medio di prima risposta di 4h12m (SLA 4h: rispettato 78% volte). Il 62% arriva da mail, 28% chat, 10% telefono. La categoria 'fatturazione' rappresenta il 34% dei volumi con tempo di risoluzione più alto (2,1 giorni vs media 0,9)...",
  "sections": [
    {
      "title": "Volumi per canale · efficienza vs adozione",
      "narrative": "Mail resta il canale dominante (772 ticket, 62%) ma con tempi di risoluzione medi di 1,8 giorni contro i 28 minuti della chat. Il telefono è marginale (124 ticket) ma ha il CSAT più alto (4,6/5). Il gap di efficienza tra chat e mail è 67x — opportunità di riallocazione volumi enorme...",
      "chart": {
        "type": "donut",
        "x_axis": "Canale",
        "y_axis": "ID Ticket",
        "aggregation": "count",
        "group_by": null,
        "value_format": "integer",
        "sort": "value_desc",
        "limit": 5,
        "title": "Mail satura 62% volumi · chat solo 28% ma 67x più rapida",
        "subtitle": "Distribuzione canali · gap di efficienza significativo",
        "insight": "Sbilanciamento volumi-efficienza: opportunità di riallocazione",
        "logic": "donut perché 3 categorie con volumi nettamente diversi rendono leggibile la composizione",
        "highlight": {"indices": [0], "rationale": "La fetta principale è il punto del messaggio"}
      },
      "key_findings": ["62% volumi su mail con risoluzione 1,8gg", "Chat 28% volumi ma risoluzione 67x più rapida"]
    },
    {
      "title": "Tempi di risoluzione per categoria",
      "narrative": "Le categorie più frequenti hanno tempi di risoluzione molto disomogenei. Fatturazione (34% volumi) richiede 2,1 giorni medi — il triplo della media. Login (22% volumi) si risolve in 0,4 giorni. La somma del tempo operatore su Fatturazione è quindi 3x quello su Login nonostante volumi inferiori...",
      "chart": {
        "type": "horizontal_bar",
        "x_axis": "Tempo Medio Risoluzione",
        "y_axis": "Categoria",
        "aggregation": "mean",
        "group_by": null,
        "value_format": "decimal",
        "sort": "value_desc",
        "limit": 8,
        "title": "Fatturazione: 2,1 giorni medi · 5x rispetto a Login",
        "subtitle": "Tempo medio risoluzione (giorni) per categoria",
        "insight": "Fatturazione assorbe sproporzionatamente il tempo operatore",
        "logic": "horizontal_bar permette confronti chiari di durate con etichette categorie leggibili",
        "highlight": {"indices": [0], "rationale": "Il top del ranking è il punto del messaggio"}
      },
      "key_findings": ["Fatturazione = 5x tempo medio rispetto a Login", "Top 5 categorie coprono 78% volumi totali"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Spostare 30% volume mail su chat",
      "action": "Promuovere chat come canale primario nelle email automatiche e signature, target di shift +30% in 60 giorni con messaggi guida nei template di risposta.",
      "data_evidence": "Chat ha SLA risoluzione 67x più rapido a parità di FCR",
      "expected_impact": "Riduzione tempo medio risoluzione complessivo del 25%"
    }
  ],
  "data_quality_notes": ["8% ticket senza categoria assegnata — esclusi dalle analisi per categoria"]
}`
  },

  'customer_care_specialist__inbound_chat_mail': {
    scope: `Analizza i FLUSSI INBOUND (chat e mail) per ottimizzare gestione, staffing e tempi di risposta.

Risposte chiave:
1. Distribuzione temporale dei volumi? (orari di picco, giorni)
2. Mix di richieste? (categorie, frequenze, durate)
3. Tassi di abbandono o ritardi sistematici?
4. Capacità di risposta first-touch (FCR)?
5. Dove allocare risorse aggiuntive in base ai pattern?`,
    context: `PROFILO UTENTE: Customer Care Manager che ottimizza staffing e processi inbound.

DATI ATTESI: timestamp ricezione, canale, oggetto/categoria, tempo gestione, esito (risolto/escalation/abbandonato), operatore.

Identifica pattern temporali (ore, giorni della settimana) se i dati lo permettono. Cerca colli di bottiglia operativi.`,
    example: `Esempio parziale:

{
  "title": "Inbound Chat/Mail · Analisi Flussi",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "I picchi di traffico sono concentrati nel lunedì mattina (9-11) con 142 contatti medi vs media giornaliera di 87. Il canale chat ha FCR del 71% vs mail al 54%, ma la mail ha durata media 2,3 giorni contro gli 8 minuti della chat. Categoria 'reso' satura il giovedì con +40% volumi rispetto agli altri giorni...",
  "sections": [
    {
      "title": "Distribuzione temporale per giorno e canale",
      "narrative": "L'analisi evidenzia 3 fasce critiche: lunedì 9-11 (picco settimanale, +63% vs media), martedì-mercoledì 14-16 (picco pomeridiano, +28%), venerdì 16-18 (saturazione mail di settimana). Il sabato concentra solo il 4% dei volumi ma con tempi di risposta doppi (probabile sotto-organico). Mail dominante nei giorni infrasettimanali, chat con peso crescente nel weekend...",
      "chart": {
        "type": "grouped_bar",
        "x_axis": "Giorno settimana",
        "y_axis": ["Mail", "Chat"],
        "aggregation": "count",
        "group_by": "Canale",
        "value_format": "integer",
        "sort": "label_asc",
        "limit": 7,
        "title": "Lunedì 9-11 satura 18% dei volumi settimanali",
        "subtitle": "Volumi per giorno × canale · pattern settimanali stabili",
        "insight": "Sabato in sotto-presidio: 4% volumi ma tempi 2x rispetto ai feriali",
        "logic": "grouped_bar permette di confrontare sia il totale per giorno sia il mix di canali",
        "highlight": null
      },
      "key_findings": ["Lunedì 9-11 = 18% volumi settimanali", "Sabato sotto-presidio: tempi di risposta 2x"]
    },
    {
      "title": "Categorie di richiesta · mix e durata",
      "narrative": "Le 5 categorie principali coprono l'82% dei volumi. 'Fatturazione' è la più frequente (28%) ma anche la più lenta (2,1 giorni medi). 'Reso' ha picco anomalo il giovedì (+40% vs altri giorni) probabilmente legato ai cicli logistici. 'Login' e 'Info prodotto' sono velocemente risolvibili (<30 min) e candidate per chatbot...",
      "chart": {
        "type": "stacked_bar",
        "x_axis": "Giorno settimana",
        "y_axis": ["Fatturazione", "Reso", "Login", "Info prodotto", "Altro"],
        "aggregation": "count",
        "group_by": "Categoria",
        "value_format": "integer",
        "sort": "label_asc",
        "limit": 7,
        "title": "Reso esplode al giovedì: +40% vs media",
        "subtitle": "Composizione richieste per giorno · stagionalità marcata",
        "insight": "Pattern settimanali nelle categorie permettono staffing predittivo",
        "logic": "stacked_bar perché evidenzia sia il volume totale sia il mix di categorie per giorno",
        "highlight": null
      },
      "key_findings": ["Top 5 categorie = 82% volumi", "Reso giovedì: pattern logistico replicabile"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Riallocare staff sul lunedì 9-11",
      "action": "Spostare 2 operatori dal turno pomeridiano al mattino del lunedì per le prossime 4 settimane di test, con monitoraggio SLA giornaliero.",
      "data_evidence": "Lunedì 9-11 satura 18% volumi settimanali con SLA al 62%",
      "expected_impact": "Recupero SLA 80% e riduzione FCR drop nella fascia critica"
    }
  ],
  "data_quality_notes": ["12% record senza timestamp preciso — esclusi dall'analisi oraria"]
}`
  },

  'customer_care_specialist__troubleshooting_profiles': {
    scope: `Identifica PATTERN RICORRENTI nei problemi segnalati e crea profili di troubleshooting per ottimizzare la risoluzione.

Risposte chiave:
1. Quali problemi sono più frequenti? (top 10 categorie)
2. Quali combinazioni problema/cliente sono critiche?
3. Tempi e tassi di successo nella risoluzione per tipologia?
4. Trend nel tempo (problemi emergenti, in calo)?
5. Quali cluster di problemi suggeriscono root cause comuni?`,
    context: `PROFILO UTENTE: Customer Care che vuole ridurre il volume di ticket ricorrenti e migliorare i tempi di risoluzione.

DATI ATTESI: categoria problema, dettaglio/descrizione, prodotto coinvolto, stato risoluzione, tempo, numero interazioni, operatore.

Usa il clustering per identificare problemi simili categorizzati diversamente. Cerca root cause aggregate.`,
    example: `Esempio parziale:

{
  "title": "Troubleshooting Profiles · Analisi Problemi Ricorrenti",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "Le 5 categorie più frequenti coprono il 78% dei ticket: Login (22%), Fatturazione (18%), Configurazione (15%), Performance (13%), Bug (10%). L'analisi cluster identifica un macro-cluster 'Login + Configurazione' (31% del totale) con tempo di risoluzione doppio rispetto alla media (1,8gg vs 0,9), suggerendo un onboarding poco chiaro come root cause comune...",
  "sections": [
    {
      "title": "Top categorie · volumi vs tempo operatore",
      "narrative": "La categoria Login guida i volumi con 274 ticket (22%) ma tempo medio di 0,4 giorni — pattern chiaro di problemi rapidi ma frequenti. Fatturazione invece ha solo 224 ticket ma satura il tempo operatore con 2,1 giorni medi: il tempo operatore aggregato è il triplo di quello speso su Login. La matrice volume×durata permette di distinguere problemi 'quick wins' da problemi 'time sinks'...",
      "chart": {
        "type": "scatter",
        "x_axis": "Numero Ticket",
        "y_axis": "Tempo Medio Risoluzione",
        "aggregation": "mean",
        "group_by": "Categoria",
        "value_format": "decimal",
        "title": "Fatturazione: pochi ticket ma 3x tempo operatore",
        "subtitle": "Volumi × durata per categoria · identifica time sinks",
        "insight": "Quadrante alto-destra (Fatturazione) drena tempo: priorità di automazione",
        "logic": "scatter rivela il quadrante critico volume-durata dove ottimizzare",
        "highlight": null
      },
      "key_findings": ["Top 5 categorie = 78% volumi", "Fatturazione assorbe 3x tempo operatore vs Login"]
    },
    {
      "title": "Pareto delle categorie · concentrazione volumi",
      "narrative": "L'analisi Pareto sui ticket conferma che 5 categorie su 14 spiegano il 78% dei volumi. Le restanti 9 categorie sono code lunga di casistiche occasionali. Concentrare gli sforzi di knowledge base e automazione sulle top 5 produce massimo ritorno...",
      "chart": {
        "type": "bar",
        "x_axis": "Categoria",
        "y_axis": "Numero Ticket",
        "aggregation": "count",
        "group_by": null,
        "value_format": "integer",
        "sort": "value_desc",
        "limit": 14,
        "title": "Top 5 categorie coprono il 78% dei volumi",
        "subtitle": "Distribuzione ticket per categoria · pattern Pareto",
        "insight": "Code lunga di 9 categorie con volumi marginali (< 4% ciascuna)",
        "logic": "bar verticali ordinati per volume mostrano nettamente la concentrazione Pareto",
        "highlight": {"indices": [0], "rationale": "Il valore dominante è il punto del messaggio"}
      },
      "key_findings": ["5 categorie = 78% volumi totali", "9 categorie marginali sotto 4% ciascuna"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Tutorial onboarding video",
      "action": "Produrre 3 video tutorial (Login, primo accesso, prima configurazione) e mostrarli al primo login in app. Affiancare knowledge base ricercabile.",
      "data_evidence": "31% ticket in cluster onboarding-related",
      "expected_impact": "Riduzione 40% volumi cluster onboarding in 60 giorni"
    }
  ],
  "data_quality_notes": ["3% ticket senza categoria assegnata — esclusi dall'analisi"]
}`
  },

  'hr_specialist__produttivita': {
    scope: `Analizza la PRODUTTIVITÀ DEL PERSONALE per individuare pattern, eccellenze e gap a livello aggregato.

Risposte chiave:
1. Distribuzione della produttività individuale e di team?
2. Differenze tra reparti, sedi, ruoli?
3. Top performer e under-performer (in forma aggregata e anonima)?
4. Correlazioni tra anzianità, formazione, output?
5. Aree di intervento (formazione, processi, organizzazione)?`,
    context: `PROFILO UTENTE: HR Specialist/Manager che analizza la performance organizzativa.

DATI ATTESI: ID dipendente (anonimizzato), reparto, sede, ruolo, anzianità, ore lavorate, output prodotto.

ATTENZIONE — TONO RISPETTOSO:
- Ragiona SEMPRE per pattern aggregati, mai giudizi sulle persone
- NON menzionare nomi specifici nemmeno se presenti nei dati
- Usa categorie tipo "il top 10%", "i sotto-performer relativi", "la media reparto X"
- L'obiettivo è migliorare i processi, non valutare le persone`,
    example: `Esempio parziale (tono rispettoso, sempre aggregato, mai nomi):

{
  "title": "Analisi Produttività Personale",
  "period_analyzed": "Gen 2024 - Apr 2025",
  "executive_summary": "Il team di 87 risorse distribuite su 4 sedi mostra produttività media di 142 unità/persona/mese con coefficiente di variazione del 34%. La sede di Bologna performa il 22% sopra la media, mentre Catania mostra gap del -18% non correlato all'anzianità (r=0,12). L'analisi suggerisce variabili di processo o organizzazione più che di skill individuale...",
  "sections": [
    {
      "title": "Produttività media per sede",
      "narrative": "Bologna (24 risorse) presenta produttività media di 173 unità/mese, il 22% sopra la media aziendale. Catania (18 risorse) si attesta a 117 unità/mese, il 18% sotto. La distribuzione interna a Bologna è più stretta (CV 21%) suggerendo processi più standardizzati. Il gap non si correla con l'anzianità media delle sedi (Catania media 5,2 anni vs Bologna 5,8 anni)...",
      "chart": {
        "type": "horizontal_bar",
        "x_axis": "Produttività Media",
        "y_axis": "Sede",
        "aggregation": "mean",
        "group_by": null,
        "value_format": "integer",
        "sort": "value_desc",
        "limit": 6,
        "title": "Bologna 173 unità/mese · Catania 117 (gap del 47%)",
        "subtitle": "Produttività media aggregata · 4 sedi confrontate",
        "insight": "Gap tra sede top e sede in difficoltà non spiegato da anzianità",
        "logic": "horizontal_bar permette confronti chiari delle medie per sede con etichette leggibili",
        "highlight": {"indices": [0], "rationale": "Il top del ranking è il punto del messaggio"}
      },
      "key_findings": ["Bologna +22% vs media aziendale", "Gap Catania non correlato ad anzianità (r=0,12)"]
    },
    {
      "title": "Distribuzione produttività · top 10% e bottom 10%",
      "narrative": "L'analisi della distribuzione mostra che il top 10% del team produce in media 218 unità/mese (53% sopra la media) mentre il bottom 10% si attesta a 89 unità/mese. La differenza più significativa non è tra individui ma tra reparti: 'Operations' e 'Customer Success' rappresentano i 2 cluster con maggiore varianza interna. Il top 10% si concentra al 70% in Bologna...",
      "chart": {
        "type": "stacked_bar",
        "x_axis": "Reparto",
        "y_axis": ["Top 10%", "Fascia centrale", "Bottom 10%"],
        "aggregation": "count",
        "group_by": "Fascia performance",
        "value_format": "integer",
        "sort": "value_desc",
        "limit": 6,
        "title": "Operations: maggiore varianza interna tra reparti",
        "subtitle": "Composizione fasce performance per reparto · sempre aggregato",
        "insight": "Varianza interna Operations suggerisce eterogeneità di processi",
        "logic": "stacked_bar visualizza la composizione delle fasce di performance per reparto senza esporre individui",
        "highlight": null
      },
      "key_findings": ["Top 10% concentrato 70% in Bologna", "Operations e Customer Success: massima varianza interna"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Audit processi sede Catania",
      "action": "Settimana di osservazione operativa a Catania per mappare differenze di processo rispetto a Bologna, focus su task complessi e flussi standardizzati. Approccio collaborativo, non valutativo.",
      "data_evidence": "Gap produttività -18% non spiegato da skill o anzianità",
      "expected_impact": "Identificare 2-3 leve di miglioramento per chiudere 50% del gap in 6 mesi"
    }
  ],
  "data_quality_notes": ["Dataset sempre analizzato in forma aggregata, mai per singolo dipendente"]
}`
  },

  'hr_specialist__cv_profiling': {
    scope: `Profila il database CV (candidati o dipendenti) per supportare scelte di recruiting, formazione e organizzazione.

Risposte chiave:
1. Composizione del pool? (esperienza, skill, formazione)
2. Skill più rappresentate vs scarse?
3. Profili tipo che emergono dai dati (cluster)?
4. Gap di competenze rispetto a job target o esigenze interne?
5. Suggerimenti di sourcing aggiuntivo o formazione?`,
    context: `PROFILO UTENTE: HR Manager che gestisce un pool di CV o dipendenti.

DATI ATTESI: anni esperienza, settore precedente, livello, formazione, certificazioni, lingue, skill tecniche/soft.

ATTENZIONE — TONO NEUTRALE E NON DISCRIMINATORIO:
- NON menzionare mai genere, età, origine geografica, stato civile (anche se presenti nei dati)
- Concentrati su skill, esperienza, competenze, formazione
- Usa il clustering per identificare profili tipo
- Anonimizza sempre, ragiona per categorie`,
    example: `Esempio parziale (tono neutrale, focus su skill ed esperienza, mai discriminante):

{
  "title": "CV Profiling · Analisi Pool Candidati",
  "period_analyzed": "Pool aggiornato Apr 2025",
  "executive_summary": "I 245 CV analizzati mostrano una concentrazione su profili junior (62% con 0-3 anni esperienza) e un gap su senior con esperienza 8+ anni (solo 11%). L'analisi cluster identifica 4 profili tipo: 'Tech Junior con stack moderno' (38%), 'Marketing/Comm con esperienza media' (25%), 'Operations multi-skill' (22%), 'Senior generalisti' (15%). Skill di Data Analytics sotto-rappresentate (presenti solo nel 18%)...",
  "sections": [
    {
      "title": "Composizione del pool per fascia di esperienza",
      "narrative": "Il pool è marcatamente sbilanciato verso profili junior: 62% ha 0-3 anni di esperienza, 27% ha 4-7 anni, solo 11% supera gli 8 anni. Questo riflette il sourcing degli ultimi 12 mesi orientato all'ingresso. Per ruoli di lead/manager interno l'attingibilità è limitata: solo 27 CV potenzialmente in target...",
      "chart": {
        "type": "bar",
        "x_axis": "Fascia Esperienza",
        "y_axis": "ID CV",
        "aggregation": "count",
        "group_by": null,
        "value_format": "integer",
        "sort": "label_asc",
        "limit": 6,
        "title": "62% pool junior · solo 11% con 8+ anni",
        "subtitle": "Distribuzione fasce di esperienza · pool aggregato",
        "insight": "Sbilanciamento verso junior limita attingibilità per ruoli senior interni",
        "logic": "bar verticali per fasce ordinate cronologicamente mostrano lo squilibrio del pool",
        "highlight": {"indices": [0], "rationale": "Il valore dominante è il punto del messaggio"}
      },
      "key_findings": ["62% pool è 0-3 anni di esperienza", "Solo 27 CV con 8+ anni esperienza"]
    },
    {
      "title": "Skill tecniche · presenza nel pool",
      "narrative": "L'inventario skill mostra forte presenza di tecnologie 'main stream' (JavaScript 73%, SQL 61%, Excel avanzato 58%) e gap significativi su skill emergenti: Data Analytics avanzato 18%, Cloud/DevOps 22%, Machine Learning 8%. Per ruoli orientati al data il pool richiede formazione interna o sourcing dedicato. Skill 'soft' come problem solving e gestione progetti presenti nel 65% e 41% rispettivamente...",
      "chart": {
        "type": "horizontal_bar",
        "x_axis": "Presenza nel Pool",
        "y_axis": "Skill",
        "aggregation": "count",
        "group_by": null,
        "value_format": "percentage",
        "sort": "value_desc",
        "limit": 12,
        "title": "Data Analytics solo 18% · gap critico per ruoli data",
        "subtitle": "Penetrazione skill tecniche nel pool · top 12 confrontate",
        "insight": "Gap su skill data e cloud richiede strategia mista sourcing + formazione",
        "logic": "horizontal_bar per nomi skill lunghi e ranking immediato di copertura",
        "highlight": {"indices": [0], "rationale": "Il top del ranking è il punto del messaggio"}
      },
      "key_findings": ["Skill main-stream coperte (60-73%)", "Gap data/cloud/ML tra 8% e 22%"]
    }
  ],
  "recommendations": [
    {
      "priority": "alta",
      "title": "Sourcing dedicato profili senior + percorso formativo data",
      "action": "Attivare canale dedicato (referral employee, head hunter mirato) per profili 8+ anni nei prossimi 60 giorni. Parallelamente, lanciare percorso formativo Data Analytics interno per junior già in pool.",
      "data_evidence": "Solo 11% pool è senior vs target organizzazione del 25% · skill Data Analytics al 18%",
      "expected_impact": "Raddoppio pipeline senior entro Q3 · 30% pool con skill data entro Q4"
    }
  ],
  "data_quality_notes": ["Skill auto-dichiarate dai candidati — verificate con test in fase di colloquio"]
}`
  },

}
