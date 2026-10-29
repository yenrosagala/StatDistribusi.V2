-- Modul Perdagangan Luar Negeri (Ekspor-Impor) Papua.
-- Sumber: DBF Bea Cukai / BPS ATAP, diunggah bulanan sebagai ZIP.
--
-- Aturan yang dijaga (lihat README paket ETL asli):
--   * Ekspor resmi memakai basis PROVORIG; impor resmi memakai basis KPPBC.
--     Kedua basis TIDAK boleh dijumlahkan.
--   * Nilai disimpan dalam US$ apa adanya; halaman web membaginya 1000
--     (Ribu US$) agar sama dengan tabel BPS.
--   * Netto dalam kg.
CREATE TABLE IF NOT EXISTS fact_ekspor (
  id              bigserial PRIMARY KEY,
  prov            text    NOT NULL,
  tahun           integer NOT NULL,
  bulan           integer NOT NULL,
  basis           text    NOT NULL,          -- 'PROVORIG' | 'POD'
  hs8             text    NOT NULL,
  hs2             text    NOT NULL,
  kabkota_asal    text,
  pel_muat        text,
  pelabuhan       text,
  negara_kode     text,
  negara_iso2     text,
  migas           text    NOT NULL,          -- 'Migas' | 'NonMigas'
  netto           double precision NOT NULL,
  fob             double precision NOT NULL  -- US$
);

CREATE INDEX IF NOT EXISTS ix_ekspor_periode ON fact_ekspor (tahun, bulan);
CREATE INDEX IF NOT EXISTS ix_ekspor_prov    ON fact_ekspor (prov, tahun, bulan, basis);

CREATE TABLE IF NOT EXISTS fact_impor (
  id              bigserial PRIMARY KEY,
  prov            text    NOT NULL,
  tahun           integer NOT NULL,
  bulan           integer NOT NULL,
  basis           text    NOT NULL,          -- 'KPPBC' | 'KDPROV'
  tipe            text,
  jenis           text,
  migas           text    NOT NULL,
  hs8             text    NOT NULL,
  hs2             text    NOT NULL,
  negara_kode     text,
  negara_iso2     text,
  pelabuhan       text,
  pel_un          text,
  kppbc           text,
  nama_kppbc      text,
  netto           double precision NOT NULL,
  cif             double precision NOT NULL  -- US$
);

CREATE INDEX IF NOT EXISTS ix_impor_periode ON fact_impor (tahun, bulan);
CREATE INDEX IF NOT EXISTS ix_impor_prov    ON fact_impor (prov, tahun, bulan, basis);

-- Jejak setiap unggahan, termasuk hasil validasi terhadap file *_total.DBF.
CREATE TABLE IF NOT EXISTS etl_log_perdagangan (
  id          bigserial PRIMARY KEY,
  tahun       integer NOT NULL,
  bulan       integer NOT NULL,
  arus        text    NOT NULL,              -- 'ekspor' | 'impor'
  prov        text    NOT NULL,
  basis       text    NOT NULL,
  sumber      text,
  baris       integer NOT NULL DEFAULT 0,
  netto_total double precision,
  nilai_total double precision,
  dicocokkan  boolean NOT NULL DEFAULT false, -- true bila cocok dengan *_total.DBF
  loaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_etl_log_periode ON etl_log_perdagangan (tahun, bulan);
