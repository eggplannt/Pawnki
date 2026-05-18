# Pawnki

> **Status: Alpha.** Core features work end-to-end on the web app, but the data model, UI, and APIs are all subject to change. Self-hosting is possible but not yet polished. Don't rely on this for a serious repertoire yet — back up your PGNs.

A chess opening trainer with Anki-style spaced repetition. Build opening trees from PGN files, drill them with depth-first practice, and reinforce weak positions with a daily SM-2 review session.

Licensed under **Apache 2.0**.

---

## Status

| Surface | State |
|---|---|
| Web app (`apps/web`) | **Alpha — primary target.** All phases 1–6 work; Phase 7 (polish + deployment) in progress. |
| Android (`apps/expo`) | **Experimental.** Feature-parity in progress; ships as an APK on the GitHub Releases page, not to Play Store. iOS is not targeted yet. |

### What works

- Google sign-in via Supabase Auth
- Opening library: create, import PGN (single or multi-game with auto-merge), delete
- Tree builder: make moves on the board, edit annotations, navigate variations
- Transposition detection: same-opening and cross-opening
- Practice mode: depth-first drill with hints and end-early flow
- Daily review: SM-2 spaced repetition with quality grades (Missed / Hard / Good / Easy)
- Streak tracking
- Light / dark / system themes; 3 board palettes (Wood / Slate / Green); review-order preference
- PGN file import + export (paste text, load a `.pgn` file, copy or download/share)

### Coming soon

- **Opening database** — browse master-game frequencies for the position you're studying
- **Computer analysis** — Stockfish (WASM on web, native on Android) for evaluation + best-move hints in the tree builder and review

### Not planned for v1

- Hosting story (web deployment + Supabase project provisioning docs are still TBD)
- Custom piece sets
- Offline mode, Anki export
- iOS build

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

## Run Locally

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Supabase CLI](https://supabase.com/docs/guides/cli) for local dev (`brew install supabase/tap/supabase`)
- Docker (Supabase CLI uses it)
- A Google OAuth Client ID (only if you want to sign in; see below)

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

This boots local Postgres + Auth on `127.0.0.1:54321` and applies all migrations.

### 3. Configure environment

```bash
cp apps/web/.env.example apps/web/.env.local       # if you have one; otherwise create it
```

The web app needs:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_... from `supabase status`>
```

For Expo, the same values go in `apps/expo/.env.local` as `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

### 4. Google OAuth (optional for local-only testing)

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add **Authorized redirect URIs** for Supabase's OAuth proxy:
   - Local: `http://127.0.0.1:54321/auth/v1/callback`
4. Drop the client ID + secret into `supabase/config.toml` under `[auth.external.google]`, then `supabase stop && supabase start` to pick up changes.

### 5. Run the apps

```bash
# Web (http://localhost:3000)
cd apps/web && bun run dev

# Expo (Android — needs an emulator or device)
cd apps/expo && bun run android
```

---

## Project Structure

```
/
├── apps/
│   ├── web/                  # Vite React web app — primary target
│   │   ├── src/pages/        # Library, OpeningDetail, Review, Settings, …
│   │   ├── src/components/   # AppShell, Logo, …
│   │   ├── src/hooks/        # useAuth, useColorTheme, useReviewOrder
│   │   └── src/lib/          # supabase client wiring
│   └── expo/                 # Expo Android app — experimental
│       ├── app/              # Expo Router routes
│       ├── components/       # Native UI
│       └── hooks/            # mirrors apps/web/src/hooks
├── packages/
│   └── shared/               # Workspace package consumed by both apps
│       └── src/lib/          # SM-2, PGN parser, openings, reviews, streaks
├── supabase/
│   ├── migrations/           # Run with `supabase migration up`
│   └── config.toml
└── package.json              # Bun workspaces root
```

---

## Android APK

Releases for Android ship as **experimental APKs on the [GitHub Releases page](https://github.com/eggplannt/Pawnki/releases)**, not to the Play Store. Expect rough edges. No automatic updates — re-install when you want the latest.

---

## Monetization

Apache 2.0 means anyone can self-host or fork freely. A managed cloud-hosted version (where users pay for convenience, not for the code) may be offered separately. The billing and subscription layer is intentionally kept out of this repository.

---

## Roadmap

- [x] Phase 1 — Repo + database schema
- [x] Phase 2 — Auth (Supabase + Google OAuth)
- [x] Phase 3 — Opening CRUD + PGN import + transposition detection
- [x] Phase 4 — Tree builder (board interaction)
- [x] Phase 5 — Practice mode (DFS drill)
- [x] Phase 6 — Daily review (SM-2)
- [ ] Phase 7 — Polish + deployment (in progress)

---

## Contributing

PRs welcome, but the project is moving fast in alpha and the data model can shift between phases. Open an issue first for non-trivial changes so we don't both write the same code.
