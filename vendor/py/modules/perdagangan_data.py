"""Data perdagangan luar negeri untuk BRS Exim.

Membaca fact_ekspor / fact_impor (Supabase) lalu menyusun angka seperti yang
diminta template BRS: ringkasan migas/nonmigas, golongan HS 2 digit, negara,
dan pelabuhan, masing-masing dengan pembanding bulan lalu dan tahun lalu plus
kumulatif Januari..bulan berjalan.

Aturan basis (dari paket ETL asli, jangan dilanggar):
  * Ekspor resmi memakai basis PROVORIG; impor resmi memakai basis KPPBC.
  * Basis POD (pelabuhan muat) dan KDPROV (provinsi tujuan) hanya untuk rincian
    dan TIDAK boleh dijumlahkan dengan angka resmi.
Semua nilai dikembalikan dalam Ribu US$ (dibagi 1000), sama seperti template.
"""
from __future__ import annotations

import logging

import pandas as pd
from sqlalchemy import text

logger = logging.getLogger(__name__)

BASIS_EKSPOR = "PROVORIG"
BASIS_IMPOR = "KPPBC"

BULAN = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]
SINGKAT = ["", "Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep",
           "Okt", "Nov", "Des"]


def _prev_period(bln, thn):
    """(bulan, tahun) sebelumnya."""
    return (bln - 1, thn) if bln > 1 else (12, thn - 1)


def _ribu(v):
    """US$ -> Ribu US$ sebagai float, atau 0.0 bila kosong."""
    try:
        if v is None or pd.isna(v):
            return 0.0
        return float(v) / 1000.0
    except (TypeError, ValueError):
        return 0.0


def _pct(now, prev):
    """Perubahan relatif dalam persen; None bila pembanding nol."""
    try:
        now, prev = float(now), float(prev)
    except (TypeError, ValueError):
        return None
    if prev == 0:
        return None if now == 0 else None
    return (now - prev) / prev * 100.0


def _query(engine, sql, **params):
    try:
        return pd.read_sql_query(text(sql), engine, params=params)
    except Exception as exc:  # noqa: BLE001
        logger.info("perdagangan: query gagal (%s): %s", sql.split()[1], exc)
        return pd.DataFrame()


def _total_bulan(engine, arus, prov, thn, bln):
    """Total nilai (Ribu US$) satu bulan untuk satu arus."""
    if arus == "ekspor":
        df = _query(engine, f"""
            SELECT COALESCE(SUM(fob),0) AS nilai FROM fact_ekspor
            WHERE prov=:prov AND basis='{BASIS_EKSPOR}' AND tahun=:thn AND bulan=:bln
        """, prov=prov, thn=int(thn), bln=int(bln))
    else:
        df = _query(engine, f"""
            SELECT COALESCE(SUM(cif),0) AS nilai FROM fact_impor
            WHERE prov=:prov AND basis='{BASIS_IMPOR}' AND tahun=:thn AND bulan=:bln
        """, prov=prov, thn=int(thn), bln=int(bln))
    return _ribu(df.iloc[0]["nilai"]) if not df.empty else 0.0


def _total_kumulatif(engine, arus, prov, thn, bln):
    """Total Januari..bln (Ribu US$)."""
    if arus == "ekspor":
        df = _query(engine, f"""
            SELECT COALESCE(SUM(fob),0) AS nilai FROM fact_ekspor
            WHERE prov=:prov AND basis='{BASIS_EKSPOR}' AND tahun=:thn AND bulan<=:bln
        """, prov=prov, thn=int(thn), bln=int(bln))
    else:
        df = _query(engine, f"""
            SELECT COALESCE(SUM(cif),0) AS nilai FROM fact_impor
            WHERE prov=:prov AND basis='{BASIS_IMPOR}' AND tahun=:thn AND bulan<=:bln
        """, prov=prov, thn=int(thn), bln=int(bln))
    return _ribu(df.iloc[0]["nilai"]) if not df.empty else 0.0


def _per_migas(engine, arus, prov, thn, bln, kumulatif=False):
    """{'Migas': x, 'NonMigas': y} dalam Ribu US$."""
    kolom = "fob" if arus == "ekspor" else "cif"
    tabel = "fact_ekspor" if arus == "ekspor" else "fact_impor"
    basis = BASIS_EKSPOR if arus == "ekspor" else BASIS_IMPOR
    syarat_bulan = "bulan<=:bln" if kumulatif else "bulan=:bln"
    df = _query(engine, f"""
        SELECT migas, COALESCE(SUM({kolom}),0) AS nilai FROM {tabel}
        WHERE prov=:prov AND basis='{basis}' AND tahun=:thn AND {syarat_bulan}
        GROUP BY migas
    """, prov=prov, thn=int(thn), bln=int(bln))
    out = {"Migas": 0.0, "NonMigas": 0.0}
    for _, r in df.iterrows():
        kunci = "Migas" if str(r["migas"]).strip().lower() == "migas" else "NonMigas"
        out[kunci] += _ribu(r["nilai"])
    return out


def _per_entitas(engine, arus, prov, thn, bln, dimensi, kumulatif=False, basis=None):
    """Agregat per dimensi ('hs2' | 'negara' | 'pelabuhan'), urut menurun.

    Mengembalikan list dict {kode, nilai} dalam Ribu US$.
    """
    tabel = "fact_ekspor" if arus == "ekspor" else "fact_impor"
    kolom = "fob" if arus == "ekspor" else "cif"
    default_basis = BASIS_EKSPOR if arus == "ekspor" else BASIS_IMPOR
    b = basis or default_basis
    syarat_bulan = "bulan<=:bln" if kumulatif else "bulan=:bln"

    if dimensi == "hs2":
        df = _query(engine, f"""
            SELECT hs2 AS kode, COALESCE(SUM({kolom}),0) AS nilai FROM {tabel}
            WHERE prov=:prov AND basis='{b}' AND tahun=:thn AND {syarat_bulan}
            GROUP BY hs2 ORDER BY 2 DESC
        """, prov=prov, thn=int(thn), bln=int(bln))
    elif dimensi == "negara":
        df = _query(engine, f"""
            SELECT COALESCE(NULLIF(negara_iso2,''), negara_kode, '-') AS kode,
                   COALESCE(SUM({kolom}),0) AS nilai FROM {tabel}
            WHERE prov=:prov AND basis='{b}' AND tahun=:thn AND {syarat_bulan}
            GROUP BY 1 ORDER BY 2 DESC
        """, prov=prov, thn=int(thn), bln=int(bln))
    elif dimensi == "pelabuhan":
        df = _query(engine, f"""
            SELECT COALESCE(NULLIF(pelabuhan,''), '-') AS kode,
                   COALESCE(SUM({kolom}),0) AS nilai FROM {tabel}
            WHERE prov=:prov AND basis='{b}' AND tahun=:thn AND {syarat_bulan}
            GROUP BY 1 ORDER BY 2 DESC
        """, prov=prov, thn=int(thn), bln=int(bln))
    else:
        raise ValueError(f"dimensi tidak dikenal: {dimensi}")

    return [{"kode": str(r["kode"]), "nilai": _ribu(r["nilai"])} for _, r in df.iterrows()]


def _bulan_tersedia(engine, prov, thn, bln):
    """Bulan (1..12) yang punya data pada tahun itu, untuk deteksi data bolong."""
    df = _query(engine, """
        SELECT DISTINCT bulan FROM fact_impor
        WHERE prov=:prov AND basis='KPPBC' AND tahun=:thn AND bulan<=:bln
        UNION SELECT DISTINCT bulan FROM fact_ekspor
        WHERE prov=:prov AND basis='PROVORIG' AND tahun=:thn AND bulan<=:bln
        ORDER BY 1
    """, prov=prov, thn=int(thn), bln=int(bln))
    return sorted(int(b) for b in df["bulan"]) if not df.empty else []


def kumpulkan_perdagangan(engine, prov, thn, bln):
    """Susun seluruh angka yang dibutuhkan template BRS Exim.

    Mengembalikan dict dengan kunci:
      ringkasan_ekspor / ringkasan_impor / ringkasan_neraca : list baris tabel
      ekspor_hs2 / ekspor_negara / ekspor_pelabuhan         : list entitas
      impor_hs2 / impor_negara                              : list entitas
      meta                                                  : periode & label
    """
    thn, bln = int(thn), int(bln)
    prev_bln, prev_thn = _prev_period(bln, thn)
    last_thn = thn - 1

    def blok_ringkasan(arus):
        """Baris Total + Migas + NonMigas untuk tabel Ringkasan."""
        now = _total_bulan(engine, arus, prov, thn, bln)
        prev = _total_bulan(engine, arus, prov, prev_thn, prev_bln)
        last = _total_bulan(engine, arus, prov, last_thn, bln)
        kum_now = _total_kumulatif(engine, arus, prov, thn, bln)
        kum_last = _total_kumulatif(engine, arus, prov, last_thn, bln)
        migas_now = _per_migas(engine, arus, prov, thn, bln)
        migas_prev = _per_migas(engine, arus, prov, prev_thn, prev_bln)
        migas_last = _per_migas(engine, arus, prov, last_thn, bln)
        migas_kum_now = _per_migas(engine, arus, prov, thn, bln, kumulatif=True)
        migas_kum_last = _per_migas(engine, arus, prov, last_thn, bln, kumulatif=True)

        def baris(label, a, b, c, d, e):
            return {"label": label, "last": a, "prev": b, "now": c,
                    "kum_last": d, "kum_now": e,
                    "mtm": _pct(c, b), "yoy_kum": _pct(e, d)}

        return [
            baris("Total", last, prev, now, kum_last, kum_now),
            baris("Migas", migas_last["Migas"], migas_prev["Migas"], migas_now["Migas"],
                  migas_kum_last["Migas"], migas_kum_now["Migas"]),
            baris("Nonmigas", migas_last["NonMigas"], migas_prev["NonMigas"], migas_now["NonMigas"],
                  migas_kum_last["NonMigas"], migas_kum_now["NonMigas"]),
        ]

    ekspor_ring = blok_ringkasan("ekspor")
    impor_ring = blok_ringkasan("impor")

    # Neraca = ekspor - impor per baris yang sama.
    neraca = []
    for e_row, i_row in zip(ekspor_ring, impor_ring):
        neraca.append({
            "label": "Neraca Perdagangan" if e_row["label"] == "Total" else e_row["label"],
            "last": e_row["last"] - i_row["last"],
            "prev": e_row["prev"] - i_row["prev"],
            "now": e_row["now"] - i_row["now"],
            "kum_last": e_row["kum_last"] - i_row["kum_last"],
            "kum_now": e_row["kum_now"] - i_row["kum_now"],
            "mtm": _pct(e_row["now"] - i_row["now"], e_row["prev"] - i_row["prev"]),
            "yoy_kum": _pct(e_row["kum_now"] - i_row["kum_now"], e_row["kum_last"] - i_row["kum_last"]),
        })

    def entitas(arus, dimensi, basis=None):
        """Entitas bulan ini + kumulatifnya (untuk baris Total)."""
        bulan = _per_entitas(engine, arus, prov, thn, bln, dimensi, basis=basis)
        kum = _per_entitas(engine, arus, prov, thn, bln, dimensi, kumulatif=True, basis=basis)
        kum_by = {r["kode"]: r["nilai"] for r in kum}
        for r in bulan:
            r["kum"] = kum_by.get(r["kode"], 0.0)
        return bulan

    return {
        "ringkasan_ekspor": ekspor_ring,
        "ringkasan_impor": impor_ring,
        "ringkasan_neraca": neraca,
        "ekspor_hs2": entitas("ekspor", "hs2"),
        "ekspor_negara": entitas("ekspor", "negara"),
        # Rincian pelabuhan untuk BRS: memecah total resmi menurut pelabuhan
        # muat, jadi harus dari baris PROVORIG (basis default). Kalau memakai
        # POD, jumlahnya tidak akan sama dengan Total Ekspor tabel Ringkasan
        # (terbukti selisih ~15x pada data Agustus 2026).
        "ekspor_pelabuhan_resmi": entitas("ekspor", "pelabuhan"),
        # Tampilan web memakai basis POD sesuai laporan acuan BPS.
        "ekspor_pelabuhan": entitas("ekspor", "pelabuhan", basis="POD"),
        "impor_hs2": entitas("impor", "hs2"),
        "impor_negara": entitas("impor", "negara"),
        "meta": {
            "bulan_tersedia": _bulan_tersedia(engine, prov, thn, bln),
            "prov": prov, "thn": thn, "bln": bln,
            "bln_nama": BULAN[bln], "bln_singkat": SINGKAT[bln],
            "prev_bln_nama": BULAN[prev_bln], "prev_thn": prev_thn,
            "last_thn": last_thn,
            "periode_kum": f"Jan-{SINGKAT[bln]}",
        },
    }
