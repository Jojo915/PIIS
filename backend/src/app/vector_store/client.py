"""Contains the vector store client."""

import chromadb
from chromadb import Collection


def create_vector_store(path: str, collection_name: str) -> Collection:
    """Create a persistent Chroma client and return the collection."""
    client = chromadb.PersistentClient(path=path)
    return client.get_or_create_collection(collection_name)
