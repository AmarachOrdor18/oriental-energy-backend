# Enabling real email delivery

The email pipeline is fully wired — scheduled reminders AND event-driven sends
(approve / reject / query / month-approve / broadcast) all deliver through one service.
Until SMTP is configured, emails are **logged to the console** instead of sent
(in-app notifications always work).

## To switch on real delivery

Add these to `oriental-energy-backend/.env`:

```
SMTP_HOST=smtp.yourprovider.com     # e.g. smtp-relay.gmail.com, smtp.sendgrid.net
SMTP_PORT=587                       # 587 = STARTTLS, 465 = implicit TLS
SMTP_USER=your-username
SMTP_PASS=your-password
MAIL_FROM=Oriental Energy TMS <no-reply@oriental-er.com>
```

Restart the backend. The startup log will show:

```
[EMAIL] SMTP configured via smtp.yourprovider.com:587
```

If you use Microsoft 365 and prefer the modern path, point SMTP_HOST at
`smtp.office365.com:587` (works today), or later swap in Microsoft Graph API
credentials — `sendEmail()` in `src/services/emailService.ts` is the single
place to change.

## What fires emails automatically

| Event | Who gets it |
|---|---|
| Timesheet approved (single / bulk / month) | The employee |
| Timesheet returned with reason | The employee |
| Finance query / rejection | The employee |
| Friday outstanding-timesheet reminder (open periods only) | Everyone outstanding |
| Month-end reminder (25th, open period only) | Everyone with unsubmitted work |
| Admin broadcast reminder | Targeted staff |
