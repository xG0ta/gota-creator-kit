#!/usr/bin/env python3
"""Prueba «Quitar silencios» del panel UXP sin Premiere.

    python3 tools/premiere-sim/run.py

Junta mock.js (una imitación pequeña de la API de Premiere, donde las
referencias a clips caducan tras cada transacción como en el Premiere real),
plugin/main.js y cada test-*.js, y los corre con node (o con JavaScriptCore en
la Mac, que no trae node). Falla si alguna prueba no imprime
«VERIFICACIÓN: OK» o imprime un ERROR.

Esto NO sustituye probar dentro de Premiere: solo cubre la lógica del armado.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
JSC = Path("/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc")
EXPORTS = [
    "buildSequenceWithoutSilences",
    "overwriteProjectItemAction",
    "markSilencesInSequence",
    "clearSilenceMarkers",
]
PRELUDE = 'if (typeof print === "undefined") { globalThis.print = function () { console.log.apply(console, arguments); }; }\n'


def engine() -> list[str]:
    node = shutil.which("node")
    if node:
        return [node]
    if JSC.exists():
        return [str(JSC)]
    raise SystemExit("Hace falta node o JavaScriptCore para correr la simulación.")


def main() -> int:
    plugin = (ROOT / "plugin" / "main.js").read_text(encoding="utf-8")
    wrapped = "var __api = (function(){\n" + plugin + "\nreturn { " + ", ".join(EXPORTS) + " };\n})();\n"
    mock = (HERE / "mock.js").read_text(encoding="utf-8")
    command = engine()
    failures = 0
    with tempfile.TemporaryDirectory() as folder:
        for test in sorted(HERE.glob("test-*.js")):
            combined = Path(folder) / ("combined-" + test.name)
            combined.write_text(PRELUDE + mock + "\n" + wrapped + "\n" + test.read_text(encoding="utf-8"), encoding="utf-8")
            result = subprocess.run(command + [str(combined)], capture_output=True, text=True, timeout=120)
            output = result.stdout + result.stderr
            ok = result.returncode == 0 and "VERIFICACIÓN: OK" in output and "ERROR" not in output and "FALLA" not in output
            print(("OK    " if ok else "FALLA ") + test.name)
            if not ok:
                failures += 1
                print(output)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
