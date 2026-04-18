# Lume · Guida Setup Completa
## Da file HTML a web app con auth, database e AI

---

## STRUTTURA FILE

```
lume-app/
├── index.html       ← pagina login/registrazione
├── app.html         ← la web app Lume (il file lume-pro.html rinominato)
├── api/
│   └── analyze.js   ← serverless function Claude (gira su Vercel)
├── database.sql     ← schema DB da eseguire su Supabase
└── README.md        ← questa guida
```

---

## STEP 1 · Crea account Supabase (10 min)

1. Vai su **supabase.com** → "Start your project" → crea account
2. "New project" → dai un nome (es. `lume`) → scegli password DB → regione Europe West
3. Aspetta 2 minuti che il progetto si avvii

### Configura il database

4. Nel menu sinistra: **SQL Editor** → "New query"
5. Copia e incolla tutto il contenuto di `database.sql`
6. Clicca "Run" — vedrai le tabelle create

### Prendi le credenziali

7. Menu sinistra: **Settings** → **API**
8. Copia questi due valori — ti servono dopo:
   - `Project URL` → es. `https://abcdefgh.supabase.co`
   - `anon public` key → stringa lunga

### Abilita Google Login (opzionale ma consigliato)

9. Menu sinistra: **Authentication** → **Providers** → **Google**
10. Segui la guida per creare OAuth credentials su Google Cloud Console
11. Incolla Client ID e Secret

---

## STEP 2 · Configura i file

### In `index.html`
Trova queste righe e sostituisci con i tuoi valori Supabase:

```javascript
const SUPABASE_URL = 'https://TUO-PROGETTO.supabase.co'  // ← il tuo Project URL
const SUPABASE_ANON_KEY = 'TUA-ANON-KEY'                  // ← la tua anon key
```

### In `app.html`
Stessa cosa — aggiungi le stesse credenziali Supabase all'inizio dello script.

---

## STEP 3 · Carica su GitHub (5 min)

1. Crea account su **github.com** se non ce l'hai
2. "New repository" → nome `lume-app` → Public → "Create"
3. Carica i file:
   - Clicca "uploading an existing file"
   - Trascina tutti i file della cartella `lume-app/`
   - "Commit changes"

---

## STEP 4 · Deploy su Vercel (5 min)

1. Vai su **vercel.com** → "Sign up with GitHub"
2. "Add New Project" → importa il repository `lume-app`
3. **IMPORTANTE** — prima di deployare, aggiungi la API key di Claude:
   - "Environment Variables" → aggiungi:
     ```
     Name:  ANTHROPIC_API_KEY
     Value: sk-ant-... (la tua key da console.anthropic.com)
     ```
4. Clicca "Deploy"

Vercel ti dà un URL tipo `lume-app.vercel.app` — la tua web app è live.

### Dominio personalizzato (opzionale)
- Vercel → Settings → Domains → aggiungi `lume.tuonome.it`
- Configura il DNS dal tuo registrar (Aruba, GoDaddy ecc.)

---

## STEP 5 · Come funziona il flusso completo

```
1. Utente va su lume-app.vercel.app
2. Vede index.html → si registra o accede
3. Supabase Auth crea il record in auth.users
4. Il trigger SQL crea automaticamente il profilo in profiles
5. Utente viene reindirizzato ad app.html
6. Carica il file Excel → risponde alle 2 domande (settore, ruolo, BU)
7. Il browser calcola statistiche descrittive
8. Chiama /api/analyze con i dati + profilo utente
9. La serverless function su Vercel chiama Claude API
10. Claude restituisce l'analisi SCOPE
11. Il risultato appare nell'interfaccia Lume
12. L'analisi viene salvata in Supabase (tabella analyses)
13. Al prossimo login l'utente ritrova lo storico
```

---

## COSTI

| Servizio   | Piano free include                  | Quando paghi          |
|------------|-------------------------------------|-----------------------|
| Supabase   | 500MB DB, 1GB storage, 50k utenti  | >50k utenti attivi    |
| Vercel     | 100GB bandwidth, deploy illimitati  | >100GB/mese           |
| GitHub     | Repository pubblici illimitati      | Mai per questo uso    |
| Anthropic  | Pay per use                         | ~$0.003 per analisi   |

**Costo stimato per 100 utenti attivi/mese: ~3-5€** (solo API Claude)

---

## VARIABILI D'AMBIENTE RICHIESTE SU VERCEL

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://....supabase.co        (opzionale se usi solo frontend)
SUPABASE_SERVICE_KEY=eyJ...                 (solo se il backend deve scrivere su DB)
```

---

## I PROMPT · Framework S.C.O.P.E.

### Dove stanno i prompt

Tutti i prompt sono in **`api/analyze.js`**, nell'oggetto `scopePrompts`.
Ogni chiamata all'API Claude è costruita secondo il framework S.C.O.P.E. —
non è solo il nome delle sezioni dell'output, ma la struttura interna di ogni prompt.

```
api/analyze.js
  └── scopePrompts = {
        S: `...`,   ← prompt per analisi Situazione
        C: `...`,   ← prompt per analisi Criticità
        O: `...`,   ← prompt per analisi Opportunità
        P: `...`,   ← prompt per analisi Priorità
        E: `...`,   ← prompt per analisi Esposizione rischio
      }
```

---

### Come è costruito ogni prompt secondo S.C.O.P.E.

Il framework S.C.O.P.E. definisce la **struttura interna di ogni prompt**
che scrivi per Claude. Non è l'output — è il modo in cui fai la domanda.

```
S – Scope       → Cosa vuoi ottenere esattamente
C – Context     → Chi è l'utente, che dati ha, in che settore lavora
O – Output      → Che formato deve avere la risposta
P – Parameters  → Vincoli: lunghezza, tono, stile, strumenti
E – Example     → Esempio di input/output atteso
```

**Esempio concreto — prompt attuale per sezione S (Situazione):**

```javascript
// S – Scope: descrivere il dataset e la sua qualità
// C – Context: settore + ruolo + BU vengono iniettati dinamicamente
// O – Output: testo discorsivo, non elenco puntato
// P – Parameters: max 150 parole, tono da consulente
// E – Example: implicito ("scrivi come un consulente che ha appena letto il file")

`Sei Lume, uno strumento di analisi dati AI per professionisti.
Analizza questo dataset per un utente che lavora in: ${settore} · ruolo: ${ruolo} · area: ${businessUnit}.
${tone}                          ← P: tono cambia in base al ruolo

DATI RICEVUTI:
${dataProfile}                   ← C + E: dati reali dell'utente come contesto

SEZIONE S — SITUAZIONE           ← S: scope specifico
Descrivi in modo chiaro e diretto:
1. Cosa contiene questo dataset
2. Qualità dei dati
3. Una frase di sintesi nel contesto aziendale

Rispondi in italiano. Massimo 150 parole.   ← P: parametri
Scrivi come un consulente che ha appena letto il file.`  ← O + E
```

---

### Come cambiano i prompt per settore / ruolo / business unit

Il prompt si adatta su **tre livelli** — ognuno modifica una parte diversa.

#### Livello 1 — Ruolo (modifica il tono `P`)

```javascript
// In api/analyze.js, oggetto toneMap
const toneMap = {
  'data_analyst':
    'Usa linguaggio tecnico, includi metriche precise e metodologie statistiche.',
  'middle_management':
    'Bilancia insight tecnici con implicazioni business. Sii concreto.',
  'team_leader':
    'Focalizzati su implicazioni operative e azioni per il team.',
  'sales_manager':
    'Prioritizza insight commerciali e azioni immediate sulle vendite.',
}
// Il tono viene iniettato in ogni prompt come variabile ${tone}
```

#### Livello 2 — Settore (modifica il contesto `C`)

Per ogni settore puoi aggiungere istruzioni specifiche nel prompt.
Esempio da implementare:

```javascript
const settoreContext = {
  'retail':
    'Il contesto è retail. Usa benchmark tipici del settore: scontrino medio, frequenza acquisto, rotazione stock.',
  'servizi':
    'Il contesto è B2B servizi. Focus su: ricavi ricorrenti, retention clienti, margini per progetto.',
  'consulenza':
    'Il contesto è consulenza. Focus su: utilization rate, pipeline, valore per cliente.',
}
// Da aggiungere in analyze.js e iniettare come ${settoreCtx} nel prompt
```

#### Livello 3 — Business Unit (modifica lo scope `S`)

La BU cambia *cosa* Claude deve cercare nei dati:

```javascript
const buScope = {
  'crm':
    'Cerca pattern su: retention, churn, frequenza contatti, segmentazione clienti.',
  'sales':
    'Cerca pattern su: conversion rate, pipeline velocity, performance per rep o area.',
  'finance':
    'Cerca pattern su: margini, variazioni budget vs actual, anomalie di costo.',
  'customer_care':
    'Cerca pattern su: volume ticket, tempi di risoluzione, soddisfazione, categorie ricorrenti.',
  'accounting':
    'Cerca pattern su: scaduti, DSO, concentrazione crediti, anomalie contabili.',
  'consulenza_fin':
    'Cerca pattern su: rendimenti, volatilità, correlazioni, distribuzione del rischio.',
}
// Da aggiungere in analyze.js e iniettare come ${buCtx} nel prompt
```

---

### Come modificare un prompt — istruzioni pratiche

1. Apri `api/analyze.js`
2. Trova l'oggetto `scopePrompts`
3. Modifica il testo del prompt che vuoi cambiare
4. Salva e fai push su GitHub → Vercel rideploya automaticamente in 30 secondi
5. Testa il nuovo output caricando un file di esempio

**Regola d'oro:** ogni modifica al prompt è un'iterazione del prodotto.
Testa sempre con dati reali e confronta l'output prima/dopo.

---

### Matrice prompt completa da sviluppare

Le combinazioni prioritarie da costruire (settore × BU):

| Settore     | BU            | Focus principale prompt              |
|-------------|---------------|--------------------------------------|
| Retail      | CRM           | Churn, RFM, segmentazione            |
| Retail      | Sales         | Sell-through, stagionalità, stock    |
| Servizi     | CRM           | Retention, lifetime value, pipeline  |
| Servizi     | Finance       | Margini per progetto, WIP            |
| Consulenza  | Sales         | Pipeline, win rate, valore offerte   |
| Consulenza  | Finance       | Parcellato, recupero crediti         |

Inizia dalle prime due — coprono la maggior parte dei casi reali.

---

## PROSSIMI PASSI SUGGERITI

1. **Onboarding**: dopo il primo login, mostra le 3 domande (settore/ruolo/BU) e salvale nel profilo
2. **Storico analisi**: pagina con lista delle analisi passate, cliccabili
3. **Export PDF**: bottone per scaricare l'analisi SCOPE come PDF
4. **Piano Pro**: integra Stripe per monetizzare (€9-19/mese)
