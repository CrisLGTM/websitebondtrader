# websitebondtrader

Minimal interactive BondTrader landing page.

## Run locally

```powershell
npm start
```

Open `http://localhost:3000`.

The form posts to `POST /api/leads` and saves leads in `data/leads.json`. That file is ignored by Git so local submissions are not committed.

The live rates panel calls `GET /api/treasury-rates`, which fetches public U.S. Treasury Fiscal Data and caches it briefly on the server.
