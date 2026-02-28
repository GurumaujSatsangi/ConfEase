/**
 * Token Management & Refresh Logic for Frontend
 * Add this to public/script.js or include in your templates
 */

// =====================
// TOKEN REFRESH HANDLER
// =====================

/**
 * Attempt to refresh the access token using the refresh token
 * @returns {boolean} true if refresh successful, false otherwise
 */
async function refreshAccessToken() {
  try {
    const response = await fetch("/auth/refresh", {
      method: "POST",
      credentials: "include", // Important: include cookies
    });

    if (response.ok) {
      console.log("Token refreshed successfully");
      return true;
    } else {
      console.log("Token refresh failed");
      redirectToLogin("Session expired. Please login again.");
      return false;
    }
  } catch (error) {
    console.error("Token refresh error:", error);
    redirectToLogin("Error refreshing session. Please login again.");
    return false;
  }
}

/**
 * Redirect user to login page
 * @param {string} message - Message to display
 */
function redirectToLogin(message) {
  const encodedMessage = encodeURIComponent(message);
  window.location.href = `/login/user?message=${encodedMessage}`;
}

/**
 * Enhanced fetch wrapper that automatically handles token refresh
 * Use this instead of regular fetch() for all API/server calls
 * 
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>} Response object
 */
async function fetchWithTokenRefresh(url, options = {}) {
  // Ensure credentials are included (for httpOnly cookies)
  options.credentials = options.credentials || "include";

  let response = await fetch(url, options);

  // If access token expired (401 Unauthorized)
  if (response.status === 401) {
    // Try to refresh token
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      // Retry the original request with new token
      // IMPORTANT: Only retry GET requests and idempotent requests
      // Do NOT retry POST/PUT/DELETE without user confirmation
      if (
        options.method === undefined ||
        options.method === "GET" ||
        options.method === "HEAD"
      ) {
        response = await fetch(url, options);
      } else {
        // For non-idempotent requests, prompt user or just fail
        console.warn("Non-idempotent request failed. Not retrying.");
      }
    } else {
      // Refresh failed, redirect to login already done in refreshAccessToken
      return response;
    }
  }

  return response;
}

/**
 * Handle form submissions with token refresh
 * Add data-auto-refresh="true" to any form to enable this
 */
document.addEventListener("DOMContentLoaded", function () {
  const formsWithRefresh = document.querySelectorAll("form[data-auto-refresh]");

  formsWithRefresh.forEach((form) => {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      const formData = new FormData(this);
      const method = this.method.toUpperCase() || "POST";
      const action = this.action;

      try {
        const response = await fetchWithTokenRefresh(action, {
          method: method,
          body: formData,
        });

        if (response.ok) {
          // Form submitted successfully
          if (response.redirected) {
            window.location.href = response.url;
          } else {
            // Handle response as needed
            this.submit(); // Fallback to normal form submission
          }
        } else {
          console.error("Form submission failed:", response.status);
        }
      } catch (error) {
        console.error("Form submission error:", error);
      }
    });
  });
});

// =====================
// LOGOUT HANDLER
// =====================

/**
 * Logout user and clear tokens
 */
async function logout() {
  try {
    const response = await fetch("/auth/logout", {
      method: "POST",
      credentials: "include",
    });

    if (response.redirected) {
      window.location.href = response.url;
    } else {
      window.location.href = "/?message=Logged out successfully!";
    }
  } catch (error) {
    console.error("Logout error:", error);
    // Even if logout fails, redirect to home
    window.location.href = "/";
  }
}

/**
 * Add logout handlers to all logout buttons/links
 */
document.addEventListener("DOMContentLoaded", function () {
  const logoutButtons = document.querySelectorAll("[data-logout]");
  logoutButtons.forEach((btn) => {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      logout();
    });
  });
});

// =====================
// AUTOMATIC TOKEN REFRESH (Optional)
// =====================

/**
 * Optional: Automatically refresh token 5 minutes before expiry (10 minutes total if token is 15 min)
 * This prevents users from seeing "session expired" errors mid-work
 * 
 * Uncomment to enable:
 */

/*
let tokenRefreshTimer = null;

function startTokenRefreshTimer() {
  // Clear any existing timer
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
  }

  // Refresh token 10 minutes from now (5 min before 15-min expiry)
  tokenRefreshTimer = setTimeout(() => {
    console.log("Auto-refreshing token...");
    refreshAccessToken();
    // Restart the timer
    startTokenRefreshTimer();
  }, 10 * 60 * 1000); // 10 minutes
}

document.addEventListener("DOMContentLoaded", function () {
  // Start auto-refresh timer when page loads (assuming user is logged in)
  // Check if accessToken cookie exists by trying a simple fetch
  fetch("/auth/check-status", {
    method: "POST",
    credentials: "include",
  })
    .then((response) => {
      if (response.ok) {
        startTokenRefreshTimer();
      }
    })
    .catch(() => {
      // User not logged in
    });
});

// Clear timer on page unload
window.addEventListener("beforeunload", () => {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
  }
});
*/

// =====================
// USAGE EXAMPLES
// =====================

/*
 * Example 1: Simple fetch request
 * -----------
 * Instead of:
 *   fetch("/api/data").then(r => r.json())
 * 
 * Use:
 *   fetchWithTokenRefresh("/api/data").then(r => r.json())
 * 
 * 
 * Example 2: Form with auto-refresh
 * -----------
 * <form method="POST" action="/submit" data-auto-refresh="true">
 *   <!-- form fields -->
 *   <button type="submit">Submit</button>
 * </form>
 * 
 * 
 * Example 3: Logout button
 * -----------
 * <button data-logout>Logout</button>
 * 
 * Or: <a href="#" data-logout>Logout</a>
 */
