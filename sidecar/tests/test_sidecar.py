import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from PIL import Image

from komaflow_sidecar import backend as be
from komaflow_sidecar.catalog import ENVS
from komaflow_sidecar.geometry import clean_ocr_text, crop_rect, map_class, xyxy_to_box
from komaflow_sidecar.install import env_commands, read_lock
from komaflow_sidecar.jobs import JobQueue
from komaflow_sidecar.pipeline import Cancelled, Control, analyze_batch
from komaflow_sidecar.server import make_handler, validate_job


@pytest.fixture(autouse=True)
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KOMAFLOW_SIDECAR_FAKE", "1")
    monkeypatch.setenv("KOMAFLOW_SIDECAR_FAKE_ROCM", "1")
    monkeypatch.setenv("KOMAFLOW_SIDECAR_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("KOMAFLOW_SIDECAR_FAKE_DELAY", raising=False)


@pytest.fixture
def pages(tmp_path):
    out = []
    for i in range(2):
        p = tmp_path / f"{i + 1:03}.png"
        Image.new("RGB", (800, 1200), (240, 240, 240)).save(p)
        out.append({"page_id": f"p{i}", "image_path": str(p)})
    return out


# ------------------------------------------------------------------ pure helpers
def test_class_map_drops_panel_and_unknown():
    assert map_class("bubble") == "bubble"
    assert map_class("onomatopoeia") == "onomatopoeia"
    assert map_class("panel") is None
    assert map_class("frame") is None
    assert map_class("text", {"text": "sfx"}) == "sfx"
    assert map_class("text", {"text": "nonsense"}) is None


def test_boxes_are_integer_and_inside_page():
    assert xyxy_to_box([10.4, 20.6, 110.5, 220.4], 800, 1200) == {"x": 10, "y": 21, "w": 100, "h": 199}
    assert xyxy_to_box([-5, -5, 900, 1300], 800, 1200) == {"x": 0, "y": 0, "w": 800, "h": 1200}
    assert xyxy_to_box([5, 5, 5.2, 50], 800, 1200) is None
    assert crop_rect({"x": 2, "y": 10, "w": 50, "h": 50}, 8, 56, 1200) == (0, 2, 56, 68)


def test_clean_ocr_text():
    assert clean_ocr_text("\n  こんにちは \n世界<|LOC_12|>\n\n") == "こんにちは\n世界"


def test_backend_choice():
    gpu = {"available": True, "arch": "gfx1031:sramecc-:xnack-"}
    assert be.choose("auto", gpu, True) == "rocm"
    assert be.choose("auto", {"available": True, "arch": "gfx1100"}, True) == "cpu"
    assert be.choose("auto", {"available": False}, True) == "cpu"
    assert be.choose("cpu", gpu, True) == "cpu"
    with pytest.raises(RuntimeError):
        be.choose("rocm", {"available": False}, True)
    with pytest.raises(RuntimeError):
        be.choose("auto", {"available": False}, False)


def test_install_uses_locks_and_pinned_torch():
    py, pins = read_lock("torch-rocm")
    assert py and py.startswith("3.12")
    assert any(p.startswith("amd-torch-device-gfx1031==") for p in pins)
    cmds = env_commands(ENVS["rocm"], "uv", Path("c.txt"))
    assert cmds[0][:2] == ["uv", "venv"] and py in cmds[0]
    assert "--prerelease" in cmds[1] and "torch[device-gfx1031]==2.14.0+rocm10.1.0" in cmds[1]
    assert "--constraint" in cmds[2] and "rfdetr==1.7.0" in cmds[2]
    assert all("directml" not in " ".join(c).lower() and "onnx" not in " ".join(c).lower() for c in cmds)


# ------------------------------------------------------------------ pipeline (stages in child processes)
def test_analyze_batch_runs_layout_then_ocr_in_processes(pages):
    seen = []
    res = analyze_batch(pages, {"backend": "auto"}, Control(on_progress=lambda p: seen.append((p.stage, p.done, p.total))))
    assert res["backend"] == "rocm"
    assert [p["page_id"] for p in res["pages"]] == ["p0", "p1"]
    objs = res["pages"][0]["objects"]
    assert [o["type"] for o in objs] == ["bubble", "text"]  # panel dropped
    assert objs[0]["box"] == {"x": 480, "y": 60, "w": 240, "h": 300}
    assert objs[0]["source_text"].startswith("テキスト")  # OCR on the padded crop
    assert objs[0]["source_text"] == "テキスト 256x316"
    stages = [s for s, _, _ in seen]
    assert stages.index("ocr") > stages.index("layout")
    assert ("ocr", 4, 4) in seen


def test_cpu_backend_skips_ocr(pages, monkeypatch):
    monkeypatch.setenv("KOMAFLOW_SIDECAR_FAKE_ROCM", "0")
    res = analyze_batch(pages, {}, Control())
    assert res["backend"] == "cpu"
    assert all(o["source_text"] == "" for p in res["pages"] for o in p["objects"])
    assert res["warnings"]


def test_layout_only_and_threshold(pages):
    res = analyze_batch(pages, {"stages": ["layout"], "layout_threshold": 0.9}, Control())
    assert [o["type"] for o in res["pages"][0]["objects"]] == ["bubble"]
    assert res["stages"]["ocr"] is None


def test_cancel_kills_the_stage_process(pages, monkeypatch):
    monkeypatch.setenv("KOMAFLOW_SIDECAR_FAKE_DELAY", "5")
    ctl = Control()
    threading.Timer(1.0, ctl.cancel.set).start()
    t0 = time.perf_counter()
    with pytest.raises(Cancelled):
        analyze_batch(pages, {}, ctl)
    assert time.perf_counter() - t0 < 4


# ------------------------------------------------------------------ HTTP service
@pytest.fixture
def service():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler("secret", JobQueue()))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(base, method, path, body=None, token="secret"):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Komaflow-Token": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_service_contract(service, pages):
    assert call(service, "GET", "/health", token="nope")[0] == 401
    assert call(service, "GET", "/health") == (200, {"ok": True, "version": "0.1.0"})
    code, caps = call(service, "GET", "/capabilities")
    assert code == 200 and [b["id"] for b in caps["backends"]] == ["rocm", "cpu"]
    assert set(caps["models"]) == {"layout", "ocr", "lama"}
    assert call(service, "POST", "/jobs", {"kind": "analyze_batch", "pages": []})[0] == 422
    code, r = call(service, "POST", "/jobs", {"kind": "analyze_batch", "pages": pages, "options": {"backend": "auto"}})
    assert code == 202
    for _ in range(100):
        code, j = call(service, "GET", f"/jobs/{r['job_id']}")
        if j["state"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert j["state"] == "done", j
    assert j["result"]["pages"][1]["objects"][0]["type"] == "bubble"
    code, r2 = call(service, "POST", "/jobs", {"kind": "ocr_boxes", "image_path": pages[0]["image_path"],
                                              "boxes": [{"id": "o1", "box": {"x": 10, "y": 10, "w": 100, "h": 50}}]})
    for _ in range(100):
        j2 = call(service, "GET", f"/jobs/{r2['job_id']}")[1]
        if j2["state"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert j2["result"]["results"] == [{"id": "o1", "source_text": "テキスト 116x66"}]


def test_service_cancel(service, pages, monkeypatch):
    monkeypatch.setenv("KOMAFLOW_SIDECAR_FAKE_DELAY", "5")
    _, r = call(service, "POST", "/jobs", {"kind": "analyze_batch", "pages": pages})
    time.sleep(0.8)
    assert call(service, "DELETE", f"/jobs/{r['job_id']}")[0] == 200
    for _ in range(50):
        j = call(service, "GET", f"/jobs/{r['job_id']}")[1]
        if j["state"] == "cancelled":
            break
        time.sleep(0.1)
    assert j["state"] == "cancelled"


def test_validate_job():
    assert validate_job({"kind": "x"})
    assert validate_job({"kind": "ocr_boxes", "image_path": "a", "boxes": [{"id": "1", "box": {"x": 1, "y": 1, "w": 1.5, "h": 1}}]})
    assert validate_job({"kind": "analyze_batch", "pages": [{"page_id": "a", "image_path": "b"}], "options": {"backend": "dml"}})
    assert validate_job({"kind": "analyze_batch", "pages": [{"page_id": "a", "image_path": "b"}]}) is None


def test_cli_analyze_with_overlay(pages, tmp_path):
    from komaflow_sidecar.cli import main

    out = tmp_path / "out"
    assert main(["analyze", "--pages", str(Path(pages[0]["image_path"]).parent), "--out", str(out), "--overlay"]) == 0
    data = json.loads((out / "analysis.json").read_text(encoding="utf-8"))
    assert len(data["pages"]) == 2
    assert (out / "001.overlay.png").exists()


# ------------------------------------------------------------------ layout params, separate OCR, rotation
def test_per_class_thresholds_and_map(pages):
    res = analyze_batch(pages, {"stages": ["layout"], "class_thresholds": {"bubble": 0.95, "text": 0.5},
                                "class_map": {"bubble": "bubble", "text": "onomatopoeia", "panel": "text"}}, Control())
    assert [o["type"] for o in res["pages"][0]["objects"]] == ["onomatopoeia", "text"]  # bubble cut, panel enabled


def test_ocr_batch_over_existing_boxes(pages):
    from komaflow_sidecar.pipeline import ocr_batch

    r = ocr_batch([{**pages[0], "boxes": [{"id": "a", "box": {"x": 10, "y": 10, "w": 100, "h": 40}},
                                          {"id": "b", "box": {"x": 200, "y": 200, "w": 60, "h": 120}, "rotation": 90}]},
                   {**pages[1], "boxes": []}], {"ocr_padding_px": 0}, Control())
    assert r["pages"][0]["results"] == [{"id": "a", "source_text": "テキスト 100x40"}, {"id": "b", "source_text": "テキスト 60x120"}]
    assert r["pages"][1]["results"] == []


def test_rotated_crop_is_straightened():
    from komaflow_sidecar.geometry import crop_object

    im = Image.new("RGB", (200, 200), (255, 255, 255))
    # a vertical dark bar on the page = a horizontal line of text rotated by 90 degrees
    for y in range(50, 150):
        for x in range(95, 105):
            im.putpixel((x, y), (0, 0, 0))
    c = crop_object(im, {"x": 50, "y": 95, "w": 100, "h": 10}, 90, 0)
    assert c.size == (100, 10)
    dark = sum(1 for x in range(100) for y in range(10) if c.getpixel((x, y))[0] < 128)
    assert dark > 800


def test_validate_ocr_batch():
    assert validate_job({"kind": "ocr_batch", "pages": [{"page_id": "p", "image_path": "a", "boxes": [{"id": "1", "box": {"x": 1, "y": 1, "w": 2, "h": 2}, "rotation": 10}]}]}) is None
    assert validate_job({"kind": "ocr_batch", "pages": []})


# ------------------------------------------------------------------ inpaint (auto-clean)
def test_inpaint_batch_paints_only_the_mask(tmp_path):
    from komaflow_sidecar.pipeline import inpaint_batch
    from komaflow_sidecar.stages.inpaint import mask_crop

    img = tmp_path / "page.png"
    Image.new("RGB", (100, 80), (10, 10, 10)).save(img)
    mask = Image.new("L", (100, 80), 0)
    for x in range(20, 40):
        for y in range(10, 30):
            mask.putpixel((x, y), 255)
    mpath = tmp_path / "mask.png"
    mask.save(mpath)
    out = tmp_path / "out.png"
    r = inpaint_batch([{"id": "p1", "image_path": str(img), "mask_path": str(mpath), "out_path": str(out)}], {}, Control())
    assert r["results"] == [{"id": "p1", "out_path": str(out), "masked_px": 400}]
    res = Image.open(out)
    assert res.getpixel((25, 15)) == (255, 255, 255)
    assert res.getpixel((5, 5)) == (10, 10, 10)
    assert mask_crop((20, 10, 40, 30), 100, 80) == (0, 0, 100, 80)
    assert mask_crop(None, 10, 10) is None


def test_validate_inpaint():
    assert validate_job({"kind": "inpaint", "items": [{"id": "a", "image_path": "i", "mask_path": "m", "out_path": "o"}]}) is None
    assert validate_job({"kind": "inpaint", "items": [{"id": "a"}]})


def test_models_only_install_needs_an_environment(monkeypatch):
    from komaflow_sidecar import install as ins

    calls = []
    monkeypatch.setattr(ins, "install_env", lambda b, log: calls.append(("env", b)))
    monkeypatch.setattr(ins, "install_model", lambda k, b, log: calls.append(("model", k, b)))
    with pytest.raises(RuntimeError):
        ins.install([], ["lama"], log=lambda m: None, models_only=True)
    monkeypatch.setattr(ins, "installed_backend", lambda: "rocm")
    ins.install(["rocm"], ["lama"], log=lambda m: None, models_only=True)
    assert calls == [("model", "lama", "rocm")]
