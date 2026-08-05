"""Contains initial fastapi endpoints."""

from __future__ import annotations

import hashlib

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.analysis.dead_cells import find_dead_cells
from app.analysis.stale_cells import find_stale_cells
from app.cells.code import CodeCell
from app.cells.factory import cell_factory
from app.inference.client import get_client
from app.inference.utils import (
    create_label_and_summary_prompt,
    run_chat_completion,
)
from app.settings_store.base import AiSettings
from app.settings_store.sqlite_store import SQLiteSettingsStore
from app.summary_store.base import CellSummary
from app.summary_store.sqlite_store import SQLiteSummaryStore
from app.vector_store.client import create_vector_store
from app.vector_store.embedding_model import load_embedding_model
from app.vector_store.operations import (
    chunk_complete_notebook,
    construct_vector_store,
    delete_cell_from_store,
    delete_notebook_from_store,
    enrich_embed_text,
    update_cell_order,
    update_vector_store,
)
from app.vector_store.utils import (
    find_duplicate_clusters,
    retrieve_documents,
    retrieve_previous_cells,
    retrieve_similar_cells,
)

app = FastAPI()

model = load_embedding_model("sentence-transformers/all-MiniLM-L6-v2")

summary_store = SQLiteSummaryStore()
settings_store = SQLiteSettingsStore()
INVALID_AI_SUMMARIES = {"", "summary"}


def resolve_ai_client_and_model() -> tuple[object | None, str]:
    """Resolve the Gemini client and model to use for the next LLM call.

    Reads the current AI settings on every call (mirroring the existing,
    already-accepted pattern of calling ``create_vector_store`` fresh per
    request rather than caching it -- see CLAUDE.md) so a key saved via the
    AI Settings panel takes effect immediately without an app restart.

    A saved API key always takes priority; falling back to the
    ``GEMINI_API_KEY`` environment variable (via ``get_client``'s own
    default) keeps existing local-dev setups working unchanged. If neither
    is available, returns ``client=None`` rather than raising -- the app
    should still start and index notebooks (with local-fallback summaries)
    before a key has ever been configured, instead of requiring one at
    startup.
    """
    settings = settings_store.get_settings()
    try:
        client = get_client(api_key=settings.api_key)
    except RuntimeError:
        client = None
    return client, settings.resolved_model


class Cell(BaseModel):
    """Represents the data for a cell."""

    content: dict
    notebook_id: str
    cell_index: int


class Notebook(BaseModel):
    """Represents the notebook."""

    notebook_id: str
    content: dict


class Query(BaseModel):
    """Represents the query."""

    notebook_id: str
    text: str
    n_results: int = (
        8  # top N to fetch; caller splits into top / others buckets
    )


class SummaryRequest(BaseModel):
    """Represents a user-edited cell summary."""

    notebook_id: str
    cell_id: str
    label: str | None = None
    summary: str | None


class SummaryResponse(BaseModel):
    """Represents stored summaries for one cell."""

    notebook_id: str
    cell_id: str
    ai_label: str | None
    user_label: str | None
    ai_summary: str | None
    user_summary: str | None
    source_hash: str | None
    display_label: str | None
    display_summary: str | None
    created_at: str
    updated_at: str


class SummarySuggestionRequest(BaseModel):
    """Represents a one-off AI summary suggestion request."""

    notebook_id: str
    cell_id: str
    cell_type: str
    source: str
    previous_cells: list[str] = []


class SummarySuggestionResponse(BaseModel):
    """Represents an unsaved AI label and summary suggestion."""

    label: str | None
    summary: str | None


class NotebookSummaryCell(BaseModel):
    """Represents one notebook cell for summary hydration."""

    cell_id: str
    cell_type: str
    source: str
    cell_index: int


class NotebookSummariesRequest(BaseModel):
    """Represents a batch summary request for one notebook."""

    notebook_id: str
    cells: list[NotebookSummaryCell]


# NOTE: This is called when a cell is executed, you send the cell
@app.post("/cells")
async def embed_cell(cell: Cell):
    """Receives a cell and embeds the cell."""
    content = cell.content
    notebook_id = cell.notebook_id

    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    created_cell = cell_factory(content, cell.cell_index)
    updated_chunk = created_cell.to_chunk(notebook_id=notebook_id)
    updated_embed = created_cell.to_embed()
    if isinstance(created_cell, CodeCell):
        previous_cells = retrieve_previous_cells(
            collection, notebook_id, cell.cell_index
        )
        context = [str(c["embed_text"]) for c in previous_cells]
        prompt = create_label_and_summary_prompt(created_cell.content, context)
        ai_client, ai_model = resolve_ai_client_and_model()
        label, summary = run_chat_completion(
            client=ai_client, prompt=prompt, model=ai_model
        )
        if label is not None:
            updated_chunk["label"] = label  # pyright: ignore[reportIndexIssue]
        if summary is not None:
            updated_chunk["summary"] = summary  # pyright: ignore[reportIndexIssue]
            summary_store.save_ai_summary(
                notebook_id=notebook_id,
                cell_id=str(updated_chunk["cell_id"]),
                summary=summary,
                label=label,
                source_hash=hash_cell_source(str(updated_chunk["content"])),
            )
        updated_embed = enrich_embed_text(updated_embed, label, summary)
        updated_chunk["embed_text"] = updated_embed  # pyright: ignore[reportIndexIssue]
    update_vector_store(collection, updated_chunk, updated_embed, model)
    return updated_chunk


# NOTE: This is called when the user deletes a cell.
@app.delete("/cells/{cell_id}")
async def delete_cell(cell_id: str, notebook_id: str):
    """Delete a single cell from the vector store and summary store.

    ``notebook_id`` is required (not just ``cell_id``) because the
    summary store's rows are keyed by (notebook_id, cell_id) -- cell_id
    alone is only guaranteed unique within a single notebook, not across
    every notebook ever indexed. Without it, a deleted cell's AI/user
    summary row would be orphaned in SQLite forever (see summary store
    docs for why deletion isn't automatic there).
    """
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    delete_cell_from_store(collection, notebook_id, cell_id)
    summary_store.delete_cell_summary(notebook_id=notebook_id, cell_id=cell_id)
    return {"deleted": cell_id}


@app.get("/cells/summary", response_model=SummaryResponse)
async def get_cell_summary(notebook_id: str, cell_id: str):
    """Return stored summaries for one cell."""
    summary = summary_store.get_summary(notebook_id, cell_id)

    if summary is None:
        raise HTTPException(status_code=404, detail="Summary not found")

    return summary_to_response(summary)


@app.post("/cells/summary", response_model=SummaryResponse)
async def save_cell_summary(request: SummaryRequest):
    """Create or update a user-edited summary for one cell."""
    summary = summary_store.save_user_summary(
        notebook_id=request.notebook_id,
        cell_id=request.cell_id,
        summary=request.summary,
        label=request.label,
    )
    return summary_to_response(summary)


@app.post(
    "/cells/summary/suggestion", response_model=SummarySuggestionResponse
)
async def suggest_cell_summary(request: SummarySuggestionRequest):
    """Generate an unsaved AI label and summary suggestion for one cell."""
    label, summary = generate_cell_label_and_summary(
        cell_type=request.cell_type,
        source=request.source,
        previous_cells=request.previous_cells,
    )
    return SummarySuggestionResponse(label=label, summary=summary)


@app.post("/notebooks/summaries", response_model=list[SummaryResponse])
async def get_notebook_summaries(request: NotebookSummariesRequest):
    """Return display summaries for cells, generating missing AI summaries."""
    responses: list[SummaryResponse] = []
    previous_cells: list[str] = []

    for cell in sorted(request.cells, key=lambda item: item.cell_index):
        source_hash = hash_cell_source(cell.source)
        stored = get_stored_summary_for_cell(
            notebook_id=request.notebook_id,
            cell_id=cell.cell_id,
            source_hash=source_hash,
        )

        if (
            stored is not None
            and stored.display_summary is not None
            and (
                stored.user_summary is not None
                or (
                    stored.source_hash == source_hash
                    and is_valid_ai_summary(stored.ai_summary)
                )
            )
        ):
            responses.append(summary_to_response(stored))
            previous_cells.append(cell.source)
            continue

        generated_label, generated_summary = generate_cell_label_and_summary(
            cell_type=cell.cell_type,
            source=cell.source,
            previous_cells=previous_cells,
        )
        summary = summary_store.save_ai_summary(
            notebook_id=request.notebook_id,
            cell_id=cell.cell_id,
            summary=generated_summary,
            label=generated_label,
            source_hash=source_hash,
        )
        responses.append(summary_to_response(summary))
        previous_cells.append(cell.source)

    return responses


# NOTE: This is called when the user opens a notebook
@app.post("/notebooks")
async def embed_notebook(notebook: Notebook):
    """Receives the complete notebook and embeds it."""
    notebook_id = notebook.notebook_id
    content = notebook.content
    ai_client, ai_model = resolve_ai_client_and_model()
    chunks, embed_texts = chunk_complete_notebook(
        content, notebook_id, ai_client, ai_model
    )
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    delete_notebook_from_store(collection, notebook_id)
    construct_vector_store(collection, chunks, embed_texts, model)
    save_ai_summaries(notebook_id, chunks)
    # Re-indexing rebuilds every chunk from scratch, so any summary row
    # left over from a cell that no longer exists (deleted, or renamed to
    # a new cell_id) would otherwise linger in SQLite forever. Only prune
    # cells absent from the fresh index -- cells whose id survived the
    # re-index keep their row (including any user edit) untouched, since
    # save_ai_summaries above never overwrites user_label/user_summary.
    current_cell_ids = {str(chunk["cell_id"]) for chunk in chunks}
    summary_store.delete_orphaned_summaries(notebook_id, current_cell_ids)
    return chunks


# NOTE: This is called when the user enters a question, returns similar cells.
@app.post("/search")
async def query_cells(query: Query):
    """Receives a question and responds with the most similar cells."""
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )

    results = retrieve_documents(
        query=query.text,
        collection=collection,
        model=model,
        notebook_id=query.notebook_id,
        n_results=query.n_results,
    )
    return results


class DuplicateRequest(BaseModel):
    """Request to find near-duplicate cells for a given cell."""

    notebook_id: str
    cell_id: str
    threshold: float = 0.35


class DuplicateResult(BaseModel):
    """One near-duplicate cell returned by the duplicate check."""

    cell_id: str
    distance: float


@app.post("/cells/duplicates", response_model=list[DuplicateResult])
async def find_duplicate_cells(request: DuplicateRequest):
    """Return code cells in the notebook that are near-duplicates of cell_id.

    Only cells whose embedding distance is at or below `threshold` are
    returned. The queried cell itself is excluded from the results.
    An empty list means no duplicates were found.

    NOTE: this per-cell lookup is no longer what powers the duplicate
    advisor shown in the sidebar -- see `/notebooks/duplicate-cells`
    below, which whole-notebook clusters with complete linkage instead of
    trusting one cell's raw neighbor list as an entire group. This
    endpoint is kept as a general-purpose "what's this one cell close
    to" lookup.
    """
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    results = retrieve_similar_cells(
        cell_id=request.cell_id,
        notebook_id=request.notebook_id,
        collection=collection,
        model=model,
        threshold=request.threshold,
    )
    return [DuplicateResult(**r) for r in results]


class DuplicateClustersRequest(BaseModel):
    """Request to find all duplicate clusters within a notebook."""

    notebook_id: str
    threshold: float = 0.35


class DuplicateClusterResult(BaseModel):
    """One cluster of mutually near-duplicate code cells."""

    cell_ids: list[str]


@app.post(
    "/notebooks/duplicate-cells", response_model=list[DuplicateClusterResult]
)
async def detect_duplicate_clusters(request: DuplicateClustersRequest):
    """Return independent clusters of mutually near-duplicate code cells.

    Advisor-only whole-notebook analysis, following the same shape as
    `/notebooks/dead-cells` and `/notebooks/stale-cells`: it replaces the
    entire current duplicate-cluster set each time it's called, so the
    caller (the extension's `runAdvisors`) can post a full-replace
    result to the webview rather than accumulating groups incrementally.

    Uses complete-linkage clustering (see
    app.analysis.duplicate_clusters) so two unrelated near-duplicate
    clusters connected only by a weak "bridge" pair of cells are kept
    separate, instead of being merged into one oversized group. An empty
    list means no duplicate clusters were found.
    """
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    clusters = find_duplicate_clusters(
        notebook_id=request.notebook_id,
        collection=collection,
        model=model,
        threshold=request.threshold,
    )
    return [DuplicateClusterResult(cell_ids=cluster) for cluster in clusters]


class DeadCellResult(BaseModel):
    """One code cell flagged as a likely-dead candidate."""

    cell_id: str
    cell_index: int
    unused_names: list[str]
    reason: str


@app.post("/notebooks/dead-cells", response_model=list[DeadCellResult])
async def detect_dead_cells(notebook: Notebook):
    """Return code cells that look like leftover / dead code.

    Advisor-only: this is a static analysis that never modifies the
    notebook. A cell is flagged only when it defines names no other cell
    uses and produces no output or observable effect. An empty list means
    nothing looked confidently dead.
    """
    dead = find_dead_cells(notebook.content)
    return [
        DeadCellResult(
            cell_id=item.cell_id,
            cell_index=item.cell_index,
            unused_names=item.unused_names,
            reason=item.reason,
        )
        for item in dead
    ]


class StaleCellResult(BaseModel):
    """One code cell whose shown output is likely out of date."""

    cell_id: str
    cell_index: int
    reason: str
    stale_due_to: list[int]


@app.post("/notebooks/stale-cells", response_model=list[StaleCellResult])
async def detect_stale_cells(notebook: Notebook):
    """Return code cells whose rendered output is likely stale.

    Advisor-only static analysis: a cell is flagged when a dependency ran
    more recently than it did (kernel ``execution_count``) or is itself
    stale, so a clean top-to-bottom rerun would produce different output.
    Only executed, statically-analyzable cells are ever returned; an empty
    list does not prove the notebook is fresh.
    """
    stale = find_stale_cells(notebook.content)
    return [
        StaleCellResult(
            cell_id=item.cell_id,
            cell_index=item.cell_index,
            reason=item.reason,
            stale_due_to=item.stale_due_to,
        )
        for item in stale
    ]


class ReorderRequest(BaseModel):
    """Represents the new cell ordering for a notebook."""

    notebook_id: str
    cell_ids: list[str]


@app.patch("/notebooks/reorder")
async def reorder_notebook(reorder: ReorderRequest):
    """Update stored cell_index for every cell after a reorder."""
    collection = create_vector_store(
        path="./chroma_db", collection_name="demo"
    )
    update_cell_order(collection, reorder.notebook_id, reorder.cell_ids)
    return {
        "notebook_id": reorder.notebook_id,
        "reordered": len(reorder.cell_ids),
    }


class AiSettingsRequest(BaseModel):
    """Represents a save request for the global AI settings.

    ``api_key`` is only present when the user actually typed a new one
    into the (password) field -- the webview never receives the stored
    key back to echo, so ``None``/omitted always means "leave the
    currently-saved key untouched", never "clear it". Clearing the key is
    only ever done through ``POST /settings/reset``.
    """

    api_key: str | None = None
    model: str
    custom_model: str | None = None
    detect_stale_cells: bool
    detect_duplicate_cells: bool
    detect_dead_cells: bool


class AiSettingsResponse(BaseModel):
    """Represents the current global AI settings.

    Deliberately omits the raw ``api_key`` -- only whether one is set --
    so a saved key is never sent back down to the webview/extension after
    the moment it was typed.
    """

    has_api_key: bool
    model: str
    custom_model: str | None
    detect_stale_cells: bool
    detect_duplicate_cells: bool
    detect_dead_cells: bool
    updated_at: str


class AiSettingsSaveResponse(BaseModel):
    """Represents the result of saving the global AI settings."""

    settings: AiSettingsResponse
    # Per the AI Settings feature's reindexing rule: a full notebook
    # reindex should happen only when a new/changed API key was just
    # saved, never for a model- or analysis-option-only change. The
    # caller (the extension) uses this flag to decide, rather than trying
    # to infer "did the key change" itself from before/after state.
    api_key_changed: bool


@app.get("/settings", response_model=AiSettingsResponse)
async def get_ai_settings():
    """Return the current global AI settings."""
    return settings_to_response(settings_store.get_settings())


@app.post("/settings", response_model=AiSettingsSaveResponse)
async def save_ai_settings(request: AiSettingsRequest):
    """Save the global AI settings."""
    previous_key = settings_store.get_settings().api_key
    new_key_provided = bool(request.api_key and request.api_key.strip())
    api_key_changed = new_key_provided and request.api_key != previous_key

    settings = settings_store.save_settings(
        api_key=request.api_key if new_key_provided else None,
        model=request.model,
        custom_model=request.custom_model,
        detect_stale_cells=request.detect_stale_cells,
        detect_duplicate_cells=request.detect_duplicate_cells,
        detect_dead_cells=request.detect_dead_cells,
    )
    return AiSettingsSaveResponse(
        settings=settings_to_response(settings),
        api_key_changed=api_key_changed,
    )


@app.post("/settings/reset", response_model=AiSettingsResponse)
async def reset_ai_settings():
    """Restore the global AI settings to their defaults, deleting the key."""
    return settings_to_response(settings_store.reset_settings())


def settings_to_response(settings: AiSettings) -> AiSettingsResponse:
    """Convert stored settings to an API response, hiding the raw key."""
    return AiSettingsResponse(
        has_api_key=bool(settings.api_key),
        model=settings.model,
        custom_model=settings.custom_model,
        detect_stale_cells=settings.detect_stale_cells,
        detect_duplicate_cells=settings.detect_duplicate_cells,
        detect_dead_cells=settings.detect_dead_cells,
        updated_at=settings.updated_at,
    )


def summary_to_response(summary: CellSummary) -> SummaryResponse:
    """Convert a stored summary to an API response."""
    return SummaryResponse(
        notebook_id=summary.notebook_id,
        cell_id=summary.cell_id,
        ai_label=summary.ai_label,
        user_label=summary.user_label,
        ai_summary=summary.ai_summary,
        user_summary=summary.user_summary,
        source_hash=summary.source_hash,
        display_label=summary.display_label,
        display_summary=summary.display_summary,
        created_at=summary.created_at,
        updated_at=summary.updated_at,
    )


def get_stored_summary_for_cell(
    notebook_id: str,
    cell_id: str,
    source_hash: str,
) -> CellSummary | None:
    """Return a stored summary, recovering it if the cell id changed."""
    stored = summary_store.get_summary(notebook_id, cell_id)

    if stored is not None and has_user_edits(stored):
        return stored

    stored_by_hash = summary_store.get_summary_by_source_hash(
        notebook_id, source_hash
    )

    if stored_by_hash is None:
        return stored

    if (
        stored is not None
        and stored_by_hash.cell_id == stored.cell_id
        and not has_user_edits(stored_by_hash)
    ):
        return stored

    return summary_store.copy_summary_to_cell(
        stored_by_hash,
        cell_id=cell_id,
        source_hash=source_hash,
    )


def has_user_edits(summary: CellSummary) -> bool:
    """Return whether the summary contains user-authored content."""
    return summary.user_label is not None or summary.user_summary is not None


def is_valid_ai_summary(summary: str | None) -> bool:
    """Return whether a stored AI summary is useful enough to show."""
    if summary is None:
        return False

    return summary.strip().lower() not in INVALID_AI_SUMMARIES


def save_ai_summaries(notebook_id: str, chunks: list) -> None:
    """Persist AI-generated summaries from notebook indexing."""
    for chunk in chunks:
        summary = chunk.get("summary")

        if summary is None:
            continue

        summary_store.save_ai_summary(
            notebook_id=notebook_id,
            cell_id=str(chunk["cell_id"]),
            summary=str(summary),
            label=str(chunk.get("label"))
            if chunk.get("label") is not None
            else None,
            source_hash=hash_cell_source(str(chunk["content"])),
        )


def hash_cell_source(source: str) -> str:
    """Return a stable hash for the cell source used by AI summaries."""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def generate_cell_label_and_summary(
    cell_type: str,
    source: str,
    previous_cells: list[str],
) -> tuple[str | None, str | None]:
    """Generate a label and summary for one cell when needed."""
    if cell_type != "code":
        return None, None

    context = previous_cells[-5:]
    prompt = create_label_and_summary_prompt(source, context)
    ai_client, ai_model = resolve_ai_client_and_model()
    return run_chat_completion(client=ai_client, prompt=prompt, model=ai_model)
