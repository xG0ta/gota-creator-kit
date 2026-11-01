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


def default_export_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Movies" / "Gota Subtítulos"
    return Path.home() / "Videos" / "Gota Subtítulos"


def _settings_path() -> Path:
    return data_dir() / "ajustes.json"


def _read_settings() -> dict:
    import json

    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_settings(settings: dict) -> None:
    import json

    temporary = _settings_path().with_suffix(".tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(_settings_path())


def export_dir() -> Path:
    """Carpeta donde se guardan los videos: la que eligió el usuario o la de siempre.

    Nunca se guarda junto al original (ver `same_folder`): esa carpeta puede
    ser la que vigila Gota Flow para programar TikTok y un video nuevo ahí se
    publicaría solo.
    """
    chosen = str(_read_settings().get("exportFolder") or "")
    root = Path(chosen) if chosen and Path(chosen).is_dir() else default_export_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def set_export_dir(folder: str | None) -> Path:
    settings = _read_settings()
    if folder:
        settings["exportFolder"] = str(Path(folder).expanduser().resolve())
    else:
        settings.pop("exportFolder", None)
    _write_settings(settings)
    return export_dir()


def same_folder(first: str | Path, second: str | Path) -> bool:
    try:
        return Path(first).resolve() == Path(second).resolve()
    except OSError:
        return False


def choose_folder() -> str | None:
    """Selector de carpetas del sistema; None si se canceló."""
    prompt = "Elige dónde guardar los videos subtitulados"
    if sys.platform == "darwin":
        script = f'activate\nPOSIX path of (choose folder with prompt "{prompt}")'
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=False)
        return result.stdout.strip() or None
    if os.name == "nt":
        script = (
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
            f"$dialog.Description = '{prompt}'; "
            "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath }"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", creationflags=NO_WINDOW, check=False,
        )
        return result.stdout.strip() or None
    return None


def unique_path(folder: Path, stem: str, extension: str) -> Path:
    safe = "".join(char for char in stem if char not in '<>:"/\\|?*').strip() or "video"
    candidate = folder / f"{safe}{extension}"
    counter = 2
    while candidate.exists():
        candidate = folder / f"{safe} ({counter}){extension}"
        counter += 1
    return candidate


def choose_videos(multiple: bool = False) -> list[str]:
    """Abre el selector de archivos del sistema; lista vacía si se canceló."""
    prompt = "Elige los videos que quieres subtitular" if multiple else "Elige el video que quieres subtitular"
    if sys.platform == "darwin":
        many = " with multiple selections allowed" if multiple else ""
        script = (
            'activate\n'
            f'set chosen to choose file with prompt "{prompt}" '
            f'of type {{"public.movie", "public.audiovisual-content"}}{many}\n'
            'if class of chosen is list then\n'
            '  set paths to {}\n'
            '  repeat with item_ in chosen\n'
            '    set end of paths to POSIX path of item_\n'
            '  end repeat\n'
            '  set AppleScript\'s text item delimiters to linefeed\n'
            '  return paths as text\n'
            'end if\n'
            'POSIX path of chosen'
        )
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=False)
        return [line for line in result.stdout.strip().splitlines() if line.strip()]
    if os.name == "nt":
        patterns = ";".join(f"*{extension}" for extension in VIDEO_EXTENSIONS)
        script = (
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
            "$dialog = New-Object System.Windows.Forms.OpenFileDialog; "
            f"$dialog.Title = '{prompt}'; "
            f"$dialog.Multiselect = ${'true' if multiple else 'false'}; "
            f"$dialog.Filter = 'Videos|{patterns}|Todos los archivos|*.*'; "
            "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.FileNames -join [Environment]::NewLine }"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", creationflags=NO_WINDOW, check=False,
        )
        return [line for line in result.stdout.strip().splitlines() if line.strip()]
    return []


def choose_video() -> str | None:
    chosen = choose_videos(False)
    return chosen[0] if chosen else None


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
