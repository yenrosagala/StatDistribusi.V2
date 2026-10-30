"""Isi template BRS Exim (IDML) dari angka perdagangan.

Template _Final sudah memuat tabel lengkap (header 3 baris + baris data), dengan
setiap sel dinamai ``baris:kolom``. Pengisi ini hanya menimpa teks sel yang ada
-- tidak membuat sel baru -- sehingga struktur InDesign tetap utuh.

Susunan kolom tabel entitas mengikuti header template:
    0 label | 1 Agt<tahun lalu> | 2 Jul<tahun ini> | 3 Agt<tahun ini>
    4 Jan-Agt<tahun lalu> | 5 Jan-Agt<tahun ini> | 6 peran %
Nilai satu bulan ditulis di kolom 3, bukan kolom 1.

Baris yang datanya tidak ada dikosongkan dengan "-" (aturan b). Bila entitas
pada data MELEBIHI kapasitas tabel, kelebihannya dilaporkan sebagai peringatan,
bukan dibuang diam-diam.
"""
from __future__ import annotations

import io
import re
import zipfile

from lxml import etree

from .indesign_export import _set_cell_text

NAME_RE = re.compile(r"(\d+):(\d+)")

TABEL_RINGKASAN = {"u103b": "ekspor", "u11ed": "impor", "ud37": "neraca"}
TABEL_ENTITAS = {
    "ubda": "ekspor_hs2",
    "ubae": "ekspor_negara",
    "u10de": "ekspor_pelabuhan",
    "u1244": "impor_hs2",
    "u125b": "impor_negara",
}

UNDEFINED = "Undefined"
KOSONG = "-"
KOLOM_BULAN_INI = 3


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


def _teks_cell(cell):
    return "".join((c.text or "") for c in cell.iter("Content")).strip()


def _tulis(cells, x, y, teks, warnings, sid):
    cell = cells.get((x, y))
    if cell is None:
        warnings.append(f"{sid}: sel {x}:{y} tidak ada di template - dilewati.")
        return False
    _set_cell_text(cell, teks)
    return True


def _isi_ringkasan(cells, baris_data, warnings, sid, jenis):
    """Tabel Ringkasan: 3 baris data (Total, Migas, Nonmigas)."""
    total = baris_data[0]["kum_now"] if baris_data else 0.0
    for i, r in enumerate(baris_data):
        y = 3 + i
        _tulis(cells, 0, y, r["label"], warnings, sid)
        _tulis(cells, 1, y, _angka(r["last"]), warnings, sid)
        _tulis(cells, 2, y, _angka(r["prev"]), warnings, sid)
        _tulis(cells, 3, y, _angka(r["now"]), warnings, sid)
        _tulis(cells, 4, y, _angka(r["kum_last"]), warnings, sid)
        _tulis(cells, 5, y, _angka(r["kum_now"]), warnings, sid)
        if jenis == "neraca":
            _tulis(cells, 6, y, _angka(r["now"] - r["prev"]), warnings, sid)
            _tulis(cells, 7, y, _angka(r["kum_now"] - r["kum_last"]), warnings, sid)
            continue
        _tulis(cells, 6, y, _persen(r["mtm"]), warnings, sid)
        _tulis(cells, 7, y, _persen(r["yoy_kum"]), warnings, sid)
        peran = (r["kum_now"] / total * 100.0) if total else 0.0
        _tulis(cells, 8, y, _angka(peran), warnings, sid)


def _isi_entitas(cells, daftar, warnings, sid, label_dari_kode):
    """Isi baris entitas; baris terakhir (Total) dihitung ulang dari data."""
    ys = sorted({y for (_, y) in cells})
    baris_data = [y for y in ys if y >= 3]
    if len(baris_data) < 2:
        warnings.append(f"{sid}: baris data tidak cukup - dilewati.")
        return
    baris_total = baris_data[-1]
    tersedia = [y for y in baris_data if y < baris_total]
    if len(daftar) > len(tersedia):
        warnings.append(
            f"{sid}: {len(daftar)} entitas tidak muat di {len(tersedia)} baris template; "
            f"{len(daftar) - len(tersedia)} entitas terbesar dihilangkan.")
    jumlah = sum(d["nilai"] for d in daftar) or 0.0

    for i, y in enumerate(tersedia):
        if i < len(daftar):
            d = daftar[i]
            _tulis(cells, 0, y, label_dari_kode(d["kode"]), warnings, sid)
            _tulis(cells, KOLOM_BULAN_INI, y, _angka(d["nilai"]), warnings, sid)
            peran = (d["nilai"] / jumlah * 100.0) if jumlah else 0.0
            _tulis(cells, 6, y, _angka(peran), warnings, sid)
            # kolom periode lain belum tersedia -> "-"
            for x in (1, 2, 4, 5):
                if (x, y) in cells:
                    _tulis(cells, x, y, KOSONG, warnings, sid)
        else:
            for x in range(0, 7):
                if (x, y) in cells:
                    _tulis(cells, x, y, KOSONG, warnings, sid)

    # Baris Total: hitung ulang dari data. Kalau dibiarkan, angka template lama
    # (mis. kumulatif 31.160,29) akan tetap tercetak dan menyesatkan.
    kumulatif = sum(d.get("kum", 0.0) for d in daftar) or 0.0
    if (0, baris_total) in cells:
        _tulis(cells, KOLOM_BULAN_INI, baris_total, _angka(jumlah), warnings, sid)
        _tulis(cells, 5, baris_total, _angka(kumulatif), warnings, sid)
        _tulis(cells, 6, baris_total, _angka(100.0 if jumlah else 0.0), warnings, sid)
        for x in (1, 2, 4):
            if (x, baris_total) in cells:
                _tulis(cells, x, baris_total, KOSONG, warnings, sid)


def isi_template_exim(template_bytes, data, label_dari_kode=None, warnings=None):
    """Kembalikan (bytes_idml, warnings)."""
    warnings = list(warnings or [])
    label_dari_kode = label_dari_kode or (lambda k: str(k))

    with zipfile.ZipFile(io.BytesIO(template_bytes)) as zf:
        order = zf.namelist()
        files = {n: zf.read(n) for n in order}

    def proses(sid, fn):
        n = f"Stories/Story_{sid}.xml"
        if n not in files:
            warnings.append(f"{sid}: story tidak ada di template.")
            return
        root = etree.fromstring(files[n])
        tbl = root.find("Story").find(".//Table") if root.find("Story") is not None else None
        if tbl is None:
            warnings.append(f"{sid}: tidak ada <Table>.")
            return
        fn(_cell_map(tbl))
        files[n] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    for sid, jenis in TABEL_RINGKASAN.items():
        proses(sid, lambda cells, sid=sid, jenis=jenis:
               _isi_ringkasan(cells, data.get(f"ringkasan_{jenis}") or [], warnings, sid, jenis))

    for sid, kunci in TABEL_ENTITAS.items():
        proses(sid, lambda cells, sid=sid, kunci=kunci:
               _isi_entitas(cells, data.get(kunci) or [], warnings, sid, label_dari_kode))

    # Peringatan kelengkapan: kolom pembanding (bulan lalu, tahun lalu,
    # kumulatif) hanya benar bila bulan-bulan itu ada di database.
    meta = (data or {}).get("meta") or {}
    tersedia = meta.get("bulan_tersedia") or []
    bln = meta.get("bln")
    if bln and len(tersedia) < bln:
        hilang = [b for b in range(1, bln + 1) if b not in tersedia]
        warnings.append(
            "Data bulan berikut belum tersedia sehingga kolom pembanding dan kumulatif "
            "tidak lengkap: " + ", ".join(str(b) for b in hilang) + ".")

    keluar = io.BytesIO()
    with zipfile.ZipFile(keluar, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, files[n])
    return keluar.getvalue(), warnings
