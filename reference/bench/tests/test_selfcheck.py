"""Самопроверка тестировщика (не моделей!): таймауты, зависания, прерывание, resume, статистика, отчёт.

Запуск:  .tools\\venv\\Scripts\\python.exe -m unittest tests.test_selfcheck -v
Все фиктивные данные создаются во временном каталоге и в отчёты бенчмарка не попадают.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bench import paths, report, stats  # noqa: E402
from bench.metrics import GpuSources  # noqa: E402
from bench.runner import run_worker  # noqa: E402
from bench.storage import RunStore  # noqa: E402

PY = Path(sys.executable)


def _script(tmp: Path, body: str) -> Path:
    p = tmp / "fake_worker.py"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


class StatsTest(unittest.TestCase):
    def test_describe(self):
        d = stats.describe([1, 2, 3, 4])
        self.assertEqual(d["n"], 4)
        self.assertAlmostEqual(d["mean"], 2.5)
        self.assertAlmostEqual(d["median"], 2.5)
        self.assertIsNone(d["p95"])  # мало измерений — P95 не считается
        d = stats.describe(list(range(1, 21)))
        self.assertAlmostEqual(d["p95"], 19.05)
        self.assertEqual(stats.describe([])["n"], 0)


class RunnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = GpuSources(3500)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bench_selftest_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, body, **kw):
        job = self.tmp / "job.json"
        job.write_text("{}", encoding="utf-8")
        out = self.tmp / "out"
        kw.setdefault("hard_timeout_s", 30)
        kw.setdefault("stall_timeout_s", 30)
        return run_worker(PY, job, out, self.src, 12, script=_script(self.tmp, body), **kw)

    def test_ok_and_metrics(self):
        o = self._run("""
            import json, time, sys
            from pathlib import Path
            p = Path('progress.jsonl')
            def ev(ph): p.open('a').write(json.dumps({'phase': ph, 't': time.time()}) + '\\n')
            ev('load'); x = bytearray(200 * 2**20); ev('measure'); time.sleep(1.5); ev('done')
        """)
        self.assertEqual(o.status, "ok", o.reason)
        self.assertEqual([e["phase"] for e in o.events], ["load", "measure", "done"])
        w = o.metrics["whole_run"]
        self.assertGreater(w["samples"], 3)
        self.assertGreater(w["peak_proc_rss_mb"], 150)  # 200 МБ bytearray виден сэмплеру

    def test_crash_is_failure(self):
        o = self._run("import sys; sys.exit(3)")
        self.assertEqual(o.status, "failed")
        self.assertIn("3", o.reason)

    def test_hard_timeout_kills_tree(self):
        t = time.time()
        o = self._run("""
            import subprocess, sys, time
            subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
            time.sleep(120)
        """, hard_timeout_s=3, stall_timeout_s=100)
        self.assertEqual(o.status, "timeout")
        self.assertLess(time.time() - t, 25)

    def test_stall_detected(self):
        o = self._run("import time; time.sleep(120)", hard_timeout_s=100, stall_timeout_s=3)
        self.assertEqual(o.status, "stalled")

    def test_interrupt(self):
        stop = threading.Event()
        threading.Timer(2, stop.set).start()
        o = self._run("import time; time.sleep(120)", hard_timeout_s=100, stall_timeout_s=100, stop_flag=stop)
        self.assertEqual(o.status, "interrupted")


class StorageReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bench_selftest_"))
        self._runs = paths.RUNS
        paths.RUNS = self.tmp  # не трогаем настоящий каталог runs/

    def tearDown(self):
        paths.RUNS = self._runs
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_new_runs_never_collide_and_resume(self):
        a, b = RunStore.new(), RunStore.new()
        self.assertNotEqual(a.dir, b.dir)
        a.set_combo("lama-manga/cpu-fp32", {"id": "lama-manga/cpu-fp32", "final": True, "status": "ok"})
        a.set_combo("lama-manga/rocm-fp32", {"id": "lama-manga/rocm-fp32", "final": False, "status": "interrupted"})
        r = RunStore.open(str(a.dir))
        self.assertTrue(r.is_done("lama-manga/cpu-fp32"))
        self.assertFalse(r.is_done("lama-manga/rocm-fp32"))
        # прерванная попытка не затирается, а переносится
        d = r.prepare_combo_dir("lama-manga", "rocm-fp32")
        (d / "x.txt").write_text("1")
        d2 = r.prepare_combo_dir("lama-manga", "rocm-fp32")
        self.assertTrue((d2.parent / "rocm-fp32_attempt1" / "x.txt").exists())

    def test_report_renders_all_statuses(self):
        st = RunStore.new()
        st.state.update(hardware={"cpu": {"name": "cpu"}, "gpu_dxgi": [], "gpu_wmi": []},
                        images=[{"name": "p1.png", "sha256": "0" * 64}])
        for i, s in enumerate(["ok", "failed", "timeout", "not_tested"]):
            st.set_combo(f"lama-manga/cpu-v{i}", {"id": f"lama-manga/cpu-v{i}", "model": "lama-manga", "backend": "cpu",
                                                  "variant": f"v{i}", "support": "official", "env": "torch-cpu",
                                                  "status": s, "reason": None if s == "ok" else "причина",
                                                  "dir": f"lama-manga/cpu-v{i}", "final": True, "notes": ""})
        report.generate(st)
        h = (st.dir / "summary.html").read_text(encoding="utf-8")
        for word in ("успех", "ошибка", "таймаут", "не проверено", "Сознательно исключённые"):
            self.assertIn(word, h)
        self.assertEqual(len(json.loads((st.dir / "summary.json").read_text(encoding="utf-8"))["combos"]), 4)
        self.assertEqual(len((st.dir / "summary.csv").read_text(encoding="utf-8-sig").strip().splitlines()), 5)


if __name__ == "__main__":
    unittest.main()
