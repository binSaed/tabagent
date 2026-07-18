/**
 * Tiny, safe Markdown -> HTML renderer for chat bubbles.
 *
 * SECURITY MODEL: model output is untrusted. We escape ALL HTML entities FIRST,
 * then apply markdown rules to the escaped string. So `**bold**` becomes
 * `<strong>bold</strong>`, but a raw `<script>` in the model output stays as
 * escaped text and is never parsed by the browser.
 *
 * Supports the common subset the model emits:
 *   - fenced code blocks ```lang ... ```
 *   - headings (# .. ######)
 *   - bold **x** / __x__
 *   - italic *x* / _x_
 *   - inline code `x`
 *   - unordered lists (- / *)
 *   - ordered lists (1. / 2.)
 *   - links [text](url)  (url sanitized to http/https/mailto only)
 *   - horizontal rule ---
 *   - GFM tables (header | sep | rows)
 *   - paragraph + line-break handling
 *
 * No external deps; this runs in the panel page context.
 */

/** Escape HTML metacharacters. Always called BEFORE any markdown parsing. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GFM table separator row: e.g. `| :--- | ---: | :---: |`.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Split a GFM table row into trimmed cell contents, dropping the optional
 * leading/trailing pipes. Operates on already-escaped text.
 */
function splitTableRow(row: string): string[] {
  let r = row.trim();
  // Strip one leading and one trailing pipe if present.
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((c) => c.trim());
}

/** Alignment for each column parsed from the separator row ("" | "left" | "center" | "right"). */
function parseTableAligns(sep: string): string[] {
  return splitTableRow(sep).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    // `:---` and plain `---` both render as default/left in GFM.
    return "";
  });
}

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

/**
 * Render markdown to an HTML string safe to assign via innerHTML.
 */
export function renderMarkdown(input: string): string {
  if (!input) return "";
  // 1. Escape everything first.
  const text = escapeHtml(input);

  const out: string[] = [];
  const lines = text.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block ---
    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(
        `<pre class="md-code"><code${lang ? ` class="lang-${lang}"` : ""}>${code.join("\n")}</code></pre>`,
      );
      continue;
    }

    // --- Horizontal rule ---
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // --- Heading ---
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // --- Unordered list ---
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // --- Ordered list ---
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // --- GFM table: header | separator | body rows ---
    // Requires a pipe in the header line AND a valid separator line next.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = parseTableAligns(lines[i + 1]);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        body.push(splitTableRow(lines[i]));
        i++;
      }
      const cell = (
        c: string,
        idx: number,
        tag: "th" | "td",
      ) => `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inline(c)}</${tag}>`;
      const headHtml = `<thead><tr>${header
        .map((c, idx) => cell(c, idx, "th"))
        .join("")}</tr></thead>`;
      const bodyHtml = body.length
        ? `<tbody>${body
            .map((row) => `<tr>${row.map((c, idx) => cell(c, idx, "td")).join("")}</tr>`)
            .join("")}</tbody>`
        : "";
      out.push(`<div class="md-table-wrap"><table class="md-table">${headHtml}${bodyHtml}</table></div>`);
      continue;
    }

    // --- Blank line: paragraph separator ---
    if (/^\s*$/.test(line)) {
      out.push("");
      i++;
      continue;
    }

    // --- Paragraph: gather consecutive non-blank, non-block lines ---
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      // Stop if this line starts a table (pipe header followed by separator).
      !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    // Join with <br> for soft line breaks within a paragraph.
    const joined = para.map(inline).join("<br/>");
    if (joined.trim()) out.push(`<p>${joined}</p>`);
  }

  return out.join("\n");
}

/** Inline transformations: bold, italic, code, links. Applied to escaped text. */
function inline(s: string): string {
  let r = s;
  // Inline code first (so its contents aren't further formatted).
  const codeStash: string[] = [];
  r = r.replace(/`([^`]+)`/g, (_m, code) => {
    codeStash.push(code as string);
    return `\u0000CODE${codeStash.length - 1}\u0000`;
  });
  // Bold: **x** or __x__
  r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // Italic: *x* or _x_ (avoid matching across word boundaries greedily)
  r = r.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  r = r.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  // Links: [text](url) -- sanitize protocol.
  r = r.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label, url) => {
      const u = String(url).trim();
      if (!SAFE_PROTOCOLS.test(u)) return String(label); // drop unsafe links
      return `<a href="${u}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  );
  // Restore inline code.
  r = r.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => `<code>${codeStash[Number(idx)]}</code>`);
  return r;
}
