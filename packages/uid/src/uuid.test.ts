import {uuidV7PrefixedBrandedIdGenerator} from './uuid.js';
import {validate as isValidUuid, version as uuidVersion} from 'uuid';

describe('uuidV7PrefixedBrandedIdGenerator', () => {
    test('it generates prefixed version 7 uuids', () => {
        const id = uuidV7PrefixedBrandedIdGenerator('person').generateId();
        const uuid = id.substring('person_'.length);

        expect(id.startsWith('person_')).toBe(true);
        expect(isValidUuid(uuid)).toBe(true);
        expect(uuidVersion(uuid)).toBe(7);
    });
});
