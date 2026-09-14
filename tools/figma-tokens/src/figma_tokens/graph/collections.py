"""Collection classification and dependency graph — fully structural, zero hardcoded names."""
from __future__ import annotations

from typing import Dict, FrozenSet, List, Set, Tuple

from ..figma.models import BranchDependency, CollectionMeta, FigmaCollection, ResolvedToken
from ..codegen.base import to_folder_name, to_pascal_case
from ..pipeline.enricher import EnrichmentResult


def classify_collections(
    collections: Dict[str, FigmaCollection],
    resolved: Dict[str, EnrichmentResult],
    package: str,
    prefix: str,
) -> Dict[str, CollectionMeta]:
    """Infer collection roles structurally and build metadata map.

    Rules (zero hardcoded names):
    - Single-mode + no external deps → primitive
    - Multi-mode, structurally identical token trees → product group
      - Group member with most tokens → semantic (base)
      - Others → product (flavor)
    - Collections with ≥2 upstream collection deps (not in product group) → leaf
    - Everything else → semantic
    """
    # Step 1: Build basic metadata with full token paths for structural comparison
    metas: Dict[str, CollectionMeta] = {}
    for name, enriched in resolved.items():
        branches: Set[str] = set()
        modes: Set[str] = set()
        token_paths: List[str] = []
        for tok in enriched.tokens:
            branches.add(tok.path.split("/")[0])
            for mn in tok.values:
                modes.add(mn)
            token_paths.append(tok.path)

        folder = to_folder_name(name)
        root_class = f"{prefix}{to_pascal_case(name)}"
        pkg = f"{package}.{folder}"

        # Compute external dependency branches (flat, for legacy compat)
        ext_deps: List[str] = []
        for tok in enriched.tokens:
            if tok.alias_by_mode:
                for v in tok.alias_by_mode.values():
                    d = v.split("/")[0]
                    if d not in branches and d not in ext_deps:
                        ext_deps.append(d)
            if tok.alias_path:
                d = tok.alias_path.split("/")[0]
                if d not in branches and d not in ext_deps:
                    ext_deps.append(d)

        metas[name] = CollectionMeta(
            name=name,
            root_class=root_class,
            package=pkg,
            folder=folder,
            branches=sorted(branches),
            modes=sorted(modes),
            ext_deps=sorted(ext_deps),
            token_paths=sorted(token_paths),
        )

    # Step 2: Classify primitives — single-mode AND no external deps
    coll_mode_counts = {c.name: len(c.modes) for c in collections.values()}
    for name, meta in metas.items():
        if coll_mode_counts.get(name, 0) <= 1 and not meta.ext_deps:
            meta.role = "primitive"

    # Step 3: Detect product groups using FULL structural comparison
    # Two collections are structurally compatible if they share the same
    # normalized token path set (paths within each branch, ignoring the branch prefix)
    branch_set_groups: Dict[FrozenSet[str], List[str]] = {}
    for name, meta in metas.items():
        if meta.role == "primitive":
            continue
        key = frozenset(meta.branches)
        branch_set_groups.setdefault(key, []).append(name)

    product_groups: Dict[FrozenSet[str], List[str]] = {}
    for branch_set, candidates in branch_set_groups.items():
        if len(candidates) < 2:
            continue
        # Further validate: check structural compatibility (normalized paths match)
        groups = _group_by_structure(candidates, metas)
        for group in groups:
            if len(group) >= 2:
                product_groups[frozenset(group)] = sorted(group)

    # In each product group, pick the base structurally: most tokens = most complete
    for group_key, group_colls in product_groups.items():
        base_name = max(group_colls, key=lambda cn: len(metas[cn].token_paths))
        metas[base_name].role = "semantic"
        for cn in group_colls:
            if cn != base_name:
                metas[cn].role = "product"
                metas[cn].base_collection = base_name

    # Step 4: Remaining unclassified → semantic
    for name, meta in metas.items():
        if not meta.role:
            meta.role = "semantic"

    # Step 5: Build provenance-aware dependency edges
    _build_dep_edges(metas, resolved)

    return metas


def _group_by_structure(
    candidates: List[str], metas: Dict[str, CollectionMeta]
) -> List[List[str]]:
    """Group candidates by structural compatibility.

    Two collections are structurally compatible if their normalized path sets
    (paths with top-level branch prefix stripped) have high overlap (≥90%).
    """
    def _normalize_paths(name: str) -> Set[str]:
        """Strip top-level branch from each path to get intra-branch structure."""
        result: Set[str] = set()
        for p in metas[name].token_paths:
            parts = p.split("/", 1)
            if len(parts) > 1:
                result.add(parts[1])
            else:
                result.add(p)
        return result

    # Simple greedy grouping: first candidate starts a group, others join if ≥90% overlap
    groups: List[List[str]] = []
    remaining = list(candidates)

    while remaining:
        leader = remaining.pop(0)
        leader_paths = _normalize_paths(leader)
        group = [leader]

        still_remaining = []
        for c in remaining:
            c_paths = _normalize_paths(c)
            if not leader_paths or not c_paths:
                still_remaining.append(c)
                continue
            # Overlap ratio
            overlap = len(leader_paths & c_paths)
            smaller = min(len(leader_paths), len(c_paths))
            if smaller > 0 and overlap / smaller >= 0.9:
                group.append(c)
            else:
                still_remaining.append(c)
        groups.append(group)
        remaining = still_remaining

    return groups


def _build_dep_edges(
    metas: Dict[str, CollectionMeta],
    resolved: Dict[str, EnrichmentResult],
) -> None:
    """Build provenance-aware dependency edges: (source_coll, source_branch) → (target_coll, target_branch).

    For each alias reference, determine which collection OWNS the target branch
    using the branch→owner lookup.
    """
    # Build branch → owning collection lookup (prefer semantic bases over products)
    branch_owners: Dict[str, str] = {}
    # First pass: all collections
    for name, meta in sorted(metas.items()):
        for branch in meta.branches:
            branch_owners[branch] = name
    # Second pass: semantic bases override (canonical owners)
    for name, meta in sorted(metas.items()):
        if meta.role == "semantic":
            for branch in meta.branches:
                branch_owners[branch] = name
    # Third pass: product group bases override their products
    for name, meta in sorted(metas.items()):
        if meta.base_collection:
            base_meta = metas[meta.base_collection]
            for branch in base_meta.branches:
                branch_owners[branch] = meta.base_collection

    # Build edges
    for name, enriched in resolved.items():
        meta = metas[name]
        own_branches = set(meta.branches)
        seen_edges: Set[Tuple[str, str, str, str]] = set()

        for tok in enriched.tokens:
            source_branch = tok.path.split("/")[0]

            def _add_edge(target_path: str) -> None:
                target_branch = target_path.split("/")[0]
                if target_branch in own_branches:
                    return
                target_coll = branch_owners.get(target_branch)
                if target_coll and target_coll != name:
                    edge_key = (name, source_branch, target_coll, target_branch)
                    if edge_key not in seen_edges:
                        seen_edges.add(edge_key)
                        meta.dep_edges.append(BranchDependency(
                            source_collection=name,
                            source_branch=source_branch,
                            target_collection=target_coll,
                            target_branch=target_branch,
                        ))

            if tok.alias_path:
                _add_edge(tok.alias_path)
            if tok.alias_by_mode:
                for v in tok.alias_by_mode.values():
                    _add_edge(v)


def build_dependency_graph(
    metas: Dict[str, CollectionMeta],
) -> Dict[str, Set[str]]:
    """Build collection-level dependency graph from provenance edges."""
    coll_deps: Dict[str, Set[str]] = {name: set() for name in metas}
    for name, meta in metas.items():
        for edge in meta.dep_edges:
            coll_deps[name].add(edge.target_collection)
    return coll_deps


def detect_leaves(
    metas: Dict[str, CollectionMeta],
    coll_deps: Dict[str, Set[str]],
) -> List[str]:
    """Leaf collections have ≥2 upstream deps AND are not part of a product group."""
    product_group_bases = {m.base_collection for m in metas.values() if m.base_collection}

    leaves = []
    for name, deps in coll_deps.items():
        if len(deps) < 2:
            continue
        if metas[name].role == "product":
            continue
        if name in product_group_bases:
            continue
        leaves.append(name)
        metas[name].role = "leaf"
    return sorted(leaves)


def detect_circular_deps(
    metas: Dict[str, CollectionMeta],
    resolved: Dict[str, EnrichmentResult],
) -> Dict[str, Set[str]]:
    """Detect circular branch dependencies within each collection."""
    circular_deps: Dict[str, Set[str]] = {}
    for name, enriched in resolved.items():
        coll_branches = {tok.path.split("/")[0] for tok in enriched.tokens}
        branch_deps: Dict[str, Set[str]] = {b: set() for b in coll_branches}
        for tok in enriched.tokens:
            branch = tok.path.split("/")[0]
            if tok.alias_by_mode:
                for v in tok.alias_by_mode.values():
                    dep = v.split("/")[0]
                    if dep != branch and dep in coll_branches:
                        branch_deps[branch].add(dep)
            if tok.alias_path:
                dep = tok.alias_path.split("/")[0]
                if dep != branch and dep in coll_branches:
                    branch_deps[branch].add(dep)
        for branch, deps in branch_deps.items():
            circ: Set[str] = set()
            for dep in deps:
                if dep in branch_deps and branch in branch_deps[dep]:
                    circ.add(dep)
            if circ:
                circular_deps.setdefault(branch, set()).update(circ)
    return circular_deps


def build_branch_maps(
    metas: Dict[str, CollectionMeta],
) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Build canonical branch→package and branch→root_class maps.

    Uses provenance: for each branch, the canonical owner is determined by role priority:
    1. Product group base (semantic) owns shared branches
    2. Other semantic collections
    3. Primitives/leaves as fallback
    """
    branch_pkg_map: Dict[str, str] = {}
    branch_root_map: Dict[str, str] = {}

    # Role priority for branch ownership: higher = wins
    role_priority = {"primitive": 0, "leaf": 1, "product": 2, "semantic": 3}

    # Collect all (branch, collection) pairs with priorities
    branch_candidates: Dict[str, List[Tuple[int, str]]] = {}
    for name, meta in metas.items():
        prio = role_priority.get(meta.role, 0)
        # Product group bases get highest priority for their branches
        if meta.role == "semantic" and any(
            m.base_collection == name for m in metas.values()
        ):
            prio = 4  # highest: product group base
        for branch in meta.branches:
            branch_candidates.setdefault(branch, []).append((prio, name))

    # Pick the highest-priority owner for each branch
    for branch, candidates in branch_candidates.items():
        candidates.sort(reverse=True)
        _, owner = candidates[0]
        owner_meta = metas[owner]
        branch_folder = to_folder_name(branch)
        branch_pkg_map[branch] = f"{owner_meta.package}.{branch_folder}"
        branch_root_map[branch] = owner_meta.root_class

    return branch_pkg_map, branch_root_map


def find_product_groups(
    metas: Dict[str, CollectionMeta],
) -> Dict[FrozenSet[str], List[str]]:
    """Find product groups (collections that share structural compatibility)."""
    groups: Dict[FrozenSet[str], List[str]] = {}
    for name, meta in metas.items():
        if meta.role == "product" and meta.base_collection:
            key = frozenset([meta.base_collection, name])
            existing = None
            for k in groups:
                if meta.base_collection in k or name in k:
                    existing = k
                    break
            if existing:
                new_set = set(groups[existing])
                new_set.add(name)
                new_set.add(meta.base_collection)
                del groups[existing]
                groups[frozenset(new_set)] = sorted(new_set)
            else:
                groups[frozenset([meta.base_collection, name])] = sorted(
                    [meta.base_collection, name]
                )
    return groups
