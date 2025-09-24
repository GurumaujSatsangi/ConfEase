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

document.querySelector("form").addEventListener("submit", function () {
  var loadingModal = new bootstrap.Modal(
    document.getElementById("loadingModal")
  );
  loadingModal.show();
});

if (window.location.search.includes("message=")) {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function renderTrackRows(n) {
  const tbody = document.getElementById("tracksTableBody");
  tbody.innerHTML = "";
  for (let i = 1; i <= n; i++) {
    tbody.innerHTML += `
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
renderTrackRows(document.getElementById("numTracks").value);

// Update rows on input change
document.getElementById("numTracks").addEventListener("input", function () {
  let n = parseInt(this.value, 10);
  if (isNaN(n) || n < 1) n = 1;
  renderTrackRows(n);
});

document.querySelector("form").addEventListener("submit", function () {
  var loadingModal = new bootstrap.Modal(
    document.getElementById("loadingModal")
  );
  loadingModal.show();
});

document.querySelector("form").addEventListener("submit", function () {
  var loadingModal = new bootstrap.Modal(
    document.getElementById("loadingModal")
  );
  loadingModal.show();
});
function updateNumTracks() {
  document.getElementById("numTracks").value = document.querySelectorAll(
    "#tracksTableBody tr"
  ).length;
}

