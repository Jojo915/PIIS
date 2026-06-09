"""Contains the client to run inference."""

from __future__ import annotations

from openai import OpenAI


def get_client(
    api_key: str = "EMPTY", api_url: str = "http://localhost:8001/v1"
):
    """Construct and return the OpenAI API client."""
    return OpenAI(api_key=api_key, base_url=api_url, timeout=300.0)
