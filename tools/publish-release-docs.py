#!/usr/bin/env python3
"""Pone al día el README (encabezado de descargas) y los latest.json.

    python3 tools/publish-release-docs.py 3.3.13
    python3 tools/publish-release-docs.py 3.3.12 --legacy 3.3.12

Las notas salen de updates/notas/<versión>.md: la primera línea es el
resumen corto que ve el actualizador del panel; el resto (lista con «- »)
va al README y al Release. Lo usa el workflow de publicación, pero también
se puede correr a mano.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "https://github.com/xG0ta/gota-creator-kit/releases/download"


def legacy_name(version: str) -> str:
    return f"GotaCreatorKit-Legacy-Premiere-2021-a-2025.5-{version}.zxp"


def read_notes(version: str) -> tuple[str, str]:
    path = ROOT / "updates" / "notas" / f"{version}.md"
    if not path.exists():
        raise SystemExit(f"Faltan las notas: {path.relative_to(ROOT)}")
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    summary = lines[0].strip()
    body = "\n".join(lines[1:]).strip()
    if not summary or not body:
        raise SystemExit("Las notas deben tener un resumen (1.ª línea) y una lista de cambios.")
    return summary, body


def header(version: str, legacy: str) -> str:
    base = f"{REPO}/v{version}"
    legacy_note = "Para Premiere 2024 y anteriores. Instálalo con ZXP Installer."
    if legacy != version:
        legacy_note += f" La Legacy {version} llegará firmada en unos días."
    return (
        f"## Descarga correcta — versión {version}\n\n"
        "| Tu computadora | Descarga esto | Importante |\n"
        "| --- | --- | --- |\n"
        f"| **Windows** | [Instalador completo para Windows — GotaCreatorKit-{version}-Windows.exe]({base}/GotaCreatorKit-{version}-Windows.exe) | Recomendado. Instala el panel y el motor local. También elimina copias UXP antiguas antes de instalar. |\n"
        f"| **Premiere 2026 sin Creative Cloud** | [ZIP completo: EXE + CCX — GotaCreatorKit-{version}-Premiere-2026-sin-Creative-Cloud.zip]({base}/GotaCreatorKit-{version}-Premiere-2026-sin-Creative-Cloud.zip) | Ejecuta primero el EXE y luego instala el CCX con un gestor compatible. Así también queda instalado el motor local. |\n"
        f"| **macOS** | [Instalador completo para macOS — GotaCreatorKit-{version}-macOS.zip]({base}/GotaCreatorKit-{version}-macOS.zip) | Descomprime el ZIP completo y abre **Instalar Gota Creator Kit.app**. |\n"
        f"| **Premiere Pro 2021–2025.5** | [Gota Creator Kit Legacy {legacy} — ZXP]({REPO}/v{legacy}/{legacy_name(legacy)}) | {legacy_note} |\n\n"
    )


def update_readme(version: str, legacy: str, body: str) -> None:
    path = ROOT / "README.md"
    text = path.read_text(encoding="utf-8")
    start = text.index("## Descarga correcta")
    end = text.index("\n## ", start + 3) + 1
    text = text[:start] + header(version, legacy) + text[end:]
    heading = f"## Novedades de {version}"
    if heading not in text:
        first = text.index("## Novedades de ")
        text = text[:first] + f"{heading}\n\n{body}\n\n" + text[first:]
    text = re.sub(r"GotaCreatorKit-\d+\.\d+\.\d+-Windows\.exe`", f"GotaCreatorKit-{version}-Windows.exe`", text)
    path.write_text(text, encoding="utf-8")


def update_manifests(version: str, legacy: str, summary: str) -> None:
    base = f"{REPO}/v{version}"
    data = {
        "version": version,
        "displayVersion": f"{version} — Gota Creator Kit ☔",
        "downloadUrl": f"{base}/GotaCreatorKit-{version}-Windows.exe",
        "windowsDownloadUrl": f"{base}/GotaCreatorKit-{version}-Windows.exe",
        "macDownloadUrl": f"{base}/GotaCreatorKit-{version}-macOS.zip",
        "legacyDownloadUrl": f"{REPO}/v{legacy}/{legacy_name(legacy)}",
        "notes": summary,
    }
    for relative in ("latest.json", "updates/latest.json"):
        (ROOT / relative).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument("--legacy", help="versión de la Legacy firmada (por omisión, la misma)")
    parser.add_argument("--release-notes", help="escribe aquí el texto del Release")
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        raise SystemExit("Versión inválida")
    legacy = args.legacy or args.version
    summary, body = read_notes(args.version)
    update_readme(args.version, legacy, body)
    update_manifests(args.version, legacy, summary)
    if args.release_notes:
        Path(args.release_notes).write_text(f"{summary}\n\n{body}\n", encoding="utf-8")
    print(f"README y latest.json listos para {args.version} (Legacy {legacy}).")


if __name__ == "__main__":
    main()
