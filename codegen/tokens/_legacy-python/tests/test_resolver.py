"""Tests for per-mode alias resolution.

Regression cover for the bug where a token whose modes alias *different*
primitives (or where only some modes are aliases) collapsed onto a single
``alias_path``, so every mode was emitted with one mode's colour.
"""
from __future__ import annotations

from figma_tokens.figma.models import (
    FigmaCollection,
    FigmaColorValue,
    FigmaMode,
    FigmaVariable,
)
from figma_tokens.pipeline.resolver import TokenResolver


LAVENDER_500 = FigmaColorValue(0.674510, 0.658824, 0.890196, 1.0)
LAVENDER_800 = FigmaColorValue(0.168627, 0.156863, 0.333333, 1.0)
LAVENDER_400 = FigmaColorValue(0.792157, 0.780392, 0.941176, 1.0)


def _resolve(base_values_by_var):
    """Resolve a two-mode `base` collection that aliases a `primitives` palette."""
    primitives = FigmaCollection(
        id="c_prim",
        name="primitives",
        modes=[FigmaMode(mode_id="p0", name="Value")],
        variable_ids=["p500", "p800", "p400"],
    )
    base = FigmaCollection(
        id="c_base",
        name="base",
        modes=[FigmaMode(mode_id="light", name="light"), FigmaMode(mode_id="dark", name="dark")],
        variable_ids=list(base_values_by_var),
    )
    variables = {
        "p500": FigmaVariable("p500", "palette/lavender/500", "COLOR", "c_prim", {"p0": LAVENDER_500}),
        "p800": FigmaVariable("p800", "palette/lavender/800", "COLOR", "c_prim", {"p0": LAVENDER_800}),
        "p400": FigmaVariable("p400", "palette/lavender/400", "COLOR", "c_prim", {"p0": LAVENDER_400}),
    }
    for var_id, values in base_values_by_var.items():
        variables[var_id] = FigmaVariable(var_id, f"color/{var_id}", "COLOR", "c_base", values)

    resolver = TokenResolver(lambda _m: None, lambda _m: None)
    tokens = resolver.resolve(
        variables,
        {"c_prim": primitives, "c_base": base},
        "base",
    )
    return {t.path: t for t in tokens}


def test_mode_with_literal_does_not_inherit_another_modes_alias():
    """light is a raw literal, dark aliases lavender/500 — light must keep its literal."""
    tokens = _resolve({"default": {"light": LAVENDER_800, "dark": "alias:p500"}})
    token = tokens["color/default"]

    assert token.alias_path is None, "a partial alias must not collapse onto every mode"
    assert token.alias_by_mode == {"dark": "palette/lavender/500"}
    assert token.values["light"] == LAVENDER_800
    assert token.values["dark"] == LAVENDER_500


def test_modes_aliasing_different_primitives_keep_both_aliases():
    """light -> lavender/800, dark -> lavender/400 must both survive."""
    tokens = _resolve({"hover": {"light": "alias:p800", "dark": "alias:p400"}})
    token = tokens["color/hover"]

    assert token.alias_path is None
    assert token.alias_by_mode == {
        "light": "palette/lavender/800",
        "dark": "palette/lavender/400",
    }
    assert token.values["light"] == LAVENDER_800
    assert token.values["dark"] == LAVENDER_400


def test_identical_alias_in_every_mode_still_collapses():
    """The single-alias fast path is preserved when all modes agree."""
    tokens = _resolve({"canvas": {"light": "alias:p500", "dark": "alias:p500"}})
    token = tokens["color/canvas"]

    assert token.alias_path == "palette/lavender/500"
    assert token.alias_by_mode is None
