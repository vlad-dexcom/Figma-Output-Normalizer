"""Figma REST API client for fetching variables."""
from __future__ import annotations

import json
import time
from typing import Any, Dict, Tuple

import requests

from .models import FigmaCollection, FigmaColorValue, FigmaMode, FigmaVariable


class FigmaClient:
    """Minimal Figma REST API client for fetching local variables."""

    BASE_URL = "https://api.figma.com/v1"

    def __init__(self, token: str):
        self._session = requests.Session()
        self._session.headers["X-Figma-Token"] = token

    def get_local_variables(
        self, file_key: str
    ) -> Tuple[Dict[str, FigmaVariable], Dict[str, FigmaCollection]]:
        """Fetch all local variables from a Figma file."""
        data = self._get(f"/files/{file_key}/variables/local")
        return self._parse_response(data)

    def get_local_variables_raw(self, file_key: str) -> dict:
        """Fetch raw JSON response."""
        return self._get(f"/files/{file_key}/variables/local")

    def _parse_response(
        self, data: dict
    ) -> Tuple[Dict[str, FigmaVariable], Dict[str, FigmaCollection]]:
        meta = data.get("meta", data)

        collections: Dict[str, FigmaCollection] = {}
        for coll_id, coll_data in meta.get("variableCollections", {}).items():
            modes = [
                FigmaMode(mode_id=m["modeId"], name=m["name"])
                for m in coll_data.get("modes", [])
            ]
            collections[coll_id] = FigmaCollection(
                id=coll_id,
                name=coll_data["name"],
                modes=modes,
                variable_ids=coll_data.get("variableIds", []),
                hidden_from_publishing=coll_data.get("hiddenFromPublishing", False),
            )

        variables: Dict[str, FigmaVariable] = {}
        for var_id, var_data in meta.get("variables", {}).items():
            values_by_mode: Dict[str, Any] = {}
            resolved_type = var_data["resolvedType"]
            for mode_id, value in var_data.get("valuesByMode", {}).items():
                values_by_mode[mode_id] = self._parse_value(value, resolved_type)
            variables[var_id] = FigmaVariable(
                id=var_id,
                name=var_data["name"],
                resolved_type=resolved_type,
                collection_id=var_data["variableCollectionId"],
                values_by_mode=values_by_mode,
                description=(var_data.get("description") or "").strip(),
            )

        return variables, collections

    @staticmethod
    def _parse_value(value: Any, resolved_type: str) -> Any:
        if value is None:
            return None
        if isinstance(value, dict):
            if value.get("type") == "VARIABLE_ALIAS":
                return f"alias:{value['id']}"
            if resolved_type == "COLOR" and "r" in value:
                return FigmaColorValue(
                    r=value["r"], g=value["g"], b=value["b"], a=value["a"]
                )
        if resolved_type == "FLOAT":
            return float(value) if not isinstance(value, dict) else value
        if resolved_type == "BOOLEAN":
            return bool(value) if not isinstance(value, dict) else value
        return value

    def _get(self, endpoint: str, max_retries: int = 3) -> dict:
        last_error: Exception | None = None
        for attempt in range(max_retries):
            try:
                resp = self._session.get(
                    f"{self.BASE_URL}{endpoint}", timeout=(30, 60)
                )
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                last_error = e
                time.sleep((attempt + 1) * 2)
        raise last_error  # type: ignore


def load_local_json(
    path: str,
) -> Tuple[Dict[str, FigmaVariable], Dict[str, FigmaCollection]]:
    """Load variables from a saved JSON file (same format as Figma API response)."""
    with open(path) as f:
        data = json.load(f)
    client = FigmaClient.__new__(FigmaClient)
    return client._parse_response(data)
