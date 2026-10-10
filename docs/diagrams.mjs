import { box, terminal, diamond, arrow, svgWrap } from "./svg.mjs";

export function diagram1() {
  const w = 760;
  let s = "";
  const cx = 380;
  s += box(cx - 150, 20, 300, 55, "Register and activate account", { role: "User" });
  s += arrow(cx, 75, cx, 110);
  s += box(cx - 150, 110, 300, 55, "Log in", { role: "User" });
  s += arrow(cx, 165, cx, 200);
  s += box(cx - 150, 200, 300, 55, "Browse conferences and open one", { role: "User" });
  s += arrow(cx, 255, cx, 290);
  s += box(cx - 160, 290, 320, 65, "Fill in the submission form: Title, Abstract, Subject Area, Co-Authors", { role: "Primary Author" });
  s += arrow(cx, 355, cx, 390);
  s += box(cx - 160, 390, 320, 65, "Upload the paper file (PDF / DOC / DOCX, checked and scanned for size, type and AI-generated text)", { role: "Primary Author", titleSize: 11.5 });
  s += arrow(cx, 455, cx, 495);
  s += terminal(cx - 190, 495, 380, 60, "Status: Submitted for Review (confirmation email sent)", { fill: "#dcfce7", stroke: "#15803d", textColor: "#14532d" });
  return svgWrap(w, 580, s, "Diagram 1: Author Submission Journey");
}

export function diagram2() {
  const w = 980;
  const h = 900;
  let s = "";
  // Start
  s += box(410 - 150, 20, 300, 50, "Submission status: Submitted for Review");
  s += arrow(410, 70, 410, 115);
  // Desk review decision
  s += diamond(410, 160, 260, 90, "Chair performs Desk Review");
  s += arrow(290, 160, 165, 258, { label: "DESK REJECT" });
  s += terminal(40, 258, 250, 55, "DESK REJECT — final, author emailed");
  s += arrow(530, 160, 695, 258, { label: "DESK ACCEPT" });
  s += box(570, 258, 250, 55, "Status: DESK ACCEPT");
  s += arrow(695, 313, 695, 358);
  s += box(570, 358, 250, 65, "Reviewers score the paper (per Subject Area)", { role: "Reviewer(s)" });
  s += arrow(695, 423, 695, 463);
  s += diamond(695, 508, 260, 90, "Chair decides how to record the final decision");
  s += arrow(565, 508, 535, 598, { label: "Path A" });
  s += box(400, 598, 270, 65, "Path A: Chair reads every review directly on Resolve Conflicts and decides", { role: "Chair", titleSize: 11.5 });
  s += arrow(825, 508, 855, 598, { label: "Path B" });
  s += box(720, 598, 270, 65, "Path B: Meta-Reviewer privately recommends a decision", { role: "Meta-Reviewer" });
  s += arrow(855, 663, 855, 700);
  s += box(720, 700, 270, 60, "Chair clicks Publish Review Results, which applies the recommendation", { role: "Chair", titleSize: 11.5 });
  s += arrow(535, 663, 580, 800, { dashed: false });
  s += arrow(855, 760, 700, 800, { dashed: false });
  s += box(420, 800, 420, 75, "Decision recorded: Accepted for Oral / Accepted for Poster / Revision Required / Rejected — author emailed the result", { titleSize: 11.5, fill: "#dcfce7", stroke: "#15803d" });
  return svgWrap(w, h, s, "Diagram 2: Desk Review, Peer Review, and Decision");
}

export function diagram3() {
  const w = 900;
  const h = 1080;
  let s = "";
  const cx = 450;
  s += box(cx - 150, 20, 300, 50, "Submission status: Revision Required");
  s += arrow(cx, 70, cx, 108);
  s += box(cx - 175, 108, 350, 60, "Author (Primary Author only) submits a Revised Paper", { role: "Author" });
  s += arrow(cx, 168, cx, 206);
  s += box(cx - 175, 206, 350, 55, "Reviewers re-review the revised paper", { role: "Reviewer(s)" });
  s += arrow(cx, 261, cx, 300);
  s += diamond(cx, 345, 260, 90, "Chair resolves re-review conflicts");
  s += arrow(320, 320, 300, 70, { dashed: true, label: "can repeat" });
  s += arrow(580, 345, 630, 325, { label: "Rejected" });
  s += terminal(630, 298, 220, 55, "Rejected — final, author emailed");
  s += arrow(cx, 390, cx, 420);
  s += box(cx - 125, 420, 250, 60, "Accepted for Oral / Accepted for Poster Presentation");
  s += arrow(cx, 480, cx, 512);
  s += box(cx - 150, 512, 300, 55, "Author submits the Final Camera-Ready Paper", { role: "Author" });
  s += arrow(cx, 567, cx, 598);
  s += box(cx - 175, 598, 350, 60, "Author registers: mode, offline-author count, video link", { role: "Author" });
  s += arrow(cx, 658, cx, 686);
  s += diamond(cx, 730, 240, 90, "Presentation day");
  s += arrow(330, 730, 200, 812, { label: "Oral" });
  s += box(60, 812, 280, 65, "Session Chair / Panelist marks it Presentation Completed", { role: "Session Chair", titleSize: 11.5 });
  s += arrow(570, 730, 710, 812, { label: "Poster" });
  s += box(560, 812, 300, 65, "Panelist or Poster Coordinator scores it: Poster Scored", { role: "Panelist / Poster Coordinator", titleSize: 11.5 });
  s += arrow(200, 877, 410, 907);
  s += arrow(710, 877, 500, 907);
  s += box(cx - 160, 907, 320, 55, "Chair clicks Enable PDF Download for the conference", { role: "Chair" });
  s += arrow(cx, 962, cx, 998);
  s += terminal(cx - 220, 998, 440, 70, "Author downloads a Certificate of Presentation (built on demand, nothing stored)", { fill: "#dcfce7", stroke: "#15803d", textColor: "#14532d" });
  return svgWrap(w, h, s, "Diagram 3: Revision, Final Paper, and Closure");
}
