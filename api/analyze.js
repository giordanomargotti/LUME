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
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
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

    let jsonText = text.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim()
    }

    let parsed
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      console.error('Parse error. Raw:', text.slice(0, 500))
      return res.status(500).json({ error: 'Risposta AI non parsabile come JSON', raw: text.slice(0, 500) })
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
  "executive_summary": "string 80-120 parole",
  "kpi_cards": [
    { "label": "string", "value": "string formattato", "delta": "string o null", "trend": "up | down | flat", "comment": "string 1 frase" }
  ],
  "sections": [
    {
      "title": "string",
      "narrative": "string 100-180 parole con numeri reali",
      "chart": {
        "type": "bar | line | pie | scatter",
        "x_axis": "nome esatto colonna",
        "y_axis": "nome esatto colonna numerica",
        "aggregation": "sum | mean | count | median",
        "group_by": "nome colonna o null",
        "title": "string",
        "insight": "string 1 frase"
      },
      "key_findings": ["string", "string"]
    }
  ],
  "recommendations": [
    { "priority": "alta | media | bassa", "title": "string", "action": "string 30-60 parole", "data_evidence": "string", "expected_impact": "string" }
  ],
  "data_quality_notes": ["string"]
}

═══════════════════════════════════════════════════════════
P — PARAMETERS
═══════════════════════════════════════════════════════════

LINGUA: Esclusivamente italiano professionale. Niente anglicismi se non strettamente tecnici e diffusi.

TONO: Bilanciato — sintesi executive in apertura, dettagli operativi nelle sezioni. Adatto sia a uso operativo sia a condivisione con direzione.

NUMEROSITÀ:
- kpi_cards: 4 a 6
- sections: 3 a 5
- recommendations: 3 a 5

REGOLE NUMERI:
- Formato italiano: 1.000,50 (mai 1,000.50)
- Valuta sempre con simbolo €
- Percentuali con segno (+12,3% / -5,1%)
- Numeri grandi abbreviati: €1,72M, €847k

REGOLE GRAFICI:
- Massimo 1 grafico per sezione
- Usa SOLO colonne effettivamente esistenti
- Tipo grafico appropriato:
  · bar → confronti tra categorie
  · line → trend temporali
  · pie → distribuzioni con max 6 categorie
  · scatter → correlazioni tra 2 variabili numeriche

REGOLE CONTENUTO:
- Ogni numero citato deve essere verificabile dai dati forniti
- Niente cliché — solo insight specifici
- Le recommendations sono AZIONI, non principi generali
- Cita sempre la sezione/colonna su cui si basa l'insight
- Usa i risultati dell'analisi inferenziale per arricchire i commenti

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
    example: `Esempio parziale di output (per calibrare lo stile):

{
  "title": "Sales Reporting · Performance Commerciale",
  "executive_summary": "Le vendite del periodo Gen 2024-Apr 2025 hanno totalizzato €1,72M su 850 transazioni con un win rate del 83,5%. Il Nord-Ovest concentra il 38% del fatturato grazie a 3 venditori top performer, mentre il Sud sottoperforma con ticket medio (€1.850) inferiore del 35% alla media nazionale...",
  "sections": [
    {
      "title": "Performance per regione",
      "narrative": "Il Nord-Ovest concentra €654k (38% del totale) grazie a 3 venditori top performer. Il Sud sottoperforma con €198k nonostante 2 venditori attivi — il ticket medio (€1.850) è il più basso suggerendo problemi di mix prodotto più che di volume...",
      "chart": { "type": "bar", "x_axis": "Regione", "y_axis": "Importo Netto", "aggregation": "sum", "group_by": null, "title": "Fatturato per regione", "insight": "Concentrazione Nord-Ovest con gap di 3,3x verso il Sud" },
      "key_findings": ["Nord-Ovest genera 3,3x il Sud con stesso numero venditori", "Ticket medio Sud (€1.850) suggerisce mix prodotto inefficiente"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Riallineare mix prodotto Sud", "action": "Affiancare ai venditori Sud un sales coach per 4 settimane focalizzato sul cross-sell di prodotti a maggior valore.", "data_evidence": "Sud vende 78% Software Base e 0% Enterprise vs media nazionale 45/15%", "expected_impact": "Aumento ticket medio Sud da €1.850 a €2.400 in 3 mesi" }
  ]
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
  "executive_summary": "Su 10 venditori attivi, 3 generano il 47% del fatturato totale (€812k). La distribuzione è polarizzata con CV del 38%. Un venditore mostra volumi simili ai top (87 deal) ma fatturato dimezzato (€132k) per mix prodotto polarizzato su entry level...",
  "sections": [
    {
      "title": "Distribuzione output per venditore",
      "narrative": "Il top performer guida con €245k (14% del totale) e ticket medio €2.840, il 53% sopra la media. La fascia centrale (5 venditori) gestisce il 38% del fatturato. Due venditori mostrano gap del -45% rispetto alla media nonostante volumi paragonabili — l'analisi indica un mix prodotto sbilanciato su entry level...",
      "chart": { "type": "bar", "x_axis": "Venditore", "y_axis": "Importo Netto", "aggregation": "sum", "group_by": null, "title": "Fatturato per venditore", "insight": "Top 3 venditori generano il 47% del fatturato" },
      "key_findings": ["Top 3 venditori (30% headcount) producono 47% fatturato", "Un venditore ha volumi top ma ticket medio del 51% inferiore"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Cross-sell coaching mirato", "action": "Programma di affiancamento di 6 settimane tra venditore sotto-performante e top performer sul ciclo di vendita prodotti a maggior valore.", "data_evidence": "Il venditore vende 76% prodotti entry vs 42% del top performer", "expected_impact": "Allineamento ticket medio a €2.000 entro Q3" }
  ]
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
  "executive_summary": "I 320 clienti si distribuiscono in 3 cluster naturali: Big Spender Enterprise (15%, scontrino €4.200), PMI ricorrenti (52%, €1.400 alta frequenza), Spot Startup (33%, €890 bassa frequenza). L'80% del fatturato proviene dal 23% dei clienti — Pareto stretto che richiede focus su account management top...",
  "sections": [
    {
      "title": "Segmenti naturali nella base clienti",
      "narrative": "L'analisi cluster ha identificato 3 segmenti distinti per comportamento d'acquisto. Il segmento 'Big Spender Enterprise' genera il 41% del fatturato con scontrino medio €4.200 ma frequenza bassa (2,1 acquisti/anno). Le 'PMI ricorrenti' sono il cuore del business con frequenza elevata (5,8 acquisti/anno)...",
      "chart": { "type": "scatter", "x_axis": "Frequenza acquisti", "y_axis": "Importo medio", "aggregation": "mean", "group_by": "Tipo Cliente", "title": "Segmentazione clienti per frequenza e valore", "insight": "3 cluster con comportamenti d'acquisto nettamente distinti" },
      "key_findings": ["Big Spender = 15% clienti ma 41% fatturato", "PMI ricorrenti hanno frequenza 2,8x rispetto agli Enterprise"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Account management dedicato Top 50", "action": "Identificare i top 50 clienti per fatturato e assegnare un account manager dedicato con touchpoint mensile.", "data_evidence": "Top 50 generano €1,1M (64% fatturato totale)", "expected_impact": "Riduzione churn rate top 50 sotto 5% annuo" }
  ]
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
  "executive_summary": "La regressione su 16 mesi indica un trend di crescita del +3,2% mese su mese (R²=0,68). Estrapolando con questo modello, il prossimo trimestre dovrebbe attestarsi tra €420k (scenario prudente, -10%) e €510k (scenario ottimistico, +10%). Il modello cattura bene il trend ma non eventuali shock esterni o stagionalità inferiori ai 4 mesi...",
  "sections": [
    {
      "title": "Trend storico e proiezione",
      "narrative": "Il fatturato mensile è cresciuto da €78k (inizio periodo) a €112k (fine periodo) con regressione lineare di pendenza positiva. La R² di 0,68 indica un fit discreto ma con variabilità mese su mese del 18%. Q4 storicamente più forte (+22% vs media), suggerendo stagionalità da considerare nel forecast Q4 prossimo...",
      "chart": { "type": "line", "x_axis": "Data", "y_axis": "Importo Netto", "aggregation": "sum", "group_by": null, "title": "Trend mensile fatturato", "insight": "Crescita lineare con stagionalità Q4" },
      "key_findings": ["Trend +3,2% mensile (R²=0,68)", "Stagionalità Q4 con +22% vs media"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Validare forecast con sales meeting", "action": "Confrontare la previsione modello con le pipeline qualitative dei venditori prima di formalizzare i budget.", "data_evidence": "Pipeline non presenti nei dati — necessaria validazione bottom-up", "expected_impact": "Forecast più accurato con +/- 5% di scarto" }
  ]
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
  "executive_summary": "Nel periodo analizzato sono stati gestiti 1.245 ticket con tempo medio di prima risposta di 4h12m (SLA 4h: rispettato 78% volte). Il 62% arriva da mail, 28% chat, 10% telefono. La categoria 'fatturazione' rappresenta il 34% dei volumi con tempo di risoluzione più alto (2,1 giorni vs media 0,9)...",
  "sections": [
    {
      "title": "Volumi e canali",
      "narrative": "Mail resta il canale dominante (772 ticket, 62%) ma con tempi di risoluzione medi di 1,8 giorni contro i 28 minuti della chat. Il telefono è marginale (124 ticket) ma ha il CSAT più alto (4,6/5)...",
      "chart": { "type": "pie", "x_axis": "Canale", "y_axis": "ID Ticket", "aggregation": "count", "group_by": null, "title": "Distribuzione ticket per canale", "insight": "Mail satura il volume, chat è il più efficiente" },
      "key_findings": ["62% volumi su mail con risoluzione 1,8gg", "Chat 28% volumi ma risoluzione 67x più rapida"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Spostare 30% volume mail su chat", "action": "Promuovere chat come canale primario nelle email automatiche e signature, target di shift +30% in 60 giorni.", "data_evidence": "Chat ha SLA risoluzione 67x più rapido a parità di FCR", "expected_impact": "Riduzione tempo medio risoluzione complessivo del 25%" }
  ]
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
  "executive_summary": "I picchi di traffico sono concentrati nel lunedì mattina (9-11) con 142 contatti medi vs media giornaliera di 87. Il canale chat ha FCR del 71% vs mail al 54%, ma la mail ha durata media 2,3 giorni contro gli 8 minuti della chat. Categoria 'reso' satura il giovedì con +40% volumi rispetto agli altri giorni...",
  "sections": [
    {
      "title": "Distribuzione temporale dei volumi",
      "narrative": "L'analisi oraria evidenzia 3 fasce critiche: lunedì 9-11 (picco settimanale, +63% vs media), martedì-mercoledì 14-16 (picco pomeridiano, +28%), venerdì 16-18 (saturazione mail di settimana). Il sabato concentra solo il 4% dei volumi ma con tempi di risposta doppi (probabile sotto-organico)...",
      "chart": { "type": "bar", "x_axis": "Giorno settimana", "y_axis": "ID Ticket", "aggregation": "count", "group_by": "Canale", "title": "Volumi per giorno e canale", "insight": "Concentrazione lun mattina con sotto-presidio sab" },
      "key_findings": ["Lunedì 9-11 = 18% volumi settimanali", "Sabato sotto-presidio: tempi 2x"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Riallocare staff sul lunedì 9-11", "action": "Spostare 2 operatori dal turno pomeridiano al mattino del lunedì per le prossime 4 settimane di test.", "data_evidence": "Lunedì 9-11 satura 18% volumi settimanali con SLA al 62%", "expected_impact": "Recupero SLA 80% e riduzione FCR drop nella fascia critica" }
  ]
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
  "executive_summary": "Le 5 categorie più frequenti coprono il 78% dei ticket: Login (22%), Fatturazione (18%), Configurazione (15%), Performance (13%), Bug (10%). L'analisi cluster identifica un macro-cluster 'Login + Configurazione' (31% del totale) con tempo di risoluzione doppio rispetto alla media (1,8gg vs 0,9), suggerendo un onboarding poco chiaro come root cause comune...",
  "sections": [
    {
      "title": "Top categorie problemi",
      "narrative": "La categoria 'Login' guida i volumi con 274 ticket (22%) e tempo medio risoluzione di 0,4 giorni — pattern chiaro di problemi rapidi ma frequenti. Fatturazione invece ha solo 224 ticket ma satura il tempo operatore con 2,1 giorni medi: il tempo operatore aggregato è il triplo di quello speso su Login...",
      "chart": { "type": "bar", "x_axis": "Categoria", "y_axis": "Tempo Medio Risoluzione", "aggregation": "mean", "group_by": null, "title": "Tempo medio risoluzione per categoria", "insight": "Fatturazione assorbe 3x tempo operatore vs Login" },
      "key_findings": ["Top 5 categorie = 78% volumi", "Cluster Login+Config ha root cause comune (onboarding)"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Tutorial onboarding video", "action": "Produrre 3 video tutorial (Login, primo accesso, prima configurazione) e mostrarli al primo login in app.", "data_evidence": "31% ticket in cluster onboarding-related", "expected_impact": "Riduzione 40% volumi cluster onboarding in 60 giorni" }
  ]
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
    example: `Esempio parziale:

{
  "title": "Analisi Produttività Personale",
  "executive_summary": "Il team di 87 risorse distribuite su 4 sedi mostra produttività media di 142 unità/persona/mese con coefficiente di variazione del 34%. La sede di Bologna performa il 22% sopra la media, mentre Catania mostra gap del -18% non correlato all'anzianità (r=0,12). L'analisi suggerisce variabili di processo o organizzazione più che di skill individuale...",
  "sections": [
    {
      "title": "Performance per sede",
      "narrative": "Bologna (24 risorse) presenta produttività media di 173 unità/mese, il 22% sopra la media aziendale. Catania (18 risorse) si attesta a 117 unità/mese, il 18% sotto. La distribuzione interna a Bologna è più stretta (CV 21%) suggerendo processi più standardizzati...",
      "chart": { "type": "bar", "x_axis": "Sede", "y_axis": "Produttività", "aggregation": "mean", "group_by": null, "title": "Produttività media per sede", "insight": "Gap del 47% tra sede top e sede in difficoltà" },
      "key_findings": ["Bologna +22% vs media (CV interno 21%)", "Catania -18% non legato ad anzianità"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Audit processi sede Catania", "action": "Settimana di osservazione operativa a Catania per mappare differenze di processo rispetto a Bologna, focus su task complessi.", "data_evidence": "Gap produttività -18% non spiegato da skill o anzianità", "expected_impact": "Identificare 2-3 leve di miglioramento per chiudere 50% del gap in 6 mesi" }
  ]
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
    example: `Esempio parziale:

{
  "title": "CV Profiling · Analisi Pool Candidati",
  "executive_summary": "I 245 CV analizzati mostrano una concentrazione su profili junior (62% con 0-3 anni esperienza) e un gap su senior con esperienza 8+ anni (solo 11%). L'analisi cluster identifica 4 profili tipo: 'Tech Junior con stack moderno' (38%), 'Marketing/Comm con esperienza media' (25%), 'Operations multi-skill' (22%), 'Senior generalisti' (15%). Skill di Data Analytics sotto-rappresentate (presenti solo nel 18%)...",
  "sections": [
    {
      "title": "Composizione per esperienza",
      "narrative": "Il pool è marcatamente sbilanciato verso profili junior: 62% ha 0-3 anni di esperienza, 27% ha 4-7 anni, solo 11% supera gli 8 anni. Questo riflette il sourcing degli ultimi 12 mesi orientato all'ingresso. Per ruoli di lead/manager interno l'attingibilità è limitata: solo 27 CV potenzialmente in target...",
      "chart": { "type": "bar", "x_axis": "Anni Esperienza", "y_axis": "ID CV", "aggregation": "count", "group_by": null, "title": "Distribuzione esperienza", "insight": "Pool sbilanciato verso junior, gap su senior" },
      "key_findings": ["62% pool è junior 0-3 anni", "Solo 27 CV con 8+ anni esperienza"]
    }
  ],
  "recommendations": [
    { "priority": "alta", "title": "Sourcing dedicato profili senior", "action": "Attivare canale dedicato (referral employee, head hunter mirato) per profili 8+ anni nei prossimi 60 giorni.", "data_evidence": "Solo 11% pool è senior vs target organizzazione del 25%", "expected_impact": "Raddoppio pipeline senior entro Q3" }
  ]
}`
  },

}
