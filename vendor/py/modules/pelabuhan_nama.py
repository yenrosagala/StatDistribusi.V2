"""Nama pelabuhan dari master Bea Cukai.

Sumber tunggalnya ``pelabuhan-nama.js`` di akar node-app -- berkas yang sama yang
dipakai halaman web (``namaPelabuhan``), hasil salinan dari "Master Pelabuhan
Dalam Negeri 03-06-2024.xls" lewat ``scripts/gen-pelabuhan.mjs``. Dibaca dari JS
supaya Excel, web, dan IDML tidak pernah berbeda daftar.

Dipakai untuk mengubah kode pelabuhan (mis. ``35563``) menjadi namanya
(``TANJUNG PERAK``) pada ekspor Excel.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_AKAR = Path(__file__).resolve().parents[3]
_CACHE: dict | None = None
_SINGKAT_RE = re.compile(r"[A-Za-z]+")


def _muat() -> dict:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    try:
        teks = (_AKAR / "pelabuhan-nama.js").read_text(encoding="utf-8")
    except OSError:
        _CACHE = {}
        return _CACHE
    m = re.search(r"export const PELABUHAN\s*=\s*(\{.*\})\s*;", teks, re.S)
    if not m:
        _CACHE = {}
        return _CACHE
    try:
        _CACHE = json.loads(m.group(1))
    except ValueError:
        _CACHE = {}
    return _CACHE


def nama(kode, bawaan=None):
    """Nama pelabuhan untuk satu kode; kembalikan ``bawaan`` bila tidak dikenal."""
    kode = str(kode).strip()
    entri = _muat().get(kode)
    if entri and entri.get("n"):
        return entri["n"]
    return bawaan if bawaan is not None else kode



def _judul(teks):
    """Samakan gaya penulisan dengan template BRS: "TANJUNG PERAK" -> "Tanjung Perak".

    Singkatan pendek (maksimal 3 huruf, mis. U, PTT, ST, JKT, IJ) dibiarkan
    kapital supaya "(U)" dan "JKT./" tidak berubah jadi "(u)" dan "Jkt./".
    """
    def satu(m):
        kata = m.group(0)
        return kata if len(kata) <= 3 else kata[:1].upper() + kata[1:].lower()
    return _SINGKAT_RE.sub(satu, str(teks))


def label(kode):
    """Nama pelabuhan bergaya BRS, atau kode apa adanya bila tidak ada di master."""
    return _judul(nama(kode, bawaan=str(kode).strip()))
