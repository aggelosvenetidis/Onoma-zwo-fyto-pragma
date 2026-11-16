# 🎲 Όνομα, Ζώο, Φυτό, Πράγμα — Online

Real-time παιχνίδι 2–5 παικτών για κινητό (PWA), στα ελληνικά. Χωρίς εγγραφή: ψευδώνυμο, avatar και πάμε.

---

## 1. Αρχιτεκτονική με μια ματιά

```
 Κινητό / Browser (PWA)                    Node.js server (ένα service)
┌──────────────────────┐   WebSocket   ┌──────────────────────────────────┐
│ public/app.js        │◄────────────►│ server/index.js  (Express+Socket.io)│
│  - οθόνες & animations│  Socket.io    │ server/rooms.js  (ροή παιχνιδιού)   │
│  - εμφάνιση χρόνου    │              │ server/scoring.js (πόντοι)           │
│  - ΜΟΝΟ εμφάνιση      │              │ server/validation/* (έλεγχος λέξεων) │
└──────────────────────┘              │        └─► Claude API (με cache)     │
                                       └──────────────────────────────────┘
```

**Ο server είναι η μοναδική πηγή αλήθειας**: αυτός διαλέγει γράμμα, μετράει χρόνο (server time),
καταγράφει πότε κλείδωσε κάθε λέξη, ελέγχει λέξεις και βγάζει πόντους. Ο client δεν μπορεί να «κλέψει».

**Γιατί vanilla JS αντί για React/Next.js;** Χωρίς build step, ένα μόνο service που σερβίρει και το
frontend και τα WebSockets → ανεβαίνει στο Render με δύο κλικ, ακόμα και από το κινητό.
Το Vercel δεν κρατάει μόνιμες συνδέσεις WebSocket, οπότε ο server θα ήθελε ούτως ή άλλως ξεχωριστό host.

### Socket events

| Κατεύθυνση | Event | Payload | Τι κάνει |
|---|---|---|---|
| C→S | `room:create` | `{nick, avatar, color, settings}` | Νέο δωμάτιο → ack `{code, playerId, token}` |
| C→S | `room:join` | `{code, nick, avatar, color, token?}` | Είσοδος ή **reconnect** (με token) |
| C→S | `room:leave` | – | Αποχώρηση |
| C→S | `room:settings` | `{rounds, timeSec, ...}` | Αλλαγή ρυθμίσεων (host, στο lobby) |
| C→S | `player:ready` | `{ready}` | Κατάσταση «Έτοιμος» |
| C→S | `game:start` | – | Έναρξη (μόνο host, όλοι έτοιμοι) |
| C→S | `answer:submit` | `{category, word}` | Κλείδωμα λέξης (χρόνος = server time) |
| C→S | `challenge:vote` | `{targetId, category}` | Ψήφος αμφισβήτησης (toggle) |
| C→S | `round:next` | – | Επόμενος γύρος / τελική (host) |
| C→S | `game:restart` | – | «Ξανά παιχνίδι» → lobby (host) |
| C→S | `time:sync` | – | Συγχρονισμός ρολογιού client |
| S→C | `room:state` | δημόσια κατάσταση | Σε κάθε αλλαγή (χωρίς λέξεις άλλων κατά τον γύρο) |
| S→C | `round:progress` | `{playerId, nick, label}` | «Η Μαρία ολοκλήρωσε: Ζώο ✓» |
| S→C | `round:finishCountdown` | `{by, deadline}` | Κάποιος τελείωσε → 10″ για τους άλλους |
| S→C | `you:answers` | `{round, words}` | Μετά από reconnect: οι δικές σου λέξεις |
| S→C | `room:expired` | – | Λήξη δωματίου (2 ώρες αδράνεια) |

### Μοντέλο δεδομένων

```js
Room {
  code: 'AB12', hostId, phase: 'lobby'|'countdown'|'playing'|'validating'|'results'|'final',
  settings: { maxPlayers, rounds, timeSec, categories: ['name','animal',...] },
  players: Map<id, Player>, usedLetters: ['Κ','Μ'], roundIndex, round: Round,
  history: [{ letter, perPlayer }],   // για τη συνολική βαθμολογία
  lastActivity, timers
}
Player { id, token /*μυστικό reconnect*/, nick, avatar, color, ready, connected, socketId }
Round {
  number, letter, countdownEndsAt, startedAt, endsAt, durationMs, finishDeadline,
  answers: { [playerId]: { [category]: { word, submittedAt, validation, flipped, votes:Set } } },
  results: { [playerId]: { total, cats: { [category]: { base, speed, first, points, valid } } } }
}
```

### Ροή φάσεων
`lobby → countdown (3-2-1) → playing → validating → results → … → final → (lobby)`

---

## 2. Δομή φακέλων

```
onoma-zwo/
├── package.json
├── .env.example
├── server/
│   ├── index.js              # Express + Socket.io, rate limiting, routes
│   ├── config.js             # ⚙️ ΒΑΘΜΟΛΟΓΙΑ, ΚΑΤΗΓΟΡΙΕΣ, ΓΡΑΜΜΑΤΑ, χρόνοι
│   ├── rooms.js              # Δωμάτια, γύροι, αμφισβήτηση, reconnect, host
│   ├── scoring.js            # Καθαρή συνάρτηση πόντων
│   ├── validation/
│   │   ├── normalize.js      # Τόνοι, κεφαλαία, σύμβολα
│   │   ├── checks.js         # Αρχικό γράμμα/δίψηφα, τυχαία strings, βρισιές
│   │   ├── dictionary.js     # Λεξικά + κλιτικοί τύποι
│   │   ├── llm.js            # Claude API + cache
│   │   └── validator.js      # Ενώνει τα στάδια
│   └── data/
│       ├── dictionaries/     # name.txt, animal.txt, plant.txt, ... (+ προαιρετικό words.txt)
│       └── profanity.txt
├── public/                   # PWA (σερβίρεται από τον ίδιο server)
│   ├── index.html, style.css, app.js
│   ├── manifest.json, sw.js, icon.svg
└── tests/                    # node --test (λογική + προσομοίωση παιχνιδιού)
```

---

## 3. Βαθμολογία (`server/config.js → SCORING`)

Για κάθε έγκυρη λέξη:
- **Βάση**: 10 αν είναι μοναδική, 5 αν την έγραψε κι άλλος (συγκρίνεται το λήμμα: «λύκοι» = «λύκος»).
- **Ταχύτητα**: `round(10 × χρόνος_που_απέμενε / συνολικός_χρόνος)` — με server time.
- **Πρώτος**: +3 στην πρώτη έγκυρη λέξη της κατηγορίας.
- Άκυρη/κενή: 0.

## 4. Επαλήθευση λέξεων

1. Κανονικοποίηση (`"Άρης" = "αρης"`, λατινικά look-alike → ελληνικά).
2. Αρχικό γράμμα, με εξαιρέσεις διψήφων στο `DIGRAPH_EXCLUSIONS` (π.χ. «ου» ≠ Ο).
3. Μήκος ≥ 2 και φίλτρο τυχαίων (`ααααα`, `κκκκ`, `ασδφ`, χωρίς φωνήεντα).
4. Φίλτρο ακατάλληλων (`data/profanity.txt`, πιάνει και κλιτικούς τύπους).
5. Λεξικό κατηγορίας με κλιτικούς τύπους (πληθυντικός, γενική, κλητική).
6. Αλλιώς **Claude API** με JSON απάντηση, cache ανά `κατηγορία+λέξη` και χωρίς διπλές ταυτόχρονες κλήσεις.
7. Χωρίς API key: η λέξη γίνεται δεκτή με ❔ και κρίνεται με **αμφισβήτηση**.

Ο έλεγχος ξεκινά **τη στιγμή που κλειδώνει η λέξη**, στο παρασκήνιο, οπότε στο τέλος του γύρου τα αποτελέσματα είναι σχεδόν άμεσα.

**Αμφισβήτηση**: πλειοψηφία των *άλλων* παικτών (π.χ. 2 από 3) αντιστρέφει την απόφαση. Με 2 παίκτες αρκεί 1 ψήφος.

> 💡 Τα λεξικά είναι αρχικά (~100–150 λέξεις/κατηγορία). Μεγάλωσέ τα προσθέτοντας γραμμές στα `.txt`.
> Για γενικό ορθογραφικό έλεγχο βάλε μια μεγάλη λίστα ελληνικών λέξεων στο `server/data/dictionaries/words.txt`
> (π.χ. από το ελληνικό λεξικό του Hunspell/LibreOffice).

---

## 5. Εγκατάσταση & εκτέλεση

Χρειάζεσαι Node.js 18+.

```bash
npm install
cp .env.example .env      # βάλε ANTHROPIC_API_KEY αν θες έλεγχο με AI
npm run dev               # http://localhost:3000
npm test                  # τεστ λογικής + προσομοίωση παιχνιδιού
```

Για δοκιμή με κινητό στο ίδιο Wi-Fi: άνοιξε `http://<IP-του-υπολογιστή>:3000`.

## 6. Deployment (GitHub + Render)

1. Ανέβασε τον φάκελο σε ένα GitHub repo (το `.env` εξαιρείται από το `.gitignore`).
2. Render → **New → Web Service** → διάλεξε το repo.
3. Build command: `npm install` · Start command: `npm start` · Instance: Free.
4. **Environment**: πρόσθεσε `ANTHROPIC_API_KEY` (και προαιρετικά `ANTHROPIC_MODEL`).
5. Deploy. Το link είναι π.χ. `https://onoma-zwo.onrender.com/room/AB12`.

> Το free plan του Render «κοιμάται» μετά από 15′ αδράνειας: το πρώτο άνοιγμα αργεί ~30″.
> Τα δωμάτια κρατιούνται στη μνήμη, οπότε χάνονται σε restart/redeploy.
> Το Railway δουλεύει με τον ίδιο τρόπο (ίδιες εντολές).

---

## 7. Πιθανές επεκτάσεις

- **Redis** (state + Socket.io adapter) για πολλούς servers και επιβίωση σε restart.
- Μεγάλο λεξικό Hunspell με πλήρη μορφολογία αντί για απλούς κανόνες καταλήξεων.
- Δημόσια δωμάτια / γρήγορο ταίριασμα με αγνώστους.
- Προσαρμοσμένες κατηγορίες από τον host (π.χ. «Ποδοσφαιριστής», «Φαγητό»).
- Στατιστικά παίκτη και ιστορικό παιχνιδιών (τοπικά ή με προαιρετικό λογαριασμό).
- Επιλογή γλώσσας (αγγλικά) με διαφορετικά λεξικά και αλφάβητο.
- Push notification «σειρά σου» και PNG εικονίδια για καλύτερη εγκατάσταση σε iOS.
