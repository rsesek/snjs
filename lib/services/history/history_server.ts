import { AnyRecord } from '@Lib/types';
import { ItemHistory } from '@Services/history/item_history';
import { History, HistoryContent } from '@Services/history/history';
import { HttpResponse } from '../api/http_service';
import { PayloadContent, RawPayload, CreateSourcedPayloadFromObject } from '@Lib/protocol/payloads/generator';
import { PayloadSource, PurePayload } from '@Lib/protocol/payloads';
import { SNProtocolService } from '../protocol_service';

export class HistoryServer extends History {

  constructor(content?: HistoryContent) {
    super(content);
  }

  static async FromResponse(protocolService: SNProtocolService, itemUuid: string, response?: HttpResponse) {
    if (response) {
      delete response.error;
      delete response.status;
      const historyServer = new HistoryServer();
      Object.entries(response).forEach(async ([key, value]) => {
        const payload = CreateSourcedPayloadFromObject(value, PayloadSource.ServerHistory, {
          ...value,
          uuid: itemUuid
        });
        const decryptedPayload = await protocolService.payloadByDecryptingPayload(payload);
        historyServer.addEntryForPayload(decryptedPayload);
      });
      return historyServer;
    } else {
      return new HistoryServer();
    }
  }
}
