"""CLI entry point for figma-tokens generator."""
from __future__ import annotations

import json
import os
import shutil
import sys
from typing import Any, Dict, List, Optional, Set

import click

from .config import (
    AppConfig,
    CollectionFilter,
    GeneratorConfig,
    load_collection_filter,
    load_config,
    resolve_token,
)
from .figma.client import FigmaClient
from .figma.models import CollectionMeta, FigmaCollection, FigmaVariable, ResolvedToken
from .pipeline.resolver import TokenResolver
from .pipeline.enricher import EnrichmentResult, TokenEnricher
from .pipeline.intermediate import build_intermediate_json, load_intermediate_json, save_intermediate_json
from .codegen.base import to_camel_case, to_folder_name, to_pascal_case
from .codegen.kotlin import KotlinGenerator
from .codegen.swift import SwiftGenerator
from .graph.collections import (
    build_branch_maps,
    build_dependency_graph,
    classify_collections,
    detect_circular_deps,
    detect_leaves,
    find_product_groups,
)
from .graph.dependencies import compute_builder_chain, compute_theme_modes


# JSON artifacts (figma-raw.json / tokens.json) always live in tools/figma-tokens/json,
# never next to the generated source output.
TOOL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_JSON_DIR = os.path.join(TOOL_ROOT, "json")


def _info(msg: str) -> None:
    print(f"[INFO] {msg}", flush=True)


def _warn(msg: str) -> None:
    print(f"[WARN] {msg}", flush=True)


@click.command()
@click.option("--config", "config_path", default=None, help="Path to config file (TOML or JSON)")
@click.option("--token", default=None, help="Figma API token")
@click.option("--token-file", default=None, help="Path to file containing Figma API token")
@click.option("--file-key", default=None, help="Figma file key")
@click.option("--language", default=None, type=click.Choice(["swift", "kotlin"]), help="Target language")
@click.option("--output", default=None, help="Output directory")
@click.option("--package", default=None, help="Package/module name")
@click.option("--root-class", default=None, help="Root class/struct name")
@click.option("--prefix", default=None, help="Prefix for all generated class/struct names")
@click.option("--save-intermediate", default=None, hidden=True, help="(deprecated, always saves to output/json/)")
@click.option("--from-intermediate", "from_intermediate", default=None, help="Generate code from saved intermediate JSON (skips Figma fetch)")
@click.option("--shared-output", default=None, help="Shared output directory (defaults to --output)")
@click.option("--write-shared/--no-write-shared", default=None, help="Write shared output")
@click.option("--json-output", "json_output", default=None, help="Directory to save intermediate/raw JSON (defaults to tools/figma-tokens/json)")
@click.option("--collections-config", "collections_config", default=None, help="Path to the collection exclusion config (defaults to tools/figma-tokens/configs/collections.toml)")
@click.option("--dry-run", is_flag=True, default=False, help="Show what would be generated without writing")
def main(
    config_path: Optional[str],
    token: Optional[str],
    token_file: Optional[str],
    file_key: Optional[str],
    language: Optional[str],
    output: Optional[str],
    package: Optional[str],
    root_class: Optional[str],
    prefix: Optional[str],
    save_intermediate: Optional[str],
    from_intermediate: Optional[str],
    shared_output: Optional[str],
    write_shared: Optional[bool],
    json_output: Optional[str],
    collections_config: Optional[str],
    dry_run: bool,
) -> None:
    """Generate Swift/Kotlin design token code from Figma variables."""
    # Load config
    cfg: Dict[str, Any] = {}
    if config_path:
        if not os.path.exists(config_path):
            click.echo(f"Error: Config file not found: {config_path}", err=True)
            sys.exit(1)
        cfg = load_config(config_path)
        _info(f"Loaded config from {config_path}")

    # Merge CLI flags over config
    file_key = file_key or cfg.get("file-key") or cfg.get("file_key")
    language = language or cfg.get("language")
    output = output or cfg.get("output")
    package = package or cfg.get("package", "DesignTokens")
    root_class = root_class or cfg.get("root-class") or cfg.get("root_class", "DesignTokens")
    prefix = prefix or cfg.get("prefix", "")
    shared_output = shared_output or cfg.get("shared-output") or cfg.get("shared_output") or output
    token = token or cfg.get("token")
    token_file = token_file or cfg.get("token-file") or cfg.get("token_file")
    json_output = json_output or cfg.get("json-output") or cfg.get("json_output")
    collections_config = (
        collections_config
        or cfg.get("collections-config")
        or cfg.get("collections_config")
    )
    if write_shared is None:
        write_shared = cfg.get("write-shared", cfg.get("write_shared", True))

    # Validate
    if not from_intermediate and not file_key:
        click.echo("Error: --file-key is required (or use --from-intermediate)", err=True)
        sys.exit(1)
    if not language:
        click.echo("Error: --language is required", err=True)
        sys.exit(1)
    if not output:
        click.echo("Error: --output is required", err=True)
        sys.exit(1)
    json_output = json_output or DEFAULT_JSON_DIR
    # Keep JSON artifacts inside the tool directory even when invoked from elsewhere
    if not os.path.isabs(json_output):
        json_output = os.path.normpath(os.path.join(TOOL_ROOT, json_output))

    # Collections excluded from generation (git-tracked config)
    collection_filter = load_collection_filter(collections_config)
    if collection_filter.exclude:
        _info(
            f"Excluding collections matching {collection_filter.exclude} "
            f"(from {collection_filter.source})"
        )
    if collection_filter.exclude_branches:
        _info(
            f"Excluding branches matching {collection_filter.exclude_branches} "
            f"(from {collection_filter.source})"
        )

    # If loading from intermediate JSON, skip Figma fetch + resolve entirely
    if from_intermediate:
        _info(f"Loading intermediate JSON from: {from_intermediate}")
        intermediate = load_intermediate_json(from_intermediate)
        _generate_from_intermediate(
            intermediate, language, output, package, prefix,
            shared_output or output, write_shared if write_shared is not None else True,
            dry_run, collection_filter,
        )
        _info("Done.")
        return

    # Fetch data from Figma API
    resolved_tok = resolve_token(token, token_file)
    client = FigmaClient(resolved_tok)
    _info(f"Fetching variables from Figma file: {file_key}")
    variables, collections = client.get_local_variables(file_key)

    # Save raw Figma JSON to json_output/
    if not dry_run:
        json_dir = json_output
        os.makedirs(json_dir, exist_ok=True)
        raw = client.get_local_variables_raw(file_key)
        raw_path = os.path.join(json_dir, "figma-raw.json")
        with open(raw_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2, ensure_ascii=False)
        _info(f"Saved raw Figma JSON to: {raw_path}")

    # Discover visible collections
    visible = [c for c in collections.values() if not c.hidden_from_publishing]
    all_names = sorted({c.name for c in visible})
    all_names, excluded_names = collection_filter.partition(all_names)
    if excluded_names:
        _info(f"Skipped {len(excluded_names)} excluded collection(s): {', '.join(excluded_names)}")
    _info(f"Found {len(all_names)} collections: {', '.join(all_names)}")

    # Initialize pipeline
    resolver = TokenResolver(_info, _warn)
    enricher = TokenEnricher(_info, _warn)

    if language == "swift":
        generator = SwiftGenerator()
    else:
        generator = KotlinGenerator(package, root_class)

    # Phase 1: Resolve all collections (without enrichment first)
    coll_mode_counts = {c.name: len(c.modes) for c in collections.values()}
    # Initial primitive candidates: single-mode collections (refined after classification)
    initial_prim_candidates = [n for n in all_names if coll_mode_counts.get(n, 2) <= 1]

    resolved_collections: Dict[str, EnrichmentResult] = {}
    failures: List[str] = []

    for coll_name in all_names:
        try:
            coll_tokens = resolver.resolve(variables, collections, coll_name)
            # First pass: just resolve, no enrichment yet
            resolved_collections[coll_name] = EnrichmentResult(
                tokens=coll_tokens, primitive_total=0,
                intra_collection_matched=0, intra_collection_unmatched=0,
                primitive_matched=0,
            )
        except Exception as e:
            _warn(f"FAILED collection '{coll_name}': {e}")
            failures.append(coll_name)

    if failures:
        click.echo(
            f"Error: {len(failures)} collection(s) failed to resolve: {', '.join(failures)}",
            err=True,
        )
        sys.exit(1)

    # Aliases into excluded collections/branches would reference classes that are
    # never generated — drop the reference and keep the already-resolved literal value.
    if collection_filter.has_rules:
        _warn_unmatched_patterns(collection_filter, all_names, excluded_names, resolved_collections)
        _drop_excluded_branches(resolved_collections, collection_filter)
        _strip_excluded_aliases(resolved_collections, collection_filter)

    # Phase 2: Classify collections structurally
    metas = classify_collections(collections, resolved_collections, package, prefix)
    branch_pkg_map, branch_root_map = build_branch_maps(metas)
    circular_deps = detect_circular_deps(metas, resolved_collections)
    coll_deps = build_dependency_graph(metas)
    leaves = detect_leaves(metas, coll_deps)
    product_groups = find_product_groups(metas)

    # Phase 3: Enrich non-primitive collections (now that we know roles)
    primitive_candidates = [
        n for n in all_names
        if coll_mode_counts.get(n, 2) <= 1 and metas[n].role in ("primitive", "semantic")
    ]
    for coll_name in all_names:
        if coll_name in primitive_candidates:
            continue  # Primitives don't need enrichment
        tokens = resolved_collections[coll_name].tokens
        if not tokens:
            continue
        enriched = enricher.enrich(
            tokens, variables, collections, primitive_candidates, resolver
        )
        resolved_collections[coll_name] = enriched

    _info(f"Classification: {sum(1 for m in metas.values() if m.role == 'primitive')} primitive, "
          f"{sum(1 for m in metas.values() if m.role == 'semantic')} semantic, "
          f"{sum(1 for m in metas.values() if m.role == 'product')} product, "
          f"{len(leaves)} leaf")

    if circular_deps:
        _info(f"Circular deps: {circular_deps}")

    # Phase 3: Validate alias references
    _validate_aliases(resolved_collections, metas, branch_pkg_map, product_groups)

    # Phase 4: Update Swift metadata for product collections (fix stale metadata issue)
    if language == "swift":
        for name, meta in metas.items():
            if meta.role == "product" and meta.base_collection:
                base_meta = metas[meta.base_collection]
                meta.root_class = base_meta.root_class
                meta.factory_fn_prefix = to_camel_case(name)
    # Mark leaf collections as having shared factories when they depend on product groups
    for leaf in leaves:
        leaf_dep_colls = coll_deps[leaf]
        for _bs, group_colls in product_groups.items():
            if any(pc in leaf_dep_colls for pc in group_colls):
                metas[leaf].shared_factory = True
                break

    # Phase 4b: Fill product trees with missing base tokens
    # Products reuse base data classes but may have fewer tokens. Fill gaps so factories compile.
    for name, meta in metas.items():
        if meta.role == "product" and meta.base_collection:
            base_tokens = resolved_collections[meta.base_collection].tokens
            product_tokens = resolved_collections[name].tokens
            product_paths = {t.path for t in product_tokens}
            base_mode_names = list(base_tokens[0].values.keys()) if base_tokens else []
            prod_mode_names = list(product_tokens[0].values.keys()) if product_tokens else []
            # Map base modes to product modes by position (both have same mode count)
            mode_map = dict(zip(base_mode_names, prod_mode_names)) if len(base_mode_names) == len(prod_mode_names) else {}
            added = 0
            for bt in base_tokens:
                if bt.path not in product_paths:
                    # Use base values, remapped to product mode names
                    if mode_map:
                        remapped_values = {mode_map[bm]: v for bm, v in bt.values.items() if bm in mode_map}
                    else:
                        remapped_values = bt.values
                    product_tokens.append(ResolvedToken(
                        path=bt.path, type=bt.type, values=remapped_values,
                        alias_path=bt.alias_path, alias_by_mode=bt.alias_by_mode,
                        description=bt.description,
                    ))
                    added += 1
            if added:
                _info(f"Filled {added} missing tokens in '{name}' from '{meta.base_collection}'")
                resolved_collections[name] = EnrichmentResult(
                    tokens=product_tokens,
                    primitive_total=resolved_collections[name].primitive_total,
                    intra_collection_matched=resolved_collections[name].intra_collection_matched,
                    intra_collection_unmatched=resolved_collections[name].intra_collection_unmatched,
                    primitive_matched=resolved_collections[name].primitive_matched,
                )

    # Recompute ext_deps after stripping (classification ran before strip)
    for name, meta in metas.items():
        ext_deps: List[str] = []
        own_paths = {t.path for t in resolved_collections[name].tokens}
        for tok in resolved_collections[name].tokens:
            if tok.alias_by_mode:
                for v in tok.alias_by_mode.values():
                    d = v.split("/")[0]
                    if d not in meta.branches and d not in ext_deps:
                        ext_deps.append(d)
            if tok.alias_path:
                d = tok.alias_path.split("/")[0]
                if d not in meta.branches and d not in ext_deps:
                    ext_deps.append(d)
                elif d in meta.branches and tok.alias_source and d not in ext_deps and tok.alias_path not in own_paths:
                    # Cross-collection same-branch dep with different paths
                    ext_deps.append(d)
        meta.ext_deps = sorted(ext_deps)

    # Phase 5: Clean output directories
    if not dry_run:
        _clean_output(output, package, language, all_names, metas)

    # Phase 6: Generate code per collection
    # Pre-pass (Swift only): detect sub-collection name collisions with parent branches
    parent_branch_renames: Dict[str, Dict[str, str]] = {}  # parent_coll → {branch: renamed_class}
    global_branch_renames: Dict[str, str] = {}  # flat: branch_name → renamed_class
    shadow_aliases_collector: Optional[Dict[str, str]] = {} if language == "swift" else None
    if language == "swift":
        for coll_name, meta in metas.items():
            for other_name, other_meta in metas.items():
                if other_name != coll_name and coll_name in other_meta.branches:
                    # Sub-collection 'coll_name' shares name with a branch in 'other_name'
                    renamed = f"{prefix}{to_pascal_case(coll_name)}Tokens"
                    parent_branch_renames.setdefault(other_name, {})[coll_name] = renamed
                    global_branch_renames[coll_name] = renamed
    coll_configs: Dict[str, Any] = {}  # Store configs for builder reference
    for coll_name, enriched in resolved_collections.items():
        meta = metas[coll_name]
        _info(f"Generating: {coll_name} (role={meta.role})")

        skip_data_classes = meta.role == "product"
        root_class_fqn = ""
        coll_branch_pkg_map = dict(branch_pkg_map)
        coll_branch_root_map = dict(branch_root_map)

        if meta.base_collection:
            base_meta = metas[meta.base_collection]
            root_class_fqn = f"{base_meta.package}.{base_meta.root_class}"
            # For products: use base's branch packages for shared branches
            for branch in base_meta.branches:
                bf = to_folder_name(branch)
                coll_branch_pkg_map[branch] = f"{base_meta.package}.{bf}"
                coll_branch_root_map[branch] = base_meta.root_class

        effective_shared_output = shared_output if shared_output else output

        # Compute cross-branch deps: branch→source_pkg for same-branch cross-collection aliases
        # Only include when alias target paths differ from own paths (otherwise it's self-referential)
        coll_cross_branch: Dict[str, str] = {}
        own_branches = set(meta.branches)
        own_paths = {t.path for t in enriched.tokens}
        for tok in enriched.tokens:
            if tok.alias_source and tok.alias_path:
                top = tok.alias_path.split("/")[0]
                if top in own_branches and tok.alias_source in metas and tok.alias_path not in own_paths:
                    src_meta = metas[tok.alias_source]
                    src_sub_pkg = f"{src_meta.package}.{to_folder_name(top)}"
                    coll_cross_branch[top] = src_sub_pkg

        if language == "kotlin":
            coll_config = GeneratorConfig(
                output_dir=output,
                package_name=meta.package,
                root_class_name=meta.root_class,
                root_class_fqn=root_class_fqn,
                shared_output_dir=effective_shared_output,
                write_shared=write_shared if write_shared is not None else True,
                palette_sub_package="",
                class_prefix=prefix,
                branch_package_map=coll_branch_pkg_map,
                branch_root_class_map=coll_branch_root_map,
                circular_deps=circular_deps,
                skip_data_classes=skip_data_classes,
                cross_branch_deps=coll_cross_branch or None,
            )
        else:
            if skip_data_classes and meta.base_collection:
                base_meta = metas[meta.base_collection]
                coll_output = os.path.join(output, to_pascal_case(meta.base_collection))
                swift_root_class = base_meta.root_class
                swift_fn_prefix = meta.factory_fn_prefix
            else:
                coll_output = os.path.join(output, to_pascal_case(coll_name))
                swift_root_class = meta.root_class
                swift_fn_prefix = ""
                # If this collection's name is a branch of another collection,
                # qualify the root class with the parent collection's root class
                for other_name, other_meta in metas.items():
                    if other_name != coll_name and coll_name in other_meta.branches:
                        parent_cls = other_meta.root_class
                        swift_root_class = f"{parent_cls}.{meta.root_class}"
                        coll_output = os.path.join(output, to_pascal_case(other_name))
                        break
            # For Swift, cross_branch_deps maps branch → source root class name
            swift_cross_branch: Dict[str, str] = {}
            for top, _pkg in coll_cross_branch.items():
                # Find the source collection and use its root class
                for tok in enriched.tokens:
                    if tok.alias_source and tok.alias_path and tok.alias_path.split("/")[0] == top:
                        if tok.alias_source in metas:
                            swift_cross_branch[top] = metas[tok.alias_source].root_class
                            break
            coll_config = GeneratorConfig(
                output_dir=coll_output,
                package_name=package,
                root_class_name=swift_root_class,
                shared_output_dir=coll_output,
                write_shared=write_shared if write_shared is not None else True,
                palette_sub_package="",
                class_prefix=prefix,
                branch_package_map=coll_branch_pkg_map,
                branch_root_class_map=coll_branch_root_map,
                circular_deps=circular_deps,
                skip_data_classes=skip_data_classes,
                factory_fn_prefix=swift_fn_prefix,
                cross_branch_deps=swift_cross_branch or None,
                shadow_aliases_collector=shadow_aliases_collector,
                branch_class_renames=parent_branch_renames.get(coll_name),
                global_branch_renames=global_branch_renames or None,
            )

        if not dry_run:
            generator.generate(enriched.tokens, coll_config)
            coll_configs[coll_name] = coll_config

    # Phase 7: Generate builders for leaf collections
    builder_specs: List[Dict[str, Any]] = []
    for leaf in leaves:
        leaf_dep_colls = coll_deps[leaf]
        product_colls: List[str] = []
        for _bs, group_colls in product_groups.items():
            if any(pc in leaf_dep_colls for pc in group_colls):
                product_colls = group_colls
                break

        builder_products = product_colls if product_colls else [""]
        for product_coll in builder_products:
            # Product-specific branch_pkg_map: override shared branches with product's package
            if product_coll:
                prod_bpm = dict(branch_pkg_map)
                pc_meta = metas[product_coll]
                pc_ext = set(pc_meta.ext_deps) if pc_meta.ext_deps else set()
                for branch in pc_meta.branches:
                    # Don't override branches that are ext_deps of the product
                    # collection — those come from earlier collections in the chain
                    if branch in pc_ext:
                        continue
                    bf = to_folder_name(branch)
                    prod_bpm[branch] = f"{pc_meta.package}.{bf}"
            else:
                prod_bpm = dict(branch_pkg_map)

            # Override branch_pkg_map for cross-collection same-branch deps
            # so builder's _source() finds the actual source collection, not self
            # Only process the leaf's own tokens — chain deps have their own
            # internal aliases that should not override the builder's mapping.
            for cn in [leaf]:
                if cn not in resolved_collections or cn not in metas:
                    continue
                cn_meta = metas[cn]
                cn_own_paths = {t.path for t in resolved_collections[cn].tokens}
                for tok in resolved_collections[cn].tokens:
                    if tok.alias_source and tok.alias_path:
                        top = tok.alias_path.split("/")[0]
                        if top in cn_meta.branches and tok.alias_source in metas and tok.alias_path not in cn_own_paths:
                            src_meta = metas[tok.alias_source]
                            bf = to_folder_name(top)
                            prod_bpm[top] = f"{src_meta.package}.{bf}"

            chain_metas = compute_builder_chain(
                leaf, coll_deps, metas, product_colls, product_coll
            )
            chain_names = [m.name for m in chain_metas]
            theme_modes = compute_theme_modes(chain_names, metas, language, leaf=leaf)

            # Update chain metas with effective factory_fn_prefix for this product
            effective_chain = []
            for m in chain_metas:
                d = _meta_to_dict(m)
                if m.role == "product" and product_coll and m.name == product_coll:
                    d['factory_fn_prefix'] = to_camel_case(product_coll)
                # Use actual root factory params instead of all ext_deps
                if m.name in coll_configs and coll_configs[m.name].root_factory_ext_deps is not None:
                    d['ext_deps'] = coll_configs[m.name].root_factory_ext_deps
                # For Swift: use the qualified root_class_name from the config
                if language == "swift" and m.name in coll_configs:
                    d['root_class'] = coll_configs[m.name].root_class_name
                effective_chain.append(d)

            leaf_dict = _meta_to_dict(metas[leaf])
            if leaf in coll_configs and coll_configs[leaf].root_factory_ext_deps is not None:
                leaf_dict['ext_deps'] = coll_configs[leaf].root_factory_ext_deps

            # Record builder spec for intermediate JSON
            builder_specs.append({
                "leaf": leaf,
                "product": product_coll or None,
                "chain": chain_names,
                "theme_modes": theme_modes,
            })

            if not dry_run:
                if language == "kotlin":
                    from .codegen.kotlin import generate_builder as gen_kt_builder
                    gen_kt_builder(
                        output_dir=output, root_package=package,
                        leaf_meta=leaf_dict,
                        sorted_chain=effective_chain,
                        branch_pkg_map=prod_bpm, theme_modes=theme_modes,
                        prefix=prefix, product_name=product_coll,
                    )
                else:
                    from .codegen.swift import generate_builder as gen_sw_builder
                    # Compute nested class names from leaf collection token paths
                    # for shadow alias detection in the builder
                    leaf_nested_names: set = set()
                    if leaf in resolved_collections:
                        for tok in resolved_collections[leaf].tokens:
                            parts = tok.path.split("/")
                            # All intermediate segments become struct names
                            for seg in parts[:-1]:
                                leaf_nested_names.add(to_pascal_case(seg) if not prefix else prefix + to_pascal_case(seg))
                    gen_sw_builder(
                        output_dir=output,
                        leaf_meta=leaf_dict,
                        sorted_chain=effective_chain,
                        branch_pkg_map=prod_bpm, theme_modes=theme_modes,
                        prefix=prefix, product_name=product_coll,
                        leaf_nested_names=leaf_nested_names,
                        shadow_aliases_collector=shadow_aliases_collector,
                    )

            _info(f"Builder: {leaf}/{product_coll or 'default'} modes={[v[0] for v in theme_modes]}")

    # Write shared shadow aliases file (Swift only)
    if language == "swift" and shadow_aliases_collector and not dry_run:
        from .codegen.swift import write_shadow_aliases_file
        write_shadow_aliases_file(output, shadow_aliases_collector)

    # Phase 8: Always save intermediate JSON to json_output/
    intermediate = build_intermediate_json(
        file_key=file_key,
        resolved_collections=resolved_collections,
        metas=metas,
        coll_deps=coll_deps,
        leaves=leaves,
        product_groups=product_groups,
        branch_pkg_map=branch_pkg_map,
        builder_specs=builder_specs,
    )
    if not dry_run:
        json_dir = json_output
        os.makedirs(json_dir, exist_ok=True)
        intermediate_path = os.path.join(json_dir, "tokens.json")
        save_intermediate_json(intermediate, intermediate_path)
        _info(f"Saved intermediate JSON to: {intermediate_path}")

    _info("Done.")


# --- Helpers ---

def _strip_excluded_aliases(
    resolved_collections: Dict[str, EnrichmentResult],
    collection_filter: CollectionFilter,
) -> None:
    """Drop alias provenance pointing at excluded collections or branches.

    The token keeps its resolved literal value, so generated code never
    references a collection or branch that was skipped.
    """
    stripped = 0
    for coll_name, enr in resolved_collections.items():
        for tok in enr.tokens:
            source = tok.alias_source or coll_name
            targets = [tok.alias_path] if tok.alias_path else []
            if tok.alias_by_mode:
                targets.extend(tok.alias_by_mode.values())
            hits_excluded = (
                tok.alias_source and collection_filter.is_excluded(tok.alias_source)
            ) or any(collection_filter.is_path_excluded(source, t) for t in targets)
            if hits_excluded:
                tok.alias_path = None
                tok.alias_source = None
                tok.alias_by_mode = None
                stripped += 1
    if stripped:
        _info(f"Stripped {stripped} alias reference(s) into excluded collections/branches")


def _drop_excluded_branches(
    resolved_collections: Dict[str, EnrichmentResult],
    collection_filter: CollectionFilter,
) -> None:
    """Remove tokens belonging to excluded branches of otherwise-kept collections."""
    if not collection_filter.exclude_branches:
        return
    dropped: Dict[str, int] = {}
    for coll_name, enr in resolved_collections.items():
        kept = [t for t in enr.tokens if not collection_filter.is_path_excluded(coll_name, t.path)]
        removed = len(enr.tokens) - len(kept)
        if removed:
            dropped[coll_name] = removed
            enr.tokens = kept
    if dropped:
        summary = ", ".join(f"{c} ({n})" for c, n in sorted(dropped.items()))
        _info(f"Dropped tokens from excluded branches in: {summary}")


def _warn_unmatched_patterns(
    collection_filter: CollectionFilter,
    all_names: List[str],
    excluded_names: List[str],
    resolved_collections: Dict[str, EnrichmentResult],
) -> None:
    """Report exclusion patterns that matched nothing (usually a typo)."""
    branch_pairs = [
        (coll_name, tok.path.split("/")[0])
        for coll_name, enr in resolved_collections.items()
        for tok in enr.tokens
    ]
    unmatched = collection_filter.unmatched_patterns(
        list(all_names) + list(excluded_names), branch_pairs
    )
    for pattern in unmatched:
        _warn(f"Exclusion pattern '{pattern}' matched no collection or branch")


def _apply_exclusions_to_intermediate(
    collections_data: Dict[str, Any],
    graph: Dict[str, Any],
    builders: List[Dict[str, Any]],
    collection_filter: CollectionFilter,
) -> tuple:
    """Re-apply collection and branch exclusions to a saved intermediate JSON.

    The intermediate may predate the current config, so the same filtering the
    full pipeline performs is repeated here: excluded collections and branches
    are dropped, aliases into them fall back to their literal value, and the
    derived metadata (`branches`, `ext_deps`, `branch_owners`, builder chains)
    is recomputed so generated factories and builders stay in sync.
    """
    branch_pairs = [
        (name, tok["path"].split("/")[0])
        for name, coll in collections_data.items()
        for tok in coll["tokens"]
    ]
    for pattern in collection_filter.unmatched_patterns(collections_data, branch_pairs):
        _warn(f"Exclusion pattern '{pattern}' matched no collection or branch")

    excluded = [n for n in collections_data if collection_filter.is_excluded(n)]
    if excluded:
        _info(f"Skipped {len(excluded)} excluded collection(s): {', '.join(sorted(excluded))}")
        collections_data = {n: c for n, c in collections_data.items() if n not in excluded}
        builders = [
            {**spec, "chain": [c for c in spec["chain"] if c not in excluded]}
            for spec in builders
            if spec["leaf"] not in excluded and (spec.get("product") or "") not in excluded
        ]

    # Drop tokens of excluded branches inside the collections that survived
    dropped: Dict[str, int] = {}
    filtered: Dict[str, Any] = {}
    for name, coll in collections_data.items():
        coll = dict(coll)
        kept_tokens = [
            t for t in coll["tokens"]
            if not collection_filter.is_path_excluded(name, t["path"])
        ]
        removed = len(coll["tokens"]) - len(kept_tokens)
        if removed:
            dropped[name] = removed
        coll["tokens"] = kept_tokens
        coll["branches"] = [
            b for b in coll.get("branches", [])
            if not collection_filter.is_branch_excluded(name, b)
        ]
        filtered[name] = coll
    collections_data = filtered
    if dropped:
        summary = ", ".join(f"{c} ({n})" for c, n in sorted(dropped.items()))
        _info(f"Dropped tokens from excluded branches in: {summary}")

    # Aliases into an excluded collection or branch keep their literal value
    stripped = 0
    for name, coll in collections_data.items():
        for tok in coll["tokens"]:
            source = tok.get("alias_source") or name
            target = tok.get("alias_path")
            if source in excluded or (
                target and collection_filter.is_path_excluded(source, target)
            ):
                if target or tok.get("alias_source"):
                    stripped += 1
                tok["alias_path"] = None
                tok["alias_source"] = None
    if stripped:
        _info(f"Stripped {stripped} alias reference(s) into excluded collections/branches")

    # Recompute derived metadata against the branches that actually survived
    graph = dict(graph)
    graph["branch_owners"] = {
        b: o for b, o in graph.get("branch_owners", {}).items()
        if o in collections_data and b in collections_data[o].get("branches", [])
    }
    surviving_branches = {
        b for coll in collections_data.values() for b in coll.get("branches", [])
    }
    for coll in collections_data.values():
        coll["ext_deps"] = [d for d in coll.get("ext_deps", []) if d in surviving_branches]

    return collections_data, graph, builders


def _meta_to_dict(meta: CollectionMeta) -> Dict[str, Any]:
    """Convert CollectionMeta to dict format expected by builder generators."""
    return {
        'name': meta.name,
        'root_class': meta.root_class,
        'package': meta.package,
        'folder': meta.folder,
        'branches': meta.branches,
        'modes': meta.modes,
        'ext_deps': meta.ext_deps,
        'shared_factory': meta.shared_factory,
        'factory_fn_prefix': meta.factory_fn_prefix,
    }


def _validate_aliases(
    resolved_collections: Dict[str, EnrichmentResult],
    metas: Dict[str, CollectionMeta],
    branch_pkg_map: Dict[str, str],
    product_groups: Dict[Any, List[str]],
) -> None:
    """Strip alias references that point to non-existent tokens."""
    coll_token_paths: Dict[str, Set[str]] = {}
    branch_owners: Dict[str, List[str]] = {}
    for cn, enr in resolved_collections.items():
        paths: Set[str] = set()
        branches_seen: Set[str] = set()
        for tok in enr.tokens:
            paths.add(tok.path)
            branches_seen.add(tok.path.split("/")[0])
        coll_token_paths[cn] = paths
        for b in branches_seen:
            branch_owners.setdefault(b, []).append(cn)

    # Identify child→base mappings from product groups
    child_to_base: Dict[str, str] = {}
    for _bs, group_colls in product_groups.items():
        base = next(
            (cn for cn in group_colls if metas[cn].role == "semantic"),
            group_colls[0],
        )
        for cn in group_colls:
            if cn != base:
                child_to_base[cn] = base

    stripped = 0
    for coll_name, enr in resolved_collections.items():
        new_tokens = []
        for tok in enr.tokens:
            modified = False
            new_alias_path = tok.alias_path
            new_alias_by_mode = tok.alias_by_mode

            def _path_valid(path: str) -> bool:
                top = path.split("/")[0]
                owners = branch_owners.get(top, [])
                external_owners = [o for o in owners if o != coll_name]
                if not external_owners:
                    return True
                base_only = [o for o in external_owners if o not in child_to_base]
                if base_only and len(base_only) < len(external_owners):
                    return any(path in coll_token_paths[o] for o in base_only)
                return any(path in coll_token_paths[o] for o in external_owners)

            if tok.alias_path:
                top = tok.alias_path.split("/")[0]
                token_top = tok.path.split("/")[0]
                # Check if alias top is also a branch in same collection (ambiguous reference)
                own_branches = {p.split("/")[0] for p in coll_token_paths.get(coll_name, set())}
                if top != token_top and not _path_valid(tok.alias_path):
                    new_alias_path = None
                    modified = True
                    stripped += 1

            if tok.alias_by_mode:
                cleaned = {}
                for m, v in tok.alias_by_mode.items():
                    top = v.split("/")[0]
                    token_top = tok.path.split("/")[0]
                    if top != token_top and not _path_valid(v):
                        stripped += 1
                        modified = True
                    else:
                        cleaned[m] = v
                if modified:
                    new_alias_by_mode = cleaned if cleaned else None

            if modified:
                new_tokens.append(ResolvedToken(
                    path=tok.path, type=tok.type, values=tok.values,
                    alias_path=new_alias_path, alias_by_mode=new_alias_by_mode,
                    alias_source=tok.alias_source if new_alias_path else None,
                    description=tok.description,
                ))
            else:
                new_tokens.append(tok)
        enr.tokens = new_tokens

    if stripped:
        _info(f"Stripped {stripped} invalid alias references")


def _clean_output(
    output: str,
    package: str,
    language: str,
    all_names: List[str],
    metas: Dict[str, CollectionMeta],
) -> None:
    """Clean generated output directory before regeneration.

    Removes the entire package directory (Kotlin) or collection directories
    plus root-level builder files (Swift) so stale files from previous runs
    don't linger.
    """
    if language == "kotlin":
        pkg_path = package.replace(".", os.sep)
        output_pkg_dir = os.path.join(output, pkg_path)
        if os.path.exists(output_pkg_dir):
            shutil.rmtree(output_pkg_dir)
            os.makedirs(output_pkg_dir, exist_ok=True)
    else:
        # Swift: remove collection folders and root-level .swift files
        if not os.path.isdir(output):
            os.makedirs(output, exist_ok=True)
            return
        for entry in os.listdir(output):
            full = os.path.join(output, entry)
            if os.path.isdir(full) and entry != "json":
                shutil.rmtree(full)
            elif entry.endswith(".swift"):
                os.remove(full)


def _generate_from_intermediate(
    data: Dict[str, Any],
    language: str,
    output: str,
    package: str,
    prefix: str,
    shared_output: str,
    write_shared: bool,
    dry_run: bool,
    collection_filter: Optional[CollectionFilter] = None,
) -> None:
    """Generate code from a previously saved intermediate JSON.

    This skips Figma fetch, resolve, enrich, and classify — all that data
    is already captured in the intermediate JSON.
    """
    from .figma.models import FigmaColorValue, ResolvedToken, TokenType

    collections_data = data["collections"]
    graph = data["graph"]
    builders = data.get("builders", [])

    # Apply exclusions again: the intermediate JSON may predate the config.
    if collection_filter and collection_filter.has_rules:
        collections_data, graph, builders = _apply_exclusions_to_intermediate(
            collections_data, graph, builders, collection_filter
        )

    # Reconstruct tokens from JSON
    def _deserialize_value(v: Any) -> Any:
        if isinstance(v, dict) and "type" in v:
            t = v["type"]
            if t == "COLOR":
                return FigmaColorValue(v["r"], v["g"], v["b"], v["a"])
            elif t == "FLOAT":
                return v["value"]
            elif t == "STRING":
                return v["value"]
        return v

    # Initialize generator
    if language == "swift":
        generator = SwiftGenerator()
    else:
        generator = KotlinGenerator(package, "")

    all_names = sorted(collections_data.keys())

    # Generate code per collection
    for coll_name, coll_data in collections_data.items():
        role = coll_data["role"]
        tokens = []
        for t in coll_data["tokens"]:
            values = {mode: _deserialize_value(val) for mode, val in t["values"].items()}
            tokens.append(ResolvedToken(
                path=t["path"],
                type=TokenType(t["type"]) if t["type"] in TokenType.__members__ else TokenType.COLOR,
                values=values,
                alias_path=t.get("alias_path"),
                alias_by_mode=t.get("alias_by_mode"),
                alias_source=t.get("alias_source"),
                description=t.get("description", ""),
            ))

        if not tokens:
            continue

        skip_data_classes = role == "product"
        root_class_fqn = ""
        branch_pkg_map: Dict[str, str] = {}
        branch_root_map: Dict[str, str] = {}

        base_coll = coll_data.get("base_collection")
        if base_coll and base_coll in collections_data:
            base_data = collections_data[base_coll]
            root_class_fqn = f"{base_data['package']}.{base_data['root_class']}"
            for branch in base_data["branches"]:
                bf = to_folder_name(branch)
                branch_pkg_map[branch] = f"{base_data['package']}.{bf}"
                branch_root_map[branch] = base_data["root_class"]

        # Merge global branch owners
        for branch, owner in graph.get("branch_owners", {}).items():
            if branch not in branch_pkg_map and owner in collections_data:
                owner_data = collections_data[owner]
                bf = to_folder_name(branch)
                branch_pkg_map[branch] = f"{owner_data['package']}.{bf}"
                branch_root_map[branch] = owner_data["root_class"]

        meta_pkg = coll_data["package"]
        meta_root = coll_data["root_class"]

        # Compute cross-branch deps for same-branch cross-collection aliases
        json_cross_branch: Dict[str, str] = {}
        own_branches = set(coll_data.get("branches", []))
        own_paths = {t.path for t in tokens}
        for tok in tokens:
            if tok.alias_source and tok.alias_path:
                top = tok.alias_path.split("/")[0]
                if top in own_branches and tok.alias_source in collections_data and tok.alias_path not in own_paths:
                    src_data = collections_data[tok.alias_source]
                    json_cross_branch[top] = f"{src_data['package']}.{to_folder_name(top)}"

        if language == "kotlin":
            coll_config = GeneratorConfig(
                output_dir=output,
                package_name=meta_pkg,
                root_class_name=meta_root,
                root_class_fqn=root_class_fqn,
                shared_output_dir=shared_output,
                write_shared=write_shared,
                palette_sub_package="",
                class_prefix=prefix,
                branch_package_map=branch_pkg_map,
                branch_root_class_map=branch_root_map,
                circular_deps=[],
                skip_data_classes=skip_data_classes,
                cross_branch_deps=json_cross_branch or None,
            )
        else:
            if skip_data_classes and base_coll:
                coll_output = os.path.join(output, to_pascal_case(base_coll))
                swift_root_class = collections_data[base_coll]["root_class"]
                swift_fn_prefix = coll_data.get("factory_fn_prefix", "")
            else:
                coll_output = os.path.join(output, to_pascal_case(coll_name))
                swift_root_class = meta_root
                swift_fn_prefix = ""
            coll_config = GeneratorConfig(
                output_dir=coll_output,
                package_name=package,
                root_class_name=swift_root_class,
                shared_output_dir=coll_output,
                write_shared=write_shared,
                palette_sub_package="",
                class_prefix=prefix,
                branch_package_map=branch_pkg_map,
                branch_root_class_map=branch_root_map,
                circular_deps=[],
                skip_data_classes=skip_data_classes,
                factory_fn_prefix=swift_fn_prefix,
            )

        if not dry_run:
            generator.generate(tokens, coll_config)
        _info(f"Generated: {coll_name} (role={role})")

    # Generate builders
    for spec in builders:
        leaf = spec["leaf"]
        product = spec.get("product") or ""
        chain_names = spec["chain"]
        theme_modes = spec["theme_modes"]

        # Rebuild chain metadata dicts from intermediate JSON
        effective_chain = []
        for cn in chain_names:
            if cn in collections_data:
                cd = collections_data[cn]
                d = {
                    "name": cn,
                    "root_class": cd["root_class"],
                    "package": cd["package"],
                    "folder": cd["folder"],
                    "branches": cd["branches"],
                    "modes": cd["modes"],
                    "ext_deps": cd["ext_deps"],
                    "shared_factory": cd.get("shared_factory", False),
                    "factory_fn_prefix": cd.get("factory_fn_prefix", ""),
                }
                if cd["role"] == "product" and product and cn == product:
                    d["factory_fn_prefix"] = to_camel_case(product)
                effective_chain.append(d)

        leaf_data = collections_data[leaf]
        leaf_dict = {
            "name": leaf,
            "root_class": leaf_data["root_class"],
            "package": leaf_data["package"],
            "folder": leaf_data["folder"],
            "branches": leaf_data["branches"],
            "modes": leaf_data["modes"],
            "ext_deps": leaf_data["ext_deps"],
            "shared_factory": leaf_data.get("shared_factory", False),
            "factory_fn_prefix": leaf_data.get("factory_fn_prefix", ""),
        }

        # Rebuild branch_pkg_map for this product
        prod_bpm: Dict[str, str] = {}
        for branch, owner in graph.get("branch_owners", {}).items():
            if owner in collections_data:
                bf = to_folder_name(branch)
                prod_bpm[branch] = f"{collections_data[owner]['package']}.{bf}"
        if product and product in collections_data:
            pc_data = collections_data[product]
            for branch in pc_data["branches"]:
                bf = to_folder_name(branch)
                prod_bpm[branch] = f"{pc_data['package']}.{bf}"

        if not dry_run:
            if language == "kotlin":
                from .codegen.kotlin import generate_builder as gen_kt_builder
                gen_kt_builder(
                    output_dir=output, root_package=package,
                    leaf_meta=leaf_dict, sorted_chain=effective_chain,
                    branch_pkg_map=prod_bpm, theme_modes=theme_modes,
                    prefix=prefix, product_name=product,
                )
            else:
                from .codegen.swift import generate_builder as gen_sw_builder
                gen_sw_builder(
                    output_dir=output,
                    leaf_meta=leaf_dict, sorted_chain=effective_chain,
                    branch_pkg_map=prod_bpm, theme_modes=theme_modes,
                    prefix=prefix, product_name=product,
                )
        _info(f"Builder: {leaf}/{product or 'default'}")



if __name__ == "__main__":
    main()
