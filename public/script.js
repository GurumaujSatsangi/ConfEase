document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.delete-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      const href = this.getAttribute('href');
      const title = this.getAttribute('data-title');
      Swal.fire({
        title: "Alert!",
        text: "Are you sure you want to delete your submission titled '" + title + "'? This action cannot be undone.",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#3085d6",
        cancelButtonColor: "#d33",
        confirmButtonText: "Yes, Delete my submission."
      }).then((result) => {
        if (result.isConfirmed) {
          window.location.href = href;
        }
      });
    });
  });
});


document.querySelector("form").addEventListener("submit", function() {
  var loadingModal = new bootstrap.Modal(document.getElementById('loadingModal'));
  loadingModal.show();
});


 if (window.location.search.includes('message=')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }