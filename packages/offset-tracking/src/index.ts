export type OffsetType = number | string;
export type OffsetIdType = number | string;

export interface OffsetRepository<Offset extends OffsetType = number, Id extends OffsetIdType = string> {
    retrieve(identifier: Id): Promise<Offset | undefined>;
    store(identifier: Id, offset: Offset): Promise<void>;
}
