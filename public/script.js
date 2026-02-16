document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".delete-btn").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      const href = this.getAttribute("href");
      const title = this.getAttribute("data-title");
      Swal.fire({
        title: "Alert!",
        text:
          "Are you sure you want to delete your submission titled '" +
          title +
          "'? This action cannot be undone.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#3085d6",
        cancelButtonColor: "#d33",
        confirmButtonText: "Yes, Delete my submission.",
      }).then((result) => {
        if (result.isConfirmed) {
          window.location.href = href;
        }
      });
    });
  });
});

// Remove message query parameter after page loads and alert is displayed
document.addEventListener("DOMContentLoaded", function () {
  if (window.location.search.includes("message=")) {
    // Small delay to ensure the alert is displayed first
    setTimeout(() => {
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 100);
  }
});

// Show loading modal on form submission (auto-creates modal if not present)
document.addEventListener("DOMContentLoaded", function () {
  const forms = document.querySelectorAll("form");
  if (forms.length === 0) return;

  // Create the loading modal dynamically if it doesn't exist on the page
  let loadingModalEl = document.getElementById("loadingModal");
  if (!loadingModalEl) {
    loadingModalEl = document.createElement("div");
    loadingModalEl.className = "modal fade";
    loadingModalEl.id = "loadingModal";
    loadingModalEl.setAttribute("tabindex", "-1");
    loadingModalEl.setAttribute("aria-hidden", "true");
    loadingModalEl.setAttribute("data-bs-backdrop", "static");
    loadingModalEl.setAttribute("data-bs-keyboard", "false");
    loadingModalEl.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content border-0 shadow" style="border-radius: 12px;">
          <div class="modal-body text-center py-4 px-4">
            <div class="spinner-border text-primary mb-3" style="width: 3rem; height: 3rem;" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
            <h5 class="mb-3" style="color: #333;">Please Wait... Loading</h5>
            <div class="progress" style="height: 6px; border-radius: 3px;">
              <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary"
                   role="progressbar" style="width: 100%;" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
            <p class="text-muted mt-2 mb-0" style="font-size: 0.85em;">This may take a moment. Please do not close or refresh the page.</p>
          </div>
        </div>
      </div>`;
    document.body.appendChild(loadingModalEl);
  } else {
    // Update existing modal content to include progress bar and message
    const modalContent = loadingModalEl.querySelector(".modal-content");
    if (modalContent) {
      modalContent.className = "modal-content border-0 shadow";
      modalContent.style.borderRadius = "12px";
      modalContent.innerHTML = `
        <div class="modal-body text-center py-4 px-4">
          <div class="spinner-border text-primary mb-3" style="width: 3rem; height: 3rem;" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <h5 class="mb-3" style="color: #333;">Please Wait... Loading</h5>
          <div class="progress" style="height: 6px; border-radius: 3px;">
            <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary"
                 role="progressbar" style="width: 100%;" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
          <p class="text-muted mt-2 mb-0" style="font-size: 0.85em;">This may take a moment. Please do not close or refresh the page.</p>
        </div>`;
    }
  }

  const loadingModal = new bootstrap.Modal(loadingModalEl);

  forms.forEach(form => {
    form.addEventListener("submit", function () {
      // Small delay so the browser initiates the form POST before Bootstrap locks the body
      setTimeout(function () {
        try { loadingModal.show(); } catch (e) { /* ignore */ }
      }, 50);
    });
  });

  // Hide modal when navigating back to the page (e.g. browser back button)
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      try { loadingModal.hide(); } catch (e) { /* ignore */ }
    }
  });
});

// Track management functionality for create-new-conference page only
document.addEventListener("DOMContentLoaded", function () {
  const numTracksInput = document.getElementById("numTracks");
  const tracksTableBody = document.getElementById("tracksTableBody");
  
  // Only initialize if we're on create-new-conference page and elements exist
  if (numTracksInput && tracksTableBody && window.location.pathname.includes('create-new-conference')) {
    
    function renderTrackRows(n) {
      tracksTableBody.innerHTML = "";
      for (let i = 1; i <= n; i++) {
        tracksTableBody.innerHTML += `
          <tr>
            <td>
              <div class="form-group">
                <input
                  type="text"
                  class="form-control"
                  name="track_title_${i}"
                  placeholder="Track Title ${i}"
                  required
                />
              </div>
            </td>
            <td>
              <div class="form-group">
                <input
                  type="email"
                  class="form-control"
                  name="track_reviewer_${i}"
                  placeholder="Reviewer Email ${i}"
                  required
                />
              </div>
            </td>
          </tr>
        `;
      }
    }
    
    // Initial render
    renderTrackRows(parseInt(numTracksInput.value) || 1);
    
    // Update rows when number of tracks changes
    numTracksInput.addEventListener("input", function () {
      let n = parseInt(this.value, 10);
      if (isNaN(n) || n < 1) n = 1;
      if (n > 20) n = 20;
      this.value = n; // Update the input value to the corrected value
      renderTrackRows(n);
    });
  }
});


function actionplan(){

Swal.fire({
  imageUrl: "./dummy.png",
  imageWidth: 500,
  imageHeight: 1000,
  imageAlt: "DEI CMT Process Flow"
});
}


function showNewChairMessage(){

       Swal.fire({
        title: "Alert!",
        text:
          "If you want to host a conference on the DEI Conference Management Toolkit (DEI CMT), please send the following details from your registered DEI Email ID to multimedia@dei.ac.in (CC: cmt@dei.ac.in) - 1) Conference Title, 2) Date of Conference, 3) List of Invited Speakers (Name & Organization), 4) Expected Number of Participants, 5) Conference Chairs (Name, Organization & Email ID). Once sent, the login credentials will be sent within 48 hours. ",
        icon: "info",
      })

}