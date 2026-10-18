"""Double-click this file (or run:  py START_SIGHTLINE.py) to set up and start Sightline.

First run : installs the libraries the app needs (needs internet, 2-5 minutes), optionally downloads the face
            models, then starts the app.
Later runs: starts the app straight away and opens http://127.0.0.1:8000 in your browser.

Where libraries go:
  1. a private environment in the .venv folder (preferred), or
  2. if Windows/antivirus/Microsoft-Store Python stops that from working, a plain .packages folder next to this
     file, used with your normal Python. This is chosen automatically. Force it with:  py START_SIGHTLINE.py --no-venv

Close this window, or press Ctrl+C in it, to stop the app.
Uses only the Python standard library, so it works on a fresh Python install.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
PKGS = ROOT / ".packages"
WIN = os.name == "nt"
OWN_ARGS = {"--no-venv"}


def say(msg=""):
    print(msg, flush=True)


def pause_and_exit(code=1):
    try:
        input("\nPress Enter to close this window...")
    except EOFError:
        pass
    sys.exit(code)


def run(cmd, env=None):
    cmd = [str(c) for c in cmd]
    say("  > " + " ".join(cmd))
    try:
        return subprocess.call(cmd, cwd=ROOT, env=env)
    except OSError as e:
        say(f"    could not start this program: {e}")
        return 127


def works(python):
    """True if this interpreter path exists and actually runs."""
    if not python or not Path(python).exists():
        return False
    try:
        return subprocess.call([str(python), "-c", "import sys"], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60) == 0
    except (OSError, subprocess.SubprocessError):
        return False


def venv_python():
    names = ["Scripts/python.exe", "Scripts/python3.exe", "Scripts/python"] if WIN else ["bin/python", "bin/python3"]
    for n in names:
        p = VENV / n
        if works(p):
            return p
    return None


def req_hash():
    return hashlib.sha256((ROOT / "requirements.txt").read_bytes()).hexdigest()


# ---------------------------------------------------------------------------------------------------- setup modes
def setup_venv():
    """Returns (python, env) using .venv, or None if a working venv cannot be made on this PC."""
    py = venv_python()
    if py is None:
        if VENV.exists():
            say("\nThe existing .venv folder is broken (its python.exe is missing or blocked). Re-creating it ...")
            shutil.rmtree(VENV, ignore_errors=True)
        else:
            say("\n[1/3] Creating a private Python environment in .venv (one time only) ...")
        try:
            venv.create(VENV, with_pip=True)
        except Exception as e:
            say(f"    venv could not be created: {e}")
        py = venv_python()
        if py is None:
            say("    The environment's python.exe is missing or cannot run.")
            say("    This usually means antivirus removed it, or Python came from the Microsoft Store.")
            say("    Switching to the simple mode (libraries go into a .packages folder) ...")
            shutil.rmtree(VENV, ignore_errors=True)
            return None
    stamp = VENV / ".requirements.sha256"
    env = dict(os.environ)
    if not (stamp.exists() and stamp.read_text().strip() == req_hash()):
        say("\n[2/3] Installing libraries (one time only, needs internet, 2-5 minutes) ...")
        run([py, "-m", "pip", "install", "--upgrade", "pip", "--disable-pip-version-check", "-q"], env)
        if run([py, "-m", "pip", "install", "-r", "requirements.txt", "--disable-pip-version-check"], env) != 0:
            install_failed()
        stamp.write_text(req_hash())
    return py, env


def setup_packages_folder():
    """Fallback: install into ROOT/.packages with the Python running this script; no copied python.exe needed."""
    py = Path(sys.executable)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(PKGS) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONNOUSERSITE"] = "1"
    stamp = PKGS / ".requirements.sha256"
    if stamp.exists() and stamp.read_text().strip() == req_hash():
        return py, env
    say("\n[2/3] Installing libraries into the .packages folder (one time only, needs internet, 2-5 minutes) ...")
    if run([py, "-m", "pip", "--version"], env) != 0:
        say("    pip is missing, trying to add it ...")
        run([py, "-m", "ensurepip", "--upgrade"], env)
    PKGS.mkdir(exist_ok=True)
    if run([py, "-m", "pip", "install", "--upgrade", "--target", PKGS, "-r", "requirements.txt",
            "--disable-pip-version-check", "--no-warn-script-location"], env) != 0:
        install_failed()
    stamp.write_text(req_hash())
    return py, env


CHECK = ("import typing_extensions, pydantic, fastapi, starlette, uvicorn, multipart, itsdangerous, "
         "numpy, cv2, cryptography.fernet, reportlab")


def libraries_ok(py, env):
    """Every start: make sure all libraries still import (antivirus or an interrupted install can remove files)."""
    try:
        r = subprocess.run([str(py), "-c", CHECK], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as e:
        say(f"    library check could not run: {e}")
        return False
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or ["unknown error"])[-1]
        say(f"    library check failed: {last}")
    return r.returncode == 0


def repair(py, env, target=None):
    say("\nSome libraries are missing or damaged (often antivirus or an interrupted install). Repairing ...")
    cmd = [py, "-m", "pip", "install", "--force-reinstall", "--no-cache-dir", "-r", "requirements.txt",
           "--disable-pip-version-check", "--no-warn-script-location"]
    if target:
        cmd[4:4] = ["--upgrade", "--target", target]
    if run(cmd, env) != 0 or not libraries_ok(py, env):
        install_failed()
    say("    Repaired.")


def install_failed():
    say("\nInstalling the libraries failed. Common fixes:")
    say("  * Check the internet connection (college Wi-Fi sometimes blocks pip: try a phone hotspot).")
    say("  * Use 64-bit Python 3.10 - 3.13 from python.org (not the Microsoft Store), with 'Add python.exe to PATH' ticked.")
    say("  * Move the sightline folder out of Downloads/OneDrive to a short path such as C:\\sightline")
    say("  * If your antivirus keeps removing files, add the sightline folder to its exclusions/allowed list.")
    say("  * Then double-click START_SIGHTLINE.py again.")
    pause_and_exit()


def first_run_extras(py, env, marker_dir):
    if not (ROOT / ".env").exists() and (ROOT / ".env.example").exists():
        shutil.copy(ROOT / ".env.example", ROOT / ".env")
    asked = marker_dir / ".models_asked"
    if (ROOT / "models" / "face_detection_yunet_2023mar.onnx").exists() or asked.exists():
        return
    asked.write_text("1")
    say("\n[3/3] Optional: download the face models (about 60 MB).")
    say("      They give better face detection, the optional reference matching, and offline use of the Observation lab.")
    try:
        ans = input("      Download now? [Y/n] ").strip().lower()
    except EOFError:
        ans = "n"
    if ans in ("", "y", "yes"):
        run([py, ROOT / "scripts" / "fetch_models.py"], env)
        say("      (You can run scripts\\fetch_models.py again later if anything failed.)")


def main():
    say("=" * 66)
    say(" Sightline - academic prototype (not for real investigations)")
    say("=" * 66)
    say(f"Python: {sys.version.split()[0]}  ({sys.executable})")
    if sys.version_info < (3, 10):
        say("Sightline needs Python 3.10 or newer. Install a newer Python from python.org, then try again.")
        pause_and_exit()
    if "WindowsApps" in sys.executable:
        say("Note: this looks like the Microsoft Store Python. If anything fails, install Python from python.org instead.")
    os.chdir(ROOT)

    setup = None
    if "--no-venv" not in sys.argv and not PKGS.exists():
        setup = setup_venv()
    if setup is None:
        setup = setup_packages_folder()
        marker = PKGS
    else:
        marker = VENV
    py, env = setup
    if not libraries_ok(py, env):
        repair(py, env, target=PKGS if marker == PKGS else None)
    first_run_extras(py, env, marker)

    say("\nStarting Sightline - your browser should open by itself (normally at http://127.0.0.1:8000)")
    say("Sign in as  investigator  /  Demo@1234     -  keep this window open; close it to stop the app.\n")
    code = run([py, ROOT / "run.py"] + [a for a in sys.argv[1:] if a not in OWN_ARGS], env)
    if code not in (0, None):
        say("\nThe app stopped with an error (see the messages above). Common causes:")
        say("  * Another copy is already running: open http://127.0.0.1:8000 in the browser.")
        say("  * A library is broken: delete the .venv and .packages folders and double-click START_SIGHTLINE.py again.")
        pause_and_exit(code)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as e:  # never let the window vanish without a message
        say(f"\nUnexpected problem: {e!r}")
        say("Please send a screenshot of this window.")
        pause_and_exit()
