"""Contains the client to run inference."""

from __future__ import annotations

from google import genai


def get_client(api_key: str):
    """Configure and return the Gemini client."""
    return genai.Client(api_key=api_key)
