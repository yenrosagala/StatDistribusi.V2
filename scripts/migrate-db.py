"""Migrasi database: Supabase -> PostgreSQL tujuan (mis. server BPS 10.94.0.230).

Hanya skema `public` yang dipindahkan. Skema internal Supabase (auth, storage,
realtime) sengaja TIDAK ikut karena objek itu dikelola Supabase dan tidak
berlaku di PostgreSQL biasa.

Pemakaian:
    python scripts/migrate-db.py --check
    python scripts/migrate-db.py --target "postgresql://user:pass@10.94.0.230:5432/postgres?sslmode=disable"

Opsi:
    --check            hanya dump sumber dan tampilkan jumlah baris (tidak menyentuh tujuan)
    --dry-run          tampilkan rencana tanpa menjalankan restore
    --jobs N           paralel restore (default 1)
    --no-clean         jangan DROP objek yang sudah ada di tujuan (default: bersihkan dulu)
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT.parent / ".streamlit" / "secrets.toml"

PG_DUMP = os.environ.get("PG_DUMP", "pg_dump")
PG_RESTORE = os.environ.get("PG_RESTORE", "pg_restore")
PSQL = os.environ.get("PSQL", "psql")


def source_dsn() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    if not SECRETS.exists():
        raise SystemExit(f"Tidak ada DATABASE_URL dan {SECRETS} tidak ditemukan.")
    m = re.search(r'DATABASE_URL\s*=\s*["\']([^"\']+)["\']', SECRETS.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit("DATABASE_URL tidak ditemukan di secrets.toml.")
    return m.group(1)


def safe(dsn: str) -> str:
    """Samarkan kredensial sebelum dicetak."""
    return re.sub(r"//[^@]*@", "//***:***@", str(dsn))


def run(cmd, timeout=900):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


def daftar_tabel(dsn: str):
    sql = ("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
           "WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname;")
    code, out, err = run([PSQL, dsn, "-At", "-c", sql])
    if code != 0:
        raise SystemExit(f"psql gagal membaca daftar tabel: {err.strip()}")
    return [b.strip() for b in out.splitlines() if b.strip()]


def source_counts(dsn: str):
    """Jumlah baris NYATA per tabel.

    reltuples bisa bernilai -1 untuk tabel yang belum pernah dianalisis, jadi
    hitungan langsung lebih dapat dipercaya untuk verifikasi migrasi.
    """
    hasil = []
    for nama in daftar_tabel(dsn):
        code, out, err = run([PSQL, dsn, "-At", "-c", f'SELECT count(*) FROM public."{nama}";'])
        if code != 0:
            hasil.append((nama, None))
            continue
        hasil.append((nama, int(out.strip() or 0)))
    return hasil


def main() -> int:
    ap = argparse.ArgumentParser(description="Migrasi Supabase -> PostgreSQL tujuan")
    ap.add_argument("--target", help="DSN tujuan, mis. postgresql://user:pass@10.94.0.230:5432/postgres?sslmode=disable")
    ap.add_argument("--check", action="store_true", help="hanya periksa sumber")
    ap.add_argument("--dry-run", action="store_true", help="tampilkan rencana")
    ap.add_argument("--jobs", default="1", help="paralel restore (default 1)")
    ap.add_argument("--no-clean", action="store_true", help="jangan DROP objek lama di tujuan")
    a = ap.parse_args()

    if not a.check and not a.target:
        ap.error("butuh --target atau --check")

    if a.target and re.search(r"sslmode=(require|verify)", a.target):
        print("Server tujuan tidak mendukung SSL (menjawab 'N' pada SSLRequest).", file=sys.stderr)
        print("Pakai ?sslmode=disable pada DSN tujuan.", file=sys.stderr)
        return 2

    src = source_dsn()
    print("sumber :", safe(src))
    if a.target:
        print("tujuan :", safe(a.target))

    # Menulis langsung ke direktori temp (bukan subdirektori baru): sebagian
    # sandbox Windows memblokir pembuatan/menulis subdirektori temp.
    dump = Path(tempfile.gettempdir()) / "migrasi-public.dump"
    try:

        print("\n[1/4] dump skema public dari sumber ...")
        code, _out, err = run([PG_DUMP, "--schema=public", "--no-owner", "--no-privileges",
                               "--format=custom", "-f", str(dump), src])
        if code != 0:
            print("pg_dump gagal:", err.strip(), file=sys.stderr)
            return 1
        print(f"      ok, {dump.stat().st_size / 1024:.1f} KB")

        print("\n[2/4] jumlah baris di sumber ...")
        total = 0
        for nama, n in source_counts(src):
            if n is None:
                print(f"      {nama:<26} (gagal dibaca)")
            else:
                total += n
                print(f"      {nama:<26} {n:>7}")
        print(f"      {'TOTAL':<26} {total:>7}")

        if a.check:
            print("\nSelesai (--check): tidak ada yang ditulis ke tujuan.")
            return 0

        if a.dry_run:
            print("\n[dry-run] rencana restore:")
            print(f"      {PG_RESTORE} {'--clean --if-exists ' if not a.no_clean else ''}"
                  f"--no-owner --no-privileges --jobs {a.jobs} -d <tujuan> {dump.name}")
            return 0

        print("\n[3/4] uji koneksi ke tujuan ...")
        env = {**os.environ, "PGSSLMODE": "disable"}
        r = subprocess.run([PSQL, a.target, "-At", "-c", "SELECT version()"],
                           capture_output=True, text=True, env=env, timeout=60)
        if r.returncode != 0:
            print("tidak bisa terhubung ke tujuan:", (r.stderr or "").strip(), file=sys.stderr)
            return 1
        print("      terhubung:", (r.stdout or "").strip().split(" on ")[0])

        print("\n[4/4] restore ke tujuan ...")
        cmd = [PG_RESTORE, "--no-owner", "--no-privileges", "--jobs", str(a.jobs)]
        if not a.no_clean:
            cmd += ["--clean", "--if-exists"]
        cmd += ["-d", a.target, str(dump)]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=1800)
        # pg_restore mengembalikan 1 untuk peringatan non-fatal (mis. DROP objek yang belum ada).
        if r.returncode > 1:
            print(f"pg_restore gagal (kode {r.returncode}):", (r.stderr or "").strip()[:800], file=sys.stderr)
            return 1
        if (r.stderr or "").strip():
            for baris in (r.stderr or "").strip().splitlines()[:5]:
                print("      peringatan:", baris)

        print("\n[verifikasi] bandingkan jumlah baris sumber vs tujuan ...")
        asal = dict(source_counts(src))
        beda = []
        for nama, n_asal in asal.items():
            code, out, err = run([PSQL, a.target, "-At", "-c", f'SELECT count(*) FROM public."{nama}";'],
                                 timeout=120)
            n_tujuan = int(out.strip()) if code == 0 and out.strip().isdigit() else None
            status = "ok" if n_tujuan == n_asal else "BEDA"
            if n_tujuan != n_asal:
                beda.append(f"{nama}: asal {n_asal}, tujuan {n_tujuan}")
            print(f"      {nama:<26} {str(n_asal):>7} -> {str(n_tujuan):>7}  {status}")
        if beda:
            print("\nPERINGATAN: ada tabel yang jumlah barisnya tidak sama:", file=sys.stderr)
            for b in beda:
                print("  -", b, file=sys.stderr)
            print("Periksa sebelum mengarahkan aplikasi ke tujuan.", file=sys.stderr)
            return 1

        print("\nSelesai. Langkah berikutnya:")
        print("  1. Arahkan DATABASE_URL aplikasi ke tujuan.")
        print("  2. Jalankan uji cepat: npm start, buka /perdagangan dan /pariwisata.")
        print("  3. Setelah yakin, baru hentikan pemakaian Supabase.")
    finally:
        try:
            dump.unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
