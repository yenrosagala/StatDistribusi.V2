"""Render PowerPoint / Word / InDesign exports for the Node dashboard.

The Node app owns the HTTP surface; this script owns the document formats. It
calls the Streamlit project's own builders instead of re-implementing OOXML or
IDML in JavaScript, so both apps produce identical files.

Usage:  python export_bridge.py <kind> <payload.json> <out-file>
        python export_bridge.py --version   (selftest: imports the real deps)
kinds:  pptx | docx | idml-transport | idml-pariwisata
"""

import io
import json
import logging
import os
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "py"
ROOT = HERE.parent
# Prefer the vendored copy so node-app works standalone; fall back to the
# sibling Streamlit project when it is present (keeps both in sync).
for _p in (ROOT, VENDOR):  # inserted last = highest priority
    if _p.exists() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
os.chdir(HERE)  # keep relative asset paths inside node-app


logging.disable(logging.WARNING)


def _chart_png(chart, width=1100, height=400):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = chart["labels"]
    datasets = chart["datasets"]
    x = list(range(len(labels)))
    fig, ax = plt.subplots(figsize=(width / 100, height / 100), dpi=100)
    bottom = [0.0] * len(labels)
    for ds in datasets:
        y = [0.0 if v is None else float(v) for v in ds["data"]]
        ax.bar(x, y, bottom=bottom, width=0.62, color=ds.get("color") or "#1F4E79", label=ds["label"])
        bottom = [b + v for b, v in zip(bottom, y)]
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=10, color="#333333")
    if chart.get("title"):
        ax.set_title(chart["title"], fontsize=13, color="#0F172A")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.08), ncol=max(1, len(datasets)), frameon=False)
    ax.yaxis.grid(True, color="#D9D9D9", linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    fig.tight_layout(pad=0.6)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


def build_pptx(payload):
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    def title_slide(slide, text):
        box = slide.shapes.add_textbox(Inches(0.4), Inches(0.2), Inches(12.5), Inches(0.7))
        frame = box.text_frame
        frame.text = text
        run = frame.paragraphs[0].runs[0]
        run.font.size = Pt(24)
        run.font.bold = True

    def add_table(slide, table, left, top, width, height):
        columns = table["columns"]
        rows = table["rows"]
        shape = slide.shapes.add_table(len(rows) + 1, len(columns), left, top, width, height)
        grid = shape.table
        for j, head in enumerate(columns):
            grid.cell(0, j).text = str(head)
        for i, row in enumerate(rows, start=1):
            for j, value in enumerate(row):
                grid.cell(i, j).text = "" if value is None else str(value)
        for r_i, row in enumerate(grid.rows):
            row.height = Inches(0.3)
            for cell in row.cells:
                for para in cell.text_frame.paragraphs:
                    for run in para.runs:
                        run.font.size = Pt(9)
                        if r_i == 0:
                            run.font.bold = True

    def add_narration(slide, paras, left, top, width, height):
        box = slide.shapes.add_textbox(left, top, width, height)
        frame = box.text_frame
        frame.word_wrap = True
        first = True
        for text in paras:
            para = frame.paragraphs[0] if first else frame.add_paragraph()
            para.text = text or ""
            first = False
            for run in para.runs:
                run.font.size = Pt(11)

    for sec in payload["sections"]:
        head = f"Transportasi {sec['moda']} — {sec['bln']} {sec['thn']}"

        s1 = prs.slides.add_slide(prs.slide_layouts[6])
        title_slide(s1, f"{head}: Grafik")
        x = Inches(0.4)
        for chart in sec.get("charts", []):
            png = _chart_png(chart)
            s1.shapes.add_picture(io.BytesIO(png), x, Inches(1.1), width=Inches(6.15))
            x += Inches(6.15) + Inches(0.25)

        s2 = prs.slides.add_slide(prs.slide_layouts[6])
        title_slide(s2, f"{head}: Tabel & Narasi")
        tables = sec.get("tables", [])
        if len(tables) > 0:
            add_table(s2, tables[0], Inches(0.4), Inches(1.1), Inches(6.15), Inches(2.2))
        if len(tables) > 1:
            add_table(s2, tables[1], Inches(6.8), Inches(1.1), Inches(6.15), Inches(2.2))
        add_narration(s2, sec.get("narration", []), Inches(0.4), Inches(3.6), Inches(12.5), Inches(3.6))

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


BATAS_NARASI_IDML = 420   # karakter per paragraf di dalam frame .idml


def _ringkas_untuk_idml(teks, batas=BATAS_NARASI_IDML):
    """Ambil kalimat utuh sepanjang batas; kalimat pertama selalu ikut.

    Template BRS punya frame teks dengan tinggi tetap, sedangkan narasi gaya BRS
    bisa tiga kalimat panjang per paragraf. Memotong di batas kalimat membuat
    isinya tetap utuh secara bahasa dan tidak memotong angka di tengah.
    """
    import re

    teks = " ".join(str(teks or "").split())
    if not teks:
        return ""
    kalimat = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\u201c\"])", teks)
    keluaran = kalimat[0]
    for s in kalimat[1:]:
        if len(keluaran) + 1 + len(s) > batas:
            break
        keluaran += " " + s
    return keluaran


def _narasi_tersimpan(item):
    """Narasi AI yang juga tampil di halaman web, dipecah jadi dua paragraf."""
    import re

    from modules.report_page import get_db_narrative

    report_type = f"report_{item['moda']}_{item['label']}"
    period_key = f"{item['prov']}|{item['bln']}|{item['thn']}"
    try:
        teks = get_db_narrative(report_type, period_key)
    except Exception:
        return None
    if not teks:
        return None
    paras = [p.strip() for p in re.split(r"\n\s*\n", str(teks).replace("**", "")) if p.strip()]
    if not paras:
        return None
    return (_ringkas_untuk_idml(paras[0]),
            _ringkas_untuk_idml(" ".join(paras[1:])))


def _report_items(prov, thn, bln):
    from modules.report_page import collect_report_tables, generate_narrative_fallback, normalize_narrative

    items = collect_report_tables(prov, thn, bln)
    for item in items:
        # Urutan sama dengan halaman web: narasi tersimpan dulu, generator statis
        # hanya kalau periode ini belum punya narasi.
        pasangan = _narasi_tersimpan(item)
        if pasangan:
            item["p1"], item["p2"] = pasangan
            continue
        region_label = "Bandara" if item["moda"] == "Transportasi Udara" else "Pelabuhan/Kabupaten"
        p1, p2 = generate_narrative_fallback(
            report_flat=item["report_flat"], col_target=item["col_target"], moda=item["moda"],
            region_label=region_label, bln=item["bln"], thn=item["thn"],
            prev_bln=item["prev_bln"], prev_thn=item["prev_thn"],
            col_prev=item["col_prev"], col_curr=item["col_curr"],
            col_cum_prev=item["col_cum_prev"], col_cum_curr=item["col_cum_curr"], prov=item["prov"],
        )
        item["p1"] = normalize_narrative(p1, item["col_target"])
        item["p2"] = normalize_narrative(p2, item["col_target"])
    return items


def build_docx(payload):
    from modules.report_page import create_complete_master_word_report

    prov, thn, bln = payload["prov"], int(payload["thn"]), payload["bln"]
    items = _report_items(prov, thn, bln)
    if not items:
        raise SystemExit(f"Tidak ada data untuk {prov} {bln} {thn}.")
    stream = create_complete_master_word_report(prov, thn, bln, items)
    return stream.getvalue()


def build_xlsx_transport(payload):
    from modules.report_page import collect_report_tables
    import io
    import pandas as pd

    prov, thn, bln = payload["prov"], int(payload["thn"]), payload["bln"]
    items = collect_report_tables(prov, thn, bln)
    if not items:
        raise SystemExit(f"Tidak ada data untuk {prov} {bln} {thn}.")
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        for item in items:
            df = item.get("report_display_brs").copy() if item.get("report_display_brs") is not None else None
            if df is None:
                continue
            sheet_name = f"{item['table_no']}. {item['label']}"[:31]
            sheet_name = sheet_name.replace("[", "").replace("]", "").replace(":", "").replace("*", "").replace("?", "").replace("/", "-").replace("\\", "-")
            df.to_excel(writer, sheet_name=sheet_name)
    output.seek(0)
    return output.getvalue()


# Bar chart geometry. The image is placed at exactly 462 x 167 pt on the sheet,
# so the figure is built from the same physical size (inches) at a higher DPI:
# the 12 pt type then lands at a true 12 pt in Excel instead of being scaled.
BAR_W_PT = 462
BAR_H_PT = 167
BAR_FONT_PT = 12
PX_PER_PT = 96 / 72          # 1 pt = 1.333 px in openpyxl's pixel units
BAR_W_PX = BAR_W_PT * PX_PER_PT   # 616.0 px -> 462.00 pt
BAR_H_PX = BAR_H_PT * PX_PER_PT   # 222.67 px -> 167.00 pt


def _angka_id(value, decimals=2):
    """Angka gaya Indonesia: titik ribuan, koma desimal (61.07 -> "61,07")."""
    try:
        s = f"{float(value):,.{decimals}f}"
    except (TypeError, ValueError):
        return str(value)
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _kelas_chart_png(labels, series):
    """Grouped bar chart for one xlsx sheet - bare, no chart chrome.

    Rendered at 462 x 167 pt (H:167, W:462) with 12 pt type. No Y axis, no grid,
    no title and no background: each bar carries its own value label in the bar's
    own colour and a black outline, so the numbers stay readable without an axis.
    """
    import numpy as np
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(BAR_W_PT / 72, BAR_H_PT / 72), dpi=200)
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")

    idx = np.arange(len(labels))
    width = 0.8 / max(1, len(series))
    for i, s in enumerate(series):
        values = [np.nan if v is None else float(v) for v in s["values"]]
        pos = idx - 0.4 + width * (i + 0.5)
        bars = ax.bar(pos, values, width=width, label=s["label"], color=s["color"],
                      edgecolor="black", linewidth=0.8, zorder=2)
        for rect, value in zip(bars, values):
            if np.isnan(value):
                continue
            ax.text(rect.get_x() + rect.get_width() / 2, value, _angka_id(value),
                    ha="center", va="bottom", fontsize=BAR_FONT_PT,
                    color=s["color"], zorder=3)

    ax.set_xticks(idx)
    ax.set_xticklabels(labels, fontsize=BAR_FONT_PT, color="#333333")
    ax.tick_params(axis="x", length=0, pad=2)
    ax.yaxis.set_visible(False)          # no Y axis
    ax.grid(False)                       # no grid
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color("black")
    ax.spines["bottom"].set_linewidth(0.8)
    ax.margins(y=0.22)                   # room for the value labels
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16),
              ncol=max(1, len(series)), frameon=False, fontsize=BAR_FONT_PT,
              handlelength=1.2, columnspacing=1.2, labelspacing=0.2)
    fig.tight_layout(pad=0.25)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True)
    plt.close(fig)
    return buf.getvalue()


def _tempel_grafik(ws, png, top_row, width=900, height=306):
    """Attach a PNG to a worksheet, anchored below the table."""
    from openpyxl.drawing.image import Image as XLImage

    image = XLImage(io.BytesIO(png))
    image.width = width
    image.height = height
    ws.add_image(image, f"A{top_row}")


def build_xlsx_pariwisata(payload):
    """Tabel TPK & RLMT per kelas akomodasi, satu sheet per indikator/jenis.

    Angka dan tanda (*) mengikuti tabel halaman web (lihat
    ``pariwisata/ai.py``): kolom tahun lalu, bulan lalu, bulan ini, lalu dua
    kolom selisih. Sumbernya ``kumpulkan_kelas`` supaya persis data BRS.

    Setiap sheet juga memuat dua gambar: grafik batang bulan lalu vs bulan ini
    per kelas, dan grafik garis PNG yang sama dengan yang ditanam ke paket .idml.
    """
    import pandas as pd

    from modules.database import get_engine
    from modules.etl_engine import MONTH_NAMES
    from modules.indesign_pariwisata import (
        INDIKATOR, JENIS, RASIO_GRAFIK, SATUAN, SINGKATAN, TOKEN_GRAFIK,
        grafik_png, kumpulkan_kelas, label_kelas,
    )

    prov, thn, bln = payload["prov"], int(payload["thn"]), payload["bln"]
    if bln not in MONTH_NAMES:
        raise SystemExit(f"Bulan tidak dikenal: {bln}")
    blok = kumpulkan_kelas(get_engine(), prov, thn, bln)
    if not blok:
        raise SystemExit(f"Tidak ada data pariwisata untuk {prov} {bln} {thn}.")

    bulan_ini = MONTH_NAMES.index(bln) + 1
    prev_bln, prev_thn = (bulan_ini - 1, thn) if bulan_ini > 1 else (12, thn - 1)

    def periode(year, month):
        return f"{MONTH_NAMES[month - 1]} {year}"

    header = [
        "Kelas Akomodasi",
        periode(thn - 1, bulan_ini),
        periode(prev_thn, prev_bln),
        periode(thn, bulan_ini),
        f"\u0394 vs {periode(prev_thn, prev_bln)}",
        f"\u0394 vs {periode(thn - 1, bulan_ini)}",
    ]

    def angka(value):
        return None if value is None or pd.isna(value) else round(float(value), 2)

    def selisih(value):
        return "-" if value is None or pd.isna(value) else f"{float(value):+.2f} pts"

    def nilai_grafik(value):
        return None if value is None or pd.isna(value) else round(float(value), 2)

    # Grafik batang: hanya bulan lalu vs bulan ini.
    WARNA_BULAN_LALU = "#FA9B3B"
    WARNA_BULAN_INI = "#FDBD26"

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        for ind in INDIKATOR:
            for jenis in JENIS:
                blk = blok.get((ind, jenis))
                if not blk:
                    continue
                # ``rse`` sudah memuat hasil gabungan RSE + status rilis
                # (lihat _tanda_bintang di indesign_pariwisata.py), jadi jangan
                # dibandingkan lagi dengan 0.25 di sini.
                tanda = blk.get("rse") or {}
                tanda_prev = blk.get("rse_prev") or {}
                tanda_last = blk.get("rse_last") or {}
                body = []
                chart_labels = []
                chart_values = ([], [])

                def bertanda(nilai, flag):
                    # Hitungan tetap numerik; yang ditambah hanya tanda (*).
                    hasil = angka(nilai)
                    if hasil is not None and bool(flag):
                        hasil = f"{hasil:.2f}*"
                    return hasil

                for kelas, (ly, prev, cur) in sorted(blk["rows"].items()):
                    body.append([
                        f"{label_kelas(jenis)} {kelas}",
                        bertanda(ly, tanda_last.get(kelas)),
                        bertanda(prev, tanda_prev.get(kelas)),
                        bertanda(cur, tanda.get(kelas)),
                        selisih(cur - prev if not pd.isna(cur) and not pd.isna(prev) else None),
                        selisih(cur - ly if not pd.isna(cur) and not pd.isna(ly) else None),
                    ])
                    chart_labels.append(f"{label_kelas(jenis)} {kelas}")
                    for bucket, value in zip(chart_values, (prev, cur)):
                        bucket.append(nilai_grafik(value))

                ly, prev, cur, d_prev, d_last = blk["total"]
                body.append([
                    "Total", angka(ly), angka(prev), angka(cur),
                    selisih(d_prev), selisih(d_last),
                ])

                nama_sheet = f"{SINGKATAN[ind]} - {jenis}"[:31]
                # (*) marks current-month values that are either statistically
                # weak (RSE > 25%) or not releasable. The key names only the RSE
                # rule, like the BRS footnote, so a star from "Tidak dapat rilis"
                # is reported through PERINGATAN.txt instead (see
                # _catat_legenda_bintang).
                # Copy per sheet: `header` is built once above and is reused by
                # every sheet, so mutating it in place would leak the key.
                kolom_sheet = list(header)
                if any(isinstance(baris[3], str) and baris[3].endswith("*") for baris in body):
                    kolom_sheet[0] = "Kelas Akomodasi (* = RSE di atas 25 persen)"
                pd.DataFrame(body, columns=kolom_sheet).to_excel(
                    writer, sheet_name=nama_sheet, index=False,
                )

                ws = writer.sheets[nama_sheet]
                for kolom, lebar in zip("ABCDEF", (20, 15, 15, 15, 22, 22)):
                    ws.column_dimensions[kolom].width = lebar
                png = _kelas_chart_png(
                    labels=chart_labels,
                    series=[
                        {"label": header[2], "values": chart_values[0],
                         "color": WARNA_BULAN_LALU},
                        {"label": header[3], "values": chart_values[1],
                         "color": WARNA_BULAN_INI},
                    ],
                )
                _tempel_grafik(ws, png, top_row=len(body) + 3,
                               width=BAR_W_PX, height=BAR_H_PX)

                # Grafik garis: PNG yang sama persis dengan yang ditanam ke paket
                # .idml (grafik_png + TOKEN_GRAFIK), jadi Excel dan InDesign tidak
                # pernah memuat gambar tren yang berbeda.
                tren = blk.get("tren") or []
                token = TOKEN_GRAFIK.get((ind, jenis))
                if tren and token:
                    png_garis = grafik_png(tren, ind, token)
                    if png_garis:
                        rasio = RASIO_GRAFIK.get(token, 2.2)
                        _tempel_grafik(ws, png_garis, top_row=len(body) + 15,
                                       width=900, height=int(round(900 / rasio)))
    output.seek(0)
    return output.getvalue()


def _asset(payload, key):
    import base64

    encoded = payload.get(f"{key}_b64")
    if not encoded:
        return None, None
    return base64.b64decode(encoded), payload.get(f"{key}_name") or f"{key}.png"


def _paket_dengan_peringatan(paket, warnings):
    """Tambahkan PERINGATAN.txt ke paket .idml agar catatan ekspor ikut terbaca."""
    if not warnings:
        return paket
    import zipfile

    sumber = zipfile.ZipFile(io.BytesIO(paket))
    keluar = io.BytesIO()
    with zipfile.ZipFile(keluar, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in sumber.infolist():
            dst.writestr(item, sumber.read(item.filename))
        dst.writestr("PERINGATAN.txt", "\n".join("- " + w for w in warnings) + "\n")
    return keluar.getvalue()


def build_idml_transport(payload):
    from modules.indesign_export import DEFAULT_TEMPLATE, fill_brs_template, paket_zip
    from modules.report_page import _kab_lookup_brs, get_comparison_data

    prov, thn, bln = payload["prov"], int(payload["thn"]), payload["bln"]
    items = _report_items(prov, thn, bln)
    if not items:
        raise SystemExit(f"Tidak ada data untuk {prov} {bln} {thn}.")

    laut_ports = None
    frame, *_ = get_comparison_data(prov, thn, bln, "Transportasi Laut")
    if frame is not None and not frame.empty:
        import re

        laut_ports = [re.split(r"\s*/\s*", str(v))[0] for v in frame["nama_pelabuhan"].drop_duplicates()]

    result = fill_brs_template(
        DEFAULT_TEMPLATE.read_bytes(), prov, thn, bln, items, _kab_lookup_brs,
        nomor_brs=(payload.get("nomor") or "").strip() or None,
        tanggal_rilis=(payload.get("tanggal") or "").strip() or None,
        laut_ports=laut_ports,
        qr_bytes=_asset(payload, "qr")[0],
        qr_name=_asset(payload, "qr")[1],
        infografis_bytes=_asset(payload, "infografis")[0],
        infografis_name=_asset(payload, "infografis")[1],
        template_dir=DEFAULT_TEMPLATE.parent,
    )
    name = f"BRS_Transportasi_{prov.replace(' ', '_')}_{bln}_{thn}.idml"
    return _paket_dengan_peringatan(
        paket_zip(result.idml_bytes, name, template_dir=DEFAULT_TEMPLATE.parent), result.warnings)


def _narasi_ai_pariwisata(engine, prov, thn, bln):
    """{(jenis_akomodasi, indicator): narrative} untuk periode ini (bisa kosong)."""
    from sqlalchemy import text

    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT jenis_akomodasi, indicator, narrative FROM pariwisata_ai_narratives "
                    "WHERE TRIM(CAST(province AS TEXT)) = :prov AND year = :thn AND month = :bln"
                ),
                {"prov": str(prov).strip(), "thn": int(thn), "bln": int(MONTH_NUMBER[bln])},
            ).fetchall()
    except Exception:
        return {}
    return {(r[0], r[1]): r[2] for r in rows if r[2]}


MONTH_NUMBER = {
    "Januari": 1, "Februari": 2, "Maret": 3, "April": 4, "Mei": 5, "Juni": 6,
    "Juli": 7, "Agustus": 8, "September": 9, "Oktober": 10, "November": 11, "Desember": 12,
}


def _catat_legenda_bintang(data, result):
    """Tambahkan peringatan bila ada (*) yang bukan karena RSE > 25%.

    Legenda di template BRS berbunyi "Keterangan: (*) RSE > 25%" saja, sesuai
    permintaan. Tetapi angka berstatus "Tidak dapat rilis" juga ditandai (*),
    jadi kasus itu harus dilaporkan ke pengguna agar tidak salah tafsir.
    """
    try:
        import pandas as pd
        bukan_rse = []
        for (ind, jenis), blok in (data or {}).items():
            tanda = blok.get("rse") or {}
            baris = blok.get("rows") or {}
            for kelas, (_, _, cur) in baris.items():
                if not tanda.get(kelas):
                    continue
                nilai_kosong = cur is None or (isinstance(cur, float) and pd.isna(cur))
                if nilai_kosong:
                    continue
                # ditandai tetapi bukan karena RSE -> berasal dari status rilis
                bukan_rse.append(f"{ind.upper()} {jenis} kelas {kelas}")
        if bukan_rse:
            result.warnings.append(
                "Sebagian tanda (*) bukan karena RSE > 25% melainkan status "
                "\"Tidak dapat rilis\", sehingga legenda BRS tidak menjelaskannya: "
                + ", ".join(bukan_rse) + ".")
    except Exception:
        # Peringatan tidak boleh menggagalkan ekspor.
        pass


def build_idml_pariwisata(payload):
    from modules.database import get_engine
    from modules.indesign_export import paket_zip
    from modules.indesign_pariwisata import fill_brs_pariwisata_template, kumpulkan_kelas, resolve_template

    prov, thn, bln = payload["prov"], int(payload["thn"]), payload["bln"]
    template_path = resolve_template(level=prov)
    if not Path(template_path).exists():
        raise SystemExit(f"Template InDesign pariwisata tidak ditemukan: {template_path}")
    data = kumpulkan_kelas(get_engine(), prov, thn, bln)
    if not data:
        raise SystemExit(f"Tidak ada data pariwisata untuk {prov} {bln} {thn}.")
    # Narasi AI yang juga tampil di halaman web, supaya IDML tidak memakai teks
    # gaya BPS yang berbeda dari laporan web.
    ai_narasi = {k: "\n\n".join(_ringkas_untuk_idml(p) for p in v.split("\n\n"))
                 for k, v in _narasi_ai_pariwisata(get_engine(), prov, thn, bln).items()}
    result = fill_brs_pariwisata_template(
        None, prov, thn, bln, data, level=prov, ai_narasi=ai_narasi,
        nomor_brs=(payload.get("nomor") or "").strip() or None,
        tanggal_rilis=(payload.get("tanggal") or "").strip() or None,
        qr_bytes=_asset(payload, "qr")[0],
        qr_name=_asset(payload, "qr")[1],
        infografis_bytes=_asset(payload, "infografis")[0],
        infografis_name=_asset(payload, "infografis")[1],
    )
    # Peringatan ekspor: legenda BRS hanya menyebut RSE > 25%, sedangkan tanda (*)
    # di tabel juga dipakai untuk angka berstatus "Tidak dapat rilis". Tanpa catatan
    # ini, tanda bintang pada angka ber-RSE rendah tidak punya penjelasan.
    _catat_legenda_bintang(data, result)
    name = f"BRS_Pariwisata_{prov.replace(' ', '_')}_{bln}_{thn}.idml"
    return _paket_dengan_peringatan(
        paket_zip(result.idml_bytes, name, template_dir=Path(template_path).parent), result.warnings)


NEGARA_LABEL = {
    "CN": "Tiongkok", "JP": "Jepang", "US": "Amerika Serikat", "AU": "Australia",
    "SG": "Singapura", "MY": "Malaysia", "KR": "Korea Selatan", "IN": "India",
    "NZ": "Selandia Baru", "PG": "Papua Nugini", "TH": "Thailand", "VN": "Vietnam",
    "PH": "Filipina", "HK": "Hong Kong", "TW": "Taiwan", "DE": "Jerman",
    "GB": "Inggris", "NL": "Belanda", "FR": "Prancis", "IT": "Italia", "ES": "Spanyol",
}


def _label_hs2(engine):
    """{kode 2 digit: label} dari tabel dimensi; kosong bila tabelnya tidak ada."""
    try:
        import pandas as pd
        df = pd.read_sql_query("select kode, label from dim_perdagangan_hs2", engine)
        return {str(r["kode"]).zfill(2): str(r["label"]) for _, r in df.iterrows()}
    except Exception:  # noqa: BLE001 - dimensi opsional, cukup pakai kode
        return {}


def build_xlsx_perdagangan(payload):
    """Tabel-tabel BRS Ekspor-Impor sebagai Excel, satu sheet per tabel.

    Sheet negara juga memuat grafik batang perbandingan kumulatif tahun lalu vs
    tahun berjalan -- sama dengan grafik di halaman web -- lengkap dengan label
    nilai berformat Indonesia (titik ribuan, koma desimal, dua digit).
    """
    import pandas as pd

    from modules.database import get_engine
    from modules.etl_engine import MONTH_NAMES
    from modules.perdagangan_data import kumpulkan_perdagangan
    from modules.perdagangan_grafik import grafik_batang

    prov, thn = payload["prov"], int(payload["thn"])
    bln_raw = payload["bln"]
    bln = int(bln_raw) if str(bln_raw).isdigit() else MONTH_NAMES.index(bln_raw) + 1
    engine = get_engine()
    data = kumpulkan_perdagangan(engine, prov, thn, bln)
    if not (data.get("ringkasan_ekspor") or data.get("ringkasan_impor")):
        raise SystemExit(f"Tidak ada data perdagangan untuk {prov} {bln} {thn}.")

    ket = (data.get("meta") or {}).get("ketersediaan") or {}
    label_hs = _label_hs2(engine)

    def kolom(arus):
        k = ket.get(arus) or {}
        return (k.get("last", True), k.get("prev", True), k.get("kum_last", True))

    prev_bln, prev_thn = (bln - 1, thn) if bln > 1 else (12, thn - 1)
    singkat = MONTH_NAMES[bln - 1][:3]
    kepala = [
        "Uraian",
        f"{MONTH_NAMES[bln - 1]} {thn - 1}",
        f"{MONTH_NAMES[prev_bln - 1]} {thn}",
        f"{MONTH_NAMES[bln - 1]} {thn}",
        f"Jan-{singkat} {thn - 1}",
        f"Jan-{singkat} {thn}",
        "% Peran",
    ]

    def angka(v):
        return None if v is None else round(float(v), 2)

    def label_negara(kode):
        return NEGARA_LABEL.get(str(kode).upper(), str(kode))

    def label_golongan(kode):
        k = str(kode).zfill(2)
        return label_hs.get(k, f"HS{k}")

    def baris_entitas(arus, daftar, total_kum, label):
        ada_last, ada_prev, ada_kum_last = kolom(arus)
        out = []
        for r in daftar or []:
            kum = float(r.get("kum") or 0.0)
            out.append([
                label(r.get("kode")),
                angka(r.get("last")) if ada_last else "-",
                angka(r.get("prev")) if ada_prev else "-",
                angka(r.get("nilai")),
                angka(r.get("kum_last")) if ada_kum_last else "-",
                angka(kum),
                round(kum / total_kum * 100.0, 2) if total_kum else 0.0,
            ])
        return out

    def total_kum(arus):
        ring = {str(r.get("label", "")).lower(): r
                for r in data.get(f"ringkasan_{arus}") or []}
        return float((ring.get("total") or {}).get("kum_now") or 0.0)

    def grafik_negara(arus, judul):
        """Grafik batang 10 negara teratas: kumulatif tahun lalu vs tahun ini."""
        daftar = sorted(data.get(f"{arus}_negara") or [],
                        key=lambda r: float(r.get("kum") or 0.0), reverse=True)[:10]
        if not daftar:
            return None
        labels = [label_negara(r.get("kode")) for r in daftar]
        seri = [
            (f"Kumulatif {thn - 1}", [float(r.get("kum_last") or 0.0) for r in daftar]),
            (f"Kumulatif {thn}", [float(r.get("kum") or 0.0) for r in daftar]),
        ]
        return grafik_batang(judul, labels, seri)

    sheets = {}

    for arus, judul in (("ekspor", "Ekspor"), ("impor", "Impor")):
        ada_last, ada_prev, ada_kum_last = kolom(arus)
        ring = data.get(f"ringkasan_{arus}") or []
        if ring:
            isi = [[("Total " + judul) if str(r.get("label", "")).lower() == "total"
                    else r.get("label", ""),
                    angka(r.get("last")) if ada_last else "-",
                    angka(r.get("prev")) if ada_prev else "-",
                    angka(r.get("now")),
                    angka(r.get("kum_last")) if ada_kum_last else "-",
                    angka(r.get("kum_now")),
                    round(float(r["kum_now"]) / total_kum(arus) * 100.0, 2)
                    if total_kum(arus) else 0.0] for r in ring]
            sheets[f"Ringkasan {judul}"] = {"baris": isi, "png": None}

        for kunci, label, pelabel in (
                ("hs2", "HS 2 Digit", label_golongan),
                ("negara", "Negara", label_negara),
                ("pelabuhan_resmi", "Pelabuhan Muat", lambda k: str(k))):
            daftar = data.get(f"{arus}_{kunci}")
            if not daftar:
                continue
            nama = f"{judul} {label}"[:31]
            png = None
            if kunci == "negara":
                arah = "Tujuan" if arus == "ekspor" else "Asal"
                png = grafik_negara(
                    arus,
                    f"Perbandingan Nilai Kumulatif {judul} Menurut Negara {arah} "
                    f"(Ribu US$), {thn - 1} dan {thn}")
            sheets[nama] = {
                "baris": baris_entitas(arus, daftar, total_kum(arus), pelabel),
                "png": png,
            }

    e = (data.get("ringkasan_ekspor") or [{}])[0]
    i = (data.get("ringkasan_impor") or [{}])[0]
    ada_e, ada_i = kolom("ekspor"), kolom("impor")

    def selisih(k):
        return float(e.get(k) or 0.0) - float(i.get(k) or 0.0)

    neraca = []
    for label, ambil, ada in (
            ("Ekspor", lambda k: float(e.get(k) or 0.0), ada_e),
            ("Impor", lambda k: float(i.get(k) or 0.0), ada_i),
            ("Neraca Perdagangan", selisih, tuple(a and b for a, b in zip(ada_e, ada_i)))):
        neraca.append([
            label,
            angka(ambil("last")) if ada[0] else "-",
            angka(ambil("prev")) if ada[1] else "-",
            angka(ambil("now")),
            angka(ambil("kum_last")) if ada[2] else "-",
            angka(ambil("kum_now")),
            "selisih",
        ])
    sheets["Neraca"] = {"baris": neraca, "png": None}

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        for nama, isi in sheets.items():
            judul_sheet = nama[:31]
            pd.DataFrame(isi["baris"], columns=kepala).to_excel(
                writer, sheet_name=judul_sheet, index=False)
            if isi.get("png"):
                _tempel_grafik(writer.sheets[judul_sheet], isi["png"],
                               top_row=len(isi["baris"]) + 3, width=900, height=380)
    output.seek(0)
    return output.getvalue()
def build_idml_exim(payload):
    """Isi template BRS Ekspor-Impor dengan data dari Supabase."""
    from modules.database import get_engine
    from modules.exim_export import isi_template_exim
    from modules.indesign_export import paket_zip
    from modules.perdagangan_data import kumpulkan_perdagangan

    prov, thn = payload["prov"], int(payload["thn"])
    # bln datang sebagai nama bulan ("Agustus") atau angka; normalkan.
    bln_raw = payload["bln"]
    bln = int(bln_raw) if str(bln_raw).isdigit() else MONTH_NUMBER[str(bln_raw)]
    tpl = (Path(__file__).resolve().parent / "templates"
           / "BRS Exim Papua Selatan Oktober 2026" / "BRS_Exim_Papua_Selatan.idml")
    if not tpl.exists():
        raise SystemExit(f"Template BRS Exim tidak ditemukan: {tpl}")

    def label_dari_kode(kode):
        kode = str(kode)
        if kode.isdigit() and len(kode) == 2:
            return f"HS{kode}"
        return NEGARA_LABEL.get(kode.upper(), kode)

    data = kumpulkan_perdagangan(get_engine(), prov, thn, bln)
    if not (data.get("ringkasan_ekspor") or data.get("ringkasan_impor")):
        raise SystemExit(f"Tidak ada data perdagangan untuk {prov} {bln} {thn}.")

    warnings = []
    # Template BRS Exim belum punya frame gambar maupun kolom nomor/tanggal,
    # jadi isian itu dicatat sebagai peringatan, bukan ditempelkan.
    if any(payload.get(k) for k in ('infografis_b64', 'qr_b64', 'nomor', 'tanggal')):
        warnings.append(
            'Template BRS Exim belum punya tempat untuk nomor BRS, tanggal rilis, '
            'kode QR, atau infografis; isian itu tidak ditempatkan.')
    idml_bytes, warnings = isi_template_exim(tpl.read_bytes(), data, label_dari_kode, warnings)
    nama = f"BRS_Exim_{prov.replace(' ', '_')}_{bln}_{thn}.idml"
    return _paket_dengan_peringatan(
        paket_zip(idml_bytes, nama, template_dir=tpl.parent), warnings)


BUILDERS = {
    "pptx": build_pptx,
    "docx": build_docx,
    "xlsx-transport": build_xlsx_transport,
    "xlsx-pariwisata": build_xlsx_pariwisata,
    "idml-transport": build_idml_transport,
    "xlsx-perdagangan": build_xlsx_perdagangan,
    "idml-exim": build_idml_exim,
    "idml-pariwisata": build_idml_pariwisata,
}


def _selftest():
    """Probe used by export.js `checkExporter()`: exit 0 only if the bridge can run.

    Mengimpor dependensi yang benar-benar dipakai builder, bukan sekadar mencetak
    versi - kalau pandas/docx/pptx/streamlit hilang, probe harus gagal di sini,
    bukan nanti saat tombol unduh diklik.
    """
    import json as _json

    hasil = {"python": sys.version.split()[0], "ok": True, "modules": {}}
    for nama in ("pandas", "numpy", "sqlalchemy", "openpyxl", "docx", "pptx",
                 "matplotlib", "fpdf", "lxml", "streamlit"):
        try:
            __import__(nama)
            hasil["modules"][nama] = "ok"
        except Exception as exc:  # noqa: BLE001 - any import failure means "not ready"
            hasil["modules"][nama] = type(exc).__name__
            hasil["ok"] = False
    print(_json.dumps(hasil))
    if not hasil["ok"]:
        raise SystemExit(1)


def main(argv):
    if len(argv) >= 2 and argv[1] in ("--version", "--selftest"):
        _selftest()
        return
    if len(argv) != 4:
        raise SystemExit(__doc__)
    kind, payload_path, out_path = argv[1], argv[2], argv[3]
    builder = BUILDERS.get(kind)
    if not builder:
        raise SystemExit(f"Jenis ekspor tidak dikenal: {kind}")
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    data = builder(payload)
    with open(out_path, "wb") as handle:
        handle.write(data)
    print(f"{kind} {len(data)} bytes", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
