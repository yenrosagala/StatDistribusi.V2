"""Isi template BRS Exim (IDML) dari angka perdagangan.

Template _Final sudah memuat seluruh tabel lengkap beserta labelnya, dan setiap
sel dinamai ``baris:kolom``. Pengisi ini hanya menimpa teks sel, tidak membuat
sel baru, sehingga struktur InDesign tetap utuh.

Tiga aturan yang menentukan bentuk modul ini:

1. **Kolom 0 tidak pernah ditimpa.** Kolom itu memuat label dan struktur
   berjenjang template (``Total Ekspor (A+B)``, ``A. Melalui Papua Selatan``,
   ``Nonmigas``/``Migas``, ``Total 6 Negara Utama``, ``Lainnya``). Menulis data
   ke sana akan meratakan tabel dan menghapus subjudulnya.

2. **Subtotal dan baris ``Lainnya`` dihitung ulang dari data**, bukan diisi
   entitas. ``Lainnya`` adalah *sisa*: nilai induknya dikurangi baris-baris
   tetap di atasnya. Dengan begitu tabel selalu berjumlah dan tidak ada entitas
   yang hilang -- entitas di luar daftar tetap template ikut melebur ke sini.

3. **Hanya kolom yang datanya ada yang diisi.** Basis data baru menyimpan
   bulan berjalan dan kumulatif tahun berjalan; bulan lalu, tahun lalu, dan
   kumulatif tahun lalu dibiarkan ``-``.

Susunan kolom tabel entitas mengikuti header template:
    0 label | 1 Agt<tahun lalu> | 2 Jul<tahun ini> | 3 Agt<tahun ini>
    4 Jan-Agt<tahun lalu> | 5 Jan-Agt<tahun ini> | 6 peran % (atau perubahan)
    7 peran % (khusus ubda, yang punya kolom perubahan tersendiri)

Basis angka (jangan dilanggar): ekspor resmi PROVORIG, impor KPPBC. Rincian
pelabuhan pada BRS memecah total resmi menurut pelabuhan muat, jadi memakai
baris PROVORIG yang dikelompokkan per pelabuhan -- bukan basis POD, yang
nilainya tidak menjumlah ke total resmi.
"""
from __future__ import annotations

import io
import re
import zipfile

from lxml import etree

from .indesign_export import _set_cell_text

NAME_RE = re.compile(r"(\d+):(\d+)")

# Story -> arus tabel Ringkasan.
TABEL_RINGKASAN = {"u103b": "ekspor", "u11ed": "impor"}
SID_NERACA = "ud37"

KOLOM_NOW = 3
KOLOM_KUM = 5
KOSONG = "-"

# Kode pelabuhan di wilayah Papua Selatan (prefix kode Bea Cukai 95xx:
# Merauke, Mappi, Asmat, Boven Digoel). Dipakai memisah baris
# "A. Melalui Papua Selatan" dari "B. Melalui Provinsi Lain".
PREFIX_PAPUA_SELATAN = "95"

UNDEFINED = "Undefined"

# ---------------------------------------------------------------------------
# Spesifikasi tabel entitas.
#
# Jenis tiap baris:
#   {"entitas": kode}          cocokkan kode entitas pada data
#   {"dari_ringkasan": label}  ambil dari tabel Ringkasan (Migas/Nonmigas)
#   {"total": True}            total resmi periode
#   {"subtotal": [y, ...]}     jumlah baris-baris lain
#   {"sisa": {"induk": y, "kurangi": [y, ...]}}   sisa = induk - kurangi
#   {"pelabuhan_ps": True}     jumlah pelabuhan ber-prefix Papua Selatan
#
# "x_peran" = kolom persentase peran; "x_perubahan" = kolom perubahan bila
# tabel punya kolom itu terpisah (ubda).
# ---------------------------------------------------------------------------
SPESIFIKASI = {
    # Ekspor menurut golongan HS 2 digit.
    "ubda": {
        "kunci": "ekspor_hs2",
        "ringkasan": "ekspor",
        "x_peran": 7,
        "x_perubahan": 6,
        "baris": [
            {"y": 3, "dari_ringkasan": "Nonmigas"},
            {"y": 4, "entitas": "44"},
            {"y": 5, "entitas": "05"},
            {"y": 6, "entitas": "07"},
            {"y": 7, "entitas": "18"},
            {"y": 8, "sisa": {"induk": 3, "kurangi": [4, 5, 6, 7]}},
            {"y": 9, "dari_ringkasan": "Migas"},
            {"y": 10, "total": True},
        ],
    },
    # Ekspor menurut negara tujuan.
    "ubae": {
        "kunci": "ekspor_negara",
        "ringkasan": "ekspor",
        "x_peran": 6,
        "baris": [
            {"y": 3, "entitas": "MY"},
            {"y": 4, "entitas": "JP"},
            {"y": 5, "entitas": "HK"},
            {"y": 6, "entitas": "NL"},
            {"y": 7, "entitas": "IN"},
            {"y": 8, "entitas": "CN"},
            {"y": 9, "subtotal": [3, 4, 5, 6, 7, 8]},
            {"y": 10, "sisa": {"induk": 11, "kurangi": [3, 4, 5, 6, 7, 8]}},
            {"y": 11, "total": True},
        ],
    },
    # Ekspor menurut pelabuhan muat: total resmi dipecah A (pelabuhan di Papua
    # Selatan) + B (pelabuhan di provinsi lain).
    "u10de": {
        "kunci": "ekspor_pelabuhan_resmi",
        "ringkasan": "ekspor",
        "x_peran": 6,
        "baris": [
            {"y": 3, "total": True},
            {"y": 4, "pelabuhan_ps": True},
            {"y": 5, "entitas": "95979"},                       # Merauke
            {"y": 6, "sisa": {"induk": 3, "kurangi": [4]}},      # B = Total - A
            {"y": 7, "entitas": "31434"},                       # Soekarno-Hatta
            {"y": 8, "entitas": "35563"},                       # Tanjung Perak
            {"y": 9, "entitas": "35587"},                       # Juanda
            {"y": 10, "entitas": "94983"},                      # Sentani
            {"y": 11, "sisa": {"induk": 6, "kurangi": [7, 8, 9, 10]}},
        ],
    },
    # Impor menurut golongan HS 2 digit.
    "u1244": {
        "kunci": "impor_hs2",
        "ringkasan": "impor",
        "x_peran": 6,
        "baris": [
            {"y": 3, "dari_ringkasan": "Nonmigas"},
            {"y": 4, "entitas": "84"},
            {"y": 5, "entitas": "09"},
            {"y": 6, "entitas": "16"},
            {"y": 7, "entitas": "19"},
            {"y": 8, "entitas": "12"},
            {"y": 9, "entitas": "08"},
            {"y": 10, "entitas": "88"},
            {"y": 11, "entitas": "85"},
            {"y": 12, "entitas": "73"},
            {"y": 13, "entitas": "38"},
            {"y": 14, "sisa": {"induk": 3,
                               "kurangi": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]}},
            {"y": 15, "dari_ringkasan": "Migas"},
            {"y": 16, "total": True},
        ],
    },
    # Impor menurut negara asal.
    "u125b": {
        "kunci": "impor_negara",
        "ringkasan": "impor",
        "x_peran": 6,
        "baris": [
            {"y": 3, "entitas": "CN"},
            {"y": 4, "entitas": "DE"},
            {"y": 5, "entitas": "PG"},
            {"y": 6, "entitas": "PH"},
            {"y": 7, "entitas": "TW"},
            {"y": 8, "entitas": "AU"},
            {"y": 9, "entitas": "NZ"},
            {"y": 10, "subtotal": [3, 4, 5, 6, 7, 8, 9]},
            {"y": 11, "sisa": {"induk": 12, "kurangi": [3, 4, 5, 6, 7, 8, 9]}},
            {"y": 12, "total": True},
        ],
    },
}

# Beberapa sumber memakai kode negara berbeda untuk negara yang sama.
ALIAS_NEGARA = {"UK": "GB", "USA": "US", "HKG": "HK", "CHN": "CN"}


def _angka(v, desimal=2):
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    s = f"{x:,.{desimal}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _persen(v):
    return UNDEFINED if v is None else _angka(v, 2)


def _cell_map(tbl):
    out = {}
    for c in tbl.findall("Cell"):
        m = NAME_RE.fullmatch(c.get("Name") or "")
        if m:
            out[(int(m.group(1)), int(m.group(2)))] = c
    return out


def _tulis(cells, x, y, teks):
    """Tulis sel bila ada; kolom yang tidak dipakai template dilewati diam-diam."""
    cell = cells.get((x, y))
    if cell is None:
        return False
    _set_cell_text(cell, teks)
    return True


def _kunci_entitas(kode):
    k = str(kode).strip().upper()
    return ALIAS_NEGARA.get(k, k)


def _ringkasan(data, jenis):
    """{label(lower): baris} dari tabel Ringkasan arus tertentu."""
    return {str(r.get("label", "")).strip().lower(): r
            for r in (data.get(f"ringkasan_{jenis}") or [])}


def _pct(now, prev):
    """Perubahan relatif (persen); None bila pembandingnya nol."""
    try:
        now, prev = float(now), float(prev)
    except (TypeError, ValueError):
        return None
    if prev == 0:
        return None
    return (now - prev) / prev * 100.0


def _tulis_baris(cells, y, v, total_kum, spec, tersedia):
    """Tulis satu baris tabel entitas dari lima metriknya.

    ``tersedia`` menandai kolom pembanding mana yang punya data. Kolom tanpa
    data ditulis "-" supaya tidak terbaca sebagai realisasi nol.
    """
    _tulis(cells, 1, y, _angka(v["last"]) if tersedia["last"] else KOSONG)
    _tulis(cells, 2, y, _angka(v["prev"]) if tersedia["prev"] else KOSONG)
    _tulis(cells, KOLOM_NOW, y, _angka(v["now"]))
    _tulis(cells, 4, y, _angka(v["kum_last"]) if tersedia["kum_last"] else KOSONG)
    _tulis(cells, KOLOM_KUM, y, _angka(v["kum"]))

    x_perubahan = spec.get("x_perubahan")
    if x_perubahan is not None:
        if not tersedia["kum_last"]:
            _tulis(cells, x_perubahan, y, KOSONG)
        else:
            _tulis(cells, x_perubahan, y, _persen(_pct(v["kum"], v["kum_last"])))

    x_peran = spec.get("x_peran")
    if x_peran is not None:
        peran = (v["kum"] / total_kum * 100.0) if total_kum else 0.0
        _tulis(cells, x_peran, y, _angka(peran))


def _isi_ringkasan(cells, baris_data, tersedia):
    """Tabel Ringkasan ekspor/impor: 3 baris (Total, Migas, Nonmigas)."""
    total_kum = float(baris_data[0]["kum_now"]) if baris_data else 0.0
    for i, r in enumerate(baris_data):
        y = 3 + i
        _tulis(cells, 1, y, _angka(r["last"]) if tersedia["last"] else KOSONG)
        _tulis(cells, 2, y, _angka(r["prev"]) if tersedia["prev"] else KOSONG)
        _tulis(cells, 3, y, _angka(r["now"]))
        _tulis(cells, 4, y, _angka(r["kum_last"]) if tersedia["kum_last"] else KOSONG)
        _tulis(cells, 5, y, _angka(r["kum_now"]))
        _tulis(cells, 6, y, _persen(r["mtm"]) if tersedia["prev"] else KOSONG)
        _tulis(cells, 7, y, _persen(r["yoy_kum"]) if tersedia["kum_last"] else KOSONG)
        peran = (float(r["kum_now"]) / total_kum * 100.0) if total_kum else 0.0
        _tulis(cells, 8, y, _angka(peran))


def _isi_neraca(cells, data_ekspor, data_impor, ket):
    """Tabel Neraca: baris Ekspor, Impor, Neraca Perdagangan.

    Template meminta tiga arus, bukan rincian migas/nonmigas -- jadi ambil baris
    Total dari masing-masing tabel Ringkasan lalu selisihkan.

    Dua kolom terakhir tabel ini berisi **selisih absolut** dalam Ribu US$
    (header: "Perubahan ... (Ribu US$)"), bukan persen seperti tabel Ringkasan
    ekspor/impor.
    """
    e = data_ekspor[0] if data_ekspor else {}
    i = data_impor[0] if data_impor else {}

    def ambil(r, k):
        return float(r.get(k) or 0.0)

    def selisih(k):
        return ambil(e, k) - ambil(i, k)

    # Neraca hanya bermakna bila kedua arus punya data pada periode itu.
    gabung = {k: (ket["ekspor"][k] and ket["impor"][k])
              for k in ("last", "prev", "kum_last")}
    baris = [
        (3, {k: ambil(e, k) for k in ("last", "prev", "now", "kum_last", "kum_now")},
         ket["ekspor"]),
        (4, {k: ambil(i, k) for k in ("last", "prev", "now", "kum_last", "kum_now")},
         ket["impor"]),
        (5, {k: selisih(k) for k in ("last", "prev", "now", "kum_last", "kum_now")},
         gabung),
    ]
    for y, nilai, tersedia in baris:
        for x, k in ((1, "last"), (2, "prev"), (3, "now"), (4, "kum_last"), (5, "kum_now")):
            if k in ("now", "kum_now"):
                # Nilai periode berjalan selalu dicetak.
                _tulis(cells, x, y, _angka(nilai[k]))
            else:
                _tulis(cells, x, y, _angka(nilai[k]) if tersedia[k] else KOSONG)
        _tulis(cells, 6, y,
               _angka(nilai["now"] - nilai["prev"]) if tersedia["prev"] else KOSONG)
        _tulis(cells, 7, y,
               _angka(nilai["kum_now"] - nilai["kum_last"]) if tersedia["kum_last"] else KOSONG)


def _isi_entitas(cells, spec, daftar, ringkasan, warnings, sid, ket):
    """Isi tabel entitas tanpa menyentuh label dan tanpa membuang entitas."""
    tersedia = {}
    for r in daftar or []:
        tersedia[_kunci_entitas(r.get("kode"))] = {
            "now": float(r.get("nilai") or 0.0),
            "prev": float(r.get("prev") or 0.0),
            "last": float(r.get("last") or 0.0),
            "kum": float(r.get("kum") or 0.0),
            "kum_last": float(r.get("kum_last") or 0.0),
        }

    total = ringkasan.get("total") or {}
    total_kum = float(total.get("kum_now") or 0.0)
    nilai = {}          # y -> dict lima metrik
    terpakai = set()    # kode entitas yang tampil di baris tetap

    METRIK = ("now", "prev", "last", "kum", "kum_last")

    def kosong():
        return {k: 0.0 for k in METRIK}

    def ambil(kode):
        return tersedia.get(_kunci_entitas(kode)) or kosong()

    def hitung(b):
        """Hitung satu baris non-sisa."""
        y = b["y"]
        if "entitas" in b:
            k = _kunci_entitas(b["entitas"])
            terpakai.add(k)
            nilai[y] = dict(ambil(k))
        elif "pelabuhan_ps" in b:
            kode_ps = {k for k in tersedia if k[:2] == PREFIX_PAPUA_SELATAN}
            terpakai.update(kode_ps)
            nilai[y] = {m: sum(tersedia[k][m] for k in kode_ps) for m in METRIK}
        elif "dari_ringkasan" in b:
            r = ringkasan.get(str(b["dari_ringkasan"]).lower()) or {}
            nilai[y] = {
                "now": float(r.get("now") or 0.0),
                "prev": float(r.get("prev") or 0.0),
                "last": float(r.get("last") or 0.0),
                "kum": float(r.get("kum_now") or 0.0),
                "kum_last": float(r.get("kum_last") or 0.0),
            }
        elif b.get("total"):
            nilai[y] = {
                "now": float(total.get("now") or 0.0),
                "prev": float(total.get("prev") or 0.0),
                "last": float(total.get("last") or 0.0),
                "kum": total_kum,
                "kum_last": float(total.get("kum_last") or 0.0),
            }
        elif "subtotal" in b:
            nilai[y] = {m: sum(nilai[yy][m] for yy in b["subtotal"]) for m in METRIK}

    # Baris "sisa" boleh menunjuk induk yang didefinisikan sesudahnya (mis. baris
    # Total di bawah "Lainnya"), jadi dihitung pada lintasan kedua.
    for b in spec["baris"]:
        if "sisa" not in b:
            hitung(b)
    for b in spec["baris"]:
        if "sisa" in b:
            induk = nilai[b["sisa"]["induk"]]
            kurang = {m: sum(nilai[yy][m] for yy in b["sisa"]["kurangi"]) for m in METRIK}
            nilai[b["y"]] = {m: induk[m] - kurang[m] for m in METRIK}
            if nilai[b["y"]]["now"] < 0 or nilai[b["y"]]["kum"] < 0:
                warnings.append(
                    f"{sid}: baris {b['y']} bernilai negatif "
                    f"({_angka(nilai[b['y']]['kum'])}); periksa kelengkapan data "
                    "periode ini.")

    for b in spec["baris"]:
        _tulis_baris(cells, b["y"], nilai[b["y"]], total_kum, spec, ket)

    # Entitas di luar daftar tetap tidak hilang: semuanya melebur ke "Lainnya".
    dilipat = set(tersedia) - terpakai
    if dilipat:
        warnings.append(
            f"{sid}: {len(dilipat)} entitas di luar daftar tetap template "
            "dijumlahkan ke baris sisa (Lainnya).")


def _perbarui_keterangan(files, meta):
    """Ganti provinsi dan periode pada judul/catatan yang tertulis di template.

    Template BRS Exim disimpan dengan judul contoh "… Papua Selatan, Agustus
    2026". Tanpa langkah ini, rilis September pun tetap berjudul Agustus.
    Penggantian dilakukan pada teks mentah XML supaya seluruh story ikut,
    termasuk yang tidak memuat tabel.
    """
    prov = (meta or {}).get("prov")
    bln_nama = (meta or {}).get("bln_nama")
    thn = (meta or {}).get("thn")
    if not (prov and bln_nama and thn):
        return
    ganti = [("Papua Selatan", str(prov)), ("Agustus 2026", f"{bln_nama} {thn}")]
    for nama, isi in list(files.items()):
        if not (nama.startswith("Stories/") and nama.endswith(".xml")):
            continue
        teks = isi.decode("utf-8", "ignore")
        baru = teks
        for lama, kini in ganti:
            baru = baru.replace(lama, kini)
        if baru != teks:
            files[nama] = baru.encode("utf-8")


def isi_template_exim(template_bytes, data, label_dari_kode=None, warnings=None):
    """Kembalikan (bytes_idml, warnings).

    ``label_dari_kode`` tidak dipakai lagi: label template tidak pernah ditimpa.
    Parameternya dipertahankan agar pemanggil lama tetap jalan.
    """
    warnings = list(warnings or [])
    data = data or {}

    def ketersediaan(arus):
        """Kolom pembanding mana yang punya data; default anggap ada."""
        k = ((data.get("meta") or {}).get("ketersediaan") or {}).get(arus) or {}
        return {nama: bool(k.get(nama, True))
                for nama in ("prev", "last", "kum_last")}

    ket = {"ekspor": ketersediaan("ekspor"), "impor": ketersediaan("impor")}

    with zipfile.ZipFile(io.BytesIO(template_bytes)) as zf:
        order = zf.namelist()
        files = {n: zf.read(n) for n in order}

    _perbarui_keterangan(files, data.get("meta"))

    def proses(sid, fn):
        n = f"Stories/Story_{sid}.xml"
        if n not in files:
            warnings.append(f"{sid}: story tidak ada di template.")
            return
        root = etree.fromstring(files[n])
        story = root.find("Story")
        tbl = story.find(".//Table") if story is not None else None
        if tbl is None:
            warnings.append(f"{sid}: tidak ada <Table>.")
            return
        fn(_cell_map(tbl))
        files[n] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    for sid, jenis in TABEL_RINGKASAN.items():
        proses(sid, lambda cells, jenis=jenis:
               _isi_ringkasan(cells, data.get(f"ringkasan_{jenis}") or [], ket[jenis]))

    proses(SID_NERACA, lambda cells:
           _isi_neraca(cells, data.get("ringkasan_ekspor") or [],
                       data.get("ringkasan_impor") or [], ket))

    for sid, spec in SPESIFIKASI.items():
        proses(sid, lambda cells, sid=sid, spec=spec:
               _isi_entitas(cells, spec, data.get(spec["kunci"]) or [],
                            _ringkasan(data, spec["ringkasan"]), warnings, sid,
                            ket[spec["ringkasan"]]))

    # Laporkan kolom mana yang kosong karena datanya memang tidak ada.
    kosong = []
    for arus, label in (("ekspor", "Ekspor"), ("impor", "Impor")):
        k = ket[arus]
        if not k["last"]:
            kosong.append(f"{label}: bulan yang sama tahun lalu")
        if not k["prev"]:
            kosong.append(f"{label}: bulan lalu")
        if not k["kum_last"]:
            kosong.append(f"{label}: kumulatif tahun lalu")
    if kosong:
        warnings.append(
            'Kolom pembanding yang datanya tidak tersedia diisi "-": '
            + "; ".join(kosong) + ".")

    keluar = io.BytesIO()
    with zipfile.ZipFile(keluar, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, files[n])
    return keluar.getvalue(), warnings
