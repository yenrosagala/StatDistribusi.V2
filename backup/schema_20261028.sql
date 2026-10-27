--
-- PostgreSQL database dump
--

\restrict YXeFNyl92wtPruJamPp51476LwpncEwW4kIpX4wOlcJqyFC2RV7XqDOt3KZ92G4

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

DROP INDEX IF EXISTS public.growth_notes_period_idx;
ALTER TABLE IF EXISTS ONLY public.wilayah DROP CONSTRAINT IF EXISTS wilayah_pkey;
ALTER TABLE IF EXISTS ONLY public.upload_staging DROP CONSTRAINT IF EXISTS upload_staging_pkey;
ALTER TABLE IF EXISTS ONLY public.ai_narratives DROP CONSTRAINT IF EXISTS unique_report_period;
ALTER TABLE IF EXISTS ONLY public.transportasi_udara DROP CONSTRAINT IF EXISTS transportasi_udara_pkey;
ALTER TABLE IF EXISTS ONLY public.transportasi_laut DROP CONSTRAINT IF EXISTS transportasi_laut_pkey;
ALTER TABLE IF EXISTS ONLY public.pariwisata_ai_narratives DROP CONSTRAINT IF EXISTS pariwisata_ai_narratives_pkey;
ALTER TABLE IF EXISTS ONLY public.growth_summaries DROP CONSTRAINT IF EXISTS growth_summaries_pkey;
ALTER TABLE IF EXISTS ONLY public.growth_summaries DROP CONSTRAINT IF EXISTS growth_summaries_module_year_month_input_hash_key;
ALTER TABLE IF EXISTS ONLY public.growth_notes DROP CONSTRAINT IF EXISTS growth_notes_pkey;
ALTER TABLE IF EXISTS ONLY public.growth_notes DROP CONSTRAINT IF EXISTS growth_notes_dataset_provinsi_entity_jenis_kelas_indicator__key;
ALTER TABLE IF EXISTS ONLY public.ai_narratives DROP CONSTRAINT IF EXISTS ai_narratives_pkey;
ALTER TABLE IF EXISTS ONLY public.ai_narratives_cache DROP CONSTRAINT IF EXISTS ai_narratives_cache_pkey;
ALTER TABLE IF EXISTS public.growth_summaries ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.growth_notes ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.ai_narratives ALTER COLUMN id DROP DEFAULT;
DROP TABLE IF EXISTS public.wilayah;
DROP TABLE IF EXISTS public.upload_staging;
DROP TABLE IF EXISTS public.transportasi_udara;
DROP TABLE IF EXISTS public.transportasi_laut;
DROP TABLE IF EXISTS public.pariwisata_ref_avg;
DROP TABLE IF EXISTS public.pariwisata_ai_narratives;
DROP SEQUENCE IF EXISTS public.growth_summaries_id_seq;
DROP TABLE IF EXISTS public.growth_summaries;
DROP SEQUENCE IF EXISTS public.growth_notes_id_seq;
DROP TABLE IF EXISTS public.growth_notes;
DROP TABLE IF EXISTS public.all_data;
DROP SEQUENCE IF EXISTS public.ai_narratives_id_seq;
DROP TABLE IF EXISTS public.ai_narratives_cache;
DROP TABLE IF EXISTS public.ai_narratives;
DROP SCHEMA IF EXISTS public;
--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_narratives (
    id integer NOT NULL,
    report_type text,
    period_key text,
    narrative_text text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: ai_narratives_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_narratives_cache (
    report_type text NOT NULL,
    period_key text NOT NULL,
    narrative_text text,
    updated_at timestamp without time zone
);


--
-- Name: ai_narratives_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_narratives_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_narratives_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_narratives_id_seq OWNED BY public.ai_narratives.id;


--
-- Name: all_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.all_data (
    kd_prov text,
    kd_kab text,
    jenis_akomodasi text,
    kelas_akomodasi integer,
    mktj real,
    mkts real,
    mtgab real,
    tpk real,
    rlmtgab real,
    year integer,
    month integer,
    tpk_rse real,
    rlmtgab_rse real
);


--
-- Name: growth_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.growth_notes (
    id bigint NOT NULL,
    dataset text NOT NULL,
    provinsi text DEFAULT ''::text NOT NULL,
    entity text DEFAULT ''::text NOT NULL,
    jenis text DEFAULT ''::text NOT NULL,
    kelas integer DEFAULT '-1'::integer NOT NULL,
    indicator text NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    comparison text NOT NULL,
    growth_value numeric,
    reason text NOT NULL,
    author text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: growth_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.growth_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: growth_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.growth_notes_id_seq OWNED BY public.growth_notes.id;


--
-- Name: growth_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.growth_summaries (
    id bigint NOT NULL,
    module text NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    input_hash text NOT NULL,
    model text,
    summary text NOT NULL,
    note_count integer NOT NULL,
    cell_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: growth_summaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.growth_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: growth_summaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.growth_summaries_id_seq OWNED BY public.growth_summaries.id;


--
-- Name: pariwisata_ai_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pariwisata_ai_narratives (
    province text NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    jenis_akomodasi text NOT NULL,
    indicator text NOT NULL,
    narrative text
);


--
-- Name: pariwisata_ref_avg; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pariwisata_ref_avg (
    kd_prov text,
    jenis_akomodasi text,
    year integer,
    month integer,
    tpk real,
    rlmtgab real
);


--
-- Name: transportasi_laut; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transportasi_laut (
    tahun bigint NOT NULL,
    bulan text NOT NULL,
    kode_provinsi bigint,
    nama_provinsi text,
    kode_kabkota bigint,
    nama_kabkota text,
    kode_pelabuhan bigint NOT NULL,
    nama_pelabuhan text,
    dn_penumpang_turun bigint,
    dn_penumpang_naik bigint,
    dn_bongkar_barang_ton double precision,
    dn_muat_barang_ton double precision,
    ln_penumpang_turun bigint,
    ln_penumpang_naik bigint,
    ln_bongkar_barang_ton double precision,
    ln_muat_barang_ton double precision
);


--
-- Name: transportasi_udara; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transportasi_udara (
    tahun bigint NOT NULL,
    bulan text NOT NULL,
    kode_provinsi bigint,
    nama_provinsi text,
    kode_kabkota bigint,
    nama_kabkota text,
    kode_bandara bigint NOT NULL,
    nama_bandara text,
    pesawat_berangkat bigint,
    pesawat_datang bigint,
    penumpang_berangkat bigint,
    penumpang_datang bigint,
    penumpang_transit bigint,
    barang_muat_kg double precision,
    barang_bongkar_kg double precision,
    bagasi_muat_kg double precision,
    bagasi_bongkar_kg double precision,
    pos_muat_kg double precision,
    pos_bongkar_kg double precision
);


--
-- Name: upload_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_staging (
    token text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: wilayah; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wilayah (
    kode_kabkota bigint NOT NULL,
    nama_kabkota text,
    kode_provinsi bigint,
    nama_provinsi text
);


--
-- Name: ai_narratives id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_narratives ALTER COLUMN id SET DEFAULT nextval('public.ai_narratives_id_seq'::regclass);


--
-- Name: growth_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_notes ALTER COLUMN id SET DEFAULT nextval('public.growth_notes_id_seq'::regclass);


--
-- Name: growth_summaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_summaries ALTER COLUMN id SET DEFAULT nextval('public.growth_summaries_id_seq'::regclass);


--
-- Name: ai_narratives_cache ai_narratives_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_narratives_cache
    ADD CONSTRAINT ai_narratives_cache_pkey PRIMARY KEY (report_type, period_key);


--
-- Name: ai_narratives ai_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_narratives
    ADD CONSTRAINT ai_narratives_pkey PRIMARY KEY (id);


--
-- Name: growth_notes growth_notes_dataset_provinsi_entity_jenis_kelas_indicator__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_notes
    ADD CONSTRAINT growth_notes_dataset_provinsi_entity_jenis_kelas_indicator__key UNIQUE (dataset, provinsi, entity, jenis, kelas, indicator, year, month, comparison);


--
-- Name: growth_notes growth_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_notes
    ADD CONSTRAINT growth_notes_pkey PRIMARY KEY (id);


--
-- Name: growth_summaries growth_summaries_module_year_month_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_summaries
    ADD CONSTRAINT growth_summaries_module_year_month_input_hash_key UNIQUE (module, year, month, input_hash);


--
-- Name: growth_summaries growth_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.growth_summaries
    ADD CONSTRAINT growth_summaries_pkey PRIMARY KEY (id);


--
-- Name: pariwisata_ai_narratives pariwisata_ai_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pariwisata_ai_narratives
    ADD CONSTRAINT pariwisata_ai_narratives_pkey PRIMARY KEY (province, year, month, jenis_akomodasi, indicator);


--
-- Name: transportasi_laut transportasi_laut_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transportasi_laut
    ADD CONSTRAINT transportasi_laut_pkey PRIMARY KEY (tahun, bulan, kode_pelabuhan);


--
-- Name: transportasi_udara transportasi_udara_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transportasi_udara
    ADD CONSTRAINT transportasi_udara_pkey PRIMARY KEY (tahun, bulan, kode_bandara);


--
-- Name: ai_narratives unique_report_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_narratives
    ADD CONSTRAINT unique_report_period UNIQUE (report_type, period_key);


--
-- Name: upload_staging upload_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_staging
    ADD CONSTRAINT upload_staging_pkey PRIMARY KEY (token);


--
-- Name: wilayah wilayah_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wilayah
    ADD CONSTRAINT wilayah_pkey PRIMARY KEY (kode_kabkota);


--
-- Name: growth_notes_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX growth_notes_period_idx ON public.growth_notes USING btree (dataset, year, month);


--
-- PostgreSQL database dump complete
--

\unrestrict YXeFNyl92wtPruJamPp51476LwpncEwW4kIpX4wOlcJqyFC2RV7XqDOt3KZ92G4

