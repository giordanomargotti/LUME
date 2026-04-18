-- ══════════════════════════════════════════════════════
-- LUME · Schema database Supabase
-- Esegui questo SQL nell'editor SQL di Supabase
-- (supabase.com → tuo progetto → SQL Editor → New query)
-- ══════════════════════════════════════════════════════

-- ── TABELLA PROFILI UTENTE ───────────────────────────
-- Viene popolata automaticamente quando un utente si registra
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  full_name   TEXT,
  email       TEXT,
  settore     TEXT,   -- retail | servizi | consulenza
  ruolo       TEXT,   -- data_analyst | middle_management | team_leader | sales_manager
  business_unit TEXT, -- crm | customer_care | sales | finance | accounting | consulenza_fin
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger: crea profilo automaticamente ad ogni nuova registrazione
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.email
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── TABELLA ANALISI ──────────────────────────────────
-- Ogni volta che un utente carica un file e fa un'analisi
CREATE TABLE IF NOT EXISTS public.analyses (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  file_name     TEXT NOT NULL,
  file_rows     INTEGER,
  file_cols     INTEGER,
  headers       JSONB,           -- array dei nomi colonne
  data_profile  TEXT,            -- il riassunto statistico mandato a Claude
  scope_s       TEXT,            -- output sezione Situazione
  scope_c       TEXT,            -- output sezione Criticità
  scope_o       TEXT,            -- output sezione Opportunità
  scope_p       TEXT,            -- output sezione Priorità
  scope_e       TEXT,            -- output sezione Esposizione rischio
  settore       TEXT,
  ruolo         TEXT,
  business_unit TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── ROW LEVEL SECURITY (RLS) ─────────────────────────
-- Ogni utente vede SOLO i propri dati — mai quelli degli altri

ALTER TABLE public.profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analyses   ENABLE ROW LEVEL SECURITY;

-- Policy profili: leggi e modifica solo il tuo
CREATE POLICY "Utente vede solo il proprio profilo"
  ON public.profiles FOR ALL
  USING (auth.uid() = id);

-- Policy analisi: leggi e crea solo le tue
CREATE POLICY "Utente vede solo le proprie analisi"
  ON public.analyses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Utente crea solo le proprie analisi"
  ON public.analyses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Utente aggiorna solo le proprie analisi"
  ON public.analyses FOR UPDATE
  USING (auth.uid() = user_id);

-- ── STORAGE BUCKET PER FILE EXCEL ───────────────────
-- Crea il bucket per i file caricati (esegui separatamente
-- oppure vai su Supabase → Storage → New bucket)

INSERT INTO storage.buckets (id, name, public)
VALUES ('lume-files', 'lume-files', false)
ON CONFLICT DO NOTHING;

-- Policy storage: ogni utente accede solo alla propria cartella
CREATE POLICY "Utente accede solo ai propri file"
  ON storage.objects FOR ALL
  USING (auth.uid()::text = (storage.foldername(name))[1]);

-- ══════════════════════════════════════════════════════
-- STRUTTURA RISULTANTE:
--
-- auth.users          ← gestita da Supabase Auth
--   └── profiles      ← profilo + preferenze utente
--   └── analyses      ← storico analisi con output SCOPE
-- storage.lume-files  ← file Excel originali (opzionale)
--   └── {user_id}/    ← cartella privata per utente
--       └── file.xlsx
-- ══════════════════════════════════════════════════════
