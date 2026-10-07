declare const brand: unique symbol;

/**
 * A branded type is a type that is naturally inexpressible.
 * While this may sound weird, this is intended behaviour, which
 * enforces the value to be checked explicitly and cast to the
 * branded type. This acts as a guard, allowing you to hint on
 * the type, trusting the value has been properly vetted.
 */
export type Branded<T, TBrand extends string> = T & {
    [brand]: 'prevents forging without casting';
} & (string extends TBrand ? unknown : {[I in TBrand as `__brand_${I}`]: true});
