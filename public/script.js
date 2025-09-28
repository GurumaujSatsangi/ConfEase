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

// Show loading modal on form submission (only add if loadingModal exists)
document.addEventListener("DOMContentLoaded", function () {
  const forms = document.querySelectorAll("form");
  const loadingModal = document.getElementById("loadingModal");
  
  if (loadingModal && forms.length > 0) {
    forms.forEach(form => {
      form.addEventListener("submit", function () {
        var modal = new bootstrap.Modal(loadingModal);
        modal.show();
      });
    });
  }
});
