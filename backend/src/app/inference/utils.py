"""Contains inference related utility functions."""

from __future__ import annotations

import json
import os

from google.genai import types


DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite"


def run_chat_completion(
    client,
    prompt: str,
    model: str | None = None,
    max_output_tokens: int = 256,
) -> tuple | None:
    """Send cell content to LLM and receive response."""
    resolved_model = model or os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)

    config = types.GenerateContentConfig(
        max_output_tokens=max_output_tokens,
        response_mime_type="application/json",
        response_schema={
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["label", "summary"],
        },
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    try:
        response = client.models.generate_content(
            model=resolved_model, contents=prompt, config=config
        )
    except Exception as error:
        print(f"Gemini summary generation failed: {error}")
        return _fallback_label_and_summary(prompt)

    response_text = getattr(response, "text", None)
    if not response_text and response.candidates:
        parts = response.candidates[0].content.parts
        response_text = "".join(part.text or "" for part in parts)

    if not response_text:
        return _fallback_label_and_summary(prompt)

    try:
        result = json.loads(response_text)
    except json.JSONDecodeError:
        return None, response_text.strip() or None

    label = result.get("label")
    summary = result.get("summary")
    return label, summary


def _fallback_label_and_summary(prompt: str) -> tuple[str, str]:
    """Return a local summary when the LLM is unavailable or quota-limited."""
    source = _extract_cell_content(prompt)
    preview = _compact_source_preview(source)

    summary = (
        "AI summary generation is temporarily unavailable, so this local "
        f"fallback is based on the cell source. The cell starts with: {preview}"
    )
    return "Local fallback", summary


def _extract_cell_content(prompt: str) -> str:
    start_marker = "content:\n"
    start = prompt.find(start_marker)
    if start == -1:
        return prompt

    content = prompt[start + len(start_marker) :]
    end_markers = [
        "\n    Here are the previous cells",
        "\n    Generate a short label",
    ]
    end_positions = [
        content.find(marker) for marker in end_markers if content.find(marker) != -1
    ]

    if end_positions:
        content = content[: min(end_positions)]

    return content.strip().rstrip(".").strip()


def _compact_source_preview(source: str, max_length: int = 160) -> str:
    preview = " ".join(line.strip() for line in source.splitlines() if line.strip())
    if not preview:
        return "an empty cell."

    if len(preview) > max_length:
        preview = f"{preview[: max_length - 3].rstrip()}..."

    return preview


def _format_previous_cells(previous_cells: list[str] | None) -> str:
    """Format previous cells into a numbered, chronologically-ordered block.

    Returns an empty string if there is no previous-cell context, so prompts
    for the first cell in a notebook read naturally without a dangling
    section.
    """
    if not previous_cells:
        return ""
    formatted = "\n\n".join(
        f"Cell {i}:\n{content}"
        for i, content in enumerate(previous_cells, start=1)
    )
    return f"""
    Here are the previous cells in this notebook, in order, for context:
    {formatted}
    """


def create_label_and_summary_prompt(
    cell_content: str, previous_cells: list[str] | None = None
) -> str:
    """Create the prompt for the LLM for generating labels and summaries."""
    context = _format_previous_cells(previous_cells)
    template = """You are given the following jupyter notebook cell content:
    <CONTENT>.
    <CONTEXT>
    Generate a short label and a summary for this cell.
    - Label: not longer than 4 words, describes the cell content concisely.
    - Summary: exactly 2 sentences, describes what the cell does and why.
    Output valid JSON with the keys "label" and "summary". Nothing else.
    """
    return template.replace("<CONTENT>", cell_content).replace(
        "<CONTEXT>", context
    )
