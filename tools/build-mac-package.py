#!/usr/bin/env python3
"""Arma el paquete de macOS desde una Mac (sin PowerShell).

Hace lo mismo que Set-ReleaseVersion.ps1 + Sync-MacPayload.ps1 + la parte
de macOS de Build-ReleasePackages.ps1:

    python3 tools/build-mac-package.py 3.3.12

Deja outputs/GotaCreatorKit-<versión>-macOS.zip. Windows y el ZXP firmado
de Legacy se siguen armando en Windows (o en GitHub Actions).
"""
from __future__ import annotations

import re
import shutil
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_NAMES = {"__pycache__", "tests"}
EXCLUDED_EXTENSIONS = {".pyc", ".log", ".sqlite3"}

# Mismos marcadores que Set-ReleaseVersion.ps1.
VERSION_MARKERS = [
    ("plugin/manifest.json", r'("version"\s*:\s*")\d+\.\d+\.\d+("\s*,)'),
    ("plugin/main.js", r'(const CURRENT_VERSION\s*=\s*")\d+\.\d+\.\d+(";)'),
    ("service/app/main.py", r'(APP_VERSION\s*=\s*")\d+\.\d+\.\d+(")'),
    ("installer/Program.cs", r'(PackageVersion\s*=\s*")\d+\.\d+\.\d+(")'),
    ("installer/AutoFrameInstaller.csproj", r"(<Version>)\d+\.\d+\.\d+(</Version>)"),
    ("installer/AutoFrameInstaller.csproj", r'(EmbeddedResource Include="payload-)\d+\.\d+\.\d+(-clean\.zip")'),
    ("installer/Supervisor.ps1", r"(version=)\d+\.\d+\.\d+()"),
    ("installer-mac/Supervisor.sh", r"(Gota Creator Kit )\d+\.\d+\.\d+( supervisor)"),
    ("installer-mac/Supervisor.sh", r"(version=)\d+\.\d+\.\d+()"),
    ("installer-mac/Instalar Gota Creator Kit.command",
     r'(echo\s+")\d+\.\d+\.\d+("\s+>\s+"\$INSTALL_DIR/installed-engine-version\.txt")'),
    ("installer-mac/Instalar Gota Creator Kit.app/Contents/Info.plist",
     r"(<key>CFBundleShortVersionString</key><string>)\d+\.\d+\.\d+(</string>)"),
    ("legacy-cep/CSXS/manifest.xml", r'(ExtensionBundleVersion=")\d+\.\d+\.\d+(")'),
    ("legacy-cep/CSXS/manifest.xml", r'(<Extension Id="com\.xg0ta\.gotacreatorkit\.legacy\.panel" Version=")\d+\.\d+\.\d+(")'),
    ("tools/Assert-ReleaseVersions.ps1", r"(ExpectedVersion = ')\d+\.\d+\.\d+(')"),
]


def set_versions(version: str) -> None:
    for relative, pattern in VERSION_MARKERS:
        path = ROOT / relative
        text = path.read_text(encoding="utf-8")
        if not re.search(pattern, text):
            raise SystemExit(f"No se encontró el marcador de versión en {relative}")
        path.write_text(re.sub(pattern, rf"\g<1>{version}\g<2>", text), encoding="utf-8")


def clean_files(folder: Path):
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        parts = path.relative_to(folder).parts
        if EXCLUDED_NAMES.intersection(parts) or path.suffix.lower() in EXCLUDED_EXTENSIONS | {".mogrt"}:
            continue
        yield path


def sync_payload() -> None:
    payload = ROOT / "installer-mac" / "payload"
    for name in ("service", "service_v2"):
        for path in clean_files(ROOT / name):
            destination = payload / name / path.relative_to(ROOT / name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
    shutil.copy2(ROOT / "installer-mac" / "Supervisor.sh", payload / "Supervisor.sh")


def add(archive: zipfile.ZipFile, source: Path, entry: str, executable: bool = False) -> None:
    info = zipfile.ZipInfo.from_file(source, entry)
    info.compress_type = zipfile.ZIP_DEFLATED
    # Sin el bit de ejecución Finder dice «no tienes los privilegios
    # necesarios» al abrir el .command o el ejecutable de la .app.
    mode = 0o755 if executable or source.stat().st_mode & stat.S_IXUSR else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.create_system = 3  # UNIX
    archive.writestr(info, source.read_bytes())


def build(version: str) -> Path:
    payload = ROOT / "installer-mac" / "payload"
    ccx = payload / "Gota Creator Kit.ccx"
    with zipfile.ZipFile(ccx, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in clean_files(ROOT / "plugin"):
            archive.write(path, path.relative_to(ROOT / "plugin").as_posix())

    app = ROOT / "installer-mac" / "Instalar Gota Creator Kit.app"
    command = ROOT / "installer-mac" / "Instalar Gota Creator Kit.command"
    output = ROOT / "outputs" / f"GotaCreatorKit-{version}-macOS.zip"
    output.parent.mkdir(exist_ok=True)
    building = output.with_suffix(".building")
    with zipfile.ZipFile(building, "w") as archive:
        add(archive, ROOT / "installer-mac" / "INSTRUCCIONES PARA MAC.txt", "INSTRUCCIONES PARA MAC.txt")
        add(archive, command, command.name, executable=True)
        for path in clean_files(app):
            relative = path.relative_to(app).as_posix()
            add(archive, path, f"{app.name}/{relative}", executable="/MacOS/" in f"/{relative}")
        for path in clean_files(payload):
            add(archive, path, f"payload/{path.relative_to(payload).as_posix()}")
        # La app lleva su propia copia del instalador y del payload para
        # funcionar aunque Finder la abra desde otra carpeta.
        add(archive, command, f"{app.name}/Contents/Resources/{command.name}", executable=True)
        for path in clean_files(payload):
            add(archive, path, f"{app.name}/Contents/Resources/payload/{path.relative_to(payload).as_posix()}")
    building.replace(output)

    with zipfile.ZipFile(output) as archive:
        engine = archive.read("payload/service/app/main.py").decode("utf-8")
    found = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', engine)
    if not found or found.group(1) != version:
        raise SystemExit(f"El paquete trae el motor {found and found.group(1)}, no {version}.")
    return output


def main() -> None:
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        raise SystemExit("Uso: python3 tools/build-mac-package.py 3.3.12")
    version = sys.argv[1]
    set_versions(version)
    sync_payload()
    print(f"Paquete macOS listo: {build(version)}")


if __name__ == "__main__":
    main()
