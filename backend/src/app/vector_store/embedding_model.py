"""Contains the embedding model factory."""

from __future__ import annotations

from sentence_transformers import SentenceTransformer


def load_embedding_model(
    model_name: str = "nomic-ai/nomic-embed-text-v1.5",
) -> SentenceTransformer:
    """Load the embedding model from HuggingFace."""
    return SentenceTransformer(model_name, trust_remote_code=True)
