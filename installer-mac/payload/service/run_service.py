from pathlib import Path
import os
import sys
import traceback

import uvicorn


PID_FILE = Path(__file__).with_name("autoframe.pid")
LOG_FILE = Path(__file__).with_name("autoframe-service.log")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIAGNOSTIC_LOG = Path(os.environ.get("GOTA_LOG_DIR", PROJECT_ROOT)) / "silence-diagnostics.log"


def write_launcher_diagnostic(event: str, **details) -> None:
    """Escribe un rastro incluso si FastAPI no alcanza a importar la app."""
    try:
        import json
        from time import time

        DIAGNOSTIC_LOG.parent.mkdir(parents=True, exist_ok=True)
        payload = {"at": round(time(), 3), "event": event, **details}
        with DIAGNOSTIC_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass


def main():
    os.chdir(PROJECT_ROOT)
    project_root_text = str(PROJECT_ROOT)
    if project_root_text not in sys.path:
        sys.path.insert(0, project_root_text)
    PID_FILE.write_text(str(os.getpid()), encoding="ascii")
    write_launcher_diagnostic("launcher_started", pid=os.getpid())
    try:
        with LOG_FILE.open("w", encoding="utf-8") as log:
            sys.stdout = log
            sys.stderr = log
            log.write("Iniciando Gota Creator Kit...\n")
            log.flush()
            try:
                uvicorn.run(
                    "service.app.main:app",
                    host="127.0.0.1",
                    port=8765,
                    log_level="warning",
                    log_config=None,
                    access_log=False,
                )
            except Exception:
                write_launcher_diagnostic("launcher_failed")
                traceback.print_exc(file=log)
                raise
    finally:
        try:
            PID_FILE.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
