"""Contains inference related utility functions."""

from __future__ import annotations


def run_chat_completion(
    client,
    prompt: str,
    model: str = "gemini-2.5-flash-lite",
    max_output_tokens: int = 128,
) -> tuple | None:
    """Send cell content to LLM and receive response."""
    # config = types.GenerateContentConfig(
    #     max_output_tokens=128,
    #     response_mime_type="application/json",
    #     response_schema={
    #         "type": "object",
    #         "properties": {
    #             "label": {"type": "string"},
    #             "summary": {"type": "string"},
    #         },
    #         "required": ["label", "summary"],
    #     },
    #     thinking_config=types.ThinkingConfig(thinking_budget=0),
    # )

    # response = client.models.generate_content(
    #     model=model, contents=prompt, config=config
    # )
    # if not response.candidates:
    #     return None, None
    # result = json.loads(response.candidates[0].content.parts[0].text)
    # label = result["label"]
    # summary = result["summary"]
    return "label", "summary"


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
