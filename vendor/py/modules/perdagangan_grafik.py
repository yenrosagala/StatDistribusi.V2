"""Grafik batang untuk paket Excel modul Perdagangan.

Angka di grafik memakai kaidah Indonesia: titik sebagai pemisah ribuan, koma
sebagai pemisah desimal, dan dua angka di belakang koma -- sama dengan tabel di
halaman web dan di BRS. Label nilai digambar di atas setiap batang supaya
pembaca tidak perlu menaksir dari sumbu Y.
"""
from __future__ import annotations

import io

# Warna seri mengikuti grafik halaman web (lihat perdagangan laporan di
# views.js): tahun lalu hijau, tahun berjalan jingga.
WARNA_SERI = ("#70AD47", "#ED7D31")


def angka_id(v, desimal=2):
    """1234.5 -> '1.234,50' (titik ribuan, koma desimal)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    s = f"{x:,.{desimal}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def grafik_batang(judul, labels, seri, satuan="Ribu US$",
                  lebar_in=9.0, tinggi_in=3.8, dpi=200, desimal=2):
    """PNG grafik batang berkelompok dengan label nilai di atas batang.

    ``labels``  : teks sumbu X (satu per kelompok).
    ``seri``    : list ``(nama_seri, daftar_nilai)``; warna diambil berurutan
                  dari ``WARNA_SERI``.
    Kembalikan ``bytes`` PNG, atau ``None`` bila tidak ada data untuk digambar.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = list(labels or [])
    seri = [(nama, list(nilai)) for nama, nilai in (seri or [])]
    if not labels or not seri:
        return None
    # Grafik tanpa angka sama sekali tidak perlu dibuat.
    if not any(abs(float(v or 0)) > 0 for _, nilai in seri for v in nilai):
        return None

    import numpy as np

    x = np.arange(len(labels))
    lebar = 0.8 / max(len(seri), 1)

    fig, ax = plt.subplots(figsize=(lebar_in, tinggi_in), dpi=dpi)
    for i, (nama, nilai) in enumerate(seri):
        posisi = x - 0.4 + lebar * (i + 0.5)
        batang = ax.bar(posisi, [float(v or 0) for v in nilai], lebar,
                        label=nama, color=WARNA_SERI[i % len(WARNA_SERI)])
        # Label nilai: format Indonesia, dua desimal.
        ax.bar_label(batang,
                     labels=[angka_id(v, desimal) for v in nilai],
                     padding=2, fontsize=6.5, rotation=90, color="#334155")

    ax.set_title(judul, fontsize=10, fontweight="bold", pad=10)
    ax.set_ylabel(satuan, fontsize=8)
    ax.set_xticks(x)
    ax.set_xticklabels([str(l) for l in labels], rotation=30, ha="right", fontsize=7.5)
    ax.tick_params(axis="y", labelsize=7)
    ax.grid(axis="y", color="#E2E8F0", linewidth=0.8)
    ax.set_axisbelow(True)
    for sisi in ("top", "right"):
        ax.spines[sisi].set_visible(False)
    ax.legend(fontsize=7.5, frameon=False, ncol=len(seri), loc="upper right")
    # Ruang ekstra di atas untuk label nilai yang diputar tegak.
    ax.margins(y=0.18)
    fig.tight_layout()

    keluaran = io.BytesIO()
    fig.savefig(keluaran, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig)
    keluaran.seek(0)
    return keluaran.getvalue()
