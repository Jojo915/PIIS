"""Interfaces and data types for AI settings storage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

DEFAULT_MODEL = "gemini-2.5-flash-lite"
DEFAULT_DETECT_STALE_CELLS = True
DEFAULT_DETECT_DUPLICATE_CELLS = True
DEFAULT_DETECT_DEAD_CELLS = True


@dataclass(frozen=True)
class AiSettings:
    """Stored global AI configuration.

    Unlike ``CellSummary`` (per notebook, per cell), this is a single
    global row -- there is one AI configuration for the whole extension,
    not one per notebook.
    """

    api_key: str | None
    model: str
    custom_model: str | None
    detect_stale_cells: bool
    detect_duplicate_cells: bool
    detect_dead_cells: bool
    created_at: str
    updated_at: str

    @property
    def resolved_model(self) -> str:
        """Return the model name that should actually be sent to the LLM.

        When the dropdown is set to the sentinel ``"other"`` value, the
        free-text ``custom_model`` field is what the user actually wants;
        otherwise the dropdown value itself is already a real model name.
        """
        if self.model == "other":
            return self.custom_model or DEFAULT_MODEL
        return self.model


class SettingsStore(Protocol):
    """Persistence interface for global AI settings."""

    def get_settings(self) -> AiSettings:
        """Return the current settings, seeding defaults if none exist."""

    def save_settings(
        self,
        *,
        api_key: str | None,
        model: str,
        custom_model: str | None,
        detect_stale_cells: bool,
        detect_duplicate_cells: bool,
        detect_dead_cells: bool,
    ) -> AiSettings:
        """Persist settings.

        ``api_key`` of ``None`` means "leave the stored key unchanged" --
        the Save action only ever touches the key when the user actually
        typed a new one, never implicitly clears it. Clearing the key is
        only ever done through ``reset_settings``.
        """

    def reset_settings(self) -> AiSettings:
        """Restore every setting to its default, deleting the stored key."""
