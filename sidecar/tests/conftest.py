import pytest


@pytest.fixture(autouse=True)
def _stop_workers():
    """Each test gets fresh warm workers; nothing leaks between tests."""
    yield
    from komaflow_sidecar import pool as p

    if p._pool is not None:
        p._pool.shutdown()
