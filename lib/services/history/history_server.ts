import { AnyRecord } from '@Lib/types';
import { ItemHistory } from '@Services/history/item_history';
import { History, HistoryContent } from '@Services/history/history';
import { HttpResponse } from '../api/http_service';
import { PayloadContent } from '@Lib/protocol/payloads/generator';

export class HistoryServer extends History {

  constructor(content?: HistoryContent) {
    super(content);
  }

  static FromResponse(response?: HttpResponse) {
    if (response) {
      const content = response.map((entry: PayloadContent) => {
        return {
          [entry.uuid]: entry
        }
      });
      const uuids = Object.keys(content);
      uuids.forEach((itemUUID) => {
        const rawItemHistory = content.itemUUIDToItemHistoryMapping[itemUUID];
        content.itemUUIDToItemHistoryMapping[itemUUID] =
          ItemHistory.FromJson(rawItemHistory);
      });
      return new HistoryServer(content);
    } else {
      return new HistoryServer();
    }
  }
}
