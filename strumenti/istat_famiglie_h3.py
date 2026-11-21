"""Famiglie ISTAT per esagono H3 (risoluzione 8), da preparare una volta l'anno per regione.

Ingresso (scaricati da istat.it, "Basi territoriali e variabili censuarie"):
  1. confini delle sezioni di censimento 2021 della regione (zip con lo shapefile Rxx_21_WGS84)
  2. dati per sezione di censimento della stessa regione (csv con il codice di sezione e le famiglie)

Uscita, nella cartella dell'app:
  dati/istat/h3r8/<riquadro>.json   {cella_h3_r8: famiglie} per ogni riquadro H3 di risoluzione 4
  dati/istat/h3r8/indice.json       elenco dei riquadri disponibili, anno e fonte

Metodo: le famiglie di ogni sezione sono distribuite in modo uniforme sulle celle H3 di risoluzione 9
che cadono nella sezione (sezioni piu' piccole di una cella: tutte nella cella del centroide), poi
sommate nella cella di risoluzione 8 che le contiene. I totali per sezione si conservano.

Uso:
  pip install geopandas pyogrio h3 pandas
  python strumenti/istat_famiglie_h3.py --anno 2023 \
      --regione R08_21.zip R08_dati_sezioni.csv \
      --regione R11_21.zip R11_dati_sezioni.csv      (una coppia per regione, fino a tutte le 20)
Ogni esecuzione ricalcola da zero tutti i riquadri: si lancia una volta l'anno con tutte le regioni.
Le colonne si riconoscono da sole; se non le trova, lo script elenca quelle presenti
e si indicano con --col-sez e --col-fam.
"""
import argparse, json, sys, zipfile, tempfile
from pathlib import Path
from collections import defaultdict
import pandas as pd
import geopandas as gpd
import h3

R_CALCOLO, R_ESAGONO, R_RIQUADRO = 9, 8, 4
CAND_SEZ = ["SEZ21_ID", "SEZ2021", "SEZ21", "SEZ_ID", "CODICE_SEZIONE"]
CAND_FAM = ["PF1", "FAMIGLIE", "F1", "N_FAMIGLIE", "TOT_FAMIGLIE"]


def trova(colonne, candidati, nome, forzata):
    if forzata:
        if forzata not in colonne:
            sys.exit(f"Colonna {forzata} non trovata. Presenti: {', '.join(colonne)}")
        return forzata
    for c in candidati:
        if c in colonne:
            return c
    sys.exit(f"Non trovo la colonna {nome}. Presenti: {', '.join(colonne)}. Indicala con --col-{nome}")


def leggi_sezioni(percorso):
    p = Path(percorso)
    if p.suffix.lower() == ".zip":
        tmp = tempfile.mkdtemp()
        zipfile.ZipFile(p).extractall(tmp)
        shp = sorted(Path(tmp).rglob("*.shp"))
        if not shp:
            sys.exit("Nello zip non c'e' nessuno shapefile")
        p = shp[0]
    g = gpd.read_file(p)
    return g.to_crs(4326)


def leggi_dati(percorso):
    for sep in (";", ",", "\t"):
        try:
            d = pd.read_csv(percorso, sep=sep, dtype=str, encoding="utf-8-sig")
            if d.shape[1] > 2:
                return d
        except UnicodeDecodeError:
            d = pd.read_csv(percorso, sep=sep, dtype=str, encoding="latin-1")
            if d.shape[1] > 2:
                return d
    sys.exit("CSV dei dati non leggibile")


def celle_della_sezione(geom):
    celle = set()
    parti = getattr(geom, "geoms", [geom])
    for poli in parti:
        if poli.is_empty:
            continue
        esterno = [(y, x) for x, y in poli.exterior.coords]
        buchi = [[(y, x) for x, y in r.coords] for r in poli.interiors]
        celle |= set(h3.polygon_to_cells(h3.LatLngPoly(esterno, *buchi), R_CALCOLO))
    if not celle:
        c = geom.representative_point()
        celle = {h3.latlng_to_cell(c.y, c.x, R_CALCOLO)}
    return celle


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--regione", nargs=2, action="append", required=True, metavar=("SEZIONI", "DATI"))
    a.add_argument("--anno", default="2021")
    a.add_argument("--uscita", default=str(Path(__file__).resolve().parents[1] / "dati" / "istat" / "h3r8"))
    a.add_argument("--col-sez"); a.add_argument("--col-fam")
    a.add_argument("--col-sez-shp")
    x = a.parse_args()

    esagoni = defaultdict(float)
    for sez_path, dati_path in x.regione:
        g = leggi_sezioni(sez_path)
        d = leggi_dati(dati_path)
        cs_shp = trova(list(g.columns), CAND_SEZ, "sez-shp", x.col_sez_shp)
        cs = trova(list(d.columns), CAND_SEZ, "sez", x.col_sez)
        cf = trova(list(d.columns), CAND_FAM, "fam", x.col_fam)
        fam = pd.to_numeric(d[cf].str.replace(",", "."), errors="coerce").fillna(0)
        fam_per_sez = dict(zip(d[cs].str.strip().str.lstrip("0"), fam))
        g["_k"] = g[cs_shp].astype(str).str.strip().str.lstrip("0")
        g["_fam"] = g["_k"].map(fam_per_sez).fillna(0)
        print(f"{Path(sez_path).name}: sezioni {len(g):,} · con famiglie {(g._fam > 0).sum():,} · famiglie {g._fam.sum():,.0f}")
        for i, (geom, f) in enumerate(zip(g.geometry, g._fam)):
            if f <= 0 or geom is None:
                continue
            celle = celle_della_sezione(geom)
            quota = f / len(celle)
            for c in celle:
                esagoni[h3.cell_to_parent(c, R_ESAGONO)] += quota
            if i and i % 5000 == 0:
                print(f"  {i:,} sezioni elaborate")

    riquadri = defaultdict(dict)
    for c, f in esagoni.items():
        if f >= 0.5:
            riquadri[h3.cell_to_parent(c, R_RIQUADRO)][c] = int(round(f))
    out = Path(x.uscita); out.mkdir(parents=True, exist_ok=True)
    for vecchio in out.glob("*.json"):
        vecchio.unlink()
    for q, celle in riquadri.items():
        (out / f"{q}.json").write_text(json.dumps(celle, separators=(",", ":")))
    ind = {"riquadri": sorted(riquadri), "anno": x.anno, "risoluzione": R_ESAGONO,
           "fonte": "ISTAT, famiglie per sezione di censimento (CC BY 4.0)"}
    (out / "indice.json").write_text(json.dumps(ind, indent=1))
    tot = sum(sum(c.values()) for c in riquadri.values())
    print(f"Esagoni: {len(esagoni):,} · riquadri: {len(riquadri)} · famiglie assegnate: {tot:,} -> {out}")


if __name__ == "__main__":
    main()
