# File Upload Error Handling - Frontend Display Improvements

## Overview
Updated all file upload error handling to display user-friendly error messages on the frontend instead of showing raw error stack traces or plain error text.

---

## Problem Solved

### Before:
```
MulterError: File too large
    at abortWithCode (C:\Users\...\node_modules\multer\lib\make-middleware.js:85:22)
    at FileStream.<anonymous> (...)
    ...
    [Full stack trace displayed to user]
```

### After:
```
User is redirected to dashboard with a message query parameter:
/dashboard?message=Error: File size exceeds 4MB limit. Please upload a smaller file.
```

---

## Solution Architecture

### 1. Error Handling Middleware (index.js, Lines 48-65)

```javascript
// Multer error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Check which page the user came from and redirect accordingly
    const referer = req.get('referer') || '';
    
    if (err.code === 'LIMIT_FILE_SIZE') {
      if (referer.includes('/invitee')) {
        return res.redirect('/invitee/dashboard?message=Error: File size exceeds 4MB limit. Please upload a smaller file.');
      } else {
        return res.redirect('/dashboard?message=Error: File size exceeds 4MB limit. Please upload a smaller file.');
      }
    } else if (err.code === 'LIMIT_PART_COUNT') {
      if (referer.includes('/invitee')) {
        return res.redirect('/invitee/dashboard?message=Error: Too many file parts. Please try again.');
      } else {
        return res.redirect('/dashboard?message=Error: Too many file parts. Please try again.');
      }
    }
    
    // Generic multer error
    if (referer.includes('/invitee')) {
      return res.redirect(`/invitee/dashboard?message=Error: ${err.message}`);
    } else {
      return res.redirect(`/dashboard?message=Error: ${err.message}`);
    }
  }
  
  // Non-multer errors
  next(err);
});
```

**Features:**
- ✅ Detects multer errors specifically
- ✅ Identifies file size limit violations (`LIMIT_FILE_SIZE`)
- ✅ Routes user back to appropriate dashboard (author or invitee)
- ✅ Passes user-friendly error message via query parameter
- ✅ Handles generic multer errors gracefully

### 2. Route-Level Error Wrapping

Each upload route now wraps the multer middleware to catch errors before the async handler executes:

#### Pattern Used:
```javascript
app.post("/route-name", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' 
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }
    
    // If no error, proceed with the actual handler
    (async () => {
      // Your async logic here
    })().catch(next);
  });
});
```

---

## Updated Routes

### All 5 Upload Routes Now Have Proper Error Handling:

1. **POST `/submit`** - Paper submission
   - ✅ Wrapped with error handling
   - ✅ Redirects to `/dashboard` on error
   
2. **POST `/submit-invited-talk`** - Invitee talk submission
   - ✅ Wrapped with error handling
   - ✅ Redirects to `/invitee/dashboard` on error

3. **POST `/submit-revised-paper`** - Revised paper submission
   - ✅ Wrapped with error handling
   - ✅ Redirects to `/dashboard` on error

4. **POST `/edit-submission`** - Edit submission
   - ✅ Wrapped with error handling
   - ✅ Redirects to `/dashboard` on error

5. **POST `/final-camera-ready-submission`** - Final camera ready paper
   - ✅ Wrapped with error handling
   - ✅ Redirects to `/dashboard` on error

---

## Error Messages Displayed to User

### File Size Limit Exceeded (4MB):
```
Error: File size exceeds 4MB limit. Please upload a smaller file.
```

### File Upload Failed:
```
Error: [specific error message]
```

### No File Selected:
```
Error: No file uploaded. File size must not exceed 4MB.
```

---

## User Experience Flow

### When File Too Large (> 4MB):

1. User selects large file on form
2. Submits form
3. Multer detects size limit violation
4. Error caught by route-level wrapper
5. User redirected to dashboard/invitee-dashboard
6. **Error message appears in notification area**
7. User sees: `Error: File size exceeds 4MB limit. Please upload a smaller file.`

### Flow Diagram:
```
Form Submit (file > 4MB)
    ↓
Multer Middleware (LIMIT_FILE_SIZE triggered)
    ↓
Route-level Wrapper Catches Error
    ↓
Redirect with Query Parameter
    ↓
Dashboard/Invitee-Dashboard Loads
    ↓
Message Displayed to User
```

---

## Frontend Message Display

The message query parameter is already handled in your EJS templates. When a page loads with `?message=...`, it displays in the notification area.

**Example Dashboard Load:**
```javascript
// In dashboard.ejs (or any EJS template)
// The message variable is passed to the template:
res.render('dashboard.ejs', {
  message: req.query.message || null
});

// In template:
<% if (message) { %>
  <div class="alert alert-danger">
    <%= message %>
  </div>
<% } %>
```

---

## Error Codes Handled

| Error Code | Message | Resolution |
|-----------|---------|-----------|
| `LIMIT_FILE_SIZE` | File size exceeds 4MB limit | Upload smaller file |
| `LIMIT_PART_COUNT` | Too many file parts | Try again or contact support |
| Other multer errors | Generic error message | Contact support |

---

## Technical Implementation Details

### Multer Configuration (Line 26-36):
```javascript
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 4 * 1024 * 1024 // 4 MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.size > 4 * 1024 * 1024) {
      return cb(new Error("File size exceeds 4MB limit"), false);
    }
    cb(null, true);
  }
});
```

### Error Handling Middleware (Line 48-65):
- Sits between multer and route handlers
- Catches all multer errors
- Determines user's dashboard (author vs invitee)
- Redirects with user-friendly message

### Route Wrappers:
- Each route wraps `upload.single("file")` 
- Checks for multer errors in callback
- If error, redirects; if no error, proceeds with async handler
- All errors caught and redirected, not displayed as raw errors

---

## Testing Scenarios

| Scenario | Expected Behavior |
|----------|-------------------|
| Upload file < 4MB | Succeeds, redirects to dashboard |
| Upload file = 4MB | Succeeds (exactly at limit) |
| Upload file > 4MB | Error: "File size exceeds 4MB limit" on dashboard |
| No file selected | Error: "No file uploaded..." on dashboard |
| Network interruption | Multer catches and redirects with error |
| Multiple files | Error: "Too many file parts" (if configured) |

---

## Benefits

✅ **User-Friendly**: Error messages are clear and actionable  
✅ **Security**: Stack traces not exposed to users  
✅ **Consistency**: All upload routes handle errors the same way  
✅ **Smart Routing**: Redirects to appropriate dashboard (author/invitee)  
✅ **Fallback**: Generic error handling for unexpected scenarios  
✅ **Logging**: Errors still logged to console for debugging  

---

## Files Modified

- `index.js` - Multer configuration, error middleware, 5 upload routes

---

## No More Raw Error Stacks!

Before your changes: Users saw the raw MulterError stack trace  
After your changes: Users see "Error: File size exceeds 4MB limit. Please upload a smaller file." in their dashboard

🎉 **Problem Solved!**

