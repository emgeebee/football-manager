# Football Manager

Matchday sheet for kids’ football: rotations, teamsheets, season stats.

- **Hosted on** [GitHub Pages](https://emgeebee.github.io/football-manager/)
- **Sign in** with Google (same API as Track My Holidays / Famtree)
- **Data** stored as a document at `PUT/GET /docs/football-manager-season` on the [trackmyholidays-api](https://github.com/emgeebee/trackmyholidays-api)

## Local

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Google OAuth

Uses the Famtree Google client id (already accepted by the API authorizer). In Google Cloud Console, add these **Authorized JavaScript origins**:

- `http://localhost:3000`
- `https://emgeebee.github.io`

## API CORS

`https://emgeebee.github.io` must be listed in the API’s `config/allowedOrigins.json` and deployed.

## Deploy

Pushes to `main` publish the `public/` folder to GitHub Pages via Actions. Enable **Pages → GitHub Actions** in the repo settings if needed.
