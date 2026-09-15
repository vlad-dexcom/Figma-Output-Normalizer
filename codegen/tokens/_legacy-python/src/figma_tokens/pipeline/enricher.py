"""Enriches resolved tokens with cross-layer alias references via value-matching."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Set

from ..figma.models import (
    FigmaCollection,
    FigmaColorValue,
    FigmaVariable,
    ResolvedToken,
    TokenType,
)
from .resolver import TokenResolver

LogFn = Callable[[str], None]


@dataclass
class EnrichmentResult:
    tokens: List[ResolvedToken]
    intra_collection_matched: int
    intra_collection_unmatched: int
    primitive_matched: int
    primitive_total: int


class TokenEnricher:
    """Enriches tokens with inferred alias paths by value-matching.

    Layer detection is structural:
      - "varying" tokens have different values across modes → candidates for primitive aliases
      - "invariant" unaliased tokens → candidates for intra-collection alias matching
    """

    def __init__(self, info: LogFn, warn: LogFn):
        self._info = info
        self._warn = warn

    def enrich(
        self,
        tokens: List[ResolvedToken],
        variables: Dict[str, FigmaVariable],
        collections: Dict[str, FigmaCollection],
        palette_names: List[str],
        resolver: TokenResolver,
    ) -> EnrichmentResult:
        primitive_color_index = self._build_primitive_color_index(
            resolver, variables, collections, palette_names
        )

        mode_names = list(tokens[0].values.keys()) if tokens else []

        # Identify tokens that vary across modes
        varying_paths: Set[str] = set()
        for token in tokens:
            if token.type == TokenType.COLOR and self._is_varying(token, mode_names):
                varying_paths.add(token.path)

        varying_index = self._build_varying_value_index(tokens, mode_names, varying_paths)

        # Phase 1: match non-varying, unaliased color tokens against varying ones
        enriched_tokens = []
        for token in tokens:
            if token.alias_path is not None or token.type != TokenType.COLOR or token.path in varying_paths:
                enriched_tokens.append(token)
                continue

            values = [token.values.get(m) for m in mode_names]
            if len(values) < 2 or values[0] is None or values[1] is None:
                enriched_tokens.append(token)
                continue

            key = (token.type, self._value_key(values[0]), self._value_key(values[1]))
            candidates = varying_index.get(key)
            if candidates:
                own_branch = token.path.split("/")[0]
                cross_branch = [c for c in candidates if c.split("/")[0] != own_branch]
                best_candidates = cross_branch if cross_branch else candidates
                enriched_tokens.append(ResolvedToken(
                    path=token.path, type=token.type, values=token.values,
                    alias_path=self._best_match(token.path, best_candidates),
                    alias_by_mode=token.alias_by_mode,
                    description=token.description,
                ))
            else:
                enriched_tokens.append(token)

        intra_matched = sum(
            1 for t in enriched_tokens
            if t.type == TokenType.COLOR and t.alias_path and t.path not in varying_paths
        )
        intra_unmatched = sum(
            1 for t in enriched_tokens
            if t.type == TokenType.COLOR and not t.alias_path and t.path not in varying_paths
        )

        # Phase 2: match varying tokens against primitives (per-mode aliases)
        if primitive_color_index:
            final_tokens = []
            for token in enriched_tokens:
                if token.type != TokenType.COLOR or token.path not in varying_paths:
                    final_tokens.append(token)
                    continue

                mode_aliases: Dict[str, str] = dict(token.alias_by_mode or {})
                for mode_name, value in token.values.items():
                    # An alias the resolver read straight from Figma is ground truth —
                    # never let value matching override it.
                    if mode_name in mode_aliases:
                        continue
                    vk = self._value_key(value)
                    candidates = primitive_color_index.get(vk)
                    if candidates:
                        filtered = [c for c in candidates if c != token.path]
                        own_branch = token.path.split("/")[0]
                        cross = [c for c in filtered if c.split("/")[0] != own_branch]
                        best = cross if cross else filtered
                        if best:
                            mode_aliases[mode_name] = self._best_match(token.path, best)

                if mode_aliases:
                    final_tokens.append(ResolvedToken(
                        path=token.path, type=token.type, values=token.values,
                        alias_path=token.alias_path, alias_by_mode=mode_aliases,
                        alias_source=token.alias_source,
                        description=token.description,
                    ))
                else:
                    final_tokens.append(token)
        else:
            final_tokens = enriched_tokens

        # Phase 3: match non-varying unaliased tokens against primitives
        if primitive_color_index:
            phase3_tokens = []
            for token in final_tokens:
                if token.type != TokenType.COLOR or token.alias_path is not None or token.path in varying_paths:
                    phase3_tokens.append(token)
                    continue
                value = next(iter(token.values.values()), None)
                if value is None:
                    phase3_tokens.append(token)
                    continue
                vk = self._value_key(value)
                candidates = primitive_color_index.get(vk)
                if candidates:
                    filtered = [c for c in candidates if c != token.path]
                    own_branch = token.path.split("/")[0]
                    cross = [c for c in filtered if c.split("/")[0] != own_branch]
                    best = cross if cross else filtered
                    if best:
                        phase3_tokens.append(ResolvedToken(
                            path=token.path, type=token.type, values=token.values,
                            alias_path=self._best_match(token.path, best),
                            alias_by_mode=token.alias_by_mode,
                            description=token.description,
                        ))
                        continue
                phase3_tokens.append(token)
            final_tokens = phase3_tokens

        prim_matched = sum(
            1 for t in final_tokens
            if t.path in varying_paths and t.type == TokenType.COLOR and t.alias_by_mode
        )
        prim_total = sum(
            1 for t in final_tokens
            if t.path in varying_paths and t.type == TokenType.COLOR
        )

        return EnrichmentResult(
            tokens=final_tokens,
            intra_collection_matched=intra_matched,
            intra_collection_unmatched=intra_unmatched,
            primitive_matched=prim_matched,
            primitive_total=prim_total,
        )

    @staticmethod
    def _is_varying(token: ResolvedToken, mode_names: List[str]) -> bool:
        values = [token.values.get(m) for m in mode_names]
        if len(values) < 2:
            return False
        return any(v != values[0] for v in values[1:])

    def _value_key(self, value: Any) -> Any:
        if isinstance(value, FigmaColorValue):
            return (value.r, value.g, value.b, value.a)
        if isinstance(value, dict) and "r" in value:
            return (value["r"], value["g"], value["b"], value["a"])
        return value

    def _build_varying_value_index(
        self, tokens: List[ResolvedToken], mode_names: List[str], varying_paths: Set[str]
    ) -> Dict[Any, List[str]]:
        index: Dict[Any, List[str]] = {}
        for token in tokens:
            if token.path not in varying_paths or token.type != TokenType.COLOR:
                continue
            values = [token.values.get(m) for m in mode_names]
            if len(values) >= 2 and values[0] is not None and values[1] is not None:
                key = (token.type, self._value_key(values[0]), self._value_key(values[1]))
                index.setdefault(key, []).append(token.path)
        return index

    def _best_match(self, component_path: str, candidates: List[str]) -> str:
        if len(candidates) == 1:
            return candidates[0]
        comp_segments = set(s.lower() for s in component_path.split("/")[1:])
        return max(
            candidates,
            key=lambda c: len(comp_segments & set(s.lower() for s in c.split("/")[1:])),
        )

    def _build_primitive_color_index(
        self,
        resolver: TokenResolver,
        variables: Dict[str, FigmaVariable],
        collections: Dict[str, FigmaCollection],
        palette_names: List[str],
    ) -> Dict[Any, List[str]]:
        if not palette_names:
            return {}
        index: Dict[Any, List[str]] = {}
        for palette_name in palette_names:
            # Only index single-mode collections (true primitives)
            coll_candidates = [c for c in collections.values() if c.name == palette_name]
            if coll_candidates and len(coll_candidates[0].modes) > 1:
                continue
            try:
                palette_tokens = resolver.resolve(variables, collections, palette_name)
            except Exception:
                continue
            for token in palette_tokens:
                if token.type != TokenType.COLOR or token.alias_path or token.alias_by_mode:
                    continue
                value = next(iter(token.values.values()), None)
                if value is None:
                    continue
                vk = self._value_key(value)
                index.setdefault(vk, []).append(token.path)
        return index
