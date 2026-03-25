# @deltic/mutex

## 0.1.2

### Patch Changes

- 76018d6: Fix package.json export dist references

## 0.1.1

### Patch Changes

- e0b32f8: Add PostgreSQL advisory lock implementation and CRC32 lock ID converter.

  - `MutexUsingPostgres` for distributed locking via PostgreSQL advisory locks, supporting `fresh` and `primary` connection modes.
  - `Crc32LockIdConverter` for mapping string lock IDs to numeric advisory lock IDs using CRC32 with a configurable `LockRange`.
  - `makePostgresMutex()` factory for convenient construction with automatic in-memory guard for `primary` mode.
  - `ConnectionStorageProvider` abstraction with `StaticConnectionStorageProvider` and `AsyncConnectionStorageProvider` implementations.

## 0.1.0

### Minor Changes

- Initial release.
