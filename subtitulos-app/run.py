"""Punto de entrada para PyInstaller y para correr la app desde el código.

El motor de subtítulos (service/captions.py) se comparte con el plugin de
Premiere, así que la raíz del repositorio va en la ruta de importación.
"""
import multiprocessing
import sys
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from gota_subtitulos.launcher import main  # noqa: E402

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main(sys.argv[1:]))
