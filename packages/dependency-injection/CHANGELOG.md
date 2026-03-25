# @deltic/dependency-injection

## 0.3.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.

## 0.3.1

### Patch Changes

- 76018d6: Fix package.json export dist references

## 0.3.0

### Minor Changes

- e0b32f8: Introduce type-safe service keys for compile-time dependency resolution safety.

  **Breaking:**

  - `resolve()` and `resolveLazy()` now require a `ServiceKey<Service>` instead of a plain string.
  - `DependencyContainer` is now a default export instead of a named export.
  - `register()` and `registerInstance()` now throw if a key is already registered.

  **Added:**

  - `ServiceKey<Service>` branded type for type-safe service resolution.
  - `register()` and `registerInstance()` now return the `ServiceKey<Service>` for the registered service.
  - `forgeServiceKey<Service>(key)` escape-hatch to create service keys without registering.

## 0.2.1

### Patch Changes

- e769367: Resolve circular dependencies automatically through proxies.

## 0.2.0

### Minor Changes

- Initial release.

## 0.1.4

### Patch Changes

- Fixed cjs export

## 0.1.3

### Patch Changes

- 9442c10: Added CJS exports and re-license as ISC

## 0.1.2

### Patch Changes

- e48e390: Added module-sync export

## 0.1.1

### Patch Changes

- Use relative export paths in published package.

## 0.1.0

### Minor Changes

- 21680a2: Initial release for @deltic/dependency-injection
