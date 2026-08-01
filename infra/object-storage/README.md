# Disposable object-storage integration

This stack is test-only. It uses the current SeaweedFS 4.29 multi-platform image,
pinned by OCI index digest, a loopback-only S3 port, explicit non-production
credentials, one pre-created bucket, and ephemeral storage.

```sh
docker compose -f infra/object-storage/compose.integration.yaml up -d
RUN_OBJECT_STORAGE_INTEGRATION=1 pnpm --filter @discord-meeting/object-storage-adapter run test:integration
docker compose -f infra/object-storage/compose.integration.yaml down --volumes
```

Never reuse these credentials or this manifest for production. Production
credentials must enter composition through the hosting secret store.
