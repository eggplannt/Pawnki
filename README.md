# Pawnki

> **Alpha.** Core features work end-to-end. Data model and APIs may still shift — back up your PGNs.

A chess trainer with Anki-style spaced repetition. Primarily an opening trainer — build opening trees from PGN files or by playing moves on the board, drill them with depth-first practice, and reinforce weak positions with a daily SM-2 review session — plus a growing set of tools for the rest of your chess training.

**[pawnki.com](https://pawnki.com)** · [GitHub](https://github.com/eggplannt/Pawnki) · [Android APK](https://github.com/eggplannt/Pawnki/releases)

Licensed under the **Business Source License 1.1**.

---

## How it works

### 1. Create an opening

In the **Library**, hit **New Opening**. Give it a name, pick your color (White or Black), and either:

- **Paste or load a PGN** — import one game or many at once; shared moves are auto-merged into a single tree. (Don't have a PGN? Search YouTube for "[opening name] repertoire" — most videos link a PGN in the description.)
- **Leave PGN blank** — start with an empty tree and build it move-by-move on the board.

### 2. Build and browse the tree

Opening the entry takes you to the **tree builder**. The board is in the center; the move tree is on the right.

- **Play moves** on the board to add new lines.
- **Click any node** in the tree to jump to that position.
- **Annotate** positions with notes.
- **Import more PGN** later if you want to extend the tree.
- **Export PGN** at any time to back up or share.

Pawnki automatically detects **transpositions** — positions reachable from multiple move orders — and links them so you aren't tested twice on the same position.

### 3. Learn

From the opening detail page, tap **Learn** to run a guided session through positions you haven't studied yet. Pawnki walks you forward through the tree:

- Opponent moves play automatically.
- At each position where *you* move, you must find the correct reply.
- **Hint** shows the legal target squares. **End early** wraps up the session and marks everything you reached as learned.

Work through Learn sessions until all positions in the opening are covered.

### 4. Review

The **Review** tab runs your daily spaced-repetition session across all openings at once. Positions you've learned come back on a schedule based on how well you recalled them.

For each position, find the right move on the board. After you answer, grade yourself:

| Grade | Meaning |
|---|---|
| **Again** | Missed it — back to short interval |
| **Hard** | Recalled with effort |
| **Good** | Got it |
| **Easy** | Effortless — longer interval |

Finish your daily queue to keep your streak alive. Positions you consistently nail are spaced further and further apart.

---

## Features

- Google sign-in via Supabase Auth
- Opening library: create, import PGN (single or multi-game with auto-merge), delete
- Tree builder: play moves on the board, edit annotations, navigate variations
- Transposition detection: same-opening and cross-opening links
- Practice mode: depth-first drill with hints and end-early flow
- Daily review: SM-2 spaced repetition with Again / Hard / Good / Easy grading
- Streak tracking
- Light / dark / system themes; 3 board palettes (Wood / Slate / Green); review-order preference
- PGN export (copy or download)

---

## Tech Stack

| Layer | Choice |
|---|---|
| Web frontend | Vite + React 19 + TypeScript, Tailwind CSS, React Router v7 |
| Mobile frontend | Expo SDK 54 + Expo Router, NativeWind |
| Shared code | `packages/shared` workspace — SM-2, PGN parser, tree ops, theme palettes |
| Backend | Supabase (Postgres + Auth + RLS) — no separate server |
| Chess logic | chess.js v1, react-chessboard (web), react-native-chessboard (Expo) |
| Package manager | Bun |

---

## Android APK

Releases ship as **experimental APKs on the [GitHub Releases page](https://github.com/eggplannt/Pawnki/releases)**. No Play Store listing yet. Re-install manually to update.

---

## Run Locally

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- Docker (used by the Supabase CLI)
- A Google OAuth Client ID (only needed if you want sign-in to work)

### 1. Clone and install

```bash
git clone https://github.com/eggplannt/Pawnki.git
cd Pawnki
bun install
```

### 2. Start Supabase

```bash
supabase start
supabase migration up
```

Boots local Postgres + Auth on `127.0.0.1:54321` and applies all migrations.

### 3. Configure environment

```bash
cp apps/web/.env.example   apps/web/.env.local
cp apps/expo/.env.example  apps/expo/.env.local
```

Fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (web) and the `EXPO_PUBLIC_` equivalents (Expo) with the values printed by `supabase status`.

### 4. Google OAuth (optional)

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add `http://127.0.0.1:54321/auth/v1/callback` as an authorized redirect URI
4. Copy and fill in `supabase/.env`:
   ```bash
   cp supabase/.env.example supabase/.env
   ```
   Then `supabase stop && supabase start` to pick up the new values.

### 5. Run

```bash
# Web — http://localhost:3000
cd apps/web && bun run dev

# Expo (Android emulator or device)
cd apps/expo && bun run android
```

---

## Project Structure

```
/
├── apps/
│   ├── web/                  # Vite React web app — primary target
│   │   ├── src/pages/        # Library, OpeningDetail, Practice, Review, Settings
│   │   ├── src/components/   # AppShell, Logo, …
│   │   ├── src/hooks/        # useAuth, useColorTheme, useReviewOrder
│   │   └── src/lib/          # Supabase client
│   └── expo/                 # Expo Android app — experimental
│       ├── app/              # Expo Router routes
│       ├── components/       # Native UI
│       └── hooks/            # mirrors apps/web/src/hooks
├── packages/
│   └── shared/               # Workspace package consumed by both apps
│       └── src/lib/          # SM-2, PGN parser, openings, reviews, streaks
├── supabase/
│   ├── migrations/           # Applied with `supabase migration up`
│   └── config.toml
└── package.json              # Bun workspaces root
```

---

## Contributing

PRs welcome. The project is moving fast in alpha and the data model can shift. Open an issue first for non-trivial changes so we don't duplicate work.
