# 0018. Box geometry is not clamped to the page

**Context.** Review 2026-11-24: a horizontal box could not be turned by 90° and put against the page edge — contract (`x, y ≥ 0`), server («box inside the page») and desktop (`clampBox`) all forced boxes into the page.

**Decision.** A box may stick out of the page or lie fully outside it, its centre too. Coordinates stay integer pixels of the raw page; only `w, h ≥ 1`. The server keeps a sanity limit: the box must lie within two page sizes around the page (`boxWithinReach`), else 422. The desktop rounds geometry (`roundBox`) and never moves or crops it; detections from analysis are still clamped (they come from inside the image). OCR crops of a box outside the image are blank instead of an error.

**Consequences.** PSD text layers and web outlines may extend beyond the canvas (as in Photoshop). Older clients that assumed `x ≥ 0` keep working: they never produce such boxes.
