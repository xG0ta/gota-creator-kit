"""Carpetas de la app, diálogos nativos y fuentes instaladas (Mac y Windows)."""
from __future__ import annotations

import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".3gp")


def data_dir() -> Path:
    if sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "GotaSubtitulos"
    elif os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "GotaSubtitulos"
    else:
        root = Path.home() / ".gota-subtitulos"
    root.mkdir(parents=True, exist_ok=True)
    return root


def export_dir() -> Path:
    """Los videos terminados van a su propia carpeta.

    Nunca junto al original: esa carpeta puede ser la que vigila Gota Flow
    para programar TikTok y un video nuevo ahí se publicaría solo.
    """
    if sys.platform == "darwin":
        root = Path.home() / "Movies" / "Gota Subtítulos"
    else:
        root = Path.home() / "Videos" / "Gota Subtítulos"
    root.mkdir(parents=True, exist_ok=True)
    return root


def unique_path(folder: Path, stem: str, extension: str) -> Path:
    safe = "".join(char for char in stem if char not in '<>:"/\\|?*').strip() or "video"
    candidate = folder / f"{safe}{extension}"
    counter = 2
    while candidate.exists():
        candidate = folder / f"{safe} ({counter}){extension}"
        counter += 1
    return candidate


def choose_video() -> str | None:
    """Abre el selector de archivos del sistema; None si se canceló."""
    if sys.platform == "darwin":
        script = (
            'activate\n'
            'set chosen to choose file with prompt "Elige el video que quieres subtitular" '
            'of type {"public.movie", "public.audiovisual-content"}\n'
            'POSIX path of chosen'
        )
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=False)
        path = result.stdout.strip()
        return path or None
    if os.name == "nt":
        patterns = ";".join(f"*{extension}" for extension in VIDEO_EXTENSIONS)
        script = (
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
            "$dialog = New-Object System.Windows.Forms.OpenFileDialog; "
            "$dialog.Title = 'Elige el video que quieres subtitular'; "
            f"$dialog.Filter = 'Videos|{patterns}|Todos los archivos|*.*'; "
            "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.FileName }"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", creationflags=NO_WINDOW, check=False,
        )
        path = result.stdout.strip()
        return path or None
    return None


def reveal(path: str) -> None:
    target = Path(path)
    if sys.platform == "darwin":
        subprocess.run(["open", "-R", str(target)], check=False)
    elif os.name == "nt":
        subprocess.run(["explorer", f"/select,{target}"], creationflags=NO_WINDOW, check=False)


def _font_dirs() -> list[Path]:
    if sys.platform == "darwin":
        return [Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"),
                Path("/Library/Fonts"), Path.home() / "Library" / "Fonts"]
    if os.name == "nt":
        return [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
                Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"]
    return [Path("/usr/share/fonts"), Path.home() / ".fonts"]


@lru_cache(maxsize=1)
def list_fonts() -> list[dict]:
    """Fuentes instaladas con su nombre legible («Arial Bold»)."""
    from PIL import ImageFont

    fonts: dict[str, str] = {}
    for folder in _font_dirs():
        if not folder.is_dir():
            continue
        for path in folder.rglob("*"):
            if path.suffix.lower() not in (".ttf", ".otf"):
                continue
            try:
                family, style = ImageFont.truetype(str(path), 20).getname()
            except Exception:
                continue
            if not family or "emoji" in family.lower():
                continue
            label = f"{family} {style}".strip() if style and style.lower() != "regular" else family
            fonts.setdefault(label, str(path))
    return [{"label": label, "path": fonts[label]} for label in sorted(fonts, key=str.casefold)]


def default_font() -> str | None:
    preferred = ("Arial Black", "Arial Bold", "Helvetica Bold", "Montserrat Black", "Arial")
    available = {font["label"]: font["path"] for font in list_fonts()}
    for label in preferred:
        if label in available:
            return available[label]
    return next(iter(available.values()), None)
