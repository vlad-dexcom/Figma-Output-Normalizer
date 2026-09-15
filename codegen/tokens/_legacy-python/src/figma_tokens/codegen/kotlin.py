"""Kotlin code generator for design tokens."""
from __future__ import annotations

import os
import shutil
from typing import Any, Dict, List, Optional, Set, Tuple

from ..figma.models import ResolvedToken, TokenType
from ..config import GeneratorConfig
from .base import (
    KOTLIN_KEYWORDS,
    TreeNode,
    TokenGenerator,
    collect_all_tokens,
    escape_string,
    format_color_kotlin,
    format_float_kotlin,
    insert_token,
    kdoc_block,
    kotlin_type,
    sanitize_identifier,
    sanitize_path,
    to_camel_case,
    to_folder_name,
    to_pascal_case,
    write_file,
)

def _prefixed_fn(fn_name: str, prefix: str) -> str:
    """Prepend a product prefix to a function name: stelo + accordions → steloAccordions."""
    if not prefix:
        return fn_name
    return f"{prefix}{fn_name[0].upper()}{fn_name[1:]}"


MAX_MODE_OVERRIDE_PARAMS = 10


def _cls(name: str, prefix: str) -> str:
    """Apply prefix to a class name."""
    return f"{prefix}{to_pascal_case(name)}"


class KotlinGenerator(TokenGenerator):
    """Generates Kotlin files in a folder structure mirroring the Figma variable hierarchy."""

    def __init__(self, package_name: str, root_class_name: str = "DesignTokens", palette_sub_package: str = "primitives"):
        self._package_name = package_name
        self._root_class_name = root_class_name
        self._palette_sub_package = palette_sub_package

    @property
    def language_id(self) -> str:
        return "kotlin"

    def generate(self, tokens: List[ResolvedToken], config: GeneratorConfig) -> None:
        pkg = config.package_name or self._package_name
        root_cls = config.root_class_name or self._root_class_name
        root_class_fqn = config.root_class_fqn or root_cls
        prefix = config.class_prefix
        palette_sub = config.palette_sub_package
        branch_pkg_map = config.branch_package_map or {}
        fn_prefix = config.factory_fn_prefix
        cross_branch = config.cross_branch_deps or {}

        shared_dir = config.shared_output_dir or config.output_dir
        flavor_dir = config.output_dir

        # Map package to directory structure (com.dexcom.tokens → com/dexcom/tokens/)
        pkg_path = pkg.replace(".", os.sep)
        shared_dir = os.path.join(shared_dir, pkg_path)
        flavor_dir = os.path.join(flavor_dir, pkg_path)

        if config.write_shared:
            os.makedirs(shared_dir, exist_ok=True)
        os.makedirs(flavor_dir, exist_ok=True)

        mode_names = list(tokens[0].values.keys()) if tokens else ["Default", "Inverted"]

        # Skip entirely for empty collections (no tokens = no output)
        if not tokens:
            return

        # Build tree
        root = TreeNode("root")
        for token in tokens:
            segments = sanitize_path(token.path)
            insert_token(root, segments, token)

        level1_branches = [n for n in root.sorted_children if n.children]
        level1_leaves = [n for n in root.sorted_children if n.token and not n.children]
        collapsible = {n.name for n in level1_branches if _can_generate_shared_factory(n)}

        # --- Shared output ---
        if config.write_shared:
            if not config.skip_data_classes:
                _gen_root_class(shared_dir, pkg, root_cls, level1_branches, level1_leaves, prefix)

            if not config.skip_data_classes:
                for l1 in level1_branches:
                    folder_name = to_folder_name(l1.name)
                    folder = os.path.join(shared_dir, folder_name)
                    os.makedirs(folder, exist_ok=True)
                    l1_class = _cls(l1.name, prefix)
                    l1_class_ref = l1_class
                    if config.skip_data_classes and l1.name in branch_pkg_map:
                        l1_class_ref = f"{branch_pkg_map[l1.name]}.{l1_class}"
                    sub_pkg = f"{pkg}.{folder_name}"

                    l2_branches = [n for n in l1.sorted_children if n.children]
                    l2_leaves = [n for n in l1.sorted_children if n.token and not n.children]
                    _gen_level1_class(folder, sub_pkg, l1, l1_class, l2_branches, l2_leaves, prefix)

                    if l1.name in collapsible:
                        _gen_collapsed_factory(
                            folder,
                            sub_pkg,
                            l1,
                            l1_class_ref,
                            root,
                            pkg,
                            palette_sub,
                            collapsible,
                            branch_pkg_map,
                            prefix,
                            circular_deps=config.circular_deps,
                            fn_prefix=fn_prefix,
                            cross_branch_deps=cross_branch,
                        )

            # Root factories in shared when no prim deps
            all_branch_names = {n.name for n in level1_branches}
            root_has_prim = _root_has_prim_deps(level1_branches, collapsible)
            root_has_ext = _root_has_external_deps(level1_branches, collapsible, all_branch_names)
            has_cross = bool(cross_branch)
            if not root_has_prim and not root_has_ext and not has_cross:
                for mode in mode_names:
                    _gen_root_factory(shared_dir, pkg, root_cls, root, mode,
                                     level1_branches, level1_leaves, collapsible, palette_sub, branch_pkg_map, prefix,
                                     circular_deps=config.circular_deps, fn_prefix=fn_prefix,
                                     root_class_fqn=root_class_fqn, inline_branches=config.skip_data_classes,
                                     cross_branch_deps=cross_branch)

        # Root factories to flavor when prim deps vary
        all_branch_names = {n.name for n in level1_branches}
        root_has_prim = _root_has_prim_deps(level1_branches, collapsible)
        root_has_ext = _root_has_external_deps(level1_branches, collapsible, all_branch_names)
        has_cross = bool(cross_branch)
        if root_has_prim or root_has_ext or has_cross:
            for mode in mode_names:
                _gen_root_factory(flavor_dir, pkg, root_cls, root, mode,
                                 level1_branches, level1_leaves, collapsible, palette_sub, branch_pkg_map, prefix,
                                 circular_deps=config.circular_deps, fn_prefix=fn_prefix,
                                 root_class_fqn=root_class_fqn, inline_branches=config.skip_data_classes,
                                 cross_branch_deps=cross_branch)

        # Non-collapsible branch factories → flavor
        if not config.skip_data_classes:
            for l1 in level1_branches:
                if l1.name in collapsible:
                    continue
                folder_name = to_folder_name(l1.name)
                folder = os.path.join(flavor_dir, folder_name)
                os.makedirs(folder, exist_ok=True)
                l1_class = _cls(l1.name, prefix)
                l1_class_ref = l1_class
                if config.skip_data_classes and l1.name in branch_pkg_map:
                    l1_class_ref = f"{branch_pkg_map[l1.name]}.{l1_class}"
                sub_pkg = f"{pkg}.{folder_name}"
                for mode in mode_names:
                    _gen_level1_factory(folder, sub_pkg, l1, l1_class_ref, mode, pkg, palette_sub, branch_pkg_map, prefix,
                                        circular_deps=config.circular_deps, fn_prefix=fn_prefix,
                                        cross_branch_deps=cross_branch)


# --- Collapsibility ---

def _can_generate_shared_factory(branch: TreeNode) -> bool:
    tokens = collect_all_tokens(branch)
    if not tokens:
        return False
    varying = [t for t in tokens if _is_varying(t)]
    if not varying:
        return True
    unmatched = sum(1 for t in varying if t.alias_path is None)
    return unmatched <= MAX_MODE_OVERRIDE_PARAMS


def _is_varying(token: ResolvedToken) -> bool:
    vals = list(token.values.values())
    return len(vals) > 1 and not all(v == vals[0] for v in vals)


def _collect_unmatched_varying(branch: TreeNode) -> List[ResolvedToken]:
    return [t for t in collect_all_tokens(branch) if _is_varying(t) and t.alias_path is None]


def _find_dependencies(branch: TreeNode, all_branches: Set[str], collapsible: Set[str]) -> List[str]:
    deps: Set[str] = set()
    own_paths = {t.path for t in collect_all_tokens(branch)}
    for token in collect_all_tokens(branch):
        if token.alias_path:
            top = token.alias_path.split("/")[0]
            if top != branch.name and top not in collapsible:
                deps.add(top)
            elif top == branch.name and token.alias_source and token.alias_path not in own_paths:
                # Same-branch cross-collection reference (e.g. base.borderWidth → primitives.borderWidth)
                deps.add(top)
        if token.alias_by_mode:
            for v in token.alias_by_mode.values():
                top = v.split("/")[0]
                if top != branch.name and top not in collapsible:
                    deps.add(top)
    return sorted(deps)


def _partition_dependencies(deps: List[str], all_branches: Set[str]) -> Tuple[List[str], List[str]]:
    internal = [d for d in deps if d in all_branches]
    external = [d for d in deps if d not in all_branches]
    return internal, external


def _root_has_prim_deps(level1_branches: List[TreeNode], collapsible: Set[str]) -> bool:
    return any(
        l1.name not in collapsible and
        any(t.alias_by_mode for t in collect_all_tokens(l1))
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


# --- Code generation helpers ---

def _fqn(pkg: str, folder: str, cls: str) -> str:
    """Build a fully-qualified class name."""
    return f"{pkg}.{folder}.{cls}"


def _dep_fqn(dep: str, pkg: str, palette_sub: str, branch_pkg_map: Optional[Dict[str, str]], prefix: str) -> str:
    """Resolve the FQN for a dependency branch.

    If branch_pkg_map is provided and contains the dep, uses its mapped package.
    Otherwise falls back to the legacy palette_sub-based resolution.
    """
    dep_folder = to_folder_name(dep)
    dep_class = _cls(dep, prefix)
    if branch_pkg_map and dep in branch_pkg_map:
        return f"{branch_pkg_map[dep]}.{dep_class}"
    palette_prefix = f"{palette_sub}." if palette_sub else ""
    return f"{pkg}.{palette_prefix}{dep_folder}.{dep_class}"


def _safe_prop(name: str) -> str:
    """Wrap property name in backticks if it's a Kotlin keyword."""
    camel = to_camel_case(name)
    return f"`{camel}`" if camel in KOTLIN_KEYWORDS else camel


def _doc_entries(leaves: List[TreeNode]) -> List[Tuple[str, str]]:
    """Collect (propertyName, description) pairs for leaves that are documented."""
    return [
        (to_camel_case(leaf.name), leaf.token.description)  # type: ignore[union-attr]
        for leaf in leaves
        if leaf.token is not None and leaf.token.description
    ]


def _default_scalar_value(token_type: TokenType) -> str:
    if token_type == TokenType.COLOR:
        return "androidx.compose.ui.graphics.Color.Transparent"
    if token_type == TokenType.FLOAT:
        return "0.0f"
    if token_type == TokenType.STRING:
        return '""'
    return "false"


def _gen_root_class(output_dir: str, pkg: str, root_cls: str,
                    branches: List[TreeNode], leaves: List[TreeNode], prefix: str) -> None:
    if not branches and not leaves:
        return  # Skip empty data classes
    lines = [f"package {pkg}", ""]
    lines.extend(kdoc_block(_doc_entries(leaves)))
    lines.append("@androidx.compose.runtime.Immutable")
    lines.append(f"data class {root_cls}(")
    for leaf in leaves:
        prop = _safe_prop(leaf.name)
        ptype = kotlin_type(leaf.token.type)  # type: ignore
        lines.append(f"    val {prop}: {ptype},")
    for l1 in branches:
        prop = _safe_prop(l1.name)
        folder = to_folder_name(l1.name)
        cls = _cls(l1.name, prefix)
        fqn = _fqn(pkg, folder, cls)
        lines.append(f"    val {prop}: {fqn},")
    lines.append(")")
    write_file(os.path.join(output_dir, f"{root_cls}.kt"), "\n".join(lines) + "\n")


def _gen_level1_class(folder: str, sub_pkg: str, node: TreeNode, class_name: str,
                      l2_branches: List[TreeNode], l2_leaves: List[TreeNode], prefix: str) -> None:
    lines = [f"package {sub_pkg}", ""]
    lines.extend(kdoc_block(_doc_entries(l2_leaves)))
    lines.append("@androidx.compose.runtime.Immutable")
    lines.append(f"data class {class_name}(")
    for leaf in l2_leaves:
        prop = _safe_prop(leaf.name)
        ptype = kotlin_type(leaf.token.type)  # type: ignore
        lines.append(f"    val {prop}: {ptype},")
    for branch in l2_branches:
        prop = _safe_prop(branch.name)
        cls = _cls(branch.name, prefix)
        lines.append(f"    val {prop}: {cls},")

    if l2_branches:
        lines.append(") {")
        for branch in l2_branches:
            cls = _cls(branch.name, prefix)
            _gen_class(lines, branch, cls, indent=1, prefix=prefix)
        lines.append("}")
    else:
        lines.append(")")
    write_file(os.path.join(folder, f"{to_pascal_case(node.name)}.kt"), "\n".join(lines) + "\n")


def _gen_subtree_file(folder: str, sub_pkg: str, node: TreeNode, class_name: str, prefix: str) -> None:
    lines = [f"package {sub_pkg}", ""]
    _gen_class(lines, node, class_name, indent=0, prefix=prefix)
    write_file(os.path.join(folder, f"{to_pascal_case(node.name)}.kt"), "\n".join(lines) + "\n")


def _gen_class(lines: List[str], node: TreeNode, class_name: str, indent: int, prefix: str) -> None:
    pad = "    " * indent
    # Node with both token AND children: treat as leaf (token takes priority)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]

    lines.extend(kdoc_block(_doc_entries(leaf_nodes), pad))
    lines.append(f"{pad}@androidx.compose.runtime.Immutable")
    lines.append(f"{pad}data class {class_name}(")
    for leaf in leaf_nodes:
        prop = _safe_prop(leaf.name)
        ptype = kotlin_type(leaf.token.type)  # type: ignore
        lines.append(f"{pad}    val {prop}: {ptype},")
    for branch in branch_nodes:
        prop = _safe_prop(branch.name)
        cls = _cls(branch.name, prefix)
        lines.append(f"{pad}    val {prop}: {cls},")

    if branch_nodes:
        lines.append(f"{pad}) {{")
        for branch in branch_nodes:
            cls = _cls(branch.name, prefix)
            _gen_class(lines, branch, cls, indent + 1, prefix)
        lines.append(f"{pad}}}")
    else:
        lines.append(f"{pad})")


def _format_value(token: ResolvedToken, mode_name: str, pkg: str = "",
                  skip_branches: Optional[Set[str]] = None,
                  cross_deps: Optional[Set[str]] = None) -> str:
    # Per-mode alias (skip references to circular/self branches)
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
        is_cross = cross_deps and top in cross_deps
        if is_cross or (top != token_top and not (skip_branches and top in skip_branches)):
            return _build_token_reference(token.alias_path)
    value = token.values.get(mode_name) or next(iter(token.values.values()))
    if token.type == TokenType.COLOR:
        return format_color_kotlin(value)
    if token.type == TokenType.FLOAT:
        return format_float_kotlin(value)
    if token.type == TokenType.STRING:
        return f'"{escape_string(str(value))}"'
    return str(value).lower()


def _build_token_reference(alias_path: str) -> str:
    segments = sanitize_path(alias_path)
    parts = []
    for seg in segments:
        name = to_camel_case(seg)
        parts.append(f"`{name}`" if name in KOTLIN_KEYWORDS else name)
    return ".".join(parts)


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


# --- Collapsed factory ---

def _gen_collapsed_factory(folder: str, sub_pkg: str, node: TreeNode, class_name: str,
                           root: TreeNode, pkg: str, palette_sub: str, collapsible: Set[str],
                           branch_pkg_map: Optional[Dict[str, str]] = None, prefix: str = "",
                           circular_deps: Optional[Dict[str, Set[str]]] = None,
                           fn_prefix: str = "",
                           cross_branch_deps: Optional[Dict[str, str]] = None) -> None:
    fn_name = _prefixed_fn(to_camel_case(node.name), fn_prefix)
    all_branch_names = set(root.children.keys())
    deps = _find_dependencies(node, all_branch_names, set())

    # Always skip self-references; also filter circular deps
    # But keep cross-collection same-branch deps (they reference a different collection)
    skip: Set[str] = {node.name}
    if circular_deps and node.name in circular_deps:
        skip |= circular_deps[node.name]
    cross = cross_branch_deps or {}
    deps = [d for d in deps if d not in skip or d in cross]

    internal, external = _partition_dependencies(deps, all_branch_names)
    unmatched = _collect_unmatched_varying(node)
    override_params = {t.path: _token_path_to_param_name(t.path, node.name) for t in unmatched}

    # Build dep params with FQN
    dep_params = []
    for dep in deps:
        dep_folder = to_folder_name(dep)
        dep_class = _cls(dep, prefix)
        if dep in cross:
            # Same-branch cross-collection: use source collection's package
            fqn = f"{cross[dep]}.{dep_class}"
        elif branch_pkg_map and dep in branch_pkg_map:
            fqn = f"{branch_pkg_map[dep]}.{dep_class}"
        elif dep in internal:
            fqn = _fqn(pkg, dep_folder, dep_class)
        else:
            fqn = _dep_fqn(dep, pkg, palette_sub, branch_pkg_map, prefix)
        dep_params.append(f"{to_camel_case(dep)}: {fqn}")

    # Override params with FQN types
    override_param_list = [
        f"{override_params[t.path]}: {kotlin_type(t.type)}" for t in unmatched
    ]
    all_params = dep_params + override_param_list

    lines = ['@file:Suppress("LongMethod")', "", f"package {sub_pkg}", ""]

    if len(all_params) <= 2:
        lines.append(f"fun {fn_name}({', '.join(all_params)}): {class_name} =")
    else:
        lines.append(f"fun {fn_name}(")
        for p in all_params:
            lines.append(f"    {p},")
        lines.append(f"): {class_name} =")

    l2_branches = [n for n in node.sorted_children if n.children]
    l2_leaves = [n for n in node.sorted_children if n.token and not n.children]

    # For value formatting, skip self-references EXCEPT cross-collection ones
    fmt_skip = skip - set(cross.keys())

    lines.append(f"    {class_name}(")
    for leaf in l2_leaves:
        prop = _safe_prop(leaf.name)
        val = _format_collapsed_value(leaf.token, root, override_params, skip_branches=fmt_skip)  # type: ignore
        lines.append(f"        {prop} = {val},")
    for branch in l2_branches:
        prop = _safe_prop(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        lines.append(f"        {prop} = {_collapsed_factory_node(branch, child_cls, root, 2, override_params, prefix, skip_branches=fmt_skip)},")
    lines.append("    )")

    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    write_file(os.path.join(folder, f"{fn_prefix_pascal}{to_pascal_case(node.name)}Factory.kt"), "\n".join(lines) + "\n")


def _collapsed_factory_node(node: TreeNode, class_name: str, root: TreeNode,
                            indent: int, override_params: Dict[str, str], prefix: str,
                            skip_branches: Optional[Set[str]] = None) -> str:
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]

    result_lines = [f"{class_name}("]
    for leaf in leaf_nodes:
        prop = _safe_prop(leaf.name)
        val = _format_collapsed_value(leaf.token, root, override_params, skip_branches=skip_branches)  # type: ignore
        result_lines.append(f"{child_pad}{prop} = {val},")
    for branch in branch_nodes:
        prop = _safe_prop(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        result_lines.append(
            f"{child_pad}{prop} = {_collapsed_factory_node(branch, child_cls, root, indent + 1, override_params, prefix, skip_branches=skip_branches)},"
        )
    result_lines.append(f"{pad})")
    return "\n".join(result_lines)


def _format_collapsed_value(token: ResolvedToken, root: TreeNode, override_params: Dict[str, str],
                            skip_branches: Optional[Set[str]] = None) -> str:
    if token.alias_path:
        top = token.alias_path.split("/")[0]
        if not (skip_branches and top in skip_branches):
            return _build_token_reference(token.alias_path)
    param_name = override_params.get(token.path)
    if param_name:
        return param_name
    # Invariant
    value = next(iter(token.values.values()))
    if token.type == TokenType.COLOR:
        return format_color_kotlin(value)
    if token.type == TokenType.FLOAT:
        return format_float_kotlin(value)
    if token.type == TokenType.STRING:
        return f'"{escape_string(str(value))}"'
    return str(value).lower()


# --- Root factory ---

def _gen_root_factory(output_dir: str, pkg: str, root_cls: str, root: TreeNode, mode_name: str,
                      level1_branches: List[TreeNode], level1_leaves: List[TreeNode],
                      collapsible: Set[str], palette_sub: str,
                      branch_pkg_map: Optional[Dict[str, str]] = None, prefix: str = "",
                      circular_deps: Optional[Dict[str, Set[str]]] = None,
                      fn_prefix: str = "", root_class_fqn: str = "",
                      inline_branches: bool = False,
                      cross_branch_deps: Optional[Dict[str, str]] = None) -> None:
    base_fn = f"{root_cls[0].lower()}{root_cls[1:]}{sanitize_identifier(mode_name)}"
    fn_name = _prefixed_fn(base_fn, fn_prefix)
    root_class_ref = root_class_fqn or root_cls
    non_collapsible = [l1 for l1 in level1_branches if l1.name not in collapsible]
    coll_branches = [l1 for l1 in level1_branches if l1.name in collapsible]

    cross = cross_branch_deps or {}
    all_branch_names = {n.name for n in level1_branches}
    # External deps (filter circular)
    prim_deps = []
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

    coll_ext_deps = []
    for l1 in coll_branches:
        l1_circ = circular_deps.get(l1.name, set()) if circular_deps else set()
        deps = _find_dependencies(l1, all_branch_names, collapsible)
        # Filter circular deps
        deps = [d for d in deps if d not in l1_circ]
        _, ext = _partition_dependencies(deps, all_branch_names)
        for d in ext:
            if d not in coll_ext_deps:
                coll_ext_deps.append(d)
        # Also collect alias_by_mode deps from unmatched varying tokens
        for t in _collect_unmatched_varying(l1):
            if t.alias_by_mode:
                for v in t.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in all_branch_names and top not in coll_ext_deps:
                        coll_ext_deps.append(top)

    all_ext = sorted(set(prim_deps + coll_ext_deps))

    # Collect cross-collection same-branch deps (need separate params with source types)
    cross_ext: List[str] = []
    for l1 in coll_branches + non_collapsible:
        for t in collect_all_tokens(l1):
            if t.alias_source and t.alias_path:
                top = t.alias_path.split("/")[0]
                if top in all_branch_names and top in cross and top not in cross_ext:
                    cross_ext.append(top)
    cross_ext.sort()

    # Also collect deps from root-level leaves
    for leaf in level1_leaves:
        if leaf.token:
            if leaf.token.alias_path:
                top = leaf.token.alias_path.split("/")[0]
                if top not in all_branch_names and top not in all_ext:
                    all_ext.append(top)
                    all_ext.sort()
            if leaf.token.alias_by_mode:
                for v in leaf.token.alias_by_mode.values():
                    top = v.split("/")[0]
                    if top not in all_branch_names and top not in all_ext:
                        all_ext.append(top)
                        all_ext.sort()

    lines = [f"package {pkg}", ""]

    # Signature — combine regular ext deps + cross-collection deps
    all_params = []
    for dep in all_ext:
        fqn = _dep_fqn(dep, pkg, palette_sub, branch_pkg_map, prefix)
        all_params.append(f"{to_camel_case(dep)}: {fqn}")
    for dep in cross_ext:
        dep_class = _cls(dep, prefix)
        fqn = f"{cross[dep]}.{dep_class}"
        all_params.append(f"{to_camel_case(dep)}: {fqn}")
    if all_params:
        params = ", ".join(all_params)
    else:
        params = ""

    lines.append(f"fun {fn_name}({params}): {root_class_ref} {{")

    if inline_branches:
        emitted: Set[str] = set()
        remaining = list(level1_branches)
        for _ in range(len(remaining) ** 2 + 1):
            if not remaining:
                break
            nxt = next(
                (l1 for l1 in remaining
                 if all(
                     d in emitted
                     for d in _find_dependencies(l1, all_branch_names, set())
                     if d in all_branch_names
                     and d not in (circular_deps.get(l1.name, set()) if circular_deps else set())
                 )),
                remaining[0],
            )
            remaining.remove(nxt)
            prop = _safe_prop(nxt.name)
            branch_class = _cls(nxt.name, prefix)
            branch_class_ref = (
                f"{branch_pkg_map[nxt.name]}.{branch_class}"
                if branch_pkg_map and nxt.name in branch_pkg_map
                else _fqn(pkg, to_folder_name(nxt.name), branch_class)
            )
            skip = {nxt.name}
            if circular_deps and nxt.name in circular_deps:
                skip |= circular_deps[nxt.name]
            fmt_skip = skip - set(cross.keys())
            cross_keys = set(cross.keys()) if cross else None
            factory_str = _gen_factory_inline(
                nxt,
                branch_class_ref,
                mode_name,
                indent=1,
                prefix=prefix,
                skip_branches=fmt_skip,
                cross_deps=cross_keys,
            )
            lines.append(f"    val {prop} = {factory_str}")
            emitted.add(nxt.name)

        lines.append(f"    return {root_class_ref}(")
        for leaf in level1_leaves:
            prop = _safe_prop(leaf.name)
            val = _format_value(leaf.token, mode_name)  # type: ignore
            lines.append(f"        {prop} = {val},")
        for l1 in level1_branches:
            prop = _safe_prop(l1.name)
            lines.append(f"        {prop} = {prop},")
        lines.append("    )")
        lines.append("}")

        fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
        file_name = f"{fn_prefix_pascal}{root_cls}{sanitize_identifier(mode_name)}.kt"
        write_file(os.path.join(output_dir, file_name), "\n".join(lines) + "\n")
        return

    # Non-collapsible locals
    for l1 in non_collapsible:
        prop = _safe_prop(l1.name)
        folder = to_folder_name(l1.name)
        l1_fn = _prefixed_fn(f"{prop}{sanitize_identifier(mode_name)}", fn_prefix)
        l1_tokens = collect_all_tokens(l1)
        l1_circ = circular_deps.get(l1.name, set()) if circular_deps else set()
        l1_skip = {l1.name} | l1_circ
        l1_prim = []
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
                elif top in l1_skip and t.alias_source and top in cross and top not in l1_prim:
                    l1_prim.append(top)
        args = ", ".join(to_camel_case(d) for d in l1_prim)
        lines.append(f"    val {prop} = {pkg}.{folder}.{l1_fn}({args})")

    # Collapsible with deps (topological)
    collapsible_names = {l1.name for l1 in coll_branches}
    depended_on: Set[str] = set()
    has_sib_deps: Set[str] = set()
    for l1 in coll_branches:
        deps = _find_dependencies(l1, all_branch_names, set())
        sib = [d for d in deps if d in collapsible_names]
        if sib:
            has_sib_deps.add(l1.name)
            depended_on.update(sib)

    needs_local = has_sib_deps | depended_on
    as_locals = [l1 for l1 in coll_branches if l1.name in needs_local]
    inline = [l1 for l1 in coll_branches if l1.name not in needs_local]

    # Topological sort
    emitted: Set[str] = set()
    remaining = list(as_locals)
    for _ in range(len(remaining) ** 2 + 1):
        if not remaining:
            break
        nxt = next(
            (l1 for l1 in remaining
             if all(d in emitted for d in _find_dependencies(l1, all_branch_names, set())
                    if d in collapsible_names)),
            remaining[0],
        )
        remaining.remove(nxt)
        prop = _safe_prop(nxt.name)
        folder = to_folder_name(nxt.name)
        prefixed_prop = _prefixed_fn(prop, fn_prefix)
        fqn = f"{pkg}.{folder}.{prefixed_prop}"
        deps = _find_dependencies(nxt, all_branch_names, set())
        # Filter circular deps (they're resolved to literals in the collapsed factory)
        # Keep cross-collection same-branch deps (they reference a different collection)
        if circular_deps and nxt.name in circular_deps:
            deps = [d for d in deps if d not in circular_deps[nxt.name] and (d != nxt.name or d in cross)]
        dep_args = [to_camel_case(d) for d in deps]
        unmatched = _collect_unmatched_varying(nxt)
        override_args = [_format_value(t, mode_name) for t in unmatched]
        all_args = dep_args + override_args
        if len(all_args) <= 2:
            lines.append(f"    val {prop} = {fqn}({', '.join(all_args)})")
        else:
            lines.append(f"    val {prop} = {fqn}(")
            for a in all_args:
                lines.append(f"        {a},")
            lines.append("    )")
        emitted.add(nxt.name)

    # Return
    lines.append(f"    return {root_class_ref}(")
    for leaf in level1_leaves:
        prop = _safe_prop(leaf.name)
        val = _format_value(leaf.token, mode_name)  # type: ignore
        lines.append(f"        {prop} = {val},")
    for l1 in non_collapsible:
        prop = _safe_prop(l1.name)
        lines.append(f"        {prop} = {prop},")
    for l1 in as_locals:
        prop = _safe_prop(l1.name)
        lines.append(f"        {prop} = {prop},")
    for l1 in inline:
        prop = _safe_prop(l1.name)
        folder = to_folder_name(l1.name)
        prefixed_prop = _prefixed_fn(prop, fn_prefix)
        fqn = f"{pkg}.{folder}.{prefixed_prop}"
        deps = _find_dependencies(l1, all_branch_names, set())
        if circular_deps and l1.name in circular_deps:
            deps = [d for d in deps if d not in circular_deps[l1.name] and (d != l1.name or d in cross)]
        dep_args = [to_camel_case(d) for d in deps]
        unmatched = _collect_unmatched_varying(l1)
        override_args = [_format_value(t, mode_name) for t in unmatched]
        all_args = dep_args + override_args
        if len(all_args) <= 2:
            lines.append(f"        {prop} = {fqn}({', '.join(all_args)}),")
        else:
            lines.append(f"        {prop} = {fqn}(")
            for a in all_args:
                lines.append(f"            {a},")
            lines.append("        ),")
    lines.append("    )")
    lines.append("}")

    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    file_name = f"{fn_prefix_pascal}{root_cls}{sanitize_identifier(mode_name)}.kt"
    write_file(os.path.join(output_dir, file_name), "\n".join(lines) + "\n")


# --- Level-1 factory ---

def _gen_level1_factory(folder: str, sub_pkg: str, node: TreeNode, class_name: str,
                        mode_name: str, pkg: str, palette_sub: str,
                        branch_pkg_map: Optional[Dict[str, str]] = None, prefix: str = "",
                        circular_deps: Optional[Dict[str, Set[str]]] = None,
                        fn_prefix: str = "",
                        cross_branch_deps: Optional[Dict[str, str]] = None) -> None:
    fn_name = _prefixed_fn(f"{to_camel_case(node.name)}{sanitize_identifier(mode_name)}", fn_prefix)
    l2_branches = [n for n in node.sorted_children if n.children]
    l2_leaves = [n for n in node.sorted_children if n.token and not n.children]

    cross = cross_branch_deps or {}
    all_tokens = collect_all_tokens(node)
    prim_deps = []
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
            elif top == node.name and t.alias_source and top not in prim_deps:
                prim_deps.append(top)

    # Build skip set: self + circular deps for this branch
    skip = {node.name}
    if circular_deps and node.name in circular_deps:
        skip |= circular_deps[node.name]
    # Remove circular deps from params, but keep cross-collection same-branch deps
    prim_deps = [d for d in prim_deps if d not in skip or d in cross]

    lines = ['@file:Suppress("LongMethod")', "", f"package {sub_pkg}", ""]

    if prim_deps:
        dep_strs = []
        for dep in prim_deps:
            if dep in cross:
                dep_class = _cls(dep, prefix)
                fqn = f"{cross[dep]}.{dep_class}"
            else:
                fqn = _dep_fqn(dep, pkg, palette_sub, branch_pkg_map, prefix)
            dep_strs.append(f"{to_camel_case(dep)}: {fqn}")
        params = ", ".join(dep_strs)
    else:
        params = ""

    lines.append(f"fun {fn_name}({params}): {class_name} =")
    lines.append(f"    {class_name}(")
    # For value formatting, exclude cross-collection deps from skip_branches
    fmt_skip = skip - set(cross.keys())
    cross_keys = set(cross.keys()) if cross else None
    for leaf in l2_leaves:
        prop = _safe_prop(leaf.name)
        val = _format_value(leaf.token, mode_name, skip_branches=fmt_skip, cross_deps=cross_keys)  # type: ignore
        lines.append(f"        {prop} = {val},")
    for branch in l2_branches:
        prop = _safe_prop(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        factory_str = _gen_factory_inline(branch, child_cls, mode_name, indent=2, prefix=prefix, skip_branches=fmt_skip, cross_deps=cross_keys)
        lines.append(f"        {prop} = {factory_str},")
    lines.append("    )")

    fn_prefix_pascal = to_pascal_case(fn_prefix) if fn_prefix else ""
    file_name = f"{fn_prefix_pascal}{to_pascal_case(node.name)}{sanitize_identifier(mode_name)}.kt"
    write_file(os.path.join(folder, file_name), "\n".join(lines) + "\n")


def _gen_factory_inline(node: TreeNode, class_name: str, mode_name: str, indent: int, prefix: str,
                        skip_branches: Optional[Set[str]] = None,
                        cross_deps: Optional[Set[str]] = None) -> str:
    pad = "    " * indent
    child_pad = "    " * (indent + 1)
    leaf_nodes = [n for n in node.sorted_children if n.token and not n.children]
    branch_nodes = [n for n in node.sorted_children if n.children]

    result = [f"{class_name}("]
    for leaf in leaf_nodes:
        prop = _safe_prop(leaf.name)
        val = _format_value(leaf.token, mode_name, skip_branches=skip_branches, cross_deps=cross_deps)  # type: ignore
        result.append(f"{child_pad}{prop} = {val},")
    for branch in branch_nodes:
        prop = _safe_prop(branch.name)
        child_cls = f"{class_name}.{_cls(branch.name, prefix)}"
        result.append(f"{child_pad}{prop} = {_gen_factory_inline(branch, child_cls, mode_name, indent + 1, prefix, skip_branches=skip_branches, cross_deps=cross_deps)},")
    result.append(f"{pad})")
    return "\n".join(result)


# --- Builder generation ---

def generate_builder(
    output_dir: str,
    root_package: str,
    leaf_meta: dict,
    sorted_chain: List[dict],
    branch_pkg_map: Dict[str, str],
    theme_modes: List[Tuple[str, Dict[str, str]]],
    prefix: str = "",
    product_name: str = "",
) -> None:
    """Generate a builder file that wires multiple collections together.

    Each collection in ``sorted_chain`` is a dict with keys:
    name, root_class, package, ext_deps (sorted branch names from other collections).

    ``theme_modes`` is a list of ``(variant_name, {coll_name: mode_name})`` tuples.
    One builder function is emitted per variant.

    ``product_name`` — when set, the builder functions/file are product-prefixed
    (e.g. ``steloComponentsDefault`` and ``SteloComponentsBuilder.kt``), while the
    shared leaf collection factory remains unprefixed.
    """
    leaf_root_class = leaf_meta['root_class']
    rc = leaf_root_class
    if prefix and rc.startswith(prefix):
        rc = rc[len(prefix):]
    leaf_camel = rc[0].lower() + rc[1:]

    pkg_path = root_package.replace(".", os.sep)
    out_dir = os.path.join(output_dir, pkg_path)
    os.makedirs(out_dir, exist_ok=True)

    def _vn(meta: dict) -> str:
        r = meta['root_class']
        if prefix and r.startswith(prefix):
            r = r[len(prefix):]
        return r[0].lower() + r[1:]

    def _source(dep_branch: str) -> Optional[dict]:
        if dep_branch not in branch_pkg_map:
            return None
        pkg = branch_pkg_map[dep_branch]
        for m in sorted_chain:
            if pkg.startswith(m['package'] + "."):
                return m
        return None

    # Product prefix for builder function names/file names
    fn_prefix = to_camel_case(product_name) if product_name else ""

    lines: List[str] = [f"package {root_package}", ""]

    # Imports
    imports: Set[str] = set()
    imports.add(f"{leaf_meta['package']}.{leaf_root_class}")
    for _, mode_map in theme_modes:
        for meta in sorted_chain:
            mode = mode_map[meta['name']]
            vn = _vn(meta)
            fn = f"{vn}{sanitize_identifier(mode)}"
            imports.add(f"{meta['package']}.{fn}")
        # Import the leaf factory
        if leaf_meta['name'] in mode_map:
            leaf_mode = mode_map[leaf_meta['name']]
            leaf_fn = f"{leaf_camel}{sanitize_identifier(leaf_mode)}"
            imports.add(f"{leaf_meta['package']}.{leaf_fn}")
    for imp in sorted(imports):
        lines.append(f"import {imp}")
    lines.append("")

    for variant_name, mode_map in theme_modes:
        if product_name:
            base_fn_name = f"{leaf_camel}{sanitize_identifier(variant_name)}" if variant_name else leaf_camel
            fn_name = _prefixed_fn(base_fn_name, fn_prefix)
        else:
            fn_name = f"{leaf_camel}{sanitize_identifier(variant_name)}" if variant_name else leaf_camel
        lines.append(f"fun {fn_name}(): {leaf_root_class} {{")

        # Track which collection variables have been computed so far
        computed_vars: Set[str] = set()

        # Build all chain dependencies (val x = ...)
        for meta in sorted_chain:
            vn = _vn(meta)
            mode = mode_map[meta['name']]
            factory_fn = f"{vn}{sanitize_identifier(mode)}"
            ext_deps = meta.get('ext_deps', [])

            args: List[str] = []
            for dep in ext_deps:
                src = _source(dep)
                if src and _vn(src) in computed_vars:
                    args.append(f"{to_camel_case(dep)} = {_vn(src)}.{_safe_prop(dep)}")
                elif src and _vn(src) not in computed_vars:
                    # Source maps to self or a not-yet-computed collection;
                    # fall back to an earlier computed collection that has the branch.
                    for earlier in sorted_chain:
                        ev = _vn(earlier)
                        if ev in computed_vars and dep in [b for b in earlier.get('branches', [])]:
                            args.append(f"{to_camel_case(dep)} = {ev}.{_safe_prop(dep)}")
                            break

            if not args:
                lines.append(f"    val {vn} = {factory_fn}()")
            elif len(args) <= 3:
                lines.append(f"    val {vn} = {factory_fn}({', '.join(args)})")
            else:
                lines.append(f"    val {vn} = {factory_fn}(")
                for a in args:
                    lines.append(f"        {a},")
                lines.append("    )")

            computed_vars.add(vn)

        # Return the leaf factory call with all its ext_deps wired
        leaf_mode = mode_map.get(leaf_meta['name'], 'Value')
        leaf_factory_fn = f"{leaf_camel}{sanitize_identifier(leaf_mode)}"
        leaf_ext_deps = leaf_meta.get('ext_deps', [])
        leaf_args: List[str] = []
        for dep in leaf_ext_deps:
            src = _source(dep)
            if src and _vn(src) in computed_vars:
                leaf_args.append(f"{to_camel_case(dep)} = {_vn(src)}.{_safe_prop(dep)}")

        if not leaf_args:
            lines.append(f"    return {leaf_factory_fn}()")
        elif len(leaf_args) <= 3:
            lines.append(f"    return {leaf_factory_fn}({', '.join(leaf_args)})")
        else:
            lines.append(f"    return {leaf_factory_fn}(")
            for a in leaf_args:
                lines.append(f"        {a},")
            lines.append("    )")

        lines.append("}")
        lines.append("")

    product_pascal = to_pascal_case(product_name) if product_name else ""
    write_file(os.path.join(out_dir, f"{product_pascal}{leaf_root_class}Builder.kt"),
               "\n".join(lines).rstrip() + "\n")
