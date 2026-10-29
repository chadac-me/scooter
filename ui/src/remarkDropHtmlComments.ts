/** Remark plugin: drop HTML comments, which chat would otherwise show as escaped text. */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

// A whole comment, or an unterminated one still streaming in.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

const strip = (node: MdNode): void => {
  if (!node.children) return;
  node.children = node.children.filter((child) => {
    if (child.type !== "html" || child.value === undefined) {
      strip(child);
      return true;
    }
    child.value = child.value.replace(COMMENT, "");
    return child.value.trim() !== "";
  });
};

export default function remarkDropHtmlComments() {
  return (tree: MdNode) => strip(tree);
}
