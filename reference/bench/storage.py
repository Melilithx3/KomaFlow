"""Каталог прогона, state.json и возобновление после прерывания."""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from . import paths


def _atomic_write(p: Path, data) -> None:
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    tmp.replace(p)


class RunStore:
    """runs/<YYYYmmdd_HHMMSS>/ — новый каталог на каждый прогон, старые не трогаются."""

    def __init__(self, run_dir: Path, created: bool):
        self.dir = run_dir
        self.created = created
        self.state_path = run_dir / "state.json"
        self.state = json.loads(self.state_path.read_text(encoding="utf-8")) if self.state_path.exists() else {
            "combos": {}, "envs": {}, "created": time.strftime("%Y-%m-%d %H:%M:%S"), "resumed": []}

    @classmethod
    def new(cls) -> RunStore:
        paths.RUNS.mkdir(parents=True, exist_ok=True)
        base = time.strftime("%Y%m%d_%H%M%S")
        d = paths.RUNS / base
        i = 1
        while d.exists():
            d = paths.RUNS / f"{base}_{i}"
            i += 1
        d.mkdir(parents=True)
        return cls(d, True)

    @classmethod
    def open(cls, which: str) -> RunStore:
        if which == "last":
            cands = sorted(p for p in paths.RUNS.glob("*") if (p / "state.json").exists())
            if not cands:
                raise FileNotFoundError("нет прогонов для возобновления в runs/")
            d = cands[-1]
        else:
            d = Path(which)
            if not d.is_absolute():
                d = paths.RUNS / which if (paths.RUNS / which).exists() else paths.ROOT / which
        if not (d / "state.json").exists():
            raise FileNotFoundError(f"{d} не похож на каталог прогона (нет state.json)")
        st = cls(d, False)
        st.state["resumed"].append(time.strftime("%Y-%m-%d %H:%M:%S"))
        return st

    def save(self) -> None:
        _atomic_write(self.state_path, self.state)

    def write_json(self, rel: str, data) -> Path:
        p = self.dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(p, data)
        return p

    def combo_dir(self, model: str, dir_name: str) -> Path:
        return self.dir / model / dir_name

    def is_done(self, combo_id: str) -> bool:
        s = self.state["combos"].get(combo_id)
        return bool(s and s.get("final"))

    def prepare_combo_dir(self, model: str, dir_name: str) -> Path:
        """Если предыдущая попытка была прервана — переносим её в _attempt<N>, а не затираем."""
        d = self.combo_dir(model, dir_name)
        if d.exists() and any(d.iterdir()):
            n = 1
            while (d.parent / f"{dir_name}_attempt{n}").exists():
                n += 1
            shutil.move(str(d), str(d.parent / f"{dir_name}_attempt{n}"))
        d.mkdir(parents=True, exist_ok=True)
        return d

    def set_combo(self, combo_id: str, record: dict) -> None:
        self.state["combos"][combo_id] = record
        self.save()
