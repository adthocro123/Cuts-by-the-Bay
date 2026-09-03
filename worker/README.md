# Queue API

Holds the walk-in line and works out the wait time. The public site reads
`GET /api/status`; everything else needs the shop password.

## Deploy

```sh
cd worker
npx wrangler login          # opens the browser once
npx wrangler secret put STAFF_PASSWORD    # type the shop password, press enter
npx wrangler deploy
```

`deploy` prints the live URL. Paste it into `assets/config.js` (replacing
`YOUR-SUBDOMAIN`), then commit and push so the site starts using it.

## Changing the password later

```sh
npx wrangler secret put STAFF_PASSWORD
```

Everyone signed in gets logged out on their next action.

## Running it locally

`worker/.dev.vars` holds a throwaway password for local testing and is
never committed:

```sh
echo 'STAFF_PASSWORD=some-test-password' > .dev.vars
npx wrangler dev --port 8787
```

Serve the site alongside it (`python3 -m http.server 8734` from the project
root) and open http://localhost:8734/checkin.html — `config.js` points at
the local worker automatically.
