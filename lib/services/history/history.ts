import { PurePayload } from '@Payloads/pure_payload';
import { ItemHistory } from '@Services/history/item_history';

export type HistoryContent = {
  itemUUIDToItemHistoryMapping: Record<string, ItemHistory>
}

export abstract class History {

  protected content?: HistoryContent

  constructor(content?: HistoryContent) {
    this.content = content;
    if (!this.content) {
      this.content = {
        itemUUIDToItemHistoryMapping: {}
      };
    }
  }

  addEntryForPayload(payload: PurePayload) {
    const itemHistory = this.historyForItem(payload.uuid!);
    return itemHistory.addHistoryEntryForItem(payload);
  }

  historyForItem(uuid: string) {
    let history = this.content!.itemUUIDToItemHistoryMapping[uuid];
    if (!history) {
      history = new ItemHistory();
      this.content!.itemUUIDToItemHistoryMapping[uuid] = history;
    }
    return history;
  }
}
