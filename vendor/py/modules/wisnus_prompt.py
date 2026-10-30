"""Prompt narasi AI untuk kartu Wisnus (dua grafik: seri bulanan & tujuan).

Aturan gaya mengikuti blok "ATURAN GAYA BRS" yang dipakai modul lain
(exim_prompt.py / report_page.py): dua paragraf, tanpa tafsir sebab-akibat,
angka format Indonesia, hanya fakta dari data.
"""
from __future__ import annotations

import pandas as pd
from sqlalchemy import text

BULAN = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]


def _angka(v, desimal=0):
    """Format Indonesia: titik ribuan, koma desimal."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    s = f"{x:,.{desimal}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def label_kabkota(kode, nama):
    """Sama dengan labelKabkota() di wisnus.js: 9471 -> Kota, 9403 -> Kabupaten."""
    bersih = str(nama or kode).replace("PAPUA--", "").title()
    kota = int(str(kode)[-2:] or 0) >= 71
    return f"{'Kota' if kota else 'Kabupaten'} {bersih}"


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
    """Angka yang dipakai prompt: seri bulanan dan kab/kota tujuan teratas."""
    seri = _query(engine, """
        SELECT tahun, bulan, SUM(jumlah)::bigint AS jumlah
          FROM wisnus_series
         WHERE prov=:prov AND arah='tujuan' AND tahun IN (:thn, :lalu)
           AND (tahun=:thn OR bulan <= :bln)
         GROUP BY tahun, bulan ORDER BY tahun, bulan
    """, prov=prov, thn=int(tahun), lalu=int(tahun) - 1, bln=int(bulan))
    # Kelompokkan per kode: 9471 (Kota Jayapura) dan 9403 (Kabupaten Jayapura)
    # bernama sama di berkas, jadi tanpa kode keduanya tergabung.
    tujuan = _query(engine, """
        SELECT kode_kab, nama_kab, SUM(jumlah)::bigint AS jumlah
          FROM wisnus_series
         WHERE prov=:prov AND arah='tujuan' AND tahun=:thn AND bulan <= :bln
         GROUP BY kode_kab, nama_kab ORDER BY 3 DESC
    """, prov=prov, thn=int(tahun), bln=int(bulan))
    if seri.empty or tujuan.empty:
        raise ValueError(f"Belum ada data Wisnus untuk {prov} {BULAN[int(bulan)]} {tahun}.")

    ini = {int(r.bulan): int(r.jumlah) for r in seri[seri.tahun == int(tahun)].itertuples()}
    lalu = {int(r.bulan): int(r.jumlah) for r in seri[seri.tahun == int(tahun) - 1].itertuples()}
    total = int(tujuan.jumlah.sum())
    return {"ini": ini, "lalu": lalu, "tujuan": tujuan, "total": total}


def build_prompt(engine, prov, tahun, bulan):
    bulan, tahun = int(bulan), int(tahun)
    d = kumpulkan(engine, prov, tahun, bulan)
    ini, lalu, total = d["ini"], d["lalu"], d["total"]

    sekarang = ini.get(bulan, 0)
    sebelumnya = ini.get(bulan - 1) if bulan > 1 else None
    tahun_lalu = lalu.get(bulan)
    kum = sum(v for b, v in ini.items() if b <= bulan)
    kum_lalu = sum(v for b, v in lalu.items() if b <= bulan)

    # Sepuluh tujuan teratas dengan kontribusi (satu-satunya angka turunan).
    baris = []
    for r in d["tujuan"].head(10).itertuples():
        peran = (int(r.jumlah) / total * 100.0) if total else 0.0
        baris.append(f"- {label_kabkota(r.kode_kab, r.nama_kab)}: {_angka(r.jumlah)} perjalanan "
                     f"({_angka(peran, 2)} persen dari total)")

    def pct_txt(v):
        if v is None:
            return "tidak dapat dibandingkan karena pembandingnya tidak tercatat"
        arah = "naik" if v > 0 else ("turun" if v < 0 else "relatif stabil")
        return f"{arah} {_angka(abs(v), 2)} persen"

    data_str = f"""Kunjungan Wisnus Provinsi {prov}, {BULAN[bulan]} {tahun} (satuan: perjalanan)
- Bulan ini ({BULAN[bulan]} {tahun}): {_angka(sekarang)}
- Bulan lalu ({BULAN[bulan - 1] if bulan > 1 else 'Desember'} {tahun if bulan > 1 else tahun - 1}): {_angka(sebelumnya) if sebelumnya is not None else 'tidak ada data'}
- Perubahan bulan ini vs bulan lalu: {pct_txt(_pct(sekarang, sebelumnya))}
- Bulan yang sama tahun lalu ({BULAN[bulan]} {tahun - 1}): {_angka(tahun_lalu) if tahun_lalu else 'tidak ada data'}
- Perubahan year-on-year: {pct_txt(_pct(sekarang, tahun_lalu))}
- Kumulatif Januari-{BULAN[bulan]} {tahun}: {_angka(kum)}
- Kumulatif Januari-{BULAN[bulan]} {tahun - 1}: {_angka(kum_lalu) if kum_lalu else 'tidak ada data'}
- Perubahan kumulatif: {pct_txt(_pct(kum, kum_lalu))}

Sepuluh kabupaten/kota tujuan teratas, kumulatif Januari-{BULAN[bulan]} {tahun}:
{chr(10).join(baris)}"""

    return f"""Anda adalah penulis Berita Resmi Statistik (BRS) Badan Pusat Statistik.
Pembaca adalah jurnalis, pelaku usaha, dan pegawai pemerintah non-teknis. Tirulah
gaya narasi BRS BPS: bahasa Indonesia baku, datar, dan objektif; sudut pandang
orang ketiga; tanpa sapaan, tanpa opini, tanpa tafsir sebab-akibat, tanpa
rekomendasi.

TUGAS
Tulis narasi kunjungan wisatawan nusantara (Wisnus) Provinsi {prov} untuk periode
{BULAN[bulan]} {tahun}.

RANGKA PARAGRAF 1 (bulan ini dibanding bulan lalu)
a. Kalimat pembuka: "Jumlah perjalanan wisatawan nusantara (Wisnus) di Provinsi
   {prov} pada {BULAN[bulan]} {tahun} tercatat sebanyak [angka bulan ini]
   perjalanan, [naik/turun] sebesar [persen] persen dibandingkan
   {BULAN[bulan - 1] if bulan > 1 else 'Desember'} [tahun sebelumnya] yang
   mencapai [angka bulan lalu] perjalanan (month-to-month)."
b. Kalimat year-on-year dengan pola yang sama.
c. Kalimat peringkat tujuan: sebut kabupaten/kota tujuan terbesar dan persentase
   kontribusinya, diikuti peringkat berikutnya seperlunya.

RANGKA PARAGRAF 2 (kumulatif Januari sampai {BULAN[bulan]} {tahun})
a. Kalimat pembuka kumulatif beserta perbandingan dengan periode yang sama tahun
   sebelumnya.
b. Kalimat peringkat tujuan secara kumulatif memakai persentase kontribusi.
c. Berhenti di fakta terakhir. Tidak ada kalimat makna atau kesimpulan.

ATURAN GAYA BRS (WAJIB)
1. Setiap kalimat memuat fakta dari data. Tidak ada kalimat yang hanya menegaskan
   pentingnya temuan. Satu kalimat hanya membawa satu gagasan.
2. Tulis "persen", bukan tanda %. Selisih angka persentase ditulis "persen poin".
3. Format angka Indonesia: titik untuk ribuan, koma untuk desimal (1.234,56).
   Persen selalu 2 desimal. Jangan mengubah satuan (tetap "perjalanan").
4. Arah perubahan ditentukan angka, bukan selera. Pakai kata baku: naik, turun,
   meningkat, menurun, stabil. Dilarang: melonjak, anjlok, drastis, tajam,
   signifikan, komprehensif, mendalam, kontras, fundamental, krusial, kerangka,
   dinamika, menandakan, mengisyaratkan, "bukan hanya ... tetapi juga", dan tanda
   pisah panjang (em dash).
5. Daftar entitas memakai pola BRS: "A sebesar x persen, B sebesar y persen, dan
   C sebesar z persen". Urutkan dari nilai terbesar ke terkecil.
6. Singkatan ditulis lengkap sekali pada pemakaian pertama.
7. Jangan menambah angka, penyebab, atau pembanding yang tidak ada di data. Satu-
   satunya angka turunan yang diperbolehkan adalah persentase kontribusi.
8. Keluaran: teks polos, tepat 2 paragraf, dipisahkan satu baris kosong. Tanpa
   judul, tanpa markdown, tanpa butir, tanpa pengantar, tanpa catatan kaki.

Sumber Data:
{data_str}"""
