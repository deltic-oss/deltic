---
"@deltic/key-value": patch
---

Look records up by the key's value in `KeyValueStoreWithColumnsUsingPg`. For an identity column declared as an object without a `toDatabaseValue`, such as `{payloadKey: 'userId', columnName: 'user_id'}`, `retrieve` and `remove` searched for the property's name instead of its value, so they never found the record `persist` wrote; they now derive the column value exactly as `persist` does.
