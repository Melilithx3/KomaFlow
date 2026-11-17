"""Local HTTP service for the desktop (docs/05 §9). Listens on 127.0.0.1, random port, one-time token.

  GET  /health        -> {ok, version}
  GET  /capabilities  -> {backends, models}
  POST /jobs          -> {job_id}      body: {kind: analyze_batch|ocr_batch|ocr_boxes|inpaint, ...}
  GET  /jobs/{id}     -> {state, stage, progress, result?, error?}
  DELETE /jobs/{id}   -> cancel

Every request must carry `X-Komaflow-Token: <token>`. On start the service prints one JSON line
to stdout: {"event": "listening", "port": N} so the desktop can connect.
"""
from __future__ import annotations

import hmac
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__
from . import backend as be
from .jobs import JobQueue
from .pipeline import analyze_batch, inpaint_batch, ocr_batch, ocr_boxes

MAX_BODY = 4 * 1024 * 1024


def validate_job(body: Any) -> str | None:
    if not isinstance(body, dict):
        return "body must be an object"
    kind = body.get("kind")
    opts = body.get("options", {})
    if not isinstance(opts, dict):
        return "options must be an object"
    if opts.get("backend", "auto") not in ("auto", "rocm", "cpu"):
        return "options.backend must be auto|rocm|cpu"
    if kind == "analyze_batch":
        pages = body.get("pages")
        if not isinstance(pages, list) or not pages:
            return "pages must be a non-empty list"
        for p in pages:
            if not isinstance(p, dict) or not isinstance(p.get("page_id"), str) or not isinstance(p.get("image_path"), str):
                return "each page needs page_id and image_path"
        return None
    if kind == "inpaint":
        items = body.get("items")
        if not isinstance(items, list) or not items:
            return "items must be a non-empty list"
        for it in items:
            if not isinstance(it, dict) or not all(isinstance(it.get(k), str) for k in ("id", "image_path", "mask_path", "out_path")):
                return "each item needs id, image_path, mask_path, out_path"
        return None
    if kind == "ocr_batch":
        pages = body.get("pages")
        if not isinstance(pages, list) or not pages:
            return "pages must be a non-empty list"
        for p in pages:
            if not isinstance(p, dict) or not isinstance(p.get("page_id"), str) or not isinstance(p.get("image_path"), str):
                return "each page needs page_id and image_path"
            err = _check_boxes(p.get("boxes"))
            if err:
                return err
        return None
    if kind == "ocr_boxes":
        if not isinstance(body.get("image_path"), str):
            return "image_path is required"
        boxes = body.get("boxes")
        if not isinstance(boxes, list) or not boxes:
            return "boxes must be a non-empty list"
        return _check_boxes(boxes)
    return "kind must be analyze_batch, ocr_batch, ocr_boxes or inpaint"


def _check_boxes(boxes: Any) -> str | None:
    if not isinstance(boxes, list):
        return "boxes must be a list"
    for b in boxes:
        box = b.get("box") if isinstance(b, dict) else None
        if not isinstance(b, dict) or not isinstance(b.get("id"), str) or not isinstance(box, dict) or not all(
            isinstance(box.get(k), int) for k in ("x", "y", "w", "h")
        ):
            return "each box needs id and integer box {x,y,w,h}"
        if not isinstance(b.get("rotation", 0), (int, float)):
            return "rotation must be a number"
    return None


def make_handler(token: str, jobs: JobQueue):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"komaflow-sidecar/{__version__}"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet; desktop collects stderr
            sys.stderr.write("[sidecar] " + (fmt % args) + "\n")

        def _send(self, code: int, body: Any) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _auth(self) -> bool:
            got = self.headers.get("X-Komaflow-Token", "")
            if not hmac.compare_digest(got.encode(), token.encode()):
                self._send(401, {"error": "bad token"})
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            if not self._auth():
                return
            if self.path == "/health":
                return self._send(200, {"ok": True, "version": __version__})
            if self.path == "/capabilities":
                return self._send(200, be.capabilities())
            if self.path.startswith("/jobs/"):
                job = jobs.get(self.path[len("/jobs/"):])
                return self._send(200, job.to_dict()) if job else self._send(404, {"error": "no such job"})
            self._send(404, {"error": "not found"})

        def do_DELETE(self) -> None:  # noqa: N802
            if not self._auth():
                return
            if self.path.startswith("/jobs/"):
                jid = self.path[len("/jobs/"):]
                if not jobs.get(jid):
                    return self._send(404, {"error": "no such job"})
                jobs.cancel(jid)
                return self._send(200, jobs.get(jid).to_dict())  # type: ignore[union-attr]
            self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._auth():
                return
            if self.path != "/jobs":
                return self._send(404, {"error": "not found"})
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send(413, {"error": "body too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(422, {"error": "invalid JSON"})
            err = validate_job(body)
            if err:
                return self._send(422, {"error": err})
            opts = body.get("options", {})
            if body["kind"] == "analyze_batch":
                job = jobs.submit("analyze_batch", lambda ctl: analyze_batch(body["pages"], opts, ctl))
            elif body["kind"] == "inpaint":
                job = jobs.submit("inpaint", lambda ctl: inpaint_batch(body["items"], opts, ctl))
            elif body["kind"] == "ocr_batch":
                job = jobs.submit("ocr_batch", lambda ctl: ocr_batch(body["pages"], opts, ctl))
            else:
                job = jobs.submit("ocr_boxes", lambda ctl: ocr_boxes(body["image_path"], body["boxes"], opts, ctl))
            self._send(202, {"job_id": job.id})

    return Handler


def serve(token: str, port: int = 0, host: str = "127.0.0.1") -> None:
    jobs = JobQueue()
    httpd = ThreadingHTTPServer((host, port), make_handler(token, jobs))
    sys.stdout.write(json.dumps({"event": "listening", "port": httpd.server_address[1]}) + "\n")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
