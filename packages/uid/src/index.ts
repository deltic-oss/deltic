import type {Branded} from '@deltic/branded';
import {StandardError} from '@deltic/error-standard';

export type PrefixedId<Prefix extends string> = Branded<`${Prefix}_${string}`, Prefix>;

export interface IdFactory<Type extends string | number> {
    (): Type;
}

export interface IdValidator<Type extends string | number> {
    (id: Type): boolean;
}

export interface IdValidator<Type extends string | number> {
    (id: unknown): id is Type;
}

export interface IdGenerator<Type extends string | number> {
    generateId(): Type;
}

export class PrefixedBrandedIdGenerator<Prefix extends string> implements IdGenerator<PrefixedId<Prefix>> {
    constructor(
        private readonly prefix: Prefix,
        private readonly factory: IdFactory<string>,
    ) {}

    generateId(): PrefixedId<Prefix> {
        return `${this.prefix}_${this.factory()}` as PrefixedId<Prefix>;
    }
}

export interface IdConversion<From extends string | number, To extends string | number = string | number> {
    toDatabase(from: From): To;
    fromDatabase(to: To): From;
}

export class NoIdConversion<Type extends string | number> implements IdConversion<Type, Type> {
    fromDatabase(to: Type): Type {
        return to;
    }

    toDatabase(from: Type): Type {
        return from;
    }
}

export class UnexpectedIdPrefix extends StandardError {
    static forExpectedPrefix = (expectedPrefix: string) =>
        new UnexpectedIdPrefix(`Expected an id prefixed with "${expectedPrefix}_".`, 'uid.unexpected_id_prefix', {
            expectedPrefix,
        });
}

export class PrefixedBrandedIdConversion<
    Prefix extends string,
    DatabaseType extends string | number,
> implements IdConversion<PrefixedId<Prefix>, DatabaseType> {
    private readonly fullPrefix: string;
    constructor(
        private readonly prefix: Prefix,
        private readonly conversion: IdConversion<string, DatabaseType>,
    ) {
        this.fullPrefix = `${prefix}_`;
        this.fromDatabase.bind(this);
        this.toDatabase.bind(this);
    }

    fromDatabase(to: DatabaseType): PrefixedId<Prefix> {
        return `${this.prefix}_${this.conversion.fromDatabase(to)}` as PrefixedId<Prefix>;
    }

    toDatabase(from: PrefixedId<Prefix>): DatabaseType {
        // The brand only exists at compile time, so an id cast to the wrong type can arrive here
        if (!from.startsWith(this.fullPrefix)) {
            throw UnexpectedIdPrefix.forExpectedPrefix(this.prefix);
        }

        return this.conversion.toDatabase(from.substring(this.fullPrefix.length));
    }
}

export function prefixedIdValidator<Prefix extends string>(
    prefix: Prefix,
    validator: IdValidator<string>,
): IdValidator<PrefixedId<Prefix>> {
    const fullPrefix = `${prefix}_`;
    const prefixLength = fullPrefix.length;

    return (id: unknown): id is PrefixedId<Prefix> => {
        return typeof id === 'string' && id.startsWith(fullPrefix) && validator(id.substring(prefixLength));
    };
}
