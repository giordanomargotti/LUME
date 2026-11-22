"""Famiglie residenti per cella H3 (risoluzione 10, circa 0,015 km²), stimate sui numeri civici ANNCSU.

Da preparare una volta l'anno. I file prodotti non contengono dati dei clienti: la sottrazione dei
clienti attivi avviene nel browser, cella per cella.

Ingressi (scaricati a mano):
  1. confini delle sezioni di censimento (ISTAT, Basi territoriali 2021: zip con lo shapefile Rxx_21_WGS84)
  2. dati per sezione di censimento (ISTAT, csv con codice di sezione, popolazione residente, famiglie)
  3. numeri civici con coordinate (ANNCSU, download massivo open data: un csv per comune o per regione)

Metodo
  a. Componenti per famiglia di ogni sezione = popolazione ÷ famiglie. Se una sezione ha la popolazione
     ma non le famiglie, le famiglie si stimano con i componenti medi del comune (o con --componenti).
  b. Ogni numero civico con coordinate viene attribuito alla sezione in cui cade.
     Famiglie per civico = famiglie della sezione ÷ civici della sezione.
  c. Le famiglie dei civici si sommano nella cella H3 di risoluzione 10 che li contiene.
  d. Sezioni con famiglie ma senza civici georeferenziati: famiglie distribuite in modo uniforme sull'area
     della sezione (celle di risoluzione 9, attribuite alla cella centrale di risoluzione 10).
  I totali per sezione si conservano.

Uscita, nella cartella dell'app:
  dati/istat/h3r10/<riquadro>.json   {cella_h3_r10: famiglie} per ogni riquadro H3 di risoluzione 4
  dati/istat/h3r10/indice.json       riquadri disponibili, anno, fonte, quota di famiglie collocate sui civici

Uso:
  pip install geopandas pyogrio h3 pandas pyproj
  python strumenti/istat_famiglie_h3.py --anno 2023 \\
      --regione R12_21.zip R12_dati_sezioni.csv \\
      --civici anncsu_058091_roma.csv --civici anncsu_altri_comuni.csv
Le colonne si riconoscono da sole; se non le trova, lo script elenca quelle presenti
e si indicano con le opzioni --col-*. Coordinate dei civici in un sistema diverso da WGS84: --epsg-civici.
"""
import argparse, json, sys, zipfile, tempfile
from pathlib import Path
from collections import defaultdict
import numpy as np
import pandas as pd
import geopandas as gpd
import h3

R_CELLA, R_AREA, R_RIQUADRO = 10, 9, 4
CAND_SEZ = ["SEZ21_ID", "SEZ2021", "SEZ21", "SEZ_ID", "CODICE_SEZIONE", "SEZ"]
CAND_FAM = ["PF1", "FAMIGLIE", "F1", "N_FAMIGLIE", "TOT_FAMIGLIE"]
CAND_POP = ["P1", "POP_TOT", "POPOLAZIONE", "POP", "RESIDENTI"]
CAND_COM = ["PRO_COM", "PRO_COM_T", "COD_COMUNE", "CODICE_COMUNE", "COMUNE"]
CAND_LAT = ["LATITUDINE", "LAT", "LAT_WGS84", "COORD_Y", "Y", "COORDINATA_Y"]
CAND_LON = ["LONGITUDINE", "LON", "LONG", "LONG_WGS84", "LON_WGS84", "COORD_X", "X", "COORDINATA_X"]


def trova(colonne, candidati, nome, forzata, obbligatoria=True):
    su = {c.upper(): c for c in colonne}
    if forzata:
        if forzata not in colonne:
            sys.exit(f"Colonna {forzata} non trovata. Presenti: {', '.join(colonne)}")
        return forzata
    for c in candidati:
        if c in su:
            return su[c]
    if obbligatoria:
        sys.exit(f"Non trovo la colonna {nome}. Presenti: {', '.join(colonne)}. Indicala con --col-{nome}")
    return None


def leggi_csv(percorso):
    for enc in ("utf-8-sig", "latin-1"):
        for sep in (";", ",", "\t", "|"):
            try:
                d = pd.read_csv(percorso, sep=sep, dtype=str, encoding=enc, low_memory=False)
            except UnicodeDecodeError:
                break
            if d.shape[1] > 2:
                return d
    sys.exit(f"CSV non leggibile: {percorso}")


def numero(s):
    return pd.to_numeric(s.astype(str).str.strip().str.replace(",", ".", regex=False), errors="coerce")


def leggi_sezioni(percorso):
    p = Path(percorso)
    if p.suffix.lower() == ".zip":
        tmp = tempfile.mkdtemp()
        zipfile.ZipFile(p).extractall(tmp)
        shp = sorted(Path(tmp).rglob("*.shp"))
        if not shp:
            sys.exit("Nello zip non c'e' nessuno shapefile")
        p = shp[0]
    return gpd.read_file(p).to_crs(4326)


def celle_area(geom):
    """Celle di risoluzione 9 che coprono la sezione (almeno quella del punto interno)."""
    celle = set()
    for poli in getattr(geom, "geoms", [geom]):
        if poli.is_empty:
            continue
        esterno = [(y, x) for x, y in poli.exterior.coords]
        buchi = [[(y, x) for x, y in r.coords] for r in poli.interiors]
        celle |= set(h3.polygon_to_cells(h3.LatLngPoly(esterno, *buchi), R_AREA))
    if not celle:
        c = geom.representative_point()
        celle = {h3.latlng_to_cell(c.y, c.x, R_AREA)}
    return celle


def famiglie_per_sezione(g, d, x):
    cs_shp = trova(list(g.columns), CAND_SEZ, "sez-shp", x.col_sez_shp)
    cs = trova(list(d.columns), CAND_SEZ, "sez", x.col_sez)
    cf = trova(list(d.columns), CAND_FAM, "fam", x.col_fam, obbligatoria=False)
    cp = trova(list(d.columns), CAND_POP, "pop", x.col_pop, obbligatoria=False)
    cc = trova(list(d.columns), CAND_COM, "com", x.col_com, obbligatoria=False)
    if not cf and not cp:
        sys.exit("Servono le famiglie (es. PF1) o la popolazione residente (es. P1) per sezione")
    t = pd.DataFrame({"k": d[cs].str.strip().str.lstrip("0")})
    t["fam"] = numero(d[cf]) if cf else np.nan
    t["pop"] = numero(d[cp]) if cp else np.nan
    t["com"] = d[cc].str.strip() if cc else "tutti"
    ok = (t.fam > 0) & (t["pop"] > 0)
    t["componenti"] = np.where(ok, t["pop"] / t.fam, np.nan)
    comp_com = t[ok].groupby("com").apply(lambda z: z["pop"].sum() / z.fam.sum(), include_groups=False)
    comp_tot = t[ok]["pop"].sum() / t[ok].fam.sum() if ok.any() else x.componenti
    stima = t.fam.isna() & (t["pop"] > 0)
    if stima.any():
        comp = t.loc[stima, "com"].map(comp_com).fillna(x.componenti or comp_tot)
        if comp.isna().any():
            sys.exit("Sezioni senza famiglie e senza componenti medi: indica --componenti")
        t.loc[stima, "fam"] = t.loc[stima, "pop"] / comp
    t["fam"] = t.fam.fillna(0)
    g = g.copy()
    g["_k"] = g[cs_shp].astype(str).str.strip().str.lstrip("0")
    g["_fam"] = g["_k"].map(dict(zip(t.k, t.fam))).fillna(0)
    return g, comp_tot, int(stima.sum())


def leggi_civici(percorsi, x):
    parti = []
    for p in percorsi:
        d = leggi_csv(p)
        cla = trova(list(d.columns), CAND_LAT, "lat", x.col_lat)
        clo = trova(list(d.columns), CAND_LON, "lon", x.col_lon)
        c = pd.DataFrame({"lat": numero(d[cla]), "lon": numero(d[clo])}).dropna()
        print(f"{Path(p).name}: civici {len(d):,} · con coordinate {len(c):,}")
        parti.append(c)
    c = pd.concat(parti, ignore_index=True) if parti else pd.DataFrame(columns=["lat", "lon"])
    pts = gpd.GeoDataFrame(c, geometry=gpd.points_from_xy(c.lon, c.lat), crs=x.epsg_civici).to_crs(4326)
    pts["lat"], pts["lon"] = pts.geometry.y, pts.geometry.x
    return pts


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--regione", nargs=2, action="append", required=True, metavar=("SEZIONI", "DATI"))
    a.add_argument("--civici", action="append", default=[], help="csv ANNCSU con coordinate (ripetibile)")
    a.add_argument("--anno", default="2023")
    a.add_argument("--uscita", default=str(Path(__file__).resolve().parents[1] / "dati" / "istat" / "h3r10"))
    a.add_argument("--componenti", type=float, default=None, help="componenti medi per famiglia, se mancano le famiglie")
    a.add_argument("--epsg-civici", type=int, default=4326)
    for c in ("sez", "fam", "pop", "com", "sez-shp", "lat", "lon"):
        a.add_argument(f"--col-{c}")
    x = a.parse_args()

    civ = leggi_civici(x.civici, x)
    celle = defaultdict(float)
    fam_tot = fam_civ = 0.0
    for sez_path, dati_path in x.regione:
        g, comp, stimate = famiglie_per_sezione(leggi_sezioni(sez_path), leggi_csv(dati_path), x)
        g = g[g._fam > 0]
        print(f"{Path(sez_path).name}: sezioni con famiglie {len(g):,} · famiglie {g._fam.sum():,.0f} · "
              f"componenti medi {comp:.2f}" + (f" · famiglie stimate dalla popolazione in {stimate:,} sezioni" if stimate else ""))
        fam_tot += g._fam.sum()
        # b-c: famiglie sui civici della sezione
        if len(civ):
            j = gpd.sjoin(civ[["lat", "lon", "geometry"]], g[["_k", "_fam", "geometry"]], predicate="within", how="inner")
            j = j[~j.index.duplicated()]
            n = j.groupby("_k").size()
            j["quota"] = j["_fam"] / j["_k"].map(n)
            j["cella"] = [h3.latlng_to_cell(la, lo, R_CELLA) for la, lo in zip(j.lat, j.lon)]
            for c, f in j.groupby("cella")["quota"].sum().items():
                celle[c] += f
            con_civici = set(n.index)
            fam_civ += g[g._k.isin(con_civici)]._fam.sum()
        else:
            con_civici = set()
        # d: sezioni senza civici, distribuzione per area
        resto = g[~g._k.isin(con_civici)]
        for geom, f in zip(resto.geometry, resto._fam):
            if geom is None:
                continue
            ca = celle_area(geom)
            for c in ca:
                celle[h3.cell_to_center_child(c, R_CELLA)] += f / len(ca)

    riquadri = defaultdict(dict)
    for c, f in celle.items():
        if f >= 0.05:
            riquadri[h3.cell_to_parent(c, R_RIQUADRO)][c] = round(f, 1)
    out = Path(x.uscita); out.mkdir(parents=True, exist_ok=True)
    for vecchio in out.glob("*.json"):
        vecchio.unlink()
    for q, cc in riquadri.items():
        (out / f"{q}.json").write_text(json.dumps(cc, separators=(",", ":")))
    quota = fam_civ / fam_tot if fam_tot else 0
    ind = {"riquadri": sorted(riquadri), "anno": x.anno, "risoluzione": R_CELLA,
           "fonte": "ISTAT, famiglie per sezione di censimento (CC BY 4.0) · ANNCSU, numeri civici",
           "quota_su_civici": round(quota, 3)}
    (out / "indice.json").write_text(json.dumps(ind, indent=1))
    tot = sum(sum(c.values()) for c in riquadri.values())
    print(f"Celle: {sum(map(len, riquadri.values())):,} · riquadri: {len(riquadri)} · famiglie {tot:,.0f} su {fam_tot:,.0f} "
          f"· collocate sui civici: {quota:.0%} -> {out}")


if __name__ == "__main__":
    main()
