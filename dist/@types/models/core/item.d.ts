import { PayloadContent } from './../../protocol/payloads/generator';
import { PayloadOverride } from '../../protocol/payloads/generator';
import { PurePayload } from './../../protocol/payloads/pure_payload';
import { SNPredicate } from './predicate';
import { ConflictStrategies } from '../../protocol/payloads/index';
export declare enum MutationType {
    /**
     * The item was changed as part of a user interaction. This means that the item's
     * user modified date will be updated
     */
    UserInteraction = 1,
    /**
     * The item was changed as part of an internal operation, such as a migration.
     * This change will not updated the item's user modified date
     */
    Internal = 2,
    /**
     * The item was changed as part of an internal function that wishes to modify
     * internal item properties, such as lastSyncBegan, without modifying the item's dirty
     * state. By default all other mutation types will result in a dirtied result.
     */
    NonDirtying = 3
}
export declare enum AppDataField {
    Pinned = "pinned",
    Archived = "archived",
    Locked = "locked",
    UserModifiedDate = "client_updated_at",
    DefaultEditor = "defaultEditor",
    MobileRules = "mobileRules",
    NotAvailableOnMobile = "notAvailableOnMobile",
    MobileActive = "mobileActive",
    LastSize = "lastSize",
    PrefersPlainEditor = "prefersPlainEditor"
}
export declare enum SingletonStrategies {
    KeepEarliest = 1
}
/**
 * The most abstract item that any syncable item needs to extend from.
 */
export declare class SNItem {
    readonly payload: PurePayload;
    private static sharedDateFormatter;
    constructor(payload: PurePayload);
    static DefaultAppDomain(): string;
    get uuid(): string;
    get content(): string | PayloadContent | undefined;
    get safeContent(): PayloadContent;
    get references(): import("../../protocol/payloads/generator").ContentReference[];
    get deleted(): boolean | undefined;
    get content_type(): import("..").ContentType;
    get created_at(): Date;
    get updated_at(): Date;
    get userModifiedDate(): Date;
    get dirtiedDate(): Date | undefined;
    get dirty(): boolean | undefined;
    get dummy(): boolean | undefined;
    get errorDecrypting(): boolean | undefined;
    get waitingForKey(): boolean | undefined;
    get errorDecryptingValueChanged(): boolean | undefined;
    get lastSyncBegan(): Date | undefined;
    get lastSyncEnd(): Date | undefined;
    /** @deprecated */
    get auth_hash(): string | undefined;
    /** @deprecated */
    get auth_params(): any;
    payloadRepresentation(override?: PayloadOverride): PurePayload;
    hasRelationshipWithItem(item: SNItem): boolean;
    /**
     * Inside of content is a record called `appData` (which should have been called `domainData`).
     * It was named `appData` as a way to indicate that it can house data for multiple apps.
     * Each key of appData is a domain string, which was originally designed
     * to allow for multiple 3rd party apps who share access to the same data to store data
     * in an isolated location. This design premise is antiquited and no longer pursued,
     * however we continue to use it as not to uncesesarily create a large data migration
     * that would require users to sync all their data.
     *
     * domainData[DomainKey] will give you another Record<string, any>.
     *
     * Currently appData['org.standardnotes.sn'] returns an object of type AppData.
     * And appData['org.standardnotes.sn.components] returns an object of type ComponentData
     */
    getDomainData(domain: string): any;
    getAppDomainValue(key: AppDataField): any;
    get protected(): any;
    get trashed(): any;
    get pinned(): any;
    get archived(): any;
    get locked(): any;
    /**
     * During sync conflicts, when determing whether to create a duplicate for an item,
     * we can omit keys that have no meaningful weight and can be ignored. For example,
     * if one component has active = true and another component has active = false,
     * it would be needless to duplicate them, so instead we ignore that value.
     */
    contentKeysToIgnoreWhenCheckingEquality(): string[];
    /** Same as `contentKeysToIgnoreWhenCheckingEquality`, but keys inside appData[Item.AppDomain] */
    appDataContentKeysToIgnoreWhenCheckingEquality(): AppDataField[];
    getContentCopy(): any;
    /** Whether the item has never been synced to a server */
    get neverSynced(): boolean;
    /**
     * Subclasses can override this getter to return true if they want only
     * one of this item to exist, depending on custom criteria.
     */
    get isSingleton(): boolean;
    /** The predicate by which singleton items should be unique */
    get singletonPredicate(): SNPredicate;
    get singletonStrategy(): SingletonStrategies;
    /**
     * Subclasses can override this method and provide their own opinion on whether
     * they want to be duplicated. For example, if this.content.x = 12 and
     * item.content.x = 13, this function can be overriden to always return
     * ConflictStrategies.KeepLeft to say 'don't create a duplicate at all, the
     * change is not important.'
     *
     * In the default implementation, we create a duplicate if content differs.
     * However, if they only differ by references, we KEEP_LEFT_MERGE_REFS.
     */
    strategyWhenConflictingWithItem(item: SNItem): ConflictStrategies.KeepLeft | ConflictStrategies.KeepRight | ConflictStrategies.KeepLeftDuplicateRight | ConflictStrategies.KeepLeftMergeRefs;
    isItemContentEqualWith(otherItem: SNItem): boolean;
    satisfiesPredicate(predicate: SNPredicate): any;
    createdAtString(): string | undefined;
    updatedAtString(): string;
    updatedAtTimestamp(): number;
    private dateToLocalizedString;
}
/**
 * An item mutator takes in an item, and an operation, and returns the resulting payload.
 * Subclasses of mutators can modify the content field directly, but cannot modify the payload directly.
 * All changes to the payload must occur by copying the payload and reassigning its value.
 */
export declare class ItemMutator {
    protected readonly item: SNItem;
    protected readonly type: MutationType;
    protected payload: PurePayload;
    protected content?: PayloadContent;
    constructor(item: SNItem, type: MutationType);
    getUuid(): string;
    getItem(): SNItem;
    getResult(): PurePayload;
    /** Merges the input payload with the base payload */
    mergePayload(payload: PurePayload): void;
    setDeleted(): void;
    set lastSyncBegan(began: Date);
    set errorDecrypting(errorDecrypting: boolean);
    set updated_at(updated_at: Date);
    set userModifiedDate(date: Date);
    set protected(isProtected: boolean);
    set trashed(trashed: boolean);
    set pinned(pinned: boolean);
    set archived(archived: boolean);
    set locked(locked: boolean);
    /**
     * Overwrites the entirety of this domain's data with the data arg.
     */
    setDomainData(data: any, domain: string): undefined;
    /**
     * First gets the domain data for the input domain.
     * Then sets data[key] = value
     */
    setDomainDataKey(key: string, value: any, domain: string): undefined;
    setAppDataItem(key: string, value: any): void;
    addItemAsRelationship(item: SNItem): void;
    removeItemAsRelationship(item: SNItem): void;
}
