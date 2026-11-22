# Lume · AntiChurn

"Conosci i tuoi clienti": scoring del rischio di churn, customer personas e mappa a esagoni.
Login con Supabase (`index.html`), app in `app.html`. Tutti i calcoli girano nel browser: i dati dei clienti non vengono inviati a nessun server.

## File
- `app.html` · pagina dell'app (variabili, personas, scoring, mappa)
- `js/lume-ml.js` · modelli in JavaScript: regressione logistica, random forest, gradient boosting, k-means, AUC, lift
- `dati/lume_antichurn_dati_demo.xlsx` · dati ipotetici: 50.000 clienti in tutta Italia, 80% tra Roma, Milano e Napoli
- `dati/demo/lume_demo.json` · gli stessi dati in JSON compatto, caricati dal pulsante "Prova con i dati demo"
- `dati/demo/famiglie_h3r10.json` · famiglie simulate per lo strato "clienti potenziali" della demo (non sono dati ISTAT)
- `strumenti/istat_famiglie_h3.py` · famiglie ISTAT per sezione distribuite sui numeri civici ANNCSU, in celle H3 di risoluzione 10 (`dati/istat/h3r10/`)
- `dati/lume_antichurn_dati_demo_rimini.xlsx` · modello Excel da compilare (3.000 clienti, area di Rimini)
- `dati/istat/h3r10/` · famiglie per cella (generate con lo script sotto, una volta l'anno)
- `strumenti/genera_demo.py` · rigenera i dati demo (`--area italia` predefinita, `--area rimini`); richiede `geonamescache` e `global-land-mask`

## Famiglie ISTAT e numeri civici ANNCSU (una volta l'anno)
Servono, per ogni regione:
- da istat.it, "Basi territoriali e variabili censuarie": lo zip delle sezioni di censimento 2021 e il csv dei dati per sezione (popolazione residente e famiglie);
- da anncsu.gov.it, download massivo open data: i numeri civici con coordinate dei comuni della regione.

    pip install geopandas pyogrio h3 pandas pyproj
    python strumenti/istat_famiglie_h3.py --anno 2023 --regione R12_21.zip R12_dati.csv --civici anncsu_lazio.csv

Metodo: componenti per famiglia = popolazione ÷ famiglie per sezione; famiglie per civico = famiglie della sezione ÷ civici
della sezione; somma per cella H3 di risoluzione 10 (circa 0,015 km²). Le sezioni senza civici con coordinate si
distribuiscono per area. Escono file in `dati/istat/h3r10/`, da caricare su GitHub. L'app legge solo i riquadri dove
ci sono clienti e toglie i clienti attivi cella per cella, nel browser.
