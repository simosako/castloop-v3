import { parseFragment, serialize, Tokenizer, type DefaultTreeAdapterTypes } from "parse5";

const allowed = new Set(["p", "br", "strong", "em", "b", "i", "ul", "ol", "li", "a", "h2", "h3", "blockquote", "pre", "code", "hr"]);

/** Validate and serialize supported HTML; comments are omitted from output. */
export function renderDescription(source: string): string {
  const errors: string[] = [];
  // Fragment parsing can discard document tags before they reach the tree.
  // Inspect tokens as well so an unsupported element is never silently lost.
  const tokenizer = new Tokenizer({}, {
    onStartTag: token => { if (!allowed.has(token.tagName)) errors.push(`Unsupported HTML element: ${token.tagName}`); },
    onEndTag: token => { if (!allowed.has(token.tagName)) errors.push(`Unsupported HTML element: ${token.tagName}`); },
    onDoctype: () => errors.push("HTML doctype is unsupported"),
    onComment: () => {}, onEof: () => {}, onCharacter: () => {},
    onNullCharacter: () => errors.push("Invalid null character"), onWhitespaceCharacter: () => {},
  });
  tokenizer.write(source, true);
  const fragment = parseFragment(source, { onParseError: error => errors.push(error.code) });
  function visit(parent: DefaultTreeAdapterTypes.ParentNode): void {
    parent.childNodes = parent.childNodes.filter(node => node.nodeName !== "#comment");
    for (const node of parent.childNodes) {
      if (node.nodeName === "#text") continue;
      if (!("tagName" in node)) { errors.push(`Unsupported HTML node: ${node.nodeName}`); continue; }
      if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !allowed.has(node.tagName)) {
        errors.push(`Unsupported HTML element: ${node.tagName}`);
      }
      for (const attribute of node.attrs) {
        if (node.tagName !== "a" || attribute.name !== "href" || attribute.namespace) {
          errors.push(`Unsupported attribute ${attribute.name} on ${node.tagName}`);
        } else {
          try { if (new URL(attribute.value).protocol !== "https:") throw new Error(); }
          catch { errors.push("Link href must be an absolute HTTPS URL"); }
        }
      }
      visit(node);
    }
  }
  visit(fragment);
  if (errors.length) throw new Error(errors.join("; "));
  return serialize(fragment);
}
