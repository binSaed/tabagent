/**
 * Aria-snapshot formatter.
 *
 * Produces a Playwright-MCP-compatible YAML-ish accessibility-tree string.
 * Each interactive node carries a `ref` (snapshot-scoped opaque id) that the
 * LLM copies verbatim into a click/type/select call. This is the dominant
 * production strategy (Playwright MCP, Browser MCP) and is LLM-familiar.
 *
 * The input is the raw CDP `Accessibility.getFullAXTree` payload. We prune
 * to role-bearing nodes, generate stable refs, and emit indentation-based YAML.
 *
 * Example output:
 *   - Page URL: https://example.com
 *   - Page Title: Example
 *   - Page Snapshot
 *   ```yaml
 *   - generic:
 *     - heading "Welcome" [level=1]
 *     - textbox "Search" [ref=s1e3]
 *     - button "Go" [ref=s1e4]
 *   ```
 */

/** A pruned node in the synthesized tree we build from the CDP AX payload. */
export interface AxNode {
  ref: string;
  role: string;
  name: string;
  level?: number;
  value?: string;
  checked?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  url?: string;
  // children, after pruning
  children: AxNode[];
  // raw CDP backend node id (for resolution back to the node at click time)
  backendNodeId?: number;
}

/**
 * A node emitted by the DOM walker injected into the page. Refs are assigned
 * ONLY to interactive elements; headings/structural nodes carry none.
 */
export interface DomWalkNode {
  role: string;
  name: string;
  ref?: string;
  level?: number;
  value?: string;
  url?: string;
  depth: number;
}

interface CdpAxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
  role: { type: "role"; value: string };
  name?: { value: string };
  value?: { value?: string };
  properties?: { name: string; value: { value: unknown } }[];
  ignored?: boolean;
}

interface CdpAxPayload {
  nodes: CdpAxNode[];
}

// Roles that carry semantic meaning worth surfacing to the model. Everything
// else (generic wrappers, layout nodes) is dropped unless it has a name or
// children we care about. This list is intentionally generous.
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "combobox",
  "listbox",
  "option",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell",
  "menu",
  "menubar",
  "toolbar",
  "dialog",
  "alertdialog",
]);

const STRUCTURAL_ROLES = new Set([
  "heading",
  "navigation",
  "main",
  "article",
  "section",
  "complementary",
  "contentinfo",
  "banner",
  "region",
  "form",
  "group",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "tablist",
  "tabpanel",
  "tree",
  "treegrid",
  "status",
  "alert",
  "log",
  "marquee",
  "timer",
  "figure",
  "separator",
]);

/**
 * Build a pruned AxNode tree from raw CDP output, assigning refs.
 * Returns the forest of top-level nodes (usually one: the root web area).
 */
export function buildAxTree(
  cdp: CdpAxPayload,
  url: string,
  title: string,
  prefix = "s1",
): { roots: AxNode[]; refToBackend: Map<string, number>; url: string; title: string } {
  const byId = new Map<string, CdpAxNode>();
  for (const n of cdp.nodes) byId.set(n.nodeId, n);

  // Find root (web area or a node with no parent in the payload).
  let rootId: string | undefined;
  for (const n of cdp.nodes) {
    if (n.role?.value === "WebArea" || n.role?.value === "RootWebArea") {
      rootId = n.nodeId;
      break;
    }
  }
  if (!rootId) {
    for (const n of cdp.nodes) {
      if (!n.parentId || !byId.has(n.parentId)) {
        rootId = n.nodeId;
        break;
      }
    }
  }

  const refToBackend = new Map<string, number>();
  let counter = 0;

  const convert = (cdpNode: CdpAxNode | undefined): AxNode | null => {
    if (!cdpNode || cdpNode.ignored) return null;
    const role = cdpNode.role?.value ?? "generic";
    const name = cdpNode.name?.value ?? "";
    const props = new Map<string, unknown>();
    for (const p of cdpNode.properties ?? []) props.set(p.name, p.value?.value);

    const keep =
      role === "WebArea" ||
      role === "RootWebArea" ||
      INTERACTIVE_ROLES.has(role) ||
      STRUCTURAL_ROLES.has(role) ||
      (role === "generic" && name.length > 0);

    // Recurse first so we know if there's anything worth keeping under this node.
    const childNodes: AxNode[] = [];
    for (const cid of cdpNode.childIds ?? []) {
      const c = convert(byId.get(cid));
      if (c) childNodes.push(c);
    }

    if (!keep && childNodes.length === 0) return null;
    // Pure pass-through wrapper: hoist children up.
    if (!keep && childNodes.length > 0) {
      // We can't return multiple from here; wrap as generic so structure stays sane.
    }

    const ref = `${prefix}e${++counter}`;
    const node: AxNode = {
      ref,
      role: role === "RootWebArea" || role === "WebArea" ? "generic" : role,
      name,
      children: childNodes,
    };
    if (cdpNode.backendDOMNodeId) {
      node.backendNodeId = cdpNode.backendDOMNodeId;
      refToBackend.set(ref, cdpNode.backendDOMNodeId);
    }
    const level = props.get("level");
    if (typeof level === "number") node.level = level;
    const val = cdpNode.value?.value;
    if (typeof val === "string" && val.length > 0) node.value = val;
    const checked = props.get("checked");
    if (checked === true || checked === false || checked === "mixed") node.checked = checked;
    if (props.get("selected") === true) node.selected = true;
    if (props.get("expanded") === true) node.expanded = true;
    if (props.get("disabled") === true) node.disabled = true;
    return node;
  };

  const roots: AxNode[] = [];
  if (rootId) {
    const r = convert(byId.get(rootId));
    if (r) roots.push(r);
  } else {
    // No root found; emit whatever top-level nodes exist.
    for (const n of cdp.nodes) {
      if (!n.parentId || !byId.has(n.parentId)) {
        const r = convert(n);
        if (r) roots.push(r);
      }
    }
  }
  // Stash url/title for the header lines.
  return { roots, refToBackend, url, title };
}

/** Render the tree as the YAML-ish string the LLM consumes. */
export function renderAxTree(snapshot: {
  roots: AxNode[];
  url: string;
  title: string;
}): string {
  const lines: string[] = [];
  lines.push(`- Page URL: ${snapshot.url}`);
  lines.push(`- Page Title: ${snapshot.title}`);
  lines.push("- Page Snapshot");
  lines.push("```yaml");
  for (const root of snapshot.roots) emitNode(root, lines, 0);
  lines.push("```");
  return lines.join("\n");
}

function emitNode(n: AxNode, lines: string[], depth: number): void {
  const indent = "  ".repeat(depth);
  const interactive = INTERACTIVE_ROLES.has(n.role);
  const props: string[] = [];
  if (n.level !== undefined) props.push(`level=${n.level}`);
  if (n.value !== undefined) props.push(`value=${JSON.stringify(n.value)}`);
  if (n.checked !== undefined) props.push(`checked=${n.checked}`);
  if (n.selected) props.push("selected");
  if (n.expanded !== undefined) props.push(`expanded=${n.expanded}`);
  if (n.disabled) props.push("disabled");
  if (interactive) props.push(`ref=${n.ref}`);

  const namePart = n.name ? ` ${JSON.stringify(n.name)}` : "";
  const propsPart = props.length ? ` [${props.join(" ")}]` : "";
  // Structural leaf with no children: collapse to a single line.
  if (n.children.length === 0) {
    if (n.role === "generic" && !n.name) return; // drop empty wrappers
    lines.push(`${indent}- ${n.role}${namePart}${propsPart}`);
    return;
  }
  lines.push(`${indent}- ${n.role}${namePart}${propsPart}:`);
  for (const c of n.children) emitNode(c, lines, depth + 1);
}

/** Estimate the token footprint of a snapshot string (~4 chars/token heuristic). */
export function estimateSnapshotTokens(snapshot: string): number {
  return Math.ceil(snapshot.length / 4);
}

// ===========================================================================
// DOM-driven snapshot (the primary strategy; see browser-tools.ts snapshot).
// `Accessibility.getFullAXTree` is unreliable on real-world SPAs -- it
// frequently returns a near-empty tree. Walking the live DOM via
// `querySelectorAll` for interactive elements is far more robust and is the
// strategy production browser agents converged on.
// ===========================================================================

/** Render a flat DOM-walk list as the YAML-ish string the LLM consumes. */
export function renderDomWalk(
  nodes: DomWalkNode[],
  url: string,
  title: string,
  viewport?: { width: number; height: number },
): string {
  const lines: string[] = [];
  lines.push(`- Page URL: ${url}`);
  lines.push(`- Page Title: ${title}`);
  if (viewport) lines.push(`- Viewport: ${viewport.width}x${viewport.height}`);
  lines.push("- Page Snapshot");
  lines.push("```yaml");
  for (const n of nodes) {
    const indent = "  ".repeat(n.depth);
    const namePart = n.name ? ` ${JSON.stringify(n.name)}` : "";
    const props: string[] = [];
    if (n.level !== undefined) props.push(`level=${n.level}`);
    if (n.value !== undefined) props.push(`value=${JSON.stringify(n.value)}`);
    if (n.url !== undefined) props.push(`url=${JSON.stringify(n.url)}`);
    if (n.ref) props.push(`ref=${n.ref}`);
    const propsPart = props.length ? ` [${props.join(" ")}]` : "";
    lines.push(`${indent}- ${n.role}${namePart}${propsPart}`);
  }
  lines.push("```");
  return lines.join("\n");
}
