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


def label(kode):
    """Nama pelabuhan, atau kode apa adanya bila tidak ada di master."""
    return nama(kode, bawaan=str(kode).strip())
