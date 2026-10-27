"""Render a summary of analyst justifications as a plain A4 PDF.

Reads JSON on stdin, writes the PDF to argv[1].
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "templates" / "BRS PARIWISATA PAPUA SELATAN Template" / "Document fonts"
LOGO = Path(__file__).resolve().parent / "public" / "logo.png"

from fpdf import FPDF  # noqa: E402

BULAN = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]
MODULE_LABEL = {"pariwisata": "Pariwisata", "transportasi": "Transportasi"}
COMPARE_LABEL = {"mtm": "M-to-M", "yoy": "Y-on-Y",
                 "dprev": "vs bulan lalu", "dlast": "vs tahun lalu"}

INK = (30, 58, 138)
DIM = (71, 85, 105)
LINE = (219, 234, 254)
POS = (4, 120, 87)
NEG = (185, 28, 28)


def group_label(n):
    parts = [n.get("provinsi") or "-"]
    if n.get("dataset") == "transportasi_udara":
        parts.append("Udara")
    elif n.get("dataset") == "transportasi_laut":
        parts.append("Laut")
    return " | ".join(parts)


def subject_label(n):
    bits = []
    if n.get("entity"):
        bits.append(str(n["entity"]))
    if n.get("jenis"):
        bits.append(str(n["jenis"]))
    if n.get("kelas") and int(n["kelas"]) > 0:
        bits.append("Kelas %s" % n["kelas"])
    bits.append(str(n.get("indicator", "")))
    return " / ".join(bits)


class SummaryPDF(FPDF):
    def footer(self):
        self.set_y(-14)
        self.set_font("Lato", "", 8)
        self.set_text_color(*DIM)
        self.cell(0, 6, "Halaman %d dari {nb}" % self.page_no(), align="C")


def build(payload, out_path):
    module = payload.get("module", "pariwisata")
    year = payload.get("year")
    month = payload.get("month")
    summary = (payload.get("summary") or "").strip()
    source = payload.get("source") or "AI"
    notes = payload.get("notes") or []
    coverage = payload.get("coverage") or {}

    pdf = SummaryPDF(format="A4")
    pdf.alias_nb_pages()
    for style, fname in (("", "Lato-Regular.ttf"), ("B", "Lato-Bold.ttf"), ("I", "Lato-Italic.ttf")):
        path = FONTS / fname
        if path.exists():
            pdf.add_font("Lato", style, str(path))
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.set_margins(18, 16, 18)

    has_logo = LOGO.exists()
    if has_logo:
        try:
            pdf.image(str(LOGO), x=18, y=14, w=16)
        except Exception:
            has_logo = False
    x0 = 40 if has_logo else 18
    pdf.set_xy(x0, 16)
    pdf.set_font("Lato", "B", 15)
    pdf.set_text_color(*INK)
    pdf.cell(0, 8, "RINGKASAN JUSTIFIKASI ANALIS", ln=1)
    pdf.set_x(x0)
    pdf.set_font("Lato", "", 10.5)
    pdf.set_text_color(*DIM)
    pdf.cell(0, 6, "Modul %s  -  Seluruh Provinsi  -  %s %s"
             % (MODULE_LABEL.get(module, module), BULAN[int(month)] if month else "-", year), ln=1)

    pdf.ln(4)
    pdf.set_draw_color(*LINE)
    pdf.set_line_width(0.4)
    pdf.line(18, pdf.get_y(), 192, pdf.get_y())
    pdf.ln(3)

    pdf.set_font("Lato", "", 9)
    pdf.set_text_color(*DIM)
    pdf.cell(0, 5, "Cakupan justifikasi: %s dari %s sel (%s%%)  -  Sumber ringkasan: %s"
             % (coverage.get("notes", len(notes)), coverage.get("cells", "?"),
                coverage.get("percent", "?"), source), ln=1)
    pdf.ln(3)

    pdf.set_font("Lato", "B", 11.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 7, "1.  RINGKASAN EKSEKUTIF", ln=1)
    pdf.ln(1)
    pdf.set_font("Lato", "", 10)
    pdf.set_text_color(30, 41, 59)
    for para in [p.strip() for p in summary.replace("\r\n", "\n").split("\n\n") if p.strip()]:
        pdf.multi_cell(0, 5.4, para)
        pdf.ln(2)

    pdf.ln(2)
    pdf.set_font("Lato", "B", 11.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 7, "2.  RINCIAN JUSTIFIKASI PER PROVINSI", ln=1)
    pdf.ln(1)

    groups = {}
    for n in notes:
        groups.setdefault(group_label(n), []).append(n)

    for glabel in sorted(groups):
        rows = groups[glabel]
        pdf.ln(1.5)
        pdf.set_font("Lato", "B", 10)
        pdf.set_text_color(*INK)
        pdf.cell(0, 6, glabel, ln=1)
        pdf.set_font("Lato", "", 8.5)
        pdf.set_text_color(*DIM)
        pdf.cell(0, 4.5, "%d justifikasi" % len(rows), ln=1)
        pdf.ln(0.5)

        for n in rows:
            gv = n.get("growth_value")
            gvs = "-" if gv is None else ("%+.2f%%" % float(gv))
            tone = POS if (gv or 0) > 0 else NEG if (gv or 0) < 0 else DIM

            pdf.set_font("Lato", "B", 9)
            pdf.set_text_color(30, 41, 59)
            pdf.cell(110, 4.8, subject_label(n)[:70], ln=0)
            pdf.set_text_color(*tone)
            pdf.cell(20, 4.8, gvs, align="R", ln=0)
            pdf.set_font("Lato", "", 8)
            pdf.set_text_color(*DIM)
            pdf.cell(0, 4.8, COMPARE_LABEL.get(n.get("comparison"), n.get("comparison") or ""), align="R", ln=1)

            pdf.set_font("Lato", "", 9)
            pdf.set_text_color(30, 41, 59)
            pdf.multi_cell(0, 4.6, str(n.get("reason", "")).strip())
            pdf.set_font("Lato", "I", 7.5)
            pdf.set_text_color(*DIM)
            pdf.cell(0, 3.8, "- %s" % (n.get("author") or "analis"), ln=1)
            pdf.ln(1.2)

    pdf.ln(3)
    pdf.set_draw_color(*LINE)
    pdf.line(18, pdf.get_y(), 192, pdf.get_y())
    pdf.ln(2)
    pdf.set_font("Lato", "I", 8)
    pdf.set_text_color(*DIM)
    pdf.multi_cell(0, 4.4,
                   "Catatan: ringkasan dihasilkan otomatis dari justifikasi yang diisi analis. "
                   "Penyebab yang dinyatakan bersifat kualitatif dan merupakan pendapat analis, "
                   "bukan inferensi statistik dari data.")

    pdf.output(out_path)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    build(payload, sys.argv[1])


if __name__ == "__main__":
    main()
