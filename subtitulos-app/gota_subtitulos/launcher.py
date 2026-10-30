"""Arranque: un solo servidor local por usuario y la pantalla en el navegador."""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser

PORTS = range(8777, 8787)
IDLE_SECONDS = 20 * 60


def _redirect_output() -> None:
    """Las apps empaquetadas sin consola no tienen stdout: se manda al registro."""
    from .system import data_dir

    if sys.stdout is None or sys.stderr is None or getattr(sys, "frozen", False):
        log = open(data_dir() / "gota-subtitulos.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = log
        sys.stderr = log


def _running_instance() -> int | None:
    import json
    import urllib.request

    for port in PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.6) as response:
                if json.loads(response.read()).get("app") == "gota-subtitulos":
                    return port
        except Exception:
            continue
    return None


def _free_port() -> int:
    for port in PORTS:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No hay un puerto libre entre 8777 y 8786.")


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        from .selftest import run

        index = argv.index("--self-test")
        report = argv[index + 1] if len(argv) > index + 1 else None
        return run(report, with_model="--with-model" in argv)

    _redirect_output()
    existing = _running_instance()
    if existing:
        webbrowser.open(f"http://127.0.0.1:{existing}/")
        return 0

    import uvicorn

    from .server import app, job, state, write_log

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, access_log=False)
    server = uvicorn.Server(config)

    def watchdog() -> None:
        # Se cierra sola si el usuario cerró la pestaña hace rato y no hay
        # ningún trabajo en curso, o si pulsó «Cerrar».
        while not server.should_exit:
            time.sleep(2)
            idle = time.time() - state["lastPing"] > IDLE_SECONDS
            if state["quit"] or (idle and job["status"] != "running"):
                server.should_exit = True

    def open_browser() -> None:
        for _ in range(100):
            if server.started:
                webbrowser.open(f"http://127.0.0.1:{port}/")
                return
            time.sleep(0.1)

    write_log(f"Gota Subtítulos inicia en el puerto {port} (pid {os.getpid()})")
    threading.Thread(target=watchdog, daemon=True).start()
    if "--no-browser" not in argv:
        threading.Thread(target=open_browser, daemon=True).start()
    server.run()
    write_log("Gota Subtítulos se cerró")
    return 0
