"""Endpoint tests for the global AI settings routes.

Covers GET /settings, POST /settings, and POST /settings/reset -- the
backend half of the AI Settings panel feature.
"""

from __future__ import annotations

from backend.src.app.settings_store.base import DEFAULT_MODEL

from .app_test_utils import AppTestCase


class TestGetAiSettings(AppTestCase):
    """GET /settings."""

    def test_defaults_are_returned_and_key_is_never_exposed(self):
        """A fresh store returns defaults; has_api_key, not the raw key."""
        response = self.client.get("/settings")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["has_api_key"])
        self.assertEqual(body["model"], DEFAULT_MODEL)
        self.assertIsNone(body["custom_model"])
        self.assertTrue(body["detect_stale_cells"])
        self.assertTrue(body["detect_duplicate_cells"])
        self.assertTrue(body["detect_dead_cells"])
        self.assertNotIn("api_key", body)

    def test_saved_key_is_reported_but_never_returned_raw(self):
        """Once a key is saved, has_api_key flips true but stays opaque."""
        self.settings_store.save_settings(
            api_key="super-secret",
            model=DEFAULT_MODEL,
            custom_model=None,
            detect_stale_cells=True,
            detect_duplicate_cells=True,
            detect_dead_cells=True,
        )

        response = self.client.get("/settings")

        body = response.json()
        self.assertTrue(body["has_api_key"])
        self.assertNotIn("api_key", body)
        self.assertNotIn("super-secret", response.text)


class TestSaveAiSettings(AppTestCase):
    """POST /settings."""

    def _payload(self, **overrides):
        payload = {
            "api_key": None,
            "model": DEFAULT_MODEL,
            "custom_model": None,
            "detect_stale_cells": True,
            "detect_duplicate_cells": True,
            "detect_dead_cells": True,
        }
        payload.update(overrides)
        return payload

    def test_first_save_with_a_new_key_flags_api_key_changed(self):
        """Providing a key for the first time must set api_key_changed."""
        response = self.client.post(
            "/settings", json=self._payload(api_key="new-key")
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["api_key_changed"])
        self.assertTrue(body["settings"]["has_api_key"])

    def test_saving_the_same_key_again_does_not_flag_a_change(self):
        """Re-submitting an unchanged key must not trigger a reindex."""
        self.client.post("/settings", json=self._payload(api_key="same-key"))

        response = self.client.post(
            "/settings", json=self._payload(api_key="same-key")
        )

        self.assertFalse(response.json()["api_key_changed"])

    def test_changing_the_key_flags_api_key_changed(self):
        """Swapping to a different key must trigger a reindex flag."""
        self.client.post("/settings", json=self._payload(api_key="key-one"))

        response = self.client.post(
            "/settings", json=self._payload(api_key="key-two")
        )

        self.assertTrue(response.json()["api_key_changed"])

    def test_model_only_change_does_not_flag_api_key_changed(self):
        """Changing only the model must never trigger a reindex flag."""
        self.client.post("/settings", json=self._payload(api_key="key-one"))

        response = self.client.post(
            "/settings",
            json=self._payload(api_key=None, model="gemini-1.5-flash"),
        )

        body = response.json()
        self.assertFalse(body["api_key_changed"])
        self.assertEqual(body["settings"]["model"], "gemini-1.5-flash")
        # The previously-saved key must still be considered present.
        self.assertTrue(body["settings"]["has_api_key"])

    def test_checkbox_only_change_does_not_flag_api_key_changed(self):
        """Changing only an analysis checkbox must never trigger a reindex."""
        self.client.post("/settings", json=self._payload(api_key="key-one"))

        response = self.client.post(
            "/settings",
            json=self._payload(api_key=None, detect_dead_cells=False),
        )

        body = response.json()
        self.assertFalse(body["api_key_changed"])
        self.assertFalse(body["settings"]["detect_dead_cells"])

    def test_omitting_api_key_leaves_stored_key_untouched(self):
        """A save with no api_key field must not clear a previously saved key."""
        self.client.post("/settings", json=self._payload(api_key="key-one"))

        response = self.client.post("/settings", json=self._payload())

        self.assertTrue(response.json()["settings"]["has_api_key"])

    def test_custom_model_is_saved_when_model_is_other(self):
        """The free-text custom model name persists alongside "other"."""
        response = self.client.post(
            "/settings",
            json=self._payload(model="other", custom_model="my-model"),
        )

        body = response.json()["settings"]
        self.assertEqual(body["model"], "other")
        self.assertEqual(body["custom_model"], "my-model")


class TestResetAiSettings(AppTestCase):
    """POST /settings/reset."""

    def test_reset_clears_key_and_restores_defaults(self):
        """Reset must delete the key and restore every default."""
        self.client.post(
            "/settings",
            json={
                "api_key": "secret",
                "model": "other",
                "custom_model": "my-model",
                "detect_stale_cells": False,
                "detect_duplicate_cells": False,
                "detect_dead_cells": False,
            },
        )

        response = self.client.post("/settings/reset")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["has_api_key"])
        self.assertEqual(body["model"], DEFAULT_MODEL)
        self.assertIsNone(body["custom_model"])
        self.assertTrue(body["detect_stale_cells"])
        self.assertTrue(body["detect_duplicate_cells"])
        self.assertTrue(body["detect_dead_cells"])

    def test_reset_is_reflected_by_a_subsequent_get(self):
        """The reset must actually persist, not just echo defaults back."""
        self.client.post(
            "/settings",
            json={
                "api_key": "secret",
                "model": DEFAULT_MODEL,
                "custom_model": None,
                "detect_stale_cells": True,
                "detect_duplicate_cells": True,
                "detect_dead_cells": True,
            },
        )
        self.client.post("/settings/reset")

        response = self.client.get("/settings")

        self.assertFalse(response.json()["has_api_key"])
