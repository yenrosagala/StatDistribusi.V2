#!/usr/bin/env python3
import json
import sys
import os
from pathlib import Path
HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "py"
ROOT = HERE.parent
# Prefer the vendored copy so node-app works standalone; fall back to the
# sibling Streamlit project when it is present (keeps both in sync).
for _p in (ROOT, VENDOR, HERE):  # inserted last = highest priority
    if _p.exists() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
os.chdir(HERE)  # keep relative asset paths inside node-app


from sqlalchemy import text
from modules.database import get_engine
from modules.ai_backup import generate_text, get_gemini_client, get_openrouter_key
from modules.report_page import normalize_narrative
import pandas as pd
# Port of the Streamlit prompt builder (pariwisata/ai.py) - keeps both apps' output
# on the same persona and the same comparison table.
from pariwisata_prompt import build_prompt
from modules.exim_prompt import SECTIONS as EXIM_SECTIONS
from modules.exim_prompt import build_prompt as build_exim_prompt


MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
               "Juli", "Agustus", "September", "Oktober", "November", "Desember"]

INDICATOR_LABELS = {
    "tpk": "Tingkat Penghunian Kamar (TPK, %)",
    "rlmtgab": "Rata-rata Lama Menginap Tamu (RLMTGAB, malam)",
}


def run(payload):
    """Generate one AI narrative for `payload` and persist it.

    Returns {"ok": True, "text": ...} on success, else {"error": ...}.
    Imported in-process by export_service.py (POST /narrative) so no child
    process is needed; main() below keeps the stdin/stdout CLI contract.
    """
    try:
        payload = payload or {}
        kind = payload.get("kind")  # pariwisata|transportasi
        prov = payload.get("provinsi") or payload.get("province")
        tahun = int(payload.get("tahun") or payload.get("year"))
        bulan = int(payload.get("bulan") or payload.get("month"))
        jenis = payload.get("jenis_akomodasi") or payload.get("jenis")
        indikator = payload.get("indikator") or payload.get("indicator") or payload.get("label")
        moda = payload.get("moda")
        table_no = payload.get("table_no")
        action = payload.get("action") or "generate"  # generate|regenerate

        eng = get_engine()
        client = get_gemini_client()

        if kind == "pariwisata":
            if not all([prov, tahun, bulan, jenis, indikator]):
                return {"error": "missing params"}
            ind_col = str(indikator).strip().lower()
            if ind_col not in INDICATOR_LABELS:
                return {"error": f"indikator tidak dikenal: {indikator}"}
            params = {"province": str(prov).strip(), "year": tahun, "month": bulan,
                      "jenis_akomodasi": jenis, "indicator": ind_col}
            # Identical prompt to the Streamlit app: comparison table with MTM/YoY
            # deltas, the Prov_Jenis Total row and RSE markers, under the
            # "Kepala Pusat Statistik" persona (see pariwisata_prompt.py).
            try:
                prompt = build_prompt(eng, prov, tahun, bulan, jenis, ind_col)
            except ValueError as exc:
                return {"error": str(exc)}
            txt, src = generate_text(prompt, temperature=0.3, client=client)
            if not txt:
                return {"error": "ai failed"}
            txt = normalize_narrative(txt)
            # Delete+insert keeps exactly one row per (province, year, month,
            # jenis_akomodasi, indicator); the Node reader expects a single narrative.
            with eng.begin() as c:
                c.execute(text(
                    "DELETE FROM pariwisata_ai_narratives WHERE province=:province AND year=:year "
                    "AND month=:month AND jenis_akomodasi=:jenis_akomodasi AND indicator=:indicator"
                ), params)
                c.execute(text(
                    "INSERT INTO pariwisata_ai_narratives (province,year,month,jenis_akomodasi,indicator,narrative) "
                    "VALUES (:province,:year,:month,:jenis_akomodasi,:indicator,:narrative)"
                ), {**params, "narrative": txt})
            return {"ok": True, "text": txt, "provider": src}

        if kind == "transportasi":
            label_t = payload.get("label") or indikator or payload.get("indikator")
            if not all([prov, tahun, bulan, moda, label_t]):
                return {"error": "missing params"}
            report_type = f"report_{moda}_{label_t}"
            # get_comparison_data / collect_report_tables take the month NAME, and
            # the Node reader looks the cache up as `prov|monthName|year` (see the
            # transportNarratives call in server.js). Passing the int month raised
            # KeyError: 9 and wrote an unreadable period_key.
            bln_name = MONTH_NAMES[bulan - 1] if 1 <= bulan <= 12 else str(bulan)
            period_key = f"{prov}|{bln_name}|{tahun}"
            prev_month = bulan - 1 if bulan > 1 else 12
            prev_year = tahun if bulan > 1 else tahun - 1
            params_r = {"report_type": report_type, "period_key": period_key}
            try:
                from modules.report_page import get_comparison_data, prepare_table_item, collect_report_tables
            except Exception as e:
                return {"error": f"import report_page failed: {e}"}
            # try to build real item for this label
            items = collect_report_tables(str(prov), int(tahun), bln_name)
            item = None
            for it in items:
                if it.get("moda") == str(moda) and str(it.get("label")) == str(label_t):
                    item = it
                    break
            if item is None and moda and label_t:
                # ponytail: fallback minimal
                cu, pr, cc, cp, p_bln, p_thn = get_comparison_data(str(prov), int(tahun), bln_name, str(moda))
                if cu.empty:
                    return {"error": "no data"}
                if str(moda) == "Transportasi Udara":
                    row_col = "nama_bandara"
                else:
                    row_col = "nama_kabkota" if str(prov) == "Papua Tengah" else "nama_pelabuhan"
                targets = {
                    "Penumpang Datang": ("penumpang_datang",),
                    "Penumpang Berangkat": ("penumpang_berangkat",),
                    "Barang Bongkar (Ton)": ("barang_bongkar_kg",),
                    "Barang Muat (Ton)": ("barang_muat_kg",),
                    "Penumpang Turun": ("dn_penumpang_turun",),
                    "Penumpang Naik": ("dn_penumpang_naik",),
                    "Barang Bongkar (Ton)": ("dn_bongkar_barang_ton",),
                    "Barang Muat (Ton)": ("dn_muat_barang_ton",),
                }
                # find col
                m = {
                    "Penumpang Datang": "penumpang_datang",
                    "Penumpang Berangkat": "penumpang_berangkat",
                    "Barang Bongkar (Ton)": "barang_bongkar_kg",
                    "Barang Muat (Ton)": "barang_muat_kg",
                    "Penumpang Turun": "dn_penumpang_turun",
                    "Penumpang Naik": "dn_penumpang_naik",
                }
                # laut ton cols may differ
                if str(moda) != "Transportasi Udara":
                    if label_t == "Barang Bongkar (Ton)": m_c = "dn_bongkar_barang_ton"
                    elif label_t == "Barang Muat (Ton)": m_c = "dn_muat_barang_ton"
                    else: m_c = m.get(label_t)
                else:
                    if label_t == "Barang Bongkar (Ton)": m_c = "barang_bongkar_kg"
                    elif label_t == "Barang Muat (Ton)": m_c = "barang_muat_kg"
                    else: m_c = m.get(label_t)
                try:
                    item = prepare_table_item(cu, pr, cc, cp, m_c, label_t, row_col, int(tahun), bln_name, p_bln, p_thn, prov=str(prov), moda=str(moda))
                except Exception as e:
                    return {"error": f"prepare failed: {e}"}
            try:
                from modules.report_page import generate_single_narrative_ai
                txt, src = generate_single_narrative_ai(item['report_display_brs'].reset_index(), item['label'], str(prov), str(moda), item['bln'], item['thn'], item['prev_bln'], item['prev_thn'],
                                                   force=(action == 'regenerate'))
            except Exception as e:
                return {"error": f"gen failed: {e}"}
            if not txt:
                return {"error": "ai failed"}
            txt = normalize_narrative(txt)
            if action == "regenerate":
                try:
                    from modules.database import delete_db_narrative
                    delete_db_narrative(report_type, period_key)
                except Exception:
                    with eng.begin() as c:
                        c.execute(text("DELETE FROM ai_narratives_cache WHERE report_type=:report_type AND period_key=:period_key"), params_r)
            try:
                from modules.database import save_db_narrative
                save_db_narrative(report_type, period_key, txt)
            except Exception:
                with eng.begin() as c:
                    c.execute(text("INSERT INTO ai_narratives_cache (report_type,period_key,narrative_text,updated_at) VALUES (:report_type,:period_key,:narrative,now()) ON CONFLICT DO NOTHING"), {**params_r, "narrative": txt})
            return {"ok": True, "text": txt}

        if kind == "perdagangan":
            bagian = payload.get("bagian")
            if not all([prov, tahun, bulan, bagian]):
                return {"error": "missing params"}
            if bagian not in EXIM_SECTIONS:
                return {"error": f"bagian tidak dikenal: {bagian}"}

            # Label ramah untuk kode HS 2 digit dan kode negara, supaya prompt
            # tidak berisi kode mentah.
            hs_label = {}
            try:
                rows = eng.connect().execute(text("SELECT kode, label FROM dim_perdagangan_hs2"))
                hs_label = {str(r[0]): r[1] for r in rows}
            except Exception:
                hs_label = {}
            from modules.exim_prompt import NEGARA_LABEL as _NEG

            def label_dari_kode(kode):
                kode = str(kode)
                if kode.isdigit() and len(kode) == 2 and kode in hs_label:
                    return hs_label[kode]
                if kode.isdigit() and len(kode) == 2:
                    return f"HS{kode}"
                return _NEG.get(kode.upper(), kode)

            try:
                prompt, _data = build_exim_prompt(eng, prov, tahun, bulan, bagian, label_dari_kode)
            except ValueError as exc:
                return {"error": str(exc)}
            txt, src = generate_text(prompt, temperature=0.3, client=client)
            if not txt:
                return {"error": "ai failed"}
            txt = normalize_narrative(txt)

            params_p = {"province": str(prov).strip(), "year": tahun, "month": bulan,
                        "bagian": bagian}
            with eng.begin() as c:
                c.execute(text(
                    "DELETE FROM perdagangan_ai_narratives WHERE province=:province "
                    "AND year=:year AND month=:month AND bagian=:bagian"), params_p)
                c.execute(text(
                    "INSERT INTO perdagangan_ai_narratives "
                    "(province,year,month,bagian,narrative,provider) "
                    "VALUES (:province,:year,:month,:bagian,:narrative,:provider)"),
                    {**params_p, "narrative": txt, "provider": src})
            return {"ok": True, "text": txt, "provider": src}

        return {"error": "bad kind"}
    except Exception as e:
        return {"error": str(e)}


def main():
    """CLI entry point: one JSON object on stdin -> one JSON object on stdout."""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        print(json.dumps({"error": f"payload JSON tidak valid: {exc}"}))
        return 1
    result = run(payload)
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())