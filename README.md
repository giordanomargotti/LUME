# Lume · AntiChurn

"Conosci i tuoi clienti": scoring del rischio di churn, customer personas e mappa a esagoni.
Login con Supabase (`index.html`), app in `app.html`. Tutti i calcoli girano nel browser: i dati dei clienti non vengono inviati a nessun server.

## File
- `app.html` · pagina dell'app (variabili, personas, scoring, mappa)
- `js/lume-ml.js` · modelli in JavaScript: regressione logistica, random forest, gradient boosting, k-means, AUC, lift
- `dati/lume_antichurn_dati_demo.xlsx` · dati ipotetici (10.000 clienti in tutta Italia) e modello Excel da compilare
- `dati/lume_antichurn_dati_demo_rimini.xlsx` · variante locale (3.000 clienti, area di Rimini)
- `dati/istat/h3r8/` · famiglie ISTAT per esagono (generate con lo script sotto)
- `strumenti/istat_famiglie_h3.py` · prepara le famiglie ISTAT per esagono, una volta l'anno per tutte le regioni
- `strumenti/genera_demo.py` · rigenera i dati demo (`--area italia` predefinita, `--area rimini`); richiede `geonamescache` e `global-land-mask`

## Famiglie ISTAT (una volta l'anno)
Da istat.it, "Basi territoriali e variabili censuarie": per ogni regione lo zip delle sezioni di censimento 2021
e il csv dei dati per sezione. Poi:

    pip install geopandas pyogrio h3 pandas
    python strumenti/istat_famiglie_h3.py --anno 2023 --regione R08_21.zip R08_dati.csv [--regione ...]

Escono file piccoli in `dati/istat/h3r8/`, da caricare su GitHub. L'app legge solo i riquadri dove ci sono clienti.
