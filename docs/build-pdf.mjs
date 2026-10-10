// Builds the final PDF from docs/render.mjs's HTML.
//
// Two passes:
//   Pass 1 renders the document with placeholder "--" page numbers in the
//   Table of Contents, then pdf-parse's per-page text is scanned to find
//   which page each section heading actually landed on.
//   Pass 2 re-renders with the real page numbers substituted into the same
//   fixed-width TOC cells, so nothing else in the document reflows between
//   passes and the final page numbers match pass 1 exactly.
//
// Every page (including the cover) gets the required footer via Puppeteer's
// footerTemplate, and a page-number indicator via headerTemplate so the two
// never overlap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { PDFParse } from "pdf-parse";
import { renderDocument } from "./render.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "DEI_Conference_Management_Toolkit_Documentation.html");
const PDF_PATH = path.join(__dirname, "DEI_Conference_Management_Toolkit_Documentation.pdf");

const FOOTER_LINES = [
  "DEI Conference Management Toolkit",
  "Designed &amp; Developed by Multimedia Laboratory / Centre,",
  "Dayalbagh Educational Institute, Agra - 282005,",
  "Uttar Pradesh, India",
  'Incase of any technical query / assistance, please feel free to reach out to us at <a href="mailto:cmt@dei.ac.in" style="color:#1e3a8a;">cmt@dei.ac.in</a>.',
];

function footerTemplate() {
  return `
  <div style="width:100%; font-size:6.6px; line-height:8.4px; color:#475569; text-align:center; font-family:'Segoe UI',Arial,sans-serif; padding:0 14mm;">
    ${FOOTER_LINES.map((l) => `<div>${l}</div>`).join("")}
  </div>`;
}

function headerTemplate() {
  return `
  <div style="width:100%; font-size:8px; color:#94a3b8; text-align:right; padding:0 14mm; font-family:'Segoe UI',Arial,sans-serif;">
    Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </div>`;
}

const PDF_OPTS = {
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: headerTemplate(),
  footerTemplate: footerTemplate(),
  margin: { top: "14mm", bottom: "32mm", left: "18mm", right: "18mm" },
};

// Section ids, in the same order as render.mjs's tocEntries, each paired
// with a short, distinctive text snippet that appears at (or right after)
// that section's heading, used to find which PDF page it landed on.
const SECTION_SNIPPETS = [
  ["toc-intro", "How this document was prepared"],
  ["toc-roles", "Section 1: User Roles and Their Actions"],
  ["toc-roletable", "Role Summary Table"],
  ["toc-interaction", "How the Roles Work Together"],
  ["toc-structure", "Conference, Track, and Subject Area"],
  ["toc-stages", "Section 2: The Research Paper Submission Process"],
  ["toc-diagrams", "Visual Workflow Diagrams"],
  ["toc-status", "Section 3: Submission, Review, and Decision Statuses"],
  ["toc-limitations", "Section 4: Known Limitations"],
];

async function renderPdf(html, outPath) {
  const browser = await puppeteer.launch({ headless: "new" });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outPath, ...PDF_OPTS });
  } finally {
    await browser.close();
  }
}

async function findPageNumbers(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  await parser.destroy();

  // The Table of Contents page itself contains the same heading text as
  // every link on it, so a naive search would always match the TOC page
  // first. Only search pages AFTER the TOC page for the real heading.
  const tocPage = result.pages.find((p) => p.text.includes("Table of Contents"));
  const searchPages = tocPage ? result.pages.filter((p) => p.num > tocPage.num) : result.pages;

  const pageNums = {};
  for (const [id, snippet] of SECTION_SNIPPETS) {
    const needle = snippet.replace(/\s+/g, " ").trim();
    const found = searchPages.find((p) => p.text.replace(/\s+/g, " ").includes(needle));
    pageNums[id] = found ? found.num : null;
  }
  return { pageNums, totalPages: result.total };
}

async function main() {
  console.log("Pass 1: rendering with placeholder TOC page numbers...");
  const html1 = renderDocument();
  fs.writeFileSync(HTML_PATH, html1, "utf8");
  const tmpPdf = path.join(__dirname, "_pass1.pdf");
  await renderPdf(html1, tmpPdf);

  console.log("Scanning pass-1 PDF for section page numbers...");
  const { pageNums, totalPages } = await findPageNumbers(tmpPdf);
  console.log("Found page numbers:", pageNums, "total pages:", totalPages);

  const missing = Object.entries(pageNums).filter(([, v]) => v === null);
  if (missing.length) {
    console.warn("WARNING: could not locate these sections in pass-1 text:", missing.map(([k]) => k));
  }

  console.log("Pass 2: rendering final PDF with real TOC page numbers...");
  let html2 = renderDocument();
  for (const [id, num] of Object.entries(pageNums)) {
    const marker = `id="pagenum-${id}">--<`;
    const replacement = `id="pagenum-${id}">${num ?? "?"}<`;
    if (!html2.includes(marker)) {
      console.warn(`WARNING: TOC marker for ${id} not found in HTML - page number not substituted.`);
      continue;
    }
    html2 = html2.replace(marker, replacement);
  }
  fs.writeFileSync(HTML_PATH, html2, "utf8");
  await renderPdf(html2, PDF_PATH);
  fs.unlinkSync(tmpPdf);

  const stat = fs.statSync(PDF_PATH);
  console.log(`Wrote ${PDF_PATH} (${(stat.size / 1024).toFixed(0)} KB)`);

  // Sanity re-check: total page count must not have changed between passes
  // (it would mean the placeholder-vs-real digit swap reflowed something).
  const final = await findPageNumbers(PDF_PATH);
  if (final.totalPages !== totalPages) {
    console.warn(`WARNING: total page count changed between passes (${totalPages} -> ${final.totalPages}). TOC page numbers may be off by one for later sections.`);
  } else {
    console.log(`Confirmed: page count stable at ${totalPages} pages across both passes.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
