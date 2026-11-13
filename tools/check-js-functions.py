#!/usr/bin/env python3
"""Falla si el panel llama con «await» a una función que no existe.

En 3.3.12 se borró recordSilenceOperation pero los botones la seguían
llamando: «Analizar silencios» se quedaba congelado en «Leyendo la selección
de Premiere…». node --check no detecta esto (la sintaxis es correcta).

    python3 tools/check-js-functions.py plugin/main.js legacy-cep/js/*.js
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

GLOBALS = {"fetch", "require", "import"}


def strip(code: str) -> str:
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    code = re.sub(r"(?m)^\s*//.*$", "", code)
    return code


def missing(path: Path) -> list[str]:
    code = strip(path.read_text(encoding="utf-8"))
    called = set(re.findall(r"\bawait\s+([A-Za-z_$][\w$]*)\s*\(", code))
    problems = []
    for name in sorted(called - GLOBALS):
        defined = re.search(
            r"(function\s*\*?\s+%(n)s\s*\(|(const|let|var)\s+%(n)s\b|\b%(n)s\s*=[^=]|"
            r"[{,(]\s*%(n)s\s*[,)}=]|^\s*(async\s+)?%(n)s\s*\([^)]*\)\s*\{)" % {"n": re.escape(name)},
            code, re.M,
        )
        if not defined:
            problems.append(name)
    return problems


def main(paths: list[str]) -> int:
    failed = False
    for raw in paths:
        problems = missing(Path(raw))
        if problems:
            failed = True
            print(f"FALLA {raw}: se llama a funciones que no existen: {', '.join(problems)}")
        else:
            print(f"OK    {raw}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["plugin/main.js"]))
