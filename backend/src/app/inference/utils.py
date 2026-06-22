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
        return None, None

    response_text = getattr(response, "text", None)
    if not response_text and response.candidates:
        parts = response.candidates[0].content.parts
        response_text = "".join(part.text or "" for part in parts)

    if not response_text:
        return None, None

    try:
        result = json.loads(response_text)
    except json.JSONDecodeError:
        return None, response_text.strip() or None

    label = result.get("label")
    summary = result.get("summary")
    return label, summary


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
