# StudyNotes (MVP)

A note-taking app for students with a free/paid tier split. This first version covers the **free tier**:

- Sign up / log in
- **Forgot password**: a "Forgot password?" link on the login screen lets you request a reset link. Since this app isn't hooked up to a real email service yet, the reset link is shown directly on screen (clearly labeled as a temporary stand-in for an emailed link) — the underlying flow (secure one-time token, 1-hour expiry) is built to work the same way once real email sending is added later.
- **Folders tab**: a "Folders" item in the sidebar opens a grid of all your folders in the main panel; click one to open it, or use the pencil/✕ icons on a card to rename, recolor, or delete it. Each folder can be color-coded (10 colors to choose from) to help you tell classes apart at a glance
- **Search**: a search box in the sidebar searches your note titles and content as you type, and shows which folder each result lives in
- Rich text formatting: bold, italic, underline, a choice of 9 fonts, and a highlighter icon in the toolbar that expands into 5 color options (yellow, green, blue, pink, or none/clear)
- Page templates: when you create a note you choose **Blank page** or **Lined page** (ruled paper); you can also switch a note's template later from the toolbar
- Unlimited pages per note: a note starts as one page, and as you fill it up, another page is automatically added so you can keep writing (this doesn't count against the 10-note limit - it's pages *within* one note set)
- Free plan is capped at 10 note sets, with an "Upgrade to Premium" prompt once you hit the limit (the upgrade button is a placeholder for now — no real payments are wired up yet)
- **Works on mobile browsers**: on a phone or narrow window, the sidebar tucks away behind a menu button so notes and the editor have full width; buttons and touch targets are sized for tapping instead of clicking
- Basic accessibility: icon-only buttons (bold, italic, highlighter, delete, rename, etc.) have screen-reader labels, and interactive toggles announce their expanded/collapsed state
- **Settings** (gear icon in the sidebar):
  - **Appearance**: Light / Dark / System theme, and a Small / Medium / Large text size for the app's menus and buttons (the note page itself always stays a plain white sheet so your highlighter colors and writing always look the same, regardless of theme)
  - **Account**: update your name, or change your password (requires your current password)
  - **Plan**: see your current plan and upgrade from there too
  - **Danger zone**: permanently delete your account and all its data (requires your password to confirm)
- **Terms of Service & Privacy Policy**: new sign-ups must check a box agreeing to both before an account can be created (enforced both in the browser and on the server, so it can't be skipped). Both documents are linked from the sign-up form, the login/sign-up footer, and the bottom of the Settings page. They spell out the plan's data policy in plain terms: StudyNotes doesn't keep more than it needs, and if someone cancels Premium, their plan stays active through the end of the period they already paid for — after that, the account drops to the Free plan's limits, and any notes/files beyond the 10 most-recently-updated notes (that they haven't downloaded a copy of) are deleted. **These are draft documents, not legal advice** — see the note below.

The paid-tier features from your brainstorm (unlimited notes/folders, upload & download files, AI-generated flashcards/quizzes/tests, and more page templates) are **not built yet** — those come next, along with actual payment processing. The template system is already set up so adding Premium-only templates later is a small change, not a rebuild.

## How to preview it on your computer

This is a small, self-contained app — it doesn't need you to install anything except Node.js.

1. **Install Node.js** (if you don't already have it): go to https://nodejs.org and install the current LTS version (needs to be version 22.5 or newer).
2. **Unzip** the `studynotes.zip` file you were sent, anywhere on your computer.
3. **Open a terminal** in that unzipped folder:
   - On Mac: right-click the folder → "New Terminal at Folder" (or open Terminal and `cd` into it).
   - On Windows: open the folder in File Explorer, click the address bar, type `cmd`, and hit Enter.
4. Run:
   ```
   node server.js
   ```
5. Open your browser to **http://localhost:3000** and try it out — sign up with any email/password (this is only stored on your own computer, nothing is sent anywhere).
6. To stop the server, go back to the terminal and press `Ctrl+C`.

Your account and notes are saved in a file at `data/studynotes.db` inside the folder. Delete that file any time to start fresh.

## About the Terms of Service / Privacy Policy

I drafted `public/terms.html` and `public/privacy.html` to match exactly what you described (data isn't kept beyond what's needed, and the cancel-Premium/10-note-limit deletion rule). They're a solid starting point, but **I'm not a lawyer, and these have not been reviewed by one** — there's a bright yellow notice at the top of each page saying so. Before you launch for real and start collecting sign-ups or payments, have an actual attorney review them, especially because:

- Your users are likely to include people under 18, which brings in extra legal requirements (like COPPA in the US) that a real lawyer should sign off on.
- A few spots are left as placeholders for facts only you can supply: the effective date, your Premium price, your contact email, and which state/country's law governs the agreement. Search both files for text in `[brackets]` to find them.

## What's next

Once you've clicked around and are happy with this direction (or have changes you want), the next steps are:

1. Add the remaining free-tier features you might think of.
2. Deploy this to a real hosting service so it has a public web address anyone can visit (instead of only running on your computer) — this is free or very cheap to start.
3. Build the paid tier: real payment processing (Stripe), file upload/download, and the AI study-material generator (flashcards, quizzes, tests) powered by the Claude API.
