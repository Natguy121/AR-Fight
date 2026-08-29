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
npm test      # the rules: 45 tests, whole games played deterministically
npm run smoke # four real browsers playing a real game
npm run verify# both
npm run dev   # restarts on save
```

```
server/
  index.js      HTTP, WebSockets, and the protocol in one comment block
  Rooms.js      tables, seats, reconnection tokens
  static.js     serving public/
  game/
    Game.js     every rule, and no I/O at all
    words.js    the word list, and why a word earns its place
    text.js     what counts as one word, and what counts as the right guess
public/         the client: one page, no framework, no build step
tools/          tests
```

`Game.js` is a pure state machine — call a method, get `{ok}` or
`{ok:false, error}` back, nothing reaches for a socket or a clock. That is
what lets the tests play whole games including the ones nearly impossible to
reproduce by hand: a three-way tie, everyone disconnecting mid-vote, Mr. White
naming the word on the last breath.

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

## Licence

MIT.
