"""Prompt narasi BRS Ekspor-Impor (Exim).

Gaya mengikuti prompt transportasi dan pariwisata: persona penulis BRS, dua
paragraf, fakta saja, tanpa tafsir sebab-akibat. Bedanya di sini objeknya adalah
nilai ekspor/impor (Ribu US$), bukan penumpang atau tingkat hunian.

Satu narasi per bagian: ekspor, impor, dan neraca.
"""
from __future__ import annotations

from .perdagangan_data import kumpulkan_perdagangan

EXIM_PROMPT = """Anda adalah penulis Berita Resmi Statistik (BRS) Badan Pusat Statistik. Pembaca adalah
jurnalis, pelaku usaha, dan pegawai pemerintah non-teknis. Tirulah gaya narasi BRS BPS:
bahasa Indonesia baku, datar, dan objektif; sudut pandang orang ketiga; tanpa sapaan,
tanpa opini, tanpa tafsir sebab-akibat, tanpa rekomendasi.

TUGAS
Tulis narasi bagian {bagian} untuk Provinsi {province}, periode {month_name} {year}.
Pembanding: {prev_month_name} {prev_year} (bulan lalu) dan {month_name} {last_year}
(tahun lalu). Nilai dalam Ribu US$.

MEMBACA DATA
- "Total" adalah angka keseluruhan; "Migas" dan "Nonmigas" adalah rinciannya.
- Baris entitas (golongan HS, negara, pelabuhan) diurutkan dari nilai terbesar.
- Tanda "-" berarti data tidak tersedia pada periode itu. Itu bukan nol. Jangan
  membandingkan entitas yang kosong.
- "Undefined" berarti pembandingnya nol sehingga persentase tidak dapat dihitung.
  Tulis "tidak dapat dibandingkan karena tidak tercatat pada {prev_month_name}
  {prev_year}" untuk entitas itu, jangan menulis persen.

RANGKA PARAGRAF 1 (bulan ini)
a. Kalimat pembuka, pola BRS:
   "Nilai {subjek} Provinsi {province} pada {month_name} {year} tercatat sebesar
   [Total] Ribu US$ atau naik/turun [persentase] persen dibandingkan
   {prev_month_name} {prev_year}."
   Bila Total nol atau tidak ada data, tulis apa adanya: "Tidak ada {subjek}
   Provinsi {province} pada {month_name} {year}." lalu lanjutkan dengan keterangan
   nilai bulan sebelumnya bila ada.
b. Kalimat migas/nonmigas: sebutkan nilai keduanya dan arah perubahannya.
c. Kalimat peringkat: sebut satu atau dua entitas terbesar beserta nilainya dan
   persentase perannya terhadap total.

RANGKA PARAGRAF 2 (kumulatif dan perbandingan tahun lalu)
a. Kalimat pembuka kumulatif:
   "Selama Januari-{month_name} {year}, nilai {subjek} mencapai [kumulatif] Ribu US$."
b. Bandingkan dengan tahun lalu memakai angka yang sama jelasnya; bila pembanding
   tidak tersedia, nyatakan tidak dapat dibandingkan.
c. Berhenti di fakta terakhir. Tidak ada kalimat makna atau kesimpulan.

ATURAN GAYA BRS (WAJIB)
1. Setiap kalimat memuat fakta dari data. Tidak ada kalimat yang hanya menegaskan
   pentingnya temuan. Satu kalimat hanya membawa satu gagasan.
2. Tulis "persen", bukan tanda %. Selisih angka persentase ditulis "persen poin".
3. Format angka Indonesia: titik untuk ribuan, koma untuk desimal (1.234,56).
4. Arah perubahan ditentukan angka, bukan selera. Pakai kata baku: naik, turun,
   meningkat, menurun, stabil. Dilarang: melonjak, anjlok, drastis, tajam,
   signifikan, komprehensif, mendalam, kontras, fundamental, krusial, kerangka,
   dinamika, menandakan, mengisyaratkan, "bukan hanya ... tetapi juga", dan tanda
   pisah panjang (em dash).
5. Daftar entitas memakai pola BRS: "A sebesar x Ribu US$, B sebesar y Ribu US$,
   dan C sebesar z Ribu US$". Urutkan dari nilai terbesar ke terkecil.
6. Singkatan ditulis lengkap sekali pada pemakaian pertama.
7. Jangan menambah angka, penyebab, atau pembanding yang tidak ada di data.
8. Jangan menyebut nilai dalam satuan US$ penuh; selalu Ribu US$.
9. Keluaran: teks polos, tepat 2 paragraf, dipisahkan satu baris kosong. Tanpa
   judul, tanpa markdown, tanpa butir, tanpa pengantar, tanpa catatan kaki,
   tanpa penutup.

Data:
{data_str}
"""

SUBJEK = {
    "ekspor": "ekspor",
    "impor": "impor",
    "neraca": "neraca perdagangan",
}


def _fmt(v):
    try:
        return f"{float(v):,.2f}".replace(",", "\x00").replace(".", ",").replace("\x00", ".")
    except (TypeError, ValueError):
        return "-"


def _persen(v):
    if v is None:
        return "Undefined"
    return f"{float(v):+.2f}".replace(".", ",")


def _tabel_ringkasan(baris):
    head = f"{'Uraian':<12}{'Agt lalu':>12}{'Jul ini':>12}{'Agt ini':>12}{'Kum lalu':>14}{'Kum ini':>14}{'MtM %':>10}{'Kum %':>10}"
    lines = [head]
    for r in baris:
        lines.append(
            f"{r['label']:<12}{_fmt(r['last']):>12}{_fmt(r['prev']):>12}{_fmt(r['now']):>12}"
            f"{_fmt(r['kum_last']):>14}{_fmt(r['kum_now']):>14}"
            f"{_persen(r['mtm']):>10}{_persen(r['yoy_kum']):>10}")
    return "\n".join(lines)


def _tabel_entitas(judul, daftar, label):
    lines = [judul, f"{'Entitas':<40}{'Agt ini':>14}{'Kum ini':>14}{'% Peran':>10}"]
    total = sum(d["nilai"] for d in daftar) or 0.0
    for d in daftar:
        peran = (d["nilai"] / total * 100.0) if total else 0.0
        lines.append(f"{label(d['kode']):<40}{_fmt(d['nilai']):>14}{_fmt(d.get('kum', 0.0)):>14}{_fmt(peran):>10}")
    return "\n".join(lines)


def build_prompt(engine, province, year, month, bagian, label_dari_kode=None):
    """Bangun prompt untuk satu bagian: 'ekspor' | 'impor' | 'neraca'."""
    if bagian not in SUBJEK:
        raise ValueError(f"bagian tidak dikenal: {bagian}")
    label = label_dari_kode or (lambda k: str(k))
    data = kumpulkan_perdagangan(engine, province, year, month)
    meta = data["meta"]

    blok = [_tabel_ringkasan(data[f"ringkasan_{bagian}"])]
    if bagian == "ekspor":
        blok.append(_tabel_entitas("Golongan HS 2 digit (ekspor)", data["ekspor_hs2"], label))
        blok.append(_tabel_entitas("Negara tujuan (ekspor)", data["ekspor_negara"], label))
        blok.append(_tabel_entitas("Pelabuhan muat (ekspor)", data["ekspor_pelabuhan"], label))
    elif bagian == "impor":
        blok.append(_tabel_entitas("Golongan HS 2 digit (impor)", data["impor_hs2"], label))
        blok.append(_tabel_entitas("Negara asal (impor)", data["impor_negara"], label))

    prompt = EXIM_PROMPT.format(
        bagian=bagian,
        subjek=SUBJEK[bagian],
        province=province,
        month_name=meta["bln_nama"],
        year=meta["thn"],
        prev_month_name=meta["prev_bln_nama"],
        prev_year=meta["prev_thn"],
        last_year=meta["last_thn"],
        data_str="\n\n".join(blok),
    )
    return prompt, data
