"""Адаптеры моделей. Каждый модуль экспортирует Adapter, SkipImage и PACKAGES.

Интерфейс Adapter (минимальный, специфика модели — внутри):
  __init__(backend, job) ; load(model_dir) ; model_info() -> dict
  read_image(path) -> объект ; prepare(raw, img_meta) -> (input, meta_dict)
  infer(input) -> output (результат уже на CPU) ; save(output, out_dir, rec) -> list[путь]
"""


class SkipImage(Exception):
    """Изображение не подходит для этой модели (причина попадает в отчёт)."""
