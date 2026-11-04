"""Fill the official BPS "Bahan Tayang" decks with database data.

Three decks live in ``templates/Bahan Tayang/`` (Pariwisata, Perdagangan,
Transportasi). This module loads each one as the *template*, replaces the chart
caches with figures read from the same database the dashboard uses, updates the
period captions and (where the deck lays data out as plain rows) the tables, and
returns the resulting .pptx bytes.

Everything is done on the OOXML level with lxml, because the decks contain 3D
charts that python-pptx cannot address through its plot API â€” writing the cache
directly works for 2D and 3D alike. PowerPoint renders charts from that cache,
so the visuals match without touching the embedded workbooks.

Public builders (registered in export_bridge.BUILDERS):
    build_bahan_tayang_transport(payload)
    build_bahan_tayang_pariwisata(payload)
    build_bahan_tayang_perdagangan(payload)
"""

import calendar
import copy
import io
import re
from datetime import date
from pathlib import Path

import pandas as pd
from lxml import etree
from pptx import Presentation
from pptx.util import Inches

HERE = Path(__file__).resolve().parent
TAYANG_DIR = HERE / "templates" / "Bahan Tayang"

MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
          "Agustus", "September", "Oktober", "November", "Desember"]
MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep",
                "Okt", "Nov", "Des"]
PROVINSI = ["Papua", "Papua Selatan", "Papua Tengah", "Papua Pegunungan"]
PROVINSI_KEY = {p.upper(): p for p in PROVINSI}

C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _qn(tag, ns=C_NS):
    return f"{{{ns}}}{tag}"


def month_number(bln):
    if isinstance(bln, int):
        return bln
    if str(bln).isdigit():
        return int(bln)
    return MONTHS.index(str(bln).strip()) + 1


def prev_period(bln, thn):
    m = month_number(bln)
    return (MONTHS[11], int(thn) - 1) if m == 1 else (MONTHS[m - 2], int(thn))


# --------------------------------------------------------------------------- io
def _deck(pattern):
    for f in sorted(TAYANG_DIR.glob("*.pptx")):
        if pattern.lower() in f.name.lower():
            return f
    raise SystemExit(f"Deck bahan tayang tidak ditemukan: {pattern}")


def _engine():
    from modules.database import get_engine
    return get_engine()


def _query(sql, params=None):
    from sqlalchemy import text

    return pd.read_sql_query(text(sql), _engine(), params=params or {})


def _save(prs):
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def _idnum(value, dec=2):
    """Indonesian number format: 7.729,74 (dot thousands, comma decimals)."""
    if value is None:
        return ""
    try:
        s = f"{float(value):,.{dec}f}"
    except (TypeError, ValueError):
        return str(value)
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _plain(value):
    """Plain decimal text for chart caches (always a dot decimal mark)."""
    if value is None:
        return None
    f = float(value)
    if f == 0:
        return "0"
    s = f"{f:.10f}".rstrip("0").rstrip(".")
    return s


# ------------------------------------------------------------------- traversal
def iter_shapes(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == 6:  # GROUP
            yield from iter_shapes(sh.shapes)


def all_text_frames(prs):
    for slide in prs.slides:
        for sh in iter_shapes(slide.shapes):
            if sh.has_text_frame:
                yield sh


# ------------------------------------------------------------- chart rewriting
def _chart_element(chart):
    cs = chart._chartSpace
    pa = cs.find(".//" + _qn("plotArea"))
    if pa is None:
        raise ValueError("chart tanpa plotArea")
    for el in pa:
        if etree.QName(el).localname.endswith("Chart"):
            return el
    raise ValueError("chart tanpa elemen plot")


def _ser_list(chart):
    el = _chart_element(chart)
    return el, el.findall(_qn("ser"))


def _set_cache(ref_el, cache_tag, values, numeric):
    """Rewrite a strCache/numCache under a strRef/numRef element."""
    cache = ref_el.find(_qn(cache_tag))
    if cache is None:
        cache = etree.SubElement(ref_el, _qn(cache_tag))
    for child in list(cache):
        cache.remove(child)
    count = etree.SubElement(cache, _qn("ptCount"))
    count.set("val", str(len(values)))
    for idx, value in enumerate(values):
        if value is None:
            continue
        pt = etree.SubElement(cache, _qn("pt"))
        pt.set("idx", str(idx))
        node = etree.SubElement(pt, _qn("v"))
        node.text = _plain(value) if numeric else str(value)


def _ref_child(parent, ref_tag, cache_tag):
    """Return the strRef/numRef element, creating it when missing."""
    for child in list(parent):
        if etree.QName(child).localname == ref_tag:
            return child
    ref = etree.SubElement(parent, _qn(ref_tag))
    etree.SubElement(ref, _qn("f")).text = "Sheet1!$A$1"
    return ref


def set_chart_data(chart, categories, series_names, series_values):
    """Replace a chart's cached data.

    categories: list of category labels.
    series_names: series names, in plot order.
    series_values: list[list[float|None]], one list per series.
    """
    el, sers = _ser_list(chart)
    target = len(series_names)
    while len(sers) > target:
        el.remove(sers.pop())
    while len(sers) < target:
        clone = copy.deepcopy(sers[-1])
        sers[-1].addnext(clone)
        sers = el.findall(_qn("ser"))

    for ser, name, values in zip(sers, series_names, series_values):
        # series name -- strRef/strCache
        tx = ser.find(_qn("tx"))
        if tx is None:
            tx = etree.Element(_qn("tx"))
            ser.insert(0, tx)
        for child in list(tx):
            tx.remove(child)
        name_ref = etree.SubElement(tx, _qn("strRef"))
        etree.SubElement(name_ref, _qn("f")).text = "Sheet1!$B$1"
        _set_cache(name_ref, "strCache", [str(name)], numeric=False)

        # categories -- datetime/numeric categories use numRef
        cat = ser.find(_qn("cat"))
        if cat is None:
            cat = etree.Element(_qn("cat"))
            ser.insert(1, cat)
        for child in list(cat):
            cat.remove(child)
        numeric_cats = any(isinstance(c, (int, float)) and not isinstance(c, bool)
                           for c in categories)
        if numeric_cats:
            cat_ref = _ref_child(cat, "numRef", "numCache")
            _set_cache(cat_ref, "numCache", [str(c) for c in categories], numeric=True)
        else:
            cat_ref = _ref_child(cat, "strRef", "strCache")
            _set_cache(cat_ref, "strCache", [str(c) for c in categories], numeric=False)

        # values -- numRef/numCache
        val = ser.find(_qn("val"))
        if val is None:
            val = etree.SubElement(ser, _qn("val"))
        for child in list(val):
            val.remove(child)
        val_ref = etree.SubElement(val, _qn("numRef"))
        etree.SubElement(val_ref, _qn("f")).text = "Sheet1!$B$2:$B$20"
        _set_cache(val_ref, "numCache", values, numeric=True)

    _release_axis_bounds(chart, series_values)
    _drop_explicit_labels(chart)


def _release_axis_bounds(chart, series_values):
    """Drop a hand-set axis min/max when the new data would fall outside it.

    The decks hard-code axis maxima for the month they were authored for
    (e.g. max=10 on a chart that now holds 107.57, or max=160 on a Papua Tengah
    line that reaches 1.6 million). PowerPoint would silently clip those bars
    and lines, so the fixed bound is removed and the axis auto-scales again.
    A min of 0 is kept: bar charts must start at zero.
    """
    numbers = [v for series in series_values for v in series if v is not None]
    if not numbers:
        return
    top, bottom = max(numbers), min(numbers)
    pa = chart._chartSpace.find(".//" + _qn("plotArea"))
    if pa is None:
        return
    for axis in pa.findall(_qn("valAx")):
        scaling = axis.find(_qn("scaling"))
        if scaling is None:
            continue
        max_el = scaling.find(_qn("max"))
        if max_el is not None:
            try:
                fixed = float(max_el.get("val"))
            except (TypeError, ValueError):
                fixed = None
            if fixed is not None and top > fixed:
                scaling.remove(max_el)
        min_el = scaling.find(_qn("min"))
        if min_el is not None:
            try:
                fixed = float(min_el.get("val"))
            except (TypeError, ValueError):
                fixed = None
            if fixed is not None and fixed != 0 and bottom < fixed:
                scaling.remove(min_el)


def _drop_explicit_labels(chart):
    """Data labels that carry literal text ignore the cache; let them read values."""
    for label in chart._chartSpace.findall(".//" + _qn("dLbl")):
        text = label.find(_qn("tx"))
        if text is not None:
            label.remove(text)


def slide_charts(slide):
    return [sh for sh in iter_shapes(slide.shapes) if sh.has_chart]


# -------------------------------------------------------------- text rewriting
_MONTH_YEAR = re.compile(
    r"\b(" + "|".join(MONTHS) + r")(\s+)(20\d{2})\b"
)


def _period_replacer(bln, thn, source=("September", 2026)):
    """Shift every "Bulan Tahun" caption by the same offset as the period.

    The decks are authored for the source period; moving to another month means
    every caption (current month, previous month, year-on-year, previous year)
    has to move by the same number of months, not just one replacement.
    """
    new_y, new_m = int(thn), month_number(bln)
    src_ord = int(source[1]) * 12 + (month_number(source[0]) - 1)
    new_ord = new_y * 12 + (new_m - 1)
    delta = new_ord - src_ord

    def shift(match):
        month, gap, year = match.group(1), match.group(2), int(match.group(3))
        ordinal = year * 12 + MONTHS.index(month) + delta
        target_y, target_m = divmod(ordinal, 12)
        return f"{MONTHS[target_m]}{gap}{target_y}"

    return lambda text: _MONTH_YEAR.sub(shift, text)


def replace_text(prs, transform):
    """Apply transform(text) to text frames, table cells and chart titles."""
    if transform is None:
        return
    for shape in all_text_frames(prs):
        _replace_in_frame(shape.text_frame, transform)
    for slide in prs.slides:
        for shape in iter_shapes(slide.shapes):
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        _replace_in_frame(cell.text_frame, transform)
        for shape in slide_charts(slide):
            for node in shape.chart._chartSpace.iter(_qn("t", A_NS)):
                if not node.text:
                    continue
                text = transform(node.text)
                if text != node.text:
                    node.text = text


def _replace_in_frame(frame, transform):
    full = frame.text
    if transform(full) == full:
        return
    originals = [(para, para.text) for para in frame.paragraphs]
    # Run level first: keeps the per-run formatting of the deck.
    for para, _orig in originals:
        for run in para.runs:
            new = transform(run.text)
            if new != run.text:
                run.text = new
    # Only paragraphs the run pass could not fix (token straddled run
    # boundaries) are rebuilt at paragraph level — always from the ORIGINAL
    # text, otherwise the caption would be shifted twice.
    for para, orig in originals:
        target = transform(orig)
        if target != orig and para.text != target:
            para.text = target


# ------------------------------------------------------------------ transport
TRANSPORT_COLS = {
    "laut": ("transportasi_laut", "dn_penumpang_naik", "dn_penumpang_turun",
             "dn_muat_barang_ton", "dn_bongkar_barang_ton"),
    "udara": ("transportasi_udara", "penumpang_berangkat", "penumpang_datang",
              "barang_muat_kg", "barang_bongkar_kg"),
}


def _transport_agg(thn, bln):
    """{moda: {provinsi: (berangkat, datang, muat, bongkar)}} for that month."""
    out = {}
    for moda, (table, a, b, c, d) in TRANSPORT_COLS.items():
        df = _query(
            f"""SELECT UPPER(TRIM(nama_provinsi)) AS p,
                       SUM(COALESCE({a}, 0)) AS a,
                       SUM(COALESCE({b}, 0)) AS b,
                       SUM(COALESCE({c}, 0)) AS c,
                       SUM(COALESCE({d}, 0)) AS d
                  FROM {table}
                 WHERE tahun = :thn AND bulan = :bln
                 GROUP BY 1""",
            {"thn": int(thn), "bln": bln},
        )
        agg = {}
        for row in df.itertuples(index=False):
            prov = PROVINSI_KEY.get(" ".join(str(row.p).split()))
            if prov:
                agg[prov] = (float(row.a), float(row.b), float(row.c), float(row.d))
        out[moda] = agg
    return out


def build_bahan_tayang_transport(payload):
    thn = int(payload["thn"])
    bln = payload["bln"]
    agg = _transport_agg(thn, bln)

    prs = Presentation(str(_deck("Transportasi")))
    replace_text(prs, _period_replacer(bln, thn))

    def series(moda, idx):
        values = []
        for prov in PROVINSI:
            rec = agg[moda].get(prov)
            values.append(None if rec is None else rec[idx])
        return values

    # Slide 2 = laut, slide 3 = udara. Each has two charts: penumpang, barang.
    for slide_idx, moda in ((2, "laut"), (3, "udara")):
        charts = slide_charts(prs.slides[slide_idx])
        if len(charts) < 2:
            raise SystemExit(f"Slide {slide_idx} tidak punya dua grafik.")
        set_chart_data(
            charts[0].chart, PROVINSI,
            ["PENUMPANG BERANGKAT", "PENUMPANG DATANG"],
            [series(moda, 0), series(moda, 1)],
        )
        muat, bongkar = series(moda, 2), series(moda, 3)
        if moda == "udara":  # kg -> ton, sama dengan deck resmi
            muat = [None if v is None else round(v / 1000, 2) for v in muat]
            bongkar = [None if v is None else round(v / 1000, 2) for v in bongkar]
        set_chart_data(
            charts[1].chart, PROVINSI,
            ["MUAT BARANG", "BONGKAR BARANG"],
            [muat, bongkar],
        )
    return _save(prs)


# ------------------------------------------------------------------ pariwisata
def _pari_totals(thn, bln):
    """{(indikator, jenis): {provinsi: total}} dari pipeline yang sama dengan web."""
    from modules.indesign_pariwisata import kumpulkan_kelas

    engine = _engine()
    out = {}
    for prov in PROVINSI:
        blok = kumpulkan_kelas(engine, prov, thn, bln)
        for key, data in blok.items():
            total = data.get("total")
            if total is None:
                continue
            out.setdefault(key, {})[prov] = total
    return out


def _pari_tren(thn, bln):
    """{(indikator, jenis): {provinsi: [(tahun, bulan, nilai)]}}."""
    from modules.indesign_pariwisata import kumpulkan_kelas

    engine = _engine()
    out = {}
    for prov in PROVINSI:
        blok = kumpulkan_kelas(engine, prov, thn, bln)
        for key, data in blok.items():
            out.setdefault(key, {})[prov] = data.get("tren") or []
    return out


def _pari_tamu(thn, bulan_no):
    df = _query(
        """SELECT UPPER(TRIM(kd_prov)) AS p, jenis_akomodasi AS j,
                  SUM(COALESCE(mktj, 0)) AS n
             FROM all_data
            WHERE year = :thn AND month = :bln
            GROUP BY 1, 2""",
        {"thn": int(thn), "bln": int(bulan_no)},
    )
    out = {}
    for row in df.itertuples(index=False):
        prov = PROVINSI_KEY.get(" ".join(str(row.p).split()))
        if prov:
            out[(prov, row.j)] = float(row.n)
    return out


def _wisnus_frames(thn, bulan_no):
    """Data wisnus: satu bulan, kumulatif per kabupaten, dan seri tahunan."""
    df_bulan = _query(
        """SELECT UPPER(TRIM(prov)) AS p, SUM(COALESCE(jumlah, 0)) AS n
             FROM wisnus_series
            WHERE arah = 'tujuan' AND tahun = :thn AND bulan = :bln
            GROUP BY 1""",
        {"thn": int(thn), "bln": int(bulan_no)},
    )
    bulan = {}
    for row in df_bulan.itertuples(index=False):
        prov = PROVINSI_KEY.get(" ".join(str(row.p).split()))
        if prov:
            bulan[prov] = float(row.n)

    df_kab = _query(
        """SELECT UPPER(TRIM(prov)) AS p, kode_kab AS kode, nama_kab AS nama,
                  SUM(COALESCE(jumlah, 0)) AS n
             FROM wisnus_series
            WHERE arah = 'tujuan' AND tahun = :thn AND bulan <= :bln
            GROUP BY 1, 2, 3""",
        {"thn": int(thn), "bln": int(bulan_no)},
    )
    kab = {}
    for row in df_kab.itertuples(index=False):
        prov = PROVINSI_KEY.get(" ".join(str(row.p).split()))
        if prov == "Papua":
            # kode ikut jadi kunci: "Jayapura" (kab.) dan "Kota Jayapura"
            # adalah dua wilayah berbeda yang namanya mirip.
            kab[(str(row.kode), _kab_label(row.nama, row.kode))] = float(row.n)

    df_tahun = _query(
        """SELECT tahun AS y, SUM(COALESCE(jumlah, 0)) AS n
             FROM wisnus_series
            WHERE arah = 'tujuan' AND UPPER(TRIM(prov)) = 'PAPUA'
              AND bulan <= :bln
            GROUP BY 1""",
        {"bln": int(bulan_no)},
    )
    tahunan = {int(row.y): float(row.n) for row in df_tahun.itertuples(index=False)}
    return bulan, kab, tahunan


def _kab_label(nama, kode=""):
    bersih = str(nama or "").replace("PAPUA--", "").strip()
    judul = re.sub(r"\b\w", lambda m: m.group(0).upper(), bersih.lower())
    # kode kabupaten/kota berakhiran >= 71 adalah kota (klasifikasi BPS);
    # tanpa awalan ini "Jayapura" kabupaten dan kota tampil sama.
    kota = str(kode).strip().isdigit() and int(str(kode).strip()[-2:]) >= 71
    return f"Kota {judul}" if kota else judul


def _wisman_monthly(thn, bulan_no):
    """Seri bulanan wisman Papua dari tahun pertama yang tersedia."""
    df = _query(
        """SELECT tahun AS y, bulan AS m, SUM(COALESCE(jumlah, 0)) AS n
             FROM wisman_series
            WHERE UPPER(TRIM(prov)) = 'PAPUA'
              AND (tahun < :thn OR (tahun = :thn AND bulan <= :bln))
            GROUP BY 1, 2 ORDER BY 1, 2""",
        {"thn": int(thn), "bln": int(bulan_no)},
    )
    if df.empty:
        return [], []
    seri = {(int(row.y), int(row.m)): float(row.n) for row in df.itertuples(index=False)}
    first = int(df["y"].min())
    cats, values = [], []
    for year in range(first, int(thn) + 1):
        last = 12 if year < int(thn) else int(bulan_no)
        for month in range(1, last + 1):
            cats.append(f"{MONTHS_SHORT[month - 1]} {year}")
            values.append(seri.get((year, month)))
    return cats, values


# ------------------------------------------------------- peta koroplet provinsi
GEOJSON = HERE / "public" / "papua_provinces.json"
MAP_RAMP = ["#FDECD2", "#F7C88A", "#E79A4A", "#B9601C"]   # palet oranye deck


def _map_png(values, ratio=0.71, width_px=560):
    """Peta 4 provinsi diwarnai sesuai nilainya (latar transparan).

    Sumber geometri: public/papua_provinces.json — berkas yang sama dipakai
    halaman peta web, jadi tidak ada batas wilayah baru yang perlu dirawat.
    """
    import json

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
    from matplotlib.colors import LinearSegmentedColormap

    data = json.loads(GEOJSON.read_text(encoding="utf-8"))
    angka = [v for v in values.values() if v is not None]
    lo, hi = (min(angka), max(angka)) if angka else (0.0, 1.0)
    cmap = LinearSegmentedColormap.from_list("bps", MAP_RAMP)

    polys, colors = [], []
    for feat in data["features"]:
        prov = feat["properties"]["PROVINSI"]
        nilai = values.get(prov)
        tone = 0.5 if nilai is None or hi == lo else (nilai - lo) / (hi - lo)
        geom = feat["geometry"]
        rings = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in rings:
            # ponytail: cincin luar saja; lubang/danau kecil diabaikan
            # koordinat berkas ini 3D (lon, lat, z) - ambil 2D untuk matplotlib
            polys.append([pt[:2] for pt in polygon[0]])
            colors.append(cmap(0.18 + 0.82 * tone))

    fig, ax = plt.subplots(figsize=(width_px / 100, width_px / ratio / 100), dpi=200)
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")
    ax.add_collection(PolyCollection(polys, facecolors=colors,
                                     edgecolors="#8A4B1A", linewidths=1.1))
    ax.autoscale_view()
    ax.set_aspect("equal")
    ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return buf.getvalue()


def _replace_picture(shape, blob):
    """Ganti isi gambar tanpa mengubah kotaknya (garis penunjuk deck tetap pas)."""
    _part, r_id = shape.part.get_or_add_image_part(io.BytesIO(blob))
    shape._element.blipFill.blip.set(
        "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed", r_id)


def _pari_kpi_cards(prs, totals, indikator, unit_suffix, fmt):
    """Fill the per-province KPI blocks (Bintang/NonBintang + delta) on a slide."""
    jenis_bintang, jenis_non = "Hotel Bintang", "Hotel Non Bintang"
    for slide in prs.slides:
        for group in slide.shapes:
            if group.shape_type != 6:
                continue
            children = list(group.shapes)
            texts = [c for c in children if c.has_text_frame and c.text_frame.text.strip()]
            if not texts:
                continue
            prov = PROVINSI_KEY.get(" ".join(texts[0].text_frame.text.upper().split()))
            if not prov:
                continue
            tb = totals.get((indikator, jenis_bintang), {}).get(prov)
            tn = totals.get((indikator, jenis_non), {}).get(prov)
            if not tb or not tn:
                continue
            level = []
            for txt in texts:
                value = txt.text_frame.text.strip()
                if re.fullmatch(r"[\d.,]+\s*" + unit_suffix, value):
                    level.append(txt)
            deltas = [txt for txt in texts if txt.text_frame.text.strip().endswith("poin")]
            if len(level) >= 2:
                level[0].text_frame.text = fmt(tb[2], unit_suffix)
                level[1].text_frame.text = fmt(tn[2], unit_suffix)
            if len(deltas) >= 2:
                deltas[0].text_frame.text = _idnum(tb[3]) + " poin"
                deltas[1].text_frame.text = _idnum(tn[3]) + " poin"


def build_bahan_tayang_pariwisata(payload):
    thn = int(payload["thn"])
    bln = payload["bln"]
    bulan_no = month_number(bln)

    totals = _pari_totals(thn, bln)
    tren = _pari_tren(thn, bln)
    tamu = _pari_tamu(thn, bulan_no)

    prs = Presentation(str(_deck("Pariwisata")))
    replace_text(prs, _period_replacer(bln, thn))

    # --- slide 2: TPK 13 bulan + jumlah tamu ---
    charts = slide_charts(prs.slides[2])
    if len(charts) < 2:
        raise SystemExit("Deck pariwisata: slide 2 tidak punya dua grafik.")

    seri = tren.get(("tpk", "Hotel Bintang"), {})
    reference = next((v for v in seri.values() if v), [])
    window = reference[-13:]
    cats = [f"{MONTHS_SHORT[m - 1]} {y}" for y, m, _ in window]
    tpk_values = []
    for prov in PROVINSI:
        values = [v for _, _, v in (seri.get(prov) or [])][-13:]
        tpk_values.append([None if pd.isna(v) else round(float(v), 2) for v in values])
    set_chart_data(charts[0].chart, cats, PROVINSI, tpk_values)

    cats_tamu = ["Hotel Berbintang", "Hotel NonBintang"]
    tamu_values = []
    for prov in PROVINSI:
        tamu_values.append([
            tamu.get((prov, "Hotel Bintang")),
            tamu.get((prov, "Hotel Non Bintang")),
        ])
    set_chart_data(charts[1].chart, cats_tamu, PROVINSI, tamu_values)

    # --- slide 5: wisnus (per provinsi, tujuan, tahunan) ---
    bulan, kab, tahunan = _wisnus_frames(thn, bulan_no)
    charts5 = slide_charts(prs.slides[5])
    if len(charts5) >= 3:
        set_chart_data(
            charts5[0].chart, PROVINSI, [MONTHS[bulan_no - 1]],
            [[bulan.get(prov) for prov in PROVINSI]],
        )
        top_kab = sorted(kab.items(), key=lambda kv: kv[1], reverse=True)[:9]
        set_chart_data(
            charts5[1].chart, [label for (_kode, label), _ in top_kab],
            ["Tujuan Kunjungan"],
            [[v for _, v in top_kab]],
        )
        years = list(range(2019, thn + 1))
        set_chart_data(
            charts5[2].chart, [str(y) for y in years], ["Papua"],
            [[tahunan.get(y) for y in years]],
        )

    # --- slide 6: wisman bulanan ---
    charts6 = slide_charts(prs.slides[6])
    if charts6:
        cats_w, values_w = _wisman_monthly(thn, bulan_no)
        set_chart_data(charts6[0].chart, cats_w, ["Wisman"], [values_w])

    # --- kartu KPI TPK (slide 2) dan RLMT (slide 3) ---
    _pari_kpi_cards(prs, totals, "tpk", "%",
                    lambda v, unit: _idnum(v) + "%")
    _pari_kpi_cards(prs, totals, "rlmtgab", "hari",
                    lambda v, unit: _idnum(v) + " hari")

    # --- peta kawasan: TPK (hlm 3) dan RLMT (hlm 4), diwarnai dari data ---
    for slide_idx, indikator in ((2, "tpk"), (3, "rlmtgab")):
        angkat = totals.get((indikator, "Hotel Bintang"), {})
        values = {prov: (angkat.get(prov) or [None, None, None])[2] for prov in PROVINSI}
        shape = next((sh for sh in iter_shapes(prs.slides[slide_idx].shapes)
                      if sh.shape_type == 13 and sh.height > Inches(2)), None)
        if shape is not None and any(v is not None for v in values.values()):
            _replace_picture(shape, _map_png(values, shape.width / shape.height))

    return _save(prs)


# ----------------------------------------------------------------- perdagangan
DAGANG_PROV = ["Papua", "Papua Selatan", "Papua Tengah"]
_DAGANG_ARUS = (("ekspor", "fact_ekspor", "fob"), ("impor", "fact_impor", "cif"))


def _dagang_cache(thn, prev_thn):
    """{(prov, arus): {tahun: [12 nilai Ribu US$]}} â€” dua query untuk semua provinsi."""
    prov_in = ", ".join(f"'{p.upper()}'" for p in DAGANG_PROV)
    out = {}
    for arus, table, col in _DAGANG_ARUS:
        df = _query(
            f"""SELECT UPPER(TRIM(prov)) AS p, tahun AS y, bulan AS m,
                       SUM(COALESCE({col}, 0)) / 1000.0 AS n
                  FROM {table}
                 WHERE UPPER(TRIM(prov)) IN ({prov_in})
                   AND tahun IN (:y1, :y2)
                 GROUP BY 1, 2, 3""",
            {"y1": int(prev_thn), "y2": int(thn)},
        )
        for row in df.itertuples(index=False):
            prov = PROVINSI_KEY.get(" ".join(str(row.p).split()))
            if not prov:
                continue
            bucket = out.setdefault((prov, arus), {})
            values = bucket.get(int(row.y))
            if values is None:
                values = bucket[int(row.y)] = [None] * 12
            values[int(row.m) - 1] = float(row.n)
    return out


def _dagang_series(cache, prov, tahun, arus):
    values = cache.get((prov, arus), {}).get(int(tahun)) or []
    return list(values) + [None] * (12 - len(values))


def _hs2_labels():
    try:
        dim = _query("SELECT kode, label FROM dim_perdagangan_hs2")
        return {str(r.kode): r.label for r in dim.itertuples(index=False)}
    except Exception:
        return {}


def _dagang_hs2(prov, tahun, bulan_no, arus, labels=None):
    if arus == "ekspor":
        table, col, basis = "fact_ekspor", "fob", "PROVORIG"
    else:
        table, col, basis = "fact_impor", "cif", "KPPBC"
    df = _query(
        f"""SELECT hs2 AS kode, SUM(COALESCE({col}, 0)) / 1000.0 AS n
              FROM {table}
             WHERE UPPER(TRIM(prov)) = :prov AND tahun = :thn AND bulan = :bln
               AND basis = :basis
             GROUP BY 1 ORDER BY 2 DESC""",
        {"prov": prov.upper(), "thn": int(tahun), "bln": int(bulan_no), "basis": basis},
    )
    labels = labels if labels is not None else _hs2_labels()
    return [(str(row.kode), labels.get(str(row.kode), f"HS{row.kode}"), float(row.n))
            for row in df.itertuples(index=False)]


def _table_unit(table):
    """1.0 when the table's value column is in Ribu US$, 0.001 when in Juta US$."""
    try:
        head = table.rows[0].cells[1].text.lower()
    except (IndexError, AttributeError):
        return 1.0
    return 0.001 if "juta" in head else 1.0


def _fill_rows_table(table, rows):
    """Write data rows (label, value, share) under an existing header row."""
    scale = _table_unit(table)
    total = (rows[0][1] * scale) if rows else 0.0
    for i in range(1, len(table.rows)):
        row = table.rows[i]
        cells = list(row.cells)
        if i - 1 < len(rows):
            label, value = rows[i - 1][0], rows[i - 1][1] * scale
            share = (value / total * 100.0) if total else 0.0
            cells[0].text = label
            if len(cells) > 1:
                cells[1].text = _idnum(value)
            if len(cells) > 2:
                cells[2].text = _idnum(share)
        else:
            cells[0].text = ""
            for extra in cells[1:]:
                extra.text = ""


def build_bahan_tayang_perdagangan(payload):
    thn = int(payload["thn"])
    bln = payload["bln"]
    bulan_no = month_number(bln)
    prev_bln, prev_thn = prev_period(bln, thn)
    prev_no = month_number(prev_bln)

    prs = Presentation(str(_deck("Perdangangan")))
    replace_text(prs, _period_replacer(bln, thn))

    cache = _dagang_cache(thn, int(thn) - 1)
    labels_12 = [MONTHS_SHORT[m] for m in range(12)]
    if bulan_no == 1:
        prev_label = f"Des {int(thn) - 1}"
    else:
        prev_label = f"{MONTHS_SHORT[prev_no - 1]} {thn}"
    cats_level = [f"{MONTHS_SHORT[bulan_no - 1]} {thn}", prev_label]

    def fill_biaya_slide(slide_idx, arus, chart_order):
        """chart_order: per provinsi, urutan ('bar'|'line') sesuai deck."""
        charts = slide_charts(prs.slides[slide_idx])
        if not charts:
            return
        for pi, prov in enumerate(DAGANG_PROV):
            cur = _dagang_series(cache, prov, thn, arus)
            last_year = _dagang_series(cache, prov, int(thn) - 1, arus)
            # batang: bulan berjalan vs bulan sebelumnya (Des tahun lalu saat Januari)
            if bulan_no == 1:
                prev_value = last_year[11]
            else:
                prev_value = cur[prev_no - 1]
            for offset, kind in enumerate(chart_order):
                ci = pi * len(chart_order) + offset
                if ci >= len(charts):
                    continue
                chart = charts[ci].chart
                if kind == "bar":
                    set_chart_data(
                        chart, cats_level, [arus.title()],
                        [[cur[bulan_no - 1], prev_value]],
                    )
                else:
                    values_2026 = [v if m < bulan_no else None for m, v in enumerate(cur)]
                    set_chart_data(
                        chart, labels_12, [str(int(thn) - 1), str(int(thn))],
                        [last_year, values_2026],
                    )

    fill_biaya_slide(2, "ekspor", ["bar", "line"])
    fill_biaya_slide(8, "impor", ["line", "bar"])

    # --- tabel HS2: ekspor (slide 3,4,5) dan impor (slide 9) ---
    labels = _hs2_labels()

    def hs_rows(prov, arus, limit=6):
        data = _dagang_hs2(prov, thn, bulan_no, arus, labels)
        if not data:
            return [("Non Migas", 0.0)]
        total = sum(n for _, _, n in data)
        rows = [("Non Migas", total)]
        for kode, label, nilai in data[:limit]:
            suffix = "" if f"HS{kode}" in label else f" (HS{kode})"
            rows.append((f"  -  {label}{suffix}", nilai))
        return rows

    def hs_table(slide_idx):
        """Tabel golongan HS = tabel yang baris pertamanya 'Non Migas'."""
        for shape in iter_shapes(prs.slides[slide_idx].shapes):
            if not shape.has_table:
                continue
            try:
                first = shape.table.rows[1].cells[0].text
            except (IndexError, AttributeError):
                continue
            if "non migas" in first.lower():
                return shape.table
        return None

    for slide_idx, prov in ((3, "Papua"), (4, "Papua Selatan"), (5, "Papua Tengah")):
        table = hs_table(slide_idx)
        if table is not None:
            _fill_rows_table(table, hs_rows(prov, "ekspor"))

    slide9 = prs.slides[9]
    tables9 = [sh for sh in iter_shapes(slide9.shapes) if sh.has_table]
    for table, prov in zip(tables9, DAGANG_PROV):
        _fill_rows_table(table.table, hs_rows(prov, "impor"))

    # --- neraca perdagangan (slide 12) ---
    _fill_neraca(prs, cache, thn, bln, bulan_no, prev_bln, prev_thn, prev_no)
    return _save(prs)


def _fill_neraca(prs, cache, thn, bln, bulan_no, prev_bln, prev_thn, prev_no):
    tables = [sh for sh in iter_shapes(prs.slides[12].shapes) if sh.has_table]
    if not tables:
        return
    table = tables[0].table
    values = {}
    for prov in DAGANG_PROV:
        now = {arus: _dagang_series(cache, prov, thn, arus) for arus in ("ekspor", "impor")}
        before = {arus: _dagang_series(cache, prov, prev_thn, arus) for arus in ("ekspor", "impor")}
        for arus in ("ekspor", "impor"):
            values[(prov, arus)] = (before[arus][prev_no - 1], now[arus][bulan_no - 1])
    for i in range(2, len(table.rows)):
        cells = list(table.rows[i].cells)
        label = cells[0].text.strip().lower()
        if not (label.startswith("ekspor") or label.startswith("impor")
                or label.startswith("neraca")):
            continue
        for pi, prov in enumerate(DAGANG_PROV):
            base = 1 + pi * 3
            if base + 2 >= len(cells):
                break
            if label.startswith("neraca"):
                e_prev, i_prev = values[(prov, "ekspor")][0], values[(prov, "impor")][0]
                e_cur, i_cur = values[(prov, "ekspor")][1], values[(prov, "impor")][1]
                prev = None if None in (e_prev, i_prev) else e_prev - i_prev
                cur = None if None in (e_cur, i_cur) else e_cur - i_cur
            else:
                arus = "ekspor" if label.startswith("ekspor") else "impor"
                prev, cur = values[(prov, arus)]
            cells[base].text = "" if prev is None else _idnum(prev)
            cells[base + 1].text = "" if cur is None else _idnum(cur)
            growth = ((cur - prev) / prev * 100.0) if (prev and cur is not None) else None
            cells[base + 2].text = "" if growth is None else _idnum(growth)

if __name__ == "__main__":
    # Cek cepat: peta harus mengikuti angka, bukan gambar tetap.
    import hashlib

    a = _map_png({"Papua": 1.0, "Papua Selatan": 2.0, "Papua Tengah": 3.0, "Papua Pegunungan": 4.0})
    b = _map_png({"Papua": 4.0, "Papua Selatan": 3.0, "Papua Tengah": 2.0, "Papua Pegunungan": 1.0})
    assert len(a) > 5000, "png peta terlalu kecil"
    assert hashlib.sha1(a).digest() != hashlib.sha1(b).digest(), "peta tidak berubah saat data berubah"
    print("ok: peta koroplet mengikuti data")
