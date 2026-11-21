"""Genera il dataset ipotetico di Lume AntiChurn (azienda fittizia, area Rimini).

Nessun dato reale: clienti, punti vendita, concorrenti e prezzi sono inventati.
Il churn e' simulato con un modello logistico noto, cosi' l'app ha un segnale da ritrovare.
"""
import numpy as np
import pandas as pd
from datetime import date, timedelta
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

rng = np.random.default_rng(2026)
RIF = date(2026, 10, 31)          # data dell'estrazione
INIZIO_FINESTRA = RIF - timedelta(days=365)
N = 3000
AZIENDA = "Azienda Demo"

# ---------------------------------------------------------------- territorio
def costa(lon):  # latitudine approssimata della linea di costa (Bellaria-Riccione)
    return 44.093 - 0.809 * (lon - 12.545)

def in_terra(lat, lon):
    return (lat < costa(lon) - 0.003) & (lat > 43.955) & (lon > 12.40) & (lon < 12.70)

COMUNI = [  # nome, cap, lat, lon (centri indicativi)
    ("Rimini", "47921", 44.055, 12.570), ("Riccione", "47838", 43.997, 12.645),
    ("Santarcangelo di Romagna", "47822", 44.063, 12.447), ("Bellaria-Igea Marina", "47814", 44.143, 12.470),
    ("Coriano", "47853", 43.968, 12.600), ("Verucchio", "47826", 43.983, 12.420),
]
CENTRI = [(44.058, 12.565, .018, .45), (44.085, 12.540, .010, .10), (43.997, 12.645, .010, .15),
          (44.063, 12.447, .009, .10), (44.140, 12.470, .008, .08), (44.030, 12.590, .015, .07)]

def punti(n, centri):
    out = []
    pesi = np.array([c[3] for c in centri]); pesi = pesi / pesi.sum()
    while len(out) < n:
        k = rng.choice(len(centri), p=pesi)
        la, lo, sd, _ = centri[k]
        lat, lon = rng.normal(la, sd), rng.normal(lo, sd * 1.35)
        if rng.random() < 0.08:  # quota diffusa nell'entroterra
            lat, lon = rng.uniform(43.96, 44.12), rng.uniform(12.41, 12.62)
        if in_terra(lat, lon):
            out.append((lat, lon))
    return np.array(out)

def comune_di(lat, lon):
    d = [(lat - c[2]) ** 2 + ((lon - c[3]) * 0.72) ** 2 for c in COMUNI]
    return COMUNI[int(np.argmin(d))]

def km(lat1, lon1, lat2, lon2):
    return np.hypot((lat1 - lat2) * 111.2, (lon1 - lon2) * 111.2 * np.cos(np.radians(44.05)))

# ---------------------------------------------------------------- punti vendita e concorrenti
PV = pd.DataFrame([
    ("PV01", f"{AZIENDA} · Rimini Centro", "Rimini", 44.0605, 12.5662),
    ("PV02", f"{AZIENDA} · Viserba", "Rimini", 44.0830, 12.5330),
    ("PV03", f"{AZIENDA} · Riccione", "Riccione", 43.9960, 12.6420),
    ("PV04", f"{AZIENDA} · Santarcangelo", "Santarcangelo di Romagna", 44.0630, 12.4480),
], columns=["id_punto", "nome", "comune", "lat", "lon"])

MARCHI = ["Concorrente Alfa", "Concorrente Beta", "Concorrente Gamma", "Concorrente Delta"]
TIPI = ["Sportello energia", "Negozio telefonia con luce e gas", "Agenzia"]
cp = punti(26, [(44.050, 12.575, .012, .55), (43.998, 12.648, .008, .2), (44.140, 12.470, .006, .1),
                (44.030, 12.600, .010, .15)])
CO = pd.DataFrame({
    "id_concorrente": [f"CO{i+1:02d}" for i in range(len(cp))],
    "marchio": rng.choice(MARCHI, len(cp), p=[.35, .3, .2, .15]),
    "tipo_punto": rng.choice(TIPI, len(cp), p=[.5, .35, .15]),
    "lat": cp[:, 0].round(5), "lon": cp[:, 1].round(5),
})
CO.insert(3, "comune", [comune_di(a, b)[0] for a, b in cp])

# ---------------------------------------------------------------- prodotti e prezzi di mercato
PRODOTTI = pd.DataFrame([
    ("Luce Fissa 12", "Luce", "Fisso", 0.138, "€/kWh", 9.0),
    ("Luce Variabile", "Luce", "Variabile", 0.129, "€/kWh", 9.0),
    ("Gas Fisso 12", "Gas", "Fisso", 0.540, "€/Smc", 11.0),
    ("Gas Variabile", "Gas", "Variabile", 0.495, "€/Smc", 11.0),
    ("Business Luce", "Luce", "Variabile", 0.124, "€/kWh", 24.0),
], columns=["prodotto", "categoria", "tipo_prezzo", "prezzo_unitario", "unita", "quota_fissa_mese"])

righe = []
for m, k in zip(MARCHI, [0.96, 1.02, 0.93, 1.05]):
    for _, p in PRODOTTI.iloc[:4].iterrows():
        righe.append((m, p.categoria, p.tipo_prezzo, round(p.prezzo_unitario * k * rng.uniform(.98, 1.02), 3),
                      p.unita, round(p.quota_fissa_mese * rng.uniform(.85, 1.15), 1), date(2026, 10, 15)))
PM = pd.DataFrame(righe, columns=["marchio", "categoria", "tipo_prezzo", "prezzo_unitario", "unita",
                                  "quota_fissa_mese", "data_rilevazione"])
media_mkt = PM.groupby(["categoria", "tipo_prezzo"]).prezzo_unitario.mean()

# ---------------------------------------------------------------- clienti
pos = punti(N, CENTRI)
lat, lon = pos[:, 0], pos[:, 1]
business = rng.random(N) < 0.14
prod = np.where(business, "Business Luce",
                rng.choice(PRODOTTI.prodotto.iloc[:4], N, p=[.30, .27, .23, .20]))
info = PRODOTTI.set_index("prodotto")
variabile = info.loc[prod, "tipo_prezzo"].values == "Variabile"
categoria = info.loc[prod, "categoria"].values

# anzianita': piu' clienti recenti
gg_att = np.clip(rng.exponential(3.2 * 365, N), 20, 10.5 * 365).astype(int)
att = np.array([RIF - timedelta(days=int(g)) for g in gg_att])
anni = gg_att / 365

fascia = np.where(business, "", rng.choice(["18-34", "35-54", "55-74", "75+"], N, p=[.17, .37, .33, .13]))
canale = rng.choice(["Sportello", "Agenzia", "Web", "Teleselling"], N, p=[.38, .24, .23, .15])
pagamento = rng.choice(["Domiciliazione", "Bollettino", "Carta"], N, p=[.55, .30, .15])
fattura_dig = rng.random(N) < np.where(fascia == "75+", .2, .55)
n_prod = np.where(rng.random(N) < np.where(business, .10, .32), 2, 1)
reclami = rng.poisson(0.35, N)
insoluti = np.where(rng.random(N) < .07, rng.gamma(2, 70, N).round(2), 0.0)
sconto = rng.choice([0, 5, 10], N, p=[.6, .25, .15])

ric_base = np.where(business, rng.gamma(6, 45, N), np.where(categoria == "Gas", rng.gamma(9, 7, N), rng.gamma(9, 6.5, N)))
ricavo = (ric_base * (1 + 0.45 * (n_prod == 2)) * (1 - sconto / 100)).round(2)
margine = (ricavo * rng.uniform(.08, .18, N)).round(2)

# prezzo rispetto al mercato (stessa categoria e tipo di prezzo)
mkt = np.array([media_mkt[(c, "Variabile" if v else "Fisso")] for c, v in zip(categoria, variabile)])
gap = (info.loc[prod, "prezzo_unitario"].values * (1 - sconto / 100) - mkt) / mkt

# distanze
d_co = np.min(km(lat[:, None], lon[:, None], CO.lat.values[None], CO.lon.values[None]), axis=1)
d_pv = np.min(km(lat[:, None], lon[:, None], PV.lat.values[None], PV.lon.values[None]), axis=1)

# giorni alla scadenza (solo prezzo fisso, rinnovo annuale)
scad_gg = np.where(variabile, np.nan, (365 - (gg_att % 365)).astype(float))

# ---- probabilita' di churn a 12 mesi (modello "vero", sconosciuto all'app)
logit = (-3.05 + 0.85 * variabile + 0.75 * (anni < 1) + 0.35 * ((anni >= 1) & (anni < 2))
         - 0.55 * (pagamento == "Domiciliazione") - 0.35 * fattura_dig + 0.45 * np.minimum(reclami, 4)
         + 0.80 * (insoluti > 0) + 4.0 * gap + 1.0 * np.exp(-d_co / 0.9) - 0.45 * np.exp(-d_pv / 1.2)
         - 0.55 * (n_prod == 2) + 0.40 * (fascia == "18-34") - 0.30 * (fascia == "75+")
         + 0.55 * (np.nan_to_num(scad_gg, nan=999) < 75) + 0.50 * (canale == "Teleselling")
         + 0.20 * (canale == "Web") - 0.20 * business)
p = 1 / (1 + np.exp(-logit))
churn = (rng.random(N) < p) & (gg_att > 45)

# data di cessazione dentro la finestra (dopo l'attivazione), vicino alla scadenza per i fissi
cess = []
for i in range(N):
    if not churn[i]:
        cess.append(None); continue
    primo = max(INIZIO_FINESTRA, att[i] + timedelta(days=30))
    span = (RIF - primo).days
    d = primo + timedelta(days=int(rng.integers(0, max(span, 1))))
    if not variabile[i] and rng.random() < .5:  # disdetta a ridosso del rinnovo
        anniv = att[i] + timedelta(days=365 * int(np.ceil((d - att[i]).days / 365)))
        d = min(max(anniv - timedelta(days=int(rng.integers(0, 45))), primo), RIF)
    cess.append(d)

# scadenza offerta: prossimo rinnovo dopo la fine del rapporto
fine = [c if c else RIF for c in cess]
scad = [None if variabile[i] else att[i] + timedelta(days=365 * int(np.ceil(((fine[i] - att[i]).days + 1) / 365)))
        for i in range(N)]

comuni = [comune_di(a, b) for a, b in zip(lat, lon)]
CL = pd.DataFrame({
    "id_cliente": [f"C{i+1:05d}" for i in range(N)],
    "data_attivazione": att, "data_cessazione": cess, "prodotto": prod, "ricavo_mensile": ricavo,
    "comune": [c[0] for c in comuni], "cap": [c[1] for c in comuni], "indirizzo": "", "civico": "",
    "lat": lat.round(5), "lon": lon.round(5),
    "tipo_cliente": np.where(business, "Business", "Privato"), "fascia_eta": fascia,
    "canale_acquisizione": canale, "sconto_pct": sconto, "data_scadenza_offerta": scad,
    "metodo_pagamento": pagamento, "fattura_digitale": np.where(fattura_dig, "Sì", "No"),
    "n_prodotti": n_prod, "n_reclami_12m": reclami, "insoluti_eur": insoluti, "margine_mensile": margine,
})
# qualche vuoto realistico nei campi facoltativi
for c, q in [("fascia_eta", .06), ("canale_acquisizione", .04), ("metodo_pagamento", .03), ("margine_mensile", .10)]:
    m = rng.random(N) < q
    CL[c] = CL[c].astype(object); CL.loc[m, c] = None
CL["indirizzo"] = None; CL["civico"] = None

# ---------------------------------------------------------------- controllo del segnale (non salvato)
CTRL = dict(churn_pct=float(churn.mean()), n_churn=int(churn.sum()),
            gap=pd.Series(gap).describe().round(3).to_dict())

# ---------------------------------------------------------------- Excel
ARIAL = "Arial"
INK, ACC, CREAM, LINE = "151412", "C2410C", "F3EFE7", "DCD5C9"
f_txt = Font(name=ARIAL, size=10, color=INK)
f_req = Font(name=ARIAL, size=10, bold=True, color="FFFFFF")
f_opt = Font(name=ARIAL, size=10, bold=True, color=INK)
fill_req = PatternFill("solid", fgColor=ACC)
fill_opt = PatternFill("solid", fgColor=CREAM)
bordo = Border(bottom=Side(style="thin", color=LINE))

OBBL = {"Clienti": ["id_cliente", "data_attivazione", "data_cessazione", "prodotto", "ricavo_mensile", "comune",
                    "cap", "indirizzo", "civico", "lat", "lon"],
        "Punti_vendita": ["id_punto", "nome", "comune", "lat", "lon"],
        "Concorrenti": ["id_concorrente", "marchio", "tipo_punto", "comune", "lat", "lon"],
        "Prodotti": ["prodotto", "categoria", "tipo_prezzo", "prezzo_unitario", "unita"],
        "Prezzi_mercato": ["marchio", "categoria", "tipo_prezzo", "prezzo_unitario", "unita", "data_rilevazione"]}

FORMATI = {"data_attivazione": "DD/MM/YYYY", "data_cessazione": "DD/MM/YYYY", "data_scadenza_offerta": "DD/MM/YYYY",
           "data_rilevazione": "DD/MM/YYYY", "ricavo_mensile": "#,##0.00", "margine_mensile": "#,##0.00",
           "insoluti_eur": "#,##0.00", "prezzo_unitario": "0.000", "quota_fissa_mese": "#,##0.00",
           "lat": "0.00000", "lon": "0.00000"}

wb = Workbook()
wb.remove(wb.active)

def foglio(nome, df):
    ws = wb.create_sheet(nome)
    for j, col in enumerate(df.columns, 1):
        c = ws.cell(row=1, column=j, value=col)
        req = col in OBBL.get(nome, [])
        c.font, c.fill = (f_req, fill_req) if req else (f_opt, fill_opt)
        c.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(j)].width = max(12, len(col) + 3)
    for i, row in enumerate(df.itertuples(index=False), 2):
        for j, v in enumerate(row, 1):
            if v is None or (isinstance(v, float) and np.isnan(v)) or v == "":
                continue
            if isinstance(v, np.generic):
                v = v.item()
            c = ws.cell(row=i, column=j, value=v)
            c.font = f_txt
            fmt = FORMATI.get(df.columns[j - 1])
            if fmt:
                c.number_format = fmt
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = ws.dimensions
    ws.row_dimensions[1].height = 20
    return ws

# Istruzioni
ws = wb.create_sheet("Istruzioni")
ws.column_dimensions["A"].width = 18; ws.column_dimensions["B"].width = 26
ws.column_dimensions["C"].width = 14; ws.column_dimensions["D"].width = 16; ws.column_dimensions["E"].width = 70
ws["A1"] = "Lume AntiChurn · dati ipotetici"; ws["A1"].font = Font(name=ARIAL, size=16, bold=True, color=INK)
ws["A2"] = (f"Azienda fittizia ({AZIENDA}), area di Rimini. Nessun dato reale. Data dell'estrazione: "
            f"{RIF.strftime('%d/%m/%Y')}. Una riga = un cliente.")
ws["A2"].font = Font(name=ARIAL, size=10, color="57524B")
ws["A4"] = "Legenda"; ws["A4"].font = Font(name=ARIAL, size=11, bold=True, color=INK)
ws["A5"] = "Obbligatorio"; ws["A5"].font, ws["A5"].fill = f_req, fill_req
ws["B5"] = "serve per scoring, personas o mappa"; ws["B5"].font = f_txt
ws["A6"] = "Facoltativo"; ws["A6"].font, ws["A6"].fill = f_opt, fill_opt
ws["B6"] = "migliora il modello; si può lasciare vuoto"; ws["B6"].font = f_txt
ws["A7"] = "Posizione"; ws["A7"].font = f_opt
ws["B7"] = "indirizzo + civico + cap oppure lat + lon (qui lat/lon)"; ws["B7"].font = f_txt

CAMPI = [
    ("Clienti", "id_cliente", "Sì", "testo", "codice anonimo: niente nomi o codici fiscali"),
    ("Clienti", "data_attivazione", "Sì", "data", "anzianità del cliente"),
    ("Clienti", "data_cessazione", "Sì", "data o vuoto", "vuoto = attivo; cessati negli ultimi 12 mesi = churn"),
    ("Clienti", "prodotto", "Sì", "testo", "deve esistere nel foglio Prodotti"),
    ("Clienti", "ricavo_mensile", "Sì", "€", "valore del cliente e valore a rischio"),
    ("Clienti", "comune, cap", "Sì", "testo", "mappa e confronti per zona"),
    ("Clienti", "indirizzo, civico / lat, lon", "Sì (uno dei due)", "testo / gradi", "posizione sulla mappa a esagoni"),
    ("Clienti", "tipo_cliente", "No", "Privato / Business", "segmentazione"),
    ("Clienti", "fascia_eta", "No", "18-34 … 75+", "personas e scoring (solo privati)"),
    ("Clienti", "canale_acquisizione", "No", "testo", "scoring"),
    ("Clienti", "sconto_pct", "No", "%", "prezzo effettivo contro mercato"),
    ("Clienti", "data_scadenza_offerta", "No", "data", "giorni al rinnovo (solo prezzo fisso)"),
    ("Clienti", "metodo_pagamento", "No", "testo", "scoring"),
    ("Clienti", "fattura_digitale", "No", "Sì / No", "scoring e personas"),
    ("Clienti", "n_prodotti", "No", "intero", "clienti con più prodotti"),
    ("Clienti", "n_reclami_12m", "No", "intero", "scoring"),
    ("Clienti", "insoluti_eur", "No", "€", "scoring"),
    ("Clienti", "margine_mensile", "No", "€", "margine a rischio"),
    ("Punti_vendita", "id_punto, nome, comune, lat, lon", "Sì", "", "la tua rete fisica"),
    ("Concorrenti", "marchio, tipo_punto, comune, lat, lon", "Sì", "", "rischio di passaggio a un concorrente vicino"),
    ("Prodotti", "prodotto, categoria, tipo_prezzo, prezzo_unitario, unita", "Sì", "", "i tuoi listini"),
    ("Prezzi_mercato", "marchio, categoria, tipo_prezzo, prezzo_unitario", "Sì", "", "confronto prezzi con i concorrenti"),
]
r0 = 9
for j, h in enumerate(["Foglio", "Campo", "Obbligatorio", "Formato", "A cosa serve"], 1):
    c = ws.cell(row=r0, column=j, value=h); c.font = f_opt; c.fill = fill_opt
for i, rr in enumerate(CAMPI, r0 + 1):
    for j, v in enumerate(rr, 1):
        c = ws.cell(row=i, column=j, value=v); c.font = f_txt; c.border = bordo
        c.alignment = Alignment(wrap_text=True, vertical="top")

foglio("Clienti", CL)
foglio("Punti_vendita", PV)
foglio("Concorrenti", CO)
foglio("Prodotti", PRODOTTI)
foglio("Prezzi_mercato", PM)

OUT = str(__import__("pathlib").Path(__file__).resolve().parents[1] / "dati" / "lume_antichurn_dati_demo.xlsx")
wb.save(OUT)
print(OUT, CTRL)
