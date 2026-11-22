/* Lume ML — modelli e metriche in JavaScript puro, eseguiti nel browser.
   I dati dei clienti non lasciano mai il computer dell'utente.
   Contiene: preparazione dati, regressione logistica, random forest, gradient boosting,
   k-means, AUC / ROC / lift, importanza delle variabili. Funziona anche in node (test). */
(function (root) {
  'use strict'

  // ───────────────────────── utilità
  function rng(seed) {                       // mulberry32: casuale ma ripetibile
    let a = seed >>> 0
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))))
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1)
  function quantile(a, q) {
    const s = a.filter(v => v != null && !isNaN(v)).sort((x, y) => x - y)
    if (!s.length) return NaN
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)
  }
  const median = a => quantile(a, 0.5)

  // ───────────────────────── date e distanze
  function aData(v) {
    if (v == null || v === '') return null
    if (v instanceof Date) return isNaN(v) ? null : v
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)) // seriale Excel
    const s = String(v).trim()
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/)
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]))
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    return null
  }
  const giorni = (a, b) => (a - b) / 86400000
  function km(lat1, lon1, lat2, lon2) {      // equirettangolare: sufficiente sotto i 50 km
    const k = 111.2, c = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
    return Math.hypot((lat1 - lat2) * k, (lon1 - lon2) * k * c)
  }
  function piuVicino(lat, lon, punti) {
    let best = Infinity, idx = -1
    for (let i = 0; i < punti.length; i++) {
      const d = km(lat, lon, punti[i].lat, punti[i].lon)
      if (d < best) { best = d; idx = i }
    }
    return { km: best, idx }
  }
  // indice a griglia per cercare il punto piu' vicino senza confrontare tutti i punti (molti clienti, molti concorrenti)
  function indiceVicini(punti, passo = 0.1) {
    if (punti.length < 150) return (lat, lon) => piuVicino(lat, lon, punti)
    const G = new Map(), chiave = (i, j) => i * 100000 + j
    punti.forEach((p, n) => { const k = chiave(Math.floor(p.lat / passo), Math.floor(p.lon / passo)); if (!G.has(k)) G.set(k, []); G.get(k).push(n) })
    return (lat, lon) => {
      const i0 = Math.floor(lat / passo), j0 = Math.floor(lon / passo), passoKm = passo * 111.2 * Math.cos(lat * Math.PI / 180)
      let best = Infinity, idx = -1
      for (let r = 0; r < 60; r++) {
        for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue
          const L = G.get(chiave(i, j)); if (!L) continue
          for (const n of L) { const d = km(lat, lon, punti[n].lat, punti[n].lon); if (d < best) { best = d; idx = n } }
        }
        if (idx >= 0 && best <= r * passoKm) return { km: best, idx }
      }
      return piuVicino(lat, lon, punti)
    }
  }
  const num = v => { if (v == null || v === '') return null; const x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isNaN(x) ? null : x }
  const si = v => /^(s[iì]|y|yes|true|1|x)$/i.test(String(v ?? '').trim())

  // ───────────────────────── preparazione: dai fogli Excel al dataset per cliente
  // Ritorna righe arricchite, matrice X delle variabili, etichetta y e descrizione delle variabili.
  function prepara(fogli, opz = {}) {
    const C = fogli.Clienti || []
    const prodotti = fogli.Prodotti || [], mercato = fogli.Prezzi_mercato || []
    const pv = (fogli.Punti_vendita || []).map(p => ({ ...p, lat: num(p.lat), lon: num(p.lon) })).filter(p => p.lat != null)
    const co = (fogli.Concorrenti || []).map(p => ({ ...p, lat: num(p.lat), lon: num(p.lon) })).filter(p => p.lat != null)
    const vicinoCo = indiceVicini(co), vicinoPv = indiceVicini(pv)
    const finestraMesi = opz.finestraMesi || 12

    // data di riferimento = data piu' recente presente nel file (estrazione)
    let rif = opz.dataRif ? aData(opz.dataRif) : null
    if (!rif) {
      let max = 0
      for (const r of C) for (const k of ['data_attivazione', 'data_cessazione']) { const d = aData(r[k]); if (d && d > max) max = d }
      rif = max ? new Date(max) : new Date()
    }
    const inizio = new Date(rif); inizio.setUTCMonth(inizio.getUTCMonth() - finestraMesi)

    // prezzi di mercato medi per categoria e tipo di prezzo
    const mkt = {}
    for (const m of mercato) {
      const k = `${m.categoria}|${m.tipo_prezzo}`, p = num(m.prezzo_unitario)
      if (p == null) continue
      ;(mkt[k] = mkt[k] || []).push(p)
    }
    const prod = {}
    for (const p of prodotti) prod[p.prodotto] = p

    const righe = []
    let esclusi = 0
    for (const r of C) {
      const att = aData(r.data_attivazione), ces = aData(r.data_cessazione)
      if (!att) { esclusi++; continue }
      if (ces && ces < inizio) { esclusi++; continue }       // cessati prima della finestra: fuori perimetro
      const fine = ces || rif
      const o = { ...r, _att: att, _ces: ces, churn: ces ? 1 : 0 }
      o.anzianita_anni = giorni(fine, att) / 365
      o.ricavo = num(r.ricavo_mensile)
      o.margine = num(r.margine_mensile)
      const sc = aData(r.data_scadenza_offerta)
      o.giorni_scadenza = sc ? giorni(sc, fine) : null
      const p = prod[r.prodotto]
      o.categoria = p ? p.categoria : null
      o.prezzo_variabile = p ? (/variab/i.test(p.tipo_prezzo) ? 1 : 0) : null
      if (p && mkt[`${p.categoria}|${p.tipo_prezzo}`]) {
        const eff = num(p.prezzo_unitario) * (1 - (num(r.sconto_pct) || 0) / 100)
        const m = mean(mkt[`${p.categoria}|${p.tipo_prezzo}`])
        o.gap_prezzo = (eff - m) / m * 100
      } else o.gap_prezzo = null
      o.lat = num(r.lat); o.lon = num(r.lon)
      if (o.lat != null && o.lon != null) {
        if (co.length) { const v = vicinoCo(o.lat, o.lon); o.dist_concorrente = v.km; o.concorrente = co[v.idx] }
        if (pv.length) { const v = vicinoPv(o.lat, o.lon); o.dist_punto = v.km; o.punto = pv[v.idx] }
      }
      righe.push(o)
    }

    // definizione delle variabili candidate (usate solo se presenti e non costanti)
    const def = [
      { k: 'anzianita_anni', l: 'Anzianità (anni)', f: o => o.anzianita_anni },
      { k: 'ricavo', l: 'Ricavo mensile (€)', f: o => o.ricavo },
      { k: 'prezzo_variabile', l: 'Prezzo variabile', f: o => o.prezzo_variabile, bin: 1 },
      { k: 'gap_prezzo', l: 'Prezzo vs mercato (%)', f: o => o.gap_prezzo },
      { k: 'sconto', l: 'Sconto (%)', f: o => num(o.sconto_pct) },
      { k: 'giorni_scadenza', l: 'Giorni al rinnovo', f: o => o.giorni_scadenza },
      { k: 'n_prodotti', l: 'N. prodotti', f: o => num(o.n_prodotti) },
      { k: 'reclami', l: 'Reclami 12 mesi', f: o => num(o.n_reclami_12m) },
      { k: 'ticket', l: 'Ticket assistenza 12 mesi', f: o => num(o.n_ticket_12m) },
      { k: 'cambi_prodotto', l: 'Cambi di prodotto', f: o => num(o.n_cambi_prodotto) },
      { k: 'rettifiche', l: 'Fatture rettificate 12 mesi', f: o => num(o.n_fatture_rettificate_12m) },
      { k: 'insoluti', l: 'Ha insoluti', f: o => o.insoluti_eur == null || o.insoluti_eur === '' ? null : (num(o.insoluti_eur) > 0 ? 1 : 0), bin: 1 },
      { k: 'solleciti', l: 'Solleciti 12 mesi', f: o => num(o.n_solleciti_12m) },
      { k: 'var_consumo', l: 'Variazione consumo (%)', f: o => num(o.var_consumo_pct) },
      { k: 'nps', l: 'Voto NPS', f: o => num(o.voto_nps), minQuota: 0.2 },   // risponde solo una parte dei clienti
      { k: 'digitale', l: 'Fattura digitale', f: o => o.fattura_digitale == null || o.fattura_digitale === '' ? null : (si(o.fattura_digitale) ? 1 : 0), bin: 1 },
      { k: 'area_web', l: 'Area clienti web', f: o => o.area_clienti_web == null || o.area_clienti_web === '' ? null : (si(o.area_clienti_web) ? 1 : 0), bin: 1 },
      { k: 'consenso', l: 'Consenso marketing', f: o => o.consenso_marketing == null || o.consenso_marketing === '' ? null : (si(o.consenso_marketing) ? 1 : 0), bin: 1 },
      { k: 'domiciliato', l: 'Pagamento domiciliato', f: o => o.metodo_pagamento == null || o.metodo_pagamento === '' ? null : (/domicil/i.test(o.metodo_pagamento) ? 1 : 0), bin: 1 },
      { k: 'business', l: 'Cliente business', f: o => o.tipo_cliente == null || o.tipo_cliente === '' ? null : (/business|azienda|impresa/i.test(o.tipo_cliente) ? 1 : 0), bin: 1 },
      { k: 'dist_concorrente', l: 'Distanza concorrente (km)', f: o => o.dist_concorrente ?? null },
      { k: 'dist_punto', l: 'Distanza tuo punto (km)', f: o => o.dist_punto ?? null },
    ]
    const cat = [
      { k: 'fascia_eta', l: 'Età' },
      { k: 'canale_acquisizione', l: 'Canale' },
    ]
    const cols = [], X = righe.map(() => [])
    const conGap = righe.some(o => o.gap_prezzo != null)
    for (const d of def) {
      if (d.k === 'sconto' && conGap) continue          // lo sconto e' gia' dentro lo scarto di prezzo
      const v = righe.map(d.f)
      const ok = v.filter(x => x != null && !isNaN(x))
      if (ok.length < righe.length * (d.minQuota ?? 0.5) || new Set(ok).size < 2) continue
      const med = median(ok)
      const manca = v.some(x => x == null || isNaN(x))
      v.forEach((x, i) => X[i].push(x == null || isNaN(x) ? (d.k === 'giorni_scadenza' ? 365 : med) : x))
      cols.push({ k: d.k, l: d.l, tipo: d.bin ? 'binaria' : 'numerica' })
      if (manca && d.k !== 'giorni_scadenza') {
        v.forEach((x, i) => X[i].push(x == null || isNaN(x) ? 1 : 0))
        cols.push({ k: d.k + '_mancante', l: d.l + ' mancante', tipo: 'binaria' })
      }
    }
    for (const c of cat) {
      const v = righe.map(o => (o[c.k] == null || o[c.k] === '') ? 'ND' : String(o[c.k]))
      const freq = {}; v.forEach(x => freq[x] = (freq[x] || 0) + 1)
      const livelli = Object.keys(freq).sort((a, b) => freq[b] - freq[a])
      if (livelli.length < 2) continue
      for (const lv of livelli.slice(1)) {        // il livello piu' frequente fa da riferimento
        if (freq[lv] < 20) continue
        v.forEach((x, i) => X[i].push(x === lv ? 1 : 0))
        cols.push({ k: `${c.k}=${lv}`, l: `${c.l}: ${lv === 'ND' ? 'non indicato' : lv}`, tipo: 'binaria', rif: livelli[0] })
      }
    }
    return { righe, X, y: righe.map(o => o.churn), cols, rif, inizio, esclusi, pv, co }
  }

  // ───────────────────────── divisione addestramento / verifica (stratificata)
  function dividi(y, quota = 0.7, seed = 42) {
    const r = rng(seed), tr = [], te = []
    for (const cl of [0, 1]) {
      const idx = y.map((v, i) => v === cl ? i : -1).filter(i => i >= 0)
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[idx[i], idx[j]] = [idx[j], idx[i]] }
      const n = Math.round(idx.length * quota)
      for (let i = 0; i < idx.length; i++) (i < n ? tr : te).push(idx[i])
    }
    return { tr, te }
  }
  const pesiBilanciati = y => {             // ogni classe pesa la meta' (come un campione 50/50)
    const n1 = y.reduce((s, v) => s + v, 0), n0 = y.length - n1
    return y.map(v => v ? y.length / (2 * n1) : y.length / (2 * n0))
  }

  // ───────────────────────── regressione logistica (Newton con piccola penalita' L2)
  function logistica(X, y, w, { l2 = 1, iter = 30 } = {}) {
    const n = X.length, p = X[0].length
    const mu = [], sd = []
    for (let j = 0; j < p; j++) {
      const c = X.map(r => r[j]); mu[j] = mean(c)
      sd[j] = Math.sqrt(mean(c.map(v => (v - mu[j]) ** 2))) || 1
    }
    const Z = X.map(r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])])
    let b = new Array(p + 1).fill(0)
    for (let it = 0; it < iter; it++) {
      const g = new Array(p + 1).fill(0), H = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0))
      for (let i = 0; i < n; i++) {
        const z = Z[i]; let eta = 0
        for (let j = 0; j <= p; j++) eta += b[j] * z[j]
        const pr = sigmoid(eta), wi = w[i], r = wi * (y[i] - pr), h = wi * pr * (1 - pr)
        for (let j = 0; j <= p; j++) {
          g[j] += r * z[j]
          const hz = h * z[j]
          for (let k = j; k <= p; k++) H[j][k] += hz * z[k]
        }
      }
      for (let j = 0; j <= p; j++) { for (let k = 0; k < j; k++) H[j][k] = H[k][j]; if (j) { H[j][j] += l2; g[j] -= l2 * b[j] } }
      const d = risolvi(H, g)
      let mx = 0
      for (let j = 0; j <= p; j++) { b[j] += d[j]; mx = Math.max(mx, Math.abs(d[j])) }
      if (mx < 1e-6) break
    }
    const coef = b.slice(1).map((v, j) => v / sd[j])     // per unita' originale
    return {
      nome: 'Regressione logistica', b, mu, sd, coef,
      prob: x => { let e = b[0]; for (let j = 0; j < p; j++) e += b[j + 1] * (x[j] - mu[j]) / sd[j]; return sigmoid(e) },
    }
  }
  function risolvi(A, bv) {                  // eliminazione di Gauss con pivot parziale
    const n = bv.length, M = A.map((r, i) => [...r, bv[i]])
    for (let c = 0; c < n; c++) {
      let piv = c
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
      ;[M[c], M[piv]] = [M[piv], M[c]]
      const d = M[c][c] || 1e-12
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / d
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
      }
    }
    const x = new Array(n).fill(0)
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n]
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
      x[r] = s / (M[r][r] || 1e-12)
    }
    return x
  }

  // ───────────────────────── alberi a istogrammi (base di random forest e gradient boosting)
  function binner(X, nb = 32) {
    const p = X[0].length, soglie = []
    for (let j = 0; j < p; j++) {
      const s = [...new Set(X.map(r => r[j]))].sort((a, b) => a - b)
      if (s.length <= nb) soglie.push(s.slice(0, -1).map((v, i) => (v + s[i + 1]) / 2))
      else {
        const t = []
        for (let q = 1; q < nb; q++) t.push(quantile(s, q / nb))
        soglie.push([...new Set(t)])
      }
    }
    const bin = (j, v) => { const t = soglie[j]; let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v > t[m]) lo = m + 1; else hi = m } return lo }
    const B = X.map(r => r.map((v, j) => bin(j, v)))
    return { soglie, B, bin }
  }
  // albero di Newton: g = gradienti, h = hessiane; foglia = -G/(H+lambda)
  function albero(B, idx, g, h, nbin, { profondita = 3, minFoglia = 10, lambda = 1, mtry = null, r = Math.random } = {}) {
    const p = B[0].length
    function costruisci(ids, d) {
      let G = 0, H = 0
      for (const i of ids) { G += g[i]; H += h[i] }
      const foglia = { v: -G / (H + lambda) }
      if (d >= profondita || ids.length < 2 * minFoglia) return foglia
      let feats = [...Array(p).keys()]
      if (mtry && mtry < p) { for (let i = p - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[feats[i], feats[j]] = [feats[j], feats[i]] } feats = feats.slice(0, mtry) }
      const base = G * G / (H + lambda)
      let best = { gain: 1e-9 }
      for (const j of feats) {
        const nb = nbin[j] + 1, GG = new Float64Array(nb), HH = new Float64Array(nb), NN = new Int32Array(nb)
        for (const i of ids) { const b = B[i][j]; GG[b] += g[i]; HH[b] += h[i]; NN[b]++ }
        let gl = 0, hl = 0, nl = 0
        for (let b = 0; b < nb - 1; b++) {
          gl += GG[b]; hl += HH[b]; nl += NN[b]
          const nr = ids.length - nl
          if (nl < minFoglia || nr < minFoglia) continue
          const gr = G - gl, hr = H - hl
          const gain = gl * gl / (hl + lambda) + gr * gr / (hr + lambda) - base
          if (gain > best.gain) best = { gain, j, b }
        }
      }
      if (best.j == null) return foglia
      const sx = [], dx = []
      for (const i of ids) (B[i][best.j] <= best.b ? sx : dx).push(i)
      return { j: best.j, b: best.b, gain: best.gain, sx: costruisci(sx, d + 1), dx: costruisci(dx, d + 1) }
    }
    return costruisci(idx, 0)
  }
  function valuta(nodo, bx) { while (nodo.j != null) nodo = bx[nodo.j] <= nodo.b ? nodo.sx : nodo.dx; return nodo.v }
  function guadagni(nodo, imp) { if (nodo.j == null) return; imp[nodo.j] += nodo.gain; guadagni(nodo.sx, imp); guadagni(nodo.dx, imp) }

  function randomForest(X, y, w, { alberi = 150, profondita = 8, minFoglia = 8, seed = 7, maxBootstrap = 12000 } = {}) {
    const { B, soglie, bin } = binner(X), n = X.length, p = X[0].length
    const nbin = soglie.map(t => t.length), r = rng(seed), mtry = Math.max(1, Math.round(Math.sqrt(p)))
    const foresta = [], imp = new Array(p).fill(0)
    for (let t = 0; t < alberi; t++) {
      const cnt = new Float64Array(n)
      for (let i = 0, nb = Math.min(n, maxBootstrap); i < nb; i++) cnt[Math.floor(r() * n)]++            // bootstrap (al massimo maxBootstrap righe per albero)
      const idx = [], g = new Float64Array(n), h = new Float64Array(n)
      for (let i = 0; i < n; i++) if (cnt[i]) { idx.push(i); g[i] = -cnt[i] * w[i] * y[i]; h[i] = cnt[i] * w[i] }
      const a = albero(B, idx, g, h, nbin, { profondita, minFoglia, lambda: 0, mtry, r })
      guadagni(a, imp); foresta.push(a)
    }
    return {
      nome: 'Random forest', imp,
      prob: x => { const bx = x.map((v, j) => bin(j, v)); let s = 0; for (const a of foresta) s += valuta(a, bx); return s / foresta.length },
    }
  }

  function gradientBoosting(X, y, w, { iter = 120, lr = 0.05, profondita = 2, minFoglia = 40, lambda = 10, sottocampione = 0.8, seed = 11 } = {}) {
    const { B, soglie, bin } = binner(X), n = X.length, p = X[0].length
    const nbin = soglie.map(t => t.length), r = rng(seed)
    const sw = w.reduce((s, v) => s + v, 0), py = w.reduce((s, v, i) => s + v * y[i], 0) / sw
    const f0 = Math.log(py / (1 - py)), F = new Float64Array(n).fill(f0)
    const alberiL = [], imp = new Array(p).fill(0), g = new Float64Array(n), h = new Float64Array(n)
    for (let t = 0; t < iter; t++) {
      for (let i = 0; i < n; i++) { const pr = sigmoid(F[i]); g[i] = w[i] * (pr - y[i]); h[i] = w[i] * pr * (1 - pr) }
      const idx = []
      for (let i = 0; i < n; i++) if (r() < sottocampione) idx.push(i)
      const a = albero(B, idx, g, h, nbin, { profondita, minFoglia, lambda })
      guadagni(a, imp); alberiL.push(a)
      for (let i = 0; i < n; i++) F[i] += lr * valuta(a, B[i])
    }
    return {
      nome: 'Gradient boosting', imp,
      prob: x => { const bx = x.map((v, j) => bin(j, v)); let s = f0; for (const a of alberiL) s += lr * valuta(a, bx); return sigmoid(s) },
    }
  }

  // ───────────────────────── metriche
  function auc(y, p) {
    const o = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0])
    let r = 0, n1 = 0, i = 0, rank = 1
    while (i < o.length) {                    // ranghi medi per i pareggi
      let j = i; while (j < o.length && o[j][0] === o[i][0]) j++
      const rm = (rank + rank + (j - i) - 1) / 2
      for (let k = i; k < j; k++) if (o[k][1]) { r += rm; n1++ }
      rank += j - i; i = j
    }
    const n0 = o.length - n1
    return n1 && n0 ? (r - n1 * (n1 + 1) / 2) / (n1 * n0) : NaN
  }
  function roc(y, p, punti = 50) {
    const o = p.map((v, i) => [v, y[i]]).sort((a, b) => b[0] - a[0])
    const P = y.reduce((s, v) => s + v, 0), N = y.length - P, out = [{ x: 0, y: 0 }]
    let tp = 0, fp = 0
    o.forEach(([, yy], i) => { yy ? tp++ : fp++; if ((i + 1) % Math.max(1, Math.floor(o.length / punti)) === 0) out.push({ x: fp / N, y: tp / P }) })
    out.push({ x: 1, y: 1 })
    return out
  }
  function decili(y, p) {                    // lift e guadagno cumulato, decile 1 = rischio piu' alto
    const o = p.map((v, i) => [v, y[i]]).sort((a, b) => b[0] - a[0])
    const base = mean(y), tot = y.reduce((s, v) => s + v, 0), out = []
    let cum = 0
    for (let d = 0; d < 10; d++) {
      const s = o.slice(Math.round(d * o.length / 10), Math.round((d + 1) * o.length / 10))
      const ch = s.reduce((t, r) => t + r[1], 0); cum += ch
      out.push({ decile: d + 1, n: s.length, churner: ch, tasso: ch / s.length, lift: ch / s.length / base, cum: cum / tot })
    }
    return out
  }
  // probabilita' riportata alla prevalenza reale (il modello e' addestrato su classi bilanciate)
  const calibra = (p, prior) => p * prior / (p * prior + (1 - p) * (1 - prior))

  function importanzaPermutazione(modello, X, y, seed = 3) {
    const r = rng(seed), base = auc(y, X.map(modello.prob)), p = X[0].length, out = []
    for (let j = 0; j < p; j++) {
      const col = X.map(x => x[j])
      for (let i = col.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1));[col[i], col[k]] = [col[k], col[i]] }
      const pr = X.map((x, i) => { const z = x.slice(); z[j] = col[i]; return modello.prob(z) })
      out.push(Math.max(0, base - auc(y, pr)))
    }
    return out
  }
  function aucUnivariata(x, y) { const a = auc(y, x); return isNaN(a) ? NaN : a }

  // ───────────────────────── confronto dei tre modelli
  // sottocampione stratificato: con parchi clienti molto grandi si addestra e si valuta su un campione
  function campione(idx, y, max, seed) {
    if (idx.length <= max) return idx
    const r = rng(seed), out = []
    for (const cl of [0, 1]) {
      const g = idx.filter(i => y[i] === cl)
      for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[g[i], g[j]] = [g[j], g[i]] }
      const m = Math.round(g.length * max / idx.length); for (let i = 0; i < m; i++) out.push(g[i])
    }
    return out
  }
  function addestraTutti(d, { seed = 42, maxAddestramento = 25000, maxVerifica = 25000, avanzamento = () => {} } = {}) {
    let { tr, te } = dividi(d.y, 0.7, seed)
    const ridotto = tr.length > maxAddestramento || te.length > maxVerifica
    tr = campione(tr, d.y, maxAddestramento, seed + 1); te = campione(te, d.y, maxVerifica, seed + 2)
    const Xtr = tr.map(i => d.X[i]), ytr = tr.map(i => d.y[i]), wtr = pesiBilanciati(ytr)
    const Xte = te.map(i => d.X[i]), yte = te.map(i => d.y[i])
    const prior = mean(d.y), out = []
    const ricette = [
      ['logistica', () => logistica(Xtr, ytr, wtr)],
      ['rf', () => randomForest(Xtr, ytr, wtr)],
      ['gbm', () => gradientBoosting(Xtr, ytr, wtr)],
    ]
    for (const [id, fn] of ricette) {
      avanzamento(id)
      const t0 = Date.now(), m = fn(), sec = (Date.now() - t0) / 1000
      const pte = Xte.map(m.prob), dec = decili(yte, pte)
      out.push({ id, nome: m.nome, modello: m, secondi: sec, auc: auc(yte, pte), roc: roc(yte, pte), decili: dec,
                 lift10: dec[0].lift, presi20: dec[1].cum, pte })
    }
    out.sort((a, b) => b.auc - a.auc)
    const migliore = out[0]
    migliore.importanza = migliore.id === 'logistica'
      ? migliore.modello.coef.map((c, j) => Math.abs(migliore.modello.b[j + 1]))
      : (() => { const s = campione(Xte.map((_, i) => i), yte, 8000, seed + 3); return importanzaPermutazione(migliore.modello, s.map(i => Xte[i]), s.map(i => yte[i])) })()
    return { modelli: out, migliore, tr, te, yte, prior, campione: ridotto ? { tr: tr.length, te: te.length } : null }
  }

  // ───────────────────────── k-means (k-means++ con piu' ripartenze)
  // con molti clienti i centri si stimano su un campione e poi si assegnano tutti i clienti
  function kmeans(Z, k, { maxN = 30000, ...opz } = {}) {
    if (Z.length <= maxN) return kmeansBase(Z, k, opz)
    const r = rng(17), idx = Z.map((_, i) => i)
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[idx[i], idx[j]] = [idx[j], idx[i]] }
    const m = kmeansBase(idx.slice(0, maxN).map(i => Z[i]), k, opz), p = Z[0].length
    const lab = Z.map(z => { let bj = 0, bd = Infinity
      for (let c = 0; c < k; c++) { let s = 0; for (let j = 0; j < p; j++) s += (z[j] - m.C[c][j]) ** 2; if (s < bd) { bd = s; bj = c } }
      return bj })
    return { lab, C: m.C, inerzia: m.inerzia }
  }
  function kmeansBase(Z, k, { ripartenze = 6, iter = 60, seed = 5 } = {}) {
    const r = rng(seed), n = Z.length, p = Z[0].length
    const d2 = (a, b) => { let s = 0; for (let j = 0; j < p; j++) s += (a[j] - b[j]) ** 2; return s }
    let best = null
    for (let t = 0; t < ripartenze; t++) {
      const C = [Z[Math.floor(r() * n)].slice()]
      while (C.length < k) {
        const dd = Z.map(z => Math.min(...C.map(c => d2(z, c)))), s = dd.reduce((a, b) => a + b, 0)
        let u = r() * s, i = 0
        while (u > dd[i] && i < n - 1) { u -= dd[i]; i++ }
        C.push(Z[i].slice())
      }
      const lab = new Array(n).fill(0)
      for (let it = 0; it < iter; it++) {
        let cambi = 0
        for (let i = 0; i < n; i++) {
          let bj = 0, bd = Infinity
          for (let c = 0; c < k; c++) { const v = d2(Z[i], C[c]); if (v < bd) { bd = v; bj = c } }
          if (lab[i] !== bj) { lab[i] = bj; cambi++ }
        }
        for (let c = 0; c < k; c++) {
          const m = new Array(p).fill(0); let cnt = 0
          for (let i = 0; i < n; i++) if (lab[i] === c) { cnt++; for (let j = 0; j < p; j++) m[j] += Z[i][j] }
          if (cnt) C[c] = m.map(v => v / cnt)
        }
        if (!cambi) break
      }
      const inerzia = Z.reduce((s, z, i) => s + d2(z, C[lab[i]]), 0)
      if (!best || inerzia < best.inerzia) best = { lab, C, inerzia }
    }
    return best
  }

  root.LumeML = { rng, quantile, median, mean, aData, km, piuVicino, indiceVicini, num, si, prepara, dividi, pesiBilanciati,
    logistica, randomForest, gradientBoosting, auc, roc, decili, calibra, importanzaPermutazione, aucUnivariata,
    addestraTutti, kmeans }
  if (typeof module !== 'undefined') module.exports = root.LumeML
})(typeof window !== 'undefined' ? window : globalThis)
