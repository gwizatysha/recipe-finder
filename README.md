# Recipe Finder

Recipe Finder lets you search recipes by name, filter them by category, and sort the results. It is an Express server that calls TheMealDB API and serves a plain HTML/CSS/JavaScript frontend. The API key stays on the server and is never sent to the browser.

**Live (load balancer):** http://18.170.230.246

## Features

- Search recipes by name
- Filter by category and sort results
- Server-side caching of API responses (`CACHE_TTL_SECONDS`)
- Rate limiting (`express-rate-limit`) and security headers (`helmet`)
- Error handling for API downtime or invalid responses

## API used

- [TheMealDB](https://www.themealdb.com/api.php). Thank you to the TheMealDB developers for the free API.
- The free test key `1` is used.

## Run locally

```bash
git clone https://github.com/gwizatysha/recipe-finder.git
cd recipe-finder
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. Requires Node 18 or newer.

`.env`:

```
PORT=3000
MEALDB_API_KEY=1
CACHE_TTL_SECONDS=300
```

`.env` is listed in `.gitignore` and is not committed.

## Deployment

Servers:

| Role          | Name        | IP             |
| ------------- | ----------- | -------------- |
| App server 1  | 7316-web-01 | 18.175.224.100 |
| App server 2  | 7316-web-02 | 18.170.86.130  |
| Load balancer | 7316-lb-01  | 18.170.230.246 |

### Web servers (done on both web-01 and web-02)

1. Install the tools: `sudo apt-get update -y && sudo apt-get install -y git nginx`
2. Install Node 20: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -` then `sudo apt-get install -y nodejs`
3. Clone the repo and install dependencies: `git clone https://github.com/gwizatysha/recipe-finder.git && cd recipe-finder && npm install --omit=dev`
4. Create `.env` on the server with the values above.
5. Create a systemd service, `/etc/systemd/system/recipe-finder.service`, that runs `/usr/bin/node server.js` as user `ubuntu` with `Restart=always`. Then run `sudo systemctl daemon-reload && sudo systemctl enable --now recipe-finder` so the app starts on boot and restarts if it crashes.
6. Put nginx in front of the app as a reverse proxy by replacing `/etc/nginx/sites-available/default` with:

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    add_header X-Served-By $hostname always;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

7. Apply it: `sudo nginx -t && sudo service nginx restart`

The `X-Served-By` header contains the server's hostname, which makes it possible to see which server answered a request.

### Load balancer (lb-01)

1. `sudo apt-get update -y && sudo apt-get install -y haproxy`
2. Append this to `/etc/haproxy/haproxy.cfg`:

```
frontend http_front
    bind *:80
    mode http
    default_backend http_back

backend http_back
    mode http
    balance roundrobin
    server 7316-web-01 18.175.224.100:80 check
    server 7316-web-02 18.170.86.130:80 check
```

3. Validate and restart: `sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo service haproxy restart`

HAProxy uses round-robin balancing, so requests alternate between the two servers. The `check` option health-checks each server and stops sending traffic to one that is down.

## Testing the load balancer

```bash
for i in 1 2 3 4; do curl -sI http://18.170.230.246 | grep -i x-served-by; done
```

The output alternates between `X-Served-By: 7316-web-01` and `X-Served-By: 7316-web-02`, which shows that traffic is split across both servers. The app also works in the browser
