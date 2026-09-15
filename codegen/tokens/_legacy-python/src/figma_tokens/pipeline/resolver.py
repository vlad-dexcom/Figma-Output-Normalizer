"""Resolves Figma variables in a collection to concrete values for all modes."""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ..figma.models import (
    FigmaCollection,
    FigmaVariable,
    ResolvedToken,
    TokenType,
)

LogFn = Callable[[str], None]


class TokenResolver:
    """Resolves all variables in a collection to concrete values."""

    def __init__(self, info: LogFn, warn: LogFn):
        self._info = info
        self._warn = warn

    def resolve(
        self,
        variables: Dict[str, FigmaVariable],
        collections: Dict[str, FigmaCollection],
        collection_name: str,
    ) -> List[ResolvedToken]:
        """Resolve all tokens in the named collection."""
        candidates = [c for c in collections.values() if c.name == collection_name]
        if not candidates:
            available = sorted(f"{c.name} ({len(c.variable_ids)})" for c in collections.values())
            raise ValueError(f"Collection '{collection_name}' not found. Available: {available}")
        target_coll = max(candidates, key=lambda c: len(c.variable_ids))

        self._info(f"Resolving '{target_coll.name}' — {len(target_coll.variable_ids)} variables, "
                   f"modes: {[m.name for m in target_coll.modes]}")

        type_map = {
            "COLOR": TokenType.COLOR,
            "FLOAT": TokenType.FLOAT,
            "STRING": TokenType.STRING,
            "BOOLEAN": TokenType.BOOLEAN,
        }

        resolved: List[ResolvedToken] = []
        unresolved: List[str] = []

        for var_id in target_coll.variable_ids:
            variable = variables.get(var_id)
            if variable is None:
                unresolved.append(f"Variable ID {var_id} not found")
                continue

            token_type = type_map.get(variable.resolved_type)
            if token_type is None:
                continue

            mode_values: Dict[str, Any] = {}
            has_failure = False
            alias_paths: List[Optional[str]] = []
            alias_sources: List[Optional[str]] = []

            for mode in target_coll.modes:
                raw_value = variable.values_by_mode.get(mode.mode_id)
                if raw_value is None:
                    # Try owner collection fallback
                    owner_coll = collections.get(variable.collection_id)
                    if owner_coll and owner_coll.id != target_coll.id:
                        owner_mode = next(
                            (m for m in owner_coll.modes if m.name == mode.name),
                            owner_coll.modes[0] if owner_coll.modes else None,
                        )
                        owner_value = (
                            variable.values_by_mode.get(owner_mode.mode_id)
                            if owner_mode
                            else next(iter(variable.values_by_mode.values()), None)
                        )
                        resolved_val = self._resolve_value(
                            owner_value, mode.name, variables, collections, set()
                        )
                        if resolved_val is not None:
                            mode_values[mode.name] = resolved_val
                        else:
                            has_failure = True
                            unresolved.append(f"{variable.name} [{mode.name}]: cannot resolve value")
                    else:
                        has_failure = True
                        unresolved.append(f"{variable.name} [{mode.name}]: no value for mode")
                    alias_paths.append(None)
                    alias_sources.append(None)
                    continue

                ap, asrc = self._find_alias_path(raw_value, variable.name, target_coll.id, variables, collections)
                alias_paths.append(ap)
                alias_sources.append(asrc)
                resolved_val = self._resolve_value(
                    raw_value, mode.name, variables, collections, set()
                )
                if resolved_val is not None:
                    mode_values[mode.name] = resolved_val
                else:
                    has_failure = True
                    unresolved.append(f"{variable.name} [{mode.name}]: cannot resolve alias chain")

            # Keep the alias Figma actually declared for *each* mode. Collapsing to a
            # single alias is only valid when every mode aliases the same target;
            # otherwise a mode holding a literal (or aliasing a different primitive)
            # would silently inherit another mode's alias and emit the wrong colour.
            mode_names = [m.name for m in target_coll.modes]
            alias_by_mode = {
                name: path
                for name, path in zip(mode_names, alias_paths)
                if path is not None
            }
            distinct_paths = set(alias_by_mode.values())
            if len(distinct_paths) == 1 and len(alias_by_mode) == len(mode_names):
                alias_path = next(iter(distinct_paths))
                alias_by_mode = None
            else:
                alias_path = None
            distinct_sources = list(set(s for s in alias_sources if s is not None))
            alias_source = distinct_sources[0] if len(distinct_sources) == 1 else None

            if not has_failure and mode_values:
                resolved.append(
                    ResolvedToken(
                        path=variable.name,
                        type=token_type,
                        values=mode_values,
                        alias_path=alias_path,
                        alias_by_mode=alias_by_mode,
                        alias_source=alias_source,
                        description=variable.description,
                    )
                )

        if unresolved:
            self._warn(f"Skipped {len(unresolved)} unresolved variables")
            for msg in unresolved[:10]:
                self._warn(f"  • {msg}")
            if len(unresolved) > 10:
                self._warn(f"  ... and {len(unresolved) - 10} more")

        self._info(f"Resolved {len(resolved)} tokens across {len(target_coll.modes)} modes")
        return resolved

    def _find_alias_path(
        self, raw_value: Any, own_path: str, own_collection_id: str,
        variables: Dict[str, FigmaVariable],
        collections: Dict[str, FigmaCollection],
    ) -> Tuple[Optional[str], Optional[str]]:
        """Return (alias_path, source_collection_name) or (None, None)."""
        if not isinstance(raw_value, str) or not raw_value.startswith("alias:"):
            return None, None
        target_id = raw_value.removeprefix("alias:")
        target_var = variables.get(target_id)
        if target_var is None:
            return None, None
        # Skip self-references within the same collection and branch
        own_top = own_path.split("/")[0] if "/" in own_path else own_path
        target_top = target_var.name.split("/")[0] if "/" in target_var.name else target_var.name
        if target_top == own_top and target_var.collection_id == own_collection_id:
            return None, None
        # Don't reference a path that is itself a branch (has child variables)
        target_prefix = target_var.name + "/"
        for v in variables.values():
            if v.name.startswith(target_prefix):
                return None, None
        # Determine source collection name
        target_coll = collections.get(target_var.collection_id)
        source_name = target_coll.name if target_coll else None
        return target_var.name, source_name

    def _resolve_value(
        self,
        value: Any,
        target_mode_name: str,
        variables: Dict[str, FigmaVariable],
        collections: Dict[str, FigmaCollection],
        visited: Set[str],
    ) -> Any:
        if value is None:
            return None
        if isinstance(value, str) and value.startswith("alias:"):
            target_id = value.removeprefix("alias:")
            if target_id in visited:
                return None
            visited.add(target_id)

            target_var = variables.get(target_id)
            if target_var is None:
                return None
            target_coll = collections.get(target_var.collection_id)
            if target_coll is None:
                return None

            target_mode = next(
                (m for m in target_coll.modes if m.name == target_mode_name),
                target_coll.modes[0] if target_coll.modes else None,
            )
            if target_mode is None:
                return None

            target_value = target_var.values_by_mode.get(target_mode.mode_id)
            if target_value is None:
                target_value = next(iter(target_var.values_by_mode.values()), None)
            if target_value is None:
                return None

            return self._resolve_value(target_value, target_mode_name, variables, collections, visited)

        return value
