"""Configuration loading and validation."""
from __future__ import annotations

import fnmatch
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set


# Root of the tools/figma-tokens directory (src/figma_tokens/config.py → up 3).
TOOL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Git-tracked config listing Figma collections that must never be generated.
DEFAULT_COLLECTIONS_CONFIG = os.path.join(TOOL_ROOT, "configs", "collections.toml")


@dataclass
class GeneratorConfig:
    """Per-collection generation config (constructed at runtime, not from user config)."""
    output_dir: str
    package_name: str
    root_class_name: str = "DesignTokens"
    root_class_fqn: str = ""
    shared_output_dir: Optional[str] = None
    write_shared: bool = True
    palette_sub_package: str = ""
    branch_package_map: Optional[Dict[str, str]] = None
    class_prefix: str = ""
    branch_root_class_map: Optional[Dict[str, str]] = None
    circular_deps: Optional[Dict[str, Set[str]]] = None
    skip_data_classes: bool = False
    factory_fn_prefix: str = ""
    cross_branch_deps: Optional[Dict[str, str]] = None  # branch→source_collection_pkg for same-branch cross-coll deps
    root_factory_ext_deps: Optional[List[str]] = None  # actual root factory params (subset of ext_deps)
    shadow_aliases_collector: Optional[Dict[str, str]] = None  # shared across all collections; accumulated aliases written once
    branch_class_renames: Optional[Dict[str, str]] = None  # branch_name → renamed_class (e.g. typography → DSTypographyTokens)
    global_branch_renames: Optional[Dict[str, str]] = None  # flat map of ALL renamed branches across all collections


@dataclass
class AppConfig:
    """Top-level CLI configuration (from TOML/flags)."""
    token: str = ""
    file_key: str = ""
    language: str = ""  # "swift" or "kotlin"
    output: str = ""
    package: str = "DesignTokens"
    root_class: str = "DesignTokens"
    prefix: str = ""
    shared_output: Optional[str] = None
    write_shared: bool = True
    local_file: Optional[str] = None
    save_json: Optional[str] = None
    collections_config: Optional[str] = None
    dry_run: bool = False


def load_config(config_path: str) -> Dict[str, Any]:
    """Load config from a TOML or JSON file."""
    import json

    if config_path.endswith(".json"):
        with open(config_path) as f:
            return json.load(f)

    try:
        import tomllib  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        try:
            import tomli as tomllib  # type: ignore[import-not-found,no-redef]
        except ModuleNotFoundError:
            print("Error: TOML config requires Python 3.11+ or 'pip install tomli'", file=sys.stderr)
            sys.exit(1)

    with open(config_path, "rb") as f:
        return tomllib.load(f)


@dataclass
class CollectionFilter:
    """Which Figma collections and branches are skipped during generation.

    `exclude` patterns are matched case-insensitively against the collection
    name and support shell-style globs (`*`, `?`, `[seq]`), e.g. `figma-only`
    or `wip-*`.

    `exclude_branches` patterns drop a top-level group *inside* a kept
    collection (the first path segment of a variable name, e.g. `apple` in
    `apple/system-black`). A pattern containing `/` is matched against
    `<collection>/<branch>`; a bare pattern is matched against the branch name
    in every collection (i.e. `apple` is shorthand for `*/apple`).
    """
    exclude: List[str] = field(default_factory=list)
    exclude_branches: List[str] = field(default_factory=list)
    source: Optional[str] = None

    @property
    def has_rules(self) -> bool:
        return bool(self.exclude or self.exclude_branches)

    def is_excluded(self, name: str) -> bool:
        lowered = name.lower()
        return any(fnmatch.fnmatch(lowered, pattern.lower()) for pattern in self.exclude)

    def is_branch_excluded(self, collection: str, branch: str) -> bool:
        qualified = f"{collection}/{branch}".lower()
        bare = branch.lower()
        for pattern in self.exclude_branches:
            lowered = pattern.lower()
            target = qualified if "/" in lowered else bare
            if fnmatch.fnmatch(target, lowered):
                return True
        return False

    def is_path_excluded(self, collection: str, path: str) -> bool:
        """True when a token path belongs to an excluded branch of `collection`."""
        return self.is_branch_excluded(collection, path.split("/")[0])

    def partition(self, names: Iterable[str]) -> tuple[List[str], List[str]]:
        """Split names into (kept, excluded), preserving order."""
        kept: List[str] = []
        skipped: List[str] = []
        for name in names:
            (skipped if self.is_excluded(name) else kept).append(name)
        return kept, skipped

    def unmatched_patterns(
        self, collections: Iterable[str], branches: Iterable[tuple[str, str]]
    ) -> List[str]:
        """Patterns that matched nothing, so a typo is reported instead of silently ignored."""
        coll_names = list(collections)
        branch_pairs = list(branches)
        unmatched: List[str] = []
        for pattern in self.exclude:
            if not any(fnmatch.fnmatch(n.lower(), pattern.lower()) for n in coll_names):
                unmatched.append(pattern)
        for pattern in self.exclude_branches:
            filt = CollectionFilter(exclude_branches=[pattern])
            if not any(filt.is_branch_excluded(c, b) for c, b in branch_pairs):
                unmatched.append(pattern)
        return unmatched


def load_collection_filter(config_path: Optional[str]) -> CollectionFilter:
    """Load the collection exclusion config.

    When `config_path` is None the git-tracked default
    (`tools/figma-tokens/configs/collections.toml`) is used if it exists;
    an explicitly requested path that is missing is a hard error.
    """
    explicit = config_path is not None
    path = config_path or DEFAULT_COLLECTIONS_CONFIG

    if not os.path.exists(path):
        if explicit:
            print(f"Error: Collections config not found: {path}", file=sys.stderr)
            sys.exit(1)
        return CollectionFilter()

    data = load_config(path)
    patterns = _pattern_list(
        data, path, "exclude", ("exclude", "exclude-collections", "exclude_collections")
    )
    branch_patterns = _pattern_list(
        data, path, "exclude-branches", ("exclude-branches", "exclude_branches")
    )
    return CollectionFilter(
        exclude=patterns, exclude_branches=branch_patterns, source=path
    )


def _pattern_list(
    data: Dict[str, Any], path: str, label: str, keys: Iterable[str]
) -> List[str]:
    """Read a list-of-glob-patterns config key, accepting a bare string too."""
    raw: Any = []
    for key in keys:
        if key in data:
            raw = data[key]
            break

    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or any(not isinstance(p, str) for p in raw):
        print(f"Error: '{label}' in {path} must be a list of name patterns", file=sys.stderr)
        sys.exit(1)

    return [p.strip() for p in raw if p.strip()]


def resolve_token(token: Optional[str], token_file: Optional[str]) -> str:
    """Resolve Figma API token from various sources."""
    if token_file:
        if not os.path.exists(token_file):
            print(f"Error: Token file not found: {token_file}", file=sys.stderr)
            sys.exit(1)
        with open(token_file) as f:
            return f.read().strip()

    env_token = os.environ.get("FIGMA_TOKEN")
    if env_token:
        return env_token

    if token:
        return token

    print("Error: No Figma token provided. Use --token, --token-file, or FIGMA_TOKEN env var.", file=sys.stderr)
    sys.exit(1)
