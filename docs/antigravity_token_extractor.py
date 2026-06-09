#!/usr/bin/env python3
"""
Antigravity (agy CLI) token-usage extractor.

Reverse-engineered 2026-06-08: token usage lives in protobuf BLOBs in
~/.gemini/antigravity-cli/conversations/<conv-id>.db, table `gen_metadata`,
one row per LLM generation. No .proto needed — we read the wire format directly.

Usage submessage path: top.field(1).field(4)
  field 1  = system-prompt tokens (constant ~1020, cached)
  field 2  = input/context tokens (variable)
  field 6  = fixed input overhead (constant ~24)
  field 3  = total output tokens  (proven invariant: field3 == field9 + field10)
  field 9  = output split A (reasoning/thoughts — label inferred)
  field 10 = output split B (response text — label inferred)

Per generation: input = f1 + f2 + f6 ; output = f3.
Session totals = SUM over all gen_metadata rows.

No native USD cost is available for Antigravity (tokens-only).
"""
import sqlite3, glob, os, sys


def _read_varint(b, i):
    shift = val = 0
    while True:
        x = b[i]; i += 1
        val |= (x & 0x7F) << shift
        if not (x & 0x80):
            return val, i
        shift += 7


def _parse(b):
    out = {}; i = 0; n = len(b)
    while i < n:
        try:
            tag, i = _read_varint(b, i)
        except IndexError:
            break
        fn, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = _read_varint(b, i)
        elif wt == 2:
            ln, i = _read_varint(b, i); v = b[i:i+ln]; i += ln
        elif wt == 1:
            v = b[i:i+8]; i += 8
        elif wt == 5:
            v = b[i:i+4]; i += 4
        else:
            break
        out.setdefault(fn, []).append((wt, v))
    return out


def _sub(p, fn):
    for wt, v in p.get(fn, []):
        if wt == 2:
            return _parse(v)
    return {}


def _vint(p, fn):
    for wt, v in p.get(fn, []):
        if wt == 0:
            return v
    return None


def session_tokens(db_path):
    """Return {'input', 'output', 'total', 'generations'} for one conversation .db."""
    rows = sqlite3.connect(db_path).execute(
        "SELECT data FROM gen_metadata ORDER BY idx").fetchall()
    inp = out = gens = 0
    for (data,) in rows:
        if not data:
            continue
        usage = _sub(_sub(_parse(data), 1), 4)
        f1, f2, f3, f6 = (_vint(usage, k) for k in (1, 2, 3, 6))
        if f2 is None or f3 is None:
            continue
        gens += 1
        inp += (f1 or 0) + f2 + (f6 or 0)
        out += f3
    return {"input": inp, "output": out, "total": inp + out, "generations": gens}


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.gemini/antigravity-cli/conversations")
    dbs = sorted(glob.glob(os.path.join(root, "*.db")))
    if not dbs:
        print(f"no .db files under {root}"); sys.exit(1)
    grand = {"input": 0, "output": 0, "total": 0}
    for db in dbs:
        t = session_tokens(db)
        for k in grand:
            grand[k] += t[k]
        print(f"{os.path.basename(db)[:8]}  gens={t['generations']:>3}  "
              f"in={t['input']:>8}  out={t['output']:>7}  total={t['total']:>8}")
    print(f"{'TOTAL':8}  {'':>8}  in={grand['input']:>8}  "
          f"out={grand['output']:>7}  total={grand['total']:>8}")
