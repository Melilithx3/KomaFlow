"""`komaflow-sidecar doctor`: error diagnostics on the cleaner's PC (not a benchmark).

Checks paths and environments, probes the GPU, then for every installed model starts a warm worker,
loads the model, runs it twice on a synthetic page (cold, then warm), parks and reuses it. Every step
has a timeout; failures include the tail of the worker log. The report is printed and saved to
%LOCALAPPDATA%/komaflow/sidecar/logs/doctor-<time>.txt so it can be sent as is.
"""
from __future__ import annotations

import platform
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

from . import __version__, paths
from . import backend as be
from .catalog import ENVS


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failed = 0

    def say(self, text: str = "") -> None:
        print(text, flush=True)
        self.lines.append(text)

    def ok(self, what: str, detail: str = "") -> None:
        self.say(f"  [OK]   {what}{(' - ' + detail) if detail else ''}")

    def fail(self, what: str, detail: str) -> None:
        self.failed += 1
        self.say(f"  [FAIL] {what}")
        for ln in detail.strip().splitlines()[-25:]:
            self.say(f"         {ln}")


def _synthetic_page(dir_: Path) -> tuple[Path, Path, dict]:
    """A 1000x1400 'page' with a bubble and dark text stripes, plus a LaMa mask over the stripes."""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", (1000, 1400), (238, 236, 230))
    d = ImageDraw.Draw(im)
    d.ellipse((520, 80, 900, 420), fill=(255, 255, 255), outline=(0, 0, 0), width=6)
    for i in range(4):
        d.rectangle((600, 170 + i * 45, 820, 190 + i * 45), fill=(20, 20, 20))
    d.text((620, 120), "HELLO", fill=(0, 0, 0))
    page = dir_ / "doctor-page.png"
    im.save(page)
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rectangle((595, 165, 825, 335), fill=255)
    mpath = dir_ / "doctor-mask.png"
    mask.save(mpath)
    return page, mpath, {"x": 590, "y": 160, "w": 240, "h": 180}


def _timed(fn, timeout_s: float):
    """Runs fn in a thread; returns (result, seconds) or raises TimeoutError."""
    box: dict = {}

    def target() -> None:
        try:
            box["r"] = fn()
        except BaseException as e:  # noqa: BLE001
            box["e"] = e

    t0 = time.perf_counter()
    th = threading.Thread(target=target, daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        raise TimeoutError(f"no answer in {timeout_s:.0f} s")
    if "e" in box:
        raise box["e"]
    return box["r"], time.perf_counter() - t0


def run(backend_req: str = "auto", load_timeout: float = 900.0) -> int:
    from .pipeline import Control
    from .pool import WorkerError, pool

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # Japanese OCR text on a cp1251/cp866 console
        except (AttributeError, ValueError):
            pass
    r = Report()
    r.say(f"komaflow-sidecar doctor {__version__} - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    r.say(f"python {sys.version.split()[0]} ({sys.executable}), {platform.platform()}")
    r.say()
    r.say("1. Paths and environments")
    r.say(f"  home:   {paths.home()}")
    r.say(f"  models: {paths.models_dir()}")
    for b, spec in ENVS.items():
        py = paths.env_python(spec.name)
        (r.ok if py.exists() else r.say)(f"env {spec.name}: {py}" if py.exists() else f"  [--]   env {spec.name} not installed ({py})")
    src = Path(__file__).resolve().parent
    r.ok("sidecar sources", str(src))

    r.say()
    r.say("2. GPU and models (torch import in the engine env)")
    try:
        caps, secs = _timed(lambda: be.capabilities(refresh=True), 300)
        r.ok("probe", f"{secs:.1f} s")
        for bk in caps["backends"]:
            r.say(f"         backend {bk['id']}: {'available' if bk['available'] else 'NOT available'}"
                  f"{(' - ' + str(bk.get('device'))) if bk.get('device') else ''}{(' (' + str(bk.get('arch')) + ')') if bk.get('arch') else ''}"
                  f"{(' - ' + str(bk.get('error'))) if bk.get('error') else ''}")
        for k, m in caps["models"].items():
            r.say(f"         model {k}: {'installed' if m['installed'] else 'not installed'} ({m.get('revision')})")
    except Exception as e:  # noqa: BLE001
        r.fail("probe", f"{e}\n{traceback.format_exc()}")
        return _finish(r)

    rocm = next(b for b in caps["backends"] if b["id"] == "rocm")
    cpu_ok = next(b for b in caps["backends"] if b["id"] == "cpu")["available"]
    try:
        backend = be.choose(backend_req, rocm, cpu_ok)
        r.ok("backend chosen", backend)
    except RuntimeError as e:
        r.fail("backend", str(e))
        return _finish(r)

    r.say()
    r.say("3. Models in warm workers (cold load, run, warm run)")
    import os

    os.environ["KOMAFLOW_SIDECAR_LOAD_TIMEOUT"] = str(load_timeout)
    tmp = Path(tempfile.mkdtemp(prefix="komaflow-doctor-"))
    page, mask, box = _synthetic_page(tmp)
    from PIL import Image

    crop = tmp / "doctor-crop.png"
    Image.open(page).crop((box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"])).save(crop)
    plan = []
    if caps["models"]["layout"]["installed"]:
        plan.append(("layout", {"threshold": None, "class_thresholds": {}, "items": [{"id": "p", "image_path": str(page)}]}))
    if caps["models"]["ocr"]["installed"]:
        if backend == "rocm":
            plan.append(("ocr", {"items": [{"id": "c", "image_path": str(crop)}]}))
        else:
            r.say("  [--]   ocr skipped: OCR runs only on ROCm")
    if caps["models"]["lama"]["installed"]:
        plan.append(("inpaint", {"items": [{"id": "p", "image_path": str(page), "mask_path": str(mask), "out_path": str(tmp / "doctor-out.png")}]}))
    model_key = {"layout": "layout", "ocr": "ocr", "inpaint": "lama"}
    for stage, job in plan:
        job = {"backend": backend, "model_dir": str(paths.model_dir(model_key[stage])), **job}
        for attempt in ("cold", "warm"):
            try:
                out, secs = _timed(lambda: pool().run(stage, backend, job, Control()), load_timeout + 120)
                res = out["results"][0]
                detail = f"{secs:.1f} s"
                if stage == "layout":
                    detail += f", {len(res.get('detections', []))} detections"
                if stage == "ocr":
                    detail += f", text: {res.get('text', '')[:40]!r}"
                if stage == "inpaint":
                    detail += f", masked px: {res.get('masked_px')}"
                if out.get("peak_vram_mb"):
                    detail += f", peak VRAM {out['peak_vram_mb']:.0f} MB"
                r.ok(f"{stage} ({attempt})", detail)
            except (WorkerError, TimeoutError, Exception) as e:  # noqa: BLE001
                r.fail(f"{stage} ({attempt})", str(e))
                break
    r.say()
    r.say("4. Workers after the run (others parked in RAM when on ROCm)")
    for w in pool().stats():
        r.say(f"         {w['stage']}: {w['state']}, pid {w['pid']}, loads {w['loads']}")
    pool().shutdown()
    r.say()
    r.say("5. Log files")
    for f in sorted(paths.logs_dir().glob("*.log")):
        r.say(f"         {f}")
    return _finish(r)


def _finish(r: Report) -> int:
    r.say()
    r.say("RESULT: " + ("all checks passed" if r.failed == 0 else f"{r.failed} check(s) FAILED - send this file"))
    logs = paths.logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    out = logs / f"doctor-{time.strftime('%Y%m%d-%H%M%S')}.txt"
    out.write_text("\n".join(r.lines) + "\n", encoding="utf-8")
    print(f"\nreport saved: {out}")
    return 0 if r.failed == 0 else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run(*(sys.argv[1:2] or ["auto"])))
