#!/usr/bin/env python3
"""Revisa que el ZIP de macOS se pueda ejecutar en una Mac.

Los scripts deben tener saltos LF (con CRLF bash falla: «bad interpreter»)
y el bit de ejecución; el motor debe traer la versión esperada.

    python3 tools/check-mac-zip.py outputs/GotaCreatorKit-3.3.13-macOS.zip 3.3.13
"""
import re
import sys
import zipfile

path, version = sys.argv[1], sys.argv[2]
problems = []
with zipfile.ZipFile(path) as archive:
    for info in archive.infolist():
        name = info.filename
        script = name.endswith((".command", ".sh")) or "/Contents/MacOS/" in name
        if not script:
            continue
        if b"\r" in archive.read(name):
            problems.append(f"saltos de Windows (CRLF): {name}")
        if name.endswith(".command") or "/Contents/MacOS/" in name:
            if not (info.external_attr >> 16) & 0o111:
                problems.append(f"sin permiso de ejecución: {name}")
    engine = archive.read("payload/service/app/main.py").decode("utf-8")
    found = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', engine)
    if not found or found.group(1) != version:
        problems.append(f"el motor dice {found and found.group(1)}, no {version}")
if problems:
    sys.exit("El ZIP de macOS no sirve:\n- " + "\n- ".join(problems))
print(f"ZIP de macOS correcto: {path}")
