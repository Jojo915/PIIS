"""Contains inference related utility functions."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openai import OpenAI


def run_chat_completion(
    client: OpenAI,
    prompt: str,
    model: str = "meta-llama/Llama-3.2-3B-Instruct",
    max_output_tokens: int = 128,
) -> str | None:
    """Send cell content to LLM and receive response."""
    # completion = client.chat.completions.create(
    #     model=model,
    #     messages=[{"role": "user", "content": prompt}],
    #     max_tokens=max_output_tokens,
    # )
    # return completion.choices[0].message.content
    return "placeholder text"


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


def create_label_prompt(
    cell_content: str, previous_cells: list[str] | None = None
) -> str:
    """Create the prompt for the LLM for generating labels."""
    context = _format_previous_cells(previous_cells)
    template = """You are given the following jupyter notebook cell content:
    <CONTENT>.
    <CONTEXT>
    Generate a short label, not longer than 4 words, that describes the content
    of the cell.
    ONLY output the label. No other text! No prefixes and no suffixes!
    No formatting, nothing.
    """
    return template.replace("<CONTENT>", cell_content).replace(
        "<CONTEXT>", context
    )


def create_summary_prompt(
    cell_content: str, previous_cells: list[str] | None = None
) -> str:
    """Create the prompt for the LLM for generating summaries."""
    context = _format_previous_cells(previous_cells)
    template = """You are given the following jupyter notebook cell content:
    <CONTENT>.
    <CONTEXT>
    Generate a very short and concise summary of what the cell contains.
    """
    return template.replace("<CONTENT>", cell_content).replace(
        "<CONTEXT>", context
    )
