# CLAUDE.md

## Project Overview

A RAG-powered backend for a Jupyter Notebook browser extension that adds a **visual canvas with NLP search**. Users can search their notebook cells in natural language and the canvas spatially reorganizes cells by relevance with graduated highlighting. The frontend (handled separately) communicates with two endpoints:

- `POST /notebook` — loads a full notebook on open
- `POST /cell` — updates a single cell on execution

---

## Stack

- **Embeddings**: `nomic-embed-text-v1.5` via `sentence_transformers` (runs locally)
- **Vector store**: ChromaDB (persistent, in-process)

---

## Cell Classes (`cells.py`)

Three classes handle parsing of raw nbformat cell dicts:

- `NotebookCell` — base class with `cell_id`, `cell_type`, `content`; provides `to_chunk()` and `to_embed()`
- `MarkdownCell` — no additional logic needed
- `CodeCell` — parses outputs (stream, execute_result, display_data, error tracebacks); extends `to_embed()` to include output text

Use `cell_factory(cell)` as the single entry point to instantiate the correct subclass.

Key methods:
- `to_chunk(notebook_id)` → `Metadata` dict stored in Chroma (`cell_id`, `cell_type`, `content`, `notebook_id`)
- `to_embed()` → text fed to the embedder; code cells include output and error tracebacks, never returned directly

---

## Utils (`utils.py`)

- `load_embedding_model(model_name)` → `SentenceTransformer`; defaults to `nomic-embed-text-v1.5`, accepts any HuggingFace model name
- `chunk_complete_notebook(notebook, notebook_id)` → `tuple[list[Metadata], list[str]]` — chunks and embed texts produced together so the cell object isn't discarded before `to_embed()` is called
- `create_vector_store(path, collection_name)` → `Collection` — persistent Chroma client
- `construct_vector_store(collection, chunks, embed_texts, model)` — upserts all cells from a full notebook
- `update_vector_store(collection, chunk, embed_text, model)` — upserts a single re-executed cell by `cell_id`
- `delete_notebook_from_store(collection, notebook_id)` — removes all cells for a notebook using Chroma `where` filter
- `retrieve_documents(query, collection, model, notebook_id, n_results)` → ranked list of `{cell_id, cell_type, distance}`

---

## Design Decisions

- **Cell order is not stored** — the frontend maintains cell positions; the backend only returns `cell_id` + `distance` for relevance ranking
- **Upsert by `cell_id`** — re-executed cells replace their old vector, not append
- **`notebook_id` scopes all queries** — Chroma `where` filter ensures search is scoped to the active notebook
- **Single embedding model** — one model for all cell types keeps query embedding simple (one vector store, one query)
- **`distance` returned to frontend** — used for graduated highlighting intensity on the canvas
- **Error tracebacks are embedded** — errors are included in `to_embed()` so queries like "where did I get a ZeroDivisionError" match correctly
- **`embed_texts` separated from chunks** — `chunk_complete_notebook` returns both together so `to_embed()` is called while the cell object is still in scope; utils functions receive plain strings

---

## Tests

Two test files, both using real instances (no mocks):

**`test_cells.py`** — unit tests for cell parsing:
- `cell_factory` instantiation and unknown type handling
- Missing key failures (`id`, `source`)
- `to_chunk` key presence, `notebook_id` correctness, output exclusion, Chroma type compatibility
- `to_embed` content for all cell types including error tracebacks
- Output parsing for all nbformat output types (stream, execute_result, display_data, error)

**`test_vector_storage.py`** — integration tests against a real ephemeral Chroma instance:
- `construct_vector_store` — chunks retrievable by ID, metadata stored correctly, count matches
- `update_vector_store` — upsert replaces not appends, metadata reflects latest cell
- `delete_notebook_from_store` — target notebook deleted, other notebooks untouched, count decreases correctly
- `retrieve_documents` — results scoped to notebook, distance scores present, ordered by relevance, empty collection returns `[]`

Tests use `EphemeralClient` (no disk I/O), `setUpClass` to load the model once, and `tearDown` to delete the collection after each test to avoid state leakage. Embedding model in tests: `all-MiniLM-L6-v2` (fast).
