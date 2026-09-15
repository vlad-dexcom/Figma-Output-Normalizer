"""Token tree structure for hierarchical code generation."""
from __future__ import annotations

from typing import Dict, List, Optional

from ..figma.models import ResolvedToken


class TreeNode:
    """A node in the variable path tree."""

    def __init__(self, name: str):
        self.name = name
        self.children: Dict[str, TreeNode] = {}
        self.token: Optional[ResolvedToken] = None

    @property
    def sorted_children(self) -> List[TreeNode]:
        return [self.children[k] for k in sorted(self.children.keys())]


def insert_token(root: TreeNode, segments: List[str], token: ResolvedToken) -> None:
    """Insert a token at the given path segments in the tree."""
    current = root
    for segment in segments[:-1]:
        if segment not in current.children:
            current.children[segment] = TreeNode(segment)
        current = current.children[segment]
    leaf_name = segments[-1]
    if leaf_name not in current.children:
        current.children[leaf_name] = TreeNode(leaf_name)
    current.children[leaf_name].token = token


def collect_all_tokens(node: TreeNode) -> List[ResolvedToken]:
    """Recursively collect all tokens under a node."""
    tokens: List[ResolvedToken] = []
    if node.token:
        tokens.append(node.token)
    for child in node.sorted_children:
        tokens.extend(collect_all_tokens(child))
    return tokens


def build_tree(tokens: List[ResolvedToken], sanitize_fn) -> TreeNode:
    """Build a tree from a list of tokens using the given path sanitizer."""
    root = TreeNode("root")
    for token in tokens:
        segments = sanitize_fn(token.path)
        insert_token(root, segments, token)
    return root
