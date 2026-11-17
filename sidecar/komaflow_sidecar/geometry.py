"""Pure helpers: class mapping, box rounding/clamping, crop rectangles. No heavy imports."""
from __future__ import annotations

from typing import Iterable

OBJECT_TYPES = ("bubble", "sfx", "onomatopoeia", "text")

# koharu-layout classes: text / onomatopoeia / bubble / panel (config.json of the model).
# The model has no "sfx" class: sfx boxes are set manually in the desktop (re-type).
# Final mapping is confirmed in spike S2 (docs/07-spikes.md).
DEFAULT_CLASS_MAP: dict[str, str | None] = {
    "bubble": "bubble",
    "text": "text",
    "onomatopoeia": "onomatopoeia",
    "panel": None,  # dropped
}


def map_class(name: str, class_map: dict[str, str | None] | None = None) -> str | None:
    """Our object type for a model class, or None to drop it. Unknown classes are dropped."""
    m = DEFAULT_CLASS_MAP if class_map is None else class_map
    t = m.get(name)
    return t if t in OBJECT_TYPES else None


def xyxy_to_box(xyxy: Iterable[float], width: int, height: int) -> dict[str, int] | None:
    """Float corner box -> integer {x,y,w,h} inside the page; None if it collapses."""
    x0, y0, x1, y1 = (float(v) for v in xyxy)
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    ix0 = min(max(int(round(x0)), 0), width - 1)
    iy0 = min(max(int(round(y0)), 0), height - 1)
    ix1 = min(max(int(round(x1)), ix0 + 1), width)
    iy1 = min(max(int(round(y1)), iy0 + 1), height)
    if ix1 - ix0 < 2 or iy1 - iy0 < 2:
        return None
    return {"x": ix0, "y": iy0, "w": ix1 - ix0, "h": iy1 - iy0}


def crop_rect(box: dict[str, int], padding: int, width: int, height: int) -> tuple[int, int, int, int]:
    """(left, top, right, bottom) for PIL.crop: box grown by `padding` px, clipped to the page."""
    p = max(0, int(padding))
    return (
        max(0, box["x"] - p),
        max(0, box["y"] - p),
        min(width, box["x"] + box["w"] + p),
        min(height, box["y"] + box["h"] + p),
    )


def clean_ocr_text(text: str) -> str:
    """Strips model control tokens and surrounding whitespace, keeps line breaks."""
    import re

    t = re.sub(r"<\|[^|>]*\|>", "", text)
    lines = [ln.strip() for ln in t.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)
