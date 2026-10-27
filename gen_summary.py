"""Generate a formal Indonesian summary of analyst justifications.

Reads JSON on stdin:
  { "module": "pariwisata"|"transportasi", "year": 2026, "month": 8,
    "notes": [ {provinsi, entity, jenis, kelas, indicator, comparison,
                growth_value, reason, author, dataset}, ... ] }
Writes JSON on stdout: { "summary": "...", "source": "OpenRouter" }
                    or { "error": "..." }
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from modules.ai_backup import generate_text  # noqa: E402

BULAN = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]

MODULE_LABEL = {"pariwisata": "Pariwisata", "transportasi": "Transportasi"}
COMPARE_LABEL = {"mtm": "M-to-M", "yoy": "Y-on-Y",
                 "dprev": "perubahan vs bulan lalu", "dlast": "perubahan vs tahun lalu"}


def ringkas_label(n):
    prov = n.get("provinsi") or "-"
    if n.get("dataset") == "transportasi_udara":
        prov += " / Udara"
    elif n.get("dataset") == "transportasi_laut":
        prov += " / Laut"
    parts = [prov]
    if n.get("entity"):
        parts.append(str(n["entity"]))
    if n.get("jenis"):
        parts.append(str(n["jenis"]))
    if n.get("kelas") and int(n["kelas"]) > 0:
        parts.append("Kelas %s" % n["kelas"])
    parts.append(str(n.get("indicator", "")))
    return " / ".join(parts)


def build_prompt(payload):
    module = payload.get("module", "pariwisata")
    year = payload.get("year")
    month = payload.get("month")
    notes = payload.get("notes") or []
    coverage = payload.get("coverage") or {}

    lines = []
    for i, n in enumerate(notes, start=1):
        gv = n.get("growth_value")
        gvs = "" if gv is None else ("%+.2f%%" % float(gv))
        lines.append(
            "%d. %s | %s | %s | %s | %s" % (
                i, ringkas_label(n), COMPARE_LABEL.get(n.get("comparison"), n.get("comparison")),
                gvs, str(n.get("reason", "")).strip().replace("\n", " "), n.get("author", "-"),
            )
        )

    return (
        "Anda adalah analis statistik BPS yang menulis dalam bahasa Indonesia formal dan baku.\n"
        "Tugas: rangkum justifikasi analis berikut menjadi ringkasan eksekutif 2-3 paragraf.\n\n"
        "ATURAN WAJIB:\n"
        "- JANGAN mengarang penyebab yang tidak tertulis pada justifikasi.\n"
        "- Sebutkan provinsi/entitas/indikator yang menjadi dasar setiap pernyataan.\n"
        "- Jika cakupan justifikasi rendah, nyatakan hasil ini sebagai temuan awal.\n"
        "- Jangan menyimpulkan kausalitas di luar teks analis.\n"
        "- Gunakan bahasa Indonesia formal, tanpa markdown, tanpa bullet pada paragraf.\n\n"
        "KONTEKS: Modul %s, periode %s %s. Cakupan justifikasi: %s dari %s sel (%s%%).\n\n"
        "JUSTIFIKASI ANALIS:\n%s\n\n"
        "Tulis ringkasan eksekutif sekarang."
        % (
            MODULE_LABEL.get(module, module), BULAN[int(month)] if month else "-", year,
            coverage.get("notes", len(notes)), coverage.get("cells", "?"),
            coverage.get("percent", "?"),
            "\n".join(lines) if lines else "(tidak ada justifikasi)",
        )
    )


def summarise(payload):
    """Return {"summary", "source"} or {"error"}. Never raises."""
    notes = payload.get("notes") or []
    if not notes:
        return {"error": "Tidak ada justifikasi pada periode ini."}

    prompt = build_prompt(payload)
    try:
        text, source = generate_text(prompt, temperature=0.3)
    except Exception as exc:  # noqa: BLE001
        return {"error": "AI gagal: %s" % exc}

    if not text or len(text.strip()) < 80:
        return {"error": "AI tidak mengembalikan ringkasan yang memadai (%s)." % source}

    return {"summary": text.strip(), "source": source or "AI"}


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": "payload tidak valid: %s" % exc}))
        return
    print(json.dumps(summarise(payload)))


if __name__ == "__main__":
    main()
