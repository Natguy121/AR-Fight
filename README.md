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
reasoning about the hints given so far. Without one — which is the default
on a fresh Render deploy, since Cloud Run-style billing is exactly the setup
cost this project tries to avoid — the AI still plays a complete, legal
game, it just reaches for a plausible-sounding filler word instead of
actually reasoning about the round. The lobby says which mode you're in.

```sh
ANTHROPIC_API_KEY=sk-ant-... npm start   # smarter AI players, locally
```

On Render, add the key from the dashboard under the service's Environment
tab — `render.yaml` declares the variable but deliberately leaves it unset,
so the value itself never lives in this repo.

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
npm test      # the rules: 48 tests, whole games played deterministically
npm run smoke # four real browsers playing a real game
npm run verify# both
npm run dev   # restarts on save
```

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
- **Without an API key, AI players are unclever on purpose.** They play a
  complete, legal game — a real hint every turn, a real vote, a real guess if
  caught — but without `ANTHROPIC_API_KEY` they reach for a plausible filler
  word rather than reasoning about the round, so a bot at the table without
  one is easy to catch.
- **Pass-and-play keeps no server, so it keeps no history.** Reloading the
  page mid-round loses that round — there's nothing to reconnect to, unlike
  the online version's reconnect tokens. Everyone's names and scores between
  rounds are remembered in that browser, though, so closing the tab and
  reopening it picks the same table back up.

## Licence

MIT.
