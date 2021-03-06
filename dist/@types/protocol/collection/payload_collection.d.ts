import { PayloadSource } from '../payloads/sources';
import { PurePayload } from '../payloads/pure_payload';
import { MutableCollection } from './collection';
/**
 * A collection of payloads coming from a single source.
 */
export declare class ImmutablePayloadCollection extends MutableCollection<PurePayload> {
    source?: PayloadSource;
    /** We don't use a constructor for this because we don't want the constructor to have
     * side-effects, such as calling collection.set(). */
    static WithPayloads(payloads?: PurePayload[], source?: PayloadSource): ImmutablePayloadCollection;
    static FromCollection(collection: MutableCollection<PurePayload>): ImmutablePayloadCollection;
    get payloads(): PurePayload[];
}
