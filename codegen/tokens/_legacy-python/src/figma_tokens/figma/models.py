"""Data models for Figma design tokens."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple


class TokenType(Enum):
    COLOR = "COLOR"
    FLOAT = "FLOAT"
    STRING = "STRING"
    BOOLEAN = "BOOLEAN"


@dataclass
class FigmaColorValue:
    r: float
    g: float
    b: float
    a: float


@dataclass
class FigmaMode:
    mode_id: str
    name: str


@dataclass
class FigmaCollection:
    id: str
    name: str
    modes: List[FigmaMode]
    variable_ids: List[str]
    hidden_from_publishing: bool = False


@dataclass
class FigmaVariable:
    id: str
    name: str
    resolved_type: str
    collection_id: str
    values_by_mode: Dict[str, Any]
    description: str = ""


@dataclass
class ResolvedToken:
    """A fully resolved token with concrete values for each mode."""
    path: str
    type: TokenType
    values: Dict[str, Any]
    alias_path: Optional[str] = None
    alias_by_mode: Optional[Dict[str, str]] = None
    alias_source: Optional[str] = None  # collection name the alias_path comes from
    description: str = ""  # Figma variable description, emitted as KDoc/DocC


@dataclass
class BranchDependency:
    """A typed dependency edge: this collection's branch references another collection's branch."""
    source_collection: str
    source_branch: str
    target_collection: str
    target_branch: str


@dataclass
class CollectionMeta:
    """Runtime-inferred metadata about a collection."""
    name: str
    root_class: str
    package: str
    folder: str
    branches: List[str]
    modes: List[str]
    ext_deps: List[str]  # branch names referenced externally (for legacy compat)
    # Provenance-aware dependencies: (target_collection, target_branch) edges
    dep_edges: List[BranchDependency] = field(default_factory=list)
    # Set at graph classification time
    role: str = ""  # "primitive", "semantic", "product", "leaf"
    base_collection: Optional[str] = None  # for products: their canonical base
    shared_factory: bool = False
    factory_fn_prefix: str = ""
    # Full normalized token paths (for structural comparison)
    token_paths: List[str] = field(default_factory=list)

