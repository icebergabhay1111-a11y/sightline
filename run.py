"""Launcher:  python run.py   ->  opens http://127.0.0.1:8000   (add --no-browser to skip opening it)"""
import json
import os
import socket
import sys
import threading
import urllib.request
import webbrowser

if sys.version_info < (3, 10):
    sys.exit("Sightline needs Python 3.10 or newer. You have " + sys.version.split()[0])

try:
    import uvicorn
except ImportError:
    sys.exit("Libraries missing. Double-click START_SIGHTLINE.py, or run:  pip install -r requirements.txt")


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def is_sightline(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
            return json.load(r).get("ok") is True
    except Exception:
        return False


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    open_browser = "--no-browser" not in sys.argv
    if not port_free(port):
        if is_sightline(port):
            print(f"Sightline is already running at http://127.0.0.1:{port} - opening it.")
            if open_browser:
                webbrowser.open(f"http://127.0.0.1:{port}")
            sys.exit(0)
        old = port
        while not port_free(port) and port < old + 20:
            port += 1
        print(f"Port {old} is used by another program, so Sightline will use port {port}.")
    url = f"http://127.0.0.1:{port}"
    if open_browser:
        threading.Timer(2.0, lambda: webbrowser.open(url)).start()
    print(f"Sightline running at {url}  (close this window or press Ctrl+C to stop)")
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")
