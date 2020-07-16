import { AnyRecord } from '../../types';
import { SNItem } from '../../models/core/item';
import { BaseHistory, HistoryContent } from './base_history';
/**
 * HistorySession is the only object in the session history domain that is
 * persistable. A history session contains one main content object: the
 * itemUUIDToItemHistoryMapping. This is a dictionary whose keys are item uuids,
 * and each value is an ItemHistory object.
 *
 * Each ItemHistory object contains an array called `entries` which contain
 * `ItemHistory` (or subclasses thereof) entries.
 */
export declare class HistorySession extends BaseHistory {
    private itemRevisionThreshold;
    constructor(content?: HistoryContent);
    static FromJson(HistoryJson?: AnyRecord): HistorySession;
    clearItemHistory(item: SNItem): void;
    clearAllHistory(): void;
    setItemRevisionThreshold(threshold: number): void;
    optimizeHistoryForItem(uuid: string): void;
}
