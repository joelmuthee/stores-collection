# Apps Script Deployment

## Step 1 — Create the Google Sheet

1. Go to sheets.google.com → New spreadsheet
2. Name it: `Oloolua Collections`
3. It will open with a blank "Sheet1" — leave it for now

## Step 2 — Open the Script Editor

Extensions → Apps Script

It opens with a default `Code.gs` file.

## Step 3 — Paste the code

1. Select all the default code in `Code.gs` and delete it
2. Paste the contents of `apps-script/Code.gs` from this repo
3. Save (Ctrl+S)

## Step 4 — Run setup once

1. In the function dropdown (top toolbar), select `setupSheet`
2. Click Run
3. Grant permissions when prompted (it needs access to Sheets and Drive)
4. Check the Execution Log — you should see "Setup complete"
5. Go back to your Sheet — you should now see tabs: Products, Aliases, Customers, Staff

## Step 5 — Deploy as web app

1. Click Deploy → New deployment
2. Click the gear icon next to "Select type" → choose **Web app**
3. Settings:
   - Description: `Oloolua Collection System v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click Deploy
5. Copy the **Web app URL** — it looks like:
   `https://script.google.com/macros/s/AKfycbx.../exec`
6. Save this URL — the PWA needs it

## Step 6 — Test it

Open the URL in a browser. You should see:
```json
{"ok":true,"message":"Oloolua Collection System is running."}
```

Test daily summary:
```
https://script.google.com/macros/s/YOUR_ID/exec?action=getDailySummary
```

Or use the curl tests in `apps-script/test.sh`.

## Updating the code

When you change `Code.gs`:
1. Deploy → Manage deployments
2. Click the pencil (edit) on your deployment
3. Change version to **New version**
4. Click Deploy

The URL stays the same.

## Environment note

The script runs under **your Google account**. Drive images will be stored in
your Drive under `Oloolua Collections / Year / Month / Day /`.

The sheet and Drive folder must be owned by the same account that deployed the script.
