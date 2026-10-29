"""Build the pariwisata (tourism) "Executive Summary" prompt for the Node app.

This is a faithful, Streamlit-free port of the table construction and prompt text
in `pariwisata/ai.py` -> `generate_akomodasi_tables()` / `_generate_narrative()`.

Why a port instead of an import: `pariwisata/ai.py` imports streamlit and the page
renderer, while this module is loaded by the export_service sidecar (and by
gen_narrative.py) where no Streamlit runtime exists. The prompt text and the table
shape must stay identical to the Streamlit version -- both apps write into the same
`pariwisata_ai_narratives` table, so a user regenerating a narrative from either UI
must get the same style of output.

What the model receives:
  * one row per accommodation class (Bintang 1-4 / Kelas 1-4), including classes
    with no data in a period (blank, not 0 -- TPK is an average, "no hotel" is not
    "0% occupancy");
  * columns for last year's same month, the previous month, the current month,
    and the delta in percentage points against each;
  * a `Total` row taken from the official Prov_Jenis reference averages
    (`pariwisata_ref_avg`) where uploaded, else the mean across classes;
  * a `*` marker on current-month cells with RSE > 25%.

Pure pandas/numpy/SQLAlchemy: no streamlit import.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sqlalchemy import text

try:  # vendored copy first, then the sibling Streamlit project
    from modules.etl_engine import MONTH_NAMES
except Exception:  # pragma: no cover - fallback keeps the module usable standalone
    MONTH_NAMES = [
        "Januari", "Februari", "Maret", "April", "Mei", "Juni",
        "Juli", "Agustus", "September", "Oktober", "November", "Desember",
    ]

GENERAL_TABLE = "all_data"
REF_AVG_TABLE = "pariwisata_ref_avg"

# Reader-facing name for the raw column. RLMTGAB is the DB/ETL code; the narasi
# says RLMT (Rata-rata Lama Menginap Tamu). TPK keeps its plain abbreviation.
INDICATOR_DISPLAY = {
    "rlmtgab": "RLMT (Rata-rata Lama Menginap Tamu)",
}
# Extra instruction per indicator, keeps the model from reintroducing the code.
INDICATOR_NOTES = {
    "rlmtgab": 'Sebut indikator ini sebagai "RLMT (Rata-rata Lama Menginap Tamu)" '
               'dan jangan gunakan singkatan RLMTGAB.',
}

PARIWISATA_PROMPT = "Anda adalah penulis Berita Resmi Statistik (BRS) Badan Pusat Statistik. Pembaca adalah\njurnalis, pelaku usaha, dan pegawai pemerintah non-teknis. Tirulah gaya narasi BRS BPS:\nbahasa Indonesia baku, datar, dan objektif; sudut pandang orang ketiga; tanpa sapaan,\ntanpa opini, tanpa tafsir sebab-akibat, tanpa rekomendasi.\n\nTUGAS\nTulis narasi indikator {indicator} untuk {jenis_lc} di Provinsi {province}, periode\n{month_name} {year}. Pembanding: {prev_month_name} {prev_year} (bulan lalu) dan\n{month_name} {last_year} (tahun lalu).\n\nMEMBACA TABEL\n- Baris tiap kelas adalah satu kelas akomodasi. Baris \"Total\" adalah angka resmi untuk\n  seluruh {jenis_lc}. Gunakan baris Total untuk kalimat pembuka dan untuk arah umum.\n- Kolom \"Δ vs ...\" berisi selisih. Satuan \"pts\" berarti poin, berlaku untuk TPK maupun RLMT. Tanda + berarti naik,\n  tanda - berarti turun.\n- Sel kosong atau \"-\" berarti kelas itu tidak ada datanya pada periode tersebut. Itu bukan\n  nol. Jangan membandingkan kelas yang kosong. Boleh dinyatakan satu kali: \"Data kelas X\n  tidak tersedia pada {prev_month_name} {prev_year}\".\n- Tanda * pada nilai bulan ini berarti RSE di atas 25 persen. Jangan cetak tanda *. Bila\n  kelas bertanda * disebut sebagai tertinggi atau terendah, tambahkan klausa \"dengan\n  catatan angka tersebut memiliki RSE di atas 25 persen\".\n\nPENULISAN INDIKATOR\n- TPK: \"Tingkat Penghunian Kamar (TPK)\" pada kemunculan pertama. Nilai ditulis \"X persen\",\n  selisih ditulis \"X persen poin\".\n- RLMT: \"Rata-rata Lama Menginap Tamu (RLMT)\". Jangan tulis RLMTGAB. Nilai ditulis dalam\n  \"hari\", selisih ditulis dalam \"poin\".\n- Nama kelas ditulis huruf kecil kecuali awal kalimat: \"hotel bintang 5\", \"hotel\n  nonbintang kelas 2\".\n\nRANGKA PARAGRAF 1 (bulan ini dibanding bulan lalu)\na. Pembuka, pola BRS:\n   \"[Indikator] {jenis_lc} di Provinsi {province} pada {month_name} {year} mencapai/\n   tercatat sebesar [Total bulan ini] [persen/hari]. Angka ini naik/turun [selisih\n   Total vs bulan lalu] [poin] dibandingkan {prev_month_name} {prev_year}\n   (m-to-m).\" Bila selisih nol, tulis \"tetap\" menggantikan naik/turun.\nb. Pergerakan kelas, pola BRS:\n   \"[Kelas A] mencatat kenaikan tertinggi, yaitu sebesar x [satuan], diikuti [kelas B]\n   sebesar y [satuan] dan [kelas C] sebesar z [satuan]. Sebaliknya, penurunan terdalam\n   terjadi pada [kelas D] sebesar p [satuan].\"\n   Bila semua kelas searah: \"Seluruh kelas mengalami [peningkatan/penurunan], dengan\n   [kelas A] tertinggi sebesar x [satuan].\" Bila hanya satu kelas berbeda arah:\n   \"Hanya [kelas X] yang mencatatkan [kenaikan/penurunan], yaitu sebesar x [satuan].\"\n\nRANGKA PARAGRAF 2 (dibanding tahun lalu)\na. Pembuka, pola BRS:\n   \"Jika dibandingkan dengan {month_name} {last_year} (y-on-y), [indikator] ...\n   mengalami peningkatan/penurunan sebesar [selisih Total] [satuan], dari [nilai tahun\n   lalu Total] menjadi [nilai bulan ini Total].\"\nb. Pergerakan kelas dengan pola dan batas yang sama seperti paragraf 1, memakai kolom\n   selisih terhadap tahun lalu.\nc. Kalimat tingkat, pola BRS:\n   \"[Indikator] tertinggi tercatat pada [kelas], yaitu [nilai] [satuan], sedangkan\n   yang terendah tercatat pada [kelas], yaitu [nilai] [satuan].\"\nd. Berhenti di fakta terakhir. Tidak ada kalimat makna atau kesimpulan. Jangan menulis\n   capaian kumulatif Januari sampai bulan ini, karena tidak ada di tabel.\ne. Penanda perbandingan (m-to-m) dan (y-on-y) ditulis huruf kecil dalam kurung, hanya satu\n   kali per kalimat pembuka paragraf, tidak di setiap kalimat.\n\nATURAN GAYA BRS (WAJIB)\n1. Setiap kalimat memuat fakta dari tabel. Tidak ada kalimat yang hanya menegaskan\n   pentingnya temuan. Satu kalimat boleh panjang, tetapi hanya membawa satu gagasan.\n2. Tulis \"persen\", bukan tanda %. Selisih angka persentase ditulis \"persen poin\".\n3. Format angka Indonesia: titik untuk ribuan, koma untuk desimal (1.234,56).\n   Persen dan persen poin selalu 2 desimal. Salin angka dari tabel, jangan membulatkan\n   dan jangan mengubah satuan (jangan ubah \"orang\" menjadi \"juta orang\").\n4. Arah perubahan ditentukan angka, bukan selera. Pakai kata baku: naik, turun, meningkat,\n   menurun, stabil. Nilai di antara -0,05 dan +0,05 ditulis \"relatif stabil\".\n   Dilarang: melonjak, anjlok, drastis, tajam, signifikan, komprehensif, mendalam, kontras,\n   fundamental, krusial, kerangka, dinamika, menandakan, mengisyaratkan,\n   \"bukan hanya ... tetapi juga\", tanda pisah panjang (em dash), dan daftar tiga hal\n   yang dipaksakan. Tanda pisah pendek hanya untuk rentang periode (Januari–Agustus 2026).\n5. Daftar entitas memakai pola BRS: \"A sebesar x persen, B sebesar y persen, dan C sebesar\n   z persen\". Urutkan dari nilai terbesar ke terkecil. Pakai \"masing-masing\" bila dua\n   entitas atau lebih berbagi satu kalimat, \"diikuti\" untuk peringkat berikutnya, dan\n   \"Sebaliknya,\" atau \"Sementara itu,\" untuk membalik arah.\n6. Bila semua entitas bergerak searah, nyatakan itu dengan satu kalimat (\"terjadi di semua\n   ... yang diamati\") lalu sebut yang tertinggi saja. Jangan mengulang daftar.\n7. Singkatan ditulis lengkap sekali pada pemakaian pertama, selanjutnya singkatannya saja.\n8. Jangan menambah angka, penyebab, atau pembanding yang tidak ada di tabel. Satu-satunya\n   angka turunan yang diperbolehkan adalah persentase kontribusi (lihat bagian modul).\n   Hitung dengan teliti dari angka tabel.\n9. Keluaran: teks polos, tepat 2 paragraf, dipisahkan satu baris kosong. Tanpa judul,\n    tanpa markdown, tanpa butir, tanpa pengantar, tanpa catatan kaki, tanpa penutup.\n\nSumber Data Tabel:\n{province_str}"


def _fill_prompt(template, values):
    """Ganti {nama} sekali jalan; placeholder tak dikenal dibiarkan."""
    import re as _re
    return _re.sub(r"\{([a-z_]+)\}", lambda m: str(values.get(m.group(1), m.group(0))), template)


def _month_year(year, month):
    """Indonesian period label, e.g. (2026, 8) -> 'Agustus 2026'."""
    return f"{MONTH_NAMES[int(month) - 1]} {int(year)}"


def _load_ref_avg(engine, province):
    """Official TPK/RLMTGAB per jenis from the uploaded Prov_Jenis sheet.

    Returns {(jenis_akomodasi, year, month): {'tpk', 'rlmtgab'}}. A missing table
    or no rows -> {}, so the caller falls back to the computed class mean.
    """
    try:
        with engine.connect() as conn:
            df = pd.read_sql_query(
                text(
                    "SELECT jenis_akomodasi, year, month, tpk, rlmtgab "
                    f"FROM {REF_AVG_TABLE} WHERE kd_prov = :prov"
                ),
                conn, params={"prov": str(province).strip()},
            )
    except Exception:
        return {}
    return {
        (r.jenis_akomodasi, int(r.year), int(r.month)): {"tpk": float(r.tpk), "rlmtgab": float(r.rlmtgab)}
        for r in df.itertuples()
    }


def _format_kelas(val, jenis):
    if pd.isna(val):
        return "Undefined Class"
    try:
        int_val = int(val)
    except (ValueError, TypeError):
        return str(val)
    if jenis == "Hotel Bintang":
        return f"Bintang {int_val}"
    if jenis == "Hotel Non Bintang":
        return f"Kelas {int_val}"
    return str(int_val)


def build_prompt(engine, province, year, month, jenis, indicator, table=GENERAL_TABLE):
    """Return the full prompt string for one (province, period, jenis, indicator).

    Mirrors the Streamlit table exactly; raises ValueError when the period has no
    current-month data (the Streamlit page shows a warning instead).
    """
    year = int(year)
    month = int(month)
    province = str(province)
    province_str = province.strip()
    prev_month = (month - 1) if month > 1 else 12
    prev_year = year if month > 1 else (year - 1)
    last_year = year - 1

    query = text(
        f"SELECT * FROM {table} WHERE TRIM(CAST(kd_prov AS TEXT)) = :province "
        "AND year IN (:year, :prev_year, :last_year) AND month IN (:month, :prev_month)"
    )
    with engine.connect() as conn:
        df_all = pd.read_sql_query(
            query, conn,
            params={"province": province_str, "year": year, "prev_year": prev_year,
                    "last_year": last_year, "month": month, "prev_month": prev_month},
        )
    if df_all.empty:
        raise ValueError(f"no data for {province_str} in the requested periods")

    df_current = df_all[(df_all["year"] == year) & (df_all["month"] == month)]
    df_prev = df_all[(df_all["year"] == prev_year) & (df_all["month"] == prev_month)]
    df_last = df_all[(df_all["year"] == last_year) & (df_all["month"] == month)]
    if df_current.empty:
        raise ValueError(f"no current period data for {province_str} on {month}/{year}")

    ref_avg = _load_ref_avg(engine, province_str)

    # Class domain per jenis from the WHOLE table, not just the displayed periods:
    # a class that is missing in one period must still get a (blank) row, because
    # "no hotels of this class" is information.
    try:
        with engine.connect() as conn:
            df_domain = pd.read_sql_query(
                text(
                    "SELECT jenis_akomodasi, kelas_akomodasi "
                    f"FROM {table} WHERE kelas_akomodasi IS NOT NULL "
                    "GROUP BY jenis_akomodasi, kelas_akomodasi"
                ),
                conn,
            )
        kelas_domain = {
            j: sorted(int(k) for k in g["kelas_akomodasi"].dropna().unique())
            for j, g in df_domain.groupby("jenis_akomodasi")
        }
    except Exception:
        kelas_domain = {}

    rse_col = f"{indicator}_rse"
    keep_rse = rse_col in df_current.columns
    cur_cols = ["kelas_akomodasi", indicator] + ([rse_col] if keep_rse else [])
    cur_sub = (df_current[df_current["jenis_akomodasi"] == jenis][cur_cols]
               .rename(columns={indicator: "current"}))
    if keep_rse:
        cur_sub = cur_sub.rename(columns={rse_col: "current_rse"})
    prev_sub = df_prev[df_prev["jenis_akomodasi"] == jenis][["kelas_akomodasi", indicator]].rename(columns={indicator: "prev"})
    last_sub = df_last[df_last["jenis_akomodasi"] == jenis][["kelas_akomodasi", indicator]].rename(columns={indicator: "last_year"})

    merged = cur_sub.merge(prev_sub, on="kelas_akomodasi", how="outer").merge(last_sub, on="kelas_akomodasi", how="outer")
    merged = merged.dropna(subset=["kelas_akomodasi"])

    merged["kelas_akomodasi"] = pd.to_numeric(merged["kelas_akomodasi"], errors="coerce")
    all_kelas = sorted(
        set(kelas_domain.get(jenis, []))
        | set(int(k) for k in merged["kelas_akomodasi"].dropna().unique())
    )
    if all_kelas:
        merged = (merged.set_index("kelas_akomodasi")
                        .reindex(all_kelas)
                        .rename_axis("kelas_akomodasi")
                        .reset_index())

    merged["change_prev"] = np.where(merged["prev"].notna(), merged["current"] - merged["prev"], np.nan)
    merged["change_last"] = np.where(merged["last_year"].notna(), merged["current"] - merged["last_year"], np.nan)
    merged["nama_kelas_akomodasi"] = merged["kelas_akomodasi"].apply(lambda v: _format_kelas(v, jenis))

    display_df = merged[["nama_kelas_akomodasi", "last_year", "prev", "current", "change_prev", "change_last"]] \
        .set_index("nama_kelas_akomodasi").round(2)

    avg_row = pd.DataFrame({
        "last_year": [display_df["last_year"].mean()],
        "prev": [display_df["prev"].mean()],
        "current": [display_df["current"].mean()],
        "change_prev": [display_df["change_prev"].mean()],
        "change_last": [display_df["change_last"].mean()],
    }, index=["Total"]).round(2)

    # Official reference values (Prov_Jenis sheet) replace the class mean for the
    # periods that sheet covers; every other cell stays a class mean.
    for cell, (yr, mo) in (("last_year", (last_year, month)),
                           ("prev", (prev_year, prev_month)),
                           ("current", (year, month))):
        ref = ref_avg.get((jenis, yr, mo))
        if ref:
            avg_row.loc["Total", cell] = round(ref[indicator], 2)
    avg_row["change_prev"] = (avg_row["current"] - avg_row["prev"]).round(2)
    avg_row["change_last"] = (avg_row["current"] - avg_row["last_year"]).round(2)

    # (*) marks this month's per-class values where RSE > 25%. The Total row is
    # never starred (display_df carries no Total row).
    if keep_rse and "current_rse" in merged.columns:
        rse_by_kelas = merged.set_index("nama_kelas_akomodasi")["current_rse"]
        display_df["current"] = display_df["current"].astype(object)
        for idx in display_df.index:
            rv = rse_by_kelas.get(idx)
            if pd.notna(rv) and rv > 0.25 and pd.notna(display_df.at[idx, "current"]):
                display_df.at[idx, "current"] = f"{display_df.at[idx, 'current']:.2f}*"

    final_table = pd.concat([display_df, avg_row])
    for col in ["change_prev", "change_last"]:
        final_table[col] = final_table[col].apply(lambda x: f"{x:+.2f} pts" if pd.notna(x) else "-")

    # Column headers name the period they represent, not "prev"/"last_year".
    final_table = final_table.rename(columns={
        "last_year": _month_year(last_year, month),
        "prev": _month_year(prev_year, prev_month),
        "current": _month_year(year, month),
        "change_prev": f"\u0394 vs {_month_year(prev_year, prev_month)}",
        "change_last": f"\u0394 vs {_month_year(last_year, month)}",
    })

    month_name = MONTH_NAMES[month - 1]
    prev_month_name = MONTH_NAMES[prev_month - 1]
    return _fill_prompt(PARIWISATA_PROMPT, {
        "indicator": INDICATOR_DISPLAY.get(indicator, str(indicator).upper()),
        "jenis_lc": str(jenis).lower().replace("non bintang", "nonbintang"),
        "province": province,
        "province_str": final_table.to_string(),
        "month_name": month_name,
        "year": year,
        "prev_month_name": prev_month_name,
        "prev_year": prev_year,
        "last_year": last_year,
    })
    note = INDICATOR_NOTES.get(indicator)
    parts = [header] + ([note] if note else []) + [final_table.to_string()]
    return "\n".join(parts) + "\n" + base_prompt_text
