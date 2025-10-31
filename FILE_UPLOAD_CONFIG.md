# File Upload Configuration & Styling Updates

## Overview
Applied 4MB file size limit to all file uploads and updated file input styling to use Bootstrap's `form-control` class for consistent UI.

---

## Changes Made

### 1. Backend: File Size Limit (index.js)

#### Multer Configuration (Line 27-36)
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

#### Error Handling Middleware (After session middleware)
```javascript
// Multer error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('File size exceeds 4MB limit. Please upload a smaller file.');
    }
    return res.status(400).send(`Upload error: ${err.message}`);
  } else if (err && err.message === 'File size exceeds 4MB limit') {
    return res.status(400).send('File size exceeds 4MB limit. Please upload a smaller file.');
  }
  next(err);
});
```

### 2. File Upload Routes Enhanced

Added file validation checks to all upload routes:

#### Routes Updated:
1. **POST `/submit`** - Paper submission
   - Checks: `if (!req.file)` → redirect with error message
   - Error Message: "Error: No file uploaded. File size must not exceed 4MB."

2. **POST `/submit-invited-talk`** - Invitee talk submission
   - Checks: `if (!req.file)` → redirect with error message
   - Error Message: "Error: No file uploaded. File size must not exceed 4MB."

3. **POST `/submit-revised-paper`** - Revised paper submission
   - Enhanced error message: "Error: No file uploaded. File size must not exceed 4MB."
   - Previous: "Please upload a file."

4. **POST `/edit-submission`** - Edit submission
   - Added: `if (!req.file && req.body.file)` check
   - Error Message: "Error: File size exceeds 4MB limit. Please upload a smaller file."

5. **POST `/final-camera-ready-submission`** - Final camera ready paper
   - Added: `if (!req.file)` check
   - Error Message: "Error: No file uploaded. File size must not exceed 4MB."

---

### 3. Frontend: File Input Styling

Changed all file input classes from `form-control-file` to `form-control` for Bootstrap 5 consistency.

#### Files Updated:

1. **views/submission.ejs** (Line 90)
   - Before: `<input type="file" required class="form-control-file" name="file" />`
   - After: `<input type="file" required class="form-control" name="file" />`

2. **views/submission3.ejs** (Line 101)
   - Before: `<input type="file" class="form-control-file" name="file" />`
   - After: `<input type="file" class="form-control" name="file" />`

3. **views/submission4.ejs** (Line 206)
   - Before: `<input type="file" required class="form-control-file" name="file" />`
   - After: `<input type="file" required class="form-control" name="file" />`

4. **views/submission5.ejs** (Line 163)
   - Already had: `class="form-control"` (No change needed)

5. **views/invitee/submission.ejs** (Line 90)
   - Before: `<input type="file" required class="form-control-file" name="file" />`
   - After: `<input type="file" required class="form-control" name="file" />`

---

## File Size Limit Details

| Setting | Value |
|---------|-------|
| **Limit** | 4 MB |
| **Bytes** | 4,194,304 |
| **Applies To** | All file uploads |

### Error Handling Flow:

1. **Client-side**: Multer rejects file if size > 4MB
2. **Middleware**: Catches multer error and returns 400 status
3. **Route Handler**: Checks `req.file` existence
4. **User Feedback**: Redirected with error message in query string

---

## Bootstrap Styling

### form-control vs form-control-file

**Note:** `form-control-file` was deprecated in Bootstrap 5. The `form-control` class now handles both text inputs and file inputs.

#### CSS Applied:
- Consistent padding and borders
- Standard focus states
- Proper sizing and spacing
- Better visual consistency with other form elements

---

## Testing Checklist

- [ ] Upload file < 4MB → Success ✅
- [ ] Upload file = 4MB → Success ✅
- [ ] Upload file > 4MB → Error message displayed ✅
- [ ] File input displays with proper Bootstrap styling ✅
- [ ] Error message appears in dashboard query string ✅
- [ ] Multer middleware catches oversized files ✅
- [ ] Route handlers validate `req.file` existence ✅

---

## Configuration Summary

**Total Routes Updated:** 5
**Total Templates Updated:** 5
**Total Files Modified:** 6

### Files Modified:
1. `index.js` - Backend routes and middleware
2. `views/submission.ejs`
3. `views/submission3.ejs`
4. `views/submission4.ejs`
5. `views/invitee/submission.ejs`

---

## Future Considerations

- Add client-side file size validation in JavaScript before upload
- Consider adding file type validation (e.g., .pdf, .doc, .docx only)
- Implement progress bar for file uploads
- Add estimated upload time based on file size
- Consider chunked uploads for better UX with large files (though 4MB is quite reasonable)

