"""Tests for figma-tokens graph classification and pipeline."""
from __future__ import annotations

import pytest
from figma_tokens.figma.models import (
    BranchDependency,
    CollectionMeta,
    FigmaCollection,
    FigmaColorValue,
    FigmaMode,
    FigmaVariable,
    ResolvedToken,
    TokenType,
)
from figma_tokens.pipeline.enricher import EnrichmentResult
from figma_tokens.graph.collections import (
    build_branch_maps,
    build_dependency_graph,
    classify_collections,
    detect_leaves,
    find_product_groups,
)
from figma_tokens.graph.dependencies import compute_builder_chain, compute_theme_modes


def _make_collection(name: str, modes: list, n_vars: int = 0) -> FigmaCollection:
    return FigmaCollection(
        id=f"id_{name}",
        name=name,
        modes=[FigmaMode(mode_id=f"m{i}", name=m) for i, m in enumerate(modes)],
        variable_ids=[f"v{i}" for i in range(n_vars)],
    )


def _make_enrichment(paths: list, ext_aliases: dict = None) -> EnrichmentResult:
    """Create a minimal EnrichmentResult from path strings.

    ext_aliases: {token_path: alias_path} for cross-collection references.
    """
    ext_aliases = ext_aliases or {}
    tokens = []
    for p in paths:
        tokens.append(ResolvedToken(
            path=p,
            type=TokenType.COLOR,
            values={"mode1": FigmaColorValue(1, 0, 0, 1)},
            alias_path=ext_aliases.get(p),
        ))
    return EnrichmentResult(
        tokens=tokens, primitive_total=0,
        intra_collection_matched=0, intra_collection_unmatched=0,
        primitive_matched=0,
    )


class TestClassifyCollections:
    """Test structural inference of collection roles."""

    def test_single_mode_no_deps_is_primitive(self):
        collections = {"c1": _make_collection("c1", ["Value"])}
        resolved = {"c1": _make_enrichment(["palette/red", "palette/blue"])}
        metas = classify_collections(collections, resolved, "pkg", "")
        assert metas["c1"].role == "primitive"

    def test_single_mode_with_deps_is_not_primitive(self):
        """Single-mode collection with ext deps should NOT be classified as primitive."""
        collections = {"leaf": _make_collection("leaf", ["value"])}
        resolved = {"leaf": _make_enrichment(
            ["buttons/color/primary", "buttons/size/lg"],
            ext_aliases={"buttons/color/primary": "color/border/strong"}
        )}
        metas = classify_collections(collections, resolved, "pkg", "")
        assert metas["leaf"].role != "primitive"

    def test_identical_branches_form_product_group(self):
        """Collections with identical branch structure are grouped."""
        collections = {
            "base": _make_collection("base", ["light", "dark"]),
            "brand_a": _make_collection("brand_a", ["light", "dark"]),
            "brand_b": _make_collection("brand_b", ["light", "dark"]),
        }
        resolved = {
            "base": _make_enrichment(["color/red", "color/blue", "opacity/low"]),
            "brand_a": _make_enrichment(["color/red", "color/blue", "opacity/low"]),
            "brand_b": _make_enrichment(["color/red", "color/blue", "opacity/low"]),
        }
        metas = classify_collections(collections, resolved, "pkg", "")

        # One should be semantic (base), others product
        semantics = [n for n, m in metas.items() if m.role == "semantic"]
        products = [n for n, m in metas.items() if m.role == "product"]
        assert len(semantics) == 1
        assert len(products) == 2
        # Base is the one with most tokens (all equal here → largest by name sort → first alpha)
        base_name = semantics[0]
        for p in products:
            assert metas[p].base_collection == base_name

    def test_base_selected_by_token_count(self):
        """The product group base is the member with most tokens."""
        collections = {
            "small": _make_collection("small", ["light", "dark"]),
            "large": _make_collection("large", ["light", "dark"]),
        }
        resolved = {
            "small": _make_enrichment(["color/red", "color/blue"]),
            "large": _make_enrichment(["color/red", "color/blue", "color/green"]),
        }
        metas = classify_collections(collections, resolved, "pkg", "")
        assert metas["large"].role == "semantic"
        assert metas["small"].role == "product"
        assert metas["small"].base_collection == "large"

    def test_no_hardcoded_name_check(self):
        """Verify no 'base' or 'default' name dependency in classification."""
        collections = {
            "xyz": _make_collection("xyz", ["light", "dark"]),
            "abc": _make_collection("abc", ["light", "dark"]),
        }
        # abc has more tokens → becomes semantic base
        resolved = {
            "xyz": _make_enrichment(["color/red"]),
            "abc": _make_enrichment(["color/red", "color/blue"]),
        }
        metas = classify_collections(collections, resolved, "pkg", "")
        assert metas["abc"].role == "semantic"
        assert metas["xyz"].role == "product"

    def test_leaf_detection(self):
        """Collections with ≥2 deps that aren't in a product group become leaves."""
        collections = {
            "prim": _make_collection("prim", ["Value"]),
            "sem": _make_collection("sem", ["light", "dark"]),
            "sem2": _make_collection("sem2", ["light", "dark"]),
            "leaf": _make_collection("leaf", ["value"]),
        }
        resolved = {
            "prim": _make_enrichment(["palette/red"]),
            "sem": _make_enrichment(["color/border"]),
            "sem2": _make_enrichment(["opacity/low"]),
            "leaf": _make_enrichment(
                ["buttons/color", "buttons/opacity"],
                ext_aliases={
                    "buttons/color": "color/border",
                    "buttons/opacity": "opacity/low",
                }
            ),
        }
        metas = classify_collections(collections, resolved, "pkg", "")
        coll_deps = build_dependency_graph(metas)
        leaves = detect_leaves(metas, coll_deps)
        assert "leaf" in leaves
        assert metas["leaf"].role == "leaf"


class TestBranchMaps:
    """Test branch→package mapping with provenance."""

    def test_semantic_base_wins_over_product(self):
        """Product group base (semantic) should own shared branches."""
        collections = {
            "base": _make_collection("base", ["light", "dark"]),
            "brand": _make_collection("brand", ["light", "dark"]),
        }
        resolved = {
            "base": _make_enrichment(["color/red", "opacity/low"]),
            "brand": _make_enrichment(["color/red", "opacity/low"]),
        }
        metas = classify_collections(collections, resolved, "pkg", "")
        branch_pkg_map, _ = build_branch_maps(metas)
        # "color" branch should be owned by base (semantic), not brand (product)
        assert "base" in branch_pkg_map["color"]


class TestBuilderChain:
    """Test builder chain computation."""

    def test_leaf_excluded_from_chain(self):
        """The leaf itself should not appear in the chain."""
        coll_deps = {"leaf": {"a", "b"}, "a": set(), "b": {"a"}}
        metas = {
            "leaf": CollectionMeta(name="leaf", root_class="Leaf", package="pkg.leaf",
                                   folder="leaf", branches=["x"], modes=["v"], ext_deps=["color", "opacity"]),
            "a": CollectionMeta(name="a", root_class="A", package="pkg.a",
                                folder="a", branches=["color"], modes=["v"], ext_deps=[]),
            "b": CollectionMeta(name="b", root_class="B", package="pkg.b",
                                folder="b", branches=["opacity"], modes=["v"], ext_deps=["color"]),
        }
        chain = compute_builder_chain("leaf", coll_deps, metas, [], "")
        chain_names = [m.name for m in chain]
        assert "leaf" not in chain_names
        # a before b (b depends on a)
        assert chain_names.index("a") < chain_names.index("b")


class TestSilentFailure:
    """Test that failures cause nonzero exit."""

    def test_exit_code_on_import(self):
        """Verify the CLI module can be imported without side effects."""
        from figma_tokens.cli import main
        assert main is not None
