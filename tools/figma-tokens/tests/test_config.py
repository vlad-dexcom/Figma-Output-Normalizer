"""Tests for the git-tracked collection exclusion config."""
from __future__ import annotations

import pytest

from figma_tokens.cli import (
    _apply_exclusions_to_intermediate,
    _drop_excluded_branches,
    _strip_excluded_aliases,
)
from figma_tokens.config import (
    DEFAULT_COLLECTIONS_CONFIG,
    CollectionFilter,
    load_collection_filter,
)
from figma_tokens.figma.models import ResolvedToken, TokenType
from figma_tokens.pipeline.enricher import EnrichmentResult


def _write(tmp_path, body: str) -> str:
    path = tmp_path / "collections.toml"
    path.write_text(body)
    return str(path)


def test_empty_filter_excludes_nothing():
    assert CollectionFilter().is_excluded("figma-only") is False


def test_exact_and_glob_patterns_are_case_insensitive():
    flt = CollectionFilter(exclude=["figma-only", "WIP-*"])
    assert flt.is_excluded("figma-only")
    assert flt.is_excluded("Figma-Only")
    assert flt.is_excluded("wip-colors")
    assert not flt.is_excluded("components")


def test_partition_preserves_order():
    flt = CollectionFilter(exclude=["figma-only"])
    kept, skipped = flt.partition(["base", "figma-only", "components"])
    assert kept == ["base", "components"]
    assert skipped == ["figma-only"]


def test_load_filter_from_toml(tmp_path):
    path = _write(tmp_path, 'exclude = ["figma-only", "wip-*"]\n')
    flt = load_collection_filter(path)
    assert flt.exclude == ["figma-only", "wip-*"]
    assert flt.source == path


def test_load_filter_accepts_single_string(tmp_path):
    flt = load_collection_filter(_write(tmp_path, 'exclude = "figma-only"\n'))
    assert flt.exclude == ["figma-only"]


def test_load_filter_missing_default_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "figma_tokens.config.DEFAULT_COLLECTIONS_CONFIG", str(tmp_path / "nope.toml")
    )
    assert load_collection_filter(None).exclude == []


def test_load_filter_missing_explicit_path_exits(tmp_path):
    with pytest.raises(SystemExit):
        load_collection_filter(str(tmp_path / "missing.toml"))


def test_load_filter_rejects_non_list(tmp_path):
    with pytest.raises(SystemExit):
        load_collection_filter(_write(tmp_path, "exclude = 42\n"))


def test_repo_default_config_is_loadable():
    flt = load_collection_filter(None)
    assert flt.source == DEFAULT_COLLECTIONS_CONFIG
    assert "figma-only" in flt.exclude


def test_strip_excluded_aliases_keeps_literal_value():
    kept = ResolvedToken(
        path="color/bg", type=TokenType.COLOR, values={"light": 1},
        alias_path="palette/blue/500", alias_source="primitives",
    )
    dropped = ResolvedToken(
        path="color/fg", type=TokenType.COLOR, values={"light": 2},
        alias_path="apple-color/blue", alias_source="figma-only",
        alias_by_mode={"light": "apple-color/blue"},
    )
    resolved = {"base": EnrichmentResult([kept, dropped], 0, 0, 0, 0)}

    _strip_excluded_aliases(resolved, CollectionFilter(exclude=["figma-only"]))

    assert kept.alias_path == "palette/blue/500"
    assert dropped.alias_path is None
    assert dropped.alias_source is None
    assert dropped.alias_by_mode is None
    assert dropped.values == {"light": 2}


# --- Branch-level exclusion ---

def test_branch_pattern_with_slash_is_collection_scoped():
    flt = CollectionFilter(exclude_branches=["base/apple"])
    assert flt.is_branch_excluded("base", "apple")
    assert flt.is_branch_excluded("Base", "Apple")
    assert not flt.is_branch_excluded("stelo", "apple")
    assert not flt.is_branch_excluded("base", "color")


def test_bare_branch_pattern_applies_to_every_collection():
    flt = CollectionFilter(exclude_branches=["apple"])
    assert flt.is_branch_excluded("base", "apple")
    assert flt.is_branch_excluded("stelo", "apple")
    assert not flt.is_branch_excluded("base", "apple-color")


def test_branch_globs_and_path_matching():
    flt = CollectionFilter(exclude_branches=["*/apple*"])
    assert flt.is_branch_excluded("primitives", "apple-color")
    assert flt.is_path_excluded("primitives", "apple-color/blue")
    assert not flt.is_path_excluded("primitives", "palette/apple-color")


def test_has_rules_reflects_both_lists():
    assert not CollectionFilter().has_rules
    assert CollectionFilter(exclude=["figma-only"]).has_rules
    assert CollectionFilter(exclude_branches=["apple"]).has_rules


def test_load_branch_patterns_from_toml(tmp_path):
    flt = load_collection_filter(
        _write(tmp_path, 'exclude = ["figma-only"]\nexclude-branches = ["base/apple"]\n')
    )
    assert flt.exclude == ["figma-only"]
    assert flt.exclude_branches == ["base/apple"]


def test_load_branch_patterns_reject_non_list(tmp_path):
    with pytest.raises(SystemExit):
        load_collection_filter(_write(tmp_path, "exclude-branches = 42\n"))


def test_unmatched_patterns_are_reported():
    flt = CollectionFilter(exclude=["figma-only", "nope"], exclude_branches=["apple", "ghost"])
    unmatched = flt.unmatched_patterns(
        ["base", "figma-only"], [("base", "apple"), ("base", "color")]
    )
    assert unmatched == ["nope", "ghost"]


def test_drop_excluded_branches_removes_only_matching_tokens():
    apple = ResolvedToken(path="apple/black", type=TokenType.COLOR, values={"light": 1})
    color = ResolvedToken(path="color/bg", type=TokenType.COLOR, values={"light": 2})
    resolved = {"base": EnrichmentResult([apple, color], 0, 0, 0, 0)}

    _drop_excluded_branches(resolved, CollectionFilter(exclude_branches=["base/apple"]))

    assert [t.path for t in resolved["base"].tokens] == ["color/bg"]


def test_strip_aliases_into_excluded_branch_of_own_collection():
    tok = ResolvedToken(
        path="color/fg", type=TokenType.COLOR, values={"light": 2},
        alias_path="apple/black", alias_by_mode={"light": "apple/black"},
    )
    resolved = {"base": EnrichmentResult([tok], 0, 0, 0, 0)}

    _strip_excluded_aliases(resolved, CollectionFilter(exclude_branches=["apple"]))

    assert tok.alias_path is None
    assert tok.alias_by_mode is None
    assert tok.values == {"light": 2}


def test_intermediate_exclusion_recomputes_metadata():
    collections_data = {
        "base": {
            "role": "semantic", "package": "p.base", "root_class": "Base", "folder": "base",
            "branches": ["apple", "color"], "ext_deps": ["palette"], "modes": [],
            "tokens": [
                {"path": "apple/black", "type": "COLOR", "values": {}},
                {"path": "color/bg", "type": "COLOR", "values": {},
                 "alias_path": "apple/black", "alias_source": "base"},
            ],
        },
        "components": {
            "role": "leaf", "package": "p.components", "root_class": "Components",
            "folder": "components", "branches": ["cards"], "ext_deps": ["apple", "color"],
            "modes": [],
            "tokens": [{"path": "cards/bg", "type": "COLOR", "values": {},
                        "alias_path": "apple/black", "alias_source": "base"}],
        },
    }
    graph = {"branch_owners": {"apple": "base", "color": "base", "cards": "components"}}
    builders = [{"leaf": "components", "product": None, "chain": ["base"], "theme_modes": []}]

    colls, new_graph, new_builders = _apply_exclusions_to_intermediate(
        collections_data, graph, builders, CollectionFilter(exclude_branches=["apple"])
    )

    assert [t["path"] for t in colls["base"]["tokens"]] == ["color/bg"]
    assert colls["base"]["branches"] == ["color"]
    assert colls["components"]["ext_deps"] == ["color"]
    assert new_graph["branch_owners"] == {"color": "base", "cards": "components"}
    assert colls["base"]["tokens"][0]["alias_path"] is None
    assert colls["components"]["tokens"][0]["alias_path"] is None
    assert new_builders == builders
