"""Minimal stand-in for Streamlit, so the vendored data modules import without
the Streamlit UI stack.

The vendored modules (config, database, ai_backup, report_page) came from the
Streamlit app. They only need three things from streamlit:

  st.secrets        -> read .streamlit/secrets.toml or environment variables
  st.cache_data /
  st.cache_resource -> decorators that simply return the function
  everything else   -> no-op callables (widgets are only called from UI code
                       that never runs here)

Keeping this in `vendor/py/` means `node-app` has no `streamlit` dependency at
all, while the original files stay byte-identical to the Streamlit app.
"""
from __future__ import annotations

import os
from pathlib import Path


# --------------------------------------------------------------------------- secrets
def _candidate_files():
    here = Path(__file__).resolve()
    # vendor/py/streamlit.py -> node-app/vendor/py -> node-app -> repo root
    node_app = here.parent.parent.parent
    yield node_app / ".streamlit" / "secrets.toml"
    yield node_app.parent / ".streamlit" / "secrets.toml"
    yield Path.cwd() / ".streamlit" / "secrets.toml"


class _Secrets(dict):
    """Dict-like view of secrets.toml, with environment variables winning."""

    def __init__(self):
        super().__init__()
        self._loaded = False

    def _load(self):
        if self._loaded:
            return
        self._loaded = True
        for path in _candidate_files():
            if not path.exists():
                continue
            try:
                import tomllib

                with path.open("rb") as handle:
                    self.update(tomllib.load(handle))
                break
            except Exception:  # noqa: BLE001 - a bad secrets file must not crash
                continue

    def get(self, key, default=None):
        self._load()
        # dict.__contains__ on purpose: `key in self` would call our own
        # __contains__, which calls get() again -> infinite recursion.
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        return os.environ.get(key, default)

    def __getitem__(self, key):
        value = self.get(key, None)
        if value is None:
            raise KeyError(key)
        return value

    def __contains__(self, key):
        return self.get(key, None) is not None


secrets = _Secrets()


# --------------------------------------------------------------------- cache helpers
def _passthrough_decorator(fn=None, **_kwargs):
    """Supports both @st.cache_data and @st.cache_data(ttl=...) forms."""
    if callable(fn):
        return fn

    def wrap(func):
        return func

    return wrap


cache_data = _passthrough_decorator
cache_resource = _passthrough_decorator


class _SessionState(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name, value):
        self[name] = value


session_state = _SessionState()


# ------------------------------------------------------------------------ no-op UI
class _Noop:
    """Absorbs any other st.* call (st.header, st.columns, st.button, ...)."""

    def __call__(self, *args, **kwargs):
        return _Noop()

    def __getattr__(self, name):
        return _Noop()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False


def __getattr__(name):
    # Anything the vendored modules reference but we did not define.
    return _Noop()
