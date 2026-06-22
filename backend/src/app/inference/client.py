"""Contains the client to run inference."""

from __future__ import annotations

import os
from pathlib import Path

from google import genai


def get_client(api_key: str | None = None):
    """Configure and return the Gemini client."""
    load_env_files()

    resolved_api_key = api_key or os.getenv("GEMINI_API_KEY")

    if not resolved_api_key:
        raise RuntimeError(
            "Missing Gemini API key. Set GEMINI_API_KEY in backend/.env "
            "or your shell environment."
        )

    return genai.Client(api_key=resolved_api_key)


def load_env_files() -> None:
    """Load .env files without overriding existing environment variables."""
    client_path = Path(__file__).resolve()
    backend_dir = client_path.parents[3]
    project_dir = backend_dir.parent

    for env_path in (project_dir / ".env", backend_dir / ".env"):
        load_env_file(env_path)


def load_env_file(env_path: Path) -> None:
    """Load KEY=VALUE lines from one .env file."""
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")

        if key and key not in os.environ:
            os.environ[key] = value
