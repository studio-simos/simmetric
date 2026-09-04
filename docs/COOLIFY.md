# Simmetric Chat su Coolify (4.3.x) — con plugin Enterprise

Questo runbook accompagna `docker/docker-compose.coolify.yml` + `docker/nginx.coolify.conf`.
Il compose automatizza build, rete interna, volumi, healthcheck, mount del plugin enterprise e i secret obbligatori (`:?`).
Le operazioni **manuali** (fuori dal alcance di un compose) sono raccolte qui passo passo.

---

## Cosa fa il compose da solo (nessuna azione richiesta)

| Automazione | Come |
|---|---|
| Build di 4 immagini (server, frontend, collector, widget) | `build.context: ..` — Coolify clona l'intero repo prima di eseguire compose |
| Montaggio plugin enterprise in `/simmetric-enterprise:ro` | path assoluto `${ENTERPRISE_PLUGIN_PATH:-/opt/simmetric-enterprise}` (il clone Coolify non ha sibling) |
| Risoluzione dipendenze plugin (`passport`, `node-saml`, …) | `NODE_PATH=/app/packages/server/node_modules:/simmetric-enterprise/node_modules` |
| Migrations + seed al boot | `docker/entrypoint-server.sh` (`prisma migrate deploy` + `db seed`) |
| Provisioning `ENCRYPTION_KEY` + `API_KEY_HMAC_SECRET` | entrypoint → file nel volume `server-storage` (NON interpolare mai queste due — trappola documentata in `docker-compose.yml:67-75`) |
| Reverse proxy interno (SPA + `/api` + `/widget` + SSE) | nginx HTTP-only (`nginx.coolify.conf`) — il proxy Coolify termina il TLS davanti |
| Secret obbligatori rifiutati se vuoti | sintassi `:?` — Coolify pre-compila e blocca il deploy se mancano |
| Rete interna + nomi servizio (`postgres`, `redis`, `ollama`, …) | compose senza `container_name` (Coolify li possiede) |

## Cosa resta manuale — passo passo

### A. Preparare il plugin Enterprise (una volta, dalla macchina col repo privato)

1. Refresh dello snapshot `file:` (trappola documentata in `docs/DEPLOYMENT.md` § "The `file:`-snapshot pitfall"):
   ```bash
   cd simmetric-enterprise && pnpm install && pnpm build
   ```
2. Verifica anti-crash-loop prima di copiare:
   ```bash
   node -e "require('./node_modules/@simmetric-chat/shared/dist/schemas/index.js')" && echo OK
   ```
3. Copia l'**intero albero** (dist + node_modules) sul server Coolify:
   ```bash
   rsync -a --delete simmetric-enterprise/ utente@server-coolify:/opt/simmetric-enterprise/
   ```
   > Serve il repo intero, NON solo `dist/`: le dipendenze del plugin non sono nell'immagine server (`docker-compose.yml:41-46`).

### B. Creare la risorsa in Coolify

1. **Projects → (sceogli/crea progetto) → + New Resource**
2. Scegli **Docker Compose** (from Git repository) — repo privato `simmetric-chat` (deploy key o access token)
3. In **Docker Compose Location**: `/docker/docker-compose.coolify.yml`
4. Lascia **Base Directory** `/` (il compose usa `context: ..` internamente — corretto)

### C. Variabili d'ambiente (Environment Variables della risorsa)

Coolify mostra come obbligatorie tutte le `:?`. Genera i secret con `openssl rand -base64 32`:

| Variabile | Valore |
|---|---|
| `JWT_SECRET` | `openssl rand -base64 32` |
| `COLLECTOR_SECRET` | `openssl rand -base64 32` |
| `WIDGET_API_KEY` | `openssl rand -base64 32` (stessa var per server e widget — match garantito) |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32` |
| `APP_URL` | l'origine pubblica, es. `https://chat.example.com` |
| `ALLOWED_ORIGINS` | stessa origine, es. `https://chat.example.com` |
| `LICENSE_KEY` | il JWT RS256 (v. `docs/ENTERPRISE_PLUGIN.md` § License JWT shape) — **vuoto = Community** |
| `ENTERPRISE_PLUGIN_PATH` | **rimossa** — Coolify rifiuta `${...}` nei volumi; il path è hardcoded a `/opt/simmetric-enterprise` nel compose (modifica il file per cambiarlo) |

Consigliate: `LLM_MODEL` (default `gemma4:latest`), `EMBEDDING_MODEL`, `ALLOW_REGISTRATION`, `SEED_BOOTSTRAP_ADMIN`.

### D. Dominio pubblico

1. Nella risorsa → servizio **frontend** → **Domains**
2. Aggiungi il dominio (es. `chat.example.com`), **porta 80**
3. Coolify registra il label Traefik e termina il TLS; nginx interno risponde su :80 e instrada SPA/API/widget

### E. Deploy + verifica

1. **Deploy** — la prima build dura (4 immagini; assicurati ≥4-6 GB RAM liberi sul server)
2. Verifiche:
   ```bash
   curl https://chat.example.com/api/health
   # atteso: {"status":"ok","checks":{"database":true,...}}
   ```
   - Login admin → Admin → License: deve mostrare **Enterprise**
   - Verifica manifest enterprise:
     ```bash
     curl -H "Authorization: Bearer <admin-jwt>" https://chat.example.com/api/enterprise/modules
     # atteso: 200 + manifest moduli (SSO, audit log, branding, backup)
     ```
3. Se i log mostrano `[enterprise] Community build — no enterprise package found`: il mount non risolve — controlla `ENTERPRISE_PLUGIN_PATH` e che l'rsync sia completo (passo A3)
4. Se crash-loop con `Cannot find module './env.schema'`: snapshot `file:` stallo — ripeti il passo A1

### F. Facoltativo

- **Modello Ollama**: il pull NON è automatizzato —
  ```bash
   docker exec <container-ollama-di-coolify> ollama pull gemma4:latest
   ```
- **Ollama Cloud login**: decommenta il mount `docker.sock` nel blocco `server` e allinea `OLLAMA_CONTAINER_NAME` al nome reale (`docker ps | grep ollama`) — accesso root-equivalente, vedi nota hardening in `.env.example`
- **Qdrant**: parte di default ma resta idle con `VECTOR_DB_PROVIDER=lancedb` — ferma il servizio `qdrant` in Coolify per risparmiare risorse

---

## Perché queste scelte (riferimenti incrociati)

- **Plugin mai nell'immagine**: contratto IP/air-gap — `docs/DEPLOYMENT.md` § Enterprise Plugin Deployment
- **Mount repo intero**: le dep del plugin risolvono da `/simmetric-enterprise/node_modules`, `express`/`shared` da quelle del server (`NODE_PATH`) — un mount dist-only rompe il boot
- **nginx HTTP-only**: la conf stock reindirizza 80→443, ma la 443 non è esposta tramite il proxy Coolify → redirect verso una porta morta
- **`ENCRYPTION_KEY`/`API_KEY_HMAC_SECRET` non interpolate**: compose risolverebbe una var assente a stringa vuota, sovrascrivendo il provisioning del volume (bug già incontrato col placeholder API_KEY_HMAC)
- **`ALLOWED_ORIGINS`/`APP_URL` esplicite**: i default Zod coprono solo `localhost` (CORS SEC-01)