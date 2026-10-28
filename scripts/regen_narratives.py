"""Resumable bulk regeneration of every stored AI narrative.

Chunked + concurrent so one invocation finishes well inside the sandbox's ~300 s
tool limit:
    python _regen2.py [limit] [workers]

Progress is read back from bulk_regen.log ("... OK <key>") so re-running skips what
is already done.
"""
import json
import os
import re
import sys
import time
import tomllib
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for _p in (ROOT, os.path.join(HERE, "vendor", "py"), HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

with open(os.path.join(ROOT, ".streamlit", "secrets.toml"), "rb") as fh:
    os.environ["DATABASE_URL"] = tomllib.load(fh)["DATABASE_URL"]

from sqlalchemy import text  # noqa: E402
from modules.database import get_engine  # noqa: E402
from modules.etl_engine import MONTH_NAMES  # noqa: E402

SIDECAR = "http://127.0.0.1:8765/narrative"
LOG = os.path.join(HERE, "bulk_regen.log")
BANS = ["menandakan", "mengisyaratkan", "signifikan", "komprehensif", "mendalam",
        "kontras", "fundamental", "krusial", "kerangka", "dinamika", "bukan hanya", "\u2014"]

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 18
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 3


def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def done_keys():
    if not os.path.exists(LOG):
        return set()
    out = set()
    with open(LOG, encoding="utf-8") as fh:
        for line in fh:
            m = re.search(r"OK (.+?) \(\d+ chars\)", line)
            if m:
                out.add(m.group(1))
    return out


def build_items():
    eng = get_engine()
    items = []
    for prov, year, month, jenis, ind in eng.connect().execute(text(
            "SELECT province, year, month, jenis_akomodasi, indicator "
            "FROM pariwisata_ai_narratives ORDER BY year, month, province, jenis_akomodasi, indicator")).fetchall():
        items.append(({"kind": "pariwisata", "provinsi": prov, "tahun": int(year), "bulan": int(month),
                       "jenis_akomodasi": jenis, "indikator": ind, "action": "regenerate"},
                      f"pariwisata|{prov}|{year}-{month}|{jenis}|{ind}"))
    for report_type, period_key in eng.connect().execute(text(
            "SELECT DISTINCT report_type, period_key FROM ai_narratives_cache "
            "WHERE report_type LIKE 'report_%' ORDER BY 1, 2")).fetchall():
        body = report_type[len("report_"):]
        moda = next((m for m in ("Transportasi Udara", "Transportasi Laut") if body.startswith(m + "_")), None)
        if not moda:
            continue
        label = body[len(moda) + 1:]
        parts = period_key.split("|")
        if len(parts) != 3 or parts[1] not in MONTH_NAMES:
            continue
        prov, bln, thn = parts
        items.append(({"kind": "transportasi", "provinsi": prov, "tahun": int(thn),
                       "bulan": MONTH_NAMES.index(bln) + 1, "moda": moda, "label": label,
                       "action": "regenerate"},
                      f"transportasi|{moda}|{label}|{period_key}"))
    return items


def call(payload, timeout=300):
    req = urllib.request.Request(SIDECAR, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def one(item):
    payload, key = item
    err = ""
    for attempt in (1, 2):
        try:
            result = call(payload)
            if result.get("error"):
                err = result["error"]
            else:
                txt = result.get("text") or ""
                hits = sorted({w for w in BANS if w.lower() in txt.lower()})
                return ("OK", key, len(txt), hits)
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
        if attempt == 1:
            time.sleep(4)
    return ("FAIL", key, 0, err)


def main():
    items = build_items()
    done = done_keys()
    todo = [it for it in items if it[1] not in done][:LIMIT]
    log(f"run: total={len(items)} done={len(done)} todo_this_run={len(todo)} workers={WORKERS}")
    if not todo:
        log("nothing left to do")
        return
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for status, key, chars, extra in pool.map(one, todo):
            if status == "OK":
                log(f"[Ok] OK {key} ({chars} chars)" + (f" banned={extra}" if extra else ""))
            else:
                log(f"[!!] FAIL {key}: {extra}")
    log(f"progress: {len(done_keys())}/{len(items)}")


if __name__ == "__main__":
    main()
