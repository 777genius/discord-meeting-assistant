# Disposable BullMQ Redis

This isolated Compose project is for local and test-only BullMQ state. It binds
to loopback by default, disables Redis persistence, and stores all data in a
container-scoped tmpfs. `docker compose down` removes the disposable queue data.

The official multi-platform image is pinned immutably to Redis `8.8.1-alpine`:

- `redis:8.8.1-alpine`
- `sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb`

Start and verify it from this directory:

```bash
docker compose --env-file .env.example up --detach --wait
docker compose exec redis redis-cli ping
docker compose down
```

Do not expose this disposable unauthenticated instance on a non-loopback
address. Use a separately secured and durable Redis deployment outside local
development.
