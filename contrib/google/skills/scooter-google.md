---
name: scooter-google
type: knowledge
version: 1.0.0
triggers:
- google
- google drive
- drive
- google docs
- google doc
- google sheets
- google sheet
- spreadsheet
- google slides
- gmail
- email
- inbox
- google calendar
- calendar
- meeting
- workspace
- g suite
- gsuite
---

# Google Workspace: Drive, Docs, Sheets, Slides, Calendar, Gmail (scooter-google)

You can call Google Workspace APIs through the credential broker. You never see
a Google credential: the broker mints a short-lived access token from a service
account and injects it as `Authorization: Bearer …`. You get Google's normal JSON
responses back.

Use the `agent-broker` CLI. The first path segment after `google/` is the
**googleapis.com subdomain**, and the rest is the API path on that host:

```bash
agent-broker "google/<host>/<api-path>" [curl-args...]
#   google/www/drive/v3/files     -> https://www.googleapis.com/drive/v3/files
#   google/sheets/v4/spreadsheets -> https://sheets.googleapis.com/v4/spreadsheets
```

| API | host | path prefix |
|---|---|---|
| Drive | `www` | `drive/v3/...` (uploads: `upload/drive/v3/...`) |
| Calendar | `www` | `calendar/v3/...` |
| Docs | `docs` | `v1/documents/...` |
| Sheets | `sheets` | `v4/spreadsheets/...` |
| Slides | `slides` | `v1/presentations/...` |
| Gmail | `gmail` | `gmail/v1/users/me/...` |
| People | `people` | `v1/...` |
| Tasks | `tasks` | `tasks/v1/...` |
| Forms | `forms` | `v1/forms/...` |

Any other host is a **404 at the broker**. That's deliberate, and you shouldn't
try to route around it. A 404 on an allowed host with no
`X-Broker-Upstream-Url` header means the provider isn't enabled in this
deployment, so tell the user.

## Whose data you see

The deployment acts as **one Workspace user**, or as **the conversation's
owner**, through domain-wide delegation. In both cases `users/me` and
`calendars/primary` resolve to that user. Without delegation it acts as the
service account itself, which only sees files shared with it.

A **403 from the broker** saying the owner isn't in an allowed domain means this
conversation has no Google identity. A 403 from Google is a missing scope or a
missing share. Check which one you got before you conclude anything.

## Drive: find files first

You rarely know a file id up front, so search for it:

```bash
# name/fulltext search; `q` is Drive's query language, URL-encoded
agent-broker "google/www/drive/v3/files?q=name%20contains%20%27roadmap%27%20and%20trashed%3Dfalse&fields=files(id,name,mimeType,modifiedTime,webViewLink)&pageSize=20"

# include shared drives
agent-broker "google/www/drive/v3/files?q=...&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives"

# export a Google Doc as text/markdown (Docs/Sheets/Slides can't be downloaded with alt=media)
agent-broker "google/www/drive/v3/files/FILE_ID/export?mimeType=text/markdown"
agent-broker "google/www/drive/v3/files/FILE_ID/export?mimeType=text/csv"     # first sheet only

# download a regular (non-Google) file
agent-broker "google/www/drive/v3/files/FILE_ID?alt=media" -o /tmp/file
```

The id is the long token in a docs URL: `docs.google.com/document/d/<ID>/edit`.

## Sheets

```bash
# metadata: sheet (tab) names and sizes
agent-broker "google/sheets/v4/spreadsheets/SHEET_ID?fields=sheets.properties"
# a range (A1 notation, URL-encoded: 'Tab 1'!A1:F50 -> %27Tab%201%27%21A1%3AF50)
agent-broker "google/sheets/v4/spreadsheets/SHEET_ID/values/Sheet1%21A1%3AF50"
```

## Docs

`google/docs/v1/documents/DOC_ID` returns the structured document, which is
verbose. For reading the text, the Drive **export** to `text/markdown` above is
usually what you want.

## Calendar

```bash
# upcoming events, expanded recurrences, in order
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
agent-broker "google/www/calendar/v3/calendars/primary/events?timeMin=$NOW&singleEvents=true&orderBy=startTime&maxResults=20"
```

## Gmail

```bash
# search (Gmail query syntax, URL-encoded) -> message ids only
agent-broker "google/gmail/gmail/v1/users/me/messages?q=from%3Aalice%20newer_than%3A7d&maxResults=20"
# one message, headers only (cheap); format=full for bodies (base64url-encoded)
agent-broker "google/gmail/gmail/v1/users/me/messages/MSG_ID?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date"
```

Mail is sensitive. Only read what the task needs, and don't paste message bodies
into PRs, issues or other shared places.

## Writes

By default the scopes are **read-only**, so a write gets a 403 from Google
(`insufficient authentication scopes`). That's the deployment's choice, not a
bug to work around. If a deployment has granted write scopes, say what you're
about to change (send, edit, delete, create events) and get the user's go-ahead
first. A sent email can't be unsent.

## Paging and limits

List endpoints return `nextPageToken`. Pass it back as `pageToken=` until it's
gone, and don't report a first-page count as the total. Use `fields=` to keep
responses small. A 429 or `rateLimitExceeded` means back off and retry later.
Don't fan out parallel calls.
