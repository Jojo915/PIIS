"""Contains inference related utility functions."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .client import get_client

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
    return "label"


def create_prompt(cell_content: str) -> str:
    """Create the prompt for the LLM."""
    template = """You are given the following jupyter notebook cell content:
    <CONTENT>.

    Generate a short label, not longer than 4 words, that describes the content
    of the cell.
    ONLY output the label. No other text! No prefixes and no suffixes!
    No formatting, nothing.
    """
    return template.replace("<CONTENT>", cell_content)


if __name__ == "__main__":
    client = get_client()
    cell_content = "import numpy as np\n\n# Normalize to zero mean and unit \
    variance\nX = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])\n \
    X_normalized = (X - X.mean(axis=0)) / X.std(axis=0)\nprint(X_normalized)"
    prompt = create_prompt(cell_content)
    print(prompt)
    response = run_chat_completion(client, prompt)
    print("response:", response)
