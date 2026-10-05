import type {Branded} from '@deltic/branded';

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

export class PrefixedBrandedIdConversion<
    Prefix extends string,
    DatabaseType extends string | number,
> implements IdConversion<PrefixedId<Prefix>, DatabaseType> {
    private readonly prefixLength: number;
    constructor(
        private readonly prefix: Prefix,
        private readonly conversion: IdConversion<string, DatabaseType>,
    ) {
        this.prefixLength = prefix.length + 1;
        // Bound per instance, so the methods can be handed around as plain functions
        this.fromDatabase = this.fromDatabase.bind(this);
        this.toDatabase = this.toDatabase.bind(this);
    }

    fromDatabase(to: DatabaseType): PrefixedId<Prefix> {
        return `${this.prefix}_${this.conversion.fromDatabase(to)}` as PrefixedId<Prefix>;
    }

    toDatabase(from: PrefixedId<Prefix>): DatabaseType {
        return this.conversion.toDatabase(from.substring(this.prefixLength));
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
