import { History, HistoryContent } from '@Services/history/history';
import { HttpResponse } from '../api/http_service';
import { CreateSourcedPayloadFromObject } from '@Lib/protocol/payloads/generator';
import { PayloadSource } from '@Lib/protocol/payloads';
import { SNProtocolService } from '../protocol_service';

export class ServerHistoryRevision extends History {

  constructor(content?: HistoryContent) {
    super(content);
  }

  static async FromResponse(protocolService: SNProtocolService, itemUuid: string, response?: HttpResponse) {
    if (response) {
      delete response.error;
      delete response.status;
      const historyServer = new ServerHistoryRevision();
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
      return new ServerHistoryRevision();
    }
  }
}
