// Small helper for building simple, readable flow-chart SVGs without a
// charting library - just rectangles, diamonds, and arrows laid out on a
// fixed grid. Kept intentionally plain so every diagram stays legible when
// printed on A4.

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wraps text onto multiple <tspan> lines inside a box of a given width.
function wrapLines(text, maxCharsPerLine) {
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const w of words) {
    const next = current ? current + " " + w : w;
    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function textBlock(x, cy, lines, { size = 12.5, weight = "600", color = "#1f2937", lineHeight = 15 } = {}) {
  const startY = cy - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${startY + i * lineHeight}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${color}" font-family="'Segoe UI', Arial, sans-serif">${esc(line)}</text>`
    )
    .join("");
}

export function box(x, y, w, h, title, { fill = "#eef2ff", stroke = "#4338ca", role = null, titleSize = 12.5 } = {}) {
  const lines = wrapLines(title, Math.max(10, Math.floor(w / 7.2)));
  const cy = y + h / 2 - (role ? 7 : 0);
  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`;
  svg += textBlock(x + w / 2, cy, lines, { size: titleSize });
  if (role) {
    svg += `<text x="${x + w / 2}" y="${y + h - 10}" text-anchor="middle" font-size="10" font-style="italic" fill="#6b7280" font-family="'Segoe UI', Arial, sans-serif">${esc(role)}</text>`;
  }
  return svg;
}

export function terminal(x, y, w, h, title, { fill = "#fee2e2", stroke = "#b91c1c", textColor = "#7f1d1d" } = {}) {
  const lines = wrapLines(title, Math.max(10, Math.floor(w / 7.2)));
  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`;
  svg += textBlock(x + w / 2, y + h / 2, lines, { size: 12, color: textColor });
  return svg;
}

export function diamond(cx, cy, w, h, title, { fill = "#fef3c7", stroke = "#b45309" } = {}) {
  const points = [
    [cx, cy - h / 2],
    [cx + w / 2, cy],
    [cx, cy + h / 2],
    [cx - w / 2, cy],
  ]
    .map((p) => p.join(","))
    .join(" ");
  const lines = wrapLines(title, Math.max(8, Math.floor(w / 9)));
  let svg = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`;
  svg += textBlock(cx, cy, lines, { size: 11.5, color: "#78350f" });
  return svg;
}

export function arrow(x1, y1, x2, y2, { color = "#374151", label = null, labelPos = 0.5, dashed = false } = {}) {
  const id = `h${Math.round(x1)}_${Math.round(y1)}_${Math.round(x2)}_${Math.round(y2)}`.replace(/-/g, "n");
  let svg = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.8" marker-end="url(#arrowhead)" ${dashed ? 'stroke-dasharray="5,4"' : ""}/>`;
  if (label) {
    const lx = x1 + (x2 - x1) * labelPos;
    const ly = y1 + (y2 - y1) * labelPos;
    svg += `<rect x="${lx - label.length * 3.3 - 4}" y="${ly - 9}" width="${label.length * 6.6 + 8}" height="16" fill="#ffffff" opacity="0.92"/>`;
    svg += `<text x="${lx}" y="${ly + 3}" text-anchor="middle" font-size="10.5" fill="${color}" font-family="'Segoe UI', Arial, sans-serif">${esc(label)}</text>`;
  }
  return svg;
}

export function svgWrap(width, height, body, title) {
  return `<svg class="diagram" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title || "")}">
  <defs>
    <marker id="arrowhead" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
      <polygon points="0 0, 8 3.5, 0 7" fill="#374151"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  ${body}
</svg>`;
}
