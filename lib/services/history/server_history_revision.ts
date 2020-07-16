import { BaseHistory, HistoryContent } from '@Lib/services/history/base_history';
import { HttpResponse } from '../api/http_service';
import { CreateSourcedPayloadFromObject, RawPayload } from '@Lib/protocol/payloads/generator';
import { PayloadSource } from '@Lib/protocol/payloads';
import { SNProtocolService } from '../protocol_service';

export class ServerHistoryRevision extends BaseHistory {

  constructor(content?: HistoryContent) {
    super(content);
  }

  static async FromResponse(protocolService: SNProtocolService, itemUuid: string, response?: HttpResponse) {
    if (response) {
      delete response.error;
      delete response.status;
      const historyServer = new ServerHistoryRevision();
      let revisions: RawPayload[] = [];
      Object.entries(response).forEach(([key, value]) => revisions.push(value));
      revisions.sort((a, b) => {
        return a.updated_at! < b.updated_at! ? -1 : 1;
      }).map(async (revision) => {
        const payload = CreateSourcedPayloadFromObject(revision, PayloadSource.ServerHistory, {
          ...revision,
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
