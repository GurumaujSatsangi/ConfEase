// Structured content for the DEI CMT documentation PDF.
// Every fact here was verified against api/index.js and the views/ folder
// during a line-by-line read of the routes, not assumed from how a typical
// conference system works.

export const roles = [
  {
    id: "user",
    name: "User (Author)",
    simple: "Any person with a regular portal account",
    purpose:
      "This is the default role every person gets when they create an account. It lets a person submit research papers to conferences and track their progress.",
    actions: [
      "Create an account and log in.",
      "Browse the list of every conference on the portal (the home page lists all conferences; no login is needed just to browse).",
      "Submit a paper as the Primary Author of a conference, choosing a Subject Area for it.",
      "Name Co-Authors when submitting; a named Co-Author can then log in and “join” the paper themselves while it is still “Submitted for Review”.",
      "Accept or reject a Co-Author join request sent to them.",
      "View every paper they are an author or co-author on, and its current status, in “My Submissions”.",
      "Edit or delete their own submission, but only while its status is still “Submitted for Review”.",
      "Submit a Revised Paper after a “Revision Required” decision.",
      "Submit a Final Camera-Ready Paper after an “Accepted” decision.",
      "Register for the conference once the camera-ready paper is in (choose Online/Offline presentation, enter how many co-authors attend offline, provide a video link).",
      "See the presentation schedule (date and time) once their camera-ready paper is in and the Chair has set a schedule.",
      "Download a Certificate of Presentation, once the Chair has enabled it and the submission's status is “Poster Scored” or “Presentation Completed”.",
      "View and edit their own profile, and reset their password.",
    ],
    restrictions: [
      "Cannot review papers, see other authors' submissions, or change any submission's status.",
      "Cannot edit a submission once it is past “Submitted for Review”, except through the specific Revise / Camera-Ready forms meant for that later stage.",
      "Cannot open any Chair, Reviewer, Meta-Reviewer, Session Chair, Poster Coordinator, or Admin page unless the portal has also given that email the matching role.",
      "A person who is also a Reviewer, Session Chair, or Invited Speaker on a conference is explicitly blocked by the code from submitting or joining a regular paper on that conference, to avoid an obvious conflict of interest. (Meta-Reviewers and Poster Presentation Coordinators are not blocked this way in the code — see Limitations.)",
    ],
    where: "Home page, My Dashboard, the conference page's “My Submissions”, My Profile.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    simple: "A subject-matter expert who scores papers",
    purpose:
      "A Reviewer is assigned by the Chair to one or more Subject Areas. Their job is to read the papers in that Subject Area and score them.",
    actions: [
      "View the Reviewer Dashboard, listing every submission in every Subject Area they are assigned to.",
      "Open and read a submission's file, along with an automatic AI-Generated Content Detection score and verdict the portal computes when the paper was uploaded (with an on-screen warning if the paper was flagged).",
      "Submit a review with five scores (Originality, Relevance, Technical Quality, Clarity, Impact — the portal averages these into a Mean Score), written remarks, and a recommended decision (Accepted for Oral Presentation / Accepted for Poster Presentation / Revision Required / Rejected).",
      "Re-review a paper after the author submits a Revised Paper (same scores; the decision choices this time are Accepted for Oral, Accepted for Poster, or Rejected — “Revision Required” is not offered a second time at this step).",
    ],
    restrictions: [
      "Can only review submissions in a Subject Area they are listed on; the portal checks this before accepting a review.",
      "Can only submit one review per paper — a second attempt by the same reviewer is blocked.",
      "Cannot see other reviewers' scores or remarks for the same paper.",
      "Cannot change a submission's official status — a review is only ever an input to the Meta-Reviewer's or the Chair's decision.",
      "Note: the code does not check reviewer workload, availability, or conflicts of interest. Any reviewer listed on a Subject Area can review any paper in it.",
    ],
    where: "Reviewer Dashboard, Review Submission form, Re-Review form.",
  },
  {
    id: "meta-reviewer",
    name: "Meta-Reviewer",
    simple: "Oversees reviewers and recommends the final decision",
    purpose:
      "A Meta-Reviewer oversees one or more Subject Areas. Once reviewers have scored a paper, the Meta-Reviewer looks at every review together and recommends one final decision for it.",
    actions: [
      "View the Meta-Reviewer Dashboard: one row per submission (not per review) in their Subject Area(s) that has passed Desk Review and has at least one peer review, and does not already have a pending recommendation.",
      "Open a submission and see every reviewer's scores and remarks together, side by side.",
      "Submit one recommended decision (Accepted for Oral Presentation / Accepted for Poster Presentation / Revision Required / Rejected) with remarks.",
      "Resubmit (overwrite) their own recommendation any time before the Chair publishes results.",
    ],
    restrictions: [
      "Their recommendation is kept private on purpose: it is stored in its own table and is not shown to the Chair, and does not change the submission's status, until the Chair clicks “Publish Review Results”.",
      "Cannot see submissions outside their assigned Subject Area(s).",
      "Important gap found in the code: a paper that goes through a second round, after “Submitted Revised Paper”, is not routed back to the Meta-Reviewer at all — the Chair resolves revised papers directly instead. See “Two Separate Decision Paths” in the Limitations section.",
    ],
    where: "Meta-Reviewer Dashboard, Recommendation Submission form.",
  },
  {
    id: "session-chair",
    name: "Session Chair (stored as “session_chair”; also called “Panelist” on several pages)",
    simple: "Runs a Subject Area's Oral Presentation session",
    purpose:
      "Manages a Subject Area's Oral Presentation session on the day of the conference, and marks papers as presented. The same people can also score Poster submissions.",
    actions: [
      "View the Active Session page for Oral presentations in their Subject Area.",
      "Mark a submission's Oral presentation as “Presentation Completed”, optionally with a panelist score.",
      "Score Poster submissions (this capability is shared with Poster Presentation Coordinators — both are checked by the same rule).",
    ],
    restrictions: [
      "Can only act on submissions in a Subject Area they are listed as a panelist for.",
      "Cannot change desk-review or peer-review outcomes, and cannot edit the paper itself.",
      "Is blocked by the code from also being a paper's Author on that conference.",
    ],
    where: "Active Session page, Score Posters page.",
  },
  {
    id: "poster-coordinator",
    name: "Poster Presentation Coordinator",
    simple: "Manages the poster session and scores posters",
    purpose:
      "Manages the logistics of a conference's poster session (its date and time) and scores Poster submissions.",
    actions: [
      "View and set the Poster Session's date, start time, and end time for the conference.",
      "Score Poster submissions for the conference.",
    ],
    restrictions: [
      "This role is assigned per conference, not per Subject Area.",
      "Cannot act on Oral-track submissions.",
      "Note: unlike Reviewers and Session Chairs, the code does not block a Poster Presentation Coordinator from also being a paper's Author.",
    ],
    where: "Manage Poster Sessions page, Score Posters page.",
  },
  {
    id: "invitee",
    name: "Invitee (Invited Speaker)",
    simple: "A speaker personally invited by the Chair",
    purpose:
      "A person the Chair has personally invited to give an Invited Talk, separate from the normal peer-reviewed submission process.",
    actions: [
      "View the Invitee Dashboard.",
      "Submit an Invited Talk paper (title and file) directly — it does not go through Desk Review, Peer Review, or the Meta-Reviewer.",
      "View, and while still pending, delete their invited-talk submission.",
    ],
    restrictions: [
      "Can only submit to the conference(s) they were invited to.",
      "Invited Talk submissions are kept in their own table and, as implemented, do not currently have the Revise / Camera-Ready / Register / Certificate steps that regular Author submissions have.",
      "Is blocked by the code from also submitting a regular paper as an Author on that conference.",
    ],
    where: "Invitee Dashboard, Submit Invited Talk form.",
  },
  {
    id: "chair",
    name: "Conference Chair (and Co-Chair)",
    simple: "The organizer who runs a conference",
    purpose:
      "The Chair creates and fully manages a conference, from Subject Areas and reviewer assignment through to final decisions and results.",
    actions: [
      "Create a new conference (title, description, dates and deadlines).",
      "Edit or delete a conference they own or co-chair.",
      "Create, edit, and delete Subject Areas (optionally grouped under a Track label), assigning Reviewers, one Meta-Reviewer, and Session Chairs/Panelists to each — the portal emails each assigned person automatically.",
      "Add Invited Speakers.",
      "Carry out Desk Review on a new submission: “DESK ACCEPT” or “DESK REJECT” (rejection requires written remarks).",
      "View every submission for their conference, grouped by Subject Area and status.",
      "Resolve a submission's final decision directly, after reading the reviewers' scores themselves, on the “Resolve Conflicts” page.",
      "Resolve a Revised Paper's final decision after re-review, on the “Resolve Re-Review Conflicts” page.",
      "Click “Publish Review Results” to apply any pending Meta-Reviewer recommendations and email every author their decision.",
      "Set up and manage Oral Presentation sessions and the Poster Session (dates, times, panelists, coordinators, venue/room).",
      "Delete a submission, but only while it is still “Submitted for Review”.",
      "Send announcements and email alerts to conference participants.",
      "Click “Enable PDF Download” to make a Certificate of Presentation available for every submission in the conference whose status is “Poster Scored” or “Presentation Completed”.",
    ],
    restrictions: [
      "Can only manage a conference they created or were added to as a co-chair — the code checks this ownership on nearly every Chair action.",
      "Cannot see a Meta-Reviewer's recommendation before publishing results (by design).",
      "Cannot delete a submission that has moved past “Submitted for Review”.",
      "A Chair account cannot be self-registered — only an Admin can create one.",
    ],
    where: "Chair Dashboard and its sub-pages: Manage Tracks, Desk Review, View Submissions, Resolve Conflicts, Manage Sessions, Manage Poster Sessions, Invited Talks, Edit Conference.",
  },
  {
    id: "admin",
    name: "Admin",
    simple: "Manages who is allowed to be a Chair",
    purpose:
      "A portal-wide role (not tied to any one conference) that controls who may hold a Conference Chair account.",
    actions: [
      "Grant Chair Portal access to a new person (creates their Chair account and emails a password-setup link).",
      "Revoke a Chair's access.",
      "Reset a Chair's password (sends a new setup link).",
      "Delete a Chair account.",
    ],
    restrictions: [
      "There is no Admin table or signup form. A logged-in person is treated as Admin only if their email exactly matches one of the addresses in the server's ADMIN_EMAILS setting; if that setting is empty, nobody is Admin.",
      "Important access-control gap found in the code: the Admin page itself, which lists every Chair's name, email, phone number, department, and status, and every conference, does not require a login to view. Only the action buttons on that page (grant, revoke, reset, delete) check the Admin allow-list. This should be treated as a real gap, not a working restriction — see Limitations.",
    ],
    where: "Admin page.",
  },
];

// status table: [status, meaning, who changes it, what happens next]
export const submissionStatuses = [
  [
    "Submitted for Review",
    "The paper has just been submitted and is waiting for Desk Review.",
    "The system, automatically, the moment the paper is submitted.",
    "The Chair performs Desk Review and moves it to “DESK ACCEPT” or “DESK REJECT”.",
  ],
  [
    "DESK ACCEPT",
    "The Chair has approved the paper to go for peer review.",
    "The Chair, on the Desk Review page.",
    "Reviewers score it. Later, the Chair (directly) or the Meta-Reviewer's recommendation (applied by the Chair at Publish) records a final decision.",
  ],
  [
    "DESK REJECT",
    "The Chair has rejected the paper at the desk-review stage, before it is sent for peer review. This is a final status.",
    "The Chair, on the Desk Review page, with required rejection remarks.",
    "The author is emailed the decision. No further status change for this paper is defined in the code.",
  ],
  [
    "Accepted for Oral Presentation",
    "The paper has been accepted for an Oral presentation.",
    "The Chair (Resolve Conflicts), or a Meta-Reviewer's recommendation applied by the Chair at Publish.",
    "The author submits a Final Camera-Ready Paper for Oral Presentation.",
  ],
  [
    "Accepted for Poster Presentation",
    "The paper has been accepted for a Poster presentation.",
    "The Chair (Resolve Conflicts), or a Meta-Reviewer's recommendation applied by the Chair at Publish.",
    "The author submits a Final Camera-Ready Paper for Poster Presentation.",
  ],
  [
    "Revision Required",
    "The author has been asked to revise and resubmit the paper.",
    "The Chair (Resolve Conflicts), or a Meta-Reviewer's recommendation applied by the Chair at Publish.",
    "The author submits a Revised Paper.",
  ],
  [
    "Submitted Revised Paper",
    "The author has resubmitted a revised version of the paper.",
    "The system, automatically, when the author uses “Submit Revised Paper”.",
    "Reviewers re-review it. The Chair then records a final decision on “Resolve Re-Review Conflicts” — this can, in principle, send the paper back to “Revision Required” a second time if the Chair chooses that option again.",
  ],
  [
    "Rejected",
    "The paper has been rejected after a full review (as opposed to a desk rejection). The same status text is used whether this is the first round or after a revision — the code does not tell the two apart with a different status.",
    "The Chair (Resolve Conflicts / Resolve Re-Review Conflicts), or a Meta-Reviewer's recommendation applied by the Chair at Publish.",
    "Final status. No further step is defined.",
  ],
  [
    "Submitted Final Camera Ready Paper for Oral Presentation",
    "The author has uploaded their final paper for an Oral presentation.",
    "The system, automatically, when the author uses “Submit Final Camera-Ready Paper”.",
    "The author can Register for the conference. On presentation day, a Session Chair/Panelist marks it “Presentation Completed”.",
  ],
  [
    "Submitted Final Camera Ready Paper for Poster Presentation",
    "The author has uploaded their final paper for a Poster presentation.",
    "The system, automatically, when the author uses “Submit Final Camera-Ready Paper”.",
    "The author can Register for the conference. A Panelist or Poster Coordinator scores it, moving it to “Poster Scored”.",
  ],
  [
    "Poster Scored",
    "The Poster submission has been judged and scored on presentation day.",
    "A Panelist or Poster Presentation Coordinator, on the Score Posters page.",
    "The Chair can “Enable PDF Download” for the conference; the author can then download a Certificate of Presentation.",
  ],
  [
    "Presentation Completed",
    "The Oral submission has been marked as presented.",
    "A Session Chair/Panelist, on the Active Session page.",
    "The Chair can “Enable PDF Download” for the conference; the author can then download a Certificate of Presentation.",
  ],
];

export const otherStatusFields = [
  {
    field: "Individual review decision (peer_review.acceptance_status)",
    values: "Accepted for Oral Presentation / Accepted for Poster Presentation / Revision Required / Rejected",
    note: "This is one reviewer's own personal recommendation. It is set by the reviewer when they submit their review, and is only ever read by the Meta-Reviewer or the Chair — by itself it never changes the submission's own status.",
  },
  {
    field: "Re-review decision (revised_submissions.acceptance_status)",
    values: "Accepted for Oral Presentation / Accepted for Poster Presentation / Rejected (no “Revision Required” option here)",
    note: "Same idea as above, but for a reviewer's re-review of a “Submitted Revised Paper”.",
  },
  {
    field: "Meta-Reviewer recommendation (meta_reviewer_decision.status)",
    values: "Accepted for Oral Presentation / Accepted for Poster Presentation / Revision Required / Rejected",
    note: "Kept private until the Chair clicks “Publish Review Results”, at which point it is copied onto the submission's own status and the row is cleared.",
  },
  {
    field: "Desk review record (desk_review.decision)",
    values: "DESK ACCEPT / DESK REJECT",
    note: "Set at the same time as, and matching, the submission's own status during Desk Review.",
  },
  {
    field: "Certificate (certificates.status)",
    values: "GENERATED (the only value the application ever writes)",
    note: "A submission with no row in this table at all is treated the same as “certificate not yet generated” — there is no separate “pending” value used by the code.",
  },
  {
    field: "Registration (the registration table)",
    values: "No status column",
    note: "A submission either has a registration row or it doesn't; that alone is treated as its registration status by the interface.",
  },
];

const roleTableShort = {
  user: {
    actions: "Browse conferences; submit a paper as Primary Author; join as Co-Author; revise, finalize, register, and download a certificate.",
    restriction: "Cannot review papers or change any submission's status.",
  },
  reviewer: {
    actions: "View assigned Subject Areas; score submissions on 5 criteria; re-review revised papers.",
    restriction: "Can only review papers in their own assigned Subject Area(s); one review per paper.",
  },
  "meta-reviewer": {
    actions: "View all reviews for a submission together; record one private recommended decision.",
    restriction: "Recommendation stays hidden from the Chair until results are published.",
  },
  "session-chair": {
    actions: "Run the Oral session; mark presentations complete; score Poster submissions.",
    restriction: "Can only act on submissions in their assigned Subject Area.",
  },
  "poster-coordinator": {
    actions: "Set the Poster Session date/time; score Poster submissions.",
    restriction: "Assigned per conference; cannot act on Oral-track submissions.",
  },
  invitee: {
    actions: "Submit an Invited Talk paper directly, outside normal peer review.",
    restriction: "Can only submit to the conference(s) they were invited to.",
  },
  chair: {
    actions: "Create/manage conferences and Subject Areas; desk-review; record decisions; publish results; manage sessions; enable certificates.",
    restriction: "Can only manage a conference they created or co-chair.",
  },
  admin: {
    actions: "Grant, revoke, and reset Chair Portal access.",
    restriction: "The Admin listing page itself is not login-protected (see Limitations).",
  },
};

export const roleTable = roles.map((r) => [
  r.name,
  r.purpose,
  roleTableShort[r.id].actions,
  roleTableShort[r.id].restriction,
]);

export const stages = [
  {
    title: "Stage 1 — Accessing the Portal",
    points: [
      "A new user registers with their name, email, address, phone number, and a password. The password must be 8 to 100 characters long, include an uppercase letter, a lowercase letter, and at least two digits, and must not contain spaces.",
      "After registering, the account is created with status “ACTIVATION PENDING” and is not yet usable. An email is sent with a one-time Account Activation Code, which the user enters on the Account Activation page before they can log in.",
      "A regular User logs in at the User Login page. A Chair logs in separately, at the Chair Login page, using a different account system (its own “chairs” table).",
      "Three failed login attempts in a row lock that account for 5 minutes. While locked, the portal shows a popup with a live countdown that the user cannot close or click away from.",
      "After logging in, a User lands on My Dashboard, which lists every conference on the portal. If their email has also been given a Reviewer, Meta-Reviewer, Session Chair, Poster Coordinator, or Invitee role on any conference, they can also open that role's own dashboard.",
    ],
  },
  {
    title: "Stage 2 — Selecting or Accessing a Conference",
    points: [
      "The home page lists every conference on the portal, with its dates, and does not require login to view.",
      "Opening a specific conference's page does require login. From there, a User can start a new submission, or open “My Submissions” to see papers they already have on that conference.",
      "A conference can have any number of Subject Areas (optionally grouped under a Track label purely for organizing the Chair's “Manage Tracks” page). When starting a submission, the author picks one Subject Area for their paper from a dropdown list.",
      "See the “Conference, Track, and Subject Area” section further in this document for exactly how these three terms relate to each other in the code.",
    ],
  },
  {
    title: "Stage 3 — Starting a New Submission",
    points: [
      "The Primary Author fills in the paper's Title, Abstract, chosen Subject Area, and optionally lists Co-Author emails to invite.",
      "There is no “save as draft” feature in the code — a submission is only created in the database once the form is actually submitted with a file attached. There is no partially-saved state before that.",
      "A person who is also a Reviewer, Session Chair, or Invited Speaker on that conference is blocked from starting a submission as an Author.",
    ],
  },
  {
    title: "Stage 4 — Uploading the Paper",
    points: [
      "The file picker on the form suggests PDF, DOC, and DOCX files. The server enforces a 4 MB maximum file size, and separately checks the first few bytes of the uploaded file to confirm it genuinely is a PDF, DOC, or DOCX file (not just trusting the file's name) before accepting it.",
      "The accepted file is uploaded to Cloudinary (an external file-storage service) rather than being kept on the portal's own server disk; the submission record stores the resulting file URL.",
      "Right after upload, the portal reads the text out of the file and automatically runs an AI-generated-content detector on it, saving a score and a yes/no verdict with the submission (see the Limitations section for who can see this).",
    ],
  },
  {
    title: "Stage 5 — Validating and Completing the Submission",
    points: [
      "Title, Abstract, Subject Area, and Conference are all required before the server will accept the submission; the chosen Subject Area is checked against the chosen conference to make sure they match.",
      "The paper submission deadline set on the conference is enforced — once it has passed, the server will not accept a new submission for that conference.",
      "Two identifiers are generated for the paper: a random, unique Paper Code (used only so a Co-Author can “join” the right paper) and a separate, sequential, human-facing Paper ID, numbered 1, 2, 3, and so on within that one conference.",
      "The code does not check for duplicate submissions — nothing stops the same title being submitted more than once, by the same or a different author, as implemented.",
    ],
  },
  {
    title: "Stage 6 — Submission Confirmation",
    points: [
      "Once accepted, the submission is saved with status “Submitted for Review”.",
      "The portal redirects the author to their Dashboard with an on-screen confirmation message, and separately emails them a confirmation that includes their Paper Code to share with Co-Authors.",
      "A named Co-Author can then use that Paper Code to send a join request, which the Primary Author must approve from their Dashboard before the Co-Author is actually added to the paper.",
    ],
  },
  {
    title: "Stage 7 — Administrative Processing (Desk Review)",
    points: [
      "The Chair opens the Desk Review page for their conference, which lists every submission still at “Submitted for Review”.",
      "The Chair records a Desk Review decision: “DESK ACCEPT” (moves on to peer review) or “DESK REJECT” (the Chair must also enter written rejection remarks, and the author is emailed with the decision).",
      "This is also where Reviewers, a Meta-Reviewer, and Session Chairs/Panelists were already assigned earlier — when the Chair set up the paper's Subject Area — rather than being assigned per paper at this stage.",
    ],
  },
  {
    title: "Stage 8 — Peer Review",
    points: [
      "Every Reviewer assigned to a Subject Area can see and review every “DESK ACCEPT” submission in that Subject Area — there is no per-paper assignment, workload limit, or conflict-of-interest check in the code.",
      "A Reviewer scores a paper on five criteria (Originality, Relevance, Technical Quality, Clarity, Impact), which the portal averages into a Mean Score, adds written Remarks, and picks a recommended decision.",
      "A reviewer can submit only one review per paper; a second attempt is blocked.",
      "The code does not enforce the conference's peer-review deadline date — that date is shown on the Chair's dashboard but is informational only, as implemented.",
      "Once reviews exist, either the Chair reads them directly (see Stage 9, Path A) or, if that Subject Area has a Meta-Reviewer, the Meta-Reviewer reads every review together and records a private recommendation (Path B).",
    ],
  },
  {
    title: "Stage 9 — Decision Making",
    points: [
      "Path A — direct Chair decision: on the “Resolve Conflicts” page, the Chair reads every reviewer's raw scores and remarks and records the final decision themselves right away (Accepted for Oral Presentation / Accepted for Poster Presentation / Revision Required / Rejected), with final remarks. This updates the submission immediately.",
      "Path B — Meta-Reviewer recommendation: the Meta-Reviewer records a private recommendation that is not visible to the Chair. Nothing happens to the submission until the Chair clicks “Publish Review Results”, at which point the portal applies every pending Meta-Reviewer recommendation to its submission and emails every author (except those still awaiting a decision) their result in one batch.",
      "Nothing in the code forces a Chair to use Path B even when a Meta-Reviewer is assigned — both paths are always available side by side. See the Limitations section.",
      "Whichever path is used, the author is informed by email, with the decision shown in the message.",
    ],
  },
  {
    title: "Stage 10 — Revisions and Resubmissions",
    points: [
      "If the decision was “Revision Required”, only the Primary Author (not a Co-Author) can upload the Revised Paper; the submission's status changes to “Submitted Revised Paper”, and the new file replaces the old one on the same submission record (the previous version is not kept as a separate, retrievable copy in the portal).",
      "Reviewers for that Subject Area can then re-review the paper (separate scoring form, separate table from the first round of reviews).",
      "The Chair records the final decision for the revised paper on “Resolve Re-Review Conflicts”. The Meta-Reviewer is not involved in this second round, as implemented.",
      "The same decision options are offered again, including “Revision Required” — so, in principle, a paper could be sent back for a second revision, though the interface is built around a single revision round.",
      "No separate revision deadline date is enforced by the code.",
    ],
  },
  {
    title: "Stage 11 — Final Paper and Presentation Preparation",
    points: [
      "Once a paper is “Accepted for Oral Presentation” or “Accepted for Poster Presentation”, the author submits a Final Camera-Ready Paper, which sets the status to “Submitted Final Camera Ready Paper for Oral/Poster Presentation”.",
      "The author then Registers for the conference: choosing Online or Offline presentation, entering how many co-authors will attend in person (if offline), and providing a link to a video of their presentation. Once submitted, that submission's Register option is disabled and a read-only summary is shown instead.",
      "The Chair sets an Oral session's date/time per Subject Area, or the Poster Session's date/time for the whole conference; once set, the author sees this schedule on their “My Submissions” view, or a “(Schedule Not Released Yet)” message if it has not been set.",
      "A presentation's “mode” (Online/Offline) is chosen once at Registration; the code does not show a separate way to change it afterwards.",
    ],
  },
  {
    title: "Stage 12 — Final Status and Closure",
    points: [
      "On the day of presentation, an Oral paper is marked “Presentation Completed” by a Session Chair/Panelist; a Poster paper is marked “Poster Scored” by a Panelist or Poster Presentation Coordinator (with a score recorded in both cases).",
      "After that, the Chair can click “Enable PDF Download” for their conference. This gives every “Poster Scored” or “Presentation Completed” submission a certificate record marked “GENERATED” (clicking it again safely skips papers that already have one).",
      "The author can then download a Certificate of Presentation at any time. The certificate PDF is generated fresh, on the spot, from a template image each time it is downloaded — no certificate file is ever stored on the server.",
      "This is the final stage supported by the code. There is no further status after “Poster Scored” / “Presentation Completed”, and no separate “conference proceedings” feature was found in the codebase.",
    ],
  },
];

export const limitations = [
  {
    title: "The Admin page is not login-protected",
    body:
      "The page at /admin, which lists every Conference Chair's name, email, phone number, department, and status, and every conference on the portal, can be opened by anyone with the link — the route has no authentication check at all. Only the buttons on that page (grant access, revoke access, reset password, delete account) check that the logged-in email is on the ADMIN_EMAILS allow-list. This is a real gap in the current code, not a working restriction, and is listed here exactly as found.",
  },
  {
    title: "Two separate, independent decision-making paths exist",
    body:
      "The application has two different ways a Chair can record a submission's final decision, and they do not go through each other. Path A: the Chair opens “Resolve Conflicts”, reads every reviewer's raw scores and remarks directly, and sets the decision themselves right away. Path B: a Meta-Reviewer (if one is assigned to that Subject Area) privately records a recommendation, which only takes effect once the Chair clicks “Publish Review Results”. Nothing in the code stops a Chair from using Path A on a submission whose Subject Area also has a Meta-Reviewer assigned — the privacy protection built around the Meta-Reviewer's recommendation only applies if the Chair chooses Path B. Also, a paper's second round, after “Submitted Revised Paper”, always goes through a version of Path A (“Resolve Re-Review Conflicts”) — the Meta-Reviewer is never consulted again for a revised paper.",
  },
  {
    title: "Only one deadline is actually enforced",
    body:
      "A conference stores four dates shown to users: the paper submission deadline, the acceptance notification date, the camera-ready paper deadline, and the peer-review deadline. Of these, only the paper submission deadline is actually checked by the code before it blocks a new submission or an edit. The other three dates are informational only, as implemented — the portal does not stop a late camera-ready upload or a late review, for example.",
  },
  {
    title: "The AI-content detection score is only ever shown to Reviewers",
    body:
      "Every primary submission is automatically scanned for AI-generated text at upload time (using the ai-text-detector package on the uploaded file's extracted text), and a score and a yes/no verdict are stored with the submission. This score and verdict are shown to Reviewers on the Review Submission page, with a warning note when a paper is flagged, but they are not shown anywhere to the Author, the Chair, or the Meta-Reviewer, as implemented.",
  },
  {
    title: "Reviewer assignment has no conflict-of-interest or workload check",
    body:
      "A Reviewer can review any paper in a Subject Area they are listed on. The code does not check whether a reviewer already has too many papers, or whether they have a personal connection to a specific paper's authors.",
  },
  {
    title: "Invited Talk submissions follow a shorter path",
    body:
      "Unlike regular Author submissions, Invited Talk submissions (made by an Invitee) do not go through Desk Review, Peer Review, the Meta-Reviewer, Revision, Camera-Ready submission, Registration, or the Certificate feature, as implemented. They are stored in their own table and only have a submit / view / delete flow.",
  },
  {
    title: "“Track” is used for two different things",
    body:
      "The interface and the database do not use the word “track” consistently. See the “Conference, Track, and Subject Area” section for the full explanation; in short, the database table literally named conference_tracks is what the interface calls a “Subject Area”, while the interface's own “Track” label refers to a separate, simpler grouping table.",
  },
];
