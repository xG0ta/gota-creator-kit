# -*- mode: python ; coding: utf-8 -*-
# Empaqueta Gota Subtítulos con PyInstaller:  pyinstaller --noconfirm gota_subtitulos.spec
# Windows: dist/GotaSubtitulos/GotaSubtitulos.exe · Mac: dist/Gota Subtitulos.app
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = Path(SPECPATH).resolve()
REPO = ROOT.parent
VERSION = re.search(r'VERSION = "([^"]+)"', (ROOT / "gota_subtitulos" / "__init__.py").read_text()).group(1)

datas = [(str(ROOT / "gota_subtitulos" / "web"), "gota_subtitulos/web")]
datas += collect_data_files("faster_whisper")
datas += collect_data_files("imageio_ffmpeg", subdir="binaries")
binaries = collect_dynamic_libs("ctranslate2") + collect_dynamic_libs("onnxruntime")
hiddenimports = ["service.captions", "service.caption_motion"] + collect_submodules("uvicorn")

a = Analysis(
    [str(ROOT / "run.py")],
    pathex=[str(REPO), str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "torch", "pandas", "IPython", "cv2", "sympy", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="GotaSubtitulos",
    console=False, disable_windowed_traceback=False, argv_emulation=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="GotaSubtitulos")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Gota Subtitulos.app",
        bundle_identifier="com.gota.subtitulos",
        version=VERSION,
        info_plist={
            "CFBundleName": "Gota Subtítulos",
            "CFBundleDisplayName": "Gota Subtítulos",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            # Sin ícono en el Dock: la pantalla vive en el navegador y la app
            # se cierra con su botón «Cerrar app» o sola tras 20 min sin uso.
            "LSUIElement": True,
            "NSHighResolutionCapable": True,
            "NSAppleEventsUsageDescription": "Gota Subtítulos abre la ventana para elegir un video.",
        },
    )
