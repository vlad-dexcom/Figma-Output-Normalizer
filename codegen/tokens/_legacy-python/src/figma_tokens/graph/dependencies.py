"""Builder generation — wires collections together into top-level composition functions."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from ..codegen.base import to_camel_case, to_folder_name, to_pascal_case
from ..figma.models import CollectionMeta


def compute_builder_chain(
    leaf: str,
    coll_deps: Dict[str, Set[str]],
    coll_metas: Dict[str, CollectionMeta],
    product_colls: List[str],
    product_coll: str,
) -> List[CollectionMeta]:
    """Compute the topologically sorted build chain for a leaf collection.

    Returns the ordered list of CollectionMeta that must be constructed
    before the leaf can be assembled.
    """
    # Build effective deps for this product
    effective_deps = dict(coll_deps)
    if product_coll:
        leaf_deps_new: Set[str] = set()
        for d in coll_deps.get(leaf, set()):
            if d in product_colls and d != product_coll:
                leaf_deps_new.add(product_coll)
            else:
                leaf_deps_new.add(d)
        effective_deps[leaf] = leaf_deps_new

    # Transitive closure
    all_deps: Set[str] = set()
    visiting: Set[str] = set()

    def _collect(c: str) -> None:
        if c in all_deps or c in visiting:
            return
        visiting.add(c)
        all_deps.add(c)
        for d in effective_deps.get(c, set()):
            _collect(d)
        visiting.discard(c)

    _collect(leaf)

    # Remove the leaf itself from the chain (it's handled separately by the builder generator)
    all_deps.discard(leaf)

    # Topological sort
    chain: List[str] = []
    remaining = set(all_deps)
    for _ in range(len(remaining) ** 2 + 1):
        if not remaining:
            break
        found = False
        for c in sorted(remaining):
            if not ((effective_deps.get(c, set()) & remaining) - {c}):
                chain.append(c)
                remaining.discard(c)
                found = True
                break
        if not found:
            c = sorted(remaining)[0]
            chain.append(c)
            remaining.discard(c)

    # Remove product siblings (keep only target product)
    if product_coll:
        chain = [c for c in chain if c not in product_colls or c == product_coll]

    return [coll_metas[c] for c in chain]


def compute_theme_modes(
    chain: List[str],
    coll_metas: Dict[str, CollectionMeta],
    language: str,
    leaf: str = "",
) -> List[Tuple[str, Dict[str, str]]]:
    """Determine theme mode variants for builder generation.

    Filters out platform-specific modes (ios modes for kotlin, android for swift)
    and returns (mode_name, {collection: mode_to_use}) tuples.
    Includes the leaf collection in the mode map.
    """
    # Platform filter: for kotlin output, exclude "ios" modes; for swift exclude "android"
    platform_filter = "ios" if language == "kotlin" else "android"

    all_colls = list(chain) + ([leaf] if leaf and leaf not in chain else [])

    filtered_modes: Dict[str, List[str]] = {}
    for c in all_colls:
        ms = coll_metas[c].modes
        f = [m for m in ms if platform_filter not in m.lower()]
        filtered_modes[c] = f if f else ms

    # Find collections with multiple filtered modes (theme-varying)
    theme_colls = [(c, filtered_modes[c]) for c in all_colls if len(filtered_modes[c]) > 1]

    if not theme_colls:
        return [("", {c: filtered_modes[c][0] for c in all_colls})]

    # Prefer collections with appearance-based modes (light/dark) over platform modes (android/value)
    _THEME_KEYWORDS = {"light", "dark", "default", "inverted", "night", "day"}

    def _theme_score(modes: List[str]) -> int:
        return sum(1 for m in modes if m.lower() in _THEME_KEYWORDS)

    theme_colls.sort(key=lambda x: _theme_score(x[1]), reverse=True)

    # Use the best theme collection's modes as the variants
    variants = theme_colls[0][1]
    theme_modes: List[Tuple[str, Dict[str, str]]] = []
    for v in variants:
        mm: Dict[str, str] = {}
        for c in all_colls:
            if len(filtered_modes[c]) > 1 and v in filtered_modes[c]:
                mm[c] = v
            else:
                mm[c] = filtered_modes[c][0]
        theme_modes.append((v, mm))

    return theme_modes
