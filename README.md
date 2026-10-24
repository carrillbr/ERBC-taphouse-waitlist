# TapHouse Waitlist

A walk-in waitlist for Elk River Brewing Co. TapHouse in North East, MD. Staff run it from a tablet at the door or their phones. Guests can join by scanning a QR code and get a text when their table is ready.

- **Staff screen** (`/`): add parties, text them, seat them at a table, mark no-shows, and undo mistakes. Everything syncs live across every device that's signed in.
- **Table board**: four 4-tops and two 2-tops. Tap an open table to pick who sits there, or tap a busy one to clear it. Groups of 5 to 8 get two 4-tops pushed together.
- **Wait quotes**: worked out from who's seated, how long they've been there, and who's ahead in line.
- **Guest sign-up** (`/join`): guests add themselves from their phone. Staff can pause this from the ••• menu.
- **Guest status page** (`/s/...`): shows a guest's place in line live and switches to "Your table is ready!" when staff text them.
- **Texts**: a confirmation with the status link when a party joins, and a "table ready" text when staff tap **Text**. Guests can reply **C** to cancel.
- **QR sign** (`/qr`): a printable sign for the door or table tents.

There are no dependencies. It needs Node 22.13 or newer and uses Node's built-in SQLite.

## Run it locally

```sh
STAFF_PIN=4242 npm start
# Staff screen: http://localhost:3000   Guest sign-up: http://localhost:3000/join
npm test
```

Without Twilio settings the app runs in **demo mode**: nothing is sent automatically. Tapping **Text** opens the Messages app on the staff phone or iPad with the message already written, so the waitlist works before Twilio is approved.

## Settings

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | What it does |
| --- | --- | --- |
| `STAFF_PIN` | `1234` | PIN staff type to sign in. **Change it.** |
| `BASE_URL` | `http://localhost:3000` | Public address of the app. Used in texts and the QR code. |
| `VENUE_NAME` | `Elk River Brewing Co. TapHouse` | Shown to guests and in texts |
| `TABLES` | `20:4,21:4,22:4,23:4,10:2,11:2` | Table name and seats (2 or 4), in display order |
| `TURN_MINUTES_4TOP` / `TURN_MINUTES_2TOP` | `60` / `45` | Typical time a group stays. Drives the wait quotes. |
| `NO_SHOW_MINUTES` | `10` | How long a texted party has to show up before they're flagged |
| `TIMEZONE` | `America/New_York` | Used for "Tonight" stats. The night rolls over at 4am. |
| `DB_PATH` | `./data/waitlist.db` | Where the SQLite file lives. Put it on a persistent disk. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | none | Twilio credentials. Leave them out for demo mode. |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | none | The number (or messaging service) texts come from |

## Going live

1. **Host it** anywhere that runs Node or Docker and has a persistent disk for the database. The easiest is Render: choose New > Blueprint and pick this repository, and `render.yaml` sets up the service and a 1 GB disk (about $7.25/month). Railway or Fly.io also work with the included `Dockerfile`; mount a disk at `/data`.
2. **Set up texting** in Twilio: buy a local number, then complete A2P 10DLC registration for the brand and campaign (US carriers require it, and approval takes days to weeks). Use "customer care / notifications" as the use case, and show the opt-in wording from `/join`.
3. In Twilio, set the number's **incoming message webhook** to `POST {BASE_URL}/sms/inbound`. The app checks Twilio's signature on every inbound text.
4. Print the sign at `/qr` and put it at the door.
5. On the tablet, open the staff screen in Safari or Chrome and choose **Add to Home Screen**. It then opens full screen like an app.

## How the wait quote works

Each table is expected to free up at "seated time + turn time". Parties in line are matched, in order, to whichever fitting table frees up first. Pairs prefer a 2-top so the 4-tops stay open for bigger groups, and groups of 5 to 8 need two 4-tops. A party's quote is the time until its table frees up, rounded up to 5 minutes. Tune `TURN_MINUTES_*` after a few weeks, using the average wait shown under "Tonight".
