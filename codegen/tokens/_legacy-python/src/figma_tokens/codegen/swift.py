"""Swift code generator for design tokens."""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Set, Tuple

from ..figma.models import FigmaColorValue, ResolvedToken, TokenType
from ..config import GeneratorConfig
from .base import (
    TreeNode,
    TokenGenerator,
    collect_all_tokens,
    insert_token,
    sanitize_path,
    sanitize_identifier,
    swift_doc,
    to_camel_case,
    to_pascal_case,
    write_file,
)

MAX_MODE_OVERRIDE_PARAMS = 10


def _prefixed_fn(fn_name: str, prefix: str) -> str:
    """Prepend a product prefix to a function name: stelo + accordions → steloAccordions."""
    if not prefix:
        return fn_name
    return f"{prefix}{fn_name[0].upper()}{fn_name[1:]}"


def _cls(name: str, prefix: str) -> str:
    """Apply prefix to a struct name."""
    return f"{prefix}{to_pascal_case(name)}"


SWIFT_KEYWORDS = frozenset([
    "as", "break", "case", "catch", "class", "continue", "default", "defer",
    "do", "else", "enum", "extension", "fallthrough", "false", "for", "func",
    "guard", "if", "import", "in", "init", "inout", "internal", "is", "let",
    "nil", "open", "operator", "private", "protocol", "public", "repeat",
    "return", "self", "static", "struct", "subscript", "super", "switch",
    "throw", "throws", "true", "try", "typealias", "var", "where", "while",
])

# Keywords that need escaping in function declarations and let declarations.
SWIFT_FUNC_KEYWORDS = SWIFT_KEYWORDS

# Keywords that do NOT need escaping in member access position (e.g. foo.default).
SWIFT_ACCESS_SAFE = frozenset(["default"])


def _safe_prop(name: str) -> str:
    """Wrap property name in backticks if it's a Swift keyword (let declarations)."""
    camel = to_camel_case(name)
    return f"`{camel}`" if camel in SWIFT_KEYWORDS else camel


def _safe_arg_label(name: str) -> str:
    """Argument label at call site — keywords like 'default' are safe unescaped."""
    camel = to_camel_case(name)
    needs_escape = camel in SWIFT_KEYWORDS and camel not in SWIFT_ACCESS_SAFE
    return f"`{camel}`" if needs_escape else camel


def _safe_factory_name(name: str) -> str:
    """Build a Swift factory method name, escaping keywords."""
    camel = to_camel_case(sanitize_identifier(name))
    return f"`{camel}`" if camel in SWIFT_KEYWORDS else camel


def _escape_factory_name(name: str) -> str:
    """Escape a precomputed Swift factory method name if it is a keyword."""
    return f"`{name}`" if name in SWIFT_KEYWORDS else name


def write_shadow_aliases_file(output_dir: str, aliases: Dict[str, str]) -> None:
    """Write a single shared _TypeAliases.swift file with all needed shadow aliases.
    Dict maps alias_name → qualified_target (e.g. '_DSBase' → 'DSBase')."""
    if not aliases:
        return
    lines = ["import SwiftUI", ""]
    for alias, target in sorted(aliases.items()):
        lines.append(f"typealias {alias} = {target}")
    lines.append("")
    write_file(os.path.join(output_dir, "_TypeAliases.swift"), "\n".join(lines) + "\n")


class SwiftGenerator(TokenGenerator):
    """Generates Swift source files mirroring the Kotlin nested class structure."""

    @property
    def language_id(self) -> str:
        return "swift"

    def generate(self, tokens: List[ResolvedToken], config: GeneratorConfig) -> None:
        shared_dir = config.shared_output_dir or config.output_dir
        flavor_dir = config.output_dir
        prefix = config.class_prefix
        fn_prefix = config.factory_fn_prefix

        if config.write_shared:
            os.makedirs(shared_dir, exist_ok=True)
        os.makedirs(flavor_dir, exist_ok=True)

        mode_names = list(tokens[0].values.keys()) if tokens else []

        if not tokens:
            return  # Nothing to generate for empty collections

        # Build tree
        root = TreeNode("root")
        for token in tokens:
            segments = sanitize_path(token.path)
            insert_token(root, segments, token)

        level1_branches = [n for n in root.sorted_children if n.children]
        level1_leaves = [n for n in root.sorted_children if n.token and not n.children]
        root_branch_names = {branch.name for branch in level1_branches}
        collapsible = {n.name for n in level1_branches if _can_generate_shared_factory(n)}

        # --- Shared output ---
        if config.write_shared:
            if not config.skip_data_classes:
                _gen_root_struct(shared_dir, config, root, level1_branches, level1_leaves, prefix)

            renames = config.branch_class_renames or {}
            for l1 in level1_branches:
                l1_class = renames.get(l1.name, _cls(l1.name, prefix))
                if l1.name in collapsible:
                    _gen_collapsed_factory(
                        shared_dir,
                        config.root_class_name,
                        root_branch_names,
                        l1,
                        l1_class,
                        root,
                        collapsible,
                        prefix,
                        config.branch_root_class_map,
                        circular_deps=config.circular_deps,
                        fn_prefix=fn_prefix,
                        cross_branch_deps=config.cross_branch_deps,
                        shadow_aliases_collector=config.shadow_aliases_collector,
                        global_branch_renames=config.global_branch_renames,
                    )

            # Root factories in shared when no prim deps
            all_branch_names = {n.name for n in level1_branches}
            root_has_prim = _root_has_prim_deps(level1_branches, collapsible)
            root_has_ext = _root_has_external_deps(level1_branches, collapsible, all_branch_names)
            if not root_has_prim and not root_has_ext:
                for mode in mode_names:
                    _gen_root_factory(
                        shared_dir, config, root, mode, level1_branches, level1_leaves, collapsible, prefix,
                        fn_prefix=fn_prefix,
                    )

        # Root factories to flavor when prim deps
        all_branch_names = {n.name for n in level1_branches}
        root_has_prim = _root_has_prim_deps(level1_branches, collapsible)
        root_has_ext = _root_has_external_deps(level1_branches, collapsible, all_branch_names)
        if root_has_prim or root_has_ext:
            for mode in mode_names:
                _gen_root_factory(
                    flavor_dir, config, root, mode, level1_branches, level1_leaves, collapsible, prefix,
                    fn_prefix=fn_prefix,
                )

        # Non-collapsible → flavor
        for l1 in level1_branches:
            if l1.name in collapsible:
                continue
            l1_class = renames.get(l1.name, _cls(l1.name, prefix))
            for mode in mode_names:
                _gen_level1_factory(
                    flavor_dir,
                    config.root_class_name,
                    root_branch_names,
                    l1,
                    l1_class,
                    mode,
                    prefix,
                    config.branch_root_class_map,
                    circular_deps=config.circular_deps,
                    fn_prefix=fn_prefix,
                    root_node=root,
                    shadow_aliases_collector=config.shadow_aliases_collector,
                    global_branch_renames=config.global_branch_renames,
                )


# --- Analysis helpers ---

def _is_varying(token: ResolvedToken) -> bool:
    vals = list(token.values.values())
    return len(vals) > 1 and not all(v == vals[0] for v in vals)


def _can_generate_shared_factory(branch: TreeNode) -> bool:
    tokens = collect_all_tokens(branch)
    if not tokens:
        return False
    varying = [t for t in tokens if _is_varying(t)]
    if not varying:
        return True
    unmatched = sum(1 for t in varying if t.alias_path is None)
    return unmatched <= MAX_MODE_OVERRIDE_PARAMS


def _collect_unmatched_varying(branch: TreeNode) -> List[ResolvedToken]:
    return [t for t in collect_all_tokens(branch) if _is_varying(t) and t.alias_path is None]


def _find_dependencies(branch: TreeNode, all_branches: Set[str], collapsible: Set[str]) -> List[str]:
    deps: Set[str] = set()
    has_cross_collection_self_dep = False
    for token in collect_all_tokens(branch):
        if token.alias_path is None:
            continue
        top = token.alias_path.split("/")[0]
        if top == branch.name and token.alias_source:
            # Cross-collection same-branch dep only if alias_path differs from token path
            if token.alias_path != token.path:
                has_cross_collection_self_dep = True
        elif top != branch.name and top not in collapsible:
            deps.add(top)
    if has_cross_collection_self_dep:
        deps.add(branch.name)
    return sorted(deps)


def _partition_dependencies(deps: List[str], all_branches: Set[str]) -> Tuple[List[str], List[str]]:
    internal = [d for d in deps if d in all_branches]
    external = [d for d in deps if d not in all_branches]
    return internal, external


def _root_has_prim_deps(level1_branches: List[TreeNode], collapsible: Set[str]) -> bool:
    return any(
        l1.name not in collapsible and any(t.alias_by_mode for t in collect_all_tokens(l1))
        for l1 in level1_branches
    )


def _root_has_external_deps(level1_branches: List[TreeNode], collapsible: Set[str], all_branch_names: Set[str]) -> bool:
    for l1 in level1_branches:
        if l1.name not in collapsible:
            continue
        deps = _find_dependencies(l1, all_branch_names, collapsible)
        _, external = _partition_dependencies(deps, all_branch_names)
        if external:
            return True
    return False


def _has_class_named_color(node: TreeNode, prefix: str = "") -> bool:
    if _cls(node.name, prefix) == "Color":
        return True
    return any(_cls(n.name, prefix) == "Color" and n.children for n in node.sorted_children)


def _swift_type(token_type: TokenType, has_color_conflict: bool = False) -> str:
    if token_type == TokenType.COLOR:
        return "SwiftUI.Color" if has_color_conflict else "Color"
    return {TokenType.FLOAT: "Double", TokenType.STRING: "String", TokenType.BOOLEAN: "Bool"}[token_type]


def _swift_default_for_type(token_type: TokenType, has_color_conflict: bool = False) -> str:
    """Return a Swift default value literal for a token type."""
    if token_type == TokenType.COLOR:
        return ".clear" if not has_color_conflict else "SwiftUI.Color.clear"
    return {TokenType.FLOAT: "0", TokenType.STRING: "\"\"", TokenType.BOOLEAN: "false"}[token_type]


def _format_color(value: Any, has_color_conflict: bool = False) -> str:
    from .base import _round_float
    color_name = "SwiftUI.Color" if has_color_conflict else "Color"
    if isinstance(value, FigmaColorValue):
        r, g, b, a = _round_float(float(value.r)), _round_float(float(value.g)), _round_float(float(value.b)), _round_float(float(value.a))
        return f"{color_name}(red: {r}, green: {g}, blue: {b}, opacity: {a})"
    if isinstance(value, dict) and "r" in value:
        r, g, b, a = _round_float(float(value['r'])), _round_float(float(value['g'])), _round_float(float(value['b'])), _round_float(float(value.get('a', 1.0)))
        return f"{color_name}(red: {r}, green: {g}, blue: {b}, opacity: {a})"
    return f"{color_name}.clear"


def _format_float(value: Any) -> str:
    from .base import _round_float
    return _round_float(float(value) if not isinstance(value, float) else value)


def _escape_string(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _build_token_reference(alias_path: str) -> str:
    segments = sanitize_path(alias_path)
    parts = []
    for seg in segments:
        name = to_camel_case(seg)
        # In member access position, some keywords (like 'default') don't need escaping
        needs_escape = name in SWIFT_KEYWORDS and name not in SWIFT_ACCESS_SAFE
        parts.append(f"`{name}`" if needs_escape else name)
    return ".".join(parts)


def _format_value(token: ResolvedToken, mode_name: str, has_color_conflict: bool = False,
                  skip_branches: Optional[Set[str]] = None) -> str:
    if token.alias_by_mode:
        alias = token.alias_by_mode.get(mode_name)
        if alias:
            top = alias.split("/")[0]
            token_top = token.path.split("/")[0]
            # Skip same-branch references (the branch is being constructed,
            # so sibling fields aren't accessible yet)
            if top != token_top and not (skip_branches and top in skip_branches):
                return _build_token_reference(alias)
    # Fallback: non-varying alias_path (e.g. from enricher Phase 3)
    if token.alias_path:
        top = token.alias_path.split("/")[0]
        token_top = token.path.split("/")[0]
        if top != token_top and not (skip_branches and top in skip_branches):
            return _build_token_reference(token.alias_path)
    value = token.values.get(mode_name) or next(iter(token.values.values()))
    if token.type == TokenType.COLOR:
        return _format_color(value, has_color_conflict)
    if token.type == TokenType.FLOAT:
        return _format_float(value)
    if token.type == TokenType.STRING:
        return f'"{_escape_string(str(value))}"'
    return str(value).lower()


def _format_collapsed_value(token: ResolvedToken, override_params: Dict[str, str],
                            has_color_conflict: bool = False, skip_branches: Optional[Set[str]] = None) -> str:
    if token.alias_path:
        top = token.alias_path.split("/")[0]
        # Skip self-references, but allow cross-collection same-branch refs with different paths
        is_self_ref = skip_branches and top in skip_branches and not (token.alias_source and token.alias_path != token.path)
        if not is_self_ref:
            return _build_token_reference(token.alias_path)
    param = override_params.get(token.path)
    if param:
        return param
    value = next(iter(token.values.values()))
    if token.type == TokenType.COLOR:
        return _format_color(value, has_color_conflict)
    if token.type == TokenType.FLOAT:
        return _format_float(value)
    if token.type == TokenType.STRING:
        return f'"{_escape_string(str(value))}"'
    return str(value).lower()


def _token_path_to_param_name(path: str, branch_name: str) -> str:
    segments = path.split("/")
    relevant = []
    skip = True
    for s in segments:
        if skip and (s == segments[0] or s == branch_name):
            continue
        skip = False
        relevant.append(s)
    parts = []
    for seg in relevant:
        clean = "".join(c for c in seg if c.isalnum() or c == " ")
        words = clean.split()
        parts.append("".join(w.capitalize() for w in words))
    result = "".join(parts)
    return result[0].lower() + result[1:] if result else "_param"


# --- Code generation ---

def _gen_root_struct(output_dir: str, config: GeneratorConfig, root: TreeNode,
                     branches: List[TreeNode], leaves: List[TreeNode], prefix: str) -> None:
    if not branches and not leaves:
        return  # Skip empty structs
    lines = ["import SwiftUI", ""]
    color_conflict = _has_class_named_color(root, prefix)
    root_name = config.root_class_name
    qualified = "." in root_name
    base_indent = 2 if qualified else 1
    pad = "    " * (base_indent - 1)
    child_pad = "    " * base_indent
    if qualified:
        parent, child = root_name.rsplit(".", 1)
        lines.append(f"extension {parent} {{")
        lines.append(f"    struct {child} {{")
    else:
        lines.append(f"struct {root_name} {{")
    renames = config.branch_class_renames or {}
    for leaf in leaves:
        prop = _safe_prop(leaf.name)
        ptype = _swift_type(leaf.token.type, color_conflict)  # type: ignore
        default = _swift_default_for_type(leaf.token.type, color_conflict)  # type: ignore
        lines.extend(swift_doc(leaf.token.description, child_pad))  # type: ignore
        lines.append(f"{child_pad}var {prop}: {ptype} = {default}")
    for l1 in branches:
        prop = _safe_prop(l1.name)
        cls = renames.get(l1.name, _cls(l1.name, prefix))
        lines.append(f"{child_pad}var {prop}: {cls} = .init()")
    if branches:
        lines.append("")
        for l1 in branches:
            cls = renames.get(l1.name, _cls(l1.name, prefix))
            _gen_struct(
                lines,
                l1,
                cls,
                indent=base_indent,
                parent_color_conflict=color_conflict,
                prefix=prefix,
            )
    lines.append(f"{pad}}}")
    if qualified:
        lines.append("}")
    write_file(os.path.join(output_dir, f"{config.root_class_name}.swift"), "\n".join(lines) + "\n")


def _gen_struct(lines: List[str], node: TreeNode, class_name: str, indent: int,
                parent_color_conflict: bool = False, prefix: str = "") -> None:
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]
    color_conflict = parent_color_conflict or _has_class_named_color(node, prefix)

    lines.append(f"{pad}struct {class_name} {{")
    for leaf in leaf_nodes:
        prop = _safe_prop(leaf.name)
        ptype = _swift_type(leaf.token.type, color_conflict)  # type: ignore
        default = _swift_default_for_type(leaf.token.type, color_conflict)  # type: ignore
        lines.extend(swift_doc(leaf.token.description, child_pad))  # type: ignore
        lines.append(f"{child_pad}var {prop}: {ptype} = {default}")
    for branch in branch_nodes:
        prop = _safe_prop(branch.name)
        child_cls = _cls(branch.name, prefix)
        lines.append(f"{child_pad}var {prop}: {child_cls} = .init()")

    if branch_nodes:
        lines.append("")
        for branch in branch_nodes:
            child_cls = _cls(branch.name, prefix)
            _gen_struct(lines, branch, child_cls, indent + 1, color_conflict, prefix)
    lines.append(f"{pad}}}")


def _qualify_root_nested_type(type_name: str, root_class_name: str, root_branch_names: Set[str], prefix: str, branch_root_map: Optional[Dict[str, str]] = None) -> str:
    """Qualify a type with its owning root struct path."""
    if type_name in root_branch_names:
        return f"{root_class_name}.{_cls(type_name, prefix)}"
    # Cross-collection reference: use the other collection's root class
    if branch_root_map and type_name in branch_root_map:
        return f"{branch_root_map[type_name]}.{_cls(type_name, prefix)}"
    return _cls(type_name, prefix)


def _collect_nested_class_names(node: TreeNode, prefix: str) -> Set[str]:
    """Recursively collect all class names used by nested structs in a tree."""
    names: Set[str] = set()
    for child in node.sorted_children:
        if child.children:  # branch → struct
            names.add(_cls(child.name, prefix))
            names |= _collect_nested_class_names(child, prefix)
    return names


def _build_shadow_aliases(ext_deps: List[str], root: TreeNode, prefix: str,
                          root_class_name: str,
                          root_branch_names: Set[str],
                          branch_root_map: Optional[Dict[str, str]] = None,
                          cross_branch_deps: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build typealias map for external dep types that collide with nested struct names.
    Returns {original_cls_name: aliased_name} for shadowed types.
    Checks the first component of qualified types (e.g. DSTypography in DSTypography.DSBody).
    Skips deps in cross_branch_deps (they use fully qualified types from other collections)."""
    nested = _collect_nested_class_names(root, prefix)
    cross = cross_branch_deps or {}
    aliases: Dict[str, str] = {}
    for dep in ext_deps:
        # Cross-branch deps are fully qualified (e.g., DSPrimitives.DSScale) — no aliasing needed
        if dep in cross:
            continue
        # Sibling branch deps within the same collection resolve correctly — no aliasing needed
        if dep in root_branch_names:
            continue
        qualified = _qualify_root_nested_type(dep, root_class_name, root_branch_names, prefix, branch_root_map)
        # Strip the root class prefix (e.g. "DSComponents.DSTypography.DSBody" -> "DSTypography.DSBody")
        if qualified.startswith(f"{root_class_name}."):
            qualified = qualified[len(root_class_name) + 1:]
        # The first component is what matters for shadowing
        first_component = qualified.split(".")[0]
        if first_component in nested and first_component not in aliases:
            aliases[first_component] = f"_{first_component}"
    return aliases


def _apply_shadow_alias(type_str: str, shadow_aliases: Dict[str, str]) -> str:
    """Replace shadowed type names in a type string (e.g. 'DSTypography.DSBody' -> '_DSTypography.DSBody')."""
    for orig, alias in shadow_aliases.items():
        if type_str == orig or type_str.startswith(f"{orig}."):
            return alias + type_str[len(orig):]
    return type_str


def _gen_collapsed_factory(output_dir: str, root_class_name: str, root_branch_names: Set[str],
                           node: TreeNode, class_name: str, root: TreeNode, collapsible: Set[str], prefix: str,
                           branch_root_map: Optional[Dict[str, str]] = None,
                           circular_deps: Optional[Dict[str, Set[str]]] = None,
                           fn_prefix: str = "",
                           cross_branch_deps: Optional[Dict[str, str]] = None,
                           shadow_aliases_collector: Optional[Dict[str, str]] = None,
                           global_branch_renames: Optional[Dict[str, str]] = None) -> None:
    fn_name = _escape_factory_name(_prefixed_fn("make", fn_prefix))
    deps = _find_dependencies(node, set(root.children.keys()), set())
    # Skip self-references and circular deps, but allow cross-collection self-deps
    cross = cross_branch_deps or {}
    skip: Set[str] = set()
    if node.name not in cross:
        skip.add(node.name)
    if circular_deps and node.name in circular_deps:
        skip |= circular_deps[node.name]
    deps = [d for d in deps if d not in skip]
    unmatched = _collect_unmatched_varying(node)
    override_params = {t.path: _token_path_to_param_name(t.path, node.name) for t in unmatched}
    has_color_conflict = any(_cls(name, prefix) == "Color" for name in root_branch_names) or _has_class_named_color(node, prefix)

    # Detect shadowed type names
    shadow_aliases = _build_shadow_aliases(deps, root, prefix, root_class_name, root_branch_names, branch_root_map, cross_branch_deps)

    lines = ["import SwiftUI", ""]
    # Accumulate aliases into shared collector instead of emitting per-file
    if shadow_aliases_collector is not None:
        for bare, alias in shadow_aliases.items():
            shadow_aliases_collector[alias] = bare  # {_DSBase: DSBase}
    lines.append(f"extension {root_class_name}.{class_name} {{")

    # Params
    cross = cross_branch_deps or {}
    gbr = global_branch_renames or {}
    dep_params = []
    for d in deps:
        if d in cross:
            cls_name = gbr.get(d, _cls(d, prefix))
            dep_type = f"{cross[d]}.{cls_name}"
        else:
            dep_type = _qualify_root_nested_type(d, root_class_name, root_branch_names, prefix, branch_root_map)
        dep_type = _apply_shadow_alias(dep_type, shadow_aliases)
        # Apply global branch renames
        if d in gbr:
            dep_type = dep_type.replace(_cls(d, prefix), gbr[d])
        dep_params.append(f"{to_camel_case(d)}: {dep_type}")
    override_param_list = [
        f"{override_params[t.path]}: {_swift_type(t.type, has_color_conflict)}" for t in unmatched
    ]
    all_params = dep_params + override_param_list

    if len(all_params) <= 2:
        lines.append(f"    static func {fn_name}({', '.join(all_params)}) -> Self {{")
    else:
        lines.append(f"    static func {fn_name}(")
        for p in all_params:
            lines.append(f"        {p},")
        lines.append("    ) -> Self {")

    l2_leaves = [n for n in node.sorted_children if n.token and not n.children]
    l2_branches = [n for n in node.sorted_children if n.children]

    lines.append("        return Self(")
    for leaf in l2_leaves:
        prop = _safe_arg_label(leaf.name)
        val = _format_collapsed_value(leaf.token, override_params, has_color_conflict, skip_branches=skip)  # type: ignore
        lines.append(f"            {prop}: {val},")
    for branch in l2_branches:
        prop = _safe_arg_label(branch.name)
        child_cls = f"{root_class_name}.{class_name}.{_cls(branch.name, prefix)}"
        node_str = _collapsed_factory_node(branch, child_cls, override_params, 2, has_color_conflict, prefix, skip_branches=skip)
        lines.append(f"            {prop}: {node_str},")
    lines.append("        )")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    write_file(
        os.path.join(output_dir, f"{fn_prefix_pascal}{root_class_name}{to_pascal_case(node.name)}Factory.swift"),
        "\n".join(lines) + "\n",
    )


def _collapsed_factory_node(node: TreeNode, class_name: str, override_params: Dict[str, str],
                            indent: int, has_color_conflict: bool, prefix: str,
                            skip_branches: Optional[Set[str]] = None) -> str:
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]

    result = [f"{class_name}("]
    for leaf in leaf_nodes:
        prop = _safe_arg_label(leaf.name)
        val = _format_collapsed_value(leaf.token, override_params, has_color_conflict, skip_branches=skip_branches)  # type: ignore
        result.append(f"{child_pad}{prop}: {val},")
    for branch in branch_nodes:
        prop = _safe_arg_label(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        result.append(f"{child_pad}{prop}: {_collapsed_factory_node(branch, child_cls, override_params, indent + 1, has_color_conflict, prefix, skip_branches=skip_branches)},")
    result.append(f"{pad})")
    return "\n".join(result)


def _gen_root_factory(output_dir: str, config: GeneratorConfig, root: TreeNode, mode_name: str,
                      branches: List[TreeNode], leaves: List[TreeNode], collapsible: Set[str], prefix: str,
                      fn_prefix: str = "") -> None:
    fn_name = _escape_factory_name(_prefixed_fn(to_camel_case(sanitize_identifier(mode_name)), fn_prefix))
    collapsed_fn = _escape_factory_name(_prefixed_fn("make", fn_prefix))
    non_collapsible = [l1 for l1 in branches if l1.name not in collapsible]
    coll_branches = [l1 for l1 in branches if l1.name in collapsible]
    has_color_conflict = _has_class_named_color(root, prefix)
    renames = config.branch_class_renames or {}

    def _branch_cls(name: str) -> str:
        return renames.get(name, _cls(name, prefix))

    all_branch_names = {n.name for n in branches}
    circular_deps = config.circular_deps
    # External deps (filter circular)
    prim_deps: List[str] = []
    for l1 in non_collapsible:
        l1_circ = circular_deps.get(l1.name, set()) if circular_deps else set()
        for t in collect_all_tokens(l1):
            if t.alias_by_mode:
                for v in t.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in all_branch_names and top not in prim_deps and top not in l1_circ:
                        prim_deps.append(top)
            if t.alias_path:
                top = t.alias_path.split("/")[0]
                if top not in all_branch_names and top not in prim_deps and top not in l1_circ:
                    prim_deps.append(top)

    ext_from_coll: List[str] = []
    for l1 in coll_branches:
        l1_circ = circular_deps.get(l1.name, set()) if circular_deps else set()
        deps = _find_dependencies(l1, all_branch_names, collapsible)
        deps = [d for d in deps if d not in l1_circ]
        _, ext = _partition_dependencies(deps, all_branch_names)
        for d in ext:
            if d not in ext_from_coll:
                ext_from_coll.append(d)
        # Also collect alias_by_mode deps from unmatched varying tokens
        for t in _collect_unmatched_varying(l1):
            if t.alias_by_mode:
                for v in t.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in all_branch_names and top not in ext_from_coll:
                        ext_from_coll.append(top)

    all_ext = sorted(set(prim_deps + ext_from_coll))

    # Promote cross-collection same-branch deps to external params
    cross = config.cross_branch_deps or {}
    for branch_name in cross:
        if branch_name in all_branch_names and branch_name not in all_ext:
            all_ext.append(branch_name)
    all_ext = sorted(set(all_ext))

    # Also collect deps from root-level leaves
    leaf_deps: List[str] = []
    for leaf in leaves:
        if leaf.token:
            if leaf.token.alias_path:
                top = leaf.token.alias_path.split("/")[0]
                if top not in all_branch_names and top not in leaf_deps:
                    leaf_deps.append(top)
            if leaf.token.alias_by_mode:
                for v in leaf.token.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in all_branch_names and top not in leaf_deps:
                        leaf_deps.append(top)
    if leaf_deps:
        all_ext = sorted(set(all_ext + leaf_deps))

    # Save actual root factory params to config for builder use
    config.root_factory_ext_deps = list(all_ext)

    root_branch_names = {n.name for n in branches}
    branch_root_map = config.branch_root_class_map
    shadow_aliases = _build_shadow_aliases(all_ext, root, prefix, config.root_class_name, root_branch_names, branch_root_map, config.cross_branch_deps)

    lines = ["import SwiftUI", ""]
    # Accumulate aliases into shared collector
    if config.shadow_aliases_collector is not None:
        for bare, alias in shadow_aliases.items():
            config.shadow_aliases_collector[alias] = bare  # {_DSBase: DSBase}
    lines.append(f"extension {config.root_class_name} {{")

    def _qualify_ext(d: str) -> str:
        # Cross-collection deps use source root class
        gbr = config.global_branch_renames or {}
        if d in cross:
            cls_name = gbr.get(d, _cls(d, prefix))
            return f"{cross[d]}.{cls_name}"
        qualified = _qualify_root_nested_type(d, config.root_class_name, root_branch_names, prefix, branch_root_map)
        qualified = _apply_shadow_alias(qualified, shadow_aliases)
        # Apply global branch renames (e.g. DSPrimitives.DSTypography → DSPrimitives.DSTypographyTokens)
        if d in gbr:
            orig_cls = _cls(d, prefix)
            renamed_cls = gbr[d]
            qualified = qualified.replace(orig_cls, renamed_cls)
        return qualified

    params = ", ".join(
        f"{to_camel_case(d)}: {_qualify_ext(d)}"
        for d in all_ext
    ) if all_ext else ""
    lines.append(f"    static func {fn_name}({params}) -> Self {{")

    # Non-collapsible locals
    for l1 in non_collapsible:
        prop = _safe_prop(l1.name)
        l1_cls = _branch_cls(l1.name)
        l1_fn = _escape_factory_name(
            _prefixed_fn(f"{to_camel_case(l1.name)}{sanitize_identifier(mode_name)}", fn_prefix)
        )
        l1_tokens = collect_all_tokens(l1)
        l1_circ = circular_deps.get(l1.name, set()) if circular_deps else set()
        l1_skip = {l1.name} | l1_circ
        l1_prim: List[str] = []
        for t in l1_tokens:
            if t.alias_by_mode:
                for v in t.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in l1_skip and top not in l1_prim:
                        l1_prim.append(top)
            if t.alias_path:
                top = t.alias_path.split("/")[0]
                if top not in l1_skip and top not in l1_prim:
                    l1_prim.append(top)
        args = ", ".join(f"{to_camel_case(d)}: {to_camel_case(d)}" for d in l1_prim)
        lines.append(f"        let {prop} = {l1_cls}.{l1_fn}({args})")

    # Collapsible branches
    coll_no_deps = [l1 for l1 in coll_branches if not _find_dependencies(l1, all_branch_names, set())]
    coll_with_deps = [l1 for l1 in coll_branches if _find_dependencies(l1, all_branch_names, set())]

    for l1 in coll_no_deps:
        prop = _safe_prop(l1.name)
        unmatched = _collect_unmatched_varying(l1)
        override_args = [
            f"{_token_path_to_param_name(t.path, l1.name)}: {_format_value(t, mode_name, has_color_conflict)}"
            for t in unmatched
        ]
        if not override_args:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}()")
        elif len(override_args) <= 2:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}({', '.join(override_args)})")
        else:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}(")
            for a in override_args:
                lines.append(f"            {a},")
            lines.append("        )")

    for l1 in coll_with_deps:
        prop = _safe_prop(l1.name)
        deps = _find_dependencies(l1, all_branch_names, set())
        if circular_deps and l1.name in circular_deps:
            deps = [d for d in deps if d not in circular_deps[l1.name] and d != l1.name]
        unmatched = _collect_unmatched_varying(l1)
        dep_args = [f"{to_camel_case(d)}: {to_camel_case(d)}" for d in deps]
        override_args = [
            f"{_token_path_to_param_name(t.path, l1.name)}: {_format_value(t, mode_name, has_color_conflict)}"
            for t in unmatched
        ]
        all_args = dep_args + override_args
        if not all_args:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}()")
        elif len(all_args) <= 2:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}({', '.join(all_args)})")
        else:
            lines.append(f"        let {prop} = {_branch_cls(l1.name)}.{collapsed_fn}(")
            for a in all_args:
                lines.append(f"            {a},")
            lines.append("        )")

    # Return
    lines.append("        return Self(")
    for leaf in leaves:
        prop = _safe_arg_label(leaf.name)
        val = _format_value(leaf.token, mode_name, has_color_conflict)  # type: ignore
        lines.append(f"            {prop}: {val},")
    for l1 in branches:
        prop = _safe_arg_label(l1.name)
        lines.append(f"            {prop}: {prop},")
    lines.append("        )")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    write_file(
        os.path.join(output_dir, f"{fn_prefix_pascal}{config.root_class_name}{sanitize_identifier(mode_name)}.swift"),
        "\n".join(lines) + "\n",
    )


def _gen_level1_factory(output_dir: str, root_class_name: str, root_branch_names: Set[str],
                        node: TreeNode, class_name: str, mode_name: str, prefix: str,
                        branch_root_map: Optional[Dict[str, str]] = None,
                        circular_deps: Optional[Dict[str, Set[str]]] = None,
                        fn_prefix: str = "",
                        root_node: Optional[TreeNode] = None,
                        shadow_aliases_collector: Optional[Dict[str, str]] = None,
                        global_branch_renames: Optional[Dict[str, str]] = None) -> None:
    fn_name = _escape_factory_name(
        _prefixed_fn(f"{to_camel_case(node.name)}{sanitize_identifier(mode_name)}", fn_prefix)
    )
    l2_leaves = [n for n in node.sorted_children if n.token and not n.children]
    l2_branches = [n for n in node.sorted_children if n.children]
    has_color_conflict = any(_cls(name, prefix) == "Color" for name in root_branch_names) or _has_class_named_color(node, prefix)

    all_tokens = collect_all_tokens(node)
    prim_deps: List[str] = []
    for t in all_tokens:
        if t.alias_by_mode:
            for v in t.alias_by_mode.values():
                top = v.split("/")[0]
                if top != node.name and top not in prim_deps:
                    prim_deps.append(top)
        if t.alias_path:
            top = t.alias_path.split("/")[0]
            if top != node.name and top not in prim_deps:
                prim_deps.append(top)

    # Build skip set: self + circular deps
    skip = {node.name}
    if circular_deps and node.name in circular_deps:
        skip |= circular_deps[node.name]
    prim_deps = [d for d in prim_deps if d not in skip]

    # Detect shadowed type names (root nested structs shadow external types)
    shadow_aliases: Dict[str, str] = {}
    if root_node:
        shadow_aliases = _build_shadow_aliases(prim_deps, root_node, prefix, root_class_name, root_branch_names, branch_root_map)

    lines = ["import SwiftUI", ""]
    if shadow_aliases_collector is not None:
        for bare, alias in shadow_aliases.items():
            shadow_aliases_collector[alias] = bare
    lines.append(f"extension {root_class_name}.{class_name} {{")

    def _qualify_ext(d: str) -> str:
        gbr = global_branch_renames or {}
        qualified = _qualify_root_nested_type(d, root_class_name, root_branch_names, prefix, branch_root_map)
        qualified = _apply_shadow_alias(qualified, shadow_aliases)
        if d in gbr:
            qualified = qualified.replace(_cls(d, prefix), gbr[d])
        return qualified

    params = ", ".join(
        f"{to_camel_case(d)}: {_qualify_ext(d)}"
        for d in prim_deps
    ) if prim_deps else ""
    lines.append(f"    static func {fn_name}({params}) -> Self {{")
    lines.append("        return Self(")
    for leaf in l2_leaves:
        prop = _safe_arg_label(leaf.name)
        val = _format_value(leaf.token, mode_name, has_color_conflict, skip_branches=skip)  # type: ignore
        lines.append(f"            {prop}: {val},")
    for branch in l2_branches:
        prop = _safe_arg_label(branch.name)
        child_cls = f"{root_class_name}.{class_name}.{_cls(branch.name, prefix)}"
        node_str = _gen_factory_node(branch, child_cls, mode_name, 2, has_color_conflict, prefix, skip_branches=skip)
        lines.append(f"            {prop}: {node_str},")
    lines.append("        )")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    write_file(
        os.path.join(output_dir, f"{fn_prefix_pascal}{root_class_name}{to_pascal_case(node.name)}{sanitize_identifier(mode_name)}.swift"),
        "\n".join(lines) + "\n",
    )


def _gen_factory_node(node: TreeNode, class_name: str, mode_name: str, indent: int,
                      has_color_conflict: bool, prefix: str, skip_branches: Optional[Set[str]] = None) -> str:
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]

    result = [f"{class_name}("]
    for leaf in leaf_nodes:
        prop = _safe_arg_label(leaf.name)
        val = _format_value(leaf.token, mode_name, has_color_conflict, skip_branches=skip_branches)  # type: ignore
        result.append(f"{child_pad}{prop}: {val},")
    for branch in branch_nodes:
        prop = _safe_arg_label(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        result.append(f"{child_pad}{prop}: {_gen_factory_node(branch, child_cls, mode_name, indent + 1, has_color_conflict, prefix, skip_branches=skip_branches)},")
    result.append(f"{pad})")
    return "\n".join(result)


# --- Builder generation ---

def generate_builder(
    output_dir: str,
    leaf_meta: dict,
    sorted_chain: List[dict],
    branch_pkg_map: Dict[str, str],
    theme_modes: List[Tuple[str, Dict[str, str]]],
    prefix: str = "",
    product_name: str = "",
    leaf_nested_names: Optional[Set[str]] = None,
    shadow_aliases_collector: Optional[Dict[str, str]] = None,
) -> None:
    """Generate a Swift builder extension that wires multiple collections together."""
    leaf_root_class = leaf_meta['root_class']

    def _vn(meta: dict) -> str:
        r = meta['root_class']
        if prefix and r.startswith(prefix):
            r = r[len(prefix):]
        # Collapse dots for qualified names (e.g. "Primitives.DSTypography" → "primitivesDSTypography")
        r = r.replace(".", "")
        return r[0].lower() + r[1:]

    def _source(dep_branch: str) -> Optional[dict]:
        if dep_branch not in branch_pkg_map:
            return None
        pkg = branch_pkg_map[dep_branch]
        for m in sorted_chain:
            if pkg.startswith(m['package'] + "."):
                return m
        return None

    # Build shadow aliases for chain root classes that collide with nested names
    shadow_aliases: Dict[str, str] = {}
    if leaf_nested_names:
        for meta in sorted_chain:
            rc = meta['root_class']
            # For qualified names (e.g. DSPrimitives.DSTypography), check last component
            last = rc.rsplit(".", 1)[-1]
            if last in leaf_nested_names:
                shadow_aliases[last] = f"_{last}"

    fn_prefix = to_camel_case(product_name) if product_name else ""
    lines: List[str] = ["import SwiftUI", ""]
    if shadow_aliases_collector is not None:
        for meta in sorted_chain:
            rc = meta['root_class']
            last = rc.rsplit(".", 1)[-1]
            alias = f"_{last}"
            if alias in [f"_{k}" for k in shadow_aliases]:
                # Use the full qualified root_class as the target
                shadow_aliases_collector[alias] = rc
    lines.append(f"extension {leaf_root_class} {{")

    for variant_name, mode_map in theme_modes:
        if fn_prefix:
            raw_variant = to_camel_case(sanitize_identifier(variant_name)) if variant_name else to_camel_case(leaf_meta['name'])
            fn_name = _escape_factory_name(_prefixed_fn(raw_variant, fn_prefix))
        else:
            fn_name = _safe_factory_name(variant_name) if variant_name else to_camel_case(leaf_meta['name'])
        lines.append(f"    static func {fn_name}() -> Self {{")

        # Track which collection variables have been computed so far
        computed_vars: Set[str] = set()

        # Build all chain dependencies (let x = ...)
        for meta in sorted_chain:
            vn = _vn(meta)
            mode = mode_map[meta['name']]
            rc = meta['root_class']
            if meta.get('factory_fn_prefix'):
                factory_fn = _escape_factory_name(_prefixed_fn(to_camel_case(sanitize_identifier(mode)), meta['factory_fn_prefix']))
            else:
                factory_fn = _safe_factory_name(mode)
            ext_deps = meta.get('ext_deps', [])

            args: List[str] = []
            for dep in ext_deps:
                src = _source(dep)
                if src and _vn(src) in computed_vars:
                    label = _safe_arg_label(dep)
                    args.append(f"{label}: {_vn(src)}.{label}")
                elif src and _vn(src) not in computed_vars:
                    # Source maps to self or a not-yet-computed collection;
                    # fall back to an earlier computed collection that has the branch.
                    for earlier in sorted_chain:
                        ev = _vn(earlier)
                        if ev in computed_vars and dep in [b for b in earlier.get('branches', [])]:
                            label = _safe_arg_label(dep)
                            args.append(f"{label}: {ev}.{label}")
                            break

            aliased_rc = shadow_aliases.get(rc, rc)
            call = f"{aliased_rc}.{factory_fn}"
            if not args:
                lines.append(f"        let {_safe_prop(vn)} = {call}()")
            elif len(args) <= 3:
                lines.append(f"        let {_safe_prop(vn)} = {call}({', '.join(args)})")
            else:
                lines.append(f"        let {_safe_prop(vn)} = {call}(")
                for a in args:
                    lines.append(f"            {a},")
                lines.append("        )")

            computed_vars.add(vn)

        # Return the leaf factory call with all its ext_deps wired
        leaf_mode = mode_map.get(leaf_meta['name'], 'Value')
        if fn_prefix and not leaf_meta.get('shared_factory'):
            leaf_factory_fn = _escape_factory_name(_prefixed_fn(to_camel_case(sanitize_identifier(leaf_mode)), fn_prefix))
        else:
            leaf_factory_fn = _safe_factory_name(leaf_mode)
        leaf_ext_deps = leaf_meta.get('ext_deps', [])
        leaf_args: List[str] = []
        for dep in leaf_ext_deps:
            src = _source(dep)
            if src and _vn(src) in computed_vars:
                label = _safe_arg_label(dep)
                leaf_args.append(f"{label}: {_vn(src)}.{label}")

        if not leaf_args:
            lines.append(f"        return Self.{leaf_factory_fn}()")
        elif len(leaf_args) <= 3:
            lines.append(f"        return Self.{leaf_factory_fn}({', '.join(leaf_args)})")
        else:
            lines.append(f"        return Self.{leaf_factory_fn}(")
            for a in leaf_args:
                lines.append(f"            {a},")
            lines.append("        )")

        lines.append("    }")
        lines.append("")

    lines.append("}")
    product_pascal = to_pascal_case(product_name) if product_name else ""
    write_file(os.path.join(output_dir, f"{product_pascal}{leaf_root_class}Builder.swift"),
               "\n".join(lines).rstrip() + "\n")
