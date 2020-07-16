import { PurePayload } from '../../protocol/payloads/pure_payload';
import { ItemHistory } from './item_history';
export declare type HistoryContent = {
    itemUUIDToItemHistoryMapping: Record<string, ItemHistory>;
};
export declare abstract class BaseHistory {
    protected content?: HistoryContent;
    constructor(content?: HistoryContent);
    addEntryForPayload(payload: PurePayload): any;
    historyForItem(uuid: string): ItemHistory;
}
