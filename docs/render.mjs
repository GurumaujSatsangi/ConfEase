import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roles, submissionStatuses, otherStatusFields, roleTable, stages, limitations } from "./data.mjs";
import { diagram1, diagram2, diagram3 } from "./diagrams.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function logoDataUri() {
  const logoPath = path.resolve(__dirname, "..", "public", "dei_logo.png");
  const buf = fs.readFileSync(logoPath);
  return "data:image/png;base64," + buf.toString("base64");
}

// Each TOC entry gets a fixed-width, right-aligned page-number cell holding
// a placeholder on the first render pass. build-pdf.mjs replaces the
// placeholder text with the real page number found by scanning the
// first-pass PDF, then renders a second, final pass. Because the cell is a
// fixed width regardless of digit count, swapping "--" for "7" or "23"
// never reflows anything after the Table of Contents, so the final page
// numbers stay identical to the first pass.
const tocEntries = [
  ["toc-intro", "Introduction and How This Document Was Prepared"],
  ["toc-roles", "Section 1: User Roles and Their Actions"],
  ["toc-roletable", "Role Summary Table"],
  ["toc-interaction", "How the Roles Work Together"],
  ["toc-structure", "Conference, Track, and Subject Area: What They Mean Here"],
  ["toc-stages", "Section 2: The Research Paper Submission Process"],
  ["toc-diagrams", "Visual Workflow Diagrams"],
  ["toc-status", "Section 3: Submission, Review, and Decision Statuses"],
  ["toc-limitations", "Section 4: Known Limitations and Points to Note"],
];

function renderTOC() {
  const rows = tocEntries
    .map(
      ([id, label]) =>
        `<div class="toc-row"><span class="toc-label">${esc(label)}</span><span class="toc-dots"></span><span class="toc-page" id="pagenum-${id}">--</span></div>`
    )
    .join("\n");
  return `
  <section class="page" id="toc-page">
    <h1 class="section-title">Table of Contents</h1>
    <div class="toc-list">
      ${rows}
    </div>
  </section>`;
}

function renderCover() {
  let logo = "";
  try {
    logo = `<div class="cover-logo-badge"><img src="${logoDataUri()}" class="cover-logo" alt="Dayalbagh Educational Institute logo"/></div>`;
  } catch (e) {
    logo = "";
  }
  const date = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  return `
  <section class="page cover-page">
    <div class="cover-inner">
      ${logo}
      <div class="cover-kicker">Reference Documentation</div>
      <h1 class="cover-title">DEI Conference Management Toolkit</h1>
      <h2 class="cover-subtitle">User Roles and Research Paper Submission Process</h2>
      <div class="cover-rule"></div>
      <p class="cover-prepared">Prepared for: Dayalbagh Educational Institute, Agra</p>
      <p class="cover-version">Document Version 1.0 &nbsp;&bull;&nbsp; ${esc(date)}</p>
    </div>
  </section>`;
}

function renderIntro() {
  return `
  <section class="page">
    <h1 class="section-title" id="toc-intro">Introduction</h1>
    <p>This document explains, in simple English, who can do what on the DEI Conference Management Toolkit (DEI CMT) portal, and how a research paper moves through the portal from submission to a final certificate.</p>
    <h3>How this document was prepared</h3>
    <p>Every fact in this document was checked directly against the project's own source code &mdash; its routes, its database tables, and the pages shown to users &mdash; rather than assumed from how other conference systems usually work. Where the code does something unusual, is incomplete, or is inconsistent between two parts of the application, this document says so plainly instead of describing it as a finished feature.</p>
    <h3>How to read this document</h3>
    <ul>
      <li><strong>Section 1</strong> lists every user role the code actually defines, what each one can do, and how the roles work together.</li>
      <li><strong>Section 2</strong> walks through the entire submission process, stage by stage, with diagrams.</li>
      <li><strong>Section 3</strong> lists every status a submission (or a review, or a decision) can have, in plain language.</li>
      <li><strong>Section 4</strong> lists limitations and inconsistencies found in the code while preparing this document. These are not criticisms &mdash; they are an accurate record of what the application currently does, so that readers are not misled about a feature that looks complete but is not.</li>
    </ul>
  </section>`;
}

function renderRoleCard(r) {
  const li = (arr) => arr.map((a) => `<li>${a}</li>`).join("");
  return `
  <article class="role-card">
    <h3 class="role-name">${esc(r.name)}</h3>
    <p class="role-simple">${esc(r.simple)}</p>
    <p class="role-purpose"><strong>Purpose: </strong>${r.purpose}</p>
    <p class="role-heading">What this role can do</p>
    <ul class="role-list">${li(r.actions)}</ul>
    <p class="role-heading">What this role cannot do / restrictions</p>
    <ul class="role-list restrict-list">${li(r.restrictions)}</ul>
    <p class="role-where"><strong>Where in the portal: </strong>${r.where}</p>
  </article>`;
}

function renderRolesSection() {
  const cards = roles.map(renderRoleCard).join("\n");
  return `
  <section class="page">
    <h1 class="section-title" id="toc-roles">Section 1: User Roles and Their Actions</h1>
    <p>The portal defines <strong>${roles.length} distinct roles</strong> in its code. A single person can hold more than one role at a time (for example, the same email can be a Reviewer on one conference and a Chair on another), because roles are granted per conference, not to the account as a whole (except Admin, which is portal-wide).</p>
    ${cards}
  </section>`;
}

function renderRoleTable() {
  const rows = roleTable
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td class="${i === 0 ? "rt-role" : ""}">${cell}</td>`).join("")}</tr>`
    )
    .join("\n");
  return `
  <section class="page">
    <h1 class="section-title" id="toc-roletable">Role Summary Table</h1>
    <p>A quick-reference summary of every role. See Section 1 above for the full detail behind each row.</p>
    <table class="data-table role-summary-table">
      <thead>
        <tr><th>User Role</th><th>Main Responsibility</th><th>Key Actions</th><th>Important Restrictions</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

function renderInteraction() {
  const steps = [
    "An <strong>Admin</strong> grants a person Chair Portal access, creating their Chair account.",
    "The <strong>Chair</strong> creates a Conference, then creates its Subject Areas, assigning Reviewers, a Meta-Reviewer, and Session Chairs/Panelists to each one. The portal emails each assigned person.",
    "A <strong>User</strong> browses the conference list, opens a conference, and submits a paper as Primary Author, naming any Co-Authors.",
    "The <strong>Chair</strong> desk-reviews the paper: DESK ACCEPT or DESK REJECT.",
    "The <strong>Reviewer(s)</strong> assigned to that paper's Subject Area independently score it.",
    "Either the <strong>Chair</strong> reads the reviews directly and decides (Resolve Conflicts), or the <strong>Meta-Reviewer</strong> privately recommends a decision that the <strong>Chair</strong> later applies by clicking Publish Review Results.",
    "The decision is emailed to the <strong>Author</strong>. If “Revision Required”, the Author resubmits, the <strong>Reviewer(s)</strong> re-review it, and the <strong>Chair</strong> makes the final call.",
    "Once accepted, the <strong>Author</strong> submits a Final Camera-Ready Paper and Registers for the conference.",
    "On presentation day, a <strong>Session Chair/Panelist</strong> marks an Oral paper complete, or a <strong>Panelist/Poster Coordinator</strong> scores a Poster paper.",
    "The <strong>Chair</strong> clicks Enable PDF Download, after which the <strong>Author</strong> can download their Certificate of Presentation.",
  ];
  return `
  <section class="page">
    <h1 class="section-title" id="toc-interaction">How the Roles Work Together</h1>
    <p>This is the order in which the roles above actually interact, as implemented in the code (see Section 2 for the full stage-by-stage detail, and Section 4 for the two different ways a decision can be reached):</p>
    <ol class="interaction-list">
      ${steps.map((s) => `<li>${s}</li>`).join("\n")}
    </ol>
  </section>`;
}

function renderStructureSection() {
  return `
  <section class="page">
    <h1 class="section-title" id="toc-structure">Conference, Track, and Subject Area: What They Mean Here</h1>
    <p>These three words are easy to mix up, and the application itself does not use them perfectly consistently. Here is exactly what each one means in the code:</p>
    <table class="data-table">
      <thead><tr><th style="width:22%">Term</th><th>What it actually is in this portal</th></tr></thead>
      <tbody>
        <tr><td><strong>Conference</strong></td><td>The top-level event (the <code>conferences</code> database table). It has its own title, description, dates, deadlines, and one or more Chairs.</td></tr>
        <tr><td><strong>Track</strong></td><td>A simple, optional label used only to group Subject Areas together on the Chair's “Manage Tracks” page (the <code>conference_groups</code> database table, e.g. “DSC2026”). A Subject Area does not have to belong to one; if it doesn't, the interface shows it under “Conference level”.</td></tr>
        <tr><td><strong>Subject Area</strong></td><td>The unit that actually does the work. This is where Reviewers, one Meta-Reviewer, and Session Chairs/Panelists are assigned, and where an Oral presentation schedule is set. Every submission belongs to exactly one Subject Area.</td></tr>
      </tbody>
    </table>
    <p class="note-box"><strong>A naming note worth knowing:</strong> confusingly, the database table that stores a “Subject Area” is literally named <code>conference_tracks</code>, and its reviewer list column is named <code>track_reviewers</code> &mdash; even though almost everywhere in the user interface, this same thing is labelled “Subject Area”, not “Track”. The interface's own, separate “Track” label refers to the simpler <code>conference_groups</code> grouping described above. In short: <strong>Conference &rarr; (optional) Track label &rarr; Subject Area (does the real work) &rarr; Submission.</strong></p>
  </section>`;
}

function renderStage(st) {
  return `
  <article class="stage-card">
    <h3>${esc(st.title)}</h3>
    <ul>${st.points.map((p) => `<li>${p}</li>`).join("")}</ul>
  </article>`;
}

function renderStagesSection() {
  return `
  <section class="page">
    <h1 class="section-title" id="toc-stages">Section 2: The Research Paper Submission Process</h1>
    <p>This section walks through the whole life of a paper, from a user's very first visit to the portal through to the final certificate, in the order these stages actually happen in the code.</p>
    ${stages.map(renderStage).join("\n")}
  </section>`;
}

function renderDiagramsSection() {
  return `
  <section class="page">
    <h1 class="section-title" id="toc-diagrams">Visual Workflow Diagrams</h1>
    <p>The submission process is split across three connected diagrams so that each one stays readable. Dashed arrows show a path that is possible but not the main route.</p>
    <h3 class="diagram-title">Diagram 1 &mdash; Author Submission Journey</h3>
    <div class="diagram-box">${diagram1()}</div>
  </section>
  <section class="page">
    <h3 class="diagram-title">Diagram 2 &mdash; Desk Review, Peer Review, and Decision</h3>
    <div class="diagram-box">${diagram2()}</div>
  </section>
  <section class="page">
    <h3 class="diagram-title">Diagram 3 &mdash; Revision, Final Paper, and Closure</h3>
    <div class="diagram-box">${diagram3()}</div>
  </section>`;
}

function renderStatusSection() {
  const rows = submissionStatuses
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td class="${i === 0 ? "status-name" : ""}">${esc(cell).replace(/&quot;/g, '"')}</td>`).join("")}</tr>`
    )
    .join("\n");
  const otherRows = otherStatusFields
    .map(
      (f) =>
        `<tr><td><strong>${esc(f.field)}</strong></td><td>${esc(f.values)}</td><td>${esc(f.note)}</td></tr>`
    )
    .join("\n");
  return `
  <section class="page">
    <h1 class="section-title" id="toc-status">Section 3: Submission, Review, and Decision Statuses</h1>
    <p>A submission's own status (<code>submission_status</code>) is the one shown to the Author and the Chair as “the” status of the paper. The table below lists every value this status can actually hold in the code, in simple English.</p>
    <table class="data-table status-table">
      <thead><tr><th style="width:16%">Status</th><th style="width:30%">Meaning in Simple English</th><th style="width:24%">Who Can Change It</th><th style="width:30%">What Happens Next</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3>Other, separate status fields</h3>
    <p>These are not the same as the submission's own status above &mdash; each lives in its own database table and is used for a different, narrower purpose. Do not read these as the paper's overall status.</p>
    <table class="data-table other-status-table">
      <thead><tr><th style="width:26%">Field</th><th style="width:30%">Possible Values</th><th>What It's For</th></tr></thead>
      <tbody>${otherRows}</tbody>
    </table>
  </section>`;
}

function renderLimitations() {
  const cards = limitations
    .map(
      (l, i) => `
  <article class="limitation-card">
    <h3>${i + 1}. ${esc(l.title)}</h3>
    <p>${l.body}</p>
  </article>`
    )
    .join("\n");
  return `
  <section class="page">
    <h1 class="section-title" id="toc-limitations">Section 4: Known Limitations and Points to Note</h1>
    <p>These are gaps, inconsistencies, or partially-implemented areas found while reading the code for this document. They are listed here so that this document does not overstate what the portal currently does.</p>
    ${cards}
  </section>`;
}

const css = `
@page { size: A4; margin: 26mm 18mm 26mm 18mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  font-family: 'Segoe UI', Calibri, Arial, sans-serif;
  color: #1f2937;
  font-size: 11.5pt;
  line-height: 1.5;
}
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1, h2, h3 { color: #1e3a8a; font-family: 'Segoe UI', Calibri, Arial, sans-serif; }
.section-title {
  font-size: 20pt;
  border-bottom: 2.5px solid #1e3a8a;
  padding-bottom: 8px;
  margin-bottom: 16px;
}
p { margin: 0 0 10px 0; text-align: left; }
ul, ol { margin: 0 0 12px 0; padding-left: 22px; }
li { margin-bottom: 5px; }
code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 0.92em; color: #334155; }

/* Cover page */
.cover-page { page-break-after: always; display: flex; align-items: center; justify-content: center; height: 245mm; }
.cover-inner { text-align: center; width: 100%; }
.cover-logo-badge { width: 118px; height: 118px; border-radius: 50%; background: #1e3a8a; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px auto; }
.cover-logo { width: 84px; height: 84px; object-fit: contain; }
.cover-kicker { letter-spacing: 3px; text-transform: uppercase; color: #64748b; font-size: 10.5pt; margin-bottom: 14px; }
.cover-title { font-size: 28pt; color: #1e3a8a; margin: 0 0 8px 0; }
.cover-subtitle { font-size: 15pt; color: #334155; font-weight: 400; margin: 0 0 24px 0; }
.cover-rule { width: 120px; height: 3px; background: #1e3a8a; margin: 0 auto 24px auto; }
.cover-prepared { font-size: 12.5pt; color: #1f2937; margin-bottom: 4px; }
.cover-version { font-size: 10.5pt; color: #64748b; }

/* TOC */
.toc-list { margin-top: 18px; }
.toc-row { display: flex; align-items: flex-end; font-size: 11.5pt; padding: 8px 0; }
.toc-label { color: #1f2937; white-space: nowrap; }
.toc-dots { flex: 1 1 auto; border-bottom: 1.5px dotted #94a3b8; margin: 0 8px 4px 8px; }
.toc-page { width: 28px; text-align: right; font-weight: 600; color: #1e3a8a; white-space: nowrap; }

/* Roles */
.role-card { border: 1px solid #dbe3ee; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; page-break-inside: avoid; background: #fafbff; }
.role-name { font-size: 13.5pt; margin: 0 0 2px 0; color: #1e3a8a; }
.role-simple { font-style: italic; color: #64748b; margin: 0 0 8px 0; font-size: 10.5pt; }
.role-purpose { margin-bottom: 8px; }
.role-heading { font-weight: 700; margin: 8px 0 4px 0; color: #334155; font-size: 10.8pt; text-transform: uppercase; letter-spacing: 0.4px; }
.role-list { margin: 0 0 4px 0; }
.restrict-list li { color: #7c2d12; }
.role-where { margin-top: 8px; font-size: 10.5pt; color: #334155; }

/* Tables */
.data-table { width: 100%; border-collapse: collapse; margin: 12px 0 18px 0; font-size: 9.8pt; }
.data-table th { background: #1e3a8a; color: #ffffff; padding: 7px 8px; text-align: left; font-size: 9.6pt; }
.data-table td { border: 1px solid #e2e8f0; padding: 7px 8px; vertical-align: top; }
.data-table tr:nth-child(even) td { background: #f8fafc; }
.role-summary-table .rt-role { font-weight: 600; width: 16%; }
.status-table { table-layout: fixed; }
.status-table .status-name { font-weight: 600; color: #1e3a8a; }
.data-table, .role-summary-table, .status-table, .other-status-table { page-break-inside: auto; }
.data-table tr { page-break-inside: avoid; }

.note-box { background: #fff7ed; border: 1px solid #fdba74; border-radius: 6px; padding: 10px 14px; margin-top: 8px; font-size: 10.6pt; }

/* Stages */
.stage-card { margin-bottom: 14px; page-break-inside: avoid; }
.stage-card h3 { font-size: 12.5pt; margin: 0 0 6px 0; color: #0f172a; background: #eef2ff; padding: 6px 10px; border-left: 4px solid #1e3a8a; }
.stage-card ul { margin-top: 4px; }

/* Diagrams */
.diagram-title { font-size: 13.5pt; margin: 4px 0 10px 0; }
.diagram-box { width: 100%; }
.diagram-box svg.diagram { width: 100%; height: auto; display: block; }

/* Limitations */
.limitation-card { border-left: 4px solid #b91c1c; background: #fef2f2; padding: 10px 14px; margin-bottom: 12px; page-break-inside: avoid; }
.limitation-card h3 { font-size: 11.8pt; margin: 0 0 6px 0; color: #7f1d1d; }
.limitation-card p { margin: 0; }

.interaction-list li { margin-bottom: 8px; }
`;

export function renderDocument() {
  const body = [
    renderCover(),
    renderTOC(),
    renderIntro(),
    renderRolesSection(),
    renderRoleTable(),
    renderInteraction(),
    renderStructureSection(),
    renderStagesSection(),
    renderDiagramsSection(),
    renderStatusSection(),
    renderLimitations(),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>DEI Conference Management Toolkit — Documentation</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(__dirname, "DEI_Conference_Management_Toolkit_Documentation.html");
  fs.writeFileSync(out, renderDocument(), "utf8");
  console.log("Wrote", out);
}
