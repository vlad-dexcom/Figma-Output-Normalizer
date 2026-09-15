"""Intermediate JSON representation of the resolved token tree.

This module serializes the fully-resolved, classified token data into a
platform-independent JSON format. This intermediate representation:

1. Decouples Figma fetching/parsing from code generation
2. Enables debugging (inspect the JSON to verify correctness)
3. Ensures identical structure for both Kotlin and Swift generators
4. Supports caching (skip Figma fetch if JSON is fresh)
5. Makes snapshot testing trivial (compare JSON, not generated code)

Schema (v1):
{
  "schema_version": 1,
  "figma_file_key": "...",
  "collections": {
    "<name>": {
      "role": "primitive|semantic|product|leaf",
      "modes": ["Mode1", "Mode2"],
      "branches": ["branch1", "branch2"],
      "ext_deps": ["dep_branch1"],
      "base_collection": null | "<name>",
      "tokens": [
        {
          "path": "color/border/strong",
          "type": "COLOR|FLOAT|STRING",
          "values": {"Mode1": <value>, "Mode2": <value>},
          "alias_path": null | "palette/blue/500"
        }
      ]
    }
  },
  "graph": {
    "dependencies": {"<coll>": ["<dep1>", "<dep2>"]},
    "leaves": ["<coll>"],
    "product_groups": [{"base": "<coll>", "products": ["<coll1>", "<coll2>"]}],
    "branch_owners": {"<branch>": "<coll>"}
  },
  "builders": [
    {
      "leaf": "<coll>",
      "product": "<coll>" | null,
      "chain": ["<dep1>", "<dep2>"],
      "theme_modes": [["mode_label", "mode_id"], ...]
    }
  ]
}
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Dict, List, Optional, Set, Tuple

from ..figma.models import (
    CollectionMeta,
    FigmaColorValue,
    ResolvedToken,
    TokenType,
)
from ..pipeline.enricher import EnrichmentResult


SCHEMA_VERSION = 1


def _serialize_value(val: Any) -> Any:
    """Convert a token value to a JSON-serializable form."""
    if isinstance(val, FigmaColorValue):
        return {"type": "COLOR", "r": val.r, "g": val.g, "b": val.b, "a": val.a}
    elif isinstance(val, (int, float)):
        return {"type": "FLOAT", "value": val}
    elif isinstance(val, str):
        return {"type": "STRING", "value": val}
    elif isinstance(val, dict):
        return val
    return str(val)


def _serialize_token(tok: ResolvedToken) -> Dict[str, Any]:
    """Serialize a single ResolvedToken."""
    values = {}
    for mode_name, val in tok.values.items():
        values[mode_name] = _serialize_value(val)

    result = {
        "path": tok.path,
        "type": tok.type.value if isinstance(tok.type, TokenType) else str(tok.type),
        "values": values,
        "alias_path": tok.alias_path,
    }
    if tok.alias_by_mode:
        result["alias_by_mode"] = dict(tok.alias_by_mode)
    if tok.alias_source:
        result["alias_source"] = tok.alias_source
    if tok.description:
        result["description"] = tok.description
    return result


def _build_token_tree(tokens: List[ResolvedToken]) -> Dict[str, Any]:
    """Build a nested tree from flat token paths — mirrors the generated class hierarchy.

    Each intermediate node = a nested data class/struct.
    Each leaf node = a property with type and optional alias reference.

    Example output:
    {
      "buttons": {
        "_children": {
          "color": {
            "_children": {
              "border": {
                "_children": {
                  "tertiary": {
                    "_children": {
                      "default": {"_type": "COLOR", "_alias": "color/border/strong/default"}
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    """
    tree: Dict[str, Any] = {}

    for tok in tokens:
        parts = tok.path.split("/")
        node = tree
        for i, part in enumerate(parts):
            is_leaf_part = (i == len(parts) - 1)
            if is_leaf_part:
                # Leaf: store type + alias (no values — those stay in flat tokens)
                entry: Dict[str, Any] = {
                    "_type": tok.type.value if isinstance(tok.type, TokenType) else str(tok.type),
                }
                if tok.alias_path:
                    entry["_ref"] = tok.alias_path
                if tok.description:
                    entry["_doc"] = tok.description
                node[part] = entry
            else:
                # Intermediate: create nested dict
                if part not in node:
                    node[part] = {}
                elif isinstance(node[part], dict) and "_type" in node[part]:
                    # Conflict: path is both a leaf and a parent (rare)
                    node[part] = {"_self": node[part]}
                node = node[part]

    return tree


def _build_tree(
    metas: Dict[str, CollectionMeta],
    resolved_collections: Dict[str, EnrichmentResult],
    product_groups: List[Dict[str, Any]],
    leaves: List[str],
) -> List[Dict[str, Any]]:
    """Build a Figma-like tree view of collections.

    Returns a list matching the visual hierarchy:
    - Leaf collections (bold/highlighted)
    - Product group bases with nested variants
    - Standalone collections
    - Primitives
    """
    # Find which collections are product variants (nested under base)
    variant_names: Set[str] = set()
    pg_map: Dict[str, List[str]] = {}
    for pg in product_groups:
        pg_map[pg["base"]] = pg["products"]
        for p in pg["products"]:
            variant_names.add(p)

    tree: List[Dict[str, Any]] = []

    # Order: leaf first, then product-group bases, then semantics, then primitives
    sorted_names = sorted(metas.keys())

    # Leaves
    for name in sorted_names:
        if name in leaves:
            tree.append({
                "name": name,
                "count": len(resolved_collections.get(name, EnrichmentResult([], 0, 0, 0, 0)).tokens),
                "role": "leaf",
            })

    # Product group bases (with variants nested)
    for name in sorted_names:
        if name in pg_map:
            variants = []
            for v in sorted(pg_map[name]):
                variants.append({
                    "name": v,
                    "count": len(resolved_collections.get(v, EnrichmentResult([], 0, 0, 0, 0)).tokens),
                })
            tree.append({
                "name": name,
                "count": len(resolved_collections.get(name, EnrichmentResult([], 0, 0, 0, 0)).tokens),
                "role": "semantic",
                "variants": variants,
            })

    # Remaining semantics (not base of a product group, not leaf)
    for name in sorted_names:
        meta = metas[name]
        if meta.role == "semantic" and name not in pg_map and name not in leaves:
            tree.append({
                "name": name,
                "count": len(resolved_collections.get(name, EnrichmentResult([], 0, 0, 0, 0)).tokens),
                "role": "semantic",
            })

    # Primitives
    for name in sorted_names:
        meta = metas[name]
        if meta.role == "primitive":
            tree.append({
                "name": name,
                "count": len(resolved_collections.get(name, EnrichmentResult([], 0, 0, 0, 0)).tokens),
                "role": "primitive",
            })

    return tree


def build_intermediate_json(
    file_key: str,
    resolved_collections: Dict[str, EnrichmentResult],
    metas: Dict[str, CollectionMeta],
    coll_deps: Dict[str, Set[str]],
    leaves: List[str],
    product_groups: Dict[Any, List[str]],
    branch_pkg_map: Dict[str, str],
    builder_specs: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build the complete intermediate JSON structure.

    Args:
        file_key: Figma file key
        resolved_collections: enriched token data per collection
        metas: classified collection metadata
        coll_deps: dependency graph {coll: {dep1, dep2}}
        leaves: leaf collection names
        product_groups: {base: [products]}
        branch_pkg_map: {branch: owner_package}
        builder_specs: precomputed builder chain info

    Returns:
        Complete JSON-serializable dict
    """
    # Collections
    collections_json: Dict[str, Any] = {}
    for name, enriched in resolved_collections.items():
        meta = metas[name]
        # Build nested token tree (mirrors generated class hierarchy)
        token_tree = _build_token_tree(enriched.tokens)
        collections_json[name] = {
            "role": meta.role,
            "modes": list(meta.modes),
            "branches": list(meta.branches),
            "ext_deps": list(meta.ext_deps),
            "base_collection": meta.base_collection,
            "root_class": meta.root_class,
            "package": meta.package,
            "folder": meta.folder,
            "shared_factory": meta.shared_factory,
            "factory_fn_prefix": meta.factory_fn_prefix,
            "token_tree": token_tree,
            "tokens": [_serialize_token(t) for t in enriched.tokens],
        }

    # Graph
    # Infer branch owners from branch_pkg_map (reverse lookup: pkg → coll name)
    branch_owners: Dict[str, str] = {}
    for branch, pkg in branch_pkg_map.items():
        # Find which collection owns this package
        for cname, m in metas.items():
            if pkg.startswith(m.package):
                branch_owners[branch] = cname
                break

    pg_list = []
    for base_key, products in product_groups.items():
        # base_key is a frozenset — find the semantic (base) member
        base_name = next((p for p in products if p in metas and metas[p].role == "semantic"), products[0])
        non_base = [p for p in products if p != base_name]
        pg_list.append({"base": base_name, "products": non_base})

    graph_json = {
        "dependencies": {k: sorted(v) for k, v in coll_deps.items()},
        "leaves": sorted(leaves),
        "product_groups": pg_list,
        "branch_owners": branch_owners,
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "figma_file_key": file_key,
        "tree": _build_tree(metas, resolved_collections, pg_list, leaves),
        "collections": collections_json,
        "graph": graph_json,
        "builders": builder_specs,
    }


def save_intermediate_json(data: Dict[str, Any], path: str) -> None:
    """Write intermediate JSON to disk."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_intermediate_json(path: str) -> Dict[str, Any]:
    """Load intermediate JSON from disk."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
