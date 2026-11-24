"""Boxes may lie outside the page (ADR 0018): OCR crops never fail."""
from PIL import Image

from komaflow_sidecar.geometry import crop_object


def test_crop_outside_page_is_blank_not_an_error():
    im = Image.new("RGB", (100, 200), (0, 0, 0))
    out = crop_object(im, {"x": -50, "y": 10, "w": 30, "h": 20}, 0, 4)
    assert out.size == (30, 20)
    assert out.getpixel((0, 0)) == (255, 255, 255)
    part = crop_object(im, {"x": -10, "y": 10, "w": 30, "h": 20}, 0, 0)
    assert part.size == (20, 20)  # clipped to the page
    rotated = crop_object(im, {"x": 90, "y": 50, "w": 40, "h": 10}, 90, 2)
    assert rotated.size == (44, 14)
