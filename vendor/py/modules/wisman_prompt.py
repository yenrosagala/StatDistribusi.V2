"""Prompt narasi AI untuk kartu Wisman (wisatawan mancanegara).
"""
from __future__ import annotations

import pandas as pd
from sqlalchemy import text

BULAN = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]

def _angka(v, desimal=0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    s = f"{x:,.{desimal}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")

def _pct(now, prev):
    try:
        now, prev = float(now), float(prev)
    except (TypeError, ValueError):
        return None
    if prev == 0:
        return None
    return (now - prev) / prev * 100.0

def _query(engine, sql, **params):
    return pd.read_sql_query(text(sql), engine, params=params)

def kumpulkan(engine, prov, tahun, bulan):
    seri = _query(engine, """
        SELECT tahun, bulan, SUM(jumlah)::bigint AS jumlah
          FROM wisman_series
         WHERE prov=:prov AND tahun IN (:thn, :lalu)
           AND (tahun=:thn OR bulan <= :bln)
         GROUP BY tahun, bulan ORDER BY tahun, bulan
    """, prov=prov, thn=int(tahun), lalu=int(tahun) - 1, bln=int(bulan))
    negara = _query(engine, """
        SELECT negara, SUM(jumlah)::bigint AS jumlah
          FROM wisman_series
         WHERE prov=:prov AND tahun=:thn AND bulan <= :bln
         GROUP BY negara ORDER BY 2 DESC
    """, prov=prov, thn=int(tahun), bln=int(bulan))
    if seri.empty or negara.empty:
        raise ValueError(f"Belum ada data Wisman untuk {prov} {BULAN[int(bulan)]} {tahun}.")
    ini = {int(r.bulan): int(r.jumlah) for r in seri[seri.tahun == int(tahun)].itertuples()}
    lalu = {int(r.bulan): int(r.jumlah) for r in seri[seri.tahun == int(tahun) - 1].itertuples()}
    total = int(negara.jumlah.sum())
    return {"ini": ini, "lalu": lalu, "negara": negara, "total": total}

def build_prompt(engine, prov, tahun, bulan):
    bulan, tahun = int(bulan), int(tahun)
    d = kumpulkan(engine, prov, tahun, bulan)
    ini, lalu, total = d["ini"], d["lalu"], d["total"]

    sekarang = ini.get(bulan, 0)
    sebelumnya = ini.get(bulan - 1) if bulan > 1 else None
    tahun_lalu = lalu.get(bulan)
    kum = sum(v for b, v in ini.items() if b <= bulan)

    baris = []
    for r in d["negara"].head(10).itertuples():
        peran = (int(r.jumlah) / total * 100.0) if total else 0.0
        baris.append(f"- {r.negara}: {_angka(r.jumlah)} kunjungan ({_angka(peran, 2)} persen dari total)")

    def pct_txt(v):
        if v is None:
            return "tidak dapat dibandingkan karena pembandingnya tidak tercatat"
        arah = "naik" if v > 0 else ("turun" if v < 0 else "relatif stabil")
        return f"{arah} {_angka(abs(v), 2)} persen"

    data_str = f"""Jumlah kunjungan wisatawan mancanegara (Wisman) Provinsi {prov}, {BULAN[bulan]} {tahun} (satuan: kunjungan)
- Bulan ini ({BULAN[bulan]} {tahun}): {_angka(sekarang)}
- Bulan lalu ({BULAN[bulan - 1] if bulan > 1 else 'Desember'} {tahun if bulan > 1 else tahun - 1}): {_angka(sebelumnya) if sebelumnya is not None else 'tidak ada data'}
- Perubahan bulan ini vs bulan lalu: {pct_txt(_pct(sekarang, sebelumnya))}
- Bulan yang sama tahun lalu ({BULAN[bulan]} {tahun - 1}): {_angka(tahun_lalu) if tahun_lalu else 'tidak ada data'}
- Perubahan year-on-year: {pct_txt(_pct(sekarang, tahun_lalu))}
- Kumulatif Januari-{BULAN[bulan]} {tahun}: {_angka(kum)}

Negara asal teratas, kumulatif Januari-{BULAN[bulan]} {tahun}:
{chr(10).join(baris)}"""

    return f"""Anda adalah penulis Berita Resmi Statistik (BRS) Badan Pusat Statistik.
Pembaca adalah jurnalis, pelaku usaha, dan pegawai pemerintah non-teknis. Tirulah
gaya narasi BRS BPS: bahasa Indonesia baku, datar, dan objektif; sudut pandang
orang ketiga; tanpa sapaan, tanpa opini, tanpa tafsir sebab-akibat, tanpa
rekomendasi.

TUGAS
Tulis narasi kunjungan wisatawan mancanegara (Wisman) Provinsi {prov} untuk periode
{BULAN[bulan]} {tahun}.

RANGKA PARAGRAF 1 (bulan ini dibanding bulan lalu)
a. Kalimat pembuka: "Jumlah kunjungan wisatawan mancanegara (wisman) ke Provinsi
   {prov} melalui pintu keimigrasian Lintas Batas di Kota Jayapura pada {BULAN[bulan]} {tahun} tercatat sebanyak [angka bulan ini]
   kunjungan, [naik/turun] sebesar [persen] persen dibandingkan
   {BULAN[bulan - 1] if bulan > 1 else 'Desember'} {tahun if bulan > 1 else tahun - 1} yang
   mencapai [angka bulan lalu] kunjungan."
b. Kalimat year-on-year dengan pola yang sama jika data tersedia.
c. Kalimat berdasarkan kawasan asal pada {BULAN[bulan]} {tahun}, kunjungan wisman didominasi oleh kawasan ... sebanyak ... kunjungan, diikuti kawasan ... sebanyak ... kunjungan, ..., dan ... sebanyak ... kunjungan. Sementara itu, tidak tercatat kunjungan wisman yang berasal dari kawasan ... (jika ada).

RANGKA PARAGRAF 2 (kumulatif Januari sampai {BULAN[bulan]} {tahun})
a. Kalimat pembuka kumulatif beserta perbandingan dengan periode yang sama tahun sebelumnya.
b. Berhenti di fakta terakhir. Tidak ada kalimat makna atau kesimpulan.

ATURAN GAYA BRS (WAJIB)
1. Setiap kalimat memuat fakta dari data. Tidak ada kalimat yang hanya menegaskan pentingnya temuan.
2. Tulis "persen", bukan tanda %. Persen selalu 2 desimal.
3. Format angka Indonesia: titik untuk ribuan, koma untuk desimal.
4. Arah perubahan ditentukan angka, bukan selera. Pakai kata baku: naik, turun, meningkat, menurun, stabil. Dilarang: melonjak, anjlok, drastis, tajam, signifikan, komprehensif, mendalam, kontras, fundamental, krusial, kerangka, dinamika, menandakan, mengisyaratkan.
5. Kelompokkan negara ke kawasan (ASEAN, Asia Lainnya, Eropa, Amerika, Afrika, Oceania, Timur Tengah) secara logis berdasarkan negara asal.
6. Jangan menambah angka, penyebab, atau pembanding yang tidak ada di data.
7. Keluaran: teks polos, tepat 2 paragraf, dipisahkan satu baris kosong. Tanpa judul, tanpa markdown, tanpa butir.

Sumber Data:
{data_str}"""
