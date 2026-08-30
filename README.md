# Mr. White

Everyone at the table is shown the same secret word. One of you is shown
nothing at all.

Going round in turn, each player says **one word** that hints at the secret
without giving it away. Mr. White has to invent a hint that fits — from
nothing but what the others have already said — while working out what on
earth everyone is talking about. Then you vote.

Play it on phones, in the same room or from anywhere. No app, no accounts.
One person starts a table, everyone else types four letters.

---

## The rules

1. Everyone gets the word. **Mr. White** gets nothing, and knows only that
   they are Mr. White.
2. In turn, each player says one word hinting at it. Not the word itself, and
   nothing anyone has already said.
3. Everyone votes. Most votes is out, and their role is revealed.
4. If Mr. White is caught, they get **one guess at the word** — and if they
   name it, they take the round anyway.
5. Civilians win by catching every Mr. White. Mr. White wins by lasting until
   the table is level.

**Scoring.** Civilians take 2 each for a win — including anyone voted out
along the way, because being wrongly suspected is not a failure, and docking
it would teach people to give hints so vague they say nothing. Mr. White
takes 6, for surviving or for naming the word from the gallows.

Two rules exist because the alternative is unplayable rather than merely
unfair:

- **The first speaker is never Mr. White.** With no word and no hints yet,
  that seat is not hard, it is impossible. Everyone knows this rule, so it
  gives nothing away.
- **A tie eliminates nobody** and sends the table round for another pass.
  Every pass adds a hint from everyone still alive, so the deadlock is broken
  with evidence rather than with a coin toss.

## Running it

```sh
git clone https://github.com/Natguy121/MrWhite
cd MrWhite
npm install
npm start
```

It prints two links. The second one works for anyone on the same wifi — open
it on each phone, or send round the invite link that the table code copies.

Everyone needs to reach the same server, so for players in different places
you need it somewhere public: any host that runs Node and allows WebSockets
will do. Put it behind HTTPS and the client switches to `wss://` on its own.
`PORT` and `HOST` are read from the environment.

## More ways to play

### Playing against an AI

Short a player, or just want a table with something unpredictable at it?
From the lobby, the host can tap **+ Add AI player** to seat one — it plays
a full seat, same as anyone else: it can be dealt Mr. White or a civilian,
gives its own hints, votes, and if it's caught, takes its own guess. It's
handed the exact same redacted view of the game a human at that seat would
get, nothing more, so it isn't cheating by seeing what it shouldn't.

With `ANTHROPIC_API_KEY` set on the server, its moves come from Claude
reasoning about the hints given so far — real language understanding, not a
lookup table. Without one — which is the default on a fresh Render deploy,
since billing is exactly the setup cost this project tries to avoid — the AI
falls back to the word list's own categories instead: a civilian bot always
knows its word's category (`pillow` → "Around the house"), so its hints stay
on-theme rather than generic, and a Mr. White bot, which does not know the
word, borrows whatever category the hints already given seem to match —
literal vocabulary lookup, not comprehension, but enough that its hints are
visibly shaped by what the table already said rather than deaf to it. Once a
category's short hint list runs dry it drops to genuinely generic filler,
same as before. The lobby says which mode you're in.

```sh
ANTHROPIC_API_KEY=sk-ant-... npm start   # smarter AI players, locally
```

On Render, add the key from the dashboard under the service's Environment
tab — `render.yaml` declares the variable but deliberately leaves it unset,
so the value itself never lives in this repo.

### Playing in VR

Open **`/vr.html`** and you are sitting at a round table in a villa, in the
evening, with everyone else at the table around you and a keyboard floating
in mid air to type your hints on. Point at a key and pull the trigger; point
at the player you suspect and pull it again to vote.

It is another client, not another game. It speaks the same protocol as the
phone client, so **a headset and four phones can sit at one table** — the
server has no idea which of its players is wearing one. The rule that
matters is untouched for the same reason: the word is redacted in
`Game.viewFor` on the server, so a Mr. White in a headset is not sent it
either, and no amount of poking at a 3D scene can reveal something that
never arrived.

**Got one of the cardboard or plastic viewers you drop a phone into?** Tap
**Phone in a viewer** and the screen splits into two lens views. Your head
steers — the phone's gyroscope drives the camera, with the first reading
taken as "straight ahead" so you start facing the table whichever way the
compass happens to point — and you pick things by looking at them: rest the
reticle on a key and a ring fills, or tap the screen if your viewer has one
of those levers that pokes it. Two fingers re-centres you; **Exit** sits in
the seam between the two lenses.

A real two-lens viewer expects the two views side by side, which needs
landscape — the page tries to lock the screen that way itself, but iOS
refuses that lock outright, and rotation lock defeats it on any platform, so
the real viewport can easily stay portrait no matter which way the phone is
actually held. Rather than depend on that lock working, the two lens views
stack one above the other instead whenever the real screen is still
portrait — nothing to do, and no viewer to line up with either, so this is
really only for the no-viewer, drag-to-look-around case below on a phone
that won't rotate.

The lens correction is the part that has to be right. Those lenses magnify,
and magnifying lenses pincushion — straight lines bow inward, worse toward
the edges — so both eyes are rendered into one texture and drawn back
through a barrel-distortion shader that cancels it. That is also why the
scene is rendered at a much wider field of view than you end up seeing: the
distortion samples outward, so a good third of what is drawn ends up outside
the lens disc, and rendering at the FOV you want to see gives you a tunnel.

No headset and no viewer? Open it anyway — drag to look around and click to
play. The table works exactly the same, which is also what lets
`npm run smoke:vr` play a whole round through it in a headless browser.

The room is drawn rather than downloaded: the terracotta, the plaster, the
evening sky through the arches and every readable word in the scene are
painted into canvases at runtime, so the whole villa costs a few kilobytes
of code on top of three.js rather than a few megabytes of assets. That is
what keeps it loadable off the same free-tier server as everything else.

### Playing in person, on one phone

No wifi needed, nothing to host — from the front page, **Play pass-and-play
on one phone →** opens `local.html`, which runs the same rules engine
(`public/shared/game/Game.js`) directly in the browser and has everyone
pass one device around the table instead of connecting over a network.

Roles and votes are still private — the app puts up a "pass the phone to
_Name_" screen before showing anything sensitive, so whoever is holding it
gets a beat to look away from the table first, the same way you'd cup a
hand of cards. That said, this is a *procedural* privacy, not the online
version's technical one: everything here lives in one page's memory rather
than never leaving a server, so it depends on people actually not peeking —
exactly the trust a physical card game already runs on. Hints, by contrast,
are said out loud and just typed in afterwards, so there's a log to scroll
back through later.

## Hosting it for real

GitHub Pages and Firebase Hosting are both static-file-only — neither can run
the process in `server/index.js` that holds every table's state and speaks
WebSockets to every phone, so a real deploy needs somewhere that runs Node
directly.

### Render (recommended)

No Docker, no cloud CLI, no billing account to attach. `render.yaml` in this
repo already describes the whole service, so the dashboard configures itself:

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect this GitHub repo (first time asks you to authorise Render against
   your GitHub account).
3. Render reads `render.yaml`, shows you what it's about to create, you
   confirm. First deploy takes a couple of minutes; after that, every push to
   this branch redeploys automatically.

That's the whole setup — no further steps, nothing to run locally.

Two things worth knowing about the free plan specifically:

- **It spins down after 15 minutes with no inbound traffic**, HTTP or
  WebSocket alike, and takes about a minute to wake back up on the next
  request. In practice a live game essentially never sees this — every hint
  and vote is traffic, and the server pings every open connection every 20
  seconds regardless — but a table with nobody actively playing for a quarter
  of an hour will lose its state when it wakes back up. Same "everything is in
  memory" trade-off called out below, not a new one.
- **The free plan runs exactly one instance, with no autoscaling available
  unless you deliberately turn it on under a paid plan.** Worth knowing
  because that single-instance guarantee is what keeps the in-memory game
  state consistent — see the Cloud Run note below for what goes wrong without
  it, in case you ever do turn scaling on.

### Firebase + Cloud Run (more setup, if you'd rather use that)

Firebase Hosting serves as a thin proxy in front of a container running the
same server, built from the `Dockerfile` already in this repo. Needs a Google
Cloud billing account attached (Cloud Run requires one even to stay within
its free tier) and both CLIs logged into your own account first.

**`--max-instances=1` is not optional.** Game state lives in one process's
memory, in one `Map`, with nothing shared between instances. Two instances
means two Maps — a friend creates a table on instance A, tries to join on
instance B, and B has never heard of that room code. That doesn't look like a
crash, it looks like a wrong error message that comes and goes, which is a
much worse thing to debug at 11pm with four people waiting to play.

```sh
npm install -g firebase-tools

gcloud run deploy mrwhite \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances=1 \
  --port=8080

cp .firebaserc.example .firebaserc   # then edit in your real Firebase project ID
firebase deploy --only hosting
```

## What is actually hard about building this

**The word must never reach Mr. White's device.** Not hidden in the
interface — never sent. It would be very easy to broadcast one copy of the
game state and let each client display the parts it should; that version
looks identical and is completely broken, because anyone who opens the
developer console wins every round for the rest of their life.

So the redaction lives in the rules, in `Game.viewFor`, and each player is
sent a state built for them alone. There is no message in the protocol that
carries the whole game.

That principle has a sharp edge, and it is the one thing here most likely to
be got wrong by someone reasonable. The rule "you cannot say the secret word"
looks like it should apply to everyone. Apply it to Mr. White and the
rejection *is the leak*: reply "you cannot use that word" and you have just
confirmed they guessed right. So Mr. White's hints are never checked against
the word at all — and if they land on it exactly, it stands, which is a
spectacular way to blend in with people who are all describing that very
thing.

`npm run smoke` proves the property where it actually matters, by recording
every WebSocket frame each browser receives and checking the word never
appears in Mr. White's. Checking the page would only show the interface does
not display it, which is a much weaker claim.

## Development

```sh
npm test         # the rules: 58 tests, whole games played deterministically
npm run smoke    # four real browsers playing a real game
npm run smoke:vr # a headset and three phones at one table, VR driven by pointer
npm run verify   # all three
npm run dev      # restarts on save
```

`npm run smoke:vr --shots` leaves screenshots of the villa in `tools/shots/`.

```
server/
  index.js      HTTP, WebSockets, and the protocol in one comment block
  Rooms.js      tables, seats, reconnection tokens, seating AI players
  static.js     serving public/
  game/
    bot.js      the AI opponent: Claude for a move, or a safe fallback
public/
  shared/game/
    Game.js     every rule, and no I/O at all — imported by server and browser alike
    words.js    the word list, and why a word earns its place
    text.js     what counts as one word, and what counts as the right guess
  index.html, app.js       the online client: one page, no framework, no build step
  local.html, local.js     pass-and-play: the same Game.js, run in one browser tab
  vr.html, vr/             the villa: same protocol as app.js, WebXR and a mid-air keyboard
    paint.js    the palette, and every texture and label, painted into canvases
    villa.js    the room, the round table and the chairs, all from primitives
    seats.js    who is sitting where, and what floats over their head
    keyboard.js the mid-air keyboard: one quad, hit-tested by UV
    cardboard.js phone-in-a-viewer: stereo, lens correction, gyro, gaze
    net.js      the same WebSocket protocol the phones speak
    main.js     scene, WebXR, pointing at things, and the game wiring
  vendor/         three.js, vendored so there is still no build step
tools/          tests
render.yaml, Dockerfile, firebase.json, firebase-public/   see Hosting it for real, above
```

`Game.js` is a pure state machine — call a method, get `{ok}` or
`{ok:false, error}` back, nothing reaches for a socket or a clock. That is
what lets the tests play whole games including the ones nearly impossible to
reproduce by hand: a three-way tie, everyone disconnecting mid-vote, Mr. White
naming the word on the last breath — and what let `local.js` reuse it wholesale
instead of re-implementing the rules a second time for one browser tab.

## Known limits

- **Everything is in memory.** Restart the server and the tables are gone.
  Fine for an evening; add a store if you want tables to outlive a deploy.
- **Nothing stops a player opening a second tab under another name.** Anyone
  who would do that is already ruining the game by talking about it out loud.
- **Hints are typed, not spoken.** That is a deliberate trade: it works for
  players in different houses, and it leaves a transcript everyone can scroll
  back through, which turns out to matter more than it sounds — most of the
  deduction happens by re-reading what was said two passes ago.
- **A disconnected player is skipped, not waited for.** A phone that locks
  itself must never be able to hang the table, so their turn passes and their
  vote is not required. They keep their seat and can come back — including
  the host, who keeps the job across a dropped connection. The table can deal
  without them while they are away, which covers the case that matters
  (nobody able to start) without demoting the person who gathered everyone
  for locking their phone during the reveal.
- **No spectators.** Joining mid-round means sitting out until the next one,
  which is also the only sane answer — being dealt in halfway through is not a
  thing that can happen at a real table either.
- **Without an API key, AI players reason about vocabulary, not language.**
  The category fallback (see "Playing against an AI," above) keeps hints
  on-theme far more often than a purely random bot would, but it is still
  literal word matching, not comprehension. Voting only treats a hint as
  suspicious when it is a recognized word from a *different* category — a
  genuine mismatch — never merely because it isn't in the word list's own
  vocabulary, which describes almost every hint a person actually types.
  Getting that distinction backwards once meant AI civilians voted against
  human players by default and against other bots almost never; a caught
  Mr. White's guess is likewise always drawn from the full word list, not
  narrowed to a category, so it doesn't win by lucky guess more than a
  caught player reasonably should. It's a real step up from generic filler,
  not a substitute for `ANTHROPIC_API_KEY`.
- **A phone viewer has no idea where your head is, only which way it points.**
  The gyroscope gives rotation and nothing else, so you can look around from
  your seat but never lean in to read something. The distortion coefficients
  are a reasonable middle setting too, not a profile for your particular
  viewer — the cheap ones vary quite a bit, and there is no QR code scanner
  here to tell them apart.
- **Nobody's head or hands are tracked between players.** In VR you see
  everyone as a seated figure that does not move — the protocol carries no
  pose data, and adding it would mean every phone at the table sending
  position updates it has no way to produce. You get who is speaking, what
  they said and who has voted, which is all the game actually turns on.
- **Pass-and-play keeps no server, so it keeps no history.** Reloading the
  page mid-round loses that round — there's nothing to reconnect to, unlike
  the online version's reconnect tokens. Everyone's names and scores between
  rounds are remembered in that browser, though, so closing the tab and
  reopening it picks the same table back up.

## Licence

MIT.
